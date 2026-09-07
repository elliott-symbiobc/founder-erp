"""
advisors.py — Advisor tracking endpoints.

GET    /advisors                    — list all advisors with contact info
GET    /advisors/{advisor_id}       — full advisor detail
POST   /advisors                    — create advisor record (links to existing contact)
PATCH  /advisors/{advisor_id}       — update advisor fields
DELETE /advisors/{advisor_id}       — remove advisor record (contact remains)
POST   /advisors/send-update        — send a batch update email to selected advisors
"""

import base64
import email.mime.multipart as _mime_mp
import email.mime.text as _mime
import logging
import os
import uuid
from datetime import date
from typing import List, Optional

import httpx
import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/advisors", tags=["advisors"])


def get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


# ── List all advisors ─────────────────────────────────────────────────────────

@router.get("")
def list_advisors():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT
                    a.advisor_id,
                    a.contact_id,
                    c.name,
                    c.title,
                    c.organization,
                    c.email,
                    c.avatar_url,
                    c.tags,
                    a.equity_percent,
                    a.faa_sign_date,
                    a.piia_due_date,
                    a.piia_issued,
                    a.piia_issue_date,
                    a.piu_cliff_months,
                    a.piu_vest_date,
                    a.vesting_schedule,
                    a.fast_performance_level,
                    a.expected_hours_per_month,
                    a.expected_meetings,
                    a.expected_responsiveness,
                    a.duties,
                    a.faa_document_url,
                    a.piia_document_url,
                    a.notes,
                    a.last_update_sent_at,
                    a.created_at,
                    a.updated_at,
                    (SELECT first_opened_at FROM advisor_email_sends WHERE advisor_id = a.advisor_id ORDER BY sent_at DESC LIMIT 1) AS last_open_at,
                    (SELECT open_count       FROM advisor_email_sends WHERE advisor_id = a.advisor_id ORDER BY sent_at DESC LIMIT 1) AS last_open_count
                FROM contact_advisors a
                JOIN contacts c ON c.contact_id = a.contact_id
                WHERE c.archived = FALSE
                ORDER BY a.faa_sign_date ASC NULLS LAST, c.name
            """)
            rows = cur.fetchall()
            return [dict(r) for r in rows]
    finally:
        conn.close()


# ── Google Drive file search ──────────────────────────────────────────────────

@router.get("/drive/files")
def search_drive_files(request: Request, q: str = Query(default="")):
    """Search the user's Google Drive for documents (PDFs, Docs, Word files)."""
    user_id = request.headers.get("X-User-Id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    from app.routers.contacts import _get_user_google_token
    try:
        token = _get_user_google_token(user_id)
    except HTTPException as e:
        if e.status_code == 400:
            raise HTTPException(status_code=400, detail="google_not_connected")
        raise

    # Build Drive API query — docs and PDFs only, not trashed
    mime_filter = (
        "mimeType = 'application/pdf'"
        " or mimeType = 'application/vnd.google-apps.document'"
        " or mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'"
    )
    query_parts = [f"({mime_filter})", "trashed = false"]
    if q.strip():
        safe_q = q.strip().replace("'", "\\'")
        query_parts.append(f"name contains '{safe_q}'")

    resp = httpx.get(
        "https://www.googleapis.com/drive/v3/files",
        headers={"Authorization": f"Bearer {token}"},
        params={
            "q": " and ".join(query_parts),
            "fields": "files(id,name,mimeType,webViewLink,modifiedTime)",
            "pageSize": 20,
            "orderBy": "modifiedTime desc",
        },
        timeout=15,
    )
    if resp.status_code == 403:
        raise HTTPException(status_code=403, detail="drive_scope_missing")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Drive API error: {resp.text[:200]}")

    return resp.json().get("files", [])


# ── Get single advisor ────────────────────────────────────────────────────────

@router.get("/{advisor_id}")
def get_advisor(advisor_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT
                    a.*,
                    c.name,
                    c.title,
                    c.organization,
                    c.email,
                    c.phone,
                    c.avatar_url,
                    c.tags,
                    c.ai_summary,
                    c.tagline
                FROM contact_advisors a
                JOIN contacts c ON c.contact_id = a.contact_id
                WHERE a.advisor_id = %s
            """, (advisor_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Advisor not found")
            return dict(row)
    finally:
        conn.close()


# ── Create advisor ────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_advisor(body: dict):
    contact_id = body.get("contact_id")
    if not contact_id:
        raise HTTPException(status_code=400, detail="contact_id is required")

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Verify contact exists
            cur.execute("SELECT contact_id FROM contacts WHERE contact_id = %s", (contact_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Contact not found")

            cur.execute("""
                INSERT INTO contact_advisors (
                    contact_id, equity_percent, faa_sign_date, piia_due_date,
                    piia_issued, piia_issue_date, piu_cliff_months, piu_vest_date,
                    vesting_schedule, fast_performance_level, expected_hours_per_month,
                    expected_meetings, expected_responsiveness, duties,
                    faa_document_url, piia_document_url, notes
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                RETURNING advisor_id
            """, (
                contact_id,
                body.get("equity_percent"),
                body.get("faa_sign_date"),
                body.get("piia_due_date"),
                body.get("piia_issued", False),
                body.get("piia_issue_date"),
                body.get("piu_cliff_months", 6),
                body.get("piu_vest_date"),
                body.get("vesting_schedule"),
                body.get("fast_performance_level"),
                body.get("expected_hours_per_month"),
                body.get("expected_meetings"),
                body.get("expected_responsiveness"),
                body.get("duties"),
                body.get("faa_document_url"),
                body.get("piia_document_url"),
                body.get("notes"),
            ))
            row = cur.fetchone()
            conn.commit()
            return {"advisor_id": str(row["advisor_id"])}
    finally:
        conn.close()


# ── Update advisor ────────────────────────────────────────────────────────────

UPDATABLE_FIELDS = {
    "equity_percent", "faa_sign_date", "piia_due_date", "piia_issued",
    "piia_issue_date", "piu_cliff_months", "piu_vest_date", "vesting_schedule",
    "fast_performance_level", "expected_hours_per_month", "expected_meetings",
    "expected_responsiveness", "duties", "faa_document_url", "piia_document_url",
    "notes",
}


@router.patch("/{advisor_id}")
def update_advisor(advisor_id: str, body: dict):
    updates = {k: v for k, v in body.items() if k in UPDATABLE_FIELDS}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values()) + [advisor_id]

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE contact_advisors SET {set_clause}, updated_at = NOW() WHERE advisor_id = %s",
                values,
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Advisor not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── Send batch update email ───────────────────────────────────────────────────

GMAIL_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
GMAIL_DRAFTS = "https://gmail.googleapis.com/gmail/v1/users/me/drafts"


class AdvisorEmailRequest(BaseModel):
    subject: str
    body: str                            # supports {name} placeholder
    advisor_ids: Optional[List[str]] = None  # None = send to all
    cc: Optional[List[str]] = None       # additional CC recipients

SendUpdateRequest = AdvisorEmailRequest  # alias kept for the send endpoint


def _get_advisor_google_token(user_id: str) -> str:
    """Return a valid Google access token for user_id, refreshing if needed."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT access_token, refresh_token, token_expiry FROM google_oauth_tokens WHERE user_id = %s",
                (user_id,),
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=400, detail="google_not_connected")

    from datetime import datetime, timezone, timedelta
    expiry = row["token_expiry"]
    if expiry and expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    needs_refresh = not expiry or expiry <= datetime.now(timezone.utc) + timedelta(minutes=2)

    if needs_refresh:
        client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
        client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
        r = httpx.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": row["refresh_token"],
                "grant_type": "refresh_token",
            },
            timeout=15,
        )
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail="Google token refresh failed")
        data = r.json()
        access_token = data["access_token"]
        from datetime import datetime, timezone, timedelta
        new_expiry = datetime.now(timezone.utc) + timedelta(seconds=data.get("expires_in", 3600))
        conn2 = get_conn()
        try:
            with conn2.cursor() as cur:
                cur.execute(
                    "UPDATE google_oauth_tokens SET access_token=%s, token_expiry=%s WHERE user_id=%s",
                    (access_token, new_expiry, user_id),
                )
                conn2.commit()
        finally:
            conn2.close()
        return access_token

    return row["access_token"]


