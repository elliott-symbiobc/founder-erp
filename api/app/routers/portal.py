"""
portal.py — Client-facing document portals.

Public (no auth):
  GET  /portal/{token}                          — project info + file list (or {password_required:true})
  POST /portal/{token}/auth                     — authenticate with password, receive session token
  GET  /portal/{token}/files/{file_id}/download — proxy file download from Drive
  GET  /portal/{token}/folders/{folder_id}      — list subfolder contents
  POST /portal/{token}/track                    — log viewer activity (page visit, file view)
  GET  /portal/{token}/room                     — curated investor-room content (session-gated)
  POST /portal/{token}/identify                 — what this email should see next
  POST /portal/{token}/register                 — allowlisted email sets a password
  POST /portal/{token}/login                    — registered viewer logs in
  POST /portal/{token}/request-access           — file an access request

Authenticated (X-User-Id required):
  POST   /projects/{project_id}/portal                        — create portal link
  GET    /projects/{project_id}/portal                        — get portal info
  PATCH  /projects/{project_id}/portal/folder                 — set/change portal's own Drive folder
  PATCH  /projects/{project_id}/portal/content                — set description / password settings
  PATCH  /projects/{project_id}/portal/slug                   — set/clear custom short slug
  PATCH  /projects/{project_id}/portal/assign                 — assign/unassign employee
  PATCH  /projects/{project_id}/portal/category               — set category (client/investor/partner)
  GET    /projects/{project_id}/portal/content                — get description + contacts + updates
  POST   /projects/{project_id}/portal/contacts               — add contact
  PATCH  /projects/{project_id}/portal/contacts/{cid}         — edit contact
  DELETE /projects/{project_id}/portal/contacts/{cid}         — delete contact
  POST   /projects/{project_id}/portal/updates                — post update
  DELETE /projects/{project_id}/portal/updates/{uid}          — delete update
  DELETE /projects/{project_id}/portal                        — revoke portal
  GET    /portals                                             — list all portals

  GET    /projects/{project_id}/portal/viewers                — list investors/viewers
  POST   /projects/{project_id}/portal/viewers                — add investor with password
  PATCH  /projects/{project_id}/portal/viewers/{vid}          — update investor
  DELETE /projects/{project_id}/portal/viewers/{vid}          — remove investor
  GET    /projects/{project_id}/portal/activity               — access log

  GET    /portals/room/{portal_id}/blocks                     — room content (incl. hidden)
  POST   /portals/room/{portal_id}/blocks                     — add a content tile
  PATCH  /portals/room/{portal_id}/blocks/{block_id}          — edit a content tile
  DELETE /portals/room/{portal_id}/blocks/{block_id}          — remove a content tile
  PUT    /portals/room/{portal_id}/sections/{section}         — set section title/order/visibility

  GET    /portals/room/{portal_id}/allowed-emails             — access list
  POST   /portals/room/{portal_id}/allowed-emails             — bulk-add addresses
  DELETE /portals/room/{portal_id}/allowed-emails/{allow_id}  — remove an address
  GET    /portals/room/{portal_id}/access-requests            — request queue
  PATCH  /portals/room/{portal_id}/access-requests/{req_id}   — approve / deny
"""

import logging
import uuid
import urllib.parse
import unicodedata
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import httpx
import psycopg2
import psycopg2.extras
from psycopg2.extras import Json
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from typing import Optional

try:
    import bcrypt as bcrypt_lib
except ImportError:
    bcrypt_lib = None  # type: ignore

logger = logging.getLogger(__name__)

router = APIRouter(tags=["portal"])

DRIVE_FILES_URL  = "https://www.googleapis.com/drive/v3/files"
DRIVE_EXPORT_URL = "https://www.googleapis.com/drive/v3/files/{id}/export"

EXPORTABLE_TO_PDF = {
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.spreadsheet",
    "application/vnd.google-apps.presentation",
}


# ── DB helpers ────────────────────────────────────────────────────────────────

def _conn():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def _require_user(request: Request) -> str:
    uid = request.headers.get("X-User-Id")
    if not uid:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return uid


def _serialize(obj):
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    return obj


def _row_dict(row) -> dict:
    return {k: _serialize(v) for k, v in dict(row).items()}


def _hash_password(password: str) -> str:
    if bcrypt_lib is None:
        raise HTTPException(status_code=500, detail="bcrypt not available")
    return bcrypt_lib.hashpw(password.encode(), bcrypt_lib.gensalt()).decode()


def _check_password(password: str, hashed: str) -> bool:
    if bcrypt_lib is None:
        return False
    try:
        return bcrypt_lib.checkpw(password.encode(), hashed.encode())
    except Exception:
        return False


def _get_active_portal_id(cur, project_id: str) -> str:
    """Return portal_id for the active portal of project_id, or raise 404."""
    cur.execute(
        "SELECT portal_id FROM project_portals WHERE project_id=%s AND is_active=true",
        [project_id],
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="No active portal for this project")
    return str(row["portal_id"])


# ── Token validation ──────────────────────────────────────────────────────────

def _validate_token(token: str) -> dict:
    """Return portal row or raise 404/403."""
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT pp.portal_id, pp.project_id, pp.label, pp.created_by,
                      pp.expires_at, pp.is_active,
                      pp.portal_drive_folder_id, pp.portal_drive_folder_name,
                      pp.description,
                      pp.is_password_protected, pp.password_hash,
                      pp.name AS standalone_name,
                      pp.slug, pp.assigned_to, pp.category,
                      p.name AS project_name,
                      p.drive_folder_id AS project_drive_folder_id,
                      p.drive_folder_name AS project_drive_folder_name
               FROM project_portals pp
               LEFT JOIN projects p ON p.project_id = pp.project_id
               WHERE pp.token = %s OR pp.slug = %s""",
            [token, token],
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Portal not found")
    if not row["is_active"]:
        raise HTTPException(status_code=403, detail="This portal link has been revoked")
    if row["expires_at"] and datetime.now(timezone.utc) > row["expires_at"]:
        raise HTTPException(status_code=403, detail="This portal link has expired")

    effective_folder_id   = row["portal_drive_folder_id"] or row.get("project_drive_folder_id")
    effective_folder_name = row["portal_drive_folder_name"] or row.get("project_drive_folder_name")
    display_name = row.get("project_name") or row.get("standalone_name") or "Data Room"

    d = _row_dict(row)
    d["effective_folder_id"]   = effective_folder_id
    d["effective_folder_name"] = effective_folder_name
    d["display_name"]          = display_name
    return d


def _validate_portal_session(portal_id: str, session_token: str | None) -> dict | None:
    """Validate a portal session token. Returns viewer row or None if invalid."""
    if not session_token:
        return None
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT ps.session_token, ps.portal_id, ps.viewer_id, ps.expires_at,
                      pv.name AS viewer_name, pv.email AS viewer_email, pv.firm AS viewer_firm
               FROM portal_sessions ps
               LEFT JOIN portal_viewers pv ON pv.viewer_id = ps.viewer_id
               WHERE ps.session_token = %s AND ps.portal_id = %s""",
            [session_token, portal_id],
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        return None
    if row["expires_at"] and datetime.now(timezone.utc) > row["expires_at"]:
        return None
    return _row_dict(row)


def _require_portal_session(portal: dict, request: Request) -> dict:
    """For password-protected portals, require a valid session. Returns session info."""
    if not portal.get("is_password_protected"):
        return {}
    session_token = request.headers.get("X-Portal-Session")
    session = _validate_portal_session(str(portal["portal_id"]), session_token)
    if not session:
        raise HTTPException(status_code=401, detail="Password required")
    return session


def _client_ip(request: Request) -> str:
    """The visitor's address, not the proxy's.

    Requests reach the API through nginx and the Next proxy route, so
    request.client.host is a container address that is identical for every
    visitor. Rate limiting and the access log both need the real one.
    """
    # nginx sets X-Client-IP from the connection it accepted and overwrites
    # anything the caller sent, so it is authoritative. It is preferred over
    # X-Forwarded-For because Traefik sits in between and rewrites that one to
    # nginx's own address.
    client = request.headers.get("X-Client-IP")
    if client and client.strip():
        return client.strip()

    xff = request.headers.get("X-Forwarded-For")
    if xff:
        # Left-most entry is the original client; the rest are proxies.
        first = xff.split(",")[0].strip()
        if first:
            return first
    real = request.headers.get("X-Real-IP")
    if real:
        return real.strip()
    return request.client.host if request.client else "unknown"


def _rate_limit(
    portal_id: str | None,
    scope: str,
    key: str,
    limit: int,
    window_seconds: int,
    record: bool = True,
) -> None:
    """Allow `limit` attempts per `key` per window, or raise 429.

    Attempts are recorded before the count is checked, so a caller that keeps
    hammering stays locked out for the full window rather than getting one free
    attempt per expiry. Failures here never block the request — a throttle that
    errors closed would take the room down with it.
    """
    try:
        conn = _conn()
        try:
            cur = conn.cursor()
            if record:
                cur.execute(
                    "INSERT INTO portal_rate_limit (portal_id, scope, key) VALUES (%s, %s, %s)",
                    [portal_id, scope, key],
                )
            cur.execute(
                """SELECT count(*) AS n FROM portal_rate_limit
                   WHERE scope = %s AND key = %s
                     AND (portal_id = %s OR (%s IS NULL AND portal_id IS NULL))
                     AND created_at > NOW() - (%s || ' seconds')::interval""",
                [scope, key, portal_id, portal_id, window_seconds],
            )
            n = cur.fetchone()["n"]

            # Opportunistic cleanup; the table is otherwise unbounded.
            cur.execute(
                "DELETE FROM portal_rate_limit WHERE created_at < NOW() - INTERVAL '1 day'"
            )
            conn.commit()
        finally:
            conn.close()
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Rate limit check failed (allowing request): %s", exc)
        return

    if n > limit:
        logger.warning("Rate limited: scope=%s key=%s portal=%s count=%s", scope, key, portal_id, n)
        raise HTTPException(
            status_code=429,
            detail="Too many attempts. Please wait a few minutes and try again.",
        )


