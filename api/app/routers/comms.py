"""
comms.py — email tracking, sending, scheduling and templates for pipeline
entities.

Shared by the investor board (entity_type 'investor') and /crm (entity_type
'deal'), which is why nothing here mentions investors except where a rule is
genuinely investor-specific.

GET    /comms/{entity_type}/{entity_id}            — timeline + addresses + queue
POST   /comms/{entity_type}/{entity_id}/send       — send now, in-thread
POST   /comms/{entity_type}/{entity_id}/schedule   — queue a conditional follow-up
POST   /comms/{entity_type}/{entity_id}/log-touch  — record an off-email touch
PATCH  /comms/messages/{message_id}                — edit a hand-logged touch
DELETE /comms/messages/{message_id}                — delete a hand-logged touch
POST   /comms/{entity_type}/{entity_id}/draft      — AI-tailored draft from a template
POST   /comms/{entity_type}/{entity_id}/drafts     — park a composed email for later
POST   /comms/{entity_type}/{entity_id}/send-test  — send it to yourself, logging nothing
GET    /comms/library                              — shared documents for attaching
POST   /comms/library                              — add one
PATCH  /comms/library/{upload_id}                  — rename one
DELETE /comms/library/{upload_id}                  — remove one
GET    /comms/{entity_type}/{entity_id}/signature  — the sign-off this record will use
GET    /comms/signature                            — your own sign-off
PUT    /comms/signature                            — change your own sign-off
PATCH  /comms/drafts/{draft_id}                    — update a parked draft
DELETE /comms/drafts/{draft_id}                    — discard a parked draft
PATCH  /comms/addresses/{address_id}               — set primary / sendable
PATCH  /comms/scheduled/{scheduled_id}             — edit a queued send
POST   /comms/scheduled/{scheduled_id}/approve     — release an automatic follow-up
DELETE /comms/scheduled/{scheduled_id}             — cancel a queued send
GET    /comms/templates                            — list
POST   /comms/templates                            — create
PATCH  /comms/templates/{template_id}              — update
DELETE /comms/templates/{template_id}              — delete
"""

import base64
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from email.mime.application import MIMEApplication
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

import httpx
import psycopg2
import psycopg2.extras
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/comms", tags=["comms"])

GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

# 'funding' is a funding_opportunities row (130). Unlike the other two it has no
# contacts of its own — mail reaches it through the domain/subject matcher in
# comm_sync, which files suggestions rather than writing here directly.
ENTITY_TYPES = ("investor", "deal", "funding")

DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files"

# Google-native files have no bytes to download — they must be exported.
DRIVE_EXPORT = {
    "application/vnd.google-apps.document":
        ("application/pdf", ".pdf"),
    "application/vnd.google-apps.presentation":
        ("application/pdf", ".pdf"),
    "application/vnd.google-apps.spreadsheet":
        ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"),
    "application/vnd.google-apps.drawing":
        ("image/png", ".png"),
}

# Gmail's JSON send carries the whole message base64-encoded, which is ~33%
# larger than the raw bytes. Well under the API limit, and a deck bigger than
# this belongs in Drive as a link anyway.
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

# Files attached from a computer. On a volume shared by the API and the worker,
# so a follow-up queued today can still be sent next week.
UPLOAD_DIR = os.environ.get("EMAIL_UPLOAD_DIR", "/app/uploads/email")


def get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _addresses(header_value: str) -> list:
    """Every address in a header like 'Name <a@b.com>, c@d.com', lowercased.

    Same rule as the crawler's parser (contacts_sync), kept here rather than
    imported: that module imports this one, and a header split is not worth a
    circular dependency.
    """
    if not header_value:
        return []
    pairs = re.findall(
        r"<([^>]+)>|(?:^|,)\s*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})",
        header_value)
    out = []
    for bracketed, bare in pairs:
        addr = (bracketed or bare).strip().lower()
        if addr and addr not in out:
            out.append(addr)
    return out


def _claim_funding(cur, entity_type: str, entity_id: str, user_id) -> None:
    """Emailing an ownerless opportunity claims it.

    Opportunities are the one board where records routinely have no owner (see
    funding._claim_unassigned). Writing to a funder, or attaching the thread you
    found, is about as clear a statement of "I am working this" as exists — so
    it fills the blank, and never overwrites a name already there. Investors and
    deals assign on creation and are left alone.
    """
    if entity_type != "funding" or not user_id:
        return
    cur.execute(
        "UPDATE funding_opportunities SET assignee_id = %s, updated_at = NOW() "
        "WHERE opportunity_id = %s AND assignee_id IS NULL",
        (user_id, entity_id))


def _check_entity(entity_type: str) -> str:
    if entity_type not in ENTITY_TYPES:
        raise HTTPException(status_code=400, detail=f"Unknown entity_type: {entity_type}")
    return entity_type


def _actor_id(request) -> Optional[str]:
    raw = request.headers.get("X-User-Id") if request else None
    if not raw:
        return None
    try:
        return str(uuid.UUID(raw))
    except (ValueError, AttributeError, TypeError):
        return None


# ── Google token ─────────────────────────────────────────────────────────────

def _google_token(cur, user_id: str) -> str:
    """Access token for user_id, refreshed if it is at or near expiry."""
    cur.execute("SELECT * FROM google_oauth_tokens WHERE user_id = %s", (user_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=400, detail="google_not_connected")

    expiry = row["token_expiry"]
    if expiry and expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    if expiry and datetime.now(timezone.utc) < expiry - timedelta(minutes=2):
        return row["access_token"]

    r = httpx.post(GOOGLE_TOKEN_URL, data={
        "client_id": os.environ.get("GOOGLE_CLIENT_ID", ""),
        "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET", ""),
        "refresh_token": row["refresh_token"],
        "grant_type": "refresh_token",
    }, timeout=20)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to refresh Google token")
    d = r.json()
    cur.execute(
        "UPDATE google_oauth_tokens SET access_token=%s, token_expiry=%s, updated_at=NOW() WHERE user_id=%s",
        (d["access_token"],
         datetime.now(timezone.utc) + timedelta(seconds=d.get("expires_in", 3600)),
         user_id),
    )
    return d["access_token"]


def resolve_sender(cur, entity_type: str, entity_id: str, fallback: Optional[str]) -> str:
    """Whose mailbox this goes out from.

    The record's owner, so the investor sees the same person they have been
    talking to. Falls back to whoever is asking. Never silently picks a
    stranger's mailbox — an unresolvable sender is an error the caller sees.
    """
    owner = None
    if entity_type == "investor":
        cur.execute("SELECT assigned_to FROM dilutive_investors WHERE investor_id = %s", (entity_id,))
        row = cur.fetchone()
        owner = str(row["assigned_to"]) if row and row["assigned_to"] else None
    elif entity_type == "deal":
        cur.execute("SELECT deal_lead_id FROM crm_deals WHERE deal_id = %s", (entity_id,))
        row = cur.fetchone()
        owner = str(row["deal_lead_id"]) if row and row["deal_lead_id"] else None
    elif entity_type == "funding":
        cur.execute("SELECT assignee_id FROM funding_opportunities WHERE opportunity_id = %s",
                    (entity_id,))
        row = cur.fetchone()
        owner = str(row["assignee_id"]) if row and row["assignee_id"] else None

    for candidate in (owner, fallback):
        if not candidate:
            continue
        cur.execute("SELECT 1 FROM google_oauth_tokens WHERE user_id = %s", (candidate,))
        if cur.fetchone():
            return candidate

    raise HTTPException(
        status_code=422,
        detail="No mailbox available to send from — the record's owner has not connected Google.",
    )


def _pick_sender(cur, entity_type, entity_id, actor, requested):
    """Whose mailbox this goes out from. An explicit choice from the composer
    wins as long as it is a connected mailbox; otherwise fall back to the
    record's owner (resolve_sender)."""
    if requested:
        cur.execute("SELECT 1 FROM google_oauth_tokens WHERE user_id = %s", (str(requested),))
        if cur.fetchone():
            return str(requested)
    return resolve_sender(cur, entity_type, entity_id, actor)


@router.get("/mailboxes")
def list_mailboxes():
    """The mailboxes a message can be sent from — every connected Google account.
    Drives the composer's From picker."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT g.user_id, COALESCE(u.full_name, u.name, g.google_email) AS name,
                          g.google_email AS email
                   FROM google_oauth_tokens g
                   LEFT JOIN users u ON u.user_id = g.user_id
                   WHERE g.google_email IS NOT NULL
                   ORDER BY name"""
            )
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()



# ── Drive attachments ────────────────────────────────────────────────────────

@router.get("/drive/search")
def drive_search(request: Request, q: str = Query(..., min_length=1),
                 max_results: int = Query(20, le=50)):
    """Find files to attach, from the requesting user's Drive."""
    actor = _actor_id(request)
    if not actor:
        raise HTTPException(status_code=401, detail="Not authenticated")
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            token = _google_token(cur, actor)
            conn.commit()
    finally:
        conn.close()

    escaped = q.replace("'", "\\'")
    r = httpx.get(DRIVE_FILES_URL, headers={"Authorization": f"Bearer {token}"},
                  params={"q": f"name contains '{escaped}' and trashed = false",
                          "fields": "files(id,name,mimeType,size,modifiedTime,webViewLink)",
                          "pageSize": max_results, "orderBy": "modifiedTime desc"},
                  timeout=20)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="Drive API error")
    return [
        {"id": f["id"], "name": f["name"], "mime_type": f.get("mimeType"),
         "size": int(f["size"]) if f.get("size") else None,
         "url": f.get("webViewLink"), "modified": f.get("modifiedTime")}
        for f in r.json().get("files", [])
    ]


@router.post("/uploads", status_code=201)
def upload_attachment(request: Request, file: UploadFile = File(...)):
    """Take a file from the user's computer and hold it for sending."""
    return _store_upload(file, _actor_id(request))


