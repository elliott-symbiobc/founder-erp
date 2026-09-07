"""
contacts_sync.py — Background tasks for the contacts module.

Tasks:
  - sync_gmail_contacts(user_id)          Pull Gmail threads for known contact emails
  - sync_calendar_contacts(user_id)       Pull Calendar events involving known contacts
  - enrich_contact(contact_id)            Apollo + Brand.dev + Claude profile enrichment
  - summarize_contact(contact_id)         Claude AI summary of interactions
"""

import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

import psycopg2
import psycopg2.extras

from app.tasks import comm_sync

logger = logging.getLogger(__name__)

DATABASE_URL = os.environ.get("DATABASE_URL", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")


def _conn():
    return psycopg2.connect(DATABASE_URL)


# ---------------------------------------------------------------------------
# Google token helpers
# ---------------------------------------------------------------------------

def _get_valid_token(user_id: str, conn) -> Optional[str]:
    """Return a valid access token for the user, refreshing if needed."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        "SELECT access_token, refresh_token, token_expiry FROM google_oauth_tokens WHERE user_id = %s",
        (user_id,),
    )
    row = cur.fetchone()
    if not row:
        return None

    # If token expires in < 5 minutes, refresh it
    expiry = row["token_expiry"]
    if expiry and expiry < datetime.now(timezone.utc) + timedelta(minutes=5):
        new_token = _refresh_google_token(row["refresh_token"], user_id, conn)
        return new_token

    return row["access_token"]


def _refresh_google_token(refresh_token: str, user_id: str, conn) -> Optional[str]:
    """Use refresh_token to get a new access_token and store it."""
    import httpx
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    if not client_id or not client_secret or not refresh_token:
        return None

    try:
        r = httpx.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
            timeout=15,
        )
        if r.status_code != 200:
            logger.error("Token refresh failed: %s", r.text)
            return None

        tokens = r.json()
        access_token = tokens["access_token"]
        expires_in = tokens.get("expires_in", 3600)
        expiry = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

        cur = conn.cursor()
        cur.execute(
            "UPDATE google_oauth_tokens SET access_token=%s, token_expiry=%s, updated_at=NOW() WHERE user_id=%s",
            (access_token, expiry, user_id),
        )
        conn.commit()
        return access_token
    except Exception as exc:
        logger.exception("Token refresh error for user %s", user_id)
        return None


# ---------------------------------------------------------------------------
# Gmail sync
# ---------------------------------------------------------------------------

def _parse_email_addresses(header_value: str) -> list[str]:
    """Extract all email addresses from a header like 'Name <a@b.com>, c@d.com'."""
    import re
    if not header_value:
        return []
    # Find all email addresses in angle brackets or bare
    addrs = re.findall(r'<([^>]+)>|(?:^|,)\s*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})', header_value)
    result = []
    for a, b in addrs:
        addr = (a or b).strip().lower()
        if addr:
            result.append(addr)
    return result


def sync_gmail_contacts(user_id: str) -> dict:
    """
    Pull Gmail messages where senders/recipients match known contact emails.

    Group email logic:
    - If contact is the SENDER: always record as a direct interaction.
    - If contact is a RECIPIENT among >3 total recipients: record as a group
      email (stored with is_group_email=True in metadata). Group emails do NOT
      update last_interaction_at and are shown differently in the UI.
    - If contact is a recipient in a small thread (≤3 recipients total): record
      as a direct interaction.
    """
    import httpx

    conn = _conn()
    try:
        access_token = _get_valid_token(user_id, conn)
        if not access_token:
            logger.info("No Google token for user %s — skipping Gmail sync", user_id)
            return {"status": "skipped", "reason": "no_token"}

        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT contact_id, email FROM contacts WHERE email IS NOT NULL AND archived = false")
        contacts_by_email = {row["email"].lower(): row["contact_id"] for row in cur.fetchall()}

        if not contacts_by_email:
            return {"status": "skipped", "reason": "no_contacts_with_email"}

        auth_headers = {"Authorization": f"Bearer {access_token}"}
        synced = 0
        contacts_updated = set()

        for email, contact_id in contacts_by_email.items():
            try:
                query = f"from:{email} OR to:{email}"
                resp = httpx.get(
                    "https://gmail.googleapis.com/gmail/v1/users/me/messages",
                    headers=auth_headers,
                    params={"q": query, "maxResults": 20},
                    timeout=15,
                )
                if resp.status_code != 200:
                    continue

                messages = resp.json().get("messages", [])
                for msg_ref in messages[:10]:
                    msg_id = msg_ref["id"]
                    cur.execute(
                        "SELECT 1 FROM contact_interactions WHERE contact_id=%s AND external_id=%s",
                        (contact_id, msg_id),
                    )
                    if cur.fetchone():
                        continue

                    # Fetch headers (To, CC needed for group detection)
                    msg_resp = httpx.get(
                        f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{msg_id}",
                        headers=auth_headers,
                        params={
                            "format": "metadata",
                            "metadataHeaders": ["Subject", "From", "To", "Cc",
                                                "Date", "Message-ID"],
                        },
                        timeout=15,
                    )
                    if msg_resp.status_code != 200:
                        continue

                    msg = msg_resp.json()
                    hdr_list = msg.get("payload", {}).get("headers", [])
                    hdr = {h["name"].lower(): h["value"] for h in hdr_list}

                    subject = hdr.get("subject", "(no subject)")
                    from_addr = hdr.get("from", "")
                    to_addr = hdr.get("to", "")
                    cc_addr = hdr.get("cc", "")
                    date_str = hdr.get("date", "")
                    snippet = msg.get("snippet", "")[:500]
                    # Per-mailbox Gmail ids make the same email look like two;
                    # this header is the same in every copy of it.
                    rfc_id = (hdr.get("message-id") or "").strip() or None

                    contact_is_sender = email.lower() in from_addr.lower()

                    # Count unique recipients (To + CC)
                    to_list = _parse_email_addresses(to_addr)
                    cc_list = _parse_email_addresses(cc_addr)
                    all_recipients = list(set(to_list + cc_list))
                    recipient_count = len(all_recipients)

                    # Group email: contact is NOT sender and there are >3 total recipients
                    is_group_email = (not contact_is_sender) and (recipient_count > 3)

                    direction = "inbound" if contact_is_sender else "outbound"
                    # Flip: if the contact sent it to us, it's inbound from our perspective
                    direction = "inbound" if contact_is_sender else "outbound"
                    interaction_type = "email_received" if contact_is_sender else "email_sent"

                    try:
                        from email.utils import parsedate_to_datetime
                        occurred_at = parsedate_to_datetime(date_str)
                    except Exception:
                        occurred_at = datetime.now(timezone.utc)

                    metadata = {
                        "is_group_email": is_group_email,
                        "recipient_count": recipient_count,
                        "from": from_addr,
                        "to": to_addr,
                        "cc": cc_addr,
                        "gmail_id": msg_id,
                    }

                    if rfc_id and _already_logged(cur, contact_id, rfc_id):
                        continue
                    cur.execute(
                        """
                        INSERT INTO contact_interactions
                            (contact_id, interaction_type, subject, content_preview,
                             external_id, occurred_at, direction, metadata,
                             rfc_message_id)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT DO NOTHING
                        """,
                        (
                            contact_id, interaction_type, subject, snippet,
                            msg_id, occurred_at, direction,
                            psycopg2.extras.Json(metadata), rfc_id,
                        ),
                    )
                    synced += 1
                    # Only mark as a real interaction if NOT a group email
                    if not is_group_email:
                        contacts_updated.add((contact_id, occurred_at))

            except Exception as exc:
                logger.warning("Gmail sync failed for contact %s: %s", contact_id, exc)
                continue

        # Update last_interaction_at only for direct (non-group) interactions
        if contacts_updated:
            cur.execute(
                """
                UPDATE contacts c
                SET last_interaction_at = (
                    SELECT MAX(ci.occurred_at)
                    FROM contact_interactions ci
                    WHERE ci.contact_id = c.contact_id
                      AND (ci.metadata->>'is_group_email' IS NULL
                           OR ci.metadata->>'is_group_email' = 'false')
                )
                WHERE c.contact_id IN (
                    SELECT DISTINCT contact_id FROM contact_interactions
                    WHERE metadata->>'is_group_email' = 'false'
                       OR metadata->>'is_group_email' IS NULL
                )
                """
            )
        # Fetch current historyId from Gmail profile and store it for incremental syncs
        try:
            profile_resp = httpx.get(
                "https://gmail.googleapis.com/gmail/v1/users/me/profile",
                headers=auth_headers, timeout=10,
            )
            if profile_resp.status_code == 200:
                history_id = profile_resp.json().get("historyId")
                if history_id:
                    cur.execute(
                        "UPDATE google_oauth_tokens SET gmail_history_id = %s, updated_at = NOW() WHERE user_id = %s",
                        (str(history_id), user_id),
                    )
        except Exception:
            cur.execute(
                "UPDATE google_oauth_tokens SET updated_at = NOW() WHERE user_id = %s",
                (user_id,),
            )
        conn.commit()

        logger.info("Gmail sync for user %s: %d new interactions", user_id, synced)
        return {"status": "success", "synced": synced}

    except Exception as exc:
        logger.exception("sync_gmail_contacts failed for user %s", user_id)
        return {"status": "error", "error": str(exc)}
    finally:
        conn.close()


def _already_logged(cur, contact_id, rfc_message_id) -> bool:
    """Is this email already on the contact's timeline, from another mailbox?

    external_id is a Gmail message id, which is issued per-mailbox: with two
    accounts connected, the same email arrives twice under two ids and the
    (contact_id, external_id) key cannot tell. The RFC822 Message-ID can.
    """
    cur.execute(
        "SELECT 1 FROM contact_interactions "
        "WHERE contact_id = %s AND rfc_message_id = %s LIMIT 1",
        (contact_id, rfc_message_id),
    )
    return cur.fetchone() is not None


def sync_gmail_incremental(user_id: str) -> dict:
    """
    Incremental Gmail sync using the History API.
    Only fetches messages added since the last full or incremental sync.
    Falls back to a full sync if no historyId is stored yet.
    """
    import httpx

    conn = _conn()
    try:
        access_token = _get_valid_token(user_id, conn)
        if not access_token:
            return {"status": "skipped", "reason": "no_token"}

        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT gmail_history_id FROM google_oauth_tokens WHERE user_id = %s",
            (user_id,),
        )
        row = cur.fetchone()
        history_id = row["gmail_history_id"] if row else None

        if not history_id:
            logger.info("No historyId stored for user %s — running full sync", user_id)
            return sync_gmail_contacts(user_id)

        # Load contact email → id map
        cur.execute("SELECT contact_id, email FROM contacts WHERE email IS NOT NULL AND archived = false")
        contacts_by_email = {r["email"].lower(): r["contact_id"] for r in cur.fetchall()}

        # Our own mail domains — used to tell inbound from outbound. A message
        # from a teammate is still us, not the investor.
        cur.execute(
            "SELECT DISTINCT lower(split_part(COALESCE(google_email, ''), '@', 2)) AS d "
            "FROM google_oauth_tokens WHERE google_email IS NOT NULL"
        )
        our_domains = {r["d"] for r in cur.fetchall() if r["d"]}
        if not our_domains:
            our_domains = {"example.com"}

        # NB: no early return on an empty contact map any more — investor
        # matching does not depend on contacts existing.

        auth_headers = {"Authorization": f"Bearer {access_token}"}

        # Fetch history since last sync
        new_message_ids: set[str] = set()
        page_token = None
        while True:
            params: dict = {
                "startHistoryId": history_id,
                "historyTypes": "messageAdded",
            }
            if page_token:
                params["pageToken"] = page_token
            resp = httpx.get(
                "https://gmail.googleapis.com/gmail/v1/users/me/history",
                headers=auth_headers, params=params, timeout=15,
            )
            if resp.status_code == 404:
                # historyId expired (>30 days) — fall back to full sync
                logger.info("historyId expired for user %s — running full sync", user_id)
                return sync_gmail_contacts(user_id)
            if resp.status_code != 200:
                return {"status": "error", "error": f"history API {resp.status_code}"}
            data = resp.json()
            for record in data.get("history", []):
                for added in record.get("messagesAdded", []):
                    new_message_ids.add(added["message"]["id"])
            page_token = data.get("nextPageToken")
            if not page_token:
                new_history_id = data.get("historyId", history_id)
                break

        if not new_message_ids:
            # No new messages — just update historyId
            cur.execute(
                "UPDATE google_oauth_tokens SET gmail_history_id = %s, updated_at = NOW() WHERE user_id = %s",
                (str(new_history_id), user_id),
            )
            conn.commit()
            return {"status": "success", "synced": 0}

        # Fetch metadata for each new message and process if it matches a contact
        synced = 0
        contacts_updated: set = set()

        for msg_id in new_message_ids:
            # Skip if already stored
            cur.execute(
                "SELECT 1 FROM contact_interactions WHERE external_id = %s LIMIT 1",
                (msg_id,),
            )
            if cur.fetchone():
                continue

            try:
                msg_resp = httpx.get(
                    f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{msg_id}",
                    headers=auth_headers,
                    params={"format": "metadata",
                            "metadataHeaders": ["Subject", "From", "To", "Cc", "Date", "Message-ID"]},
                    timeout=15,
                )
                if msg_resp.status_code != 200:
                    continue
                msg = msg_resp.json()
                hdr_list = msg.get("payload", {}).get("headers", [])
                hdr = {h["name"].lower(): h["value"] for h in hdr_list}

                from_addr = hdr.get("from", "")
                to_addr   = hdr.get("to", "")
                cc_addr   = hdr.get("cc", "")
                subject   = hdr.get("subject", "(no subject)")
                date_str  = hdr.get("date", "")
                snippet   = msg.get("snippet", "")[:500]
                rfc_id    = (hdr.get("message-id") or "").strip() or None

                # Find which contact(s) this message involves
                to_list = _parse_email_addresses(to_addr)
                cc_list = _parse_email_addresses(cc_addr)
                from_list = _parse_email_addresses(from_addr)
                all_recipients = list(set(to_list + cc_list))
                recipient_count = len(all_recipients)

                matched_contacts: list[tuple[str, bool]] = []  # (contact_id, is_sender)
                for email_addr, contact_id in contacts_by_email.items():
                    if any(email_addr in e for e in from_list):
                        matched_contacts.append((str(contact_id), True))
                    elif any(email_addr in e for e in all_recipients):
                        matched_contacts.append((str(contact_id), False))

                try:
                    from email.utils import parsedate_to_datetime
                    occurred_at = parsedate_to_datetime(date_str)
                except Exception:
                    occurred_at = datetime.now(timezone.utc)

                for contact_id, is_sender in matched_contacts:
                    is_group = (not is_sender) and (recipient_count > 3)
                    interaction_type = "email_received" if is_sender else "email_sent"
                    direction = "inbound" if is_sender else "outbound"
                    metadata = {
                        "is_group_email": is_group,
                        "recipient_count": recipient_count,
                        "from": from_addr, "to": to_addr, "cc": cc_addr,
                        "gmail_id": msg_id,
                    }
                    if rfc_id and _already_logged(cur, contact_id, rfc_id):
                        continue
                    cur.execute(
                        """
                        INSERT INTO contact_interactions
                            (contact_id, interaction_type, subject, content_preview,
                             external_id, occurred_at, direction, metadata,
                             rfc_message_id)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT DO NOTHING
                        """,
                        (contact_id, interaction_type, subject, snippet,
                         msg_id, occurred_at, direction,
                         psycopg2.extras.Json(metadata), rfc_id),
                    )
                    synced += 1
                    if not is_group:
                        contacts_updated.add((contact_id, occurred_at))

                # Same message, second matcher: pipeline entities match on their
                # own address list and on known threads, so investor mail lands
                # even when nobody involved is a contact.
                try:
                    moved = comm_sync.record_message(
                        cur,
                        msg_id=msg_id,
                        thread_id=msg.get("threadId"),
                        from_email=(from_list[0] if from_list else ""),
                        to_emails=all_recipients,
                        subject=subject,
                        snippet=snippet,
                        occurred_at=occurred_at,
                        user_id=user_id,
                        our_domains=our_domains,
                        rfc_message_id=hdr.get("message-id"),
                    )
                    for entity_type, entity_id, direction in moved:
                        if direction == "inbound":
                            comm_sync.apply_inbound(cur, entity_type, entity_id, occurred_at)
                        else:
                            comm_sync.apply_outbound(cur, entity_type, entity_id)
                except Exception as exc:
                    logger.warning("comm_sync failed for message %s: %s", msg_id, exc)

            except Exception as exc:
                logger.warning("incremental sync failed for message %s: %s", msg_id, exc)
                continue

        if contacts_updated:
            cur.execute(
                """
                UPDATE contacts c
                SET last_interaction_at = (
                    SELECT MAX(ci.occurred_at) FROM contact_interactions ci
                    WHERE ci.contact_id = c.contact_id
                      AND (ci.metadata->>'is_group_email' IS NULL
                           OR ci.metadata->>'is_group_email' = 'false')
                )
                WHERE c.contact_id = ANY(%s::uuid[])
                """,
                ([cid for cid, _ in contacts_updated],),
            )

        cur.execute(
            "UPDATE google_oauth_tokens SET gmail_history_id = %s, updated_at = NOW() WHERE user_id = %s",
            (str(new_history_id), user_id),
        )
        conn.commit()
        logger.info("Gmail incremental sync for user %s: %d new interactions", user_id, synced)
        return {"status": "success", "synced": synced}

    except Exception as exc:
        logger.exception("sync_gmail_incremental failed for user %s", user_id)
        return {"status": "error", "error": str(exc)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Calendar sync
# ---------------------------------------------------------------------------

def sync_calendar_contacts(user_id: str) -> dict:
    """Pull Google Calendar events that involve known contacts."""
    import httpx

    conn = _conn()
    try:
        access_token = _get_valid_token(user_id, conn)
        if not access_token:
            return {"status": "skipped", "reason": "no_token"}

        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT contact_id, email FROM contacts WHERE email IS NOT NULL AND archived = false")
        contacts_by_email = {row["email"].lower(): row["contact_id"] for row in cur.fetchall()}

        if not contacts_by_email:
            return {"status": "skipped", "reason": "no_contacts_with_email"}

        headers = {"Authorization": f"Bearer {access_token}"}

        # Fetch upcoming and recent events (30 days back, 14 forward)
        now = datetime.now(timezone.utc)
        time_min = (now - timedelta(days=30)).isoformat()
        time_max = (now + timedelta(days=14)).isoformat()

        resp = httpx.get(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            headers=headers,
            params={
                "timeMin": time_min,
                "timeMax": time_max,
                "maxResults": 100,
                "singleEvents": True,
                "orderBy": "startTime",
            },
            timeout=15,
        )
        if resp.status_code != 200:
            return {"status": "error", "reason": resp.text[:200]}

        events = resp.json().get("items", [])
        synced = 0

        for event in events:
            event_id = event.get("id", "")
            attendees = event.get("attendees", [])
            attendee_emails = {a.get("email", "").lower() for a in attendees}

            for email, contact_id in contacts_by_email.items():
                if email not in attendee_emails:
                    continue

                cur.execute(
                    "SELECT 1 FROM contact_interactions WHERE contact_id=%s AND external_id=%s",
                    (contact_id, event_id),
                )
                if cur.fetchone():
                    continue

                start = event.get("start", {}).get("dateTime") or event.get("start", {}).get("date")
                try:
                    occurred_at = datetime.fromisoformat(start.replace("Z", "+00:00"))
                except Exception:
                    occurred_at = datetime.now(timezone.utc)

                summary = event.get("summary", "Meeting")[:255]
                description = event.get("description", "")[:500]

                cur.execute(
                    """
                    INSERT INTO contact_interactions
                        (contact_id, interaction_type, subject, content_preview,
                         external_id, occurred_at)
                    VALUES (%s, 'meeting', %s, %s, %s, %s)
                    ON CONFLICT (contact_id, external_id) DO NOTHING
                    """,
                    (contact_id, summary, description, event_id, occurred_at),
                )
                synced += 1

        conn.commit()
        logger.info("Calendar sync for user %s: %d new interactions", user_id, synced)
        return {"status": "success", "synced": synced}

    except Exception as exc:
        logger.exception("sync_calendar_contacts failed for user %s", user_id)
        return {"status": "error", "error": str(exc)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# AI Summary
# ---------------------------------------------------------------------------

def summarize_contact(contact_id: str) -> dict:
    """Generate AI summary of a contact's profile and interactions using Claude."""
    import anthropic

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM contacts WHERE contact_id = %s", (contact_id,))
        contact = cur.fetchone()
        if not contact:
            return {"status": "error", "error": "contact not found"}

        # Fetch recent interactions
        cur.execute(
            """
            SELECT interaction_type, subject, content_preview, occurred_at, direction
            FROM contact_interactions
            WHERE contact_id = %s
            ORDER BY occurred_at DESC
            LIMIT 30
            """,
            (contact_id,),
        )
        interactions = [dict(r) for r in cur.fetchall()]

        # Fetch open reminders (action items)
        cur.execute(
            """
            SELECT title, reminder_type, due_date, description
            FROM contact_reminders
            WHERE contact_id = %s AND resolved = false
            ORDER BY due_date ASC NULLS LAST
            """,
            (contact_id,),
        )
        open_reminders = [dict(r) for r in cur.fetchall()]

        # Build context
        parts = []

        # Open action items go FIRST
        if open_reminders:
            items_text = "Open action items:\n"
            for r in open_reminders:
                due = f" (due {r['due_date']})" if r.get("due_date") else ""
                items_text += f"- {r['title']}{due}\n"
                if r.get("description"):
                    items_text += f"  {r['description']}\n"
            parts.append(items_text)

        # Contact profile
        profile = (
            f"Contact: {contact['name']}"
            + (f", {contact.get('title')}" if contact.get('title') else "")
            + (f" at {contact.get('organization')}" if contact.get('organization') else "")
            + f"\nEmail: {contact.get('email', 'unknown')}"
            + (f"\nSubject areas: {', '.join(contact.get('subject_areas') or [])}" if contact.get('subject_areas') else "")
            + (f"\nNotes: {contact['notes']}" if contact.get('notes') else "")
        )
        parts.append(profile)

        # Interactions
        if interactions:
            ix_lines = []
            for ix in interactions[:15]:
                d = ix["occurred_at"].strftime("%Y-%m-%d") if ix["occurred_at"] else "?"
                subj = (ix.get("subject") or "").strip()[:80]
                preview = (ix.get("content_preview") or "").strip()[:100]
                line = f"[{d}] {ix['interaction_type'].replace('_',' ')}"
                if subj:
                    line += f": {subj}"
                if preview and preview != subj:
                    line += f" — {preview}"
                ix_lines.append(line)
            parts.append("Recent interactions:\n" + "\n".join(ix_lines))

        context = "\n\n".join(parts)

        prompt = (
            f"Write a plain-text CRM summary for this contact. No headers, no markdown, no bullet points — "
            f"just 2-3 short paragraphs separated by blank lines.\n\n"
            f"Structure: If there are open action items, start with a sentence listing them specifically. "
            f"Then describe who this person is and what their relevance is to us. "
            f"Then describe the relationship history and current status.\n\n"
            f"Be direct and specific. Only mention things actually present in the data below. "
            f"Do not pad with generic phrases like 'it is recommended' or 'this contact represents'.\n\n"
            f"{context}"
        )

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        summary = message.content[0].text

        # Generate a short tagline (≤12 words) capturing who they are + key context
        tagline_msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=60,
            messages=[{"role": "user", "content": (
                f"Based on this CRM summary, write a single tagline of at most 12 words that captures "
                f"who this person is and the most important thing about our relationship. "
                f"No punctuation at the end. No quotes. Just the tagline.\n\n{summary}"
            )}],
        )
        tagline = tagline_msg.content[0].text.strip().strip('"').strip("'")

        cur.execute(
            "UPDATE contacts SET ai_summary = %s, tagline = %s, ai_summary_updated_at = NOW() WHERE contact_id = %s",
            (summary, tagline, contact_id),
        )
        conn.commit()
        logger.info("AI summary generated for contact %s", contact_id)
        return {"status": "success", "contact_id": contact_id}

    except Exception as exc:
        logger.exception("summarize_contact failed for %s", contact_id)
        return {"status": "error", "error": str(exc)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Web enrichment (Apollo person match + Brand.dev employer + Claude synthesis)
# ---------------------------------------------------------------------------
#
# Design rule, learned the hard way from the Semantic Scholar version this
# replaced: NEVER identify a person by name alone. "Pablo Sanchez" + employer
# resolves to a different real human on both S2 and Apollo — an IT technician in
# Colombia rather than the VP we meant. A confidently wrong profile is worse
# than an empty one, because it silently feeds the Claude synthesis below and
# comes back out as authoritative prose. Email is the only join key we trust.

_GW_BASE = "https://api.gooseworks.ai/v1"
_GENERIC_MAIL_DOMAINS = {
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
    "icloud.com", "me.com", "msn.com", "live.com", "comcast.net", "proton.me",
    "protonmail.com", "att.net", "verizon.net", "sbcglobal.net",
}


def _gw_key() -> str:
    """GooseWorks API key — credentials file first, env var as fallback."""
    import json as _json
    try:
        with open(os.path.expanduser("~/.gooseworks/credentials.json")) as f:
            return _json.load(f)["api_key"]
    except Exception:
        return os.environ.get("GOOSEWORKS_API_KEY", "")


def _contact_domain(email: Optional[str]) -> Optional[str]:
    """Employer domain from an email address. Consumer mailbox providers return
    None — 'gmail.com' is not an employer, and looking it up would attach
    Google's brand data to every freelancer in the CRM."""
    if not email or "@" not in email:
        return None
    domain = email.rsplit("@", 1)[-1].strip().lower()
    if not domain or "." not in domain:
        return None
    return None if domain in _GENERIC_MAIL_DOMAINS else domain


def _apollo_person(email: Optional[str], linkedin_url: Optional[str] = None) -> Optional[dict]:
    """Match one person in Apollo on a unique identifier — email, or failing
    that a LinkedIn profile URL. Both point at exactly one human; a name does
    not. Returns the raw person object or None."""
    import json as _json
    import urllib.request

    key = _gw_key()
    if not key:
        return None
    if email:
        query = {"email": email, "reveal_personal_emails": False}
    elif linkedin_url:
        query = {"linkedin_url": linkedin_url, "reveal_personal_emails": False}
    else:
        return None
    try:
        req = urllib.request.Request(
            f"{_GW_BASE}/proxy/apollo/people/match",
            data=_json.dumps(query).encode(),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=45) as resp:
            payload = _json.load(resp)
    except Exception as exc:
        logger.warning("Apollo match failed for %s: %s", email or linkedin_url, exc)
        return None

    person = (payload.get("data") or payload).get("person")
    if not person:
        return None

    # Apollo echoes the query back even on a miss. Require the match to actually
    # carry an identity before trusting it.
    if not (person.get("name") or person.get("linkedin_url")):
        return None
    return person


def _brand_for_domain(domain: str) -> Optional[dict]:
    """Employer brand data via the same Brand.dev proxy the company enrichment
    endpoint uses. Returns None on any failure — enrichment degrades, not fails."""
    import json as _json
    import urllib.request

    key = _gw_key()
    if not key or not domain:
        return None
    try:
        req = urllib.request.Request(
            f"{_GW_BASE}/proxy/orthogonal/run",
            data=_json.dumps({
                "api": "brand-dev",
                "path": "/v1/brand/retrieve",
                "query": {"domain": domain},
            }).encode(),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=45) as resp:
            payload = _json.load(resp)
    except Exception as exc:
        logger.warning("Brand.dev lookup failed for %s: %s", domain, exc)
        return None

    if (payload.get("status") or "").lower() == "error":
        return None
    return ((payload.get("data") or {}).get("brand")) or None


def _claude_json(prompt: str, max_tokens: int = 700) -> Optional[dict]:
    """One Claude call that must return a JSON object. Tolerates markdown
    fences. Returns None rather than raising — a failed synthesis should leave
    the verified facts intact, not lose them."""
    import json as _json
    import re as _re
    import anthropic

    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = msg.content[0].text.strip() if msg.content else ""
        fence = _re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
        if fence:
            raw = fence.group(1).strip()
        if not raw:
            return None
        parsed = _json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except Exception as exc:
        logger.warning("Claude synthesis failed: %s", exc)
        return None


def enrich_contact(contact_id: str) -> dict:
    """
    Enrich a contact from verified sources, then synthesize.

    1. Apollo people/match, keyed on email — title, LinkedIn, location, employer
    2. Brand.dev on the employer domain — what the company actually does
    3. Claude — synthesize relevance from the facts above, inventing nothing

    Blank contact columns get filled from step 1; existing values are never
    overwritten. Tags come only from the existing contact_tags vocabulary.
    """
    import json as _json

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM contacts WHERE contact_id = %s", (contact_id,))
        contact = cur.fetchone()
        if not contact:
            return {"status": "error", "error": "contact not found"}

        name = (contact["name"] or "").strip()
        email = (contact.get("email") or "").strip()
        linkedin = (contact.get("linkedin_url") or "").strip()
        org = (contact.get("organization") or "").strip()
        enrichment = dict(contact.get("enrichment_data") or {})

        # Drop artifacts of the Semantic Scholar era so re-enriching a contact
        # clears stale publication counts instead of leaving them orphaned.
        for dead in ("s2_author_id", "s2_paper_count", "s2_citation_count",
                     "recent_papers", "regulatory_pressures", "government_incentives"):
            enrichment.pop(dead, None)

        sources = []
        facts = {}          # verified, attributable — never invented by an LLM
        col_updates = {}    # blank contact columns we can safely fill

        # --- 1. Apollo person match (unique identifiers only) -----------------
        person = _apollo_person(email, linkedin) if (email or linkedin) else None
        if person:
            sources.append("apollo")
            p_org = person.get("organization") or {}
            facts.update({k: v for k, v in {
                "person_title": person.get("title"),
                "person_headline": person.get("headline"),
                "person_linkedin": person.get("linkedin_url"),
                "person_location": ", ".join(filter(None, [
                    person.get("city"), person.get("state"), person.get("country")])) or None,
                "employer_name": p_org.get("name"),
                "employer_industry": p_org.get("industry"),
                "employer_size": p_org.get("estimated_num_employees"),
                "employer_founded": p_org.get("founded_year"),
                "employer_website": p_org.get("website_url"),
                "employer_linkedin": p_org.get("linkedin_url"),
            }.items() if v})
            # Fill blanks on the record itself — never overwrite curated values.
            for col, val in (
                ("title", person.get("title")),
                ("linkedin_url", person.get("linkedin_url")),
                ("avatar_url", person.get("photo_url")),
                ("website_url", p_org.get("website_url")),
            ):
                if val and not str(contact.get(col) or "").strip():
                    col_updates[col] = val
        elif email or linkedin:
            logger.info("No Apollo match for %s <%s>", name, email or linkedin)

        # --- 2. Employer brand data ------------------------------------------
        domain = _contact_domain(email) or _contact_domain(facts.get("employer_website"))
        if not domain and facts.get("employer_website"):
            domain = (facts["employer_website"] or "").replace("https://", "").replace(
                "http://", "").replace("www.", "").split("/")[0].lower() or None
        brand = _brand_for_domain(domain) if domain else None
        if brand:
            sources.append("brand_dev")
            eic = (brand.get("industries") or {}).get("eic") or []
            brand_industry = None
            if eic:
                brand_industry = eic[0].get("subindustry") or eic[0].get("industry")
            facts.update({k: v for k, v in {
                "employer_domain": domain,
                "employer_description": brand.get("description"),
                "employer_industry_classified": brand_industry,
            }.items() if v})
            enrichment["brand_dev"] = brand

        # --- 3. Claude synthesis over verified facts only ---------------------
        if facts:
            facts_text = "\n".join(f"  {k}: {v}" for k, v in facts.items())
            prompt = (
                "You are enriching a CRM record.\n\n"
                "VERIFIED FACTS about this contact, retrieved from Apollo and Brand.dev:\n"
                f"  name: {name}\n"
                f"  organization on file: {org or 'unknown'}\n"
                f"{facts_text}\n\n"
                "Write a JSON object with exactly these fields:\n"
                '{"professional_background": "2-3 sentences on this person\'s role and remit",\n'
                ' "key_expertise": ["3-5 areas"],\n'
                ' "industry_focus": "primary sector",\n'
                ' "company_focus": "1-2 sentences on what their employer does",\n'
                ' "relevance_to_business": "why this contact matters to the company specifically",\n'
                ' "partnership_potential": "1-2 concrete sentences on how Open ERP could work with them",\n'
                ' "suggested_tags": ["up to 5 short tags"]}\n\n'
                "RULES:\n"
                "- Ground every claim in the verified facts above. Do not invent job history, "
                "credentials, publications, or company details that are not stated.\n"
                "- If the facts are too thin to support a field, use null. A null is correct; "
                "a plausible guess is not.\n"
                "- Do not speculate about regulations or grant programs.\n"
                "Return only valid JSON, no markdown fences."
            )
            synth = _claude_json(prompt)
            if synth:
                sources.append("claude")
                for k in ("professional_background", "key_expertise", "industry_focus",
                          "company_focus", "relevance_to_business", "partnership_potential",
                          "suggested_tags"):
                    if synth.get(k) is not None:
                        enrichment[k] = synth[k]
        else:
            logger.info("No verified data for contact %s — skipping synthesis", contact_id)

        # --- 4. Tags from the existing vocabulary only ------------------------
        cur.execute("SELECT name FROM contact_tags")
        vocab = {r["name"].lower(): r["name"] for r in cur.fetchall()}
        current = {t.lower() for t in (contact.get("tags") or [])}
        added_tags = []
        for suggested in (enrichment.get("suggested_tags") or [])[:5]:
            canon = vocab.get(str(suggested).strip().lower())
            if canon and canon.lower() not in current:
                added_tags.append(canon)
                current.add(canon.lower())
        if added_tags:
            col_updates["tags"] = list(contact.get("tags") or []) + added_tags

        # --- 5. Persist -------------------------------------------------------
        enrichment["verified_facts"] = facts
        enrichment["enrichment_sources"] = sources
        enrichment["enrichment_confidence"] = (
            "verified" if person else "partial" if brand else "none"
        )
        if not (email or linkedin):
            enrichment["enrichment_note"] = (
                "No email or LinkedIn URL on file — person-level lookup needs a "
                "unique identifier. Add either one to enable it."
            )

        sets = ["enrichment_data = %s", "last_enriched_at = NOW()", "updated_at = NOW()"]
        params = [psycopg2.extras.Json(enrichment)]
        for col, val in col_updates.items():
            sets.insert(0, f"{col} = %s")
            params.insert(0, val)
        params.append(contact_id)
        cur.execute(f"UPDATE contacts SET {', '.join(sets)} WHERE contact_id = %s", params)
        conn.commit()

        logger.info(
            "Enriched contact %s (%s) — sources=%s filled=%s",
            contact_id, name, ",".join(sources) or "none", ",".join(col_updates) or "none",
        )
        return {
            "status": "success",
            "contact_id": contact_id,
            "sources": sources,
            "confidence": enrichment["enrichment_confidence"],
            "filled": list(col_updates),
            "enrichment": enrichment,
        }

    except Exception as exc:
        logger.exception("enrich_contact failed for %s", contact_id)
        return {"status": "error", "error": str(exc)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Relationship inference from email co-occurrence
# ---------------------------------------------------------------------------

def infer_relationships_from_emails() -> dict:
    """
    Analyse email interaction metadata to infer relationships between contacts.

    Scoring per shared email:
      - Sender → direct recipient (small thread ≤3 recipients): +4
      - Sender → recipient on group email (>3 recipients):       +1
      - Co-recipients on small thread:                           +2
      - Co-recipients on group email:                            +0.5

    A pair needs a raw score ≥ 3 to create/update a relationship.
    Strength 1-5 is derived from score (capped at 5).

    relationship_type is set to 'inferred_email' so the graph can
    distinguish inferred edges from manually curated ones.
    """
    import re

    def _emails_from(val: str) -> list[str]:
        if not val:
            return []
        found = re.findall(r'<([^>]+)>|(?:^|,)\s*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})', val)
        return list({(a or b).strip().lower() for a, b in found if (a or b).strip()})

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        # Build email → contact_id lookup
        cur.execute("SELECT contact_id, email FROM contacts WHERE email IS NOT NULL AND archived = false")
        email_to_id = {row["email"].lower(): str(row["contact_id"]) for row in cur.fetchall()}

        if len(email_to_id) < 2:
            return {"status": "skipped", "reason": "fewer than 2 contacts with email"}

        # Fetch all email interactions that have metadata
        cur.execute(
            """
            SELECT contact_id, interaction_type, occurred_at, metadata
            FROM contact_interactions
            WHERE interaction_type IN ('email_sent', 'email_received')
              AND metadata IS NOT NULL
              AND metadata != '{}'::jsonb
            """
        )
        interactions = cur.fetchall()

        # co_scores[frozenset({id_a, id_b})] = float score
        from collections import defaultdict
        co_scores: dict[frozenset, float] = defaultdict(float)

        for ix in interactions:
            meta = ix["metadata"] or {}
            from_val = meta.get("from", "")
            to_val   = meta.get("to", "")
            cc_val   = meta.get("cc", "")
            is_group = meta.get("is_group_email", False)
            recip_count = meta.get("recipient_count", 1)

            # Resolve all participants in this email to contact IDs
            sender_emails = _emails_from(from_val)
            recip_emails  = _emails_from(to_val) + _emails_from(cc_val)

            sender_ids  = {email_to_id[e] for e in sender_emails if e in email_to_id}
            recip_ids   = {email_to_id[e] for e in recip_emails  if e in email_to_id}
            all_ids = sender_ids | recip_ids

            if len(all_ids) < 2:
                continue

            # Score sender→recipient pairs
            for sid in sender_ids:
                for rid in recip_ids:
                    if sid == rid:
                        continue
                    pair = frozenset({sid, rid})
                    co_scores[pair] += 1.0 if is_group else 4.0

            # Score co-recipient pairs (recipient↔recipient)
            recip_list = list(recip_ids)
            for i in range(len(recip_list)):
                for j in range(i + 1, len(recip_list)):
                    pair = frozenset({recip_list[i], recip_list[j]})
                    co_scores[pair] += 0.5 if is_group else 2.0

        # Upsert relationships for pairs above threshold
        THRESHOLD = 3.0
        created = updated = skipped = 0

        for pair, score in co_scores.items():
            if score < THRESHOLD:
                skipped += 1
                continue

            ids = list(pair)
            id_a, id_b = sorted(ids)  # canonical order
            strength = min(5, max(1, round(score / 4)))

            cur.execute(
                """
                INSERT INTO contact_relationships
                    (contact_a_id, contact_b_id, relationship_type, description, strength)
                VALUES (%s, %s, 'inferred_email', %s, %s)
                ON CONFLICT (contact_a_id, contact_b_id, relationship_type) DO UPDATE
                    SET strength    = EXCLUDED.strength,
                        description = EXCLUDED.description
                RETURNING (xmax = 0) AS inserted
                """,
                (
                    id_a, id_b,
                    f"Inferred from {round(score)} email co-occurrence points",
                    strength,
                ),
            )
            row = cur.fetchone()
            if row and row["inserted"]:
                created += 1
            else:
                updated += 1

        conn.commit()
        logger.info(
            "infer_relationships_from_emails: %d created, %d updated, %d below threshold",
            created, updated, skipped,
        )
        return {"status": "success", "created": created, "updated": updated, "skipped": skipped}

    except Exception as exc:
        logger.exception("infer_relationships_from_emails failed")
        return {"status": "error", "error": str(exc)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Refresh stale AI summaries (daily)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Google Contacts bidirectional sync
# ---------------------------------------------------------------------------

def _google_person_to_dict(person: dict) -> dict:
    """Extract relevant fields from a Google People API person resource."""
    names = person.get("names", [])
    emails = person.get("emailAddresses", [])
    phones = person.get("phoneNumbers", [])
    orgs = person.get("organizations", [])

    update_time = None
    for src in person.get("metadata", {}).get("sources", []):
        ut = src.get("updateTime")
        if ut:
            update_time = ut
            break

    return {
        "name": (names[0].get("displayName") or names[0].get("unstructuredName")) if names else None,
        "email": emails[0]["value"].strip().lower() if emails else None,
        "phone": phones[0]["value"] if phones else None,
        "organization": orgs[0].get("name") if orgs else None,
        "title": orgs[0].get("title") if orgs else None,
        "resource_name": person.get("resourceName"),
        "etag": person.get("etag"),
        "google_update_time": update_time,
    }


def _contact_to_google_person(contact: dict) -> dict:
    """Convert a platform contact record to a Google People API person body."""
    person: dict = {}
    if contact.get("name"):
        person["names"] = [{"unstructuredName": contact["name"]}]
    if contact.get("email"):
        person["emailAddresses"] = [{"value": contact["email"]}]
    if contact.get("phone"):
        person["phoneNumbers"] = [{"value": contact["phone"]}]
    org: dict = {}
    if contact.get("organization"):
        org["name"] = contact["organization"]
    if contact.get("title"):
        org["title"] = contact["title"]
    if org:
        person["organizations"] = [org]
    return person


def sync_google_contacts_inbound(user_id: str) -> dict:
    """
    Pull all contacts from Google People API and sync into the platform.

    For each Google contact:
      - If a matching platform contact exists (by resource name mapping or email):
          compare updated_at timestamps; if Google is newer, update the platform record.
      - If no match exists:
          create a pending_contact record for human review.

    Uses a syncToken for incremental syncs after the first full pass.
    """
    import httpx

    conn = _conn()
    try:
        access_token = _get_valid_token(user_id, conn)
        if not access_token:
            return {"status": "skipped", "reason": "no_token"}

        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT google_contacts_sync_token FROM google_oauth_tokens WHERE user_id = %s",
            (user_id,),
        )
        row = cur.fetchone()
        sync_token = row["google_contacts_sync_token"] if row else None

        headers = {"Authorization": f"Bearer {access_token}"}
        person_fields = "names,emailAddresses,phoneNumbers,organizations,metadata"

        all_persons: list[dict] = []
        new_sync_token = None
        page_token = None
        full_retry = False

        while True:
            params: dict = {"personFields": person_fields, "pageSize": 200}
            if sync_token and not full_retry:
                params["syncToken"] = sync_token
            if page_token:
                params["pageToken"] = page_token

            resp = httpx.get(
                "https://people.googleapis.com/v1/people/me/connections",
                headers=headers, params=params, timeout=20,
            )

            if resp.status_code == 410:
                # syncToken expired — fall back to full sync
                sync_token = None
                full_retry = True
                page_token = None
                all_persons = []
                continue
            if resp.status_code != 200:
                return {"status": "error", "error": f"People API {resp.status_code}: {resp.text[:200]}"}

            data = resp.json()
            all_persons.extend(data.get("connections", []))
            new_sync_token = data.get("nextSyncToken", new_sync_token)
            page_token = data.get("nextPageToken")
            if not page_token:
                break

        # Load platform contacts for matching
        cur.execute(
            "SELECT contact_id, email, updated_at FROM contacts WHERE archived = false"
        )
        contacts_by_email: dict[str, dict] = {
            r["email"].lower(): {"id": r["contact_id"], "updated_at": r["updated_at"]}
            for r in cur.fetchall() if r["email"]
        }

        cur.execute(
            "SELECT contact_id, google_resource_name FROM contact_google_mappings WHERE user_id = %s",
            (user_id,),
        )
        contacts_by_resource: dict[str, str] = {
            r["google_resource_name"]: str(r["contact_id"]) for r in cur.fetchall()
        }

        updated = 0
        queued_pending = 0

        for person in all_persons:
            if person.get("metadata", {}).get("deleted"):
                continue

            gd = _google_person_to_dict(person)
            if not gd["name"] and not gd["email"]:
                continue

            # Resolve matching platform contact
            contact_id = None
            if gd["resource_name"]:
                contact_id = contacts_by_resource.get(gd["resource_name"])
            if not contact_id and gd["email"]:
                match = contacts_by_email.get(gd["email"])
                if match:
                    contact_id = str(match["id"])

            if contact_id:
                # Conflict resolution: most recently modified wins
                cur.execute(
                    "SELECT updated_at FROM contacts WHERE contact_id = %s",
                    (contact_id,),
                )
                c = cur.fetchone()
                platform_updated_at = c["updated_at"] if c else None

                google_is_newer = False
                if gd["google_update_time"] and platform_updated_at:
                    try:
                        g_dt = datetime.fromisoformat(gd["google_update_time"].replace("Z", "+00:00"))
                        p_dt = platform_updated_at if platform_updated_at.tzinfo else platform_updated_at.replace(tzinfo=timezone.utc)
                        google_is_newer = g_dt > p_dt
                    except Exception:
                        pass
                elif gd["google_update_time"] and not platform_updated_at:
                    google_is_newer = True

                if google_is_newer:
                    cols = {k: gd[k] for k in ("name", "email", "phone", "organization", "title") if gd.get(k)}
                    if cols:
                        set_clause = ", ".join(f"{k} = %s" for k in cols)
                        cur.execute(
                            f"UPDATE contacts SET {set_clause}, updated_at = NOW() WHERE contact_id = %s",
                            list(cols.values()) + [contact_id],
                        )
                        updated += 1

                # Upsert the resource name mapping
                if gd["resource_name"]:
                    cur.execute(
                        """
                        INSERT INTO contact_google_mappings
                            (contact_id, user_id, google_resource_name, google_etag, synced_at)
                        VALUES (%s, %s, %s, %s, NOW())
                        ON CONFLICT (contact_id, user_id) DO UPDATE
                            SET google_resource_name = EXCLUDED.google_resource_name,
                                google_etag           = EXCLUDED.google_etag,
                                synced_at             = NOW()
                        """,
                        (contact_id, user_id, gd["resource_name"], gd["etag"]),
                    )

            else:
                # Unknown — queue as pending (deduplicated by partial unique indexes)
                try:
                    cur.execute(
                        """
                        INSERT INTO pending_contacts
                            (source, name, email, phone, organization, title,
                             google_resource_name, google_etag, raw_data)
                        VALUES ('google_contacts', %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT DO NOTHING
                        """,
                        (
                            gd["name"], gd["email"], gd["phone"],
                            gd["organization"], gd["title"],
                            gd["resource_name"], gd["etag"],
                            psycopg2.extras.Json(person),
                        ),
                    )
                    if cur.rowcount:
                        queued_pending += 1
                except Exception:
                    pass

        if new_sync_token:
            cur.execute(
                "UPDATE google_oauth_tokens SET google_contacts_sync_token = %s, updated_at = NOW() WHERE user_id = %s",
                (new_sync_token, user_id),
            )

        conn.commit()
        logger.info(
            "Google Contacts inbound sync for user %s: %d updated, %d queued pending",
            user_id, updated, queued_pending,
        )
        return {"status": "success", "updated": updated, "queued_pending": queued_pending}

    except Exception as exc:
        logger.exception("sync_google_contacts_inbound failed for user %s", user_id)
        return {"status": "error", "error": str(exc)}
    finally:
        conn.close()


def push_contact_to_google(contact_id: str) -> dict:
    """
    Push a platform contact to Google Contacts for all users with connected accounts.
    Creates the contact if no mapping exists for a user; updates if one does.
    """
    import httpx

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT * FROM contacts WHERE contact_id = %s AND archived = false",
            (contact_id,),
        )
        contact = cur.fetchone()
        if not contact:
            return {"status": "skipped", "reason": "not found or archived"}

        person_body = _contact_to_google_person(dict(contact))
        if not person_body:
            return {"status": "skipped", "reason": "no pushable fields"}

        cur.execute("SELECT user_id FROM google_oauth_tokens")
        users = [str(r["user_id"]) for r in cur.fetchall()]

        pushed = 0
        errors = 0

        for uid in users:
            access_token = _get_valid_token(uid, conn)
            if not access_token:
                continue

            headers = {"Authorization": f"Bearer {access_token}"}

            cur.execute(
                "SELECT google_resource_name, google_etag FROM contact_google_mappings WHERE contact_id = %s AND user_id = %s",
                (contact_id, uid),
            )
            mapping = cur.fetchone()

            try:
                if mapping:
                    body = dict(person_body)
                    body["etag"] = mapping["google_etag"]
                    resp = httpx.patch(
                        f"https://people.googleapis.com/v1/{mapping['google_resource_name']}:updateContact",
                        headers=headers,
                        params={"updatePersonFields": "names,emailAddresses,phoneNumbers,organizations"},
                        json=body,
                        timeout=15,
                    )
                    if resp.status_code == 200:
                        result = resp.json()
                        cur.execute(
                            "UPDATE contact_google_mappings SET google_etag = %s, synced_at = NOW() WHERE contact_id = %s AND user_id = %s",
                            (result.get("etag"), contact_id, uid),
                        )
                        pushed += 1
                    elif resp.status_code == 404:
                        # Stale mapping — delete and fall through to create
                        cur.execute(
                            "DELETE FROM contact_google_mappings WHERE contact_id = %s AND user_id = %s",
                            (contact_id, uid),
                        )
                        mapping = None
                    else:
                        logger.warning("Google PATCH failed for contact %s user %s: %s", contact_id, uid, resp.text[:200])
                        errors += 1

                if not mapping:
                    resp = httpx.post(
                        "https://people.googleapis.com/v1/people:createContact",
                        headers=headers,
                        json=person_body,
                        timeout=15,
                    )
                    if resp.status_code == 200:
                        result = resp.json()
                        cur.execute(
                            """
                            INSERT INTO contact_google_mappings
                                (contact_id, user_id, google_resource_name, google_etag, synced_at)
                            VALUES (%s, %s, %s, %s, NOW())
                            ON CONFLICT (contact_id, user_id) DO UPDATE
                                SET google_resource_name = EXCLUDED.google_resource_name,
                                    google_etag           = EXCLUDED.google_etag,
                                    synced_at             = NOW()
                            """,
                            (contact_id, uid, result.get("resourceName"), result.get("etag")),
                        )
                        pushed += 1
                    else:
                        logger.warning("Google POST failed for contact %s user %s: %s", contact_id, uid, resp.text[:200])
                        errors += 1

            except Exception as exc:
                logger.warning("push_contact_to_google error for user %s: %s", uid, exc)
                errors += 1

        conn.commit()
        logger.info("push_contact_to_google for %s: %d pushed, %d errors", contact_id, pushed, errors)
        return {"status": "success", "pushed": pushed, "errors": errors}

    except Exception as exc:
        logger.exception("push_contact_to_google failed for %s", contact_id)
        return {"status": "error", "error": str(exc)}
    finally:
        conn.close()


def refresh_stale_summaries() -> dict:
    """Refresh AI summaries for contacts where summary is > 7 days old."""
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            """
            SELECT contact_id FROM contacts
            WHERE archived = false
              AND (ai_summary_updated_at IS NULL OR ai_summary_updated_at < NOW() - INTERVAL '7 days')
              AND (
                  EXISTS (SELECT 1 FROM contact_interactions ci WHERE ci.contact_id = contacts.contact_id)
              )
            LIMIT 20
            """
        )
        stale = [r["contact_id"] for r in cur.fetchall()]
        refreshed = 0
        for contact_id in stale:
            result = summarize_contact(contact_id)
            if result.get("status") == "success":
                refreshed += 1
        logger.info("refresh_stale_summaries: %d summaries refreshed", refreshed)
        return {"status": "success", "refreshed": refreshed}
    except Exception as exc:
        logger.exception("refresh_stale_summaries failed")
        return {"status": "error", "error": str(exc)}
    finally:
        conn.close()


