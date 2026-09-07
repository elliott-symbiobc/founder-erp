"""Pull Google Calendar events onto the Activity feed.

Runs over a wide window on demand (backfill) and a narrow one on a schedule.
Matching is by attendee address against comm_addresses, so a meeting only lands
on an investor we already know an address for.
"""
import logging
import os
from datetime import datetime, timedelta, timezone

import httpx
import psycopg2
import psycopg2.extras

from app.tasks import comm_sync
from app.tasks.contacts_sync import _conn, _get_valid_token

logger = logging.getLogger(__name__)

CAL_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"


def sync_calendar_comms(user_id: str, days_back: int = 30, days_forward: int = 14) -> dict:
    conn = _conn()
    try:
        token = _get_valid_token(user_id, conn)
        if not token:
            return {"status": "skipped", "reason": "no_token"}

        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT DISTINCT lower(split_part(COALESCE(google_email, ''), '@', 2)) AS d "
            "FROM google_oauth_tokens WHERE google_email IS NOT NULL"
        )
        our_domains = {r["d"] for r in cur.fetchall() if r["d"]} or {"example.com"}

        now = datetime.now(timezone.utc)
        params = {
            "timeMin": (now - timedelta(days=days_back)).isoformat(),
            "timeMax": (now + timedelta(days=days_forward)).isoformat(),
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": 250,
        }

        recorded = 0
        page_token = None
        while True:
            if page_token:
                params["pageToken"] = page_token
            r = httpx.get(CAL_URL, headers={"Authorization": f"Bearer {token}"},
                          params=params, timeout=30)
            if r.status_code != 200:
                logger.warning("calendar fetch failed for %s: %s", user_id, r.text[:200])
                break
            payload = r.json()

            for ev in payload.get("items", []):
                if ev.get("status") == "cancelled":
                    continue
                attendees = [a.get("email") for a in ev.get("attendees", []) if a.get("email")]
                organizer = (ev.get("organizer") or {}).get("email")
                if organizer:
                    attendees.append(organizer)
                if not attendees:
                    continue

                start = (ev.get("start") or {}).get("dateTime") or (ev.get("start") or {}).get("date")
                end = (ev.get("end") or {}).get("dateTime") or (ev.get("end") or {}).get("date")
                if not start:
                    continue

                hits = comm_sync.record_meeting(
                    cur,
                    event_id=ev.get("id"),
                    summary=ev.get("summary"),
                    description=ev.get("description"),
                    attendees=attendees,
                    starts_at=start,
                    ends_at=end,
                    event_link=ev.get("htmlLink"),
                    user_id=user_id,
                    our_domains=our_domains,
                )
                recorded += len(hits)

            page_token = payload.get("nextPageToken")
            if not page_token:
                break

        conn.commit()
        return {"status": "success", "recorded": recorded}
    except Exception as exc:
        conn.rollback()
        logger.exception("sync_calendar_comms failed for %s", user_id)
        return {"status": "error", "error": str(exc)}
    finally:
        conn.close()