def _store_upload(file: UploadFile, actor: Optional[str], *,
                  is_library: bool = False, label: Optional[str] = None) -> dict:
    """Write the bytes to the shared volume and record the row.

    One path for both a file dragged into a single email and a document put on
    the shared shelf — they differ by a flag, so a library document attaches
    through exactly the same code as any other upload.
    """
    import pathlib
    import uuid as _uuid

    data = file.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status_code=413,
            detail="That file is over 20 MB — share it as a Drive link instead.",
        )

    pathlib.Path(UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
    name = os.path.basename(file.filename or "attachment")
    suffix = pathlib.Path(name).suffix
    stored = os.path.join(UPLOAD_DIR, f"{_uuid.uuid4()}{suffix}")
    with open(stored, "wb") as fh:
        fh.write(data)

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO email_uploads
                     (filename, mime_type, size_bytes, path, created_by, is_library, label)
                   VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING upload_id""",
                (name, file.content_type or "application/octet-stream",
                 len(data), stored, actor, is_library, (label or "").strip() or None),
            )
            upload_id = str(cur.fetchone()["upload_id"])
            conn.commit()
    finally:
        conn.close()

    return {"source": "upload", "id": upload_id, "name": label or name,
            "filename": name, "mime_type": file.content_type, "size": len(data)}


# ── Shared document library ──────────────────────────────────────────────────
#
# Documents kept for reuse — the deck, the one-pager — rather than the one-off
# copy attached to a single email. Managed in Email Template settings and
# offered in the composer.

@router.get("/library")
def list_library():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT u.upload_id, u.filename, u.label, u.mime_type, u.size_bytes,
                          u.created_at, COALESCE(x.full_name, x.name, x.email) AS uploaded_by
                   FROM email_uploads u
                   LEFT JOIN users x ON x.user_id = u.created_by
                   WHERE u.is_library
                   ORDER BY COALESCE(u.label, u.filename)"""
            )
            return [{
                "source": "upload",
                "id": str(r["upload_id"]),
                "name": r["label"] or r["filename"],
                "filename": r["filename"],
                "mime_type": r["mime_type"],
                "size": r["size_bytes"],
                "uploaded_by": r["uploaded_by"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            } for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/library", status_code=201)
def add_library_document(request: Request, file: UploadFile = File(...),
                         label: str = Query(None)):
    return _store_upload(file, _actor_id(request), is_library=True, label=label)


@router.patch("/library/{upload_id}")
def rename_library_document(upload_id: str, body: dict):
    """Rename for the list. The stored filename is what recipients see attached,
    so it is left alone — renaming here must not change what lands in an inbox."""
    label = (body.get("label") or "").strip()
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "UPDATE email_uploads SET label = %s WHERE upload_id = %s AND is_library"
                " RETURNING upload_id, filename, label",
                (label or None, upload_id),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="No such document")
            conn.commit()
            return {"id": str(row["upload_id"]), "name": row["label"] or row["filename"]}
    finally:
        conn.close()


@router.delete("/library/{upload_id}", status_code=204)
def remove_library_document(upload_id: str):
    """Off the shelf and off the disk.

    A queued follow-up that already attached this document reads the file at
    send time, so deleting one out from under a scheduled send would make it
    fail. Checked first, and refused while anything still points at it.
    """
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT path FROM email_uploads WHERE upload_id = %s AND is_library",
                (upload_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="No such document")

            cur.execute(
                """SELECT count(*) AS n FROM scheduled_emails
                   WHERE status IN ('scheduled', 'draft')
                     AND attachments @> %s""",
                (psycopg2.extras.Json([{"id": upload_id}]),),
            )
            pending = cur.fetchone()["n"]
            if pending:
                raise HTTPException(
                    status_code=409,
                    detail=f"{pending} queued or draft email still attaches this document.",
                )

            cur.execute("DELETE FROM email_uploads WHERE upload_id = %s", (upload_id,))
            conn.commit()
        try:
            os.remove(row["path"])
        except OSError:
            pass  # already gone; the row is what mattered
    finally:
        conn.close()


def _fetch_upload(cur, upload_id: str) -> tuple:
    """(filename, mime_type, bytes) for a file attached from a computer."""
    cur.execute(
        "SELECT filename, mime_type, path FROM email_uploads WHERE upload_id = %s",
        (upload_id,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Uploaded file not found")
    try:
        with open(row["path"], "rb") as fh:
            return row["filename"], row["mime_type"], fh.read()
    except OSError:
        raise HTTPException(
            status_code=410,
            detail=f"“{row['filename']}” is no longer on disk — re-attach it.",
        )


def _fetch_drive_file(token: str, file_id: str) -> tuple:
    """(filename, mime_type, bytes) for a Drive file, exporting native docs."""
    meta = httpx.get(f"{DRIVE_FILES_URL}/{file_id}",
                     headers={"Authorization": f"Bearer {token}"},
                     params={"fields": "name,mimeType,size"}, timeout=20)
    if meta.status_code != 200:
        raise HTTPException(status_code=404, detail=f"Drive file {file_id} not found")
    info = meta.json()
    name, mime = info.get("name", "attachment"), info.get("mimeType", "")

    if mime in DRIVE_EXPORT:
        out_mime, ext = DRIVE_EXPORT[mime]
        r = httpx.get(f"{DRIVE_FILES_URL}/{file_id}/export",
                      headers={"Authorization": f"Bearer {token}"},
                      params={"mimeType": out_mime}, timeout=60)
        if not name.lower().endswith(ext):
            name += ext
        mime = out_mime
    else:
        r = httpx.get(f"{DRIVE_FILES_URL}/{file_id}",
                      headers={"Authorization": f"Bearer {token}"},
                      params={"alt": "media"}, timeout=60)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Could not download “{name}” from Drive")
    return name, mime, r.content


def _build_attachments(token: str, attachments: list, cur=None) -> list:
    """Resolve attachment specs into MIME parts, refusing a payload Gmail would
    reject. A spec is {id, source} where source is 'drive' (the default) or
    'upload' for a file that came off someone's computer."""
    parts, total = [], 0
    for spec in attachments or []:
        if isinstance(spec, dict):
            file_id, source = spec.get("id"), (spec.get("source") or "drive")
            # A spec may name a marketing role instead of a file. Resolving it
            # at send time is the point: the template never has to be edited
            # when the deck is replaced, and a send cannot go out with the
            # file that happened to be current when the template was written.
            role = spec.get("role")
            if role:
                from app.routers.marketing import resolve_role_file
                resolved = resolve_role_file(role)
                if not resolved:
                    raise HTTPException(
                        status_code=422,
                        detail=f"No file is assigned to the '{role}' role in Marketing.",
                    )
                file_id, source = resolved["file_id"], "drive"
        else:
            file_id, source = spec, "drive"
        if not file_id:
            continue
        if source == "upload":
            if cur is None:
                raise HTTPException(status_code=500, detail="Cannot read uploads here")
            name, mime, data = _fetch_upload(cur, file_id)
        else:
            name, mime, data = _fetch_drive_file(token, file_id)
        total += len(data)
        if total > MAX_ATTACHMENT_BYTES:
            raise HTTPException(
                status_code=422,
                detail="Attachments exceed 20 MB — send a Drive link instead.",
            )
        maintype, _, subtype = mime.partition("/")
        part = MIMEApplication(data, _subtype=subtype or "octet-stream")
        part.add_header("Content-Disposition", "attachment", filename=name)
        parts.append((name, part))
    return parts


# ── Reading ──────────────────────────────────────────────────────────────────

@router.get("/templates")
def list_templates(scope: Optional[str] = Query(None)):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if scope:
                cur.execute(
                    "SELECT * FROM email_templates WHERE scope IN ('any', %s) ORDER BY kind, name",
                    (scope,),
                )
            else:
                cur.execute("SELECT * FROM email_templates ORDER BY kind, name")
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/templates", status_code=201)
def create_template(body: dict, request: Request = None):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO email_templates
                     (name, kind, scope, subject, body, default_delay_days,
                      attachments, created_by)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING *""",
                (name, body.get("kind") or "outreach", body.get("scope") or "any",
                 body.get("subject") or "", body.get("body") or "",
                 body.get("default_delay_days"),
                 psycopg2.extras.Json(body.get("attachments") or []),
                 _actor_id(request)),
            )
            out = dict(cur.fetchone())
            conn.commit()
            return out
    finally:
        conn.close()


TEMPLATE_FIELDS = {"name", "kind", "scope", "subject", "body", "default_delay_days"}


@router.patch("/templates/{template_id}")
def update_template(template_id: str, body: dict):
    updates = {k: v for k, v in body.items() if k in TEMPLATE_FIELDS}
    # jsonb, so it cannot ride along as a plain value with the text fields.
    if "attachments" in body:
        updates["attachments"] = psycopg2.extras.Json(body.get("attachments") or [])
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            sets = ", ".join(f"{k} = %s" for k in updates)
            cur.execute(
                f"UPDATE email_templates SET {sets}, updated_at = NOW() WHERE template_id = %s RETURNING *",
                list(updates.values()) + [template_id],
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Template not found")
            conn.commit()
            return dict(row)
    finally:
        conn.close()


@router.delete("/templates/{template_id}", status_code=204)
def delete_template(template_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM email_templates WHERE template_id = %s", (template_id,))
            conn.commit()
    finally:
        conn.close()


def _autolink_deal_contacts(cur, deal_id):
    """Register every CRM contact on this deal as a tracked comms address, so the
    Gmail sync matches their mail onto the deal without anyone re-typing it. Cheap
    and idempotent (ensure_contact_address is ON CONFLICT DO NOTHING)."""
    from app.tasks.comm_sync import ensure_contact_address
    cur.execute(
        """SELECT c.name, c.email, c.title
           FROM crm_deal_contacts dc
           JOIN contacts c ON c.contact_id = dc.contact_id
           WHERE dc.deal_id = %s AND c.email IS NOT NULL AND c.email <> ''""",
        (deal_id,),
    )
    for r in cur.fetchall():
        try:
            ensure_contact_address(cur, "deal", deal_id, email=r["email"],
                                   name=r.get("name"), role=r.get("title"))
        except Exception:
            pass


@router.get("/{entity_type}/{entity_id}")
def get_comms(entity_type: str, entity_id: str, limit: int = Query(50, ge=1, le=200)):
    """Timeline, known addresses and anything still queued."""
    _check_entity(entity_type)
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if entity_type == "deal":
                _autolink_deal_contacts(cur, entity_id)
                conn.commit()
            cur.execute(
                """SELECT m.*, u.name AS seen_by_name,
                          (m.gmail_message_id LIKE 'touch:%%') AS is_manual
                   FROM comm_messages m
                   LEFT JOIN users u ON u.user_id = m.seen_by
                   WHERE m.entity_type = %s AND m.entity_id = %s
                   ORDER BY m.occurred_at DESC
                   LIMIT %s""",
                (entity_type, entity_id, limit),
            )
            messages = [dict(r) for r in cur.fetchall()]

            cur.execute(
                """SELECT a.*, c.name AS contact_name
                   FROM comm_addresses a
                   LEFT JOIN contacts c ON c.contact_id = a.contact_id
                   WHERE a.entity_type = %s AND a.entity_id = %s
                   ORDER BY a.is_primary DESC, a.is_organizational, a.email""",
                (entity_type, entity_id),
            )
            addresses = [dict(r) for r in cur.fetchall()]

            cur.execute(
                """SELECT s.*, t.name AS template_name
                   FROM scheduled_emails s
                   LEFT JOIN email_templates t ON t.template_id = s.template_id
                   WHERE s.entity_type = %s AND s.entity_id = %s
                     AND s.status = 'scheduled'
                   ORDER BY s.scheduled_for""",
                (entity_type, entity_id),
            )
            scheduled = [dict(r) for r in cur.fetchall()]

            # Parked drafts. Same table, but nothing will ever send these — they
            # sit here until someone opens one back up.
            cur.execute(
                """SELECT s.*, t.name AS template_name
                   FROM scheduled_emails s
                   LEFT JOIN email_templates t ON t.template_id = s.template_id
                   WHERE s.entity_type = %s AND s.entity_id = %s
                     AND s.status = 'draft'
                   ORDER BY s.updated_at DESC""",
                (entity_type, entity_id),
            )
            drafts = [dict(r) for r in cur.fetchall()]

            # Sends that errored out (e.g. a reply thread that was deleted).
            # Surfaced so they can be retried or discarded, not lost silently.
            cur.execute(
                """SELECT s.*, t.name AS template_name
                   FROM scheduled_emails s
                   LEFT JOIN email_templates t ON t.template_id = s.template_id
                   WHERE s.entity_type = %s AND s.entity_id = %s
                     AND s.status = 'failed'
                   ORDER BY s.updated_at DESC
                   LIMIT 10""",
                (entity_type, entity_id),
            )
            failed = [dict(r) for r in cur.fetchall()]

            # Planned work lives in the shared tasks table — the Activity
            # section reads it rather than keeping a second to-do list.
            cur.execute(
                """SELECT t.task_id, t.title, t.description, t.due_date, t.status,
                          t.kanban_status, t.priority, t.activity_type, t.assigned_to,
                          COALESCE(u.full_name, u.name, u.email) AS assigned_to_name,
                          t.created_at
                   FROM tasks t
                   LEFT JOIN users u ON u.user_id = t.assigned_to
                   WHERE t.source_ref = %s
                   ORDER BY
                       CASE t.status WHEN 'open' THEN 0 ELSE 1 END,
                       t.due_date ASC NULLS LAST,
                       t.created_at DESC
                   LIMIT 50""",
                (entity_id,),
            )
            tasks = [dict(r) for r in cur.fetchall()]

            return {"messages": messages, "addresses": addresses,
                    "scheduled": scheduled, "drafts": drafts, "failed": failed,
                    "tasks": tasks}
    finally:
        conn.close()


# ── Full message body (fetched from Gmail on demand) ─────────────────────────

def _b64url(data: str) -> str:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")


def _extract_gmail_body(payload: dict):
    """Walk a Gmail payload for its text — prefer text/plain, else text/html."""
    plain = html = None
    stack = [payload or {}]
    while stack:
        p = stack.pop()
        mime = p.get("mimeType", "") or ""
        data = (p.get("body") or {}).get("data")
        if data and mime == "text/plain" and plain is None:
            plain = _b64url(data)
        elif data and mime == "text/html" and html is None:
            html = _b64url(data)
        for part in (p.get("parts") or []):
            stack.append(part)
    return plain, html


def _html_to_text(raw: str) -> str:
    """Crude, safe HTML→text for emails with no plain-text part: never rendered,
    so no markup reaches the browser."""
    import html as _htmllib
    raw = re.sub(r"(?is)<(script|style).*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>", "\n", raw)
    raw = re.sub(r"(?i)</(p|div|tr|li|h[1-6]|table)>", "\n", raw)
    text = re.sub(r"(?s)<[^>]+>", "", raw)
    text = _htmllib.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]*\n[ \t]*\n+", "\n\n", text)
    return text.strip()


@router.get("/message/{message_id}/body")
def get_message_body(message_id: str, request: Request = None):
    """The full text of a synced email, fetched live from Gmail (the sync keeps
    only a snippet). Falls back to the snippet for hand-logged touches, meetings,
    or when the message can no longer be reached."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT gmail_message_id, snippet FROM comm_messages WHERE message_id = %s",
                (message_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="No such message")
            gid = row["gmail_message_id"]
            snippet = row["snippet"] or ""
            if not gid or gid.startswith("touch:"):
                return {"body": snippet, "full": False}

            cur.execute("SELECT user_id::text AS uid FROM google_oauth_tokens")
            uids = [r["uid"] for r in cur.fetchall()]
            body = None
            for uid in uids:
                try:
                    token = _google_token(cur, uid)
                except HTTPException:
                    continue
                try:
                    resp = httpx.get(
                        f"{GMAIL_BASE}/messages/{gid}",
                        headers={"Authorization": f"Bearer {token}"},
                        params={"format": "full"}, timeout=20,
                    )
                except Exception:
                    continue
                if resp.status_code != 200:
                    continue  # not in this mailbox — try the next
                plain, html = _extract_gmail_body(resp.json().get("payload", {}))
                body = plain or (_html_to_text(html) if html else None)
                if body:
                    break
            conn.commit()  # persist any token refresh done above
            if body:
                return {"body": body, "full": True}
            return {"body": snippet, "full": False}
    finally:
        conn.close()



@router.patch("/message/{message_id}/notes")
def set_message_notes(message_id: str, body: dict, request: Request = None):
    """Attach a note to a message — for now typically a Granola link on a synced
    meeting. This is our annotation, not the synced content, so it is editable on
    any message regardless of source, and the next sync leaves it alone."""
    notes = (body.get("notes") or "").strip() or None
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "UPDATE comm_messages SET notes = %s WHERE message_id = %s "
                "RETURNING message_id, notes",
                (notes, message_id),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="No such message")
            conn.commit()
            return dict(row)
    finally:
        conn.close()



# ── Sending ──────────────────────────────────────────────────────────────────

# ── Signatures ───────────────────────────────────────────────────────────────
#
# Authored as plain text, one line per line, with `Label [url]` for a link.
# Both the HTML and the plain-text part of the message are rendered from that
# single source, so they cannot drift.

LOGO_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "openerp-logo.png")
LOGO_CID = "openerplogo"
LOGO_WIDTH = 180  # rendered at 360px, shown at half size so it stays sharp

_LINK_LINE = re.compile(r"^(?P<label>.*?)\s*\[(?P<url>[^\]]+)\]\s*$")
_BARE_URL = re.compile(r"^(https?://\S+|www\.\S+)$", re.I)
_BARE_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))