BASE_URL = os.environ.get("NEXTAUTH_URL", "https://erp.example.com")

# 1x1 transparent GIF
_PIXEL_GIF = base64.b64decode(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
)


def _fetch_advisors_for_send(advisor_ids: Optional[List[str]]):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if advisor_ids:
                cur.execute(
                    """
                    SELECT a.advisor_id, a.contact_id, c.name, c.email
                    FROM contact_advisors a
                    JOIN contacts c ON c.contact_id = a.contact_id
                    WHERE a.advisor_id = ANY(%s) AND c.archived = FALSE AND c.email IS NOT NULL
                    """,
                    (advisor_ids,),
                )
            else:
                cur.execute(
                    """
                    SELECT a.advisor_id, a.contact_id, c.name, c.email
                    FROM contact_advisors a
                    JOIN contacts c ON c.contact_id = a.contact_id
                    WHERE c.archived = FALSE AND c.email IS NOT NULL
                    """
                )
            return cur.fetchall()
    finally:
        conn.close()


def _build_mime(to_name: str, to_email: str, subject: str, text_body: str, send_id: str, cc: Optional[List[str]] = None) -> bytes:
    """Build a multipart/alternative MIME message with plain text + HTML tracking pixel."""
    msg = _mime_mp.MIMEMultipart("alternative")
    msg["To"] = f"{to_name} <{to_email}>"
    msg["Subject"] = subject
    if cc:
        msg["Cc"] = ", ".join(cc)

    msg.attach(_mime.MIMEText(text_body, "plain", "utf-8"))

    html_body = "<br>".join(line for line in text_body.splitlines())
    pixel_url = f"{BASE_URL}/api/proxy/advisors/track/{send_id}/open.gif"
    html = (
        f'<div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#111">'
        f"{html_body}"
        f'</div>'
        f'<img src="{pixel_url}" width="1" height="1" alt="" style="display:none" />'
    )
    msg.attach(_mime.MIMEText(html, "html", "utf-8"))

    return msg.as_bytes()


