"""
worker_ops.py — Celery tasks for contacts, comms and finance.

Gmail and Calendar sync, contact enrichment and relationship inference, Google
Contacts push and pull, scheduled email and marketing sends, Plaid and QBO
actuals, daily and weekly planning, Granola note ingestion.

Split from worker.py. Task names are unchanged: each decorator carries an
explicit name="app.worker.<x>".
"""
import logging
import os
import subprocess
from datetime import timedelta

import psycopg2

from app.worker import celery_app, _get_conn, _log_anthropic_usage

logger = logging.getLogger(__name__)


@celery_app.task(name="app.worker.sync_gmail_contacts_task", bind=True, max_retries=1)
def sync_gmail_contacts_task(self, user_id: str):
    """Sync Gmail interactions for a single user's contacts."""
    from app.tasks.contacts_sync import sync_gmail_contacts
    return sync_gmail_contacts(user_id)


@celery_app.task(name="app.worker.sync_calendar_contacts_task", bind=True, max_retries=1)
def sync_calendar_contacts_task(self, user_id: str):
    """Sync Google Calendar interactions for a single user's contacts."""
    from app.tasks.contacts_sync import sync_calendar_contacts
    return sync_calendar_contacts(user_id)


@celery_app.task(name="app.worker.sync_gmail_contacts_all_users", bind=True)
def sync_gmail_contacts_all_users(self):
    """Hourly: sync Gmail for every user with a connected Google account."""
    conn = _get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT user_id FROM google_oauth_tokens")
        users = [r[0] for r in cur.fetchall()]
    finally:
        conn.close()
    for uid in users:
        sync_gmail_contacts_task.delay(str(uid))
    return {"status": "queued", "users": len(users)}


@celery_app.task(name="app.worker.sync_gmail_incremental_task", bind=True, max_retries=1)
def sync_gmail_incremental_task(self, user_id: str):
    """Incremental Gmail sync for a single user using the History API."""
    from app.tasks.contacts_sync import sync_gmail_incremental
    return sync_gmail_incremental(user_id)


@celery_app.task(name="app.worker.sync_gmail_incremental_all_users", bind=True)
def sync_gmail_incremental_all_users(self):
    """Incremental Gmail sync for every user with a connected Google account."""
    conn = _get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT user_id FROM google_oauth_tokens")
        users = [r[0] for r in cur.fetchall()]
    finally:
        conn.close()
    for uid in users:
        sync_gmail_incremental_task.delay(str(uid))
    return {"status": "queued", "users": len(users)}


@celery_app.task(name="app.worker.sync_calendar_contacts_all_users", bind=True)
def sync_calendar_contacts_all_users(self):
    """Hourly: sync Calendar for every user with a connected Google account."""
    conn = _get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT user_id FROM google_oauth_tokens")
        users = [r[0] for r in cur.fetchall()]
    finally:
        conn.close()
    for uid in users:
        sync_calendar_contacts_task.delay(str(uid))
    return {"status": "queued", "users": len(users)}


@celery_app.task(name="app.worker.refresh_contact_summaries_task", bind=True)
def refresh_contact_summaries_task(self):
    """Nightly: refresh stale AI summaries for contacts with interactions."""
    from app.tasks.contacts_sync import refresh_stale_summaries
    return refresh_stale_summaries()


@celery_app.task(name="app.worker.enrich_contact_task", bind=True, max_retries=1)
def enrich_contact_task(self, contact_id: str):
    """Enrich a contact record with Semantic Scholar + Claude."""
    from app.tasks.contacts_sync import enrich_contact
    return enrich_contact(contact_id)


@celery_app.task(name="app.worker.summarize_contact_task", bind=True, max_retries=1)
def summarize_contact_task(self, contact_id: str):
    """Generate or refresh AI summary for a contact."""
    from app.tasks.contacts_sync import summarize_contact
    return summarize_contact(contact_id)