def load_signature(cur, user_id: Optional[str]) -> Optional[dict]:
    """The sender's sign-off, rendered both ways. None when they have none."""
    if not user_id:
        return None
    cur.execute("SELECT signature FROM user_email_signatures WHERE user_id = %s", (user_id,))
    row = cur.fetchone()
    raw = (row["signature"] if row else "") or ""
    if not raw.strip():
        return None
    return render_signature(raw)


def render_signature(raw: str) -> dict:
    """{'text': …, 'html': …} for a signature source, logo included.

    Leads with a separator line so the sign-off reads as one, and never as a
    continuation of whatever the author was saying.
    """
    text_lines, html_lines = [], []
    for line in raw.replace("\r\n", "\n").split("\n"):
        line = line.strip()
        if not line:
            text_lines.append("")
            html_lines.append("<div>&nbsp;</div>")
            continue
        m = _LINK_LINE.match(line)
        if m and m.group("label"):
            label, url = m.group("label"), m.group("url").strip()
            text_lines.append(f"{label} ({url})")
            html_lines.append(f'<div><a href="{_esc(url)}" style="color:#0b57d0">{_esc(label)}</a></div>')
        elif m:  # a bare [url] with nothing in front of it
            url = m.group("url").strip()
            text_lines.append(url)
            html_lines.append(f'<div><a href="{_esc(url)}" style="color:#0b57d0">{_esc(url)}</a></div>')
        elif _BARE_URL.match(line):
            href = line if line.lower().startswith("http") else f"https://{line}"
            text_lines.append(line)
            html_lines.append(f'<div><a href="{_esc(href)}" style="color:#0b57d0">{_esc(line)}</a></div>')
        elif _BARE_EMAIL.match(line):
            text_lines.append(line)
            html_lines.append(f'<div><a href="mailto:{_esc(line)}" style="color:#0b57d0">{_esc(line)}</a></div>')
        else:
            text_lines.append(line)
            html_lines.append(f"<div>{_esc(line)}</div>")

    # The name carries the weight; everything under it is supporting detail.
    if html_lines:
        html_lines[0] = html_lines[0].replace("<div>", "<div style=\"font-weight:600\">", 1)

    logo_html = ""
    if os.path.exists(LOGO_PATH):
        logo_html = (f'<div style="margin-top:10px">'
                     f'<img src="cid:{LOGO_CID}" width="{LOGO_WIDTH}" alt="Open ERP Bioculinary" '
                     f'style="display:block;border:0"></div>')

    html = ('<div style="margin-top:18px;padding-top:10px;border-top:1px solid #e5e5e5;'
            'font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45;color:#333">'
            + "".join(html_lines) + logo_html + "</div>")
    return {"text": "\n\n--\n" + "\n".join(text_lines), "html": html}


def _logo_part():
    """The signature logo as an inline image, referenced by Content-ID.

    A CID part rather than a hosted URL or a data: URI: those are the two forms
    mail clients block by default, and a signature whose logo shows as a broken
    box is worse than one with no logo at all.
    """
    try:
        with open(LOGO_PATH, "rb") as fh:
            data = fh.read()
    except OSError:
        return None
    part = MIMEImage(data, _subtype="png")
    part.add_header("Content-ID", f"<{LOGO_CID}>")
    part.add_header("Content-Disposition", "inline", filename="openerp-logo.png")
    return part


def _html_body(body: str, signature: Optional[dict]) -> str:
    """The composed text as HTML. It was typed as plain text, so it is escaped
    and line breaks are preserved — never interpreted as markup."""
    escaped = _esc(body).replace("\n", "<br>")
    return ('<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;'
            f'line-height:1.5;color:#111">{escaped}</div>'
            + (signature or {}).get("html", ""))


def _send_via_gmail(token: str, *, to: str, subject: str, body: str,
                    cc: Optional[list] = None, thread_id: Optional[str] = None,
                    in_reply_to: Optional[str] = None,
                    attachment_parts: Optional[list] = None,
                    signature: Optional[dict] = None) -> dict:
    """Send one message, threaded when we know the conversation.

    Two bodies always go out: plain text for clients that want it, and HTML so
    the signature's links and logo survive. The nesting is the one every client
    understands — mixed(attachments) wraps related(inline images) wraps
    alternative(text, html) — and each layer is dropped when it holds nothing.
    """
    plain = body + (signature or {}).get("text", "")
    html = _html_body(body, signature)

    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText(plain, "plain", "utf-8"))
    alt.attach(MIMEText(html, "html", "utf-8"))

    logo = _logo_part() if signature else None
    if logo is not None:
        related = MIMEMultipart("related")
        related.attach(alt)
        related.attach(logo)
        inner = related
    else:
        inner = alt

    if attachment_parts:
        msg = MIMEMultipart("mixed")
        msg.attach(inner)
        for _name, part in attachment_parts:
            msg.attach(part)
    else:
        msg = inner

    msg["To"] = to
    msg["Subject"] = subject
    if cc:
        msg["Cc"] = ", ".join(cc)
    if in_reply_to:
        # Both headers, so every mail client threads it, not just Gmail.
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to

    payload = {"raw": base64.urlsafe_b64encode(msg.as_bytes()).decode()}
    if thread_id:
        payload["threadId"] = thread_id

    def _post(pl):
        return httpx.post(f"{GMAIL_BASE}/messages/send",
                          headers={"Authorization": f"Bearer {token}",
                                   "Content-Type": "application/json"},
                          json=pl, timeout=25)

    r = _post(payload)
    # A 404 on the threadId means this mailbox cannot see that thread — it was
    # deleted, or (far more often) the id was read out of a colleague's mailbox,
    # where the same conversation carries a different id. Rather than fail the
    # whole send, drop the thread and send it as a fresh message: the
    # In-Reply-To/References headers still thread it for the recipient and in
    # every other mailbox on the conversation. It is only the sender's own Gmail
    # that ends up with a stray thread, so this is worth a warning rather than a
    # silent recovery — a run of them means the anchor is being taken from the
    # wrong mailbox.
    if r.status_code == 404 and payload.get("threadId"):
        logger.warning(
            "Gmail thread %s is not in the sending mailbox — sending %r to %s as a "
            "new conversation (In-Reply-To %s kept, so it still threads for them)",
            payload["threadId"], subject, to, in_reply_to or "none",
        )
        payload.pop("threadId", None)
        r = _post(payload)

    if r.status_code not in (200, 201):
        detail = r.text[:300]
        try:
            detail = r.json().get("error", {}).get("message", detail)
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=f"Gmail API error: {detail}")
    return r.json()


def _sent_rfc_id(token: str, gmail_id: str) -> Optional[str]:
    """The Message-ID Gmail assigned to a message we just sent — the send
    response carries only ids, not headers."""
    try:
        r = httpx.get(f"{GMAIL_BASE}/messages/{gmail_id}",
                      headers={"Authorization": f"Bearer {token}"},
                      params={"format": "metadata", "metadataHeaders": ["Message-ID"]},
                      timeout=15)
        if r.status_code != 200:
            return None
        for h in r.json().get("payload", {}).get("headers", []):
            if h["name"].lower() == "message-id":
                return h["value"]
    except Exception:
        logger.warning("could not read Message-ID for %s", gmail_id, exc_info=True)
    return None


def _record_outbound(cur, entity_type, entity_id, sent, *, to_emails, subject,
                     body, sender_id, rfc_message_id=None, attachment_names=None):
    cur.execute(
        """INSERT INTO comm_messages
             (entity_type, entity_id, gmail_message_id, thread_id, direction,
              subject, snippet, from_email, to_emails, occurred_at, seen_by,
              sent_by_platform, rfc_message_id, attachment_names, mailbox_user_id)
           VALUES (%s, %s, %s, %s, 'outbound', %s, %s,
                   (SELECT google_email FROM google_oauth_tokens WHERE user_id = %s),
                   %s, NOW(), %s, true, %s, %s, %s)
           ON CONFLICT DO NOTHING
           RETURNING message_id""",
        (entity_type, entity_id, sent.get("id"), sent.get("threadId"),
         subject, body[:500], sender_id, to_emails, sender_id, rfc_message_id,
         list(attachment_names or []), sender_id),
    )
    # The sending mailbox's ids. The Cc'd mailbox will add its own when its
    # crawl reaches the same message.
    if cur.rowcount:
        from app.tasks.comm_sync import record_mailbox_copy
        record_mailbox_copy(cur, cur.fetchone()["message_id"], sender_id,
                            sent.get("id"), sent.get("threadId"))


def stamp_outreach_date(cur, entity_type, entity_id, occurred_at=None):
    """Record when we first reached out, from the mail itself.

    Called on every outbound message — sent from the panel or found in Gmail by
    the sync — rather than only on the first, because the sync can surface an
    older email long after a later one was already recorded.

    LEAST, so the earliest evidence wins: a date set by hand for a LinkedIn
    message or a call still stands when no email precedes it, and a stamp that
    turns out to post-date the real first email is corrected backwards.
    """
    if entity_type != "investor":
        return
    cur.execute(
        """UPDATE dilutive_investors
           SET outreach_date = LEAST(COALESCE(outreach_date, %s), %s), updated_at = NOW()
           WHERE investor_id = %s
             AND (outreach_date IS NULL OR outreach_date > %s)""",
        (occurred_at, occurred_at, entity_id, occurred_at),
    )


def _mark_awaiting_investor(cur, entity_type, entity_id, actor):
    """Sending puts the ball in their court, so the status follows the send.

    This is not the same thing as the inbound automation: it fires only on a
    send we made, never on mail merely observed in a sync."""
    if entity_type != "investor":
        return
    cur.execute("SELECT status, is_priority FROM dilutive_investors WHERE investor_id = %s", (entity_id,))
    row = cur.fetchone()
    if not row or not row["is_priority"] or row["status"] == "Awaiting Investor":
        return
    cur.execute(
        "UPDATE dilutive_investors SET status = 'Awaiting Investor', updated_at = NOW() WHERE investor_id = %s",
        (entity_id,),
    )
    cur.execute(
        """INSERT INTO dilutive_status_history (investor_id, status_from, status_to, changed_by)
           VALUES (%s, %s, 'Awaiting Investor', %s)""",
        (entity_id, row["status"], actor),
    )


