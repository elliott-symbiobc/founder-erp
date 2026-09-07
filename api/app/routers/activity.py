"""activity.py — read side of the request audit log.

Rows are written by the middleware in app/core/activity.py. Everything here
needs `view_activity` except /activity/me, which any signed-in user may read
about themselves.

  GET /activity                 — filterable event feed
  GET /activity/summary         — per-user roll-up (sessions, actions, modules)
  GET /activity/users/{id}      — one user's timeline + module breakdown
  GET /activity/me              — the caller's own recent activity
"""

import logging
import os
from contextlib import contextmanager

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException, Request

from app.routers.auth import get_current_user, require_permission

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/activity", tags=["activity"])


@contextmanager
def _db():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    try:
        with conn.cursor() as cur:
            yield cur
        conn.commit()
    finally:
        conn.close()


def _ser(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def _row(r) -> dict:
    return {k: _ser(v) for k, v in dict(r).items()}


@router.get("")
def list_activity(
    request: Request,
    user_id: str | None = None,
    org_id: str | None = None,
    module: str | None = None,
    action: str | None = None,
    days: int = 7,
    limit: int = 200,
    offset: int = 0,
):
    require_permission(request, "view_activity")
    limit = max(1, min(limit, 1000))
    days = max(1, min(days, 365))

    where = ["a.created_at > now() - make_interval(days => %s)"]
    params: list = [days]
    if user_id:
        where.append("a.user_id = %s")
        params.append(user_id)
    if org_id:
        where.append("a.org_id = %s")
        params.append(org_id)
    if module:
        where.append("a.module = %s")
        params.append(module)
    if action:
        where.append("a.action = %s")
        params.append(action)

    with _db() as cur:
        cur.execute(f"""
            SELECT a.activity_id, a.user_id, a.email, a.role, a.org_id,
                   a.method, a.path, a.module, a.action, a.status_code,
                   a.duration_ms, a.ip, a.created_at,
                   u.full_name, o.name AS org_name
              FROM activity_log a
              LEFT JOIN users u        ON u.user_id = a.user_id
              LEFT JOIN partner_orgs o ON o.org_id = a.org_id
             WHERE {' AND '.join(where)}
             ORDER BY a.created_at DESC
             LIMIT %s OFFSET %s
        """, [*params, limit, offset])
        events = [_row(r) for r in cur.fetchall()]

        cur.execute(
            f"SELECT count(*) AS n FROM activity_log a WHERE {' AND '.join(where)}", params
        )
        total = cur.fetchone()["n"]

    return {"events": events, "total": total, "limit": limit, "offset": offset}


@router.get("/summary")
def activity_summary(request: Request, days: int = 30, org_id: str | None = None):
    """One row per user: volume, distinct active days, and where they spend time."""
    require_permission(request, "view_activity")
    days = max(1, min(days, 365))

    where = ["a.created_at > now() - make_interval(days => %s)"]
    params: list = [days]
    if org_id:
        where.append("a.org_id = %s")
        params.append(org_id)

    with _db() as cur:
        cur.execute(f"""
            SELECT a.user_id, a.email, a.role,
                   u.full_name, o.name AS org_name, o.org_id,
                   count(*)                                   AS events,
                   count(*) FILTER (WHERE a.action <> 'view')  AS writes,
                   count(DISTINCT date_trunc('day', a.created_at)) AS active_days,
                   max(a.created_at)                          AS last_seen,
                   min(a.created_at)                          AS first_seen,
                   round(avg(a.duration_ms))                  AS avg_ms
              FROM activity_log a
              LEFT JOIN users u        ON u.user_id = a.user_id
              LEFT JOIN partner_orgs o ON o.org_id = a.org_id
             WHERE {' AND '.join(where)}
             GROUP BY a.user_id, a.email, a.role, u.full_name, o.name, o.org_id
             ORDER BY events DESC
        """, params)
        users = [_row(r) for r in cur.fetchall()]

        cur.execute(f"""
            SELECT a.module, count(*) AS events, count(DISTINCT a.user_id) AS users
              FROM activity_log a
             WHERE {' AND '.join(where)}
             GROUP BY a.module ORDER BY events DESC LIMIT 25
        """, params)
        modules = [_row(r) for r in cur.fetchall()]

        cur.execute(f"""
            SELECT date_trunc('day', a.created_at) AS day,
                   count(*) AS events, count(DISTINCT a.user_id) AS users
              FROM activity_log a
             WHERE {' AND '.join(where)}
             GROUP BY 1 ORDER BY 1
        """, params)
        daily = [_row(r) for r in cur.fetchall()]

    return {"users": users, "modules": modules, "daily": daily, "days": days}


@router.get("/users/{target_id}")
def user_activity(request: Request, target_id: str, days: int = 30, limit: int = 300):
    """One user's timeline, module breakdown and learning progress in one call."""
    require_permission(request, "view_activity")
    days = max(1, min(days, 365))
    limit = max(1, min(limit, 1000))

    with _db() as cur:
        cur.execute("""
            SELECT u.user_id, u.email, u.full_name, u.role, u.is_active,
                   u.last_login, u.created_at, o.name AS org_name, o.org_id
              FROM users u LEFT JOIN partner_orgs o ON o.org_id = u.org_id
             WHERE u.user_id = %s
        """, (target_id,))
        user = cur.fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        cur.execute("""
            SELECT module, action, count(*) AS events, max(created_at) AS last_seen
              FROM activity_log
             WHERE user_id = %s AND created_at > now() - make_interval(days => %s)
             GROUP BY module, action ORDER BY events DESC
        """, (target_id, days))
        breakdown = [_row(r) for r in cur.fetchall()]

        cur.execute("""
            SELECT activity_id, method, path, module, action, status_code,
                   duration_ms, ip, created_at
              FROM activity_log
             WHERE user_id = %s AND created_at > now() - make_interval(days => %s)
             ORDER BY created_at DESC LIMIT %s
        """, (target_id, days, limit))
        timeline = [_row(r) for r in cur.fetchall()]

        cur.execute("""
            SELECT m.module_id, m.title, t.title AS track_title, t.kind,
                   p.status, p.video_seconds, p.quiz_score,
                   p.started_at, p.completed_at, p.last_seen_at
              FROM learn_progress p
              JOIN learn_modules m ON m.module_id = p.module_id
              JOIN learn_tracks t  ON t.track_id = m.track_id
             WHERE p.user_id = %s
             ORDER BY p.last_seen_at DESC
        """, (target_id,))
        learning = [_row(r) for r in cur.fetchall()]

    return {
        "user": _row(user),
        "breakdown": breakdown,
        "timeline": timeline,
        "learning": learning,
        "days": days,
    }


@router.get("/me")
def my_activity(request: Request, days: int = 30, limit: int = 100):
    """A user's own recent activity — no special permission needed."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    days = max(1, min(days, 365))
    with _db() as cur:
        cur.execute("""
            SELECT method, path, module, action, status_code, created_at
              FROM activity_log
             WHERE user_id = %s AND created_at > now() - make_interval(days => %s)
             ORDER BY created_at DESC LIMIT %s
        """, (user["user_id"], days, max(1, min(limit, 500))))
        return [_row(r) for r in cur.fetchall()]