@router.post("/send-update", status_code=200)
def send_advisor_update(body: AdvisorEmailRequest, request: Request):
    """Send a batch update email to selected (or all) advisors."""
    user_id = request.headers.get("X-User-Id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    access_token = _get_advisor_google_token(user_id)
    advisors = _fetch_advisors_for_send(body.advisor_ids)
    if not advisors:
        raise HTTPException(status_code=400, detail="No advisors with email addresses found")

    results = []
    for adv in advisors:
        first_name = adv["name"].split()[0]
        personalized_body = body.body.replace("{name}", first_name)

        # Pre-create send record to get the tracking ID
        send_id = str(uuid.uuid4())
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO advisor_email_sends (send_id, advisor_id, contact_id, subject) VALUES (%s, %s, %s, %s)",
                    (send_id, adv["advisor_id"], adv["contact_id"], body.subject),
                )
                conn.commit()
        finally:
            conn.close()

        raw = base64.urlsafe_b64encode(
            _build_mime(adv["name"], adv["email"], body.subject, personalized_body, send_id, body.cc)
        ).decode()

        r = httpx.post(
            GMAIL_SEND,
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
            json={"raw": raw},
            timeout=20,
        )
        if r.status_code not in (200, 201):
            logger.error("Gmail send failed for %s: %s", adv["email"], r.text)
            # Remove the orphaned send record
            conn = get_conn()
            try:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM advisor_email_sends WHERE send_id = %s", (send_id,))
                    conn.commit()
            finally:
                conn.close()
            results.append({"advisor_id": str(adv["advisor_id"]), "email": adv["email"], "status": "error", "detail": r.json().get("error", {}).get("message", "Send failed")})
            continue

        gmail_id = r.json().get("id")

        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE advisor_email_sends SET gmail_message_id = %s WHERE send_id = %s",
                    (gmail_id, send_id),
                )
                cur.execute(
                    """
                    INSERT INTO contact_interactions
                        (contact_id, interaction_type, subject, content_preview, full_content,
                         occurred_at, direction, external_id)
                    VALUES (%s, 'email_sent', %s, %s, %s, NOW(), 'outbound', %s)
                    ON CONFLICT (contact_id, external_id) DO NOTHING
                    """,
                    (adv["contact_id"], body.subject, personalized_body[:500], personalized_body, gmail_id),
                )
                cur.execute(
                    "UPDATE contacts SET last_interaction_at = NOW(), updated_at = NOW() WHERE contact_id = %s",
                    (adv["contact_id"],),
                )
                cur.execute(
                    "UPDATE contact_advisors SET last_update_sent_at = NOW() WHERE advisor_id = %s",
                    (adv["advisor_id"],),
                )
                conn.commit()
        finally:
            conn.close()

        results.append({"advisor_id": str(adv["advisor_id"]), "email": adv["email"], "status": "sent", "send_id": send_id})

    sent = sum(1 for r in results if r["status"] == "sent")
    return {"sent": sent, "total": len(advisors), "results": results}