# ── The follow-up that comes with a first outreach ───────────────────────────

FOLLOWUP_TEMPLATE = "Follow-up — no response"
FOLLOWUP_DAYS = 5


def _is_first_outreach(cur, entity_type, entity_id) -> bool:
    """Has anything ever gone out to this record before?

    Asked of the timeline rather than the investor's outreach_date, because
    that field is also set by hand and would call a second email a first one.
    """
    cur.execute(
        """SELECT 1 FROM comm_messages
           WHERE entity_type = %s AND entity_id = %s AND direction = 'outbound'
           LIMIT 1""",
        (entity_type, entity_id),
    )
    return cur.fetchone() is None


def _queue_first_followup(cur, entity_type, entity_id, *, to, cc, sender_id,
                          actor, thread_id, outreach_subject):
    """Queue the no-response follow-up alongside a first outreach.

    A first email that nobody chases is a wasted one, and the chase is the part
    that gets forgotten. It goes out five days later on the same thread and
    cancels itself the moment they reply, so the only way it ever sends is the
    case it was written for. Visible in the queue from the second it exists, so
    it can be edited or cancelled like anything else scheduled by hand.
    """
    cur.execute(
        """SELECT template_id, subject, body, default_delay_days, attachments
           FROM email_templates
           WHERE kind = 'follow_up' AND scope IN ('any', %s)
           ORDER BY (name = %s) DESC, name
           LIMIT 1""",
        (entity_type, FOLLOWUP_TEMPLATE),
    )
    tpl = cur.fetchone()
    if not tpl:
        return None  # nothing to send; not worth failing a delivered email over

    # Never two chases for one silence.
    cur.execute(
        """SELECT 1 FROM scheduled_emails
           WHERE entity_type = %s AND entity_id = %s AND status = 'scheduled' LIMIT 1""",
        (entity_type, entity_id),
    )
    if cur.fetchone():
        return None

    try:
        ctx = _entity_context(cur, entity_type, entity_id)
    except HTTPException:
        return None
    # Threaded off the subject that just went out. The template's own subject is
    # a human-written stand-in ("Re: [original subject]"), and resolving it here
    # rather than at send time means that placeholder can never reach an inbox.
    subject = reply_subject(_fill(tpl["subject"] or "", ctx), outreach_subject)
    text = _fill(tpl["body"] or "", ctx)
    days = tpl["default_delay_days"] or FOLLOWUP_DAYS
    when = datetime.now(timezone.utc) + timedelta(days=days)

    cur.execute(
        """INSERT INTO scheduled_emails
             (entity_type, entity_id, to_email, cc_emails, subject, body, template_id,
              scheduled_for, cancel_on_reply, thread_id, sender_id, created_by, attachments,
              approval_required)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,true,%s,%s,%s,%s,true)
           RETURNING scheduled_id""",
        (entity_type, entity_id, to, cc, subject, text, tpl["template_id"], when,
         thread_id, sender_id, actor, psycopg2.extras.Json(tpl["attachments"] or [])),
    )
    scheduled_id = str(cur.fetchone()["scheduled_id"])

    # Nobody hunts through a queue for work they were never told about, so the
    # review is a task, due the day the email would otherwise go out.
    task_id = _create_review_task(cur, entity_type, entity_id, sender_id, actor, when)
    if task_id:
        cur.execute(
            "UPDATE scheduled_emails SET review_task_id = %s WHERE scheduled_id = %s",
            (task_id, scheduled_id),
        )

    return {"scheduled_id": scheduled_id, "days": days, "subject": subject,
            "review_task_id": str(task_id) if task_id else None}


REVIEW_TASK_TITLE = "Review follow up"


def _review_task_target(cur, entity_type, entity_id):
    """(display name, owner_id) for a record — used to address a review task to
    the person who owns the relationship."""
    if entity_type == "investor":
        cur.execute(
            "SELECT firm, assigned_to FROM dilutive_investors WHERE investor_id = %s",
            (entity_id,),
        )
        row = cur.fetchone()
        name = (row["firm"] if row else None) or "this investor"
        lead = str(row["assigned_to"]) if row and row["assigned_to"] else None
        return name, lead
    if entity_type == "deal":
        cur.execute(
            """SELECT COALESCE(NULLIF(c.name, ''), NULLIF(d.company, ''), d.title) AS name,
                      d.deal_lead_id
               FROM crm_deals d LEFT JOIN companies c ON c.company_id = d.company_id
               WHERE d.deal_id = %s""",
            (entity_id,),
        )
        row = cur.fetchone()
        name = (row["name"] if row else None) or "this deal"
        lead = str(row["deal_lead_id"]) if row and row["deal_lead_id"] else None
        return name, lead
    return "this record", None


def _create_review_task(cur, entity_type, entity_id, sender_id, actor, due):
    """The task that stands between a machine-written email and a real send.

    Due the day the follow-up is scheduled for, not earlier: it is not overdue
    work until the day it would have sent.

    It belongs to the record's lead — the person who owns the relationship —
    rather than to whoever happened to press send. Only if nobody owns the
    record yet does it fall back to the sending mailbox, and then to the sender.
    """
    firm, lead = _review_task_target(cur, entity_type, entity_id)
    owner = lead or sender_id or actor
    if not owner:
        return None
    cur.execute(
        """INSERT INTO tasks
             (user_id, assigned_to, title, description, due_date, status, kanban_status,
              source, source_ref, activity_type, priority)
           VALUES (%s::uuid, %s::uuid, %s, %s, %s::date, 'open', 'todo',
                   'auto', %s, 'followup_review', 'medium')
           RETURNING task_id""",
        (owner, owner, REVIEW_TASK_TITLE,
         f"Approve or edit the automatic follow-up to {firm} before it sends.",
         due, str(entity_id)),
    )
    return cur.fetchone()["task_id"]


def _close_review_task(cur, scheduled_id):
    """Once the email is approved, cancelled or sent, the review is over."""
    cur.execute(
        """UPDATE tasks SET status = 'done', kanban_status = 'done', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
           WHERE task_id = (SELECT review_task_id FROM scheduled_emails WHERE scheduled_id = %s)
             AND status = 'open'""",
        (scheduled_id,),
    )


DEAL_FOLLOWUP_SUBJECT = "Following up"
FOLLOWUP_REVIEW_DELAY_DAYS = 1   # approval-gated, so this is only when review is due


def _any_mailbox(cur):
    """Any connected Google mailbox — a last resort when a record has no owner."""
    cur.execute("SELECT user_id::text AS uid FROM google_oauth_tokens LIMIT 1")
    row = cur.fetchone()
    return row["uid"] if row else None


def _pick_followup_recipient(cur, entity_type, entity_id):
    """Best external address to reply to: the primary human contact, else the
    last person who wrote in, else any known address."""
    cur.execute(
        """SELECT email FROM comm_addresses
           WHERE entity_type = %s AND entity_id = %s
             AND email IS NOT NULL AND email <> ''
           ORDER BY is_primary DESC, is_organizational ASC, email
           LIMIT 1""",
        (entity_type, entity_id),
    )
    row = cur.fetchone()
    if row and row["email"]:
        return row["email"]
    cur.execute(
        """SELECT from_email FROM comm_messages
           WHERE entity_type = %s AND entity_id = %s AND direction = 'inbound'
             AND from_email IS NOT NULL AND from_email <> ''
           ORDER BY occurred_at DESC LIMIT 1""",
        (entity_type, entity_id),
    )
    row = cur.fetchone()
    return row["from_email"] if row and row["from_email"] else None


def queue_review_followup(cur, entity_type, entity_id, actor=None):
    """Keep an awaiting-client record moving — the rule behind the CRM cadence.

    If there is an email thread to reply on, draft the next follow-up and park it
    in the queue as approval-required: it shows up for review exactly like an
    investor follow-up, never sends until a human signs off, and cancels itself
    the moment the client replies. If there is no thread yet there is nothing to
    reply to, so we leave a first-contact task on the record instead.

    Idempotent — a record that already has a follow-up queued (or an open
    follow-up task) is left alone, so this can be run across the pipeline
    repeatedly without stacking duplicates.
    """
    cur.execute(
        """SELECT 1 FROM scheduled_emails
           WHERE entity_type = %s AND entity_id = %s
             AND status IN ('scheduled', 'draft') LIMIT 1""",
        (entity_type, entity_id),
    )
    if cur.fetchone():
        return {"mode": "skipped", "reason": "already_queued"}
    cur.execute(
        """SELECT 1 FROM tasks
           WHERE source_ref = %s AND status = 'open'
             AND activity_type IN ('followup', 'followup_review') LIMIT 1""",
        (str(entity_id),),
    )
    if cur.fetchone():
        return {"mode": "skipped", "reason": "already_tasked"}

    ctx = _entity_context(cur, entity_type, entity_id)
    firm = ctx.get("firm") or ctx.get("title") or "this account"
    contact = ctx.get("contact_name") or "there"

    # Resolved before the anchor, not after: which mailbox this will leave from
    # decides which of the recorded threads is the one to reply on.
    try:
        sender_id = resolve_sender(cur, entity_type, entity_id, actor)
    except HTTPException:
        sender_id = _any_mailbox(cur)

    thread_id, in_reply_to, base_subject = _thread_anchor(
        cur, entity_type, entity_id, {}, sender_id=sender_id)
    to = _pick_followup_recipient(cur, entity_type, entity_id)

    # No conversation to continue → leave a task to open one.
    if not thread_id or not to:
        _firm, lead = _review_task_target(cur, entity_type, entity_id)
        owner = lead or actor or _any_mailbox(cur)
        if not owner:
            return {"mode": "skipped", "reason": "no_owner"}
        due = (datetime.now(timezone.utc) + timedelta(days=2)).date()
        cur.execute(
            """INSERT INTO tasks
                 (user_id, assigned_to, title, description, due_date, status,
                  kanban_status, source, source_ref, activity_type, priority)
               VALUES (%s::uuid, %s::uuid, %s, %s, %s::date, 'open', 'todo',
                       'auto', %s, 'followup', 'medium')
               RETURNING task_id""",
            (owner, owner, f"Follow up with {firm}",
             "No email thread on this deal yet — send the first outreach or a "
             "recap to get the conversation going.",
             due, str(entity_id)),
        )
        return {"mode": "task", "task_id": str(cur.fetchone()["task_id"])}

    # There is a thread → draft the next touch, approval-gated.
    subject = reply_subject(DEAL_FOLLOWUP_SUBJECT, base_subject)
    body = (
        f"Hi {contact},\n\n"
        "Circling back on my last note — I know inboxes get busy, so I wanted "
        "to make sure this didn't slip through.\n\n"
        f"If it's useful, I'm happy to put together a short overview of how we'd "
        f"approach {firm}'s use case and what a first step could look like.\n\n"
        "Would a brief call in the next week or two make sense?\n\n"
        "Best,"
    )
    when = datetime.now(timezone.utc) + timedelta(days=FOLLOWUP_REVIEW_DELAY_DAYS)
    cur.execute(
        """INSERT INTO scheduled_emails
             (entity_type, entity_id, to_email, cc_emails, subject, body,
              scheduled_for, cancel_on_reply, thread_id, in_reply_to, sender_id,
              created_by, watch_from, approval_required)
           VALUES (%s,%s,%s,%s,%s,%s,%s,true,%s,%s,%s,%s,NOW(),true)
           RETURNING scheduled_id""",
        (entity_type, entity_id, to, [], subject, body, when,
         thread_id, in_reply_to, sender_id, actor or sender_id),
    )
    scheduled_id = str(cur.fetchone()["scheduled_id"])
    task_id = _create_review_task(cur, entity_type, entity_id, sender_id, actor, when)
    if task_id:
        cur.execute(
            "UPDATE scheduled_emails SET review_task_id = %s WHERE scheduled_id = %s",
            (task_id, scheduled_id),
        )
    return {"mode": "email", "scheduled_id": scheduled_id, "to": to,
            "review_task_id": str(task_id) if task_id else None}


@router.post("/{entity_type}/{entity_id}/followup", status_code=201)
def create_followup(entity_type: str, entity_id: str, request: Request = None):
    """Draft the next approval-required follow-up (or a first-contact task) for a
    record. Safe to call repeatedly — no-ops if one is already pending."""
    _check_entity(entity_type)
    actor = _actor_id(request)
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            out = queue_review_followup(cur, entity_type, entity_id, actor)
            conn.commit()
            return out
    finally:
        conn.close()