def _clear_rate_limit(portal_id: str | None, scope: str, key: str) -> None:
    """Drop recorded attempts, so a success doesn't count toward a lockout."""
    try:
        conn = _conn()
        try:
            cur = conn.cursor()
            cur.execute(
                """DELETE FROM portal_rate_limit
                   WHERE scope = %s AND key = %s
                     AND (portal_id = %s OR (%s IS NULL AND portal_id IS NULL))""",
                [scope, key, portal_id, portal_id],
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("Rate limit clear failed: %s", exc)


def _log_event(
    portal_id: str,
    event_type: str,
    viewer_id: str | None = None,
    viewer_name: str | None = None,
    file_id: str | None = None,
    file_name: str | None = None,
    section: str | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
):
    """Write to portal_access_log (best-effort, never raises)."""
    try:
        conn = _conn()
        try:
            cur = conn.cursor()
            cur.execute(
                """INSERT INTO portal_access_log
                     (portal_id, viewer_id, viewer_name, event_type,
                      file_id, file_name, section, ip_address, user_agent)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                [portal_id, viewer_id, viewer_name, event_type,
                 file_id, file_name, section, ip_address, user_agent],
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("Failed to log portal event: %s", exc)


def _content_disposition(filename: str) -> str:
    """Build a Content-Disposition that survives a non-ASCII filename.

    HTTP headers are latin-1, so a name containing an em-dash or an accent
    raises UnicodeEncodeError and the download 500s. RFC 6266 answers this with
    two forms: a stripped ASCII name every client understands, and a
    percent-encoded UTF-8 name that modern ones prefer.
    """
    ascii_name = (
        unicodedata.normalize("NFKD", filename)
        .encode("ascii", "ignore")
        .decode("ascii")
        .replace('"', "")
        .strip()
    ) or "download"
    quoted = urllib.parse.quote(filename, safe="")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"


def _get_drive_token(user_id: str) -> str:
    from app.routers.drive import _get_token
    return _get_token(user_id)


def _drive_file_meta(token: str, file_id: str) -> dict | None:
    """id/parents/driveId for a Drive item, or None if it isn't reachable."""
    r = httpx.get(
        f"{DRIVE_FILES_URL}/{file_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,parents,driveId", "supportsAllDrives": "true"},
        timeout=10,
    )
    if r.status_code != 200:
        return None
    return r.json()


def _portal_mirrors_file(portal_id: str, file_id: str) -> bool:
    """True if a docs tile in this room mirrors a marketing role holding this file.

    A mirrored asset lives in the marketing folder, not the room's, so folder
    containment alone would refuse it. This permits exactly the file the room is
    already choosing to publish — not the marketing folder at large.
    """
    from app.routers.marketing import resolve_role_file

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT payload FROM portal_room_blocks
               WHERE portal_id = %s AND block_type = 'docs' AND is_visible = true""",
            [portal_id],
        )
        roles = {
            role
            for r in cur.fetchall()
            for role in _tile_roles(r["payload"] or {})
        }
    finally:
        conn.close()

    for role in roles:
        resolved = resolve_role_file(role)
        if resolved and resolved["file_id"] == file_id:
            return True
    return False


def _assert_within_portal(portal: dict, file_id: str) -> None:
    """Refuse anything outside the portal's own Drive folder.

    A portal session only proves the holder may see *this* room. Without this
    check, any file id could be passed to the download and folder endpoints and
    would be fetched with the portal owner's Drive token — which reaches every
    file that account can open, including other clients' rooms.

    Containment is decided by walking parents upward to the portal root. Files
    in a shared drive also carry driveId, which short-circuits the walk when the
    room is rooted at the drive itself.
    """
    if _portal_mirrors_file(str(portal.get("portal_id")), file_id):
        return

    root = portal.get("effective_folder_id")
    if not root:
        raise HTTPException(status_code=403, detail="This portal has no document folder")
    if file_id == root:
        return

    token = _get_drive_token(portal["created_by"])

    seen: set[str] = set()
    frontier = [file_id]
    for _ in range(12):                      # depth guard; real trees are shallow
        nxt: list[str] = []
        for fid in frontier:
            if fid in seen:
                continue
            seen.add(fid)
            meta = _drive_file_meta(token, fid)
            if not meta:
                continue
            if meta.get("driveId") == root:  # room is the shared drive root
                return
            parents = meta.get("parents") or []
            if root in parents:
                return
            nxt.extend(parents)
        if not nxt:
            break
        frontier = nxt

    logger.warning("Blocked out-of-portal Drive access: portal=%s file=%s",
                   portal.get("portal_id"), file_id)
    raise HTTPException(status_code=403, detail="This file is not part of this portal")


def _list_folder_live(token: str, folder_id: str) -> list[dict]:
    """List files directly from Drive."""
    params = {
        "q":                         f"'{folder_id}' in parents and trashed = false",
        "fields":                    "files(id,name,mimeType,webViewLink,modifiedTime,size)",
        "orderBy":                   "folder,name_natural",
        "pageSize":                  100,
        "supportsAllDrives":         "true",
        "includeItemsFromAllDrives": "true",
    }
    r = httpx.get(
        DRIVE_FILES_URL,
        headers={"Authorization": f"Bearer {token}"},
        params=params,
        timeout=20,
    )
    if r.status_code != 200:
        logger.warning("Drive list failed: %s", r.text[:200])
        return []
    raw = r.json().get("files", [])
    return [
        {
            "file_id":       f["id"],
            "name":          f.get("name", "Untitled"),
            "mime_type":     f.get("mimeType"),
            "web_view_link": f.get("webViewLink"),
            "modified_time": f.get("modifiedTime"),
            "size_bytes":    int(f["size"]) if f.get("size") else None,
        }
        for f in raw
    ]


def _get_file_descriptions(cur, portal_id: str) -> dict:
    cur.execute(
        "SELECT file_id, description FROM portal_file_descriptions WHERE portal_id=%s",
        [portal_id],
    )
    return {row["file_id"]: row["description"] for row in cur.fetchall()}


def _get_portal_contacts(cur, portal_id: str) -> list[dict]:
    cur.execute(
        """SELECT id, name, title, email, phone
           FROM portal_contacts
           WHERE portal_id=%s
           ORDER BY sort_order ASC, created_at ASC""",
        [portal_id],
    )
    return [_row_dict(r) for r in cur.fetchall()]


def _get_portal_updates(cur, portal_id: str) -> list[dict]:
    cur.execute(
        """SELECT pu.id, pu.title, pu.body, pu.created_at, u.name AS created_by_name
           FROM portal_updates pu
           LEFT JOIN users u ON u.user_id = pu.created_by
           WHERE pu.portal_id = %s
           ORDER BY pu.created_at DESC""",
        [portal_id],
    )
    return [_row_dict(r) for r in cur.fetchall()]


# ── Public endpoints ──────────────────────────────────────────────────────────

@router.get("/portal/{token}")
def get_portal(token: str, request: Request):
    portal = _validate_token(token)
    portal_id = str(portal["portal_id"])

    # If password-protected, check for valid session
    if portal.get("is_password_protected"):
        session_token = request.headers.get("X-Portal-Session")
        session = _validate_portal_session(portal_id, session_token)
        if not session:
            return {"password_required": True}

    has_own_folder = bool(portal.get("portal_drive_folder_id"))
    effective_folder_id = portal.get("effective_folder_id")

    if not effective_folder_id:
        files = []
    elif has_own_folder:
        drive_token = _get_drive_token(portal["created_by"])
        files = _list_folder_live(drive_token, portal["portal_drive_folder_id"])
    else:
        conn = _conn()
        try:
            cur = conn.cursor()
            cur.execute(
                """SELECT file_id, name, mime_type, web_view_link,
                          modified_time, size_bytes, synced_at
                   FROM project_drive_files
                   WHERE project_id = %s
                   ORDER BY (mime_type = 'application/vnd.google-apps.folder') DESC, name ASC""",
                [portal["project_id"]],
            )
            files = [_row_dict(r) for r in cur.fetchall()]
        finally:
            conn.close()

    conn = _conn()
    try:
        cur = conn.cursor()
        descs    = _get_file_descriptions(cur, portal_id)
        contacts = _get_portal_contacts(cur, portal_id)
        updates  = _get_portal_updates(cur, portal_id)
    finally:
        conn.close()

    for f in files:
        f["description"] = descs.get(f.get("file_id"))

    return {
        "project_name":      portal["display_name"],
        "drive_folder_name": portal["effective_folder_name"],
        "label":             portal["label"],
        "description":       portal.get("description"),
        "contacts":          contacts,
        "updates":           updates,
        "files":             files,
    }


class PortalAuthBody(BaseModel):
    password: str


@router.post("/portal/{token}/auth")
def portal_auth(token: str, body: PortalAuthBody, request: Request):
    """Authenticate with a portal password. Returns a session token."""
    portal = _validate_token(token)
    portal_id = str(portal["portal_id"])

    if not portal.get("is_password_protected"):
        raise HTTPException(status_code=400, detail="This portal is not password-protected")

    _rate_limit(portal_id, "login", _client_ip(request), limit=20, window_seconds=900)

    ip = _client_ip(request)
    ua = request.headers.get("User-Agent")

    # Check viewer-specific passwords first
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT viewer_id, name, email, firm, password_hash
               FROM portal_viewers
               WHERE portal_id = %s AND is_active = true""",
            [portal_id],
        )
        viewers = cur.fetchall()
    finally:
        conn.close()

    matched_viewer = None
    for v in viewers:
        if _check_password(body.password, v["password_hash"]):
            matched_viewer = v
            break

    # Fall back to portal-level password
    if not matched_viewer and portal.get("password_hash"):
        if not _check_password(body.password, portal["password_hash"]):
            raise HTTPException(status_code=401, detail="Incorrect password")
    elif not matched_viewer:
        raise HTTPException(status_code=401, detail="Incorrect password")

    viewer_id   = str(matched_viewer["viewer_id"]) if matched_viewer else None
    viewer_name = matched_viewer["name"] if matched_viewer else None

    # Create session
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO portal_sessions (portal_id, viewer_id)
               VALUES (%s, %s)
               RETURNING session_token""",
            [portal_id, viewer_id],
        )
        session_token = str(cur.fetchone()["session_token"])
        conn.commit()
    finally:
        conn.close()

    _log_event(
        portal_id=portal_id,
        event_type="login",
        viewer_id=viewer_id,
        viewer_name=viewer_name,
        ip_address=ip,
        user_agent=ua,
    )

    return {
        "session_token": session_token,
        "viewer_name":   viewer_name,
    }


class TrackBody(BaseModel):
    event_type: str                 # page_visit | file_view | file_download
    section: Optional[str] = None  # overview | updates | documents
    file_id: Optional[str] = None
    file_name: Optional[str] = None


@router.post("/portal/{token}/track")
def portal_track(token: str, body: TrackBody, request: Request):
    """Log viewer activity. Silently succeeds even if portal is not password-protected."""
    portal = _validate_token(token)
    portal_id = str(portal["portal_id"])

    session = None
    if portal.get("is_password_protected"):
        session_token = request.headers.get("X-Portal-Session")
        session = _validate_portal_session(portal_id, session_token)

    viewer_id   = session.get("viewer_id") if session else None
    viewer_name = session.get("viewer_name") if session else None
    ip = _client_ip(request)
    ua = request.headers.get("User-Agent")

    # An unrecognised type is downgraded to page_visit rather than rejected, so
    # a new event has to be listed here or it is silently lost.
    allowed = {"page_visit", "file_view", "file_download", "confidentiality_ack"}
    event_type = body.event_type if body.event_type in allowed else "page_visit"

    _log_event(
        portal_id=portal_id,
        event_type=event_type,
        viewer_id=viewer_id,
        viewer_name=viewer_name,
        file_id=body.file_id,
        file_name=body.file_name,
        section=body.section,
        ip_address=ip,
        user_agent=ua,
    )

    # Notify assigned employee on first page_visit within a 4-hour window
    if event_type == "page_visit" and portal.get("assigned_to"):
        try:
            from app.routers.notifications import create_notification
            conn = _conn()
            try:
                cur = conn.cursor()
                cur.execute(
                    """SELECT 1 FROM task_notifications
                       WHERE notification_type = 'portal_view'
                         AND entity_id = %s::uuid
                         AND created_at > NOW() - INTERVAL '4 hours'
                       LIMIT 1""",
                    [portal_id],
                )
                if not cur.fetchone():
                    display = portal.get("display_name", "Portal")
                    viewer_label = viewer_name or "Someone"
                    create_notification(
                        conn,
                        recipient_id=str(portal["assigned_to"]),
                        sender_id=None,
                        notification_type="portal_view",
                        entity_type="portal",
                        entity_id=portal_id,
                        title=f"{viewer_label} viewed the {display} portal",
                        message=None,
                    )
                    conn.commit()
            finally:
                conn.close()
        except Exception as e:
            logger.warning("Portal view notification failed: %s", e)

    return {"ok": True}


@router.get("/portal/{token}/files/{file_id}/download")
def portal_download(token: str, file_id: str, request: Request):
    portal = _validate_token(token)
    _require_portal_session(portal, request)
    _assert_within_portal(portal, file_id)
    drive_token = _get_drive_token(portal["created_by"])
    auth_headers = {"Authorization": f"Bearer {drive_token}"}

    # Drive is the authority on what this file is now. The cached row in
    # project_drive_files is only a sync snapshot, and serving its name and type
    # meant a renamed file downloaded under its old title and a replaced one
    # kept downloading at all. A link handed out earlier must stop working the
    # moment the room stops listing the document.
    stored_name = _room_pinned_name(str(portal["portal_id"]), file_id)

    if stored_name is not None:
        verdict, meta = _drive_item_verdict(drive_token, file_id, stored_name)
    else:
        # Not pinned in a room tile — a plain document portal, or a file served
        # through a mirrored role. There is no curated name to match against, so
        # only presence in Drive decides.
        meta = _drive_meta_live(drive_token, file_id)
        if meta is _UNKNOWN:
            verdict = "unknown"
        elif not meta or meta.get("trashed"):
            verdict, meta = "drop", None
        else:
            verdict = "ok"

    if verdict == "unknown":
        raise HTTPException(status_code=503, detail="Drive is unavailable, try again shortly")
    if verdict == "drop" or not meta:
        raise HTTPException(
            status_code=404,
            detail="This document is no longer available in the data room",
        )

    mime = meta.get("mimeType", "")
    name = meta.get("name", "file")

    # Log the download
    session_token = request.headers.get("X-Portal-Session")
    session = _validate_portal_session(str(portal["portal_id"]), session_token) if portal.get("is_password_protected") else None
    _log_event(
        portal_id=str(portal["portal_id"]),
        event_type="file_download",
        viewer_id=session.get("viewer_id") if session else None,
        viewer_name=session.get("viewer_name") if session else None,
        file_id=file_id,
        file_name=name,
        ip_address=_client_ip(request),
        user_agent=request.headers.get("User-Agent"),
    )

    if mime in EXPORTABLE_TO_PDF:
        r = httpx.get(
            DRIVE_EXPORT_URL.format(id=file_id),
            headers=auth_headers,
            params={"mimeType": "application/pdf", "supportsAllDrives": "true"},
            timeout=60,
        )
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to export file from Drive")
        return Response(
            content=r.content,
            media_type="application/pdf",
            headers={"Content-Disposition": _content_disposition(f"{name}.pdf")},
        )
    else:
        # Stream rather than buffer. Reading the whole file before replying meant
        # a 30 MB deck spent eight seconds producing no bytes at all, while the
        # transfer itself took a fraction of a second.
        #
        # A Range header is passed through so a PDF viewer can fetch the pages it
        # needs instead of the whole document, which is what lets a large deck
        # open immediately rather than after the last byte arrives.
        upstream_headers = dict(auth_headers)
        range_header = request.headers.get("Range")
        if range_header:
            upstream_headers["Range"] = range_header

        client = httpx.Client(timeout=httpx.Timeout(300.0))
        req = client.build_request(
            "GET",
            f"{DRIVE_FILES_URL}/{file_id}",
            headers=upstream_headers,
            params={"alt": "media", "supportsAllDrives": "true"},
        )
        resp = client.send(req, stream=True)
        if resp.status_code not in (200, 206):
            resp.close()
            client.close()
            raise HTTPException(status_code=502, detail="Failed to download file from Drive")

        def body():
            try:
                for chunk in resp.iter_bytes(65536):
                    yield chunk
            finally:
                resp.close()
                client.close()

        out_headers = {
            "Content-Disposition": _content_disposition(name),
            "Accept-Ranges": "bytes",
        }
        for passthrough in ("Content-Length", "Content-Range"):
            if passthrough in resp.headers:
                out_headers[passthrough] = resp.headers[passthrough]

        content_type = mime if mime and "/" in mime else "application/octet-stream"
        return StreamingResponse(
            body(),
            status_code=resp.status_code,
            media_type=content_type,
            headers=out_headers,
        )


@router.get("/portal/{token}/folders/{folder_id}")
def portal_list_folder(token: str, folder_id: str, request: Request):
    """List contents of a subfolder within the portal."""
    portal = _validate_token(token)
    _require_portal_session(portal, request)
    _assert_within_portal(portal, folder_id)
    portal_id = str(portal["portal_id"])
    drive_token = _get_drive_token(portal["created_by"])
    files = _list_folder_live(drive_token, folder_id)
    conn = _conn()
    try:
        cur = conn.cursor()
        descs = _get_file_descriptions(cur, portal_id)
    finally:
        conn.close()
    for f in files:
        f["description"] = descs.get(f["file_id"])
    return {"files": files}


# ── Authenticated endpoints ───────────────────────────────────────────────────

@router.post("/projects/{project_id}/portal")
def create_portal(project_id: str, request: Request):
    uid = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT project_id FROM projects WHERE project_id=%s", [project_id])
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Project not found")
        cur.execute(
            "UPDATE project_portals SET is_active=false WHERE project_id=%s",
            [project_id],
        )
        cur.execute(
            # Protected by default. A portal link is a bearer token that gets
            # forwarded, so an unprotected room is readable by anyone it reaches.
            """INSERT INTO project_portals (project_id, created_by, is_password_protected)
               VALUES (%s, %s, true)
               RETURNING portal_id, token""",
            [project_id, uid],
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()

    return {"portal_id": str(row["portal_id"]), "token": row["token"]}


@router.get("/projects/{project_id}/portal")
def get_project_portal(project_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT portal_id, token, slug, is_active, created_at, expires_at,
                      portal_drive_folder_id, portal_drive_folder_name,
                      is_password_protected
               FROM project_portals
               WHERE project_id=%s AND is_active=true
               ORDER BY created_at DESC LIMIT 1""",
            [project_id],
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        return {"portal": None}
    return {"portal": _row_dict(row)}