@router.post("/save-drafts", status_code=200)
def save_advisor_drafts(body: AdvisorEmailRequest, request: Request):
    """Save individual Gmail drafts for selected (or all) advisors."""
    user_id = request.headers.get("X-User-Id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    access_token = _get_advisor_google_token(user_id)
    advisors = _fetch_advisors_for_send(body.advisor_ids)
    if not advisors:
        raise HTTPException(status_code=400, detail="No advisors with email addresses found")

    results = []
    for adv in advisors:
        first_name = adv["name"].split()[0]
        personalized_body = body.body.replace("{name}", first_name)

        # Drafts don't get a tracking pixel (not sent yet)
        msg = _mime_mp.MIMEMultipart("alternative")
        msg["To"] = f"{adv['name']} <{adv['email']}>"
        msg["Subject"] = body.subject
        if body.cc:
            msg["Cc"] = ", ".join(body.cc)
        msg.attach(_mime.MIMEText(personalized_body, "plain", "utf-8"))
        html_body = "<br>".join(line for line in personalized_body.splitlines())
        msg.attach(_mime.MIMEText(
            f'<div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#111">{html_body}</div>',
            "html", "utf-8",
        ))
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()

        r = httpx.post(
            GMAIL_DRAFTS,
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
            json={"message": {"raw": raw}},
            timeout=20,
        )
        if r.status_code not in (200, 201):
            logger.error("Draft save failed for %s: %s", adv["email"], r.text)
            results.append({"advisor_id": str(adv["advisor_id"]), "email": adv["email"], "status": "error", "detail": r.json().get("error", {}).get("message", "Draft save failed")})
        else:
            results.append({"advisor_id": str(adv["advisor_id"]), "email": adv["email"], "status": "saved"})

    saved = sum(1 for r in results if r["status"] == "saved")
    return {"saved": saved, "total": len(advisors), "results": results}


@router.get("/track/{send_id}/open.gif")
def track_open(send_id: str):
    """Record an email open and return a 1x1 transparent GIF."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE advisor_email_sends
                SET
                    open_count = open_count + 1,
                    first_opened_at = COALESCE(first_opened_at, NOW())
                WHERE send_id = %s
                """,
                (send_id,),
            )
            conn.commit()
    finally:
        conn.close()
    return Response(content=_PIXEL_GIF, media_type="image/gif", headers={"Cache-Control": "no-store"})


# ── Delete advisor record ─────────────────────────────────────────────────────

@router.delete("/{advisor_id}", status_code=204)
def delete_advisor(advisor_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM contact_advisors WHERE advisor_id = %s", (advisor_id,))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Advisor not found")
            conn.commit()
    finally:
        conn.close()