@router.post("/{entity_type}/{entity_id}/send", status_code=201)
def send_now(entity_type: str, entity_id: str, body: dict, request: Request = None):
    _check_entity(entity_type)
    to = (body.get("to") or "").strip()
    subject = (body.get("subject") or "").strip()
    text = body.get("body") or ""
    if not to or not subject:
        raise HTTPException(status_code=400, detail="to and subject are required")

    actor = _actor_id(request)
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            sender_id = _pick_sender(cur, entity_type, entity_id, actor, body.get("sender_id"))
            token = _google_token(cur, sender_id)

            # Asked before this send is recorded, or it would never be the first.
            first_outreach = _is_first_outreach(cur, entity_type, entity_id)

            thread_id, in_reply_to, base_subject = _thread_anchor(
                cur, entity_type, entity_id, body, token, sender_id=sender_id)
            if thread_id:
                subject = reply_subject(subject, base_subject)

            parts = _build_attachments(token, body.get("attachments") or [], cur)

            # The sign-off belongs to the mailbox this leaves from, which is the
            # record's owner — not necessarily whoever pressed send.
            sig = load_signature(cur, sender_id)

            sent = _send_via_gmail(token, to=to, subject=subject, body=text,
                                   cc=body.get("cc") or [], thread_id=thread_id,
                                   in_reply_to=in_reply_to, attachment_parts=parts,
                                   signature=sig)

            _record_outbound(cur, entity_type, entity_id, sent,
                             to_emails=[to] + (body.get("cc") or []),
                             subject=subject, body=text, sender_id=sender_id,
                             rfc_message_id=_sent_rfc_id(token, sent.get("id")),
                             attachment_names=[n for n, _ in parts])

            _claim_funding(cur, entity_type, entity_id, actor)
            _mark_awaiting_investor(cur, entity_type, entity_id, actor)
            stamp_outreach_date(cur, entity_type, entity_id, datetime.now(timezone.utc))

            _register_address(cur, entity_type, entity_id, to)
            # If this went out from a saved draft, that draft is now history.
            _clear_draft(cur, body, sent=True, gmail_message_id=sent.get("id"))
            # Sending it by hand is the review, so its task is done.
            if body.get("scheduled_id"):
                _close_review_task(cur, body["scheduled_id"])

            queued_followup = None
            if first_outreach:
                queued_followup = _queue_first_followup(
                    cur, entity_type, entity_id,
                    to=to, cc=body.get("cc") or [], sender_id=sender_id,
                    actor=actor, thread_id=sent.get("threadId"),
                    outreach_subject=subject,
                )

            conn.commit()
            return {"gmail_message_id": sent.get("id"), "thread_id": sent.get("threadId"),
                    "followup_scheduled": queued_followup}
    finally:
        conn.close()


def _thread_anchor(cur, entity_type, entity_id, body, token=None, sender_id=None):
    """Where this send should land: (thread_id, in_reply_to, base_subject).

    Gmail's threadId keeps it in one conversation inside Gmail; In-Reply-To and
    References are what every other client threads on, and they need the RFC822
    Message-ID rather than the API id. When we have not recorded that header we
    ask Gmail for the newest message in the thread, so threading works even for
    conversations backfilled before the column existed.

    A threadId only means anything inside the one mailbox that issued it. When
    two of our mailboxes sit on the same conversation — one sent it, the other
    was Cc'd — the sync records that single email twice under two different
    thread ids, and handing Gmail the other mailbox's id 404s the send straight
    out of the conversation. So the anchor is resolved within the mailbox the
    mail will actually leave from. sender_id is what makes that possible; called
    without it, this falls back to newest-row-wins and takes its chances.
    """
    sender_id = str(sender_id) if sender_id else None
    thread_id = body.get("thread_id")
    in_reply_to = body.get("in_reply_to")
    base_subject = None

    if not thread_id:
        # A thread the sending mailbox can see, in preference to one it cannot.
        # Rows from before the mailbox was recorded rank in between: unknown is
        # a better bet than known-to-be-someone-else's.
        row = None
        if sender_id:
            # This mailbox's own id for the newest conversation on the record.
            cur.execute(
                """SELECT b.thread_id, m.rfc_message_id, m.subject
                     FROM comm_messages m
                     JOIN comm_message_mailboxes b ON b.message_id = m.message_id
                    WHERE m.entity_type = %s AND m.entity_id = %s
                      AND m.kind = 'email'
                      AND b.mailbox_user_id = %s::uuid
                      AND b.thread_id IS NOT NULL
                    ORDER BY m.occurred_at DESC LIMIT 1""",
                (entity_type, entity_id, sender_id),
            )
            row = cur.fetchone()
        if row is None:
            # Nothing this mailbox has seen. Rows predating the mailbox table
            # rank in between: unknown is a better bet than known-to-be-someone
            # -else's, and In-Reply-To threads it for the recipient either way.
            order = "occurred_at DESC"
            params = [entity_type, entity_id]
            if sender_id:
                order = ("CASE WHEN mailbox_user_id = %s::uuid THEN 0 "
                         "WHEN mailbox_user_id IS NULL THEN 1 ELSE 2 END, occurred_at DESC")
                params.append(sender_id)
            cur.execute(
                f"""SELECT thread_id, rfc_message_id, subject FROM comm_messages
                    WHERE entity_type = %s AND entity_id = %s
                      AND thread_id IS NOT NULL AND kind = 'email'
                    ORDER BY {order} LIMIT 1""",
                tuple(params),
            )
            row = cur.fetchone()
        if row:
            thread_id = row["thread_id"]
            in_reply_to = in_reply_to or row["rfc_message_id"]
            base_subject = row["subject"]
    elif sender_id:
        # Handed a thread from somewhere else — a follow-up queued days ago, or
        # the panel. It may name the other mailbox's copy, so translate it.
        thread_id, in_reply_to, base_subject = _thread_in_mailbox(
            cur, entity_type, entity_id, thread_id, in_reply_to, sender_id)

    if thread_id and not in_reply_to and token:
        anchor = _thread_tail(token, thread_id)
        if anchor:
            in_reply_to = anchor.get("rfc_message_id")
            base_subject = base_subject or anchor.get("subject")

    return thread_id, in_reply_to, base_subject


def _thread_in_mailbox(cur, entity_type, entity_id, thread_id, in_reply_to, sender_id):
    """This mailbox's own id for a conversation named by another mailbox's id.

    Thread ids differ per mailbox, but every mailbox holding a message agrees on
    its RFC822 Message-ID, so that header is what carries us across: read the
    Message-IDs in the thread we were handed, then find the same mail filed
    under this mailbox. A conversation this mailbox was never on has no local
    thread at all — send it with no threadId rather than a foreign one, because
    In-Reply-To still threads it for the recipient and a doomed threadId only
    buys a 404 and a stray conversation in our own Sent.
    """
    cur.execute(
        """SELECT 1 FROM comm_message_mailboxes
            WHERE thread_id = %s AND mailbox_user_id = %s::uuid LIMIT 1""",
        (thread_id, sender_id),
    )
    # Ours already — leave the caller's id alone.
    if cur.fetchone():
        return thread_id, in_reply_to, None

    # Every mailbox holding a message agrees on its message_id here, so the
    # translation is one join: their thread -> the emails in it -> our copies.
    cur.execute(
        """SELECT mine.thread_id, m.rfc_message_id, m.subject
             FROM comm_message_mailboxes theirs
             JOIN comm_message_mailboxes mine
               ON mine.message_id = theirs.message_id
              AND mine.mailbox_user_id = %s::uuid
             JOIN comm_messages m ON m.message_id = mine.message_id
            WHERE theirs.thread_id = %s
              AND m.entity_type = %s AND m.entity_id = %s
              AND mine.thread_id IS NOT NULL
            ORDER BY m.occurred_at DESC LIMIT 1""",
        (sender_id, thread_id, entity_type, entity_id),
    )
    row = cur.fetchone()
    if row:
        return row["thread_id"], in_reply_to or row["rfc_message_id"], row["subject"]

    logger.warning(
        "Gmail thread %s belongs to another mailbox and %s has no copy of that "
        "conversation — sending on In-Reply-To alone", thread_id, sender_id,
    )
    return None, in_reply_to, None


def _thread_tail(token: str, thread_id: str) -> Optional[dict]:
    """Message-ID and Subject of the most recent message in a Gmail thread."""
    try:
        r = httpx.get(f"{GMAIL_BASE}/threads/{thread_id}",
                      headers={"Authorization": f"Bearer {token}"},
                      params={"format": "metadata",
                              "metadataHeaders": ["Message-ID", "Subject"]},
                      timeout=20)
        if r.status_code != 200:
            return None
        msgs = r.json().get("messages") or []
        if not msgs:
            return None
        headers = {h["name"].lower(): h["value"]
                   for h in msgs[-1].get("payload", {}).get("headers", [])}
        return {"rfc_message_id": headers.get("message-id"),
                "subject": headers.get("subject")}
    except Exception:
        logger.warning("could not read thread %s", thread_id, exc_info=True)
        return None


def reply_subject(subject: str, base_subject: Optional[str]) -> str:
    """Keep the thread's subject, prefixed once. Clients that fall back to
    subject matching need it to line up with the conversation."""
    source = base_subject or subject or ""
    source = source.strip()
    if source.lower().startswith("re:"):
        return source
    return f"Re: {source}" if source else subject


def _register_address(cur, entity_type, entity_id, email):
    if not email:
        return
    # Never one of our own mailboxes: it is on every message, so a record
    # holding it matches the whole inbox.
    from app.tasks.comm_sync import _our_domains, is_our_address
    if is_our_address(email, _our_domains(cur)):
        return
    cur.execute(
        """INSERT INTO comm_addresses (entity_type, entity_id, email)
           VALUES (%s, %s, %s) ON CONFLICT (entity_type, entity_id, email) DO NOTHING""",
        (entity_type, entity_id, email.lower()),
    )


@router.post("/{entity_type}/{entity_id}/schedule", status_code=201)
def schedule_send(entity_type: str, entity_id: str, body: dict, request: Request = None):
    """Queue a follow-up. By default it only goes out if they stay silent."""
    _check_entity(entity_type)
    to = (body.get("to") or "").strip()
    subject = (body.get("subject") or "").strip()
    if not to or not subject:
        raise HTTPException(status_code=400, detail="to and subject are required")

    when = body.get("scheduled_for")
    if not when:
        days = int(body.get("delay_days") or 5)
        when = datetime.now(timezone.utc) + timedelta(days=days)

    actor = _actor_id(request)
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            sender_id = _pick_sender(cur, entity_type, entity_id, actor, body.get("sender_id"))
            thread_id, _anchor, _base = _thread_anchor(
                cur, entity_type, entity_id, body, sender_id=sender_id)
            in_reply_to = None  # resolved when it actually sends

            # Queueing a saved draft promotes that same row rather than copying
            # it, so the draft cannot linger next to the send it became.
            # watch_from restarts now: "only if they stay silent" means silent
            # from the moment it was queued, not from when it was first typed.
            if body.get("draft_id"):
                cur.execute(
                    """UPDATE scheduled_emails
                       SET status='scheduled', to_email=%s, cc_emails=%s, subject=%s,
                           body=%s, template_id=%s, scheduled_for=%s, cancel_on_reply=%s,
                           thread_id=%s, sender_id=%s, attachments=%s,
                           watch_from=NOW(), updated_at=NOW()
                       WHERE scheduled_id = %s AND status = 'draft'
                       RETURNING *""",
                    (to, body.get("cc") or [], subject, body.get("body") or "",
                     body.get("template_id"), when, body.get("cancel_on_reply", True),
                     thread_id, sender_id,
                     psycopg2.extras.Json(body.get("attachments") or []),
                     body["draft_id"]),
                )
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="No such draft")
                out = dict(row)
                conn.commit()
                return out

            cur.execute(
                """INSERT INTO scheduled_emails
                     (entity_type, entity_id, to_email, cc_emails, subject, body,
                      template_id, scheduled_for, cancel_on_reply, thread_id,
                      in_reply_to, sender_id, created_by, attachments)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   RETURNING *""",
                (entity_type, entity_id, to, body.get("cc") or [], subject,
                 body.get("body") or "", body.get("template_id"), when,
                 body.get("cancel_on_reply", True), thread_id, in_reply_to,
                 sender_id, actor, psycopg2.extras.Json(body.get("attachments") or [])),
            )
            out = dict(cur.fetchone())
            conn.commit()
            return out
    finally:
        conn.close()