class PortalFolderBody(BaseModel):
    folder_url: str


@router.patch("/projects/{project_id}/portal/folder")
def set_portal_folder(project_id: str, body: PortalFolderBody, request: Request):
    uid = _require_user(request)
    drive_token = _get_drive_token(uid)

    from app.routers.drive import _parse_folder_id, _get_folder_name
    folder_id   = _parse_folder_id(body.folder_url)
    folder_name = _get_folder_name(drive_token, folder_id)

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """UPDATE project_portals
               SET portal_drive_folder_id=%s, portal_drive_folder_name=%s
               WHERE project_id=%s AND is_active=true""",
            [folder_id, folder_name, project_id],
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="No active portal for this project")
        conn.commit()
    finally:
        conn.close()

    return {"folder_id": folder_id, "folder_name": folder_name}


class PortalContentBody(BaseModel):
    description: Optional[str] = None
    is_password_protected: Optional[bool] = None
    password: Optional[str] = None  # plain text; will be hashed


@router.patch("/projects/{project_id}/portal/content")
def set_portal_content(project_id: str, body: PortalContentBody, request: Request):
    _require_user(request)

    sets  = []
    vals  = []

    if body.description is not None:
        sets.append("description=%s"); vals.append(body.description)

    if body.is_password_protected is not None:
        sets.append("is_password_protected=%s"); vals.append(body.is_password_protected)

    if body.password is not None:
        if body.password.strip():
            sets.append("password_hash=%s"); vals.append(_hash_password(body.password))
        else:
            # Empty string clears the portal-level password
            sets.append("password_hash=NULL")

    if not sets:
        raise HTTPException(status_code=400, detail="Nothing to update")

    vals.append(project_id)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            f"UPDATE project_portals SET {', '.join(sets)} WHERE project_id=%s AND is_active=true",
            vals,
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="No active portal for this project")
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.get("/projects/{project_id}/portal/content")
def get_portal_content(project_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT portal_id, description, is_password_protected,
                      (password_hash IS NOT NULL) AS has_portal_password
               FROM project_portals WHERE project_id=%s AND is_active=true""",
            [project_id],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="No active portal for this project")
        portal_id   = str(row["portal_id"])
        description = row["description"]
        is_pw       = row["is_password_protected"]
        has_pw      = row["has_portal_password"]
        contacts    = _get_portal_contacts(cur, portal_id)
        updates     = _get_portal_updates(cur, portal_id)
    finally:
        conn.close()
    return {
        "description": description,
        "is_password_protected": is_pw,
        "has_portal_password": has_pw,
        "contacts": contacts,
        "updates": updates,
    }


class PortalSlugBody(BaseModel):
    slug: Optional[str] = None  # None or empty string clears the slug


import re as _re

_SLUG_RE = _re.compile(r'^[a-z0-9][a-z0-9\-]{1,62}[a-z0-9]$')


@router.patch("/projects/{project_id}/portal/slug")
def set_portal_slug(project_id: str, body: PortalSlugBody, request: Request):
    _require_user(request)
    slug = body.slug.strip().lower() if body.slug else None
    if slug == "":
        slug = None
    if slug and not _SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Slug must be 3–64 lowercase letters, numbers, or hyphens, starting and ending with a letter or number")
    conn = _conn()
    try:
        cur = conn.cursor()
        try:
            cur.execute(
                "UPDATE project_portals SET slug=%s WHERE project_id=%s AND is_active=true",
                [slug, project_id],
            )
        except Exception as e:
            if "unique" in str(e).lower():
                raise HTTPException(status_code=409, detail="That slug is already in use")
            raise
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="No active portal for this project")
        conn.commit()
    finally:
        conn.close()
    return {"slug": slug}


@router.patch("/portals/room/{portal_id}/slug")
def set_room_slug(portal_id: str, body: PortalSlugBody, request: Request):
    _require_user(request)
    slug = body.slug.strip().lower() if body.slug else None
    if slug == "":
        slug = None
    if slug and not _SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Slug must be 3–64 lowercase letters, numbers, or hyphens, starting and ending with a letter or number")
    conn = _conn()
    try:
        cur = conn.cursor()
        try:
            cur.execute(
                "UPDATE project_portals SET slug=%s WHERE portal_id=%s",
                [slug, portal_id],
            )
        except Exception as e:
            if "unique" in str(e).lower():
                raise HTTPException(status_code=409, detail="That slug is already in use")
            raise
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Portal not found")
        conn.commit()
    finally:
        conn.close()
    return {"slug": slug}


class PortalAssignBody(BaseModel):
    assigned_to: Optional[str] = None  # user_id or None to unassign


class PortalCategoryBody(BaseModel):
    category: str  # 'client' | 'investor' | 'partner'


@router.patch("/projects/{project_id}/portal/assign")
def assign_portal(project_id: str, body: PortalAssignBody, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE project_portals SET assigned_to=%s WHERE project_id=%s AND is_active=true",
            [body.assigned_to, project_id],
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="No active portal for this project")
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.patch("/projects/{project_id}/portal/category")
def set_portal_category(project_id: str, body: PortalCategoryBody, request: Request):
    _require_user(request)
    if body.category not in ("client", "investor", "partner"):
        raise HTTPException(status_code=400, detail="category must be client, investor, or partner")
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE project_portals SET category=%s WHERE project_id=%s AND is_active=true",
            [body.category, project_id],
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="No active portal for this project")
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.patch("/portals/room/{portal_id}/assign")
def assign_room_portal(portal_id: str, body: PortalAssignBody, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE project_portals SET assigned_to=%s WHERE portal_id=%s",
            [body.assigned_to, portal_id],
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Portal not found")
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.patch("/portals/room/{portal_id}/category")
def set_room_category(portal_id: str, body: PortalCategoryBody, request: Request):
    _require_user(request)
    if body.category not in ("client", "investor", "partner"):
        raise HTTPException(status_code=400, detail="category must be client, investor, or partner")
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE project_portals SET category=%s WHERE portal_id=%s",
            [body.category, portal_id],
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Portal not found")
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


class ContactBody(BaseModel):
    name: str
    title: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None


class ContactPatchBody(BaseModel):
    name: Optional[str] = None
    title: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None


@router.post("/projects/{project_id}/portal/contacts")
def add_portal_contact(project_id: str, body: ContactBody, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        portal_id = _get_active_portal_id(cur, project_id)
        cur.execute(
            """INSERT INTO portal_contacts (portal_id, name, title, email, phone)
               VALUES (%s, %s, %s, %s, %s)
               RETURNING id, name, title, email, phone""",
            [portal_id, body.name, body.title, body.email, body.phone],
        )
        row = _row_dict(cur.fetchone())
        conn.commit()
    finally:
        conn.close()
    return row


@router.patch("/projects/{project_id}/portal/contacts/{cid}")
def edit_portal_contact(project_id: str, cid: int, body: ContactPatchBody, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        portal_id = _get_active_portal_id(cur, project_id)
        updates = []
        values  = []
        if body.name is not None:
            updates.append("name=%s"); values.append(body.name)
        if body.title is not None:
            updates.append("title=%s"); values.append(body.title)
        if body.email is not None:
            updates.append("email=%s"); values.append(body.email)
        if body.phone is not None:
            updates.append("phone=%s"); values.append(body.phone)
        if not updates:
            raise HTTPException(status_code=400, detail="Nothing to update")
        values.extend([cid, portal_id])
        cur.execute(
            f"UPDATE portal_contacts SET {', '.join(updates)} WHERE id=%s AND portal_id=%s RETURNING id, name, title, email, phone",
            values,
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Contact not found")
        result = _row_dict(row)
        conn.commit()
    finally:
        conn.close()
    return result


@router.delete("/projects/{project_id}/portal/contacts/{cid}")
def delete_portal_contact(project_id: str, cid: int, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        portal_id = _get_active_portal_id(cur, project_id)
        cur.execute(
            "DELETE FROM portal_contacts WHERE id=%s AND portal_id=%s",
            [cid, portal_id],
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


class UpdateBody(BaseModel):
    title: str
    body: Optional[str] = None


@router.post("/projects/{project_id}/portal/updates")
def post_portal_update(project_id: str, body: UpdateBody, request: Request):
    uid = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        portal_id = _get_active_portal_id(cur, project_id)
        cur.execute(
            """INSERT INTO portal_updates (portal_id, title, body, created_by)
               VALUES (%s, %s, %s, %s)
               RETURNING id, title, body, created_at""",
            [portal_id, body.title, body.body, uid],
        )
        row = _row_dict(cur.fetchone())
        conn.commit()
    finally:
        conn.close()
    return row


@router.delete("/projects/{project_id}/portal/updates/{uid}")
def delete_portal_update(project_id: str, uid: int, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        portal_id = _get_active_portal_id(cur, project_id)
        cur.execute(
            "DELETE FROM portal_updates WHERE id=%s AND portal_id=%s",
            [uid, portal_id],
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.get("/portals")
def list_all_portals(request: Request):
    """List all portals for the management view (authenticated)."""
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT pp.portal_id, pp.token, pp.slug, pp.is_active, pp.created_at, pp.expires_at,
                      pp.portal_drive_folder_id, pp.portal_drive_folder_name,
                      pp.is_password_protected,
                      pp.project_id,
                      pp.assigned_to AS assigned_to_id,
                      pp.category,
                      COALESCE(p.name, pp.name) AS project_name,
                      p.drive_folder_name AS project_drive_folder_name,
                      u.name  AS created_by_name,
                      ua.name AS assigned_to_name,
                      (pp.project_id IS NULL) AS is_standalone,
                      (SELECT COUNT(*) FROM portal_viewers pv
                       WHERE pv.portal_id = pp.portal_id AND pv.is_active = true) AS viewer_count,
                      cl.contact_name  AS client_contact,
                      cl.organization   AS client_org,
                      la.created_at  AS last_access_at,
                      la.viewer_name AS last_access_by
               FROM project_portals pp
               LEFT JOIN LATERAL (
                       SELECT c.name AS contact_name, c.organization
                       FROM project_contacts pc
                       JOIN contacts c ON c.contact_id = pc.contact_id
                       WHERE pc.project_id = pp.project_id AND pc.is_primary = true
                       LIMIT 1) cl ON true
               LEFT JOIN LATERAL (
                       SELECT pal.created_at, pal.viewer_name
                       FROM portal_access_log pal
                       WHERE pal.portal_id = pp.portal_id
                       ORDER BY pal.created_at DESC
                       LIMIT 1) la ON true
               LEFT JOIN projects p   ON p.project_id  = pp.project_id
               LEFT JOIN users u      ON u.user_id      = pp.created_by
               LEFT JOIN users ua     ON ua.user_id     = pp.assigned_to
               ORDER BY pp.created_at DESC""",
        )
        rows = [_row_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()
    return rows


# ── Standalone (project-free) portal endpoints ───────────────────────────────

class StandalonePortalBody(BaseModel):
    name: str


@router.post("/portals/standalone")
def create_standalone_portal(body: StandalonePortalBody, request: Request):
    """Create a data room portal not linked to any project."""
    uid = _require_user(request)
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="Name is required")
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO project_portals (project_id, created_by, name, category,
                                            is_password_protected)
               VALUES (NULL, %s, %s, 'investor', true)
               RETURNING portal_id, token""",
            [uid, body.name.strip()],
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    return {"portal_id": str(row["portal_id"]), "token": row["token"]}


@router.get("/portals/room/{portal_id}")
def get_standalone_portal(portal_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT portal_id, token, slug, is_active, created_at, expires_at,
                      portal_drive_folder_id, portal_drive_folder_name,
                      is_password_protected, name,
                      COALESCE(messaging_enabled, false) AS messaging_enabled,
                      messaging_channel_id::text
               FROM project_portals
               WHERE portal_id = %s""",
            [portal_id],
        )
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Portal not found")
    return _row_dict(row)


