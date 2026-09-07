import logging
import os
import subprocess
from datetime import timedelta

import psycopg2
from celery import Celery
from celery.schedules import crontab

logger = logging.getLogger(__name__)

celery_app = Celery(
    "openerp",
    broker=os.environ.get("REDIS_URL", "redis://redis:6379/0"),
    backend=os.environ.get("REDIS_URL", "redis://redis:6379/0"),
)
# Alias expected by `celery -A app.worker worker`
celery = celery_app

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="America/Chicago",
    # Global safety net: no task may occupy a prefork slot indefinitely.
    # Individual tasks may override with a longer/shorter time_limit.
    task_time_limit=3600,       # hard kill after 1h
    task_soft_time_limit=3300,  # SoftTimeLimitExceeded raised at 55m for cleanup
    beat_schedule={
        "daily-plaid-sync": {
            "task": "app.worker.sync_plaid_actuals",
            "schedule": crontab(hour=7, minute=0),
        },
        "daily-qbo-sync": {
            "task": "app.worker.sync_qbo_actuals",
            "schedule": crontab(hour=7, minute=15),
        },
        # Contacts module
        "contacts-gmail-sync": {
            "task": "app.worker.sync_gmail_contacts_all_users",
            "schedule": crontab(hour=3, minute=0),  # full sync once daily at 03:00 America/Chicago
        },
        "contacts-gmail-incremental": {
            "task": "app.worker.sync_gmail_incremental_all_users",
            # Every 5 minutes. The board is worked live — an hour of latency
            # made a sent email look like nothing had happened. The History API
            # costs one cheap call per user when there is nothing new.
            "schedule": timedelta(minutes=5),
        },
        "contacts-calendar-sync": {
            "task": "app.worker.sync_calendar_contacts_all_users",
            "schedule": crontab(minute=30),          # every hour at :30
        },
"contacts-summaries": {
            "task": "app.worker.refresh_contact_summaries_task",
            "schedule": crontab(hour=1, minute=0),   # nightly at 01:00 America/Chicago
        },
        "contacts-relationship-inference": {
            "task": "app.worker.infer_relationships_task",
            "schedule": crontab(hour=2, minute=30),  # nightly at 02:30 America/Chicago
        },
        "contacts-google-contacts-inbound": {
            "task": "app.worker.sync_google_contacts_inbound_all_users",
            "schedule": crontab(hour=4, minute=0),   # nightly at 04:00 America/Chicago
        },
        # RAG: nightly incremental re-embed of recently updated content
        "rag-nightly-embed": {
            "task": "app.worker.nightly_embed_task",
            "schedule": crontab(hour=1, minute=30),  # 01:30 America/Chicago
        },
        # BGC safety flag sweep (after nightly annotation window)
        # Granola: poll for new meeting notes every 5 minutes
        "email-suggestions-scan": {
            "task": "app.worker.scan_email_suggestions_all_users",
            "schedule": timedelta(minutes=15),  # was daily; now scans inbox every 15 minutes
        },
        "marketing-scheduled-posts": {
            "task": "app.worker.send_due_marketing_posts",
            "schedule": timedelta(hours=1),
        },
        "calendar-comms": {
            "task": "app.worker.sync_calendar_comms_all_users",
            "schedule": timedelta(hours=1),
        },
        "scheduled-emails": {
            "task": "app.worker.send_due_scheduled_emails",
            "schedule": timedelta(minutes=15),
        },
        "conditional-followup-check": {
            "task": "app.worker.check_conditional_followups",
            "schedule": timedelta(hours=4),  # every 4 hours
        },
    },
)