@router.post("/scheduled/{scheduled_id}/approve")
def approve_scheduled(scheduled_id: str, request: Request = None):
    """Sign off on an automatic follow-up so the sweep may send it.

    Until this happens the email sits in the queue past its date rather than
    going out — a machine-written email reaching an investor unread is the thing
    this exists to prevent, and a missed deadline is the cheaper failure.
    """
    actor = _actor_id(request)
    if not actor:
        raise HTTPException(status_code=401, detail="Not signed in")
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE scheduled_emails
                   SET approved_at = NOW(), approved_by = %s, updated_at = NOW()
                   WHERE scheduled_id = %s AND status = 'scheduled'
                   RETURNING *""",
                (actor, scheduled_id),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="No such queued email")
            _close_review_task(cur, scheduled_id)
            conn.commit()
            return dict(row)
    finally:
        conn.close()


@router.patch("/scheduled/{scheduled_id}")
def update_scheduled(scheduled_id: str, body: dict):
    """Change a queued email before it goes out — wording, recipient, or when.

    Only while it is still waiting: once the sweep has sent it, there is nothing
    left to edit, and pretending otherwise would let someone "fix" an email the
    investor has already read.
    """
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT status FROM scheduled_emails WHERE scheduled_id = %s",
                (scheduled_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="No such queued email")
            if row["status"] != "scheduled":
                raise HTTPException(
                    status_code=409,
                    detail=f"This email is {row['status']} — only a queued one can be edited.",
                )

            sets, vals = [], []

            def put(col, val):
                sets.append(f"{col} = %s")
                vals.append(val)

            if "to" in body:
                to = (body.get("to") or "").strip()
                if not to:
                    raise HTTPException(status_code=422, detail="to cannot be empty")
                put("to_email", to)
            if "cc" in body:
                put("cc_emails", body.get("cc") or [])
            if "subject" in body:
                subject = (body.get("subject") or "").strip()
                if not subject:
                    raise HTTPException(status_code=422, detail="subject cannot be empty")
                put("subject", subject)
            if "body" in body:
                put("body", body.get("body") or "")
            if "attachments" in body:
                put("attachments", psycopg2.extras.Json(body.get("attachments") or []))
            if "cancel_on_reply" in body:
                put("cancel_on_reply", bool(body.get("cancel_on_reply")))
            # Either an explicit moment or "this many days from now", the same
            # two ways scheduling accepts in the first place.
            if body.get("scheduled_for"):
                put("scheduled_for", body["scheduled_for"])
            elif body.get("delay_days"):
                put("scheduled_for", datetime.now(timezone.utc) + timedelta(days=int(body["delay_days"])))

            if not sets:
                raise HTTPException(status_code=400, detail="Nothing to update")

            sets.append("updated_at = NOW()")
            vals.append(scheduled_id)
            cur.execute(
                f"UPDATE scheduled_emails SET {', '.join(sets)}"
                " WHERE scheduled_id = %s AND status = 'scheduled' RETURNING *",
                vals,
            )
            out = dict(cur.fetchone())
            conn.commit()
            return out
    finally:
        conn.close()


@router.delete("/scheduled/{scheduled_id}", status_code=204)
def cancel_scheduled(scheduled_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE scheduled_emails
                   SET status = 'cancelled', cancelled_reason = 'Cancelled by user', updated_at = NOW()
                   WHERE scheduled_id = %s AND status IN ('scheduled', 'failed')""",
                (scheduled_id,),
            )
            # An email nobody will send needs no review.
            _close_review_task(cur, scheduled_id)
            conn.commit()
    finally:
        conn.close()


@router.post("/scheduled/{scheduled_id}/retry")
def retry_scheduled(scheduled_id: str, request: Request = None):
    """Re-queue a failed send. With the deleted-thread fallback in place the
    resend goes out on the next sweep; it is re-approved so it needs no second
    sign-off (it was already reviewed before the first attempt)."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """UPDATE scheduled_emails
                   SET status='scheduled', error=NULL, scheduled_for=NOW(),
                       approved_at=NOW(), approved_by=%s, watch_from=NOW(),
                       updated_at=NOW()
                   WHERE scheduled_id = %s AND status = 'failed'
                   RETURNING *""",
                (_actor_id(request), scheduled_id),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="No failed email to retry")
            conn.commit()
            return dict(row)
    finally:
        conn.close()



# ── Drafts ───────────────────────────────────────────────────────────────────
#
# A draft is a scheduled_emails row with status 'draft' and no scheduled_for.
# Nothing sweeps it, nothing cancels it when they reply — it waits.

def _draft_or_404(cur, draft_id: str) -> dict:
    cur.execute(
        "SELECT * FROM scheduled_emails WHERE scheduled_id = %s AND status = 'draft'",
        (draft_id,),
    )
    row = cur.fetchone()
    if not row:
        # Either it never existed or it has already gone out; both mean the
        # caller is holding a stale reference, and neither is recoverable here.
        raise HTTPException(status_code=404, detail="No such draft")
    return dict(row)


@router.post("/{entity_type}/{entity_id}/drafts", status_code=201)
def save_draft(entity_type: str, entity_id: str, body: dict, request: Request = None):
    """Park a composed email. Deliberately undemanding about its contents — a
    half-written thought with no subject yet is exactly what drafts are for."""
    _check_entity(entity_type)
    to = (body.get("to") or "").strip()
    subject = (body.get("subject") or "").strip()
    text = body.get("body") or ""
    if not (to or subject or text.strip()):
        raise HTTPException(status_code=400, detail="Nothing to save")

    actor = _actor_id(request)
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # No resolve_sender here: saving must not fail because the owner has
            # not connected Google. The mailbox is resolved when it actually goes.
            cur.execute(
                """INSERT INTO scheduled_emails
                     (entity_type, entity_id, to_email, cc_emails, subject, body,
                      template_id, scheduled_for, cancel_on_reply, status,
                      created_by, attachments)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,NULL,%s,'draft',%s,%s)
                   RETURNING *""",
                (entity_type, entity_id, to, body.get("cc") or [], subject, text,
                 body.get("template_id"), body.get("cancel_on_reply", True),
                 actor, psycopg2.extras.Json(body.get("attachments") or [])),
            )
            out = dict(cur.fetchone())
            conn.commit()
            return out
    finally:
        conn.close()


@router.patch("/drafts/{draft_id}")
def update_draft(draft_id: str, body: dict):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            _draft_or_404(cur, draft_id)

            # Only what was sent is touched, so a partial save cannot blank a
            # field the composer did not have on screen.
            sets, vals = [], []

            def put(col, val):
                sets.append(f"{col} = %s")
                vals.append(val)

            if "to" in body:
                put("to_email", (body.get("to") or "").strip())
            if "cc" in body:
                put("cc_emails", body.get("cc") or [])
            if "subject" in body:
                put("subject", (body.get("subject") or "").strip())
            if "body" in body:
                put("body", body.get("body") or "")
            if "template_id" in body:
                put("template_id", body.get("template_id") or None)
            if "cancel_on_reply" in body:
                put("cancel_on_reply", bool(body.get("cancel_on_reply")))
            if "attachments" in body:
                put("attachments", psycopg2.extras.Json(body.get("attachments") or []))

            if not sets:
                raise HTTPException(status_code=400, detail="Nothing to update")

            sets.append("updated_at = NOW()")
            vals.append(draft_id)
            cur.execute(
                f"UPDATE scheduled_emails SET {', '.join(sets)}"
                " WHERE scheduled_id = %s AND status = 'draft' RETURNING *",
                vals,
            )
            out = dict(cur.fetchone())
            conn.commit()
            return out
    finally:
        conn.close()


@router.delete("/drafts/{draft_id}", status_code=204)
def discard_draft(draft_id: str):
    """Throw a draft away. Deleted rather than marked cancelled — a draft was
    never a commitment, so there is no decision worth keeping a record of."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            _draft_or_404(cur, draft_id)
            cur.execute(
                "DELETE FROM scheduled_emails WHERE scheduled_id = %s AND status = 'draft'",
                (draft_id,),
            )
            conn.commit()
    finally:
        conn.close()


def _clear_draft(cur, body: dict, *, sent: bool, gmail_message_id=None):
    """A draft or a queued email that has now gone out stops being pending.

    Called inside the send/schedule transaction, so neither can survive a
    successful send and go out a second time on the sweep.
    """
    row_id = body.get("draft_id") or body.get("scheduled_id")
    if not row_id:
        return
    if sent:
        cur.execute(
            """UPDATE scheduled_emails
               SET status = 'sent', sent_at = NOW(), gmail_message_id = %s, updated_at = NOW()
               WHERE scheduled_id = %s AND status IN ('draft', 'scheduled')""",
            (gmail_message_id, row_id),
        )
    else:
        cur.execute(
            "DELETE FROM scheduled_emails WHERE scheduled_id = %s AND status = 'draft'",
            (row_id,),
        )


# ── Signature endpoints ──────────────────────────────────────────────────────

def _signature_payload(cur, user_id: Optional[str], *, editable: bool) -> dict:
    cur.execute("SELECT signature FROM user_email_signatures WHERE user_id = %s", (user_id,))
    row = cur.fetchone()
    raw = (row["signature"] if row else "") or ""
    rendered = render_signature(raw) if raw.strip() else {"text": "", "html": ""}
    cur.execute("SELECT COALESCE(full_name, name, email) AS nm FROM users WHERE user_id = %s", (user_id,))
    who = cur.fetchone()
    # Two flavours of the same HTML: the mail one references the logo by
    # Content-ID, which a browser cannot resolve, so the preview points at the
    # served copy instead.
    return {"user_id": user_id, "signature": raw, "html": rendered["html"],
            "preview_html": rendered["html"].replace(
                f"cid:{LOGO_CID}", "/api/proxy/comms/signature-logo.png"),
            "editable": editable, "owner_name": who["nm"] if who else None}


@router.get("/signature-logo.png")
def signature_logo():
    """The signature logo, for the composer preview. Single path segment on
    purpose: a two-segment path would be swallowed by /{entity_type}/{entity_id}."""
    if not os.path.exists(LOGO_PATH):
        raise HTTPException(status_code=404, detail="No logo installed")
    return FileResponse(LOGO_PATH, media_type="image/png")


@router.get("/signature")
def get_my_signature(request: Request):
    actor = _actor_id(request)
    if not actor:
        raise HTTPException(status_code=401, detail="Not signed in")
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            return _signature_payload(cur, actor, editable=True)
    finally:
        conn.close()