@celery_app.task(name="app.worker.infer_relationships_task", bind=True, max_retries=1)
def infer_relationships_task(self):
    """Infer contact relationships from email co-occurrence patterns."""
    from app.tasks.contacts_sync import infer_relationships_from_emails
    return infer_relationships_from_emails()


@celery_app.task(name="app.worker.sync_google_contacts_inbound_task", bind=True, max_retries=1)
def sync_google_contacts_inbound_task(self, user_id: str):
    """Pull Google Contacts for one user — update existing records, queue unknowns as pending."""
    from app.tasks.contacts_sync import sync_google_contacts_inbound
    return sync_google_contacts_inbound(user_id)


@celery_app.task(name="app.worker.sync_google_contacts_inbound_all_users", bind=True)
def sync_google_contacts_inbound_all_users(self):
    """Daily: inbound Google Contacts sync for every user with a connected account."""
    conn = _get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT user_id FROM google_oauth_tokens")
        users = [r[0] for r in cur.fetchall()]
    finally:
        conn.close()
    for uid in users:
        sync_google_contacts_inbound_task.delay(str(uid))
    return {"status": "queued", "users": len(users)}


@celery_app.task(name="app.worker.push_contact_to_google_task", bind=True, max_retries=2)
def push_contact_to_google_task(self, contact_id: str):
    """Push a single platform contact to all users' Google Contacts."""
    from app.tasks.contacts_sync import push_contact_to_google
    return push_contact_to_google(contact_id)


# ---------------------------------------------------------------------------
# Notes: AI analysis task
# ---------------------------------------------------------------------------


@celery_app.task(name="app.worker.analyze_note_task", bind=True, max_retries=1)
def analyze_note_task(self, note_id: str):
    """Run Claude analysis on a note's raw transcript to extract summary,
    action items, decisions, and follow-ups."""
    import re
    import json as _json
    import anthropic
    from app.core.tracer import ExecutionTracer

    logger.info("analyze_note_task: note=%s", note_id)
    conn = _get_conn()
    try:
        with ExecutionTracer(
            pipeline="note_analysis",
            entity_id=note_id,
            entity_type="note",
            inputs={"note_id": note_id},
            triggered_by="user",
        ) as tracer:
            cur = conn.cursor()
            cur.execute(
                "SELECT note_id, title, raw_transcript FROM notes WHERE note_id = %s::uuid",
                (note_id,),
            )
            row = cur.fetchone()
            if not row:
                logger.warning("analyze_note_task: note %s not found", note_id)
                tracer.step("Note not found — skipping")
                return {"status": "skipped", "reason": "not_found"}

            note_id_val, title, transcript = row
            if not transcript:
                cur.execute(
                    "UPDATE notes SET ai_status = 'error', updated_at = now() WHERE note_id = %s::uuid",
                    (note_id,),
                )
                conn.commit()
                tracer.step("No transcript — skipping")
                return {"status": "skipped", "reason": "no_transcript"}

            tracer.step("Fetched note from DB", {"title": title, "transcript_chars": len(transcript)})

            cur.execute(
                "UPDATE notes SET ai_status = 'processing', updated_at = now() WHERE note_id = %s::uuid",
                (note_id,),
            )
            conn.commit()

            client = anthropic.Anthropic()
            prompt = f"""Analyze this meeting or session transcript and extract structured information.

Meeting title: {title or "Untitled"}
Transcript:
{transcript[:12000]}

Return ONLY a valid JSON object with exactly these fields:
{{
  "summary": "2-3 paragraph prose summary of what was discussed and any outcomes",
  "action_items": [
    {{"title": "concise action title", "description": "brief details of what needs to be done", "assignee_hint": "person name or null"}}
  ],
  "decisions": [
    {{"decision": "what was decided", "context": "brief rationale"}}
  ],
  "follow_ups": ["string", "string"]
}}"""

            tracer.step("Sending transcript to Claude", {"model": "claude-sonnet-4-6", "prompt_chars": len(prompt)})
            response = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=2048,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = response.content[0].text.strip() if response.content else ""
            tracer.step("Claude response received", {"output_tokens": response.usage.output_tokens if hasattr(response, 'usage') else 0, "response_chars": len(raw)})

            # Strip markdown fences if present
            fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
            if fence:
                raw = fence.group(1).strip()
            start = raw.find("{")
            end = raw.rfind("}")
            if start == -1 or end == -1:
                raise ValueError(f"No JSON object in Claude response: {raw[:200]}")
            parsed = _json.loads(raw[start:end + 1])
            tracer.step("Response parsed", {
                "action_items": len(parsed.get("action_items", [])),
                "decisions": len(parsed.get("decisions", [])),
                "follow_ups": len(parsed.get("follow_ups", [])),
            })

            cur.execute(
                """
                UPDATE notes SET
                    ai_summary   = %s,
                    action_items = %s::jsonb,
                    decisions    = %s::jsonb,
                    follow_ups   = %s::jsonb,
                    ai_status    = 'done',
                    updated_at   = now()
                WHERE note_id = %s::uuid
                """,
                (
                    parsed.get("summary"),
                    _json.dumps(parsed.get("action_items", [])),
                    _json.dumps(parsed.get("decisions", [])),
                    _json.dumps(parsed.get("follow_ups", [])),
                    note_id,
                ),
            )
            conn.commit()
            tracer.step("DB updated — analysis complete")
            tracer.set_outputs({
                "action_items": len(parsed.get("action_items", [])),
                "decisions": len(parsed.get("decisions", [])),
            })
            logger.info("analyze_note_task complete: note=%s", note_id)
            return {
                "status": "done",
                "action_items": len(parsed.get("action_items", [])),
                "decisions": len(parsed.get("decisions", [])),
            }

    except Exception as exc:
        logger.exception("analyze_note_task failed for note %s", note_id)
        try:
            conn.rollback()
            cur2 = conn.cursor()
            cur2.execute(
                "UPDATE notes SET ai_status = 'error', updated_at = now() WHERE note_id = %s::uuid",
                (note_id,),
            )
            conn.commit()
        except Exception:
            pass
        raise self.retry(exc=exc, countdown=30)
    finally:
        conn.close()


