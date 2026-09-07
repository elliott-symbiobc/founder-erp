"""
email.py — Gmail inbox module.

GET  /email/inbox              — paginated inbox from Gmail API
GET  /email/sent               — paginated sent folder
GET  /email/message/{id}       — full message content
POST /email/send               — send email to any recipient
"""

import base64
import logging
import os
from datetime import datetime, timezone, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/email", tags=["email"])

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"


def _conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _get_user_google_token(user_id: str) -> str:
    """Return a valid access token for user_id, refreshing if needed."""
    import httpx as _httpx

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM google_oauth_tokens WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(
                status_code=400,
                detail="Google account not connected. Connect Gmail first via Settings.",
            )

        expiry = row["token_expiry"]
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) >= expiry - timedelta(minutes=2):
            r = _httpx.post(
                GOOGLE_TOKEN_URL,
                data={
                    "client_id": os.environ.get("GOOGLE_CLIENT_ID", ""),
                    "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET", ""),
                    "refresh_token": row["refresh_token"],
                    "grant_type": "refresh_token",
                },
                timeout=15,
            )
            if r.status_code != 200:
                raise HTTPException(status_code=502, detail="Failed to refresh Google token")
            data = r.json()
            new_token = data["access_token"]
            new_expiry = datetime.now(timezone.utc) + timedelta(seconds=data.get("expires_in", 3600))
            cur2 = conn.cursor()
            cur2.execute(
                "UPDATE google_oauth_tokens SET access_token=%s, token_expiry=%s, updated_at=NOW() WHERE user_id=%s",
                (new_token, new_expiry, user_id),
            )
            conn.commit()
            return new_token

        return row["access_token"]
    finally:
        conn.close()


def _extract_header(headers: list, name: str) -> str:
    for h in headers:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _extract_body(payload: dict) -> dict:
    """Extract plain text and HTML body from Gmail message payload."""
    plain = ""
    html = ""

    def walk(part):
        nonlocal plain, html
        mime = part.get("mimeType", "")
        body_data = part.get("body", {}).get("data", "")
        if mime == "text/plain" and body_data and not plain:
            plain = base64.urlsafe_b64decode(body_data + "==").decode("utf-8", errors="replace")
        elif mime == "text/html" and body_data and not html:
            html = base64.urlsafe_b64decode(body_data + "==").decode("utf-8", errors="replace")
        for sub in part.get("parts", []):
            walk(sub)

    walk(payload)
    return {"plain": plain, "html": html}


def _parse_message_metadata(msg: dict) -> dict:
    headers = msg.get("payload", {}).get("headers", [])
    return {
        "id": msg.get("id"),
        "thread_id": msg.get("threadId"),
        "snippet": msg.get("snippet", ""),
        "subject": _extract_header(headers, "Subject") or "(no subject)",
        "from": _extract_header(headers, "From"),
        "to": _extract_header(headers, "To"),
        "date": _extract_header(headers, "Date"),
        "label_ids": msg.get("labelIds", []),
        "is_read": "UNREAD" not in msg.get("labelIds", []),
    }


class SendEmailRequest(BaseModel):
    to: str                              # recipient email address
    to_name: Optional[str] = None        # optional display name
    subject: str
    body: str                            # plain text body
    cc: Optional[list[str]] = []
    contact_id: Optional[str] = None     # if tied to a contact, record interaction


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/status")
def gmail_status(request: Request):
    """Check if current user has Gmail connected."""
    user_id = request.headers.get("X-User-Id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT google_email, updated_at FROM google_oauth_tokens WHERE user_id = %s",
            (user_id,),
        )
        row = cur.fetchone()
        if not row:
            return {"connected": False}
        return {
            "connected": True,
            "google_email": row["google_email"],
            "last_sync": row["updated_at"].isoformat() if row["updated_at"] else None,
        }
    finally:
        conn.close()