@router.put("/signature")
def put_my_signature(body: dict, request: Request = None):
    """Only ever your own. Signing off in someone else's name is not an edit
    anyone should be able to make from a composer."""
    actor = _actor_id(request)
    if not actor:
        raise HTTPException(status_code=401, detail="Not signed in")
    raw = (body.get("signature") or "").strip()
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO user_email_signatures (user_id, signature)
                   VALUES (%s, %s)
                   ON CONFLICT (user_id) DO UPDATE
                     SET signature = EXCLUDED.signature, updated_at = NOW()""",
                (actor, raw),
            )
            out = _signature_payload(cur, actor, editable=True)
            conn.commit()
            return out
    finally:
        conn.close()


@router.get("/{entity_type}/{entity_id}/signature")
def get_send_signature(entity_type: str, entity_id: str,
                       sender_id: Optional[str] = Query(None),
                       request: Request = None):
    """The signature this record's email will actually carry.

    Resolved from the sending mailbox rather than the reader, so the composer
    shows the truth when writing on a record someone else owns — and says so by
    returning editable=false, since it is not yours to change.
    """
    _check_entity(entity_type)
    actor = _actor_id(request)
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            chosen = None
            if sender_id:
                cur.execute("SELECT 1 FROM google_oauth_tokens WHERE user_id = %s", (sender_id,))
                if cur.fetchone():
                    chosen = str(sender_id)
            if not chosen:
                try:
                    chosen = resolve_sender(cur, entity_type, entity_id, actor)
                except HTTPException:
                    # Nobody can send yet. Showing your own is the useful answer —
                    # it is what will go out once a mailbox is connected.
                    chosen = actor
            return _signature_payload(cur, chosen, editable=chosen == actor)
    finally:
        conn.close()


# ── Test sends ───────────────────────────────────────────────────────────────

@router.post("/{entity_type}/{entity_id}/send-test")
def send_test(entity_type: str, entity_id: str, body: dict, request: Request = None):
    """Send the composed email to the requesting user's own inbox.

    From and to the person clicking, not the record's owner — a test is for
    seeing what you wrote, and it must never reach the investor. It leaves no
    trace: no timeline entry, no status change, no address registered, so a
    test cannot be mistaken later for real correspondence.
    """
    _check_entity(entity_type)
    actor = _actor_id(request)
    if not actor:
        raise HTTPException(status_code=401, detail="Not signed in")

    subject = (body.get("subject") or "").strip()
    text = body.get("body") or ""
    if not subject and not text.strip():
        raise HTTPException(status_code=400, detail="Nothing to test")

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT google_email FROM google_oauth_tokens WHERE user_id = %s",
                (actor,),
            )
            row = cur.fetchone()
            if not row or not row["google_email"]:
                raise HTTPException(
                    status_code=422,
                    detail="Connect your Google account to send yourself a test.",
                )
            me = row["google_email"]
            # From the chosen mailbox when one is picked (so the test carries that
            # sender's signature), otherwise your own.
            sender = actor
            requested = body.get("sender_id")
            if requested:
                cur.execute("SELECT 1 FROM google_oauth_tokens WHERE user_id = %s", (str(requested),))
                if cur.fetchone():
                    sender = str(requested)
            token = _google_token(cur, sender)

            # Attachments are built too, so the test also proves the deck is
            # attachable and the right size.
            parts = _build_attachments(token, body.get("attachments") or [], cur)

            sent = _send_via_gmail(token, to=me, subject=f"[TEST] {subject}",
                                   body=text, attachment_parts=parts,
                                   signature=load_signature(cur, sender))
            return {"sent_to": me, "gmail_message_id": sent.get("id")}
    finally:
        conn.close()


@router.post("/sync")
def sync_now():
    """Pull Gmail immediately rather than waiting for the next sweep."""
    from app.tasks.contacts_sync import sync_gmail_incremental

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT user_id::text AS uid FROM google_oauth_tokens")
            uids = [r["uid"] for r in cur.fetchall()]
    finally:
        conn.close()

    synced = 0
    for uid in uids:
        result = sync_gmail_incremental(uid)
        synced += result.get("synced", 0) or 0
    return {"ok": True, "synced": synced, "mailboxes": len(uids)}


@router.post("/{entity_type}/{entity_id}/backfill")
def backfill_entity(entity_type: str, entity_id: str):
    """Pull PAST Gmail for this record's linked addresses onto its timeline. The
    ongoing sync only catches new mail, so this fills in history on demand."""
    _check_entity(entity_type)
    from app.tasks.contacts_sync import backfill_entity_gmail
    return backfill_entity_gmail(entity_type, entity_id)


@router.post("/{entity_type}/{entity_id}/contacts", status_code=201)
def add_contact(entity_type: str, entity_id: str, body: dict):
    """Link a person or a shared inbox to this record.

    Creates the contact if the address is new, so what is typed here is a real
    contact — and a live matching key for the Gmail sync — rather than text on
    one record.
    """
    _check_entity(entity_type)
    from app.tasks.comm_sync import ensure_contact_address

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            email = (body.get("email") or "").strip()

            # Linking an existing contact: take its details rather than asking
            # the caller to retype them.
            if body.get("contact_id"):
                cur.execute(
                    "SELECT name, email, title FROM contacts WHERE contact_id = %s",
                    (body["contact_id"],),
                )
                existing = cur.fetchone()
                if not existing:
                    raise HTTPException(status_code=404, detail="Contact not found")
                email = email or (existing["email"] or "")
                if "@" not in email:
                    raise HTTPException(
                        status_code=422,
                        detail="That contact has no email address — add one on the contact first.",
                    )
                body = {**body, "name": body.get("name") or existing["name"],
                        "role": body.get("role") or existing["title"]}

            if "@" not in email:
                raise HTTPException(status_code=400, detail="A valid email address is required")

            org = None
            if entity_type == "investor":
                cur.execute("SELECT firm FROM dilutive_investors WHERE investor_id = %s", (entity_id,))
                row = cur.fetchone()
                org = row["firm"] if row else None
            contact_id = ensure_contact_address(
                cur, entity_type, entity_id, email=email,
                name=body.get("name"), role=body.get("role"), organization=org,
            )
            conn.commit()
            return {"contact_id": str(contact_id) if contact_id else None, "email": email.lower()}
    finally:
        conn.close()


@router.delete("/addresses/{address_id}", status_code=204)
def unlink_address(address_id: str):
    """Unlink an address from a record. The contact itself is left alone — it
    may be linked to a project or deal as well."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM comm_addresses WHERE address_id = %s", (address_id,))
            conn.commit()
    finally:
        conn.close()