@celery_app.task(name="app.worker.scan_email_suggestions_all_users", bind=True)
def scan_email_suggestions_all_users(self):
    """Every 4 hours: scan inbox emails for all connected users and notify on new suggestions."""
    from app.routers.email import scan_and_notify_user

    conn = _get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT user_id::text FROM google_oauth_tokens")
        user_ids = [r[0] for r in cur.fetchall()]
    except Exception as e:
        logger.error("scan_email_suggestions_all_users: failed to load users: %s", e)
        return {"status": "error"}
    finally:
        conn.close()

    logger.info("scan_email_suggestions_all_users: scanning %d users", len(user_ids))
    results = {}
    for uid in user_ids:
        try:
            count = scan_and_notify_user(uid)
            results[uid] = count
        except Exception as e:
            logger.warning("scan failed for user %s: %s", uid, e)
            results[uid] = -1

    logger.info("scan_email_suggestions_all_users: done %s", results)
    return {"status": "ok", "results": results}


@celery_app.task(name="app.worker.send_due_marketing_posts", bind=True)
def send_due_marketing_posts(self):
    """Send marketing campaign posts whose scheduled time has arrived."""
    logger.info("send_due_marketing_posts started")
    conn = _get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT post_id
               FROM campaign_posts
               WHERE status = 'scheduled'
                 AND scheduled_at IS NOT NULL
                 AND scheduled_at <= NOW()
               ORDER BY scheduled_at
               LIMIT 25"""
        )
        post_ids = [str(r[0]) for r in cur.fetchall()]
    finally:
        conn.close()

    sent = 0
    failed = 0
    from app.routers.marketing import _send_post_now
    for post_id in post_ids:
        try:
            _send_post_now(post_id)
            sent += 1
        except Exception as exc:
            failed += 1
            logger.exception("Scheduled marketing post failed: %s", post_id)
            conn = _get_conn()
            try:
                cur = conn.cursor()
                cur.execute(
                    "UPDATE campaign_posts SET status='failed', error_message=%s, updated_at=NOW() WHERE post_id=%s::uuid",
                    [str(exc), post_id],
                )
                conn.commit()
            finally:
                conn.close()

    logger.info("send_due_marketing_posts complete: sent=%d failed=%d", sent, failed)
    return {"sent": sent, "failed": failed}


@celery_app.task(name="app.worker.sync_calendar_comms_all_users", bind=True)
def sync_calendar_comms_all_users(self, days_back: int = 30, days_forward: int = 14):
    """Put calendar meetings with known investor addresses on the Activity feed."""
    from app.tasks.calendar_comms import sync_calendar_comms

    conn = _get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT user_id::text FROM google_oauth_tokens")
        user_ids = [r[0] for r in cur.fetchall()]
    finally:
        conn.close()

    results = {}
    for uid in user_ids:
        results[uid] = sync_calendar_comms(uid, days_back=days_back, days_forward=days_forward)
    logger.info("sync_calendar_comms_all_users: %s", results)
    return results


@celery_app.task(name="app.worker.send_due_scheduled_emails", bind=True)
def send_due_scheduled_emails(self):
    """Send queued follow-ups whose time has come — unless they replied.

    The reply check happens HERE, immediately before sending, not only in the
    hourly Gmail sync. A reply that lands between the last sync and this sweep
    still stops the chase, which is the whole point of the feature.
    """
    from app.routers.comms import (
        _google_token, _send_via_gmail, _record_outbound, _mark_awaiting_investor,
        _thread_anchor, _sent_rfc_id, reply_subject, _build_attachments,
        load_signature,
    )

    logger.info("send_due_scheduled_emails started")
    conn = _get_conn()
    sent = failed = cancelled = 0
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            """SELECT * FROM scheduled_emails
               WHERE status = 'scheduled'
                 AND (scheduled_for IS NULL OR scheduled_for <= NOW())
                 -- A machine-written follow-up waits for a person. Unapproved,
                 -- it simply stays in the queue past its date; it is never sent
                 -- late by default, only when someone releases it.
                 AND (NOT approval_required OR approved_at IS NOT NULL)
               ORDER BY scheduled_for
               LIMIT 50"""
        )
        due = [dict(r) for r in cur.fetchall()]

        for job in due:
            jid = job["scheduled_id"]
            try:
                # Did they answer while this was waiting?
                if job["cancel_on_reply"]:
                    cur.execute(
                        """SELECT 1 FROM comm_messages
                           WHERE entity_type = %s AND entity_id = %s
                             AND direction = 'inbound' AND occurred_at >= %s
                           LIMIT 1""",
                        (job["entity_type"], job["entity_id"], job["watch_from"]),
                    )
                    if cur.fetchone():
                        cur.execute(
                            """UPDATE scheduled_emails
                               SET status='cancelled', cancelled_reason='Reply received',
                                   updated_at=NOW()
                               WHERE scheduled_id = %s""",
                            (jid,),
                        )
                        conn.commit()
                        cancelled += 1
                        continue

                if not job["sender_id"]:
                    raise RuntimeError("No sender mailbox on this scheduled email")

                token = _google_token(cur, str(job["sender_id"]))

                # Resolve the reply anchor NOW, not when this was queued — days
                # may have passed and the conversation may have moved on. The
                # follow-up should hang off whatever is newest in the thread.
                thread_id, in_reply_to, base_subject = _thread_anchor(
                    cur, job["entity_type"], str(job["entity_id"]),
                    {"thread_id": job["thread_id"], "in_reply_to": job["in_reply_to"]},
                    token, sender_id=str(job["sender_id"]),
                )
                subject = reply_subject(job["subject"], base_subject) if thread_id else job["subject"]

                # Pulled from Drive now, not when this was queued — a deck
                # revised in the meantime goes out in its current form.
                parts = _build_attachments(token, job.get("attachments") or [], cur)

                result = _send_via_gmail(
                    token,
                    to=job["to_email"],
                    subject=subject,
                    body=job["body"],
                    cc=list(job["cc_emails"] or []),
                    thread_id=thread_id,
                    in_reply_to=in_reply_to,
                    attachment_parts=parts,
                    # Read now, not when this was queued — a follow-up signs off
                    # with the sender's current details, not last month's.
                    signature=load_signature(cur, str(job["sender_id"])),
                )
                _record_outbound(
                    cur, job["entity_type"], str(job["entity_id"]), result,
                    to_emails=[job["to_email"]] + list(job["cc_emails"] or []),
                    subject=subject, body=job["body"],
                    sender_id=str(job["sender_id"]),
                    rfc_message_id=_sent_rfc_id(token, result.get("id")),
                    attachment_names=[n for n, _ in parts],
                )
                # A follow-up going out hands the ball back to them, same as
                # sending by hand from the panel.
                _mark_awaiting_investor(
                    cur, job["entity_type"], str(job["entity_id"]), job["created_by"],
                )
                cur.execute(
                    """UPDATE scheduled_emails
                       SET status='sent', sent_at=NOW(), gmail_message_id=%s,
                           thread_id=COALESCE(thread_id, %s), updated_at=NOW()
                       WHERE scheduled_id = %s""",
                    (result.get("id"), result.get("threadId"), jid),
                )
                # It has gone; there is nothing left to review.
                from app.routers.comms import _close_review_task
                _close_review_task(cur, jid)
                conn.commit()
                sent += 1
            except Exception as exc:
                conn.rollback()
                failed += 1
                logger.exception("scheduled email failed: %s", jid)
                try:
                    cur.execute(
                        "UPDATE scheduled_emails SET status='failed', error=%s, updated_at=NOW() WHERE scheduled_id=%s",
                        (str(exc)[:500], jid),
                    )
                    conn.commit()
                except Exception:
                    conn.rollback()
    finally:
        conn.close()

    logger.info("send_due_scheduled_emails: sent=%d cancelled=%d failed=%d", sent, cancelled, failed)
    return {"sent": sent, "cancelled": cancelled, "failed": failed}


@celery_app.task(name="app.worker.check_conditional_followups", bind=True)
def check_conditional_followups(self):
    """Cancel conditional follow-up tasks where a response email has arrived."""
    from app.routers.tasks import _check_conditional_followups_for_project
    logger.info("check_conditional_followups started")
    conn = _get_conn()
    cancelled = 0
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            """
            SELECT DISTINCT t.project_id::text
            FROM tasks t
            WHERE t.condition = 'no_response'
              AND t.status = 'open'
              AND t.locked = false
              AND t.project_id IS NOT NULL
            """
        )
        project_ids = [r["project_id"] for r in cur.fetchall()]
        for pid in project_ids:
            try:
                _check_conditional_followups_for_project(cur, pid)
                conn.commit()
                cancelled += 1
            except Exception as e:
                conn.rollback()
                logger.warning("check_conditional_followups: error for project %s: %s", pid, e)
        logger.info("check_conditional_followups done, checked %d projects", len(project_ids))
        return {"projects_checked": len(project_ids)}
    finally:
        conn.close()


@celery_app.task(name="app.worker.sync_plaid_actuals", bind=True, max_retries=2)
def sync_plaid_actuals(self):
    """Daily pull of Plaid bank data to update FP&A actuals (runs at 07:00 America/Chicago)."""
    from app.routers.fpa import _do_plaid_sync

    logger.info("sync_plaid_actuals started")
    try:
        result = _do_plaid_sync()
        logger.info(
            "sync_plaid_actuals complete: cash=%.2f net_burn=%.2f",
            result["cash_balance"],
            result["net_burn"],
        )
        return result
    except Exception as exc:
        logger.exception("sync_plaid_actuals failed")
        raise self.retry(exc=exc, countdown=300)


@celery_app.task(name="app.worker.sync_qbo_actuals", bind=True, max_retries=2)
def sync_qbo_actuals(self):
    """Daily pull of QBO P&L data for projected vs actual comparison (runs at 07:15 America/Chicago)."""
    from app.routers.fpa import _do_qbo_sync

    logger.info("sync_qbo_actuals started")
    try:
        monthly = _do_qbo_sync("monthly")
        weekly = _do_qbo_sync("weekly")
        quarterly = _do_qbo_sync("quarterly")
        yearly = _do_qbo_sync("yearly")
        logger.info("sync_qbo_actuals complete: %d monthly, %d weekly, %d quarterly, %d yearly",
                    len(monthly), len(weekly), len(quarterly), len(yearly))
        return {"monthly": len(monthly), "weekly": len(weekly), "quarterly": len(quarterly), "yearly": len(yearly)}
    except Exception as exc:
        # Don't retry if QBO isn't connected yet
        if "not connected" in str(exc).lower():
            logger.info("sync_qbo_actuals skipped: QBO not connected")
            return {"status": "skipped"}
        logger.exception("sync_qbo_actuals failed")
        raise self.retry(exc=exc, countdown=300)


# ---------------------------------------------------------------------------
# AI Planner tasks
# ---------------------------------------------------------------------------


@celery_app.task(name="app.worker.generate_daily_plans_all_users", bind=True)
def generate_daily_plans_all_users(self):
    """06:00 CST daily: generate AI daily plan for every user with a Google token."""
    from datetime import date as _date
    from app.routers.planner import run_daily_plan

    conn = _get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT user_id FROM google_oauth_tokens")
        users = [str(r[0]) for r in cur.fetchall()]
    finally:
        conn.close()

    results = []
    today = _date.today()
    for uid in users:
        try:
            conn2 = _get_conn()
            result = run_daily_plan(conn2, uid, today, force=False)
            conn2.close()
            results.append({"user_id": uid, "status": "ok", "plan_id": result.get("plan_id")})
            logger.info("generate_daily_plans_all_users: user=%s done", uid)
        except Exception as exc:
            logger.exception("generate_daily_plans_all_users: user=%s failed", uid)
            results.append({"user_id": uid, "status": "error", "error": str(exc)})

    return {"users": len(users), "results": results}


@celery_app.task(name="app.worker.generate_weekly_plans_all_users", bind=True)
def generate_weekly_plans_all_users(self):
    """06:00 CST Monday: generate AI weekly plan for every user with a Google token."""
    from datetime import date as _date, timedelta as _td
    from app.routers.planner import run_weekly_plan

    conn = _get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT user_id FROM google_oauth_tokens")
        users = [str(r[0]) for r in cur.fetchall()]
    finally:
        conn.close()

    today = _date.today()
    # week_start = most recent Monday
    week_start = today - _td(days=today.weekday())

    results = []
    for uid in users:
        try:
            conn2 = _get_conn()
            result = run_weekly_plan(conn2, uid, week_start, force=False)
            conn2.close()
            results.append({"user_id": uid, "status": "ok", "plan_id": result.get("plan_id")})
            logger.info("generate_weekly_plans_all_users: user=%s done", uid)
        except Exception as exc:
            logger.exception("generate_weekly_plans_all_users: user=%s failed", uid)
            results.append({"user_id": uid, "status": "error", "error": str(exc)})

    return {"users": len(users), "results": results}


@celery_app.task(name="app.worker.rollover_incomplete_blocks", bind=True)
def rollover_incomplete_blocks(self):
    """17:30 CST daily: mark unstarted draft blocks as 'skipped' for the day.

    Blocks that are still in 'draft' status at end of day are marked skipped.
    Confirmed blocks that weren't completed are left as-is for reporting.
    """
    from datetime import date as _date

    conn = _get_conn()
    try:
        cur = conn.cursor()
        today = _date.today()
        cur.execute("""
            UPDATE plan_blocks
            SET status = 'skipped'
            WHERE status = 'draft'
              AND plan_id IN (
                  SELECT plan_id FROM daily_plans WHERE plan_date = %s
              )
        """, (today,))
        skipped = cur.rowcount
        conn.commit()
        logger.info("rollover_incomplete_blocks: %d blocks skipped for %s", skipped, today)
        return {"status": "ok", "skipped": skipped, "date": str(today)}
    except Exception as exc:
        logger.exception("rollover_incomplete_blocks failed")
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# RAG embedding tasks
# ---------------------------------------------------------------------------


def _extract_granola_action_items(summary_markdown: str) -> list[dict]:
    """Parse bolded action items from a Granola Next Steps section.

    Returns list of {"title": str, "assignee": str | None} dicts.
    Only items in a section whose heading contains 'next step' or 'action item'
    (case-insensitive) are extracted.
    """
    import re as _re
    items = []
    in_section = False
    for line in summary_markdown.splitlines():
        stripped = line.strip()
        # Detect section headings
        if stripped.startswith("#"):
            heading = stripped.lstrip("#").strip().lower()
            in_section = "next step" in heading or "action item" in heading
            continue
        if not in_section:
            continue
        # Match bolded items: **text** (optional) (Name) — may be prefixed by list markers
        m = _re.search(r"\*\*(.+?)\*\*\s*(?:\(([^)]+)\))?", stripped)
        if m:
            title = m.group(1).strip()
            assignee = m.group(2).strip() if m.group(2) else None
            if title:
                items.append({"title": title, "assignee": assignee})
    return items


def _stage_granola_tasks(conn, user_id: str, entry_id: str,
                         note_title: str, summary_markdown: str,
                         granola_note_id: str,
                         note_created_at: str | None,
                         attendees: str | None = None) -> int:
    """Extract action items from a Granola note and insert into granola_suggested_tasks for approval.

    Only stages items where the assignee matches the user's first name or is
    unspecified — skips items clearly assigned to someone else.
    Returns the number of tasks staged.
    """
    import uuid as _uuid

    action_items = _extract_granola_action_items(summary_markdown)
    if not action_items:
        return 0

    cur = conn.cursor()
    # Fetch user's first name for assignee matching
    cur.execute("SELECT split_part(COALESCE(full_name, name, ''), ' ', 1) FROM users WHERE user_id = %s::uuid", (user_id,))
    row = cur.fetchone()
    user_first_name = (row[0] or "").strip().lower() if row else ""

    # Avoid duplicates: check existing staged titles for this note
    cur.execute(
        "SELECT title FROM granola_suggested_tasks WHERE granola_note_id = %s AND user_id = %s::uuid",
        (granola_note_id, user_id),
    )
    existing_titles = {r[0].strip().lower() for r in cur.fetchall()}

    staged = 0
    for item in action_items:
        assignee_name = (item["assignee"] or "").strip().lower()
        # Skip if clearly assigned to someone else
        if assignee_name and user_first_name and assignee_name != user_first_name:
            continue
        title = item["title"]
        if title.strip().lower() in existing_titles:
            continue
        cur.execute(
            """
            INSERT INTO granola_suggested_tasks (
                user_id, title, description, note_title,
                note_entry_id, granola_note_id, attendees, created_at, updated_at
            ) VALUES (
                %s::uuid, %s, %s, %s,
                %s::uuid, %s, %s, COALESCE(%s::timestamptz, now()), now()
            )
            """,
            (user_id, title, f"From meeting: {note_title}", note_title,
             entry_id, granola_note_id, attendees, note_created_at),
        )
        existing_titles.add(title.strip().lower())
        staged += 1
        logger.info("sync_granola_notes_task: staged task %r from note %s", title, granola_note_id)

    cur.close()
    return staged