class PortalMessagingBody(BaseModel):
    messaging_enabled: bool


@router.patch("/portals/room/{portal_id}/messaging")
def set_portal_messaging(portal_id: str, body: PortalMessagingBody, request: Request):
    """Enable or disable messaging for a portal."""
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE project_portals SET messaging_enabled=%s WHERE portal_id=%s",
            [body.messaging_enabled, portal_id],
        )
        conn.commit()
    finally:
        conn.close()
    return {"messaging_enabled": body.messaging_enabled}


class RoomNameBody(BaseModel):
    name: str


@router.patch("/portals/room/{portal_id}/name")
def rename_standalone_portal(portal_id: str, body: RoomNameBody, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE project_portals SET name=%s WHERE portal_id=%s",
            [body.name.strip(), portal_id],
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.patch("/portals/room/{portal_id}/folder")
def set_room_folder(portal_id: str, body: PortalFolderBody, request: Request):
    uid = _require_user(request)
    drive_token = _get_drive_token(uid)
    from app.routers.drive import _parse_folder_id, _get_folder_name
    folder_id   = _parse_folder_id(body.folder_url)
    folder_name = _get_folder_name(drive_token, folder_id)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE project_portals SET portal_drive_folder_id=%s, portal_drive_folder_name=%s WHERE portal_id=%s",
            [folder_id, folder_name, portal_id],
        )
        conn.commit()
    finally:
        conn.close()
    return {"folder_id": folder_id, "folder_name": folder_name}


