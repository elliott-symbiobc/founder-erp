"""activity.py — buffered request audit log.

Every authenticated API request becomes one row in `activity_log`. Writing that
row inline would put a Postgres round-trip in front of every dashboard poll, so
events go onto a bounded queue and a single background task flushes them in
batches. If the queue fills because the database is slow or down, events are
dropped and counted — an audit log must never be able to stall the API.

Wired up in app/main.py:
    app.add_middleware(ActivityLogMiddleware)
    @app.on_event("startup")  -> start_flusher()
"""

import asyncio
import logging
import os
import re
import time

import psycopg2
import psycopg2.extras
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)

QUEUE_MAX = 5000
FLUSH_INTERVAL_S = 2.0
FLUSH_BATCH = 200

_queue: asyncio.Queue | None = None
_dropped = 0

# Endpoints that fire on a timer and would otherwise dominate the log.
_SKIP_PATTERNS = (
    re.compile(r"^/?health"),
    re.compile(r"^/?notifications/(unread|poll)"),
    re.compile(r"^/?messaging/.*/poll"),
    re.compile(r"^/?jobs/[^/]+/status"),
    re.compile(r"^/?openapi\.json"),
)

_METHOD_ACTION = {
    "GET": "view",
    "HEAD": "view",
    "POST": "create",
    "PUT": "update",
    "PATCH": "update",
    "DELETE": "delete",
}


def _module_of(path: str) -> str:
    """First path segment — a coarse bucket like 'learn', 'strains', 'fpa'."""
    seg = path.strip("/").split("/", 1)[0]
    return seg or "root"


def _client_ip(request) -> str | None:
    for header in ("X-Client-IP", "X-Real-IP"):
        v = request.headers.get(header)
        if v:
            return v.strip()
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


def record(event: dict) -> None:
    """Enqueue one activity event. Never raises, never blocks."""
    global _dropped
    if _queue is None:
        return
    try:
        _queue.put_nowait(event)
    except asyncio.QueueFull:
        _dropped += 1
        if _dropped % 100 == 1:
            logger.warning("activity_log queue full; dropped %d events", _dropped)


class ActivityLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        started = time.perf_counter()
        response = await call_next(request)

        try:
            path = request.url.path
            # root_path is /api; strip it so `module` matches the router prefix.
            rel = path[len("/api"):] if path.startswith("/api") else path
            user_id = request.headers.get("X-User-Id")
            if user_id and not any(p.match(rel.lstrip("/")) for p in _SKIP_PATTERNS):
                record({
                    "user_id": user_id,
                    "email": request.headers.get("X-User-Email"),
                    "role": request.headers.get("X-User-Role"),
                    "method": request.method,
                    "path": rel,
                    "module": _module_of(rel),
                    "action": _METHOD_ACTION.get(request.method, "other"),
                    "status_code": response.status_code,
                    "duration_ms": int((time.perf_counter() - started) * 1000),
                    "ip": _client_ip(request),
                    "user_agent": (request.headers.get("User-Agent") or "")[:500],
                    # Set by ImpersonationMiddleware. Without it a preview would
                    # be logged as the partner's own activity.
                    "impersonated_by": request.headers.get("X-Impersonated-By"),
                })
        except Exception:  # logging must never break a response
            logger.debug("activity capture failed", exc_info=True)

        return response


_INSERT = """
    INSERT INTO activity_log
        (user_id, email, role, org_id, method, path, module, action,
         status_code, duration_ms, ip, user_agent, impersonated_by)
    VALUES %s
"""


def _flush_sync(batch: list[dict]) -> None:
    rows = [
        (
            e.get("user_id"), e.get("email"), e.get("role"), None,
            e.get("method"), e.get("path")[:2000], e.get("module"), e.get("action"),
            e.get("status_code"), e.get("duration_ms"), e.get("ip"), e.get("user_agent"),
            e.get("impersonated_by"),
        )
        for e in batch
    ]
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(cur, _INSERT, rows)
            # Backfill org_id from the user record so cohort roll-ups are a
            # plain group-by rather than a join at read time.
            cur.execute("""
                UPDATE activity_log a SET org_id = u.org_id
                  FROM users u
                 WHERE a.user_id = u.user_id
                   AND a.org_id IS NULL AND u.org_id IS NOT NULL
                   AND a.created_at > now() - interval '1 hour'
            """)
        conn.commit()
    finally:
        conn.close()


async def _flusher() -> None:
    assert _queue is not None
    while True:
        await asyncio.sleep(FLUSH_INTERVAL_S)
        batch: list[dict] = []
        while batch.__len__() < FLUSH_BATCH and not _queue.empty():
            batch.append(_queue.get_nowait())
        if not batch:
            continue
        try:
            await asyncio.to_thread(_flush_sync, batch)
        except Exception:
            logger.warning("activity_log flush failed (%d events lost)", len(batch), exc_info=True)


def start_flusher() -> None:
    """Create the queue and launch the background writer. Call on startup."""
    global _queue
    if _queue is not None:
        return
    _queue = asyncio.Queue(maxsize=QUEUE_MAX)
    asyncio.create_task(_flusher())
    logger.info("activity_log flusher started")