@router.get("/inbox")
def list_inbox(
    request: Request,
    page_token: Optional[str] = Query(None),
    max_results: int = Query(25, ge=1, le=100),
    label: str = Query("INBOX"),
):
    """Return paginated Gmail inbox messages with metadata headers."""
    import httpx as _httpx

    user_id = request.headers.get("X-User-Id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    access_token = _get_user_google_token(user_id)

    # 1. List message IDs
    params: dict = {"labelIds": label, "maxResults": max_results}
    if page_token:
        params["pageToken"] = page_token

    r = _httpx.get(
        f"{GMAIL_BASE}/messages",
        headers={"Authorization": f"Bearer {access_token}"},
        params=params,
        timeout=20,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Gmail API error: {r.text[:200]}")

    data = r.json()
    messages_raw = data.get("messages", [])
    next_page_token = data.get("nextPageToken")

    if not messages_raw:
        return {"messages": [], "next_page_token": None}

    # 2. Fetch metadata for each message (subject, from, to, date)
    messages = []
    for m in messages_raw:
        resp = _httpx.get(
            f"{GMAIL_BASE}/messages/{m['id']}",
            headers={"Authorization": f"Bearer {access_token}"},
            params={
                "format": "metadata",
                "metadataHeaders": ["Subject", "From", "To", "Date"],
            },
            timeout=15,
        )
        if resp.status_code == 200:
            messages.append(_parse_message_metadata(resp.json()))

    return {"messages": messages, "next_page_token": next_page_token}


@router.get("/sent")
def list_sent(
    request: Request,
    page_token: Optional[str] = Query(None),
    max_results: int = Query(25, ge=1, le=100),
):
    """Return paginated sent folder."""
    return list_inbox(request, page_token=page_token, max_results=max_results, label="SENT")


@router.get("/search")
def search_email(
    request: Request,
    q: str = Query(..., min_length=1),
    max_results: int = Query(15, ge=1, le=50),
):
    """Search the user's Gmail with a free-text query. Returns lightweight
    message metadata (id, subject, from, date, snippet) for attaching as a
    data source."""
    import httpx as _httpx

    user_id = request.headers.get("X-User-Id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    access_token = _get_user_google_token(user_id)

    r = _httpx.get(
        f"{GMAIL_BASE}/messages",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"q": q, "maxResults": max_results},
        timeout=20,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Gmail API error: {r.text[:200]}")

    results = []
    for m in r.json().get("messages", []):
        resp = _httpx.get(
            f"{GMAIL_BASE}/messages/{m['id']}",
            headers={"Authorization": f"Bearer {access_token}"},
            params={"format": "metadata", "metadataHeaders": ["Subject", "From", "Date"]},
            timeout=15,
        )
        if resp.status_code == 200:
            meta = _parse_message_metadata(resp.json())
            results.append({
                "id": m["id"],
                "title": meta.get("subject") or "(no subject)",
                "subtitle": meta.get("from"),
                "snippet": meta.get("snippet"),
                "url": f"https://mail.google.com/mail/u/0/#all/{m['id']}",
            })
    return {"results": results}


@router.get("/drive-search")
def search_drive(
    request: Request,
    q: str = Query(..., min_length=1),
    max_results: int = Query(15, ge=1, le=50),
):
    """Search the user's Google Drive by file name. Returns file metadata for
    attaching as a data source."""
    import httpx as _httpx

    user_id = request.headers.get("X-User-Id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    access_token = _get_user_google_token(user_id)

    # Escape single quotes for the Drive query grammar.
    safe = q.replace("'", "\\'")
    r = _httpx.get(
        "https://www.googleapis.com/drive/v3/files",
        headers={"Authorization": f"Bearer {access_token}"},
        params={
            "q": f"name contains '{safe}' and trashed = false",
            "pageSize": max_results,
            "fields": "files(id,name,mimeType,webViewLink,modifiedTime)",
            "orderBy": "modifiedTime desc",
        },
        timeout=20,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Drive API error: {r.text[:200]}")

    results = []
    for f in r.json().get("files", []):
        results.append({
            "id": f["id"],
            "title": f.get("name") or "(untitled)",
            "subtitle": (f.get("mimeType") or "").split(".")[-1],
            "snippet": None,
            "url": f.get("webViewLink"),
        })
    return {"results": results}


@router.get("/message/{message_id}")
def get_message(message_id: str, request: Request):
    """Fetch full message content from Gmail."""
    import httpx as _httpx

    user_id = request.headers.get("X-User-Id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    access_token = _get_user_google_token(user_id)

    r = _httpx.get(
        f"{GMAIL_BASE}/messages/{message_id}",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"format": "full"},
        timeout=20,
    )
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="Message not found")
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Gmail API error: {r.text[:200]}")

    msg = r.json()
    headers = msg.get("payload", {}).get("headers", [])
    body = _extract_body(msg.get("payload", {}))

    return {
        "id": msg.get("id"),
        "thread_id": msg.get("threadId"),
        "subject": _extract_header(headers, "Subject") or "(no subject)",
        "from": _extract_header(headers, "From"),
        "to": _extract_header(headers, "To"),
        "cc": _extract_header(headers, "Cc"),
        "date": _extract_header(headers, "Date"),
        "label_ids": msg.get("labelIds", []),
        "is_read": "UNREAD" not in msg.get("labelIds", []),
        "snippet": msg.get("snippet", ""),
        "plain_body": body["plain"],
        "html_body": body["html"],
    }


@router.post("/send", status_code=201)
def send_email(body: SendEmailRequest, request: Request):
    """Send an email via the authenticated user's Gmail account."""
    import httpx as _httpx

    user_id = request.headers.get("X-User-Id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    access_token = _get_user_google_token(user_id)

    # Build MIME message
    msg = MIMEText(body.body, "plain", "utf-8")
    to_header = f"{body.to_name} <{body.to}>" if body.to_name else body.to
    msg["To"] = to_header
    msg["Subject"] = body.subject
    if body.cc:
        msg["Cc"] = ", ".join(body.cc)

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()

    r = _httpx.post(
        f"{GMAIL_BASE}/messages/send",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"raw": raw},
        timeout=20,
    )
    if r.status_code not in (200, 201):
        logger.error("Gmail send failed: %s", r.text)
        raise HTTPException(
            status_code=502,
            detail=f"Gmail API error: {r.json().get('error', {}).get('message', r.text)}",
        )

    gmail_id = r.json().get("id")

    # Optionally record as contact interaction
    if body.contact_id:
        conn = _conn()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO contact_interactions
                    (contact_id, interaction_type, subject, content_preview, full_content,
                     occurred_at, direction, external_id)
                VALUES (%s, 'email_sent', %s, %s, %s, NOW(), 'outbound', %s)
                ON CONFLICT (contact_id, external_id) DO NOTHING
                """,
                (body.contact_id, body.subject, body.body[:500], body.body, gmail_id),
            )
            cur.execute(
                "UPDATE contacts SET last_interaction_at = NOW(), updated_at = NOW() WHERE contact_id = %s",
                (body.contact_id,),
            )
            conn.commit()
        finally:
            conn.close()

    return {"status": "sent", "gmail_message_id": gmail_id}


@router.get("/followup-suggestions")
def get_followup_suggestions():
    """Return saved suggestions from the most recent scan (non-dismissed, non-accepted)."""
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            """
            SELECT s.*
            FROM email_followup_suggestions s
            WHERE scan_batch_id = (
                SELECT scan_batch_id FROM email_followup_suggestions
                ORDER BY created_at DESC LIMIT 1
            )
              -- The docstring has always claimed non-dismissed and non-accepted;
              -- the query never filtered on status, so accepting a suggestion
              -- created the task and then handed the suggestion straight back on
              -- the next load. It reads as the finished work returning to the
              -- Inbox, because a suggestion and the task it made look alike.
              AND s.status = 'pending'
            ORDER BY created_at ASC
            """,
        )
        rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            if r.get("suggested_due_date"):
                r["suggested_due_date"] = str(r["suggested_due_date"])
        return {"suggestions": rows}
    finally:
        conn.close()


@router.patch("/followup-suggestions/{suggestion_id}")
def update_suggestion_status(suggestion_id: str, body: dict):
    """Update status of a suggestion (accepted or dismissed)."""
    status = body.get("status")
    if status not in ("accepted", "dismissed", "pending"):
        raise HTTPException(status_code=400, detail="status must be accepted, dismissed, or pending")
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE email_followup_suggestions SET status=%s WHERE suggestion_id=%s::uuid",
            (status, suggestion_id),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.get("/suggest-followups")
def suggest_followups(request: Request, max_results: int = Query(20, ge=1, le=50)):
    """
    Fetch recent inbox emails and use Claude to suggest typed tasks (not just follow-ups).
    Returns suggestions with task_type, title, priority, and duplicate detection.
    """
    import httpx as _httpx
    import anthropic
    import json as _json

    user_id = request.headers.get("X-User-Id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    access_token = _get_user_google_token(user_id)

    # 1. Fetch recent inbox messages (metadata only)
    r = _httpx.get(
        f"{GMAIL_BASE}/messages",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"labelIds": "INBOX", "maxResults": max_results},
        timeout=20,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Gmail API error: {r.text[:200]}")

    messages_raw = r.json().get("messages", [])
    if not messages_raw:
        return {"suggestions": []}

    # 2. Fetch metadata for each message
    messages = []
    for m in messages_raw[:max_results]:
        resp = _httpx.get(
            f"{GMAIL_BASE}/messages/{m['id']}",
            headers={"Authorization": f"Bearer {access_token}"},
            params={"format": "metadata", "metadataHeaders": ["Subject", "From", "To", "Date"]},
            timeout=15,
        )
        if resp.status_code == 200:
            messages.append(_parse_message_metadata(resp.json()))

    if not messages:
        return {"suggestions": []}

    # 3. Load existing open task titles for duplicate detection
    conn = _conn()
    existing_titles: list[str] = []
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT LOWER(title) FROM tasks WHERE user_id=%s::uuid AND status='open' ORDER BY created_at DESC LIMIT 100",
            (user_id,),
        )
        existing_titles = [r[0] for r in cur.fetchall()]
    except Exception:
        pass
    finally:
        conn.close()

    existing_block = ""
    if existing_titles:
        existing_block = "\n\nAlready open tasks (do NOT suggest duplicates of these):\n" + "\n".join(
            f"- {t}" for t in existing_titles[:30]
        )

    # 4. Ask Claude to suggest actionable tasks
    email_list = "\n".join(
        f"[{i}] id={m['id']} | from={m['from']} | subject={m['subject']} | date={m['date']} | read={'yes' if m['is_read'] else 'no'} | snippet={m['snippet'][:200]}"
        for i, m in enumerate(messages)
    )

    client = anthropic.Anthropic()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    prompt = f"""Today is {today}. You are a smart assistant reviewing recent inbox emails to suggest specific tasks.{existing_block}

Emails:
{email_list}

For each email that requires action, suggest ONE concrete task. Think about what specific action is needed:
- A reply needed? → task_type: "email"
- A call to schedule or conduct? → task_type: "call"
- A meeting to prepare for or schedule? → task_type: "meeting"
- A document to review, sign, or create? → task_type: "document"
- Other actionable item? → task_type: "todo"

Exclude: newsletters, automated notifications, receipts, marketing, noreply senders.
Skip emails that are already covered by an existing open task.

Return a JSON array (max 6 items). Each item:
{{
  "message_id": "<gmail message id>",
  "from_name": "<sender display name>",
  "from_email": "<sender email>",
  "subject": "<email subject>",
  "date": "<date string>",
  "title": "<short specific task title, e.g. 'Reply to John re: partnership proposal'>",
  "reason": "<1 sentence explaining why this task is needed>",
  "task_type": "email|call|meeting|document|todo",
  "priority": "high|medium|low",
  "suggested_due_days": <1-7>
}}

Return only valid JSON array, no explanation."""

    msg = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = msg.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip()

    try:
        suggestions = _json.loads(raw)
        if not isinstance(suggestions, list):
            suggestions = []
    except Exception:
        suggestions = []

    # Add computed due_date; keep suggested_action as alias for title
    for s in suggestions:
        days = s.pop("suggested_due_days", 2)
        try:
            due = datetime.now(timezone.utc) + timedelta(days=int(days))
            s["suggested_due_date"] = due.strftime("%Y-%m-%d")
        except Exception:
            s["suggested_due_date"] = (datetime.now(timezone.utc) + timedelta(days=2)).strftime("%Y-%m-%d")
        # Back-compat: expose as suggested_action too
        if "title" in s and "suggested_action" not in s:
            s["suggested_action"] = s["title"]

    # Persist to DB
    import uuid as _uuid
    batch_id = str(_uuid.uuid4())
    if suggestions:
        conn = _conn()
        try:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            for s in suggestions:
                cur.execute(
                    """
                    INSERT INTO email_followup_suggestions
                        (message_id, from_name, from_email, subject, date,
                         reason, suggested_action, suggested_due_date, status, scan_batch_id,
                         task_type, title, priority)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'pending', %s::uuid, %s, %s, %s)
                    RETURNING suggestion_id
                    """,
                    (
                        s.get("message_id"), s.get("from_name"), s.get("from_email"),
                        s.get("subject"), s.get("date"), s.get("reason"),
                        s.get("suggested_action"), s.get("suggested_due_date"), batch_id,
                        s.get("task_type", "email"),
                        s.get("title") or s.get("suggested_action"),
                        s.get("priority", "medium"),
                    ),
                )
                s["suggestion_id"] = str(cur.fetchone()["suggestion_id"])
                s["status"] = "pending"
            conn.commit()
        finally:
            conn.close()

    return {"suggestions": suggestions, "scan_batch_id": batch_id}


class AcceptFollowupRequest(BaseModel):
    from_email: str
    from_name: str
    subject: str
    suggested_action: str
    suggested_due_date: str  # YYYY-MM-DD
    message_id: str
    task_type: str = "email"
    priority: str = "medium"
    title: Optional[str] = None
    suggestion_id: Optional[str] = None
    user_id: Optional[str] = None   # passed from frontend header


@router.post("/accept-followup", status_code=201)
def accept_followup(body: AcceptFollowupRequest, request: Request):
    """
    Accept a task suggestion — creates a typed task linked to the contact if found.
    Always creates a task (not just a contact reminder) for clean task list integration.
    """
    from app.routers.auth import get_current_user

    user = get_current_user(request)
    uid = user["user_id"] if user else body.user_id
    if not uid:
        raise HTTPException(status_code=401, detail="Not authenticated")

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        # Look up contact by email (case-insensitive) to link the task
        cur.execute(
            "SELECT contact_id, name FROM contacts WHERE LOWER(email) = LOWER(%s) AND NOT archived LIMIT 1",
            (body.from_email,),
        )
        contact = cur.fetchone()

        task_title = body.title or body.suggested_action or f"Follow up: {body.subject}"
        priority = body.priority if body.priority in ("high", "medium", "low") else "medium"
        task_type = body.task_type if body.task_type in ("email", "call", "meeting", "document", "todo") else "email"

        # Get next sort_order
        cur.execute(
            "SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM tasks WHERE user_id=%s::uuid",
            (uid,),
        )
        next_order = cur.fetchone()["next"]

        # A task off an email belongs to whoever owns the mailbox it arrived in,
        # not necessarily whoever happened to clear the suggestion list. Falls
        # back to the acting user when the message predates mailbox tracking.
        # message_id is compared as text so a non-uuid value cannot error the
        # lookup.
        cur.execute(
            """
            SELECT mailbox_user_id::text AS uid
              FROM comm_message_mailboxes
             WHERE gmail_message_id = %s OR message_id::text = %s
             LIMIT 1
            """,
            (body.message_id, body.message_id),
        )
        mailbox = cur.fetchone()
        assignee = (mailbox or {}).get("uid") or uid

        # Lands in Inbox, not To Do. Accepting a suggestion says "this is
        # real", not "this is next" -- it still needs a due date, a priority
        # and a place in the queue, which is what Inbox is for.
        cur.execute(
            """
            INSERT INTO tasks
                (user_id, assigned_to, title, description, due_date, status, kanban_status,
                 activity_type, priority, sort_order, contact_id, source_ref)
            VALUES (%s::uuid, %s::uuid, %s, %s, %s::date, 'open', 'inbox', %s, %s, %s, %s, 'email_suggestion')
            RETURNING *
            """,
            (
                uid,
                assignee,
                task_title,
                f"From: {body.from_name} <{body.from_email}> · Re: {body.subject}",
                body.suggested_due_date or None,
                task_type,
                priority,
                next_order,
                str(contact["contact_id"]) if contact else None,
            ),
        )
        task = dict(cur.fetchone())

        # Mark the suggestion as accepted
        if body.suggestion_id:
            cur.execute(
                "UPDATE email_followup_suggestions SET status='accepted' WHERE suggestion_id=%s::uuid",
                (body.suggestion_id,),
            )

        conn.commit()
        return {
            "type": "task",
            "id": str(task["task_id"]),
            "contact_id": str(contact["contact_id"]) if contact else None,
            "contact_name": contact["name"] if contact else None,
        }
    finally:
        conn.close()


@router.post("/mark-read/{message_id}")
def mark_read(message_id: str, request: Request):
    """Mark a Gmail message as read."""
    import httpx as _httpx

    user_id = request.headers.get("X-User-Id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    access_token = _get_user_google_token(user_id)

    r = _httpx.post(
        f"{GMAIL_BASE}/messages/{message_id}/modify",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"removeLabelIds": ["UNREAD"]},
        timeout=10,
    )
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail="Failed to mark message as read")
    return {"ok": True}


def ensure_suggestions_user_column():
    """Add user_id to email_followup_suggestions if not present (idempotent)."""
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("""
            ALTER TABLE email_followup_suggestions
            ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(user_id) ON DELETE CASCADE
        """)
        conn.commit()
    except Exception as e:
        logger.warning("ensure_suggestions_user_column: %s", e)
        conn.rollback()
    finally:
        conn.close()


def scan_and_notify_user(user_id: str) -> int:
    """
    Run the email suggestion scan for one user and send a notification if
    new suggestions are found. Returns the number of new suggestions saved.
    Called by the Celery beat task.
    """
    import httpx as _httpx
    import anthropic
    import json as _json
    import uuid as _uuid

    # Get access token — skip silently if user has no token
    try:
        access_token = _get_user_google_token(user_id)
    except Exception:
        return 0

    # Fetch inbox messages
    try:
        r = _httpx.get(
            f"{GMAIL_BASE}/messages",
            headers={"Authorization": f"Bearer {access_token}"},
            params={"labelIds": "INBOX", "maxResults": 20},
            timeout=20,
        )
        if r.status_code != 200:
            return 0
        messages_raw = r.json().get("messages", [])
    except Exception as e:
        logger.warning("scan_and_notify_user: Gmail fetch failed for %s: %s", user_id, e)
        return 0

    if not messages_raw:
        return 0

    messages = []
    for m in messages_raw[:20]:
        try:
            resp = _httpx.get(
                f"{GMAIL_BASE}/messages/{m['id']}",
                headers={"Authorization": f"Bearer {access_token}"},
                params={"format": "metadata", "metadataHeaders": ["Subject", "From", "To", "Date"]},
                timeout=15,
            )
            if resp.status_code == 200:
                messages.append(_parse_message_metadata(resp.json()))
        except Exception:
            continue

    if not messages:
        return 0

    # Deduplicate against existing open tasks
    conn = _conn()
    existing_titles: list[str] = []
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT LOWER(title) FROM tasks WHERE user_id=%s::uuid AND status='open' ORDER BY created_at DESC LIMIT 100",
            (user_id,),
        )
        existing_titles = [r[0] for r in cur.fetchall()]
    except Exception:
        pass
    finally:
        conn.close()

    existing_block = ""
    if existing_titles:
        existing_block = "\n\nAlready open tasks (do NOT suggest duplicates):\n" + "\n".join(
            f"- {t}" for t in existing_titles[:30]
        )

    email_list = "\n".join(
        f"[{i}] id={m['id']} | from={m['from']} | subject={m['subject']} | date={m['date']} | snippet={m['snippet'][:200]}"
        for i, m in enumerate(messages)
    )

    client = anthropic.Anthropic()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    prompt = f"""Today is {today}. Review these inbox emails and suggest actionable tasks.{existing_block}

Emails:
{email_list}

For each email requiring action, suggest ONE concrete task. Exclude newsletters, automated notifications, receipts, marketing emails, noreply senders.

Return a JSON array (max 6 items):
{{
  "message_id": "<gmail message id>",
  "from_name": "<sender name>",
  "from_email": "<sender email>",
  "subject": "<subject>",
  "date": "<date>",
  "title": "<short task title, e.g. 'Reply to John re: partnership'>",
  "reason": "<1 sentence why this needs action>",
  "task_type": "email|call|meeting|document|todo",
  "priority": "high|medium|low",
  "suggested_due_days": <1-7>
}}

Return only valid JSON array, no explanation."""

    try:
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = msg.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        suggestions = _json.loads(raw.strip())
        if not isinstance(suggestions, list):
            suggestions = []
    except Exception as e:
        logger.warning("scan_and_notify_user: Claude failed for %s: %s", user_id, e)
        return 0

    for s in suggestions:
        days = s.pop("suggested_due_days", 2)
        try:
            due = datetime.now(timezone.utc) + timedelta(days=int(days))
            s["suggested_due_date"] = due.strftime("%Y-%m-%d")
        except Exception:
            s["suggested_due_date"] = (datetime.now(timezone.utc) + timedelta(days=2)).strftime("%Y-%m-%d")
        if "title" in s and "suggested_action" not in s:
            s["suggested_action"] = s["title"]

    if not suggestions:
        return 0

    batch_id = str(_uuid.uuid4())
    saved = 0
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        for s in suggestions:
            try:
                cur.execute(
                    """
                    INSERT INTO email_followup_suggestions
                        (message_id, from_name, from_email, subject, date,
                         reason, suggested_action, suggested_due_date, status, scan_batch_id,
                         task_type, title, priority, user_id)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'pending', %s::uuid, %s, %s, %s, %s::uuid)
                    ON CONFLICT DO NOTHING
                    """,
                    (
                        s.get("message_id"), s.get("from_name"), s.get("from_email"),
                        s.get("subject"), s.get("date"), s.get("reason"),
                        s.get("suggested_action"), s.get("suggested_due_date"), batch_id,
                        s.get("task_type", "email"),
                        s.get("title") or s.get("suggested_action"),
                        s.get("priority", "medium"),
                        user_id,
                    ),
                )
                saved += cur.rowcount
            except Exception as e:
                logger.warning("scan_and_notify_user: insert failed: %s", e)
        conn.commit()

        # Send notification only if we have new suggestions and haven't notified recently
        if saved > 0:
            cur.execute(
                """
                SELECT notification_id FROM task_notifications
                WHERE recipient_id = %s::uuid
                  AND notification_type = 'general'
                  AND title LIKE 'Email suggestions:%%'
                  AND created_at > now() - interval '20 hours'
                LIMIT 1
                """,
                (user_id,),
            )
            if cur.fetchone() is None:
                cur.execute(
                    """
                    INSERT INTO task_notifications
                        (recipient_id, notification_type, entity_type, title, message, status)
                    VALUES (%s::uuid, 'general', 'general', %s, %s, 'pending')
                    """,
                    (
                        user_id,
                        f"Email suggestions: {saved} new task{'s' if saved != 1 else ''} ready",
                        "Open Tasks and expand the Suggested section to review.",
                    ),
                )
                conn.commit()
                logger.info("scan_and_notify_user: notified %s with %d suggestions", user_id, saved)
    except Exception as e:
        logger.error("scan_and_notify_user: DB error for %s: %s", user_id, e)
        conn.rollback()
    finally:
        conn.close()

    return saved