def backfill_entity_gmail(entity_type: str, entity_id: str, per_address: int = 25) -> dict:
    """Pull historical Gmail for an entity's already-linked addresses and record
    it onto the entity.

    The 5-minute incremental sync only sees NEW mail (Gmail historyId) and skips
    anything already stored in contact_interactions, so a freshly-linked deal
    never picks up past correspondence on its own. This one-off pass queries
    Gmail directly for each linked address and feeds every hit through the same
    pipeline matcher (comm_sync.record_message), which is idempotent.
    """
    import httpx
    from datetime import datetime, timezone
    from email.utils import parsedate_to_datetime
    from app.tasks import comm_sync

    conn = _conn()
    recorded = 0
    scanned = 0
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT DISTINCT lower(email) AS email FROM comm_addresses "
            "WHERE entity_type = %s AND entity_id = %s AND email IS NOT NULL",
            (entity_type, str(entity_id)),
        )
        emails = [r["email"] for r in cur.fetchall() if r["email"]]
        if not emails:
            return {"status": "skipped", "reason": "no_addresses", "recorded": 0}

        cur.execute(
            "SELECT DISTINCT lower(split_part(COALESCE(google_email, ''), '@', 2)) AS d "
            "FROM google_oauth_tokens WHERE google_email IS NOT NULL"
        )
        our_domains = {r["d"] for r in cur.fetchall() if r["d"]} or {"example.com"}

        cur.execute("SELECT user_id::text AS uid FROM google_oauth_tokens")
        uids = [r["uid"] for r in cur.fetchall()]

        for uid in uids:
            token = _get_valid_token(uid, conn)
            if not token:
                continue
            headers = {"Authorization": f"Bearer {token}"}
            seen_ids: set = set()
            for email in emails:
                try:
                    resp = httpx.get(
                        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
                        headers=headers,
                        params={"q": f"from:{email} OR to:{email}", "maxResults": per_address},
                        timeout=20,
                    )
                    if resp.status_code != 200:
                        continue
                    for ref in resp.json().get("messages", []):
                        mid = ref["id"]
                        if mid in seen_ids:
                            continue
                        seen_ids.add(mid)
                        scanned += 1
                        mr = httpx.get(
                            f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{mid}",
                            headers=headers,
                            params={"format": "metadata",
                                    "metadataHeaders": ["Subject", "From", "To", "Cc", "Date", "Message-ID"]},
                            timeout=20,
                        )
                        if mr.status_code != 200:
                            continue
                        m = mr.json()
                        hdr = {h["name"].lower(): h["value"]
                               for h in m.get("payload", {}).get("headers", [])}
                        from_list = _parse_email_addresses(hdr.get("from", ""))
                        all_recipients = list(set(
                            _parse_email_addresses(hdr.get("to", "")) +
                            _parse_email_addresses(hdr.get("cc", ""))
                        ))
                        try:
                            occurred_at = parsedate_to_datetime(hdr.get("date", ""))
                        except Exception:
                            occurred_at = datetime.now(timezone.utc)
                        moved = comm_sync.record_message(
                            cur,
                            msg_id=mid,
                            thread_id=m.get("threadId"),
                            from_email=(from_list[0] if from_list else ""),
                            to_emails=all_recipients,
                            subject=hdr.get("subject", "(no subject)"),
                            snippet=m.get("snippet", "")[:500],
                            occurred_at=occurred_at,
                            user_id=uid,
                            our_domains=our_domains,
                            rfc_message_id=hdr.get("message-id"),
                        )
                        recorded += len(moved)
                except Exception:
                    logger.exception("backfill: gmail error for %s / %s", uid, email)
                    continue
        conn.commit()
        return {"status": "success", "recorded": recorded, "scanned": scanned,
                "addresses": len(emails), "mailboxes": len(uids)}
    finally:
        conn.close()
