"""
reports.py — Planner, task, CRM and KPI analytics.

The DOCX report endpoints moved to report_files.py: they are the only part
the analysis pages use, and everything left here reads FP&A and CRM internals.

GET /reports/tasks/overview   — personal task completion, overdue, by priority/source
GET /reports/tasks/team       — admin: per-employee task stats
GET /reports/crm              — CRM deal pipeline and project metrics
GET /reports/time-analysis    — planned vs actual time by block type
GET /reports/completion       — daily and priority-based completion rates
GET /reports/velocity         — weekly block/task velocity
GET /reports/estimate-accuracy — AI estimate vs actual duration accuracy
GET /reports/summary          — quick weekly/monthly overview
GET /reports/kpis             — full internal & accelerator KPI dashboard
"""
import os
from datetime import date, datetime, timedelta

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.routers.auth import get_current_user

router = APIRouter(prefix="/reports", tags=["reports"])
security = HTTPBearer(auto_error=False)

REPORTS_DIR = "/app/reports"


def _get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    import jwt as pyjwt
    token = credentials.credentials
    secret = os.environ.get("JWT_SECRET", "changeme")
    try:
        payload = pyjwt.decode(token, secret, algorithms=["HS256"])
        return payload["sub"]
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

@router.get("/summary")
def get_reports_summary(credentials: HTTPAuthorizationCredentials = Depends(security)):
    user_id = _verify_token(credentials)
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        today = date.today()
        week_ago = today - timedelta(days=7)
        month_ago = today - timedelta(days=30)

        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE dp.plan_date >= %s) AS blocks_this_week,
                COUNT(*) FILTER (WHERE pb.status = 'done' AND dp.plan_date >= %s) AS completed_this_week,
                COUNT(*) FILTER (WHERE dp.plan_date >= %s) AS blocks_this_month,
                COUNT(*) FILTER (WHERE pb.status = 'done' AND dp.plan_date >= %s) AS completed_this_month,
                COALESCE(SUM(pb.actual_minutes) FILTER (WHERE dp.plan_date >= %s), 0) AS actual_minutes_week,
                COALESCE(SUM(pb.estimated_minutes) FILTER (WHERE dp.plan_date >= %s), 0) AS planned_minutes_week
            FROM plan_blocks pb
            JOIN daily_plans dp ON dp.plan_id = pb.plan_id
            WHERE pb.user_id = %s
        """, (week_ago, week_ago, month_ago, month_ago, week_ago, week_ago, user_id))
        stats = cur.fetchone()

        cur.execute("""
            SELECT COALESCE(SUM(logged_minutes), 0) AS logged_this_week
            FROM time_logs
            WHERE user_id = %s AND log_date >= %s
        """, (user_id, week_ago))
        logged = cur.fetchone()

        return {
            "this_week": {
                "blocks": stats["blocks_this_week"],
                "completed": stats["completed_this_week"],
                "completion_pct": round(100 * stats["completed_this_week"] / stats["blocks_this_week"], 1)
                    if stats["blocks_this_week"] else 0,
                "planned_minutes": stats["planned_minutes_week"],
                "actual_minutes": stats["actual_minutes_week"],
                "logged_minutes": logged["logged_this_week"],
            },
            "this_month": {
                "blocks": stats["blocks_this_month"],
                "completed": stats["completed_this_month"],
                "completion_pct": round(100 * stats["completed_this_month"] / stats["blocks_this_month"], 1)
                    if stats["blocks_this_month"] else 0,
            },
        }
    finally:
        conn.close()


@router.get("/time-analysis")
def get_time_analysis(
    days: int = Query(30, ge=7, le=365),
    credentials: HTTPAuthorizationCredentials = Depends(security),
):
    user_id = _verify_token(credentials)
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        since = date.today() - timedelta(days=days)

        cur.execute("""
            SELECT
                block_type,
                COUNT(*) AS block_count,
                COALESCE(SUM(estimated_minutes), 0) AS planned_minutes,
                COALESCE(SUM(actual_minutes), 0) AS actual_minutes,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS completed_count
            FROM plan_blocks
            WHERE user_id = %s
              AND plan_id IN (SELECT plan_id FROM daily_plans WHERE plan_date >= %s AND user_id = %s)
            GROUP BY block_type
            ORDER BY planned_minutes DESC NULLS LAST
        """, (user_id, since, user_id))
        by_type = cur.fetchall()

        cur.execute("""
            SELECT log_date, SUM(logged_minutes) AS logged_minutes, COUNT(*) AS entries
            FROM time_logs
            WHERE user_id = %s AND log_date >= %s
            GROUP BY log_date ORDER BY log_date
        """, (user_id, since))
        daily_logged = cur.fetchall()

        cur.execute("""
            SELECT
                COALESCE(SUM(estimated_minutes), 0) AS total_planned,
                COALESCE(SUM(actual_minutes), 0) AS total_actual
            FROM plan_blocks
            WHERE user_id = %s
              AND plan_id IN (SELECT plan_id FROM daily_plans WHERE plan_date >= %s AND user_id = %s)
        """, (user_id, since, user_id))
        totals = cur.fetchone()

        cur.execute("""
            SELECT COALESCE(SUM(logged_minutes), 0) AS total_logged
            FROM time_logs WHERE user_id = %s AND log_date >= %s
        """, (user_id, since))
        logged_total = cur.fetchone()

        return {
            "period_days": days,
            "by_type": [dict(r) for r in by_type],
            "daily_logged": [
                {"date": str(r["log_date"]), "minutes": r["logged_minutes"], "entries": r["entries"]}
                for r in daily_logged
            ],
            "totals": {
                "planned_minutes": totals["total_planned"],
                "actual_minutes": totals["total_actual"],
                "logged_minutes": logged_total["total_logged"],
            },
        }
    finally:
        conn.close()


@router.get("/completion")
def get_completion_rate(
    days: int = Query(30, ge=7, le=365),
    credentials: HTTPAuthorizationCredentials = Depends(security),
):
    user_id = _verify_token(credentials)
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        since = date.today() - timedelta(days=days)

        cur.execute("""
            SELECT
                dp.plan_date,
                COUNT(pb.block_id) AS total_blocks,
                SUM(CASE WHEN pb.status = 'done' THEN 1 ELSE 0 END) AS completed_blocks,
                CASE WHEN COUNT(pb.block_id) > 0
                     THEN ROUND(100.0 * SUM(CASE WHEN pb.status = 'done' THEN 1 ELSE 0 END) / COUNT(pb.block_id), 1)
                     ELSE 0 END AS completion_pct
            FROM daily_plans dp
            LEFT JOIN plan_blocks pb ON pb.plan_id = dp.plan_id AND pb.user_id = dp.user_id
            WHERE dp.user_id = %s AND dp.plan_date >= %s
            GROUP BY dp.plan_date ORDER BY dp.plan_date
        """, (user_id, since))
        daily = cur.fetchall()

        cur.execute("""
            SELECT
                CASE
                    WHEN priority_score >= 90 THEN 'CRITICAL'
                    WHEN priority_score >= 70 THEN 'HIGH'
                    WHEN priority_score >= 50 THEN 'ELEVATED'
                    WHEN priority_score >= 30 THEN 'NORMAL'
                    ELSE 'LOW'
                END AS priority_bucket,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS completed,
                CASE WHEN COUNT(*) > 0
                     THEN ROUND(100.0 * SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) / COUNT(*), 1)
                     ELSE 0 END AS completion_pct
            FROM plan_blocks
            WHERE user_id = %s
              AND plan_id IN (SELECT plan_id FROM daily_plans WHERE plan_date >= %s AND user_id = %s)
            GROUP BY priority_bucket
        """, (user_id, since, user_id))
        by_priority = cur.fetchall()

        cur.execute("""
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
                SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft
            FROM plan_blocks
            WHERE user_id = %s
              AND plan_id IN (SELECT plan_id FROM daily_plans WHERE plan_date >= %s AND user_id = %s)
        """, (user_id, since, user_id))
        overall = cur.fetchone()

        return {
            "period_days": days,
            "daily": [
                {
                    "date": str(r["plan_date"]),
                    "total": r["total_blocks"],
                    "completed": r["completed_blocks"],
                    "pct": float(r["completion_pct"]),
                }
                for r in daily
            ],
            "by_priority": [dict(r) for r in by_priority],
            "overall": dict(overall),
        }
    finally:
        conn.close()


@router.get("/velocity")
def get_velocity(
    weeks: int = Query(12, ge=4, le=52),
    credentials: HTTPAuthorizationCredentials = Depends(security),
):
    user_id = _verify_token(credentials)
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        since = date.today() - timedelta(weeks=weeks)

        cur.execute("""
            SELECT
                DATE_TRUNC('week', dp.plan_date)::date AS week_start,
                COUNT(pb.block_id) AS total_blocks,
                SUM(CASE WHEN pb.status = 'done' THEN 1 ELSE 0 END) AS completed_blocks,
                COALESCE(SUM(CASE WHEN pb.status = 'done' THEN pb.actual_minutes END), 0) AS completed_minutes
            FROM daily_plans dp
            LEFT JOIN plan_blocks pb ON pb.plan_id = dp.plan_id AND pb.user_id = dp.user_id
            WHERE dp.user_id = %s AND dp.plan_date >= %s
            GROUP BY week_start ORDER BY week_start
        """, (user_id, since))
        weekly = cur.fetchall()

        cur.execute("""
            SELECT
                DATE_TRUNC('week', updated_at)::date AS week_start,
                COUNT(*) AS tasks_done
            FROM tasks
            WHERE user_id = %s AND status = 'done' AND updated_at >= %s
            GROUP BY week_start ORDER BY week_start
        """, (user_id, since))
        tasks_weekly = cur.fetchall()
        tasks_map = {str(r["week_start"]): r["tasks_done"] for r in tasks_weekly}

        return {
            "period_weeks": weeks,
            "weekly": [
                {
                    "week": str(r["week_start"]),
                    "total_blocks": r["total_blocks"],
                    "completed_blocks": r["completed_blocks"],
                    "completed_minutes": r["completed_minutes"],
                    "tasks_done": tasks_map.get(str(r["week_start"]), 0),
                }
                for r in weekly
            ],
        }
    finally:
        conn.close()


@router.get("/estimate-accuracy")
def get_estimate_accuracy(
    days: int = Query(30, ge=7, le=365),
    credentials: HTTPAuthorizationCredentials = Depends(security),
):
    user_id = _verify_token(credentials)
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        since = date.today() - timedelta(days=days)

        cur.execute("""
            SELECT
                pb.block_id, pb.title, pb.block_type,
                pb.estimated_minutes, pb.actual_minutes,
                pb.actual_minutes - pb.estimated_minutes AS delta_minutes,
                CASE WHEN pb.estimated_minutes > 0
                     THEN ROUND(100.0 * (pb.actual_minutes - pb.estimated_minutes) / pb.estimated_minutes, 1)
                     ELSE NULL END AS pct_error,
                dp.plan_date
            FROM plan_blocks pb
            JOIN daily_plans dp ON dp.plan_id = pb.plan_id
            WHERE pb.user_id = %s AND dp.plan_date >= %s
              AND pb.estimated_minutes IS NOT NULL
              AND pb.actual_minutes IS NOT NULL AND pb.actual_minutes > 0
            ORDER BY dp.plan_date DESC LIMIT 200
        """, (user_id, since))
        raw = cur.fetchall()

        cur.execute("""
            SELECT
                COUNT(*) AS sample_size,
                ROUND(AVG(actual_minutes - estimated_minutes), 1) AS avg_delta,
                ROUND(AVG(ABS(actual_minutes - estimated_minutes)), 1) AS avg_abs_error,
                ROUND(AVG(CASE WHEN estimated_minutes > 0
                          THEN 100.0 * ABS(actual_minutes - estimated_minutes) / estimated_minutes
                          ELSE NULL END), 1) AS avg_pct_error,
                SUM(CASE WHEN actual_minutes <= estimated_minutes * 1.1 THEN 1 ELSE 0 END) AS on_time_count
            FROM plan_blocks pb
            JOIN daily_plans dp ON dp.plan_id = pb.plan_id
            WHERE pb.user_id = %s AND dp.plan_date >= %s
              AND pb.estimated_minutes IS NOT NULL
              AND pb.actual_minutes IS NOT NULL AND pb.actual_minutes > 0
        """, (user_id, since))
        agg = cur.fetchone()

        cur.execute("""
            SELECT
                pb.block_type, COUNT(*) AS count,
                ROUND(AVG(actual_minutes - estimated_minutes), 1) AS avg_delta,
                ROUND(AVG(CASE WHEN estimated_minutes > 0
                          THEN 100.0 * ABS(actual_minutes - estimated_minutes) / estimated_minutes
                          ELSE NULL END), 1) AS avg_pct_error
            FROM plan_blocks pb
            JOIN daily_plans dp ON dp.plan_id = pb.plan_id
            WHERE pb.user_id = %s AND dp.plan_date >= %s
              AND pb.estimated_minutes IS NOT NULL
              AND pb.actual_minutes IS NOT NULL AND pb.actual_minutes > 0
            GROUP BY pb.block_type ORDER BY count DESC
        """, (user_id, since))
        by_type = cur.fetchall()

        return {
            "period_days": days,
            "aggregate": dict(agg),
            "by_type": [dict(r) for r in by_type],
            "samples": [
                {
                    "block_id": str(r["block_id"]),
                    "title": r["title"],
                    "type": r["block_type"],
                    "estimated": r["estimated_minutes"],
                    "actual": r["actual_minutes"],
                    "delta": r["delta_minutes"],
                    "pct_error": float(r["pct_error"]) if r["pct_error"] is not None else None,
                    "date": str(r["plan_date"]),
                }
                for r in raw
            ],
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Task analytics (new schema)
# ---------------------------------------------------------------------------

@router.get("/tasks/overview")
def get_tasks_overview(
    days: int = Query(30, ge=7, le=365),
    request: Request = None,
):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    uid = user["user_id"]
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        since = date.today() - timedelta(days=days)

        cur.execute("""
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'done') AS done,
                COUNT(*) FILTER (WHERE status = 'open') AS open,
                COUNT(*) FILTER (WHERE status = 'open' AND due_date < CURRENT_DATE) AS overdue
            FROM tasks
            WHERE user_id = %s::uuid OR assigned_to = %s::uuid
        """, (uid, uid))
        totals = dict(cur.fetchone())

        cur.execute("""
            SELECT
                COALESCE(priority, 'none') AS priority,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'done') AS done,
                COUNT(*) FILTER (WHERE status = 'open' AND due_date < CURRENT_DATE) AS overdue
            FROM tasks
            WHERE user_id = %s::uuid OR assigned_to = %s::uuid
            GROUP BY priority
            ORDER BY
                CASE COALESCE(priority,'none')
                    WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
        """, (uid, uid))
        by_priority = [dict(r) for r in cur.fetchall()]

        cur.execute("""
            SELECT kanban_status, COUNT(*) AS count
            FROM tasks
            WHERE (user_id = %s::uuid OR assigned_to = %s::uuid) AND status = 'open'
            GROUP BY kanban_status
            ORDER BY
                CASE kanban_status
                    WHEN 'inbox' THEN 0
                    WHEN 'todo' THEN 1 WHEN 'in_progress' THEN 2
                    WHEN 'review' THEN 3 WHEN 'done' THEN 4 END
        """, (uid, uid))
        by_kanban = [dict(r) for r in cur.fetchall()]

        cur.execute("""
            SELECT
                CASE
                    WHEN source_ref LIKE 'funding:%%' THEN 'Funding'
                    WHEN source_ref LIKE 'dilutive:%%' THEN 'Investor'
                    WHEN source = 'gmail' THEN 'Email Follow-up'
                    WHEN project_id IS NOT NULL THEN 'Project'
                    WHEN contact_id IS NOT NULL THEN 'Contact'
                    ELSE 'General'
                END AS category,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'done') AS done
            FROM tasks
            WHERE user_id = %s::uuid OR assigned_to = %s::uuid
            GROUP BY category
            ORDER BY total DESC
        """, (uid, uid))
        by_category = [dict(r) for r in cur.fetchall()]

        cur.execute("""
            SELECT
                DATE_TRUNC('week', updated_at)::date AS week,
                COUNT(*) AS tasks_done
            FROM tasks
            WHERE (user_id = %s::uuid OR assigned_to = %s::uuid)
              AND status = 'done'
              AND updated_at >= %s
            GROUP BY week ORDER BY week
        """, (uid, uid, since))
        weekly_done = [{"week": str(r["week"]), "tasks_done": r["tasks_done"]}
                       for r in cur.fetchall()]

        return {
            "period_days": days,
            "totals": totals,
            "by_priority": by_priority,
            "by_kanban": by_kanban,
            "by_category": by_category,
            "weekly_done": weekly_done,
        }
    finally:
        conn.close()


@router.get("/tasks/team")
def get_tasks_team(request: Request = None):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        cur.execute("""
            SELECT
                u.user_id::text,
                COALESCE(u.full_name, u.name, u.email) AS name,
                u.email,
                u.role,
                COUNT(t.task_id) AS total,
                COUNT(t.task_id) FILTER (WHERE t.status = 'done') AS done,
                COUNT(t.task_id) FILTER (WHERE t.status = 'open') AS open,
                COUNT(t.task_id) FILTER (WHERE t.status = 'open' AND t.due_date < CURRENT_DATE) AS overdue,
                CASE WHEN COUNT(t.task_id) > 0
                     THEN ROUND(100.0 * COUNT(t.task_id) FILTER (WHERE t.status = 'done') / COUNT(t.task_id), 1)
                     ELSE 0 END AS completion_pct
            FROM users u
            LEFT JOIN tasks t ON t.user_id = u.user_id OR t.assigned_to = u.user_id
            WHERE COALESCE(u.is_active, true) = true
            GROUP BY u.user_id, u.full_name, u.name, u.email, u.role
            ORDER BY total DESC NULLS LAST
        """)
        members = [dict(r) for r in cur.fetchall()]

        cur.execute("""
            SELECT
                u.user_id::text,
                COALESCE(t.priority, 'none') AS priority,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE t.status = 'done') AS done
            FROM users u
            JOIN tasks t ON t.user_id = u.user_id OR t.assigned_to = u.user_id
            WHERE COALESCE(u.is_active, true) = true
            GROUP BY u.user_id, priority
        """)
        priority_rows = [dict(r) for r in cur.fetchall()]

        return {"members": members, "priority_breakdown": priority_rows}
    finally:
        conn.close()


@router.get("/crm")
def get_crm_metrics(request: Request = None):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        cur.execute("""
            SELECT
                stage,
                COUNT(*) AS count,
                COALESCE(SUM(expected_revenue), 0) AS total_revenue,
                COALESCE(AVG(probability), 0) AS avg_probability,
                COALESCE(SUM(expected_revenue * COALESCE(probability,0) / 100), 0) AS weighted_revenue
            FROM crm_deals
            WHERE NOT COALESCE(archived, false)
            GROUP BY stage
            ORDER BY count DESC
        """)
        deals_by_stage = [
            {**dict(r), "total_revenue": float(r["total_revenue"]),
             "avg_probability": float(r["avg_probability"]),
             "weighted_revenue": float(r["weighted_revenue"])}
            for r in cur.fetchall()
        ]

        cur.execute("""
            SELECT
                COUNT(*) AS total_deals,
                COALESCE(SUM(expected_revenue), 0) AS total_pipeline,
                COALESCE(SUM(expected_revenue * COALESCE(probability,0) / 100), 0) AS weighted_pipeline
            FROM crm_deals
            WHERE NOT COALESCE(archived, false)
        """)
        row = cur.fetchone()
        pipeline = {
            "total_deals": row["total_deals"],
            "total_pipeline": float(row["total_pipeline"]),
            "weighted_pipeline": float(row["weighted_pipeline"]),
        }

        cur.execute("""
            SELECT
                COALESCE(section, 'other') AS section,
                COALESCE(stage, 'No Stage') AS stage,
                COUNT(*) AS count,
                COALESCE(SUM(expected_revenue), 0) AS total_revenue
            FROM projects
            WHERE COALESCE(status, 'active') = 'active'
            GROUP BY section, stage
            ORDER BY section, count DESC
        """)
        projects_by_stage = [
            {**dict(r), "total_revenue": float(r["total_revenue"])}
            for r in cur.fetchall()
        ]

        cur.execute("""
            SELECT
                p.name,
                COALESCE(p.section, 'other') AS section,
                COALESCE(p.stage, '—') AS stage,
                COUNT(t.task_id) FILTER (WHERE t.status = 'open') AS open_tasks,
                COUNT(t.task_id) FILTER (WHERE t.status = 'open' AND t.due_date < CURRENT_DATE) AS overdue_tasks
            FROM projects p
            LEFT JOIN tasks t ON t.project_id = p.project_id
            WHERE COALESCE(p.status, 'active') = 'active'
            GROUP BY p.project_id, p.name, p.section, p.stage
            HAVING COUNT(t.task_id) FILTER (WHERE t.status = 'open') > 0
            ORDER BY open_tasks DESC
            LIMIT 10
        """)
        project_tasks = [dict(r) for r in cur.fetchall()]

        return {
            "pipeline": pipeline,
            "deals_by_stage": deals_by_stage,
            "projects_by_stage": projects_by_stage,
            "project_tasks": project_tasks,
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# KPI Dashboard
# ---------------------------------------------------------------------------

@router.get("/kpis")
def get_kpis(request: Request = None):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        today = date.today()
        week_ago = today - timedelta(days=7)
        # Monday of the current week
        week_start = today - timedelta(days=today.weekday())

        # ── Sales: outreach touches per week (last 8 weeks) ──────────────────
        # "Touch" = unique contact reached via call, meeting, or direct 1-to-1 email
        # (group/blast emails excluded via is_group_email metadata flag)
        cur.execute("""
            SELECT
                DATE_TRUNC('week', occurred_at)::date AS week,
                COUNT(DISTINCT contact_id) AS unique_contacts,
                COUNT(*) FILTER (WHERE interaction_type IN ('call','meeting')) AS calls_meetings,
                COUNT(*) FILTER (
                    WHERE interaction_type = 'email_sent'
                      AND (metadata->>'is_group_email')::bool IS NOT TRUE
                ) AS direct_emails
            FROM contact_interactions
            WHERE occurred_at >= NOW() - INTERVAL '8 weeks'
              AND (
                interaction_type IN ('call','meeting')
                OR (interaction_type = 'email_sent'
                    AND (metadata->>'is_group_email')::bool IS NOT TRUE)
              )
            GROUP BY week ORDER BY week
        """)
        outreach_by_week = [
            {"week": str(r["week"]), "unique_contacts": r["unique_contacts"],
             "calls_meetings": r["calls_meetings"], "direct_emails": r["direct_emails"]}
            for r in cur.fetchall()
        ]

        # ── Sales: this-week detail ──────────────────────────────────────────
        cur.execute("""
            SELECT
                COUNT(DISTINCT contact_id) AS unique_contacts,
                COUNT(*) FILTER (WHERE interaction_type IN ('call','meeting')) AS calls_meetings,
                COUNT(*) FILTER (
                    WHERE interaction_type = 'email_sent'
                      AND (metadata->>'is_group_email')::bool IS NOT TRUE
                ) AS direct_emails
            FROM contact_interactions
            WHERE occurred_at >= %s
              AND (
                interaction_type IN ('call','meeting')
                OR (interaction_type = 'email_sent'
                    AND (metadata->>'is_group_email')::bool IS NOT TRUE)
              )
        """, (week_start,))
        outreach_week = dict(cur.fetchone())

        # ── Sales: new leads this week (from sales_leads / CRM pipeline) ────
        cur.execute("""
            SELECT id::text, company, reach_out_status, priority, created_at
            FROM sales_leads
            WHERE NOT archived AND created_at >= %s
            ORDER BY created_at DESC
        """, (week_start,))
        new_leads_this_week = [
            {"id": r["id"], "title": r["company"],
             "stage": r["reach_out_status"] or "New",
             "priority": r["priority"]}
            for r in cur.fetchall()
        ]

        # ── Sales: pipeline by stage ─────────────────────────────────────────
        cur.execute("""
            SELECT
                stage,
                COUNT(*) AS count,
                COALESCE(SUM(expected_revenue), 0) AS pipeline_value,
                COALESCE(AVG(expected_revenue), 0) AS avg_value,
                ARRAY_AGG(deal_id::text ORDER BY created_at DESC) AS deal_ids,
                ARRAY_AGG(title ORDER BY created_at DESC) AS deal_titles
            FROM crm_deals
            WHERE NOT archived
            GROUP BY stage
            ORDER BY
                CASE stage
                    WHEN 'New' THEN 1
                    WHEN 'Qualified' THEN 2
                    WHEN 'Initial Testing' THEN 3
                    WHEN 'Proposition' THEN 4
                    WHEN 'Won' THEN 5
                    ELSE 6
                END
        """)
        pipeline_stages = [
            {
                "stage": r["stage"],
                "count": r["count"],
                "pipeline_value": float(r["pipeline_value"]),
                "avg_value": float(r["avg_value"]),
                "deal_ids": r["deal_ids"],
                "deal_titles": r["deal_titles"],
            }
            for r in cur.fetchall()
        ]

        cur.execute("""
            SELECT
                COALESCE(SUM(expected_revenue), 0) AS total,
                COALESCE(AVG(expected_revenue), 0) AS avg_deal
            FROM crm_deals WHERE NOT archived
        """)
        pipe_totals = cur.fetchone()

        # ── Sales: average sales cycle (days) for Won deals ──────────────────
        cur.execute("""
            SELECT ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400), 1) AS avg_days
            FROM crm_deals
            WHERE NOT archived AND stage = 'Won'
        """)
        cycle_row = cur.fetchone()
        avg_sales_cycle_days = float(cycle_row["avg_days"]) if cycle_row["avg_days"] else None

        # ── Sales: warm intros ────────────────────────────────────────────────
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'Committed') AS committed,
                COUNT(*) FILTER (WHERE intro_type = 'Warm') AS warm_total,
                COUNT(*) FILTER (WHERE intro_type = 'Warm' AND status = 'Committed') AS warm_committed
            FROM dilutive_investors
        """)
        warm_row = dict(cur.fetchone())

        # ── Sales: conversion by market segment (keyword match on title) ──────
        segments = [
            ("Bakery", ["bakery", "bread", "bake", "pastry", "dough"]),
            ("Cocoa", ["cocoa", "chocolate", "cacao"]),
            ("Central Valley", ["central valley"]),
        ]
        conversion_by_segment = []
        for seg_name, kws in segments:
            pattern = "%(" + "|".join(kws) + ")%"
            like_clauses = " OR ".join(
                f"LOWER(title) LIKE '%%{kw}%%' OR LOWER(description) LIKE '%%{kw}%%'"
                for kw in kws
            )
            cur.execute(f"""
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE stage = 'Won') AS won,
                    COUNT(*) FILTER (WHERE stage NOT IN ('Inactive','Won')) AS active,
                    ARRAY_AGG(deal_id::text ORDER BY created_at DESC) AS deal_ids,
                    ARRAY_AGG(title ORDER BY created_at DESC) AS deal_titles
                FROM crm_deals
                WHERE NOT archived AND ({like_clauses})
            """)
            row = cur.fetchone()
            conversion_by_segment.append({
                "segment": seg_name,
                "total": row["total"],
                "won": row["won"],
                "active": row["active"],
                "conversion_pct": round(100 * row["won"] / row["total"], 1) if row["total"] else 0,
                "deal_ids": row["deal_ids"] or [],
                "deal_titles": row["deal_titles"] or [],
            })

        # ── Sales: TEA reports ────────────────────────────────────────────────
        os.makedirs(REPORTS_DIR, exist_ok=True)
        tea_reports = sorted(f for f in os.listdir(REPORTS_DIR) if f.endswith(".docx"))

        # ── Operations: active deployments ───────────────────────────────────
        cur.execute("""
            SELECT
                project_id::text, name, stage, updated_at
            FROM projects
            WHERE status = 'active'
              AND stage IN ('R&D','Pilot','Production','Initial Testing','Contracted')
            ORDER BY updated_at DESC
        """)
        active_deployments = [
            {"id": r["project_id"], "name": r["name"], "stage": r["stage"]}
            for r in cur.fetchall()
        ]

        # ── Operations: avg contract-to-deployment days ───────────────────────
        # Approximate: projects at Pilot/Production stage, use (updated_at - date_start) when date_start set
        cur.execute("""
            SELECT ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - date_start::timestamptz)) / 86400), 1) AS avg_days
            FROM projects
            WHERE status = 'active'
              AND stage IN ('Pilot','Production')
              AND date_start IS NOT NULL
        """)
        depl_row = cur.fetchone()
        avg_contract_to_deployment_days = float(depl_row["avg_days"]) if depl_row["avg_days"] else None

        # ── Operations: open equipment milestones ─────────────────────────────
        cur.execute("""
            SELECT
                pm.milestone_id::text AS id, pm.title, pm.status,
                p.name AS project_name, p.project_id::text
            FROM project_milestones pm
            JOIN projects p ON p.project_id = pm.project_id
            WHERE pm.status NOT IN ('complete','done','completed')
              AND (LOWER(pm.title) LIKE '%%equipment%%'
                   OR LOWER(pm.title) LIKE '%%sourc%%'
                   OR LOWER(pm.title) LIKE '%%procurement%%')
            ORDER BY pm.due_date NULLS LAST
        """)
        equipment_milestones = [
            {"id": r["id"], "title": r["title"], "status": r["status"],
             "project_name": r["project_name"], "project_id": r["project_id"]}
            for r in cur.fetchall()
        ]

        # ── Financial: burn rate from FPA actuals (respects burn_mode setting) ──
        from app.routers.fpa import (
            _fetch_active_model as _fpa_fetch_model,
            _compute_kpis as _fpa_compute_kpis,
            _get_manual_monthly as _fpa_manual_monthly,
            _get_pending_liabilities as _fpa_pending_liabilities,
            _actuals_floats as _fpa_actuals_floats,
        )

        cur.execute("SELECT * FROM fpa_actuals ORDER BY pulled_at DESC LIMIT 1")
        fpa_actuals_row = cur.fetchone()
        fpa_model_row = _fpa_fetch_model(cur)

        current_month_burn = 0.0
        runway_months = None
        net_burn = 0.0
        cash_balance = 0.0
        burn_mode = (fpa_model_row or {}).get("burn_mode", "auto")

        if fpa_actuals_row:
            actuals = _fpa_actuals_floats(dict(fpa_actuals_row))
            manual_monthly = _fpa_manual_monthly(fpa_model_row)
            kpis = _fpa_compute_kpis(
                actuals,
                manual_monthly,
                _fpa_pending_liabilities(fpa_model_row),
                (fpa_model_row or {}).get("excluded_burn_categories"),
            )
            current_month_burn = kpis["burn_rate_monthly"]
            runway_months = kpis["runway_months"]
            net_burn = kpis["net_burn_monthly"]
            cash_balance = kpis["cash_balance"]

        # Projected revenue / YTD from FPA projection model
        projected_annual_revenue = 0.0
        ytd_revenue = 0.0
        ytd_opex = 0.0

        cur.execute("SELECT monthly_data FROM fpa_model WHERE is_active ORDER BY uploaded_at DESC LIMIT 1")
        fpa_proj_row = cur.fetchone()
        if fpa_proj_row and fpa_proj_row["monthly_data"]:
            monthly = fpa_proj_row["monthly_data"]
            cy = today.year
            cm = today.month
            yr_months = [m for m in monthly if m.get("year") == cy]
            projected_annual_revenue = sum(float(m.get("total_revenue", 0)) for m in yr_months)
            ytd_months = [m for m in yr_months if m.get("month", 0) < cm]
            ytd_revenue = sum(float(m.get("total_revenue", 0)) for m in ytd_months)
            ytd_opex = sum(float(m.get("total_opex", 0)) for m in ytd_months)

        # ── Capital: committed vs target ──────────────────────────────────────
        cur.execute("""
            SELECT
                COALESCE(SUM(amount_raised) FILTER (WHERE status = 'closed'), 0) AS committed,
                COALESCE(SUM(amount_raised), 0) AS total_raised,
                COALESCE(SUM(amount_raised) FILTER (WHERE status = 'open'), 0) AS open_round_committed
            FROM cap_table_rounds
        """)
        cap_row = dict(cur.fetchone())

        cur.execute("""
            SELECT status, COUNT(*) AS count,
                   ARRAY_AGG(investor_id::text) AS ids,
                   ARRAY_AGG(COALESCE(name, firm, 'Unknown')) AS names
            FROM dilutive_investors
            GROUP BY status ORDER BY count DESC
        """)
        investor_status = [
            {"status": r["status"], "count": r["count"], "ids": r["ids"], "names": r["names"]}
            for r in cur.fetchall()
        ]

        cur.execute("""
            SELECT COUNT(*) AS count,
                   ARRAY_AGG(cd.document_id::text) AS ids,
                   ARRAY_AGG(cd.name) AS names
            FROM cap_table_documents cd
            WHERE cd.doc_type = 'term_sheet' AND cd.signed_date IS NULL
        """)
        ts_row = dict(cur.fetchone())

        # Investor meetings this week = interactions with contacts tagged 'investor'
        cur.execute("""
            SELECT COUNT(*) AS count
            FROM contact_interactions ci
            JOIN contacts c ON c.contact_id = ci.contact_id
            WHERE ci.interaction_type IN ('call','meeting')
              AND ci.occurred_at >= %s
              AND (
                c.tags @> ARRAY['investor']
                OR EXISTS (
                    SELECT 1 FROM contact_relationships cr
                    WHERE (cr.contact_a_id = c.contact_id OR cr.contact_b_id = c.contact_id)
                      AND cr.relationship_type = 'investor'
                )
              )
        """, (week_start,))
        inv_meetings_count = cur.fetchone()["count"]

        return {
            "as_of": str(today),
            "week_start": str(week_start),
            "sales": {
                "source_url": "/crm",
                "outreach_by_week": outreach_by_week,
                "outreach_this_week": outreach_week,  # keys: unique_contacts, calls_meetings, direct_emails
                "new_leads_this_week": new_leads_this_week,
                "pipeline_stages": pipeline_stages,
                "total_pipeline": float(pipe_totals["total"]),
                "avg_deal_size": float(pipe_totals["avg_deal"]),
                "avg_sales_cycle_days": avg_sales_cycle_days,
                "warm_intros": warm_row,
                "conversion_by_segment": conversion_by_segment,
                "tea_reports": [{"filename": f} for f in tea_reports],
            },
            "operations": {
                "source_url": "/projects",
                "active_deployments": active_deployments,
                "avg_contract_to_deployment_days": avg_contract_to_deployment_days,
                "open_equipment_milestones": equipment_milestones,
            },
            "financial": {
                "source_url": "/fpa",
                "current_month_burn": current_month_burn,
                "net_burn": net_burn,
                "cash_balance": cash_balance,
                "burn_mode": burn_mode,
                "projected_annual_revenue": projected_annual_revenue,
                "runway_months": runway_months,
                "ytd_revenue": ytd_revenue,
                "ytd_opex": ytd_opex,
            },
            "capital": {
                "source_url": "/funding",
                "committed_capital": float(cap_row["committed"]),
                "open_round_committed": float(cap_row["open_round_committed"]),
                "total_raised": float(cap_row["total_raised"]),
                "investor_status": investor_status,
                "term_sheets_outstanding": ts_row["count"],
                "term_sheet_names": ts_row["names"] or [],
                "investor_meetings_this_week": inv_meetings_count,
            },
        }
    finally:
        conn.close()