@router.get("/portals/room/{portal_id}/content")
def get_room_content(portal_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT portal_id, description, is_password_protected,
                      (password_hash IS NOT NULL) AS has_portal_password
               FROM project_portals WHERE portal_id=%s""",
            [portal_id],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Portal not found")
        contacts = _get_portal_contacts(cur, portal_id)
        updates  = _get_portal_updates(cur, portal_id)
    finally:
        conn.close()
    return {
        "description":          row["description"],
        "is_password_protected": row["is_password_protected"],
        "has_portal_password":  row["has_portal_password"],
        "contacts":             contacts,
        "updates":              updates,
    }


@router.patch("/portals/room/{portal_id}/content")
def set_room_content(portal_id: str, body: PortalContentBody, request: Request):
    _require_user(request)
    sets, vals = [], []
    if body.description is not None:
        sets.append("description=%s"); vals.append(body.description)
    if body.is_password_protected is not None:
        sets.append("is_password_protected=%s"); vals.append(body.is_password_protected)
    if body.password is not None:
        if body.password.strip():
            sets.append("password_hash=%s"); vals.append(_hash_password(body.password))
        else:
            sets.append("password_hash=NULL")
    if not sets:
        raise HTTPException(status_code=400, detail="Nothing to update")
    vals.append(portal_id)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(f"UPDATE project_portals SET {', '.join(sets)} WHERE portal_id=%s", vals)
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.get("/portals/room/{portal_id}/files")
def list_room_files(portal_id: str, request: Request, folder_id: str | None = None):
    """List files in the portal's Drive folder with their descriptions.

    Pass folder_id to list a subfolder instead of the room's root, so a picker
    can drill into nested sections.
    """
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT portal_drive_folder_id, created_by FROM project_portals WHERE portal_id=%s",
            [portal_id],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Portal not found")
        descs = _get_file_descriptions(cur, portal_id)
    finally:
        conn.close()
    root = row["portal_drive_folder_id"]
    target = folder_id or root
    if not target:
        return {"files": []}
    if folder_id and folder_id != root:
        _assert_within_portal(
            {"effective_folder_id": root, "created_by": row["created_by"], "portal_id": portal_id},
            folder_id,
        )
    drive_token = _get_drive_token(row["created_by"])
    files = _list_folder_live(drive_token, target)
    for f in files:
        f["description"] = descs.get(f["file_id"])
    return {"files": files}


class FileDescBody(BaseModel):
    description: str


@router.put("/portals/room/{portal_id}/files/{file_id}/description")
def set_file_description(portal_id: str, file_id: str, body: FileDescBody, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        if body.description.strip():
            cur.execute(
                """INSERT INTO portal_file_descriptions (portal_id, file_id, description, updated_at)
                   VALUES (%s, %s, %s, NOW())
                   ON CONFLICT (portal_id, file_id)
                   DO UPDATE SET description=EXCLUDED.description, updated_at=NOW()""",
                [portal_id, file_id, body.description.strip()],
            )
        else:
            cur.execute(
                "DELETE FROM portal_file_descriptions WHERE portal_id=%s AND file_id=%s",
                [portal_id, file_id],
            )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.post("/portals/room/{portal_id}/contacts")
def add_room_contact(portal_id: str, body: ContactBody, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO portal_contacts (portal_id, name, title, email, phone) VALUES (%s,%s,%s,%s,%s) RETURNING id, name, title, email, phone",
            [portal_id, body.name, body.title, body.email, body.phone],
        )
        row = _row_dict(cur.fetchone())
        conn.commit()
    finally:
        conn.close()
    return row


@router.patch("/portals/room/{portal_id}/contacts/{cid}")
def edit_room_contact(portal_id: str, cid: int, body: ContactPatchBody, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        updates, values = [], []
        if body.name  is not None: updates.append("name=%s");  values.append(body.name)
        if body.title is not None: updates.append("title=%s"); values.append(body.title)
        if body.email is not None: updates.append("email=%s"); values.append(body.email)
        if body.phone is not None: updates.append("phone=%s"); values.append(body.phone)
        if not updates:
            raise HTTPException(status_code=400, detail="Nothing to update")
        values.extend([cid, portal_id])
        cur.execute(
            f"UPDATE portal_contacts SET {', '.join(updates)} WHERE id=%s AND portal_id=%s RETURNING id, name, title, email, phone",
            values,
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Contact not found")
        result = _row_dict(row)
        conn.commit()
    finally:
        conn.close()
    return result


@router.delete("/portals/room/{portal_id}/contacts/{cid}")
def delete_room_contact(portal_id: str, cid: int, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM portal_contacts WHERE id=%s AND portal_id=%s", [cid, portal_id])
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.post("/portals/room/{portal_id}/updates")
def post_room_update(portal_id: str, body: UpdateBody, request: Request):
    uid = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO portal_updates (portal_id, title, body, created_by) VALUES (%s,%s,%s,%s) RETURNING id, title, body, created_at",
            [portal_id, body.title, body.body, uid],
        )
        row = _row_dict(cur.fetchone())
        conn.commit()
    finally:
        conn.close()
    return row


@router.delete("/portals/room/{portal_id}/updates/{uid}")
def delete_room_update(portal_id: str, uid: int, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM portal_updates WHERE id=%s AND portal_id=%s", [uid, portal_id])
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


class ViewerBody(BaseModel):
    name: str
    email: Optional[str] = None
    firm: Optional[str] = None
    password: str


class ViewerPatchBody(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    firm: Optional[str] = None
    password: Optional[str] = None
    is_active: Optional[bool] = None


@router.get("/portals/room/{portal_id}/viewers")
def list_room_viewers(portal_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT viewer_id, name, email, firm, is_active, created_at FROM portal_viewers WHERE portal_id=%s ORDER BY created_at ASC",
            [portal_id],
        )
        rows = [_row_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()
    return rows


@router.post("/portals/room/{portal_id}/viewers")
def add_room_viewer(portal_id: str, body: ViewerBody, request: Request):
    _require_user(request)
    if not body.password.strip():
        raise HTTPException(status_code=400, detail="Password is required")
    pw_hash = _hash_password(body.password)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO portal_viewers (portal_id, name, email, firm, password_hash) VALUES (%s,%s,%s,%s,%s) RETURNING viewer_id, name, email, firm, is_active, created_at",
            [portal_id, body.name.strip(), body.email, body.firm, pw_hash],
        )
        row = _row_dict(cur.fetchone())
        conn.commit()
    finally:
        conn.close()
    return row


@router.patch("/portals/room/{portal_id}/viewers/{vid}")
def update_room_viewer(portal_id: str, vid: str, body: ViewerPatchBody, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        sets, vals = [], []
        if body.name      is not None: sets.append("name=%s");      vals.append(body.name.strip())
        if body.email     is not None: sets.append("email=%s");     vals.append(body.email or None)
        if body.firm      is not None: sets.append("firm=%s");      vals.append(body.firm or None)
        if body.is_active is not None: sets.append("is_active=%s"); vals.append(body.is_active)
        if body.password  is not None:
            if not body.password.strip():
                raise HTTPException(status_code=400, detail="Password cannot be empty")
            sets.append("password_hash=%s"); vals.append(_hash_password(body.password))
        if not sets:
            raise HTTPException(status_code=400, detail="Nothing to update")
        vals.extend([vid, portal_id])
        cur.execute(
            f"UPDATE portal_viewers SET {', '.join(sets)} WHERE viewer_id=%s AND portal_id=%s RETURNING viewer_id, name, email, firm, is_active, created_at",
            vals,
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Viewer not found")
        result = _row_dict(row)
        conn.commit()
    finally:
        conn.close()
    return result


@router.delete("/portals/room/{portal_id}/viewers/{vid}")
def delete_room_viewer(portal_id: str, vid: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM portal_viewers WHERE viewer_id=%s AND portal_id=%s", [vid, portal_id])
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.get("/portals/room/{portal_id}/activity")
def get_room_activity(portal_id: str, request: Request, limit: int = 200):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT log_id, viewer_id, viewer_name, event_type,
                      file_id, file_name, section, ip_address, created_at
               FROM portal_access_log
               WHERE portal_id=%s
               ORDER BY created_at DESC LIMIT %s""",
            [portal_id, min(limit, 500)],
        )
        rows = [_row_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()
    return rows


@router.delete("/portals/room/{portal_id}")
def delete_standalone_portal(portal_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE project_portals SET is_active=false WHERE portal_id=%s",
            [portal_id],
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.delete("/projects/{project_id}/portal")
def revoke_portal(project_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE project_portals SET is_active=false WHERE project_id=%s AND is_active=true",
            [project_id],
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


# ── Viewer (investor) management ──────────────────────────────────────────────

@router.get("/projects/{project_id}/portal/viewers")
def list_portal_viewers(project_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        portal_id = _get_active_portal_id(cur, project_id)
        cur.execute(
            """SELECT viewer_id, name, email, firm, is_active, created_at
               FROM portal_viewers
               WHERE portal_id = %s
               ORDER BY created_at ASC""",
            [portal_id],
        )
        rows = [_row_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()
    return rows


@router.post("/projects/{project_id}/portal/viewers")
def add_portal_viewer(project_id: str, body: ViewerBody, request: Request):
    _require_user(request)
    if not body.password.strip():
        raise HTTPException(status_code=400, detail="Password is required")
    pw_hash = _hash_password(body.password)
    conn = _conn()
    try:
        cur = conn.cursor()
        portal_id = _get_active_portal_id(cur, project_id)
        cur.execute(
            """INSERT INTO portal_viewers (portal_id, name, email, firm, password_hash)
               VALUES (%s, %s, %s, %s, %s)
               RETURNING viewer_id, name, email, firm, is_active, created_at""",
            [portal_id, body.name.strip(), body.email, body.firm, pw_hash],
        )
        row = _row_dict(cur.fetchone())
        conn.commit()
    finally:
        conn.close()
    return row


@router.patch("/projects/{project_id}/portal/viewers/{vid}")
def update_portal_viewer(project_id: str, vid: str, body: ViewerPatchBody, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        portal_id = _get_active_portal_id(cur, project_id)
        sets  = []
        vals  = []
        if body.name is not None:
            sets.append("name=%s"); vals.append(body.name.strip())
        if body.email is not None:
            sets.append("email=%s"); vals.append(body.email or None)
        if body.firm is not None:
            sets.append("firm=%s"); vals.append(body.firm or None)
        if body.is_active is not None:
            sets.append("is_active=%s"); vals.append(body.is_active)
        if body.password is not None:
            if not body.password.strip():
                raise HTTPException(status_code=400, detail="Password cannot be empty")
            sets.append("password_hash=%s"); vals.append(_hash_password(body.password))
        if not sets:
            raise HTTPException(status_code=400, detail="Nothing to update")
        vals.extend([vid, portal_id])
        cur.execute(
            f"""UPDATE portal_viewers SET {', '.join(sets)}
                WHERE viewer_id=%s AND portal_id=%s
                RETURNING viewer_id, name, email, firm, is_active, created_at""",
            vals,
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Viewer not found")
        result = _row_dict(row)
        conn.commit()
    finally:
        conn.close()
    return result


@router.delete("/projects/{project_id}/portal/viewers/{vid}")
def delete_portal_viewer(project_id: str, vid: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        portal_id = _get_active_portal_id(cur, project_id)
        cur.execute(
            "DELETE FROM portal_viewers WHERE viewer_id=%s AND portal_id=%s",
            [vid, portal_id],
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


# ── Activity log ──────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/portal/activity")
def get_portal_activity(project_id: str, request: Request, limit: int = 200):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        portal_id = _get_active_portal_id(cur, project_id)
        cur.execute(
            """SELECT log_id, viewer_id, viewer_name, event_type,
                      file_id, file_name, section, ip_address, created_at
               FROM portal_access_log
               WHERE portal_id = %s
               ORDER BY created_at DESC
               LIMIT %s""",
            [portal_id, min(limit, 500)],
        )
        rows = [_row_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()
    return rows


# ── Investor room: curated content blocks ────────────────────────────────────
#
# The visual investor room at /investors renders curated tiles rather than a
# Drive file listing. Content lives in portal_room_blocks / portal_room_sections
# and is edited from the platform — nothing here is derived from live data, so a
# number on the page only changes when someone edits it.

ROOM_SECTIONS = ["overview", "traction", "science", "team", "raise", "finance", "governance", "documents"]
BLOCK_SECTIONS = [s for s in ROOM_SECTIONS if s != "documents"]
BLOCK_TYPES = ["stat", "text", "logo", "person", "list", "chart", "image", "quote", "docs"]


def _tile_roles(payload: dict) -> list[str]:
    """Marketing roles a docs tile mirrors, in the order they should appear.

    Accepts the older single `role` key as well, so tiles written before a tile
    could mirror more than one document keep working.
    """
    roles = payload.get("roles")
    if isinstance(roles, list):
        return [r for r in roles if isinstance(r, str) and r]
    single = payload.get("role")
    return [single] if isinstance(single, str) and single else []


# Drive metadata is fetched per file, so a room with twenty documents would pay
# twenty round trips on every load. A short TTL keeps a burst of viewers — and
# the several requests one viewer makes — down to one lookup per file, while
# still reflecting a Drive change within the minute.
_DRIVE_META_TTL_SECONDS = 60
_drive_meta_cache: dict[str, tuple[float, Optional[dict]]] = {}


def _drive_meta_live(token: str, file_id: str) -> Optional[dict]:
    """Current name/type/trashed for a Drive file, or None if it is unreachable.

    None covers deleted-for-good and permission-revoked alike: in both cases the
    file is no longer something this room can honestly serve.
    """
    now = time.monotonic()
    hit = _drive_meta_cache.get(file_id)
    if hit and now - hit[0] < _DRIVE_META_TTL_SECONDS:
        return hit[1]

    meta: Optional[dict] = None
    try:
        r = httpx.get(
            f"{DRIVE_FILES_URL}/{file_id}",
            headers={"Authorization": f"Bearer {token}"},
            params={"fields": "id,name,mimeType,trashed", "supportsAllDrives": "true"},
            timeout=10,
        )
        if r.status_code == 200:
            meta = r.json()
        elif r.status_code in (404, 403):
            meta = None
        else:
            # An outage must not empty the room — treat it as unknown and let
            # the caller keep what it has rather than telling investors the
            # documents are gone.
            logger.warning("Drive meta lookup failed for %s: %s", file_id, r.status_code)
            return _UNKNOWN
    except Exception as exc:
        logger.warning("Drive meta lookup errored for %s: %s", file_id, exc)
        return _UNKNOWN

    if len(_drive_meta_cache) > 2000:
        _drive_meta_cache.clear()
    _drive_meta_cache[file_id] = (now, meta)
    return meta


# Sentinel distinguishing "Drive says this file is gone" (None) from "we could
# not reach Drive" (_UNKNOWN). Only the former removes a document.
_UNKNOWN: dict = {"__unknown__": True}


def _drive_item_verdict(token: str, file_id: str, stored_name: Optional[str]) -> tuple[str, Optional[dict]]:
    """Decide whether a pinned document may still be served.

    Returns ("ok", meta), ("drop", None) or ("unknown", None).

    A room pins a Drive id, and that id keeps resolving long after the document
    behind it stopped being the one that was curated. Two things break the link:
    the file is trashed or deleted, and the file is renamed — which in this Drive
    is how a replacement shows up, because the new document is uploaded under a
    new name while the tile still points at the superseded id.

    Both are treated as "this is no longer the document that was picked", so the
    room stops serving it. Showing nothing is the safe failure for a data room;
    showing a superseded agreement is not.

    Only the surrounding whitespace of a name is ignored — an investor cannot
    tell a trailing space from none, so it is not evidence of a replacement.
    """
    meta = _drive_meta_live(token, file_id)
    if meta is _UNKNOWN:
        return "unknown", None
    if not meta or meta.get("trashed"):
        return "drop", None
    if (meta.get("name") or "").strip() != (stored_name or "").strip():
        return "drop", None
    return "ok", meta


def _room_pinned_name(portal_id: str, file_id: str) -> Optional[str]:
    """The name a room tile recorded for a file, or None if it pins no such file.

    Used by the download endpoint so a link stops working under exactly the same
    condition that removes the document from the room — the two must not be able
    to disagree about what is still being served.
    """
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT payload FROM portal_room_blocks
               WHERE portal_id = %s AND block_type = 'docs' AND is_visible = true""",
            [portal_id],
        )
        rows = cur.fetchall()
    except Exception as exc:
        logger.warning("Room pinned-name lookup failed: %s", exc)
        return None
    finally:
        conn.close()

    for r in rows:
        for item in ((r["payload"] or {}).get("items") or []):
            if isinstance(item, dict) and item.get("file_id") == file_id:
                return item.get("name") or ""
    return None


def _resolve_live_drive_items(portal: dict, blocks: list[dict]) -> None:
    """Make Drive authoritative for every document a room serves.

    A docs tile stores the id, name and type captured when the file was picked.
    Each one is re-checked against Drive as the room is read, and anything that
    no longer matches what was curated — trashed, deleted or renamed — drops out
    rather than being served in its old form.

    A tile that loses every document renders as no documents rather than a
    broken row, matching how a mirrored tile behaves when its role has no file
    assigned.
    """
    docs = [b for b in blocks if b.get("block_type") == "docs"]
    if not docs:
        return

    file_ids = {
        item["file_id"]
        for b in docs
        for item in ((b.get("payload") or {}).get("items") or [])
        if isinstance(item, dict) and item.get("file_id")
    }
    if not file_ids:
        return

    try:
        token = _get_drive_token(portal["created_by"])
    except Exception as exc:
        # No usable Drive token: leave the stored snapshot alone rather than
        # blanking the room.
        logger.warning("Room live-resolve skipped, no Drive token: %s", exc)
        return

    # Warm the cache concurrently so a room with many documents costs one round
    # trip rather than one per file in series.
    file_ids = list(file_ids)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda f: _drive_meta_live(token, f), file_ids))

    for b in docs:
        payload = b.get("payload") or {}
        items = payload.get("items")
        if not isinstance(items, list):
            continue

        kept = []
        for item in items:
            if not isinstance(item, dict) or not item.get("file_id"):
                continue
            verdict, meta = _drive_item_verdict(token, item["file_id"], item.get("name"))
            if verdict == "unknown":
                kept.append(item)  # Drive unreachable — keep the snapshot.
                continue
            if verdict == "drop":
                logger.info(
                    "Room %s dropping file %s (%r): removed or renamed in Drive",
                    portal.get("portal_id"), item["file_id"], item.get("name"),
                )
                continue
            item["mime_type"] = meta.get("mimeType") or item.get("mime_type")
            kept.append(item)

        payload["items"] = kept
        b["payload"] = payload


def _apply_marketing_roles(blocks: list[dict]) -> None:
    """Resolve any docs tile set to mirror marketing roles.

    Opt-in per tile: a tile with no roles keeps the files that were picked for
    it. One with roles ignores them and serves whatever Marketing currently
    has, so a room cannot go stale behind a replaced deck.

    A role that has no file assigned contributes nothing rather than an empty
    row — the tile shows the documents that exist, not placeholders.
    """
    from app.routers.marketing import resolve_role_file

    for b in blocks:
        if b.get("block_type") != "docs":
            continue
        payload = b.get("payload") or {}
        roles = _tile_roles(payload)
        if not roles:
            continue

        items = []
        for role in roles:
            resolved = resolve_role_file(role)
            if resolved:
                items.append({
                    "file_id":   resolved["file_id"],
                    "name":      resolved["file_name"],
                    "mime_type": resolved["mime_type"],
                })
        payload["items"] = items
        b["payload"] = payload


def _attach_file_descriptions(cur, portal_id: str, blocks: list[dict]) -> None:
    """Give each document in a docs tile the description written for that file.

    Descriptions are per portal and per file, set on the Documents tab, and are
    what the generic portal view already shows beneath a file name. A docs tile
    stores only the id, name and type it captured when the file was picked, so
    without this the description exists but never reaches the room.

    Resolved at read time rather than copied into the payload, so editing a
    description updates every tile showing that file.
    """
    if not any(b.get("block_type") == "docs" for b in blocks):
        return

    descriptions = _get_file_descriptions(cur, portal_id)

    # A mirrored tile serves the marketing folder's copy of a file, which is a
    # different Drive id from the one a portal description is keyed to. Its
    # description therefore comes from the marketing asset, which is also the
    # right place for it: the file is owned there, not here.
    marketing_desc: dict[str, str] = {}
    try:
        cur.execute("SELECT file_id, description FROM marketing_asset_meta")
        marketing_desc = {r["file_id"]: r["description"] for r in cur.fetchall() if r["description"]}
    except Exception as exc:
        logger.warning("Marketing description lookup failed: %s", exc)

    for b in blocks:
        if b.get("block_type") != "docs":
            continue
        payload = b.get("payload") or {}
        items = payload.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict) or not item.get("file_id"):
                continue
            item.pop("description", None)
            fid = item["file_id"]
            desc = (descriptions.get(fid) or marketing_desc.get(fid) or "").strip()
            if desc:
                item["description"] = desc
        b["payload"] = payload


def _fetch_room_content(
    cur,
    portal_id: str,
    include_hidden: bool = False,
    for_viewer: bool = False,
    portal: Optional[dict] = None,
) -> dict:
    """Sections + blocks for a room, ordered for rendering."""
    vis_blocks   = "" if include_hidden else " AND is_visible = true"
    vis_sections = "" if include_hidden else " AND is_visible = true"

    cur.execute(
        f"""SELECT section, title, subtitle, position, is_visible
            FROM portal_room_sections
            WHERE portal_id = %s{vis_sections}
            ORDER BY position, section""",
        [portal_id],
    )
    sections = [_row_dict(r) for r in cur.fetchall()]

    cur.execute(
        f"""SELECT block_id, section, block_type, position, is_visible, payload, span
            FROM portal_room_blocks
            WHERE portal_id = %s{vis_blocks}
            ORDER BY section, position, created_at""",
        [portal_id],
    )
    blocks = [_row_dict(r) for r in cur.fetchall()]

    # A hidden section is filtered out above, which leaves the room with no row
    # for it at all — and the room treats a missing row as "this section has
    # never been configured, show it with its defaults". Hiding a section
    # therefore brought it back rather than removing it. Naming the hidden ones
    # explicitly is what lets the room tell those two cases apart; only the ids
    # travel, never the titles.
    hidden_sections: list[str] = []
    if not include_hidden:
        cur.execute(
            """SELECT section FROM portal_room_sections
               WHERE portal_id = %s AND is_visible = false""",
            [portal_id],
        )
        hidden_sections = [r["section"] for r in cur.fetchall()]

        # Turning a section off has to take its content with it. A block was
        # only ever filtered on its own visibility, so the tiles of a hidden
        # section were still served — reaching the browser, and leaving their
        # documents downloadable, for a section nobody could see.
        if hidden_sections:
            blocks = [b for b in blocks if b.get("section") not in hidden_sections]

    # Resolve only for the room itself. The editor must see what is stored, or
    # it will save the resolved values back and they stop tracking their source.
    if for_viewer:
        _apply_marketing_roles(blocks)
        if portal:
            # After the roles are resolved, so a mirrored document is held to the
            # same standard as a pinned one.
            _resolve_live_drive_items(portal, blocks)
        _attach_file_descriptions(cur, portal_id, blocks)

    return {"sections": sections, "blocks": blocks, "hidden_sections": hidden_sections}


@router.get("/portal/{token}/room")
def get_portal_room(token: str, request: Request):
    """Curated investor-room content. Gated by the portal's password/session."""
    portal = _validate_token(token)
    _require_portal_session(portal, request)
    portal_id = str(portal["portal_id"])

    conn = _conn()
    try:
        cur = conn.cursor()
        content = _fetch_room_content(cur, portal_id, for_viewer=True, portal=portal)
    finally:
        conn.close()
    return content


@router.get("/portals/room/{portal_id}/blocks")
def list_room_blocks(portal_id: str, request: Request):
    """Management view — includes hidden sections and blocks."""
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        content = _fetch_room_content(cur, portal_id, include_hidden=True)
    finally:
        conn.close()
    return content


class RoomBlockBody(BaseModel):
    section: str
    block_type: str
    payload: dict = {}
    span: int = 1
    position: Optional[int] = None
    is_visible: bool = True


@router.post("/portals/room/{portal_id}/blocks")
def create_room_block(portal_id: str, body: RoomBlockBody, request: Request):
    uid = _require_user(request)
    if body.section not in BLOCK_SECTIONS:
        raise HTTPException(status_code=400, detail=f"section must be one of {BLOCK_SECTIONS}")
    if body.block_type not in BLOCK_TYPES:
        raise HTTPException(status_code=400, detail=f"block_type must be one of {BLOCK_TYPES}")
    if not 1 <= body.span <= 4:
        raise HTTPException(status_code=400, detail="span must be between 1 and 4")

    conn = _conn()
    try:
        cur = conn.cursor()
        position = body.position
        if position is None:
            cur.execute(
                """SELECT COALESCE(MAX(position), -1) + 1 AS next
                   FROM portal_room_blocks WHERE portal_id = %s AND section = %s""",
                [portal_id, body.section],
            )
            position = cur.fetchone()["next"]
        cur.execute(
            """INSERT INTO portal_room_blocks
                 (portal_id, section, block_type, payload, span, position, is_visible, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING block_id, section, block_type, position, is_visible, payload, span""",
            [portal_id, body.section, body.block_type, Json(body.payload),
             body.span, position, body.is_visible, uid],
        )
        row = _row_dict(cur.fetchone())
        conn.commit()
    finally:
        conn.close()
    return row


class RoomBlockPatchBody(BaseModel):
    section: Optional[str] = None
    block_type: Optional[str] = None
    payload: Optional[dict] = None
    span: Optional[int] = None
    position: Optional[int] = None
    is_visible: Optional[bool] = None


@router.patch("/portals/room/{portal_id}/blocks/{block_id}")
def update_room_block(portal_id: str, block_id: str, body: RoomBlockPatchBody, request: Request):
    _require_user(request)
    sets, params = [], []
    if body.section is not None:
        if body.section not in BLOCK_SECTIONS:
            raise HTTPException(status_code=400, detail=f"section must be one of {BLOCK_SECTIONS}")
        sets.append("section = %s"); params.append(body.section)
    if body.block_type is not None:
        if body.block_type not in BLOCK_TYPES:
            raise HTTPException(status_code=400, detail=f"block_type must be one of {BLOCK_TYPES}")
        sets.append("block_type = %s"); params.append(body.block_type)
    if body.payload is not None:
        sets.append("payload = %s"); params.append(Json(body.payload))
    if body.span is not None:
        if not 1 <= body.span <= 4:
            raise HTTPException(status_code=400, detail="span must be between 1 and 4")
        sets.append("span = %s"); params.append(body.span)
    if body.position is not None:
        sets.append("position = %s"); params.append(body.position)
    if body.is_visible is not None:
        sets.append("is_visible = %s"); params.append(body.is_visible)
    if not sets:
        raise HTTPException(status_code=400, detail="Nothing to update")

    sets.append("updated_at = NOW()")
    params += [block_id, portal_id]
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            f"""UPDATE portal_room_blocks SET {', '.join(sets)}
                WHERE block_id = %s AND portal_id = %s
                RETURNING block_id, section, block_type, position, is_visible, payload, span""",
            params,
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Block not found")
    return _row_dict(row)


@router.delete("/portals/room/{portal_id}/blocks/{block_id}")
def delete_room_block(portal_id: str, block_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM portal_room_blocks WHERE block_id = %s AND portal_id = %s",
            [block_id, portal_id],
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


class RoomSectionBody(BaseModel):
    title: Optional[str] = None
    subtitle: Optional[str] = None
    position: Optional[int] = None
    is_visible: Optional[bool] = None


@router.put("/portals/room/{portal_id}/sections/{section}")
def upsert_room_section(portal_id: str, section: str, body: RoomSectionBody, request: Request):
    """Set a section's heading, order or visibility.

    Only the fields actually present in the request body are written, so
    clearing a title to null resets it to the room's default rather than being
    read as "leave it alone".
    """
    _require_user(request)
    if section not in ROOM_SECTIONS:
        raise HTTPException(status_code=400, detail=f"section must be one of {ROOM_SECTIONS}")

    provided = body.model_fields_set
    if not provided:
        raise HTTPException(status_code=400, detail="Nothing to update")

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO portal_room_sections (portal_id, section, title, subtitle, position, is_visible)
               VALUES (%s, %s, %s, %s, COALESCE(%s, 0), COALESCE(%s, true))
               ON CONFLICT (portal_id, section) DO NOTHING""",
            [portal_id, section, body.title, body.subtitle, body.position, body.is_visible],
        )

        sets, params = [], []
        for field in ("title", "subtitle", "position", "is_visible"):
            if field in provided:
                value = getattr(body, field)
                if field in ("position", "is_visible") and value is None:
                    continue
                sets.append(f"{field} = %s")
                params.append(value)

        if sets:
            sets.append("updated_at = NOW()")
            params += [portal_id, section]
            cur.execute(
                f"""UPDATE portal_room_sections SET {', '.join(sets)}
                    WHERE portal_id = %s AND section = %s""",
                params,
            )

        cur.execute(
            """SELECT section, title, subtitle, position, is_visible
               FROM portal_room_sections WHERE portal_id = %s AND section = %s""",
            [portal_id, section],
        )
        row = _row_dict(cur.fetchone())
        conn.commit()
    finally:
        conn.close()
    return row


# ── Self-service access ───────────────────────────────────────────────────────
#
# One link is shared with every investor. The email they enter decides what
# happens next: allowlisted people set a password and walk in, everyone else
# files a request the portal owner approves or denies.

# Two different origins serve portals. The marketing domain only routes the
# investor room's vanity path; every generic /portal/{id} link is served by the
# platform host. Sending a client a www /portal/... link would hit WordPress.
def _marketing_base_url() -> str:
    return os.environ.get("MARKETING_PUBLIC_URL", "https://example.com").rstrip("/")


def _platform_base_url() -> str:
    return os.environ.get("PORTAL_PUBLIC_URL", "https://erp.example.com").rstrip("/")


# Rooms that render on a dedicated marketing-domain page rather than the
# generic portal view. Mirrored in frontend/lib/portalLinks.ts.
VANITY_ROOMS = {"investors": "/investors"}


def _room_link(portal: dict) -> str:
    """Public URL for a room, on whichever host actually serves it."""
    slug = portal.get("slug")
    if slug in VANITY_ROOMS:
        return f"{_marketing_base_url()}{VANITY_ROOMS[slug]}"
    return f"{_platform_base_url()}/portal/{slug or portal['token']}"


def _send_portal_email(sender_user_id: str, to: str, subject: str, body: str) -> bool:
    """Send as the portal owner. Best-effort: a failure must not break the flow."""
    try:
        from email.mime.text import MIMEText
        import base64 as _b64
        from app.routers.email import _get_user_google_token, GMAIL_BASE

        token = _get_user_google_token(sender_user_id)
        msg = MIMEText(body, "plain", "utf-8")
        msg["To"] = to
        msg["Subject"] = subject
        raw = _b64.urlsafe_b64encode(msg.as_bytes()).decode()

        r = httpx.post(
            f"{GMAIL_BASE}/messages/send",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"raw": raw},
            timeout=20,
        )
        if r.status_code not in (200, 201):
            logger.warning("Portal email send failed: %s", r.text[:300])
            return False
        return True
    except Exception as exc:
        logger.warning("Portal email send error: %s", exc)
        return False


def _owner_email(cur, portal: dict) -> tuple[str | None, str | None]:
    """(user_id, email) of whoever should approve requests for this portal."""
    uid = portal.get("assigned_to") or portal.get("created_by")
    if not uid:
        return None, None
    cur.execute("SELECT user_id, email FROM users WHERE user_id = %s", [uid])
    row = cur.fetchone()
    if not row:
        return None, None
    return str(row["user_id"]), row["email"]


class IdentifyBody(BaseModel):
    email: str


@router.post("/portal/{token}/identify")
def portal_identify(token: str, body: IdentifyBody, request: Request):
    """Decide what the visitor sees next, based on their email address.

    Returns status: login | register | pending | denied | unknown
    """
    portal = _validate_token(token)
    portal_id = str(portal["portal_id"])
    email = (body.email or "").strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=400, detail="Enter a valid email address")

    # This endpoint reports whether an address is on the access list, so an
    # unthrottled caller could enumerate the investor list one guess at a time.
    _rate_limit(portal_id, "identify", _client_ip(request), limit=40, window_seconds=600)

    conn = _conn()
    try:
        cur = conn.cursor()

        cur.execute(
            """SELECT viewer_id, name, is_active FROM portal_viewers
               WHERE portal_id = %s AND lower(email) = %s""",
            [portal_id, email],
        )
        viewer = cur.fetchone()
        if viewer:
            if not viewer["is_active"]:
                return {"status": "denied", "reason": "Access to this room has been withdrawn."}
            return {"status": "login", "name": viewer["name"]}

        cur.execute(
            "SELECT name FROM portal_allowed_emails WHERE portal_id = %s AND email = %s",
            [portal_id, email],
        )
        allowed = cur.fetchone()
        if allowed:
            return {"status": "register", "name": allowed["name"]}

        cur.execute(
            "SELECT status FROM portal_access_requests WHERE portal_id = %s AND email = %s",
            [portal_id, email],
        )
        req = cur.fetchone()
        if req:
            if req["status"] == "pending":
                return {"status": "pending"}
            if req["status"] == "denied":
                return {"status": "denied", "reason": "This request was not approved."}
            # approved but not yet on the allowlist shouldn't happen; treat as register
            return {"status": "register", "name": None}

        return {"status": "unknown"}
    finally:
        conn.close()


class RegisterBody(BaseModel):
    email: str
    password: str
    name: Optional[str] = None


@router.post("/portal/{token}/register")
def portal_register(token: str, body: RegisterBody, request: Request):
    """Set a password for an allowlisted email and open a session."""
    portal = _validate_token(token)
    portal_id = str(portal["portal_id"])
    email = (body.email or "").strip().lower()
    if len(body.password or "") < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    _rate_limit(portal_id, "register", _client_ip(request), limit=10, window_seconds=900)

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT name, firm FROM portal_allowed_emails WHERE portal_id = %s AND email = %s",
            [portal_id, email],
        )
        allowed = cur.fetchone()
        if not allowed:
            raise HTTPException(status_code=403, detail="This email is not on the access list")

        cur.execute(
            "SELECT viewer_id FROM portal_viewers WHERE portal_id = %s AND lower(email) = %s",
            [portal_id, email],
        )
        if cur.fetchone():
            raise HTTPException(status_code=409, detail="An account already exists for this email. Log in instead.")

        name = (body.name or allowed["name"] or email.split("@")[0]).strip()
        cur.execute(
            """INSERT INTO portal_viewers (portal_id, name, email, firm, password_hash)
               VALUES (%s, %s, %s, %s, %s)
               RETURNING viewer_id, name""",
            [portal_id, name, email, allowed["firm"], _hash_password(body.password)],
        )
        viewer = cur.fetchone()
        viewer_id = str(viewer["viewer_id"])

        cur.execute(
            "INSERT INTO portal_sessions (portal_id, viewer_id) VALUES (%s, %s) RETURNING session_token",
            [portal_id, viewer_id],
        )
        session_token = str(cur.fetchone()["session_token"])
        conn.commit()
    finally:
        conn.close()

    _log_event(
        portal_id=portal_id, event_type="login", viewer_id=viewer_id, viewer_name=name,
        ip_address=_client_ip(request),
        user_agent=request.headers.get("User-Agent"),
    )
    return {"session_token": session_token, "viewer_name": name}


class EmailLoginBody(BaseModel):
    email: str
    password: str


@router.post("/portal/{token}/login")
def portal_login(token: str, body: EmailLoginBody, request: Request):
    """Log in a registered viewer by email + password."""
    portal = _validate_token(token)
    portal_id = str(portal["portal_id"])
    email = (body.email or "").strip().lower()

    # Limited per address as well as per source, so one attacker cannot spread
    # guesses across addresses and a shared office IP cannot lock out a room.
    _rate_limit(portal_id, "login", _client_ip(request), limit=20, window_seconds=900)
    _rate_limit(portal_id, "login", email, limit=8, window_seconds=900)

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT viewer_id, name, password_hash, is_active FROM portal_viewers
               WHERE portal_id = %s AND lower(email) = %s""",
            [portal_id, email],
        )
        viewer = cur.fetchone()
        if not viewer or not viewer["is_active"]:
            raise HTTPException(status_code=401, detail="Incorrect email or password")
        if not _check_password(body.password, viewer["password_hash"]):
            raise HTTPException(status_code=401, detail="Incorrect email or password")

        viewer_id = str(viewer["viewer_id"])
        name = viewer["name"]
        cur.execute(
            "INSERT INTO portal_sessions (portal_id, viewer_id) VALUES (%s, %s) RETURNING session_token",
            [portal_id, viewer_id],
        )
        session_token = str(cur.fetchone()["session_token"])
        conn.commit()
    finally:
        conn.close()

    _clear_rate_limit(portal_id, "login", email)
    _clear_rate_limit(portal_id, "login", _client_ip(request))

    _log_event(
        portal_id=portal_id, event_type="login", viewer_id=viewer_id, viewer_name=name,
        ip_address=_client_ip(request),
        user_agent=request.headers.get("User-Agent"),
    )
    return {"session_token": session_token, "viewer_name": name}


class AccessRequestBody(BaseModel):
    email: str
    name: Optional[str] = None
    firm: Optional[str] = None
    note: Optional[str] = None


@router.post("/portal/{token}/request-access")
def portal_request_access(token: str, body: AccessRequestBody, request: Request):
    """File an access request and notify the portal owner."""
    portal = _validate_token(token)
    portal_id = str(portal["portal_id"])
    email = (body.email or "").strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=400, detail="Enter a valid email address")

    # Every distinct address here sends the owner an email, so an unthrottled
    # caller could use the room as a mail flood.
    _rate_limit(portal_id, "request", _client_ip(request), limit=5, window_seconds=3600)

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO portal_access_requests (portal_id, email, name, firm, note)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (portal_id, email) DO UPDATE SET
                 name = COALESCE(EXCLUDED.name, portal_access_requests.name),
                 firm = COALESCE(EXCLUDED.firm, portal_access_requests.firm),
                 note = COALESCE(EXCLUDED.note, portal_access_requests.note)
               RETURNING request_id, status""",
            [portal_id, email, (body.name or "").strip() or None,
             (body.firm or "").strip() or None, (body.note or "").strip() or None],
        )
        req = _row_dict(cur.fetchone())
        owner_id, owner_addr = _owner_email(cur, portal)
        conn.commit()
    finally:
        conn.close()

    if owner_id and owner_addr and req["status"] == "pending":
        room = portal.get("display_name") or "data room"
        _send_portal_email(
            owner_id,
            owner_addr,
            f"Access request: {room}",
            f"""{body.name or email} has requested access to {room}.

Email: {email}
Name:  {body.name or "—"}
Firm:  {body.firm or "—"}
Note:  {body.note or "—"}

Approve or deny from the platform:
{_platform_base_url()}/portals
""",
        )

    _log_event(
        portal_id=portal_id, event_type="access_request", viewer_name=body.name or email,
        ip_address=_client_ip(request),
        user_agent=request.headers.get("User-Agent"),
    )
    return {"status": "request_sent"}


# ── Access list management (authenticated) ────────────────────────────────────

@router.get("/portals/room/{portal_id}/allowed-emails")
def list_allowed_emails(portal_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT a.allow_id, a.email, a.name, a.firm, a.created_at,
                      v.viewer_id IS NOT NULL AS is_registered,
                      v.is_active AS viewer_active
               FROM portal_allowed_emails a
               LEFT JOIN portal_viewers v
                      ON v.portal_id = a.portal_id AND lower(v.email) = a.email
               WHERE a.portal_id = %s
               ORDER BY a.created_at DESC""",
            [portal_id],
        )
        return [_row_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


class AllowedEmailsBody(BaseModel):
    emails: str          # newline/comma separated; names may be "Name <email>"


@router.post("/portals/room/{portal_id}/allowed-emails")
def add_allowed_emails(portal_id: str, body: AllowedEmailsBody, request: Request):
    """Bulk-add addresses. Accepts a pasted list, one per line or comma separated."""
    uid = _require_user(request)
    import re as _re

    added, skipped = [], []
    raw_parts = [p.strip() for p in _re.split(r"[,\n;]+", body.emails or "") if p.strip()]

    conn = _conn()
    try:
        cur = conn.cursor()
        for part in raw_parts:
            m = _re.match(r"^(.*?)[<\s]*([^<>\s]+@[^<>\s]+?)>?$", part)
            if not m or "@" not in m.group(2):
                skipped.append(part)
                continue
            name  = m.group(1).strip().strip('"') or None
            email = m.group(2).strip().lower()
            cur.execute(
                """INSERT INTO portal_allowed_emails (portal_id, email, name, added_by)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (portal_id, email) DO NOTHING
                   RETURNING allow_id""",
                [portal_id, email, name, uid],
            )
            (added if cur.fetchone() else skipped).append(email)
        conn.commit()
    finally:
        conn.close()
    return {"added": added, "skipped": skipped}


@router.delete("/portals/room/{portal_id}/allowed-emails/{allow_id}")
def delete_allowed_email(portal_id: str, allow_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM portal_allowed_emails WHERE allow_id = %s AND portal_id = %s",
            [allow_id, portal_id],
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.get("/portals/room/{portal_id}/access-requests")
def list_access_requests(portal_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT request_id, email, name, firm, note, status,
                      created_at, decided_at
               FROM portal_access_requests
               WHERE portal_id = %s
               ORDER BY (status = 'pending') DESC, created_at DESC""",
            [portal_id],
        )
        return [_row_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


class RequestDecisionBody(BaseModel):
    status: str          # approved | denied


@router.patch("/portals/room/{portal_id}/access-requests/{request_id}")
def decide_access_request(portal_id: str, request_id: str, body: RequestDecisionBody, request: Request):
    """Approve (allowlist + notify) or deny an access request."""
    uid = _require_user(request)
    if body.status not in ("approved", "denied"):
        raise HTTPException(status_code=400, detail="status must be approved or denied")

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """UPDATE portal_access_requests
               SET status = %s, decided_at = NOW(), decided_by = %s
               WHERE request_id = %s AND portal_id = %s
               RETURNING email, name, firm""",
            [body.status, uid, request_id, portal_id],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Request not found")
        req = _row_dict(row)

        if body.status == "approved":
            cur.execute(
                """INSERT INTO portal_allowed_emails (portal_id, email, name, firm, added_by)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (portal_id, email) DO NOTHING""",
                [portal_id, req["email"], req["name"], req["firm"], uid],
            )

        cur.execute(
            """SELECT pp.portal_id, pp.token, pp.slug, pp.created_by, pp.assigned_to,
                      COALESCE(p.name, pp.name) AS display_name
               FROM project_portals pp
               LEFT JOIN projects p ON p.project_id = pp.project_id
               WHERE pp.portal_id = %s""",
            [portal_id],
        )
        portal = _row_dict(cur.fetchone())
        owner_id, _ = _owner_email(cur, portal)
        conn.commit()
    finally:
        conn.close()

    if body.status == "approved" and owner_id:
        room = portal.get("display_name") or "our data room"
        _send_portal_email(
            owner_id,
            req["email"],
            f"You've been granted access to {room}",
            f"""Hi{" " + req["name"] if req.get("name") else ""},

You've been granted access to {room}.

Open the link below and enter this email address ({req["email"]}) —
you'll be asked to choose a password the first time.

{_room_link(portal)}

Founder ERP
""",
        )

    return {"status": body.status, "email": req["email"]}


# ── Tile images ───────────────────────────────────────────────────────────────
#
# Tile image fields used to take a URL, so a picture had to be hosted somewhere
# first. These are uploaded from a computer and served back by id.
#
# Unlike documents, they are served without a portal session: an <img> tag
# cannot send the X-Portal-Session header, and unlike a download there is no
# fetch-and-blob workaround, because the browser issues the request itself. The
# id is a random UUID that appears nowhere but the tile, which makes a URL
# unguessable rather than secret — fine for headshots, logos and diagrams.

TILE_IMAGE_DIR = "/app/uploads/portal-images"

TILE_IMAGE_MIMES = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
    "image/gif": ".gif", "image/svg+xml": ".svg",
}

MAX_TILE_IMAGE_BYTES = 10 * 1024 * 1024


@router.post("/portals/room/{portal_id}/images")
async def upload_tile_image(
    portal_id: str,
    request: Request,
    file: UploadFile = File(...),
):
    """Store an image for use in a tile and return the URL to reference it by."""
    uid = _require_user(request)

    mime = (file.content_type or "").lower()
    if mime not in TILE_IMAGE_MIMES:
        raise HTTPException(
            status_code=400,
            detail=f"{mime or 'That file'} is not an image the room can show. Use PNG, JPEG, WEBP, GIF or SVG.",
        )

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="That file is empty")
    if len(content) > MAX_TILE_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"That image is {len(content) // (1024 * 1024)} MB; the limit is 10 MB.",
        )

    os.makedirs(TILE_IMAGE_DIR, exist_ok=True)
    image_id = str(uuid.uuid4())
    stored_name = f"{image_id}{TILE_IMAGE_MIMES[mime]}"
    with open(os.path.join(TILE_IMAGE_DIR, stored_name), "wb") as fh:
        fh.write(content)

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO portal_tile_images
                 (image_id, portal_id, original_name, stored_name, mime_type, size_bytes, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            [image_id, portal_id, file.filename, stored_name, mime, len(content), uid],
        )
        conn.commit()
    finally:
        conn.close()

    return {
        "image_id": image_id,
        "url": f"/api/proxy/portal-images/{image_id}",
        "name": file.filename,
        "size_bytes": len(content),
    }


@router.get("/portal-images/{image_id}")
def get_tile_image(image_id: str):
    """Serve a tile image. No session: an <img> cannot present one."""
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT stored_name, mime_type FROM portal_tile_images WHERE image_id = %s",
            [image_id],
        )
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Image not found")

    path = os.path.join(TILE_IMAGE_DIR, row["stored_name"])
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Image not found")

    with open(path, "rb") as fh:
        data = fh.read()

    return Response(
        content=data,
        media_type=row["mime_type"],
        # Immutable: the id addresses this exact file, so a new image is a new id.
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