def _get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _check_model_staleness() -> None:
    """Warn at worker startup if the compatibility model is missing or stale (> 7 days)."""
    import pickle
    from datetime import datetime, timezone
    from pathlib import Path

    model_path = Path("/opt/openerp/models/compatibility_model.pkl")
    if not model_path.exists():
        logger.warning(
            "MODEL STALENESS: compatibility_model.pkl not found — "
            "run retrain task or seed_training_data.py before predictions will work."
        )
        return

    try:
        with open(model_path, "rb") as fh:
            model_data = pickle.load(fh)
        last_trained_str = model_data.get("last_trained")
        if last_trained_str:
            last_trained = datetime.fromisoformat(last_trained_str)
            age_days = (datetime.now(timezone.utc) - last_trained).days
            if age_days > 7:
                logger.warning(
                    "MODEL STALENESS: compatibility_model.pkl is %d days old "
                    "(trained %s). Consider retraining.",
                    age_days, last_trained_str,
                )
            else:
                logger.info(
                    "Model freshness OK: compatibility_model.pkl trained %s (%d days ago, source=%s)",
                    last_trained_str, age_days,
                    model_data.get("training_data_source", "unknown"),
                )
    except Exception as exc:
        logger.warning("MODEL STALENESS: could not read model pkl: %s", exc)


try:
    _check_model_staleness()
except Exception:
    pass  # never block worker startup



def _log_anthropic_usage(task: str, model: str, input_tokens: int, output_tokens: int):
    try:
        from app.agents.usage_logger import log_anthropic_call
        log_anthropic_call(operation=task, model=model, input_tokens=input_tokens, output_tokens=output_tokens)
    except Exception:
        pass


@celery_app.task(name="app.worker.embed_content_task", bind=True, max_retries=2)
def embed_content_task(self, source_table: str, source_id: str, user_id: str | None = None):
    """Embed a single content item into context_chunks."""
    from app.tasks.embed_task import embed_content
    try:
        return embed_content(source_table, source_id, user_id=user_id)
    except Exception as exc:
        logger.exception("embed_content_task failed: %s/%s", source_table, source_id)
        raise self.retry(exc=exc, countdown=60)


@celery_app.task(name="app.worker.backfill_all_embeddings", bind=True)
def backfill_all_embeddings(self, user_id: str | None = None):
    """One-shot: embed every row in all source tables (run once after migration)."""
    from app.tasks.embed_task import backfill_all
    logger.info("backfill_all_embeddings started (user_id=%s)", user_id)
    result = backfill_all(user_id=user_id)
    logger.info("backfill_all_embeddings complete: %s", result)
    return result


@celery_app.task(name="app.worker.nightly_embed_task", bind=True)
def nightly_embed_task(self):
    """Nightly: re-embed rows updated in the last 25 hours (catches missed triggers)."""
    from app.tasks.embed_task import embed_content

    conn = _get_conn()
    try:
        cur = conn.cursor()
        # Tables with user_id and tables without
        table_pks = {
            "notes": ("note_id", True),
            "eln_entries": ("entry_id", True),
            "papers": ("paper_id", False),
            "contacts": ("contact_id", False),
            "tasks": ("task_id", True),
        }
        total = 0
        for table, (pk_col, has_user_id) in table_pks.items():
            user_col = f", user_id::text" if has_user_id else ", NULL::text"
            cur.execute(
                f"SELECT {pk_col}::text{user_col} FROM {table} "
                f"WHERE updated_at > now() - interval '25 hours'"
            )
            rows = cur.fetchall()
            for sid, uid in rows:
                embed_content_task.delay(table, sid, uid)
                total += 1
        logger.info("nightly_embed_task: queued %d items", total)
        return {"status": "ok", "queued": total}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Task registration.
#
# The task bodies live in worker_science.py and worker_ops.py. Importing them
# here registers them with celery_app and keeps `from app.worker import <task>`
# working for the fifteen modules that do exactly that. The import sits at the
# bottom because both modules import celery_app from this one.
# ---------------------------------------------------------------------------

from app.worker_science import *  # noqa: E402,F401,F403
from app.worker_ops import *      # noqa: E402,F401,F403