@router.patch("/addresses/{address_id}")
def update_address(address_id: str, body: dict):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if body.get("is_primary"):
                cur.execute(
                    """UPDATE comm_addresses SET is_primary = false
                       WHERE (entity_type, entity_id) =
                             (SELECT entity_type, entity_id FROM comm_addresses WHERE address_id = %s)""",
                    (address_id,),
                )
            sets, vals = [], []
            for field in ("is_primary", "sendable", "is_organizational"):
                if field in body:
                    sets.append(f"{field} = %s")
                    vals.append(bool(body[field]))
            if not sets:
                raise HTTPException(status_code=400, detail="Nothing to update")
            cur.execute(
                f"UPDATE comm_addresses SET {', '.join(sets)} WHERE address_id = %s RETURNING *",
                vals + [address_id],
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Address not found")
            conn.commit()
            return dict(row)
    finally:
        conn.close()


# ── Off-email touches ────────────────────────────────────────────────────────

@router.post("/{entity_type}/{entity_id}/log-touch", status_code=201)
def log_touch(entity_type: str, entity_id: str, body: dict, request: Request = None):
    """Record a LinkedIn message, call or form submission.

    Investors reached that way have no mail to sync, so without this their
    last-contact date would never move.
    """
    _check_entity(entity_type)
    channel = (body.get("channel") or "linkedin").strip()
    direction = body.get("direction") or "outbound"
    if direction not in ("inbound", "outbound"):
        raise HTTPException(status_code=400, detail="direction must be inbound or outbound")

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO comm_messages
                     (entity_type, entity_id, gmail_message_id, direction, subject,
                      snippet, occurred_at, seen_by, sent_by_platform)
                   VALUES (%s, %s, %s, %s, %s, %s, COALESCE(%s::timestamptz, NOW()), %s, true)
                   RETURNING *""",
                (entity_type, entity_id, f"touch:{uuid.uuid4()}", direction,
                 body.get("subject") or f"{channel.capitalize()} message",
                 (body.get("note") or "")[:500], body.get("occurred_at"),
                 _actor_id(request)),
            )
            out = dict(cur.fetchone())
            if direction == "inbound":
                from app.tasks import comm_sync
                comm_sync.apply_inbound(cur, entity_type, entity_id, out["occurred_at"])
            conn.commit()
            return out
    finally:
        conn.close()


MANUAL_MESSAGE_FIELDS = {"subject", "snippet", "occurred_at"}


def _manual_message_or_refuse(cur, message_id: str) -> dict:
    """A hand-logged touch, or an explanation of why this one cannot be changed.

    Synced Gmail messages are deliberately out of reach: they are a record of
    what happened in a mailbox nobody edits from here, and the next sync would
    put back anything removed. A wrongly logged LinkedIn message is the case
    this exists for.
    """
    cur.execute(
        "SELECT message_id, gmail_message_id, kind FROM comm_messages WHERE message_id = %s",
        (message_id,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="No such entry")
    if not (row["gmail_message_id"] or "").startswith("touch:"):
        raise HTTPException(
            status_code=409,
            detail="This came from Gmail, so it cannot be edited here — the next sync would restore it.",
        )
    return dict(row)


@router.patch("/messages/{message_id}")
def update_manual_message(message_id: str, body: dict):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            _manual_message_or_refuse(cur, message_id)

            sets, vals = [], []
            if "subject" in body:
                subject = (body.get("subject") or "").strip()
                if not subject:
                    raise HTTPException(status_code=422, detail="subject cannot be empty")
                sets.append("subject = %s"); vals.append(subject[:500])
            if "note" in body:
                sets.append("snippet = %s"); vals.append((body.get("note") or "")[:500])
            if "occurred_at" in body and body.get("occurred_at"):
                sets.append("occurred_at = %s::timestamptz"); vals.append(body["occurred_at"])
            if not sets:
                raise HTTPException(status_code=400, detail="Nothing to update")

            vals.append(message_id)
            cur.execute(
                f"UPDATE comm_messages SET {', '.join(sets)} WHERE message_id = %s RETURNING *",
                vals,
            )
            out = dict(cur.fetchone())
            conn.commit()
            return out
    finally:
        conn.close()


@router.delete("/messages/{message_id}", status_code=204)
def delete_manual_message(message_id: str):
    """Remove a hand-logged touch that should not have been recorded.

    The status it may have flipped at the time is left where it is: that was a
    decision someone acted on afterwards, and silently reversing it would be a
    second wrong entry rather than an undo of the first.
    """
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            _manual_message_or_refuse(cur, message_id)
            cur.execute("DELETE FROM comm_messages WHERE message_id = %s", (message_id,))
            conn.commit()
    finally:
        conn.close()


# ── AI drafting ──────────────────────────────────────────────────────────────

PLACEHOLDER = re.compile(r"\{\{\s*([a-z_]+)\s*\}\}")

_DRAFT_PROMPT = (
    "You are writing on behalf of Open ERP, an early-stage biotech/foodtech company raising "
    "capital. Open ERP converts food-industry sidestreams into high-value compounds using "
    "engineered fermentation.\n\n"
    "Rewrite the template below into a specific, credible email to this investor. Keep it "
    "short — under 150 words. Reference what genuinely fits their thesis; never invent facts "
    "about them or about Open ERP. If a detail is unknown, leave it out rather than guessing. "
    "Do not use exclamation marks or superlatives. Keep any placeholder the template leaves "
    "you unable to fill.\n\n"
    "Return ONLY valid JSON: {\"subject\": string, \"body\": string}"
)


@router.post("/{entity_type}/{entity_id}/draft")
def draft_email(entity_type: str, entity_id: str, body: dict):
    """Tailor a template to one record using what we know about it."""
    _check_entity(entity_type)
    import anthropic
    import json as _json

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            ctx = _entity_context(cur, entity_type, entity_id)

            subject = body.get("subject") or ""
            text = body.get("body") or ""
            if body.get("template_id"):
                cur.execute("SELECT subject, body FROM email_templates WHERE template_id = %s",
                            (body["template_id"],))
                t = cur.fetchone()
                if t:
                    subject = subject or t["subject"]
                    text = text or t["body"]

            # Fill what we can mechanically, so the model only handles judgement.
            subject = _fill(subject, ctx)
            text = _fill(text, ctx)

            # Recent thread, so a follow-up does not repeat the first email.
            cur.execute(
                """SELECT direction, subject, snippet, occurred_at FROM comm_messages
                   WHERE entity_type = %s AND entity_id = %s
                   ORDER BY occurred_at DESC LIMIT 6""",
                (entity_type, entity_id),
            )
            history = [
                f"[{r['occurred_at']:%Y-%m-%d}] {r['direction'].upper()} — {r['subject']}: {(r['snippet'] or '')[:200]}"
                for r in cur.fetchall()
            ]
    finally:
        conn.close()

    facts = "\n".join(f"{k}: {v}" for k, v in ctx.items() if v)
    convo = "\n".join(reversed(history)) or "(no prior correspondence)"

    prompt = (
        f"{_DRAFT_PROMPT}\n\nWhat we know about them:\n{facts}\n\n"
        f"Correspondence so far:\n{convo}\n\n"
        f"Template subject: {subject}\nTemplate body:\n{text}"
    )

    client = anthropic.Anthropic()
    msg = client.messages.create(
        model="claude-sonnet-5",
        max_tokens=1200,
        messages=[{"role": "user", "content": prompt}],
    )
    # Sonnet returns thinking blocks ahead of the answer, so take the first
    # text block rather than assuming content[0].
    raw = next((b.text for b in msg.content if getattr(b, "type", None) == "text"), "").strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    try:
        out = _json.loads(raw.strip())
    except Exception:
        raise HTTPException(status_code=502, detail="Could not parse the drafted email")

    return {"subject": out.get("subject") or subject, "body": out.get("body") or text}


def _fill(text: str, ctx: dict) -> str:
    return PLACEHOLDER.sub(lambda m: str(ctx.get(m.group(1)) or m.group(0)), text or "")


def _entity_context(cur, entity_type: str, entity_id: str) -> dict:
    if entity_type == "investor":
        cur.execute(
            """SELECT i.firm, i.name, i.role, i.focus, i.investment_stage, i.avg_check_size,
                      i.hq, i.geo_focus, i.description, i.enrichment_notes, i.investor_type,
                      i.pipeline_stage,
                      (SELECT c.name FROM comm_addresses a
                        JOIN contacts c ON c.contact_id = a.contact_id
                        WHERE a.entity_type = 'investor' AND a.entity_id = i.investor_id
                          AND a.is_primary AND NOT a.is_organizational
                        LIMIT 1) AS primary_contact
               FROM dilutive_investors i WHERE i.investor_id = %s""",
            (entity_id,),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Investor not found")
        return {
            "firm": r["firm"],
            # Greeting a shared inbox by name reads badly, so fall back to nothing.
            "contact_name": r["primary_contact"] or r["name"] or "",
            "role": r["role"],
            "focus": r["focus"],
            "stage": r["investment_stage"],
            "check_size": r["avg_check_size"],
            "hq": r["hq"],
            "geo_focus": r["geo_focus"],
            "investor_type": r["investor_type"],
            "pipeline_stage": r["pipeline_stage"],
            "description": r["description"],
            "notes": r["enrichment_notes"],
        }

    if entity_type == "funding":
        cur.execute(
            """SELECT fo.title, fo.stage, fo.funding_type, fo.amount, fo.amount_currency,
                      fo.deadline, fo.tags,
                      (SELECT n.body FROM funding_notes n
                        WHERE n.opportunity_id = fo.opportunity_id
                        ORDER BY n.created_at DESC LIMIT 1) AS latest_note
               FROM funding_opportunities fo WHERE fo.opportunity_id = %s""",
            (entity_id,),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Opportunity not found")
        return {
            # The funder is the counterparty here; there is no person to greet,
            # so contact_name stays empty and templates fall through to a
            # neutral opening.
            "firm": r["title"],
            "contact_name": "",
            "title": r["title"],
            "stage": r["stage"],
            "funding_type": r["funding_type"],
            "amount": f"{r['amount']:,.0f} {r['amount_currency']}" if r["amount"] else "",
            "deadline": r["deadline"].isoformat() if r["deadline"] else "",
            "focus": ", ".join(r["tags"] or []),
            "notes": r["latest_note"],
        }

    cur.execute(
        """SELECT d.title, d.description, c.name AS company,
                  (SELECT co.name FROM comm_addresses a
                     JOIN contacts co ON co.contact_id = a.contact_id
                    WHERE a.entity_type = 'deal' AND a.entity_id = d.deal_id
                      AND a.is_primary AND NOT a.is_organizational
                    LIMIT 1) AS primary_contact
           FROM crm_deals d LEFT JOIN companies c ON c.company_id = d.company_id
           WHERE d.deal_id = %s""",
        (entity_id,),
    )
    r = cur.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="Deal not found")
    return {"firm": r["company"] or r["title"], "contact_name": r["primary_contact"] or "",
            "description": r["description"], "title": r["title"]}


# ── Finding a thread by hand ─────────────────────────────────────────────────
#
# The matcher files mail on evidence: a known address, a thread we already hold,
# and for funding a domain or a distinctive phrase from the title. That covers
# the correspondence anyone would expect it to and misses the rest — a programme
# officer writing from a personal address, an introduction forwarded by a third
# party, a thread that predates the record existing. None of those are matcher
# failures; there was nothing to match on.
#
# So: search the mailboxes, pick the thread, attach it. Attaching is not a
# special kind of record — it runs the same code the sync runs, so the thread
# lands in the timeline exactly as a matched one would, and the counterparty's
# address is learned on the way in. That last part is what makes this additive
# rather than parallel: attach a thread once and the automatic sync owns the
# conversation from then on.


def _thread_summary(token: str, thread_id: str) -> Optional[dict]:
    """Subject, participants and dates for one thread, in a single call."""
    try:
        r = httpx.get(
            f"{GMAIL_BASE}/threads/{thread_id}",
            headers={"Authorization": f"Bearer {token}"},
            params={"format": "metadata",
                    "metadataHeaders": ["Subject", "From", "To", "Cc", "Date", "Message-ID"]},
            timeout=20)
        if r.status_code != 200:
            return None
        messages = r.json().get("messages", [])
        if not messages:
            return None
    except Exception:
        logger.warning("thread %s could not be read", thread_id, exc_info=True)
        return None

    def hdrs(m):
        return {h["name"].lower(): h["value"] for h in m.get("payload", {}).get("headers", [])}

    first, last = hdrs(messages[0]), hdrs(messages[-1])
    people: list = []
    for m in messages:
        h = hdrs(m)
        for raw in (h.get("from", ""), h.get("to", ""), h.get("cc", "")):
            for addr in _addresses(raw):
                if addr not in people:
                    people.append(addr)

    # An RFC 2822 Date header sorts alphabetically, which puts "Mon, 4 Aug"
    # after "Wed, 27 Aug". Parse it once, here, and hand out something both the
    # sort below and the browser can read.
    try:
        last_at = parsedate_to_datetime(last.get("date", ""))
    except Exception:
        last_at = None

    return {
        "thread_id": thread_id,
        "subject": first.get("subject") or "(no subject)",
        "from_email": (_addresses(first.get("from", "")) or [None])[0],
        "participants": people,
        "message_count": len(messages),
        "last_date": last_at.isoformat() if last_at else last.get("date"),
        "_sort_key": last_at.timestamp() if last_at else 0.0,
        "rfc_message_ids": [hdrs(m).get("message-id") for m in messages],
        "snippet": (messages[-1].get("snippet") or "")[:200],
    }


@router.get("/{entity_type}/{entity_id}/gmail-search")
def gmail_search(entity_type: str, entity_id: str,
                 q: str = Query(..., min_length=2),
                 limit: int = Query(8, ge=1, le=20),
                 request: Request = None):
    """Threads in our mailboxes matching q, and whether this record has them.

    Every connected mailbox is searched, not just the caller's: the thread you
    are looking for is frequently in a colleague's inbox, which is the whole
    reason it never reached this record on its own. Results are keyed by the
    RFC Message-IDs they contain, so one conversation held by two mailboxes is
    one row here rather than two near-identical ones.

    q is passed to Gmail as written, so its own operators work — from:, to:,
    subject:, before:, has:attachment. A bare phrase searches everything.
    """
    _check_entity(entity_type)
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT user_id::text AS uid, google_email FROM google_oauth_tokens "
                "WHERE google_email IS NOT NULL ORDER BY google_email")
            mailboxes = cur.fetchall()
            if not mailboxes:
                raise HTTPException(status_code=400, detail="google_not_connected")

            found: dict = {}
            for mb in mailboxes:
                try:
                    token = _google_token(cur, mb["uid"])
                except HTTPException:
                    continue
                try:
                    r = httpx.get(f"{GMAIL_BASE}/threads",
                                  headers={"Authorization": f"Bearer {token}"},
                                  params={"q": q, "maxResults": limit},
                                  timeout=20)
                    if r.status_code != 200:
                        continue
                    thread_refs = r.json().get("threads", [])
                except Exception:
                    logger.warning("gmail search failed for %s", mb["google_email"],
                                   exc_info=True)
                    continue

                for ref in thread_refs[:limit]:
                    summary = _thread_summary(token, ref["id"])
                    if not summary:
                        continue
                    rfc_ids = [m for m in summary["rfc_message_ids"] if m]
                    # One conversation, however many of our mailboxes hold it.
                    key = rfc_ids[0] if rfc_ids else f"{mb['uid']}:{ref['id']}"
                    if key in found:
                        found[key]["mailboxes"].append(
                            {"user_id": mb["uid"], "email": mb["google_email"],
                             "thread_id": ref["id"]})
                        continue
                    summary["mailboxes"] = [
                        {"user_id": mb["uid"], "email": mb["google_email"],
                         "thread_id": ref["id"]}]
                    found[key] = summary

            # How much of each thread this record already holds, so the caller
            # can say "3 of 4 attached" instead of offering a no-op.
            for summary in found.values():
                rfc_ids = [m for m in summary["rfc_message_ids"] if m]
                if rfc_ids:
                    cur.execute(
                        "SELECT count(*) AS c FROM comm_messages "
                        "WHERE entity_type=%s AND entity_id=%s AND rfc_message_id = ANY(%s)",
                        (entity_type, entity_id, rfc_ids))
                    summary["attached_count"] = cur.fetchone()["c"]
                else:
                    summary["attached_count"] = 0
                summary.pop("rfc_message_ids", None)

            conn.commit()  # token refreshes are worth keeping
            results = sorted(found.values(),
                             key=lambda s: s.pop("_sort_key", 0.0), reverse=True)
            return {"query": q, "threads": results[:limit],
                    "mailboxes_searched": [m["google_email"] for m in mailboxes]}
    finally:
        conn.close()


@router.post("/{entity_type}/{entity_id}/attach-thread", status_code=201)
def attach_thread(entity_type: str, entity_id: str, body: dict, request: Request = None):
    """Record every message in a Gmail thread against this record.

    The whole thread, not the one message that matched the search: a timeline
    holding the reply but not the question is worse than one holding neither.
    """
    _check_entity(entity_type)
    thread_id = (body.get("thread_id") or "").strip()
    mailbox_user_id = body.get("mailbox_user_id")
    if not thread_id or not mailbox_user_id:
        raise HTTPException(status_code=400,
                            detail="thread_id and mailbox_user_id are required")

    from app.tasks.comm_sync import attach_message, _our_domains

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            token = _google_token(cur, str(mailbox_user_id))
            r = httpx.get(
                f"{GMAIL_BASE}/threads/{thread_id}",
                headers={"Authorization": f"Bearer {token}"},
                params={"format": "metadata",
                        "metadataHeaders": ["Subject", "From", "To", "Cc", "Date", "Message-ID"]},
                timeout=25)
            if r.status_code != 200:
                raise HTTPException(status_code=404, detail="Thread not found in that mailbox")
            messages = r.json().get("messages", [])
            if not messages:
                raise HTTPException(status_code=404, detail="That thread has no messages")

            our_domains = _our_domains(cur)
            attached = 0
            for m in messages:
                h = {x["name"].lower(): x["value"]
                     for x in m.get("payload", {}).get("headers", [])}
                try:
                    occurred_at = parsedate_to_datetime(h.get("date", ""))
                except Exception:
                    occurred_at = datetime.now(timezone.utc)
                from_list = _addresses(h.get("from", ""))
                recipients = list(dict.fromkeys(
                    _addresses(h.get("to", "")) + _addresses(h.get("cc", ""))))
                if attach_message(
                        cur, entity_type, entity_id,
                        msg_id=m["id"], thread_id=m.get("threadId") or thread_id,
                        from_email=(from_list[0] if from_list else ""),
                        to_emails=recipients,
                        subject=h.get("subject"), snippet=m.get("snippet"),
                        occurred_at=occurred_at, user_id=str(mailbox_user_id),
                        our_domains=our_domains,
                        rfc_message_id=h.get("message-id")):
                    attached += 1

            # Learn the outside addresses, so the sync owns this conversation
            # from here and nobody has to come back and attach the next reply.
            learned = 0
            for m in messages:
                h = {x["name"].lower(): x["value"]
                     for x in m.get("payload", {}).get("headers", [])}
                for raw in (h.get("from", ""), h.get("to", ""), h.get("cc", "")):
                    for addr in _addresses(raw):
                        if addr.split("@")[-1].lower() in our_domains:
                            continue
                        cur.execute(
                            "INSERT INTO comm_addresses (entity_type, entity_id, email) "
                            "VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                            (entity_type, entity_id, addr.lower()))
                        learned += cur.rowcount

            _claim_funding(cur, entity_type, entity_id, _actor_id(request))

            # A funding suggestion for the same mail is now answered — leaving it
            # in the waiting room would ask about something already on the board.
            if entity_type == "funding":
                cur.execute(
                    "UPDATE funding_email_suggestions SET status='accepted', resolved_at=NOW() "
                    "WHERE opportunity_id=%s AND status='suggested' "
                    "AND gmail_message_id = ANY(%s)",
                    (entity_id, [m["id"] for m in messages]))

            conn.commit()
            return {"attached": attached, "in_thread": len(messages),
                    "addresses_learned": learned}
    finally:
        conn.close()
