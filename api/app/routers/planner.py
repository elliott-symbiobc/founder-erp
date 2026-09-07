"""
planner.py — AI-powered daily & weekly planning.

GET  /planner/today                 — today's plan + blocks
GET  /planner/week                  — current week plan + daily breakdown
POST /planner/generate              — (re)generate today's plan
POST /planner/week/generate         — (re)generate this week's plan
POST /planner/brain-dump            — extract tasks from free text, append to plan
POST /planner/blocks/{id}/approve   — confirm draft → GCal confirmed
POST /planner/blocks/{id}/complete  — mark done + log actual time
PATCH /planner/blocks/{id}          — edit block title/time
DELETE /planner/blocks/{id}         — reject block + delete GCal draft
GET  /planner/logs                  — list time logs
POST /planner/logs                  — create time log
"""
import json
import logging
import os
from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

import httpx
import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from app.routers.auth import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/planner", tags=["planner"])

CST = ZoneInfo("America/Chicago")
WORK_START = 8    # 8 AM CST
WORK_END   = 21   # 9 PM CST
GCAL_BASE  = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
AI_MODEL   = "claude-sonnet-4-6"


# ── Models ─────────────────────────────────────────────────────────────────────

class BlockPatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    start_time: Optional[str] = None  # ISO or HH:MM
    end_time: Optional[str] = None

class CompleteBlock(BaseModel):
    actual_minutes: int
    note: Optional[str] = None

class BrainDump(BaseModel):
    text: str

class TimeLogCreate(BaseModel):
    block_id: Optional[str] = None
    task_id: Optional[str] = None
    description: Optional[str] = None
    logged_minutes: int
    log_date: Optional[str] = None

class InstructionsUpdate(BaseModel):
    instructions: str


# ── DB helpers ─────────────────────────────────────────────────────────────────

def _conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _fmt_block(row: dict) -> dict:
    d = dict(row)
    for f in ("block_id", "plan_id", "user_id"):
        if d.get(f): d[f] = str(d[f])
    for f in ("start_time", "end_time", "completed_at", "created_at"):
        if d.get(f) and hasattr(d[f], "isoformat"): d[f] = d[f].isoformat()
    return d


def _get_plan_with_blocks(conn, plan_id: str, user_id: str) -> dict:
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM daily_plans WHERE plan_id = %s::uuid", (plan_id,))
    plan = dict(cur.fetchone())
    for f in ("plan_id", "user_id", "weekly_plan_id"):
        if plan.get(f): plan[f] = str(plan[f])
    for f in ("plan_date", "generated_at", "updated_at"):
        if plan.get(f) and hasattr(plan[f], "isoformat"): plan[f] = plan[f].isoformat()
    cur.execute(
        "SELECT * FROM plan_blocks WHERE plan_id = %s::uuid ORDER BY start_time",
        (plan_id,),
    )
    plan["blocks"] = [_fmt_block(r) for r in cur.fetchall()]
    return plan


# ── Context gathering ──────────────────────────────────────────────────────────

def _gather_context(conn, user_id: str) -> dict:
    """Pull all relevant planning data from DB for this user."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    today = datetime.now(CST).date()

    # User's standing planner instructions
    cur.execute("SELECT planner_instructions FROM users WHERE user_id = %s::uuid", (user_id,))
    row = cur.fetchone()
    planner_instructions = (row["planner_instructions"] or "").strip() if row else ""

    # Open tasks
    cur.execute("""
        SELECT t.task_id::text, t.title, t.description, t.due_date, t.estimated_minutes,
               p.name AS project_name, p.status AS project_status,
               p.expected_revenue, p.stage AS project_stage,
               c.name AS contact_name, c.is_client, c.organization
        FROM tasks t
        LEFT JOIN projects p ON p.project_id = t.project_id
        LEFT JOIN contacts c ON c.contact_id = t.contact_id
        WHERE t.user_id = %s::uuid AND t.status = 'open'
        ORDER BY
            CASE WHEN t.due_date IS NOT NULL AND t.estimated_minutes IS NOT NULL THEN 0
                 WHEN t.due_date IS NOT NULL THEN 1
                 ELSE 2 END,
            t.due_date ASC NULLS LAST,
            t.created_at ASC
        LIMIT 60
    """, (user_id,))
    tasks = []
    for r in cur.fetchall():
        d = dict(r)
        if d.get("due_date") and hasattr(d["due_date"], "isoformat"):
            d["due_date"] = d["due_date"].isoformat()
        tasks.append(d)

    # Open contact reminders
    cur.execute("""
        SELECT cr.reminder_id::text, cr.reminder_type, cr.title, cr.description,
               cr.due_date, cr.created_at,
               c.name AS contact_name, c.is_client, c.organization,
               EXTRACT(DAY FROM NOW() - cr.created_at)::int AS age_days
        FROM contact_reminders cr
        JOIN contacts c ON c.contact_id = cr.contact_id
        WHERE cr.resolved = false
        ORDER BY cr.due_date ASC NULLS LAST, cr.created_at ASC
        LIMIT 40
    """)
    reminders = []
    for r in cur.fetchall():
        d = dict(r)
        if d.get("due_date") and hasattr(d["due_date"], "isoformat"):
            d["due_date"] = d["due_date"].isoformat()
        if d.get("created_at") and hasattr(d["created_at"], "isoformat"):
            d["created_at"] = d["created_at"].isoformat()
        reminders.append(d)

    # Active projects
    cur.execute("""
        SELECT p.project_id::text, p.name, p.description, p.stage, p.status,
               p.expected_revenue, p.probability, p.date_deadline,
               c.name AS contact_name, c.is_client
        FROM projects p
        LEFT JOIN contacts c ON c.contact_id = p.contact_id
        WHERE p.status IN ('active', 'at_risk', 'off_track')
        ORDER BY p.expected_revenue DESC NULLS LAST, p.date_deadline ASC NULLS LAST
        LIMIT 20
    """)
    projects = []
    for r in cur.fetchall():
        d = dict(r)
        if d.get("date_deadline") and hasattr(d["date_deadline"], "isoformat"):
            d["date_deadline"] = d["date_deadline"].isoformat()
        projects.append(d)

    # FP&A actuals — optional, rollback on error so the connection stays usable
    fpa = {}
    try:
        cur.execute("""
            SELECT cash_balance, monthly_inflow, monthly_outflow, net_burn
            FROM fpa_actuals ORDER BY created_at DESC LIMIT 1
        """)
        row = cur.fetchone()
        if row: fpa = dict(row)
    except Exception:
        conn.rollback()

    # QBO recent revenue
    qbo = []
    try:
        cur.execute("""
            SELECT revenue, expenses, net_income, period_start::text, period_end::text
            FROM fpa_qbo_periods WHERE period_type = 'monthly'
            ORDER BY period_start DESC LIMIT 3
        """)
        qbo = [dict(r) for r in cur.fetchall()]
    except Exception:
        conn.rollback()

    # Recent completions (yesterday's done tasks for context)
    yesterday = today - timedelta(days=1)
    try:
        cur.execute("""
            SELECT COUNT(*) AS done_count FROM plan_blocks
            WHERE user_id = %s::uuid AND status = 'done'
              AND start_time::date = %s
        """, (user_id, yesterday))
        row = cur.fetchone()
        yesterday_done = row["done_count"] if row else 0

        cur.execute("""
            SELECT COUNT(*) AS total_count FROM plan_blocks
            WHERE user_id = %s::uuid AND status != 'skipped'
              AND start_time::date = %s
        """, (user_id, yesterday))
        row = cur.fetchone()
        yesterday_total = row["total_count"] if row else 0
    except Exception:
        conn.rollback()
        yesterday_done = 0
        yesterday_total = 0

    return {
        "tasks": tasks,
        "reminders": reminders,
        "projects": projects,
        "fpa": fpa,
        "qbo": qbo,
        "yesterday_done": yesterday_done,
        "yesterday_total": yesterday_total,
        "today": today.isoformat(),
        "planner_instructions": planner_instructions,
    }


def _gather_omnipresent_context(conn, user_id: str) -> dict:
    """Pull cross-module data for the omnipresent dashboard chat assistant."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Recent meeting notes (with AI summaries + action items)
    recent_notes = []
    try:
        cur.execute("""
            SELECT title, ai_summary, action_items,
                   created_at::date AS note_date,
                   calendar_event_title
            FROM notes
            WHERE user_id = %s::uuid
              AND ai_summary IS NOT NULL AND ai_summary != ''
            ORDER BY created_at DESC LIMIT 5
        """, (user_id,))
        for r in cur.fetchall():
            d = dict(r)
            if d.get("note_date") and hasattr(d["note_date"], "isoformat"):
                d["note_date"] = d["note_date"].isoformat()
            recent_notes.append(d)
    except Exception:
        conn.rollback()

    # Key client contacts with AI summaries
    key_contacts = []
    try:
        cur.execute("""
            SELECT name, organization, title, ai_summary,
                   last_interaction_at::date AS last_seen
            FROM contacts
            WHERE (is_client = true OR ai_summary IS NOT NULL)
              AND NOT COALESCE(archived, false)
              AND ai_summary IS NOT NULL AND ai_summary != ''
            ORDER BY is_client DESC NULLS LAST,
                     last_interaction_at DESC NULLS LAST
            LIMIT 10
        """)
        for r in cur.fetchall():
            d = dict(r)
            if d.get("last_seen") and hasattr(d["last_seen"], "isoformat"):
                d["last_seen"] = d["last_seen"].isoformat()
            key_contacts.append(d)
    except Exception:
        conn.rollback()

    # Active funding opportunities
    funding = []
    try:
        cur.execute("""
            SELECT title, stage, deadline::text, amount, funding_type
            FROM funding_opportunities
            WHERE stage NOT IN ('Rejected', 'Closed')
            ORDER BY deadline ASC NULLS LAST LIMIT 6
        """)
        funding = [dict(r) for r in cur.fetchall()]
    except Exception:
        conn.rollback()

    return {
        "recent_notes": recent_notes,
        "key_contacts": key_contacts,
        "funding": funding,
    }



def _fmt_recent_notes(notes: list) -> str:
    if not notes:
        return "No recent meeting notes."
    lines = []
    for n in notes:
        actions = n.get("action_items") or []
        if isinstance(actions, list):
            action_str = "; ".join(
                (a.get("title") or a) if isinstance(a, dict) else str(a)
                for a in actions[:3]
            )
        else:
            action_str = ""
        lines.append(
            f"  [{n.get('note_date', '?')}] {n['title']}"
            + (f" (re: {n['calendar_event_title']})" if n.get("calendar_event_title") else "")
            + f": {(n.get('ai_summary') or '')[:150]}"
            + (f" | Actions: {action_str}" if action_str else "")
        )
    return "\n".join(lines)


def _fmt_key_contacts(contacts: list) -> str:
    if not contacts:
        return "No contacts with AI summaries."
    lines = []
    for c in contacts:
        org = f" ({c['organization']})" if c.get("organization") else ""
        title = f" — {c['title']}" if c.get("title") else ""
        lines.append(
            f"  {c['name']}{org}{title}: {(c.get('ai_summary') or '')[:180]}"
        )
    return "\n".join(lines)




def _fmt_funding(funding: list) -> str:
    if not funding:
        return "No active funding opportunities."
    lines = []
    for f in funding:
        dl = f" | Deadline: {f['deadline']}" if f.get("deadline") else ""
        amt = f" | {f['amount']}" if f.get("amount") else ""
        lines.append(f"  [{f['stage']}] {f['title']}{amt}{dl}")
    return "\n".join(lines)


# ── GCal helpers ───────────────────────────────────────────────────────────────

def _get_gcal_events(token: str, start_date: date, end_date: date) -> list:
    resp = httpx.get(
        GCAL_BASE,
        headers={"Authorization": f"Bearer {token}"},
        params={
            "timeMin": datetime(start_date.year, start_date.month, start_date.day, 0, 0, tzinfo=CST).isoformat(),
            "timeMax": datetime(end_date.year, end_date.month, end_date.day, 23, 59, tzinfo=CST).isoformat(),
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": 50,
        },
        timeout=10,
    )
    if resp.status_code != 200:
        return []
    events = []
    for ev in resp.json().get("items", []):
        start = ev.get("start", {})
        end   = ev.get("end", {})
        events.append({
            "title": ev.get("summary", "Busy"),
            "start": start.get("dateTime") or start.get("date"),
            "end":   end.get("dateTime")   or end.get("date"),
            "all_day": "date" in start and "dateTime" not in start,
        })
    return events


def _create_gcal_draft(token: str, title: str, desc: str, start_dt: datetime, end_dt: datetime) -> Optional[str]:
    try:
        resp = httpx.post(
            GCAL_BASE,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={
                "summary": f"🎯 {title}",
                "description": desc or "",
                "start": {"dateTime": start_dt.isoformat(), "timeZone": "America/Chicago"},
                "end":   {"dateTime": end_dt.isoformat(),   "timeZone": "America/Chicago"},
                "status": "tentative",
                "colorId": "7",  # peacock blue
                "reminders": {"useDefault": False},
            },
            timeout=10,
        )
        if resp.status_code in (200, 201):
            return resp.json().get("id")
    except Exception as e:
        logger.warning("GCal draft creation failed: %s", e)
    return None


def _confirm_gcal_event(token: str, event_id: str):
    try:
        httpx.patch(
            f"{GCAL_BASE}/{event_id}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"status": "confirmed", "colorId": "2"},  # sage green
            timeout=8,
        )
    except Exception as e:
        logger.warning("GCal confirm failed: %s", e)


def _delete_gcal_event(token: str, event_id: str):
    try:
        httpx.delete(f"{GCAL_BASE}/{event_id}", headers={"Authorization": f"Bearer {token}"}, timeout=8)
    except Exception as e:
        logger.warning("GCal delete failed: %s", e)


# ── Prompt builders ────────────────────────────────────────────────────────────

def _fmt_fpa(fpa: dict, qbo: list) -> str:
    if not fpa and not qbo:
        return "No financial data connected."
    parts = []
    if fpa.get("cash_balance") is not None:
        cash = fpa["cash_balance"]
        burn = fpa.get("net_burn") or fpa.get("monthly_outflow", 0)
        parts.append(f"Cash: ${cash:,.0f}")
        if burn and burn > 0:
            runway = cash / burn
            parts.append(f"Monthly burn: ${burn:,.0f}")
            parts.append(f"Runway: {runway:.1f} months")
    if qbo:
        rev = qbo[0].get("revenue")
        if rev is not None:
            parts.append(f"Last month revenue: ${rev:,.0f}")
    return " | ".join(parts) if parts else "Financial data available but empty."


def _fmt_tasks(tasks: list, today: date) -> str:
    if not tasks:
        return "No open tasks."
    lines = []
    for t in tasks:
        due = t.get("due_date")
        est = t.get("estimated_minutes")
        if due:
            due_date = date.fromisoformat(due)
            if due_date < today:
                tag = f"[OVERDUE {(today - due_date).days}d]"
            elif due_date == today:
                tag = "[DUE TODAY]"
            elif due_date <= today + timedelta(days=3):
                tag = f"[DUE {(due_date - today).days}d]"
            else:
                tag = f"[due {due}]"
        else:
            tag = "[no deadline]"
        time_tag = f" [{est}min]" if est else ""
        project = f" | Project: {t['project_name']}" if t.get("project_name") else ""
        client  = " (CLIENT)" if t.get("is_client") else ""
        revenue = f" ${t['expected_revenue']:,.0f}" if t.get("expected_revenue") else ""
        contact = f" | Contact: {t['contact_name']}{client}{revenue}" if t.get("contact_name") else ""
        lines.append(f"  {tag}{time_tag} {t['title']}{project}{contact}")
    return "\n".join(lines)


def _fmt_reminders(reminders: list, today: date) -> str:
    if not reminders:
        return "No open reminders."
    lines = []
    for r in reminders:
        age = r.get("age_days", 0) or 0
        due = r.get("due_date")
        urgency = ""
        if due:
            due_date = date.fromisoformat(due)
            if due_date < today:
                urgency = f"[OVERDUE] "
            elif due_date == today:
                urgency = "[DUE TODAY] "
        elif age > 14:
            urgency = f"[{age}d old] "
        client  = " (CLIENT)" if r.get("is_client") else ""
        org     = f", {r['organization']}" if r.get("organization") else ""
        contact = f" — Contact: {r['contact_name']}{client}{org}" if r.get("contact_name") else ""
        lines.append(f"  {urgency}[{r['reminder_type']}] {r['title']}{contact}")
    return "\n".join(lines)


def _fmt_projects(projects: list, today: date) -> str:
    if not projects:
        return "No active projects."
    lines = []
    for p in projects:
        risk = " ⚠️ AT RISK" if p.get("status") in ("at_risk", "off_track") else ""
        rev  = f" | ${p['expected_revenue']:,.0f} potential" if p.get("expected_revenue") else ""
        dl   = ""
        if p.get("date_deadline"):
            dl_date = date.fromisoformat(p["date_deadline"])
            days = (dl_date - today).days
            dl = f" | deadline in {days}d" if days >= 0 else f" | DEADLINE PASSED {-days}d ago"
        lines.append(f"  {p['name']} — {p['stage']} / {p['status']}{risk}{rev}{dl}")
    return "\n".join(lines)


def _fmt_gcal(events: list) -> str:
    if not events:
        return "No existing calendar events."
    lines = []
    for ev in events:
        start = ev.get("start", "")
        end   = ev.get("end",   "")
        if "T" in str(start):
            try:
                s = datetime.fromisoformat(start).astimezone(CST).strftime("%H:%M")
                e = datetime.fromisoformat(end).astimezone(CST).strftime("%H:%M")
                lines.append(f"  {s}-{e}  {ev['title']}")
            except Exception:
                lines.append(f"  {ev['title']}")
        else:
            lines.append(f"  [All day] {ev['title']}")
    return "\n".join(lines)


def _build_daily_prompt(ctx: dict, gcal: list, plan_date: date, weekly_summary: str) -> str:
    today = plan_date
    dow   = plan_date.strftime("%A")
    tasks_str    = _fmt_tasks(ctx["tasks"], today)
    remind_str   = _fmt_reminders(ctx["reminders"], today)
    project_str  = _fmt_projects(ctx["projects"], today)
    fpa_str      = _fmt_fpa(ctx.get("fpa", {}), ctx.get("qbo", []))
    gcal_str     = _fmt_gcal(gcal)
    yesterday_ctx = ""
    if ctx.get("yesterday_total", 0) > 0:
        pct = int(ctx["yesterday_done"] / ctx["yesterday_total"] * 100)
        yesterday_ctx = f"\nYesterday: completed {ctx['yesterday_done']}/{ctx['yesterday_total']} blocks ({pct}%)."

    instructions = ctx.get("planner_instructions", "").strip()
    instructions_block = f"\n=== USER'S STANDING INSTRUCTIONS (follow these strictly) ===\n{instructions}\n" if instructions else ""

    return f"""You are an elite executive assistant and strategic planning expert. Create a realistic, prioritized daily schedule.

DATE: {dow}, {plan_date.strftime("%B %d, %Y")}
WORKING HOURS: 8:00 AM – 9:00 PM Central Time{yesterday_ctx}
{instructions_block}
=== EXISTING CALENDAR (schedule AROUND these — no overlaps) ===
{gcal_str}

=== OPEN TASKS ===
{tasks_str}

=== CONTACT REMINDERS ===
{remind_str}

=== ACTIVE PROJECTS ===
{project_str}

=== FINANCIAL CONTEXT ===
{fpa_str}

=== WEEKLY PLAN CONTEXT ===
{weekly_summary or "No weekly plan generated yet."}

=== PRIORITY RULES ===
0. ABSOLUTE: Tasks with BOTH a due date and an estimated time [Xmin] — these must be scheduled first, using their exact estimated duration. Schedule them before anything else, in due-date order.
1. CRITICAL: Tasks with a due date but no time estimate (treat as high-priority, use your own time estimate); items overdue >7 days; funding/investor activities; money/contracts/billing
2. HIGH: Due today or tomorrow; existing clients with high deal value (>$100K); at-risk projects
3. ELEVATED: Due this week; new large prospects; follow-ups >14 days old
4. NORMAL: Regular tasks and follow-ups <14 days old
5. LOW: Admin, research, low-value items

=== TIME ESTIMATES ===
- If a task has [Xmin] in its label, use EXACTLY that duration for its block — do not adjust it.
- For tasks without an estimate: Quick call or email: 15-30 min | Meeting prep: 30-45 min | Strategic document or investor deck: 90-180 min | Financial analysis or model work: 60-90 min | Admin batch: 20-30 min | Deep technical or creative work: 90-150 min

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{{
  "health_summary": "2-3 sentence company health snapshot covering cash position, pipeline health, and top priority for today",
  "blocks": [
    {{
      "title": "Concise action-oriented title (max 8 words)",
      "description": "What specifically to do in this block",
      "start": "HH:MM",
      "end": "HH:MM",
      "estimated_minutes": 60,
      "priority_score": 90.0,
      "priority_reason": "One sentence explaining why this is scheduled here and now",
      "block_type": "focus",
      "source_type": "reminder",
      "source_id": null
    }}
  ]
}}

CONSTRAINTS:
- All times are CST, 24-hour format (08:00-21:00 only)
- Do NOT overlap any existing calendar event
- Leave at least 10 minutes between blocks
- Maximum 10 blocks; minimum 15 minutes per block
- Target 8-10 hours of total scheduled time
- Sort blocks chronologically by start time
- If more items than time: prioritize ruthlessly, skip low-priority items
- block_type must be one of: focus, admin, break
- source_type must be one of: task, reminder, project, ad_hoc, or null
- source_id is the UUID string of the source item, or null"""


def _build_weekly_prompt(ctx: dict, gcal: list, week_start: date) -> str:
    week_end = week_start + timedelta(days=6)
    tasks_str   = _fmt_tasks(ctx["tasks"], week_start)
    remind_str  = _fmt_reminders(ctx["reminders"], week_start)
    project_str = _fmt_projects(ctx["projects"], week_start)
    fpa_str     = _fmt_fpa(ctx.get("fpa", {}), ctx.get("qbo", []))
    gcal_str    = _fmt_gcal(gcal)

    instructions = ctx.get("planner_instructions", "").strip()
    instructions_block = f"\n=== USER'S STANDING INSTRUCTIONS (follow these strictly) ===\n{instructions}\n" if instructions else ""

    return f"""You are an elite executive assistant. Create a strategic weekly plan.

WEEK: {week_start.strftime("%B %d")} – {week_end.strftime("%B %d, %Y")}
WORKING HOURS: 8:00 AM – 9:00 PM CST each day (Mon–Fri primary, Sat–Sun optional)
{instructions_block}
=== EXISTING CALENDAR COMMITMENTS THIS WEEK ===
{gcal_str}

=== ALL OPEN TASKS ===
{tasks_str}

=== CONTACT REMINDERS ===
{remind_str}

=== ACTIVE PROJECTS ===
{project_str}

=== FINANCIAL CONTEXT ===
{fpa_str}

Tasks marked [Xmin] have user-defined time estimates — treat those durations as fixed when allocating days.
Tasks with both a due date and [Xmin] are ABSOLUTE priority — schedule them on or before their due date.

Create a week-level strategic plan. Allocate themes and key items to each day. Be realistic about capacity.

Return ONLY valid JSON (no markdown):
{{
  "week_summary": "3-4 sentence strategic overview of the week: top priorities, key risks, what must get done",
  "ai_reasoning": "Explanation of how you allocated priorities across the week",
  "days": {{
    "monday":    {{"theme": "short theme label", "focus_areas": ["area1", "area2"], "key_items": ["specific item 1", "specific item 2", "specific item 3"]}},
    "tuesday":   {{"theme": "...", "focus_areas": [...], "key_items": [...]}},
    "wednesday": {{"theme": "...", "focus_areas": [...], "key_items": [...]}},
    "thursday":  {{"theme": "...", "focus_areas": [...], "key_items": [...]}},
    "friday":    {{"theme": "...", "focus_areas": [...], "key_items": [...]}}
  }}
}}"""


def _build_brain_dump_prompt(text: str) -> str:
    return f"""Extract discrete actionable items from this brain dump text. Classify each as a task or reminder.

BRAIN DUMP:
{text}

Return ONLY valid JSON:
{{
  "items": [
    {{
      "title": "Concise action title",
      "type": "task",
      "urgency": "high",
      "notes": "any context from the text or null"
    }}
  ]
}}

Rules:
- type: "task" (work item) or "reminder" (follow-up with a person/contact)
- urgency: "high" (do today), "medium" (this week), "low" (someday)
- Deduplicate if the same thing is mentioned twice
- Maximum 10 items"""


# ── Claude caller ──────────────────────────────────────────────────────────────

def _call_claude(prompt: str, max_tokens: int = 4096, agent_id: str = "planner_generate") -> dict:
    import anthropic
    try:
        from app.core.agent_config import get_agent_config
        cfg = get_agent_config(agent_id)
        model = cfg.get("model") or AI_MODEL
        max_tokens = cfg.get("max_tokens") or max_tokens
        extra = cfg.get("system_prompt_override") or ""
        if extra:
            prompt = extra.strip() + "\n\n" + prompt
    except Exception:
        model = AI_MODEL
    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
    msg = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = msg.content[0].text.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw)


# ── Block storage ──────────────────────────────────────────────────────────────

def _store_blocks(conn, plan_id: str, user_id: str, raw_blocks: list, plan_date: date, token: Optional[str]) -> list:
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    stored = []
    for b in raw_blocks:
        try:
            start_str = b.get("start", "09:00")
            end_str   = b.get("end",   "10:00")
            sh, sm = map(int, start_str.split(":"))
            eh, em = map(int, end_str.split(":"))
            start_dt = datetime(plan_date.year, plan_date.month, plan_date.day, sh, sm, tzinfo=CST)
            end_dt   = datetime(plan_date.year, plan_date.month, plan_date.day, eh, em, tzinfo=CST)
            if end_dt <= start_dt:
                end_dt = start_dt + timedelta(minutes=b.get("estimated_minutes", 60))
        except Exception:
            continue

        gcal_id = None
        if token:
            gcal_id = _create_gcal_draft(token, b.get("title", "Focus Block"), b.get("description"), start_dt, end_dt)

        cur.execute("""
            INSERT INTO plan_blocks
                (plan_id, user_id, title, description, start_time, end_time,
                 estimated_minutes, priority_score, priority_reason,
                 block_type, source_type, source_id, gcal_event_id)
            VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        """, (
            plan_id, user_id,
            b.get("title", "Focus Block"),
            b.get("description"),
            start_dt, end_dt,
            b.get("estimated_minutes"),
            b.get("priority_score", 50),
            b.get("priority_reason"),
            b.get("block_type", "focus"),
            b.get("source_type"),
            b.get("source_id"),
            gcal_id,
        ))
        stored.append(_fmt_block(cur.fetchone()))
    conn.commit()
    return stored


# ── Core plan runners ──────────────────────────────────────────────────────────

def run_daily_plan(user_id: str, plan_date: date, force: bool = False) -> dict:
    """Generate (or return existing) daily plan. Safe to call from Celery or endpoint."""
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        # Check existing
        cur.execute("SELECT * FROM daily_plans WHERE user_id=%s::uuid AND plan_date=%s", (user_id, plan_date))
        existing = cur.fetchone()
        if existing and not force:
            return _get_plan_with_blocks(conn, str(existing["plan_id"]), user_id)

        # Google token
        token = None
        try:
            from app.routers.contacts import _get_user_google_token
            token = _get_user_google_token(user_id)
        except Exception:
            pass

        # Gather context + GCal
        ctx = _gather_context(conn, user_id)
        gcal = []
        if token:
            try:
                gcal = _get_gcal_events(token, plan_date, plan_date)
            except Exception as e:
                logger.warning("GCal fetch failed for %s: %s", user_id, e)

        # Weekly context
        week_start = plan_date - timedelta(days=plan_date.weekday())
        cur.execute("SELECT week_summary FROM weekly_plans WHERE user_id=%s::uuid AND week_start=%s", (user_id, week_start))
        row = cur.fetchone()
        weekly_summary = row["week_summary"] if row else ""

        # Claude
        prompt = _build_daily_prompt(ctx, gcal, plan_date, weekly_summary)
        result = _call_claude(prompt)

        health = result.get("health_summary", "")
        raw_blocks = result.get("blocks", [])

        # Upsert plan
        if existing and force:
            # Delete old GCal events before deleting blocks
            if token:
                old_cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
                old_cur.execute("SELECT gcal_event_id FROM plan_blocks WHERE plan_id=%s::uuid", (str(existing["plan_id"]),))
                for row in old_cur.fetchall():
                    if row["gcal_event_id"]:
                        _delete_gcal_event(token, row["gcal_event_id"])
            cur.execute("DELETE FROM plan_blocks WHERE plan_id=%s::uuid", (str(existing["plan_id"]),))
            cur.execute("""
                UPDATE daily_plans SET health_summary=%s, generated_at=NOW(), updated_at=NOW()
                WHERE plan_id=%s::uuid
            """, (health, str(existing["plan_id"])))
            plan_id = str(existing["plan_id"])
        else:
            cur.execute("""
                INSERT INTO daily_plans (user_id, plan_date, health_summary)
                VALUES (%s::uuid, %s, %s) RETURNING plan_id
            """, (user_id, plan_date, health))
            plan_id = str(cur.fetchone()["plan_id"])

        conn.commit()
        blocks = _store_blocks(conn, plan_id, user_id, raw_blocks, plan_date, token)

        return {
            "plan_id": plan_id,
            "plan_date": plan_date.isoformat(),
            "health_summary": health,
            "blocks": blocks,
        }
    finally:
        conn.close()


def run_weekly_plan(user_id: str, week_start: date, force: bool = False) -> dict:
    """Generate (or return existing) weekly plan."""
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        cur.execute("SELECT * FROM weekly_plans WHERE user_id=%s::uuid AND week_start=%s", (user_id, week_start))
        existing = cur.fetchone()
        if existing and not force:
            plan = dict(existing)
            for f in ("plan_id", "user_id"):
                if plan.get(f): plan[f] = str(plan[f])
            if plan.get("week_start"): plan["week_start"] = plan["week_start"].isoformat()
            return plan

        token = None
        try:
            from app.routers.contacts import _get_user_google_token
            token = _get_user_google_token(user_id)
        except Exception:
            pass

        ctx  = _gather_context(conn, user_id)
        gcal = []
        if token:
            try:
                gcal = _get_gcal_events(token, week_start, week_start + timedelta(days=6))
            except Exception as e:
                logger.warning("Weekly GCal fetch failed: %s", e)

        prompt = _build_weekly_prompt(ctx, gcal, week_start)
        result = _call_claude(prompt, max_tokens=2048)

        week_summary  = result.get("week_summary", "")
        ai_reasoning  = result.get("ai_reasoning", "")

        if existing and force:
            cur.execute("""
                UPDATE weekly_plans SET week_summary=%s, ai_reasoning=%s, generated_at=NOW(), updated_at=NOW()
                WHERE plan_id=%s::uuid RETURNING plan_id
            """, (week_summary, ai_reasoning, str(existing["plan_id"])))
            plan_id = str(cur.fetchone()["plan_id"])
        else:
            cur.execute("""
                INSERT INTO weekly_plans (user_id, week_start, week_summary, ai_reasoning)
                VALUES (%s::uuid, %s, %s, %s) RETURNING plan_id
            """, (user_id, week_start, week_summary, ai_reasoning))
            plan_id = str(cur.fetchone()["plan_id"])

        conn.commit()
        return {
            "plan_id": plan_id,
            "week_start": week_start.isoformat(),
            "week_summary": week_summary,
            "ai_reasoning": ai_reasoning,
            "days": result.get("days", {}),
        }
    finally:
        conn.close()


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/today")
def get_today(request: Request):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    today = datetime.now(CST).date()
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT plan_id FROM daily_plans WHERE user_id=%s::uuid AND plan_date=%s", (user["user_id"], today))
        row = cur.fetchone()
        if not row:
            return {"plan_date": today.isoformat(), "health_summary": None, "blocks": [], "exists": False}
        return {**_get_plan_with_blocks(conn, str(row["plan_id"]), user["user_id"]), "exists": True}
    finally:
        conn.close()


@router.get("/week")
def get_week(request: Request):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    today = datetime.now(CST).date()
    week_start = today - timedelta(days=today.weekday())
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM weekly_plans WHERE user_id=%s::uuid AND week_start=%s", (user["user_id"], week_start))
        wp = cur.fetchone()
        if not wp:
            return {"week_start": week_start.isoformat(), "exists": False, "days": {}}
        plan = dict(wp)
        for f in ("plan_id", "user_id"):
            if plan.get(f): plan[f] = str(plan[f])
        if plan.get("week_start"): plan["week_start"] = plan["week_start"].isoformat()
        plan["exists"] = True

        # Attach daily completion stats
        stats = []
        for i in range(7):
            d = week_start + timedelta(days=i)
            cur.execute("""
                SELECT
                  COUNT(*) FILTER (WHERE status != 'rejected') AS total,
                  COUNT(*) FILTER (WHERE status = 'completed')  AS done,
                  COUNT(*) FILTER (WHERE status = 'approved')   AS approved,
                  COUNT(*) FILTER (WHERE status = 'draft')      AS draft
                FROM plan_blocks WHERE user_id=%s::uuid AND start_time::date=%s
            """, (user["user_id"], d))
            row = cur.fetchone()
            stats.append({"date": d.isoformat(), **dict(row)})
        plan["daily_stats"] = stats
        return plan
    finally:
        conn.close()


@router.get("/instructions")
def get_instructions(request: Request):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT planner_instructions FROM users WHERE user_id = %s::uuid", (user["user_id"],))
        row = cur.fetchone()
        return {"instructions": (row["planner_instructions"] or "") if row else ""}
    finally:
        conn.close()


@router.put("/instructions")
def save_instructions(body: InstructionsUpdate, request: Request):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE users SET planner_instructions = %s WHERE user_id = %s::uuid",
            (body.instructions.strip() or None, user["user_id"]),
        )
        conn.commit()
        return {"instructions": body.instructions.strip()}
    finally:
        conn.close()


@router.post("/generate")
def generate_today(request: Request, force: bool = Query(False)):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    today = datetime.now(CST).date()
    return run_daily_plan(user["user_id"], today, force=force)


@router.post("/week/generate")
def generate_week(request: Request, force: bool = Query(False)):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    today = datetime.now(CST).date()
    week_start = today - timedelta(days=today.weekday())
    return run_weekly_plan(user["user_id"], week_start, force=force)


@router.post("/brain-dump")
def brain_dump(body: BrainDump, request: Request):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    if not body.text.strip(): raise HTTPException(422, "Text required")

    # Extract items via Claude
    prompt = _build_brain_dump_prompt(body.text)
    try:
        result = _call_claude(prompt, max_tokens=1024)
        items  = result.get("items", [])
    except Exception as e:
        logger.error("Brain dump Claude call failed: %s", e)
        raise HTTPException(502, "AI extraction failed")

    conn = _conn()
    created_tasks = []
    created_reminders = []
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        today = datetime.now(CST).date()

        for item in items:
            title   = item.get("title", "").strip()
            urgency = item.get("urgency", "medium")
            notes   = item.get("notes")
            if not title: continue

            if item.get("type") == "reminder":
                cur.execute("""
                    INSERT INTO contact_reminders (contact_id, reminder_type, title, description)
                    SELECT contact_id, 'custom', %s, %s FROM contacts LIMIT 1
                """, (title, notes))
                # If no contacts, create as task instead
                if cur.rowcount == 0:
                    cur.execute("""
                        INSERT INTO tasks (user_id, assigned_to, title, description)
                        VALUES (%s::uuid, %s::uuid, %s, %s) RETURNING task_id
                    """, (user["user_id"], user["user_id"], title, notes))
                    created_tasks.append({"title": title, "urgency": urgency})
                else:
                    created_reminders.append({"title": title, "urgency": urgency})
            else:
                cur.execute("""
                    INSERT INTO tasks (user_id, assigned_to, title, description)
                    VALUES (%s::uuid, %s::uuid, %s, %s) RETURNING task_id::text
                """, (user["user_id"], user["user_id"], title, notes))
                row = cur.fetchone()
                created_tasks.append({"task_id": str(row["task_id"]), "title": title, "urgency": urgency})

        # Save brain dump text on today's plan if it exists
        cur.execute("""
            UPDATE daily_plans SET brain_dump = COALESCE(brain_dump || E'\n\n' || %s, %s), updated_at=NOW()
            WHERE user_id=%s::uuid AND plan_date=%s
        """, (body.text, body.text, user["user_id"], today))

        conn.commit()

        # Re-run plan if urgent items exist
        has_urgent = any(i.get("urgency") == "high" for i in items)
        if has_urgent:
            updated_plan = run_daily_plan(user["user_id"], today, force=True)
            return {
                "created_tasks": created_tasks,
                "created_reminders": created_reminders,
                "plan_updated": True,
                "plan": updated_plan,
            }

        return {
            "created_tasks": created_tasks,
            "created_reminders": created_reminders,
            "plan_updated": False,
        }
    finally:
        conn.close()


@router.post("/blocks/{block_id}/approve")
def approve_block(block_id: str, request: Request):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM plan_blocks WHERE block_id=%s::uuid AND user_id=%s::uuid", (block_id, user["user_id"]))
        block = cur.fetchone()
        if not block: raise HTTPException(404, "Block not found")
        if block["gcal_event_id"]:
            try:
                from app.routers.contacts import _get_user_google_token
                token = _get_user_google_token(user["user_id"])
                _confirm_gcal_event(token, block["gcal_event_id"])
            except Exception: pass
        cur.execute("UPDATE plan_blocks SET status='approved' WHERE block_id=%s::uuid RETURNING *", (block_id,))
        conn.commit()
        return _fmt_block(cur.fetchone())
    finally:
        conn.close()


@router.post("/blocks/approve-all")
def approve_all_blocks(request: Request):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    today = datetime.now(CST).date()
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT block_id::text, gcal_event_id FROM plan_blocks
            WHERE user_id=%s::uuid AND status='draft' AND start_time::date=%s
        """, (user["user_id"], today))
        blocks = cur.fetchall()
        token = None
        try:
            from app.routers.contacts import _get_user_google_token
            token = _get_user_google_token(user["user_id"])
        except Exception: pass
        for b in blocks:
            if b["gcal_event_id"] and token:
                _confirm_gcal_event(token, b["gcal_event_id"])
        cur.execute("""
            UPDATE plan_blocks SET status='approved'
            WHERE user_id=%s::uuid AND status='draft' AND start_time::date=%s
        """, (user["user_id"], today))
        conn.commit()
        return {"approved": cur.rowcount}
    finally:
        conn.close()


@router.post("/blocks/{block_id}/complete")
def complete_block(block_id: str, body: CompleteBlock, request: Request):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM plan_blocks WHERE block_id=%s::uuid AND user_id=%s::uuid", (block_id, user["user_id"]))
        block = cur.fetchone()
        if not block: raise HTTPException(404, "Block not found")
        cur.execute("""
            UPDATE plan_blocks SET status='completed', actual_minutes=%s, completed_at=NOW()
            WHERE block_id=%s::uuid RETURNING *
        """, (body.actual_minutes, block_id))
        updated = _fmt_block(cur.fetchone())
        # Log time
        cur.execute("""
            INSERT INTO time_logs (user_id, block_id, description, logged_minutes, log_date)
            VALUES (%s::uuid, %s::uuid, %s, %s, NOW()::date)
        """, (user["user_id"], block_id, body.note, body.actual_minutes))
        # Mark linked task done
        if block.get("source_type") == "task" and block.get("source_id"):
            cur.execute("UPDATE tasks SET status='done', updated_at=NOW() WHERE task_id=%s::uuid", (block["source_id"],))
        conn.commit()
        return updated
    finally:
        conn.close()


@router.patch("/blocks/{block_id}")
def update_block(block_id: str, body: BlockPatch, request: Request):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM plan_blocks WHERE block_id=%s::uuid AND user_id=%s::uuid", (block_id, user["user_id"]))
        block = cur.fetchone()
        if not block: raise HTTPException(404, "Block not found")

        sets, params = [], []
        if body.title is not None:       sets.append("title=%s");       params.append(body.title)
        if body.description is not None: sets.append("description=%s"); params.append(body.description)
        if body.start_time is not None:
            plan_date = block["start_time"].date()
            sh, sm = map(int, body.start_time.replace("T","T").split("T")[-1][:5].split(":"))
            start_dt = datetime(plan_date.year, plan_date.month, plan_date.day, sh, sm, tzinfo=CST)
            sets.append("start_time=%s"); params.append(start_dt)
        if body.end_time is not None:
            plan_date = block["start_time"].date()
            eh, em = map(int, body.end_time.replace("T","T").split("T")[-1][:5].split(":"))
            end_dt = datetime(plan_date.year, plan_date.month, plan_date.day, eh, em, tzinfo=CST)
            sets.append("end_time=%s"); params.append(end_dt)
        if not sets: return _fmt_block(block)
        params.append(block_id)
        cur.execute(f"UPDATE plan_blocks SET {', '.join(sets)} WHERE block_id=%s::uuid RETURNING *", params)
        conn.commit()
        return _fmt_block(cur.fetchone())
    finally:
        conn.close()


@router.delete("/blocks/{block_id}", status_code=204)
def reject_block(block_id: str, request: Request):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM plan_blocks WHERE block_id=%s::uuid AND user_id=%s::uuid", (block_id, user["user_id"]))
        block = cur.fetchone()
        if not block: raise HTTPException(404, "Block not found")
        if block.get("gcal_event_id"):
            try:
                from app.routers.contacts import _get_user_google_token
                token = _get_user_google_token(user["user_id"])
                _delete_gcal_event(token, block["gcal_event_id"])
            except Exception: pass
        cur.execute("UPDATE plan_blocks SET status='rejected' WHERE block_id=%s::uuid", (block_id,))
        conn.commit()
    finally:
        conn.close()


@router.get("/logs")
def list_logs(request: Request, days: int = Query(7, ge=1, le=90)):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    since = datetime.now(CST).date() - timedelta(days=days)
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT tl.log_id::text, tl.block_id::text, tl.task_id::text,
                   tl.description, tl.logged_minutes, tl.log_date::text, tl.logged_at,
                   pb.title AS block_title, pb.block_type,
                   t.title  AS task_title
            FROM time_logs tl
            LEFT JOIN plan_blocks pb ON pb.block_id = tl.block_id
            LEFT JOIN tasks t        ON t.task_id   = tl.task_id
            WHERE tl.user_id=%s::uuid AND tl.log_date >= %s
            ORDER BY tl.logged_at DESC
        """, (user["user_id"], since))
        logs = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("logged_at"): d["logged_at"] = d["logged_at"].isoformat()
            logs.append(d)
        return logs
    finally:
        conn.close()


@router.post("/logs", status_code=201)
def create_log(body: TimeLogCreate, request: Request):
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    log_date = date.fromisoformat(body.log_date) if body.log_date else datetime.now(CST).date()
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            INSERT INTO time_logs (user_id, block_id, task_id, description, logged_minutes, log_date)
            VALUES (%s::uuid, %s::uuid, %s::uuid, %s, %s, %s) RETURNING log_id::text
        """, (user["user_id"], body.block_id or None, body.task_id or None, body.description, body.logged_minutes, log_date))
        log_id = cur.fetchone()["log_id"]
        conn.commit()
        return {"log_id": log_id, "logged_minutes": body.logged_minutes}
    finally:
        conn.close()


# ── Dashboard Brief ────────────────────────────────────────────────────────────

@router.get("/brief")
def get_brief(request: Request):
    """Aggregated business snapshot for the Command Center dashboard."""
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        today = datetime.now(CST).date()
        week_start = today - timedelta(days=today.weekday())

        # Tasks
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE status = 'open') AS open,
                COUNT(*) FILTER (WHERE status = 'open' AND due_date < %s) AS overdue,
                COUNT(*) FILTER (WHERE status = 'done' AND updated_at::date >= %s) AS done_this_week
            FROM tasks WHERE user_id = %s::uuid
        """, (today, week_start, user["user_id"]))
        tasks_row = {k: int(v or 0) for k, v in dict(cur.fetchone()).items()}

        # Projects
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE status = 'active') AS active,
                COUNT(*) FILTER (WHERE status IN ('at_risk', 'off_track')) AS at_risk,
                COALESCE(SUM(expected_revenue) FILTER (WHERE status IN ('active', 'at_risk', 'off_track')), 0) AS pipeline_value
            FROM projects
        """)
        row = dict(cur.fetchone())
        proj_row = {"active": int(row["active"] or 0), "at_risk": int(row["at_risk"] or 0), "pipeline_value": float(row["pipeline_value"] or 0)}

        # Contacts with overdue follow-ups
        cur.execute("""
            SELECT COUNT(*) AS overdue_followups
            FROM contact_reminders
            WHERE resolved = false
              AND (due_date < %s OR (due_date IS NULL AND created_at < NOW() - INTERVAL '14 days'))
        """, (today,))
        contacts_row = {"overdue_followups": int(cur.fetchone()["overdue_followups"] or 0)}

        # FP&A
        fpa_data = {}
        try:
            cur.execute("SELECT cash_balance, net_burn, monthly_outflow FROM fpa_actuals ORDER BY created_at DESC LIMIT 1")
            row = cur.fetchone()
            if row:
                fpa_data = {k: float(v) if v is not None else None for k, v in dict(row).items()}
                burn = fpa_data.get("net_burn") or fpa_data.get("monthly_outflow") or 0
                fpa_data["runway_months"] = round(fpa_data["cash_balance"] / burn, 1) if burn and fpa_data.get("cash_balance") else None
        except Exception:
            conn.rollback()

        # Invoices
        invoices_data = {"unpaid_count": 0, "unpaid_total": 0.0}
        try:
            cur.execute("""
                SELECT COUNT(*) AS unpaid_count, COALESCE(SUM(total), 0) AS unpaid_total
                FROM invoices WHERE status IN ('draft', 'sent', 'overdue')
            """)
            row = cur.fetchone()
            if row:
                invoices_data = {"unpaid_count": int(row["unpaid_count"] or 0), "unpaid_total": float(row["unpaid_total"] or 0)}
        except Exception:
            conn.rollback()

        # Signals
        signals = []

        try:
            cur.execute("""
                SELECT title, due_date FROM tasks
                WHERE user_id = %s::uuid AND status = 'open' AND due_date < %s
                ORDER BY due_date ASC LIMIT 3
            """, (user["user_id"], today))
            for row in cur.fetchall():
                days_late = (today - row["due_date"]).days
                signals.append({
                    "type": "task_overdue", "severity": "high" if days_late > 3 else "medium",
                    "title": row["title"],
                    "description": f"Overdue by {days_late} day{'s' if days_late != 1 else ''}",
                    "action_url": "/tasks", "action_label": "View tasks",
                })
        except Exception:
            conn.rollback()

        try:
            cur.execute("""
                -- Last contact comes from contact_interactions, which is what the
                -- Gmail and Calendar sync actually writes. This read used to hit a
                -- contact_emails table that migration 072 never applied, so it threw
                -- into the rollback below and this signal never once appeared.
                SELECT c.name, c.contact_id::text,
                       COALESCE(EXTRACT(DAY FROM NOW() - MAX(ci.occurred_at))::int, 999) AS days_since
                FROM contacts c
                JOIN projects p ON p.contact_id = c.contact_id AND p.status = 'active'
                LEFT JOIN contact_interactions ci ON ci.contact_id = c.contact_id
                GROUP BY c.contact_id, c.name
                HAVING MAX(ci.occurred_at) < NOW() - INTERVAL '14 days'
                    OR MAX(ci.occurred_at) IS NULL
                ORDER BY days_since DESC LIMIT 2
            """)
            for row in cur.fetchall():
                days = int(row["days_since"] or 99)
                signals.append({
                    "type": "contact_stale", "severity": "medium",
                    "title": f"Follow up with {row['name']}",
                    "description": f"{days if days < 999 else '14+'}d since last contact — active deal",
                    "action_url": f"/contacts/{row['contact_id']}", "action_label": "Open contact",
                })
        except Exception:
            conn.rollback()

        try:
            cur.execute("SELECT name, status FROM projects WHERE status IN ('at_risk', 'off_track') LIMIT 2")
            for row in cur.fetchall():
                signals.append({
                    "type": "project_risk", "severity": "high",
                    "title": f"{row['name']} is {row['status'].replace('_', ' ')}",
                    "description": "Project health needs attention",
                    "action_url": "/projects", "action_label": "View project",
                })
        except Exception:
            conn.rollback()

        try:
            cur.execute("""
                SELECT cr.title, c.name AS contact_name, c.contact_id::text
                FROM contact_reminders cr
                JOIN contacts c ON c.contact_id = cr.contact_id
                WHERE cr.resolved = false AND cr.due_date < %s
                ORDER BY cr.due_date ASC LIMIT 2
            """, (today,))
            for row in cur.fetchall():
                signals.append({
                    "type": "reminder_overdue", "severity": "medium",
                    "title": row["title"],
                    "description": f"Overdue reminder — {row['contact_name']}",
                    "action_url": f"/contacts/{row['contact_id']}", "action_label": "View contact",
                })
        except Exception:
            conn.rollback()

        try:
            cur.execute("SELECT invoice_number, total FROM invoices WHERE status = 'overdue' ORDER BY created_at ASC LIMIT 2")
            for row in cur.fetchall():
                signals.append({
                    "type": "invoice_overdue", "severity": "high",
                    "title": f"Invoice {row['invoice_number']} overdue",
                    "description": f"${float(row['total']):,.0f} outstanding",
                    "action_url": "/invoices", "action_label": "View invoices",
                })
        except Exception:
            conn.rollback()

        return {
            "tasks": tasks_row,
            "projects": proj_row,
            "contacts": contacts_row,
            "fpa": fpa_data,
            "invoices": invoices_data,
            "signals": signals[:8],
        }
    finally:
        conn.close()


# ── AI Chat ────────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: list[ChatMessage]

@router.post("/chat")
def chat(body: ChatRequest, request: Request):
    """Conversational AI with full business context for the Command Center."""
    user = get_current_user(request)
    if not user: raise HTTPException(401, "Not authenticated")
    if not body.messages:
        raise HTTPException(422, "Messages required")

    conn = _conn()
    try:
        ctx = _gather_context(conn, user["user_id"])
        omni = _gather_omnipresent_context(conn, user["user_id"])
        today = datetime.now(CST).date()

        # Fetch today's calendar events for context
        today_gcal: list = []
        try:
            from app.routers.contacts import _get_user_google_token
            _gcal_token = _get_user_google_token(user["user_id"])
            if _gcal_token:
                today_gcal = _get_gcal_events(_gcal_token, today, today)
        except Exception:
            pass

        # ── Block A: static role context (prompt-cached across all requests) ──
        _block_a_text = """You are an executive assistant for Open ERP, a biotech startup.
You have real-time access to ALL business data across every module and help the founder prioritize and manage their day.

=== YOUR ROLE ===
- You are omnipresent — you see every module: tasks, projects, finances, meeting notes, contacts, and funding
- Be a sharp, direct executive assistant — not overly formal
- Use the calendar to understand what time is already committed today
- If the user gives a brain dump or asks to add something, populate extracted_tasks — these go into their task list, NOT the calendar
- When asked about priorities or what to do today, give a numbered list tied to the actual data above, accounting for calendar commitments
- When asked about contacts or funding, draw from those sections
- When asked what to do next, look at overdue items and high-revenue projects first
- Keep responses concise (under 200 words) unless detail is explicitly requested
- If something is alarming (overdue tasks, low runway, at-risk project, stalled R&D), flag it proactively
- Never suggest adding items to the calendar — task capture always goes to the task list

RESPONSE FORMAT — always return valid JSON, nothing else:
{
  "reply": "Your response (markdown ok, keep it tight)",
  "extracted_tasks": [
    {"title": "Concise action title", "urgency": "high|medium|low", "notes": "context or null"}
  ],
  "extracted_followups": [
    {"contact_name": "Name or email", "action": "What to follow up on", "due_days": 2}
  ],
  "suggest_replan": false
}

Only populate extracted_tasks when the user gives a brain dump or explicitly asks you to add something.
Only populate extracted_followups when the user explicitly asks to create an email follow-up, reminder to email someone, or follow up with a contact. Use extracted_followups (not extracted_tasks) for anything that is clearly an email/contact follow-up.
Set suggest_replan to true if you extracted urgent tasks and regenerating the daily plan would be valuable."""

        # ── Block B: live structured context (today's data) ──
        _block_b_text = f"""TODAY: {today.strftime("%A, %B %d, %Y")}

=== OPERATIONS ===

OPEN TASKS:
{_fmt_tasks(ctx['tasks'], today)}

CONTACT REMINDERS:
{_fmt_reminders(ctx['reminders'], today)}

ACTIVE PROJECTS:
{_fmt_projects(ctx['projects'], today)}

FINANCIALS:
{_fmt_fpa(ctx.get('fpa', {}), ctx.get('qbo', []))}

TODAY'S CALENDAR:
{_fmt_gcal(today_gcal)}

=== RECORDS ===

RECENT MEETING NOTES:
{_fmt_recent_notes(omni['recent_notes'])}

=== BUSINESS DEVELOPMENT ===

KEY CONTACTS:
{_fmt_key_contacts(omni['key_contacts'])}

FUNDING OPPORTUNITIES:
{_fmt_funding(omni['funding'])}"""

        # ── Block C: semantically retrieved context (RAG, query-specific) ──
        _latest_user_msg = next(
            (m.content for m in reversed(body.messages) if m.role == "user"), ""
        )
        _rag_enabled = os.environ.get("RAG_ENABLED", "true").lower() == "true"
        _block_c_text = ""
        if _rag_enabled and _latest_user_msg:
            try:
                from app.core.rag import rag_context_for_query
                _block_c_text = rag_context_for_query(conn, user["user_id"], _latest_user_msg)
            except Exception:
                pass

        import anthropic
        _chat_model = AI_MODEL
        _chat_tokens = 1024
        _chat_top_p = None
        _chat_top_k = None
        _chat_extra = ""
        try:
            from app.core.agent_config import get_agent_config as _gac
            _cfg = _gac("planner_chat")
            _chat_model = _cfg.get("model") or AI_MODEL
            _chat_tokens = _cfg.get("max_tokens") or 1024
            _chat_top_p = _cfg.get("top_p")
            _chat_top_k = _cfg.get("top_k")
            _chat_extra = _cfg.get("system_prompt_override") or ""
        except Exception:
            pass

        # Build system blocks (list of content blocks for prompt caching)
        _system_blocks: list[dict] = []
        if _chat_extra:
            _system_blocks.append({"type": "text", "text": _chat_extra.strip()})
        # Block A is always first and marked for caching
        _system_blocks.append({
            "type": "text",
            "text": _block_a_text,
            "cache_control": {"type": "ephemeral"},
        })
        _system_blocks.append({"type": "text", "text": _block_b_text})
        if _block_c_text:
            _system_blocks.append({"type": "text", "text": _block_c_text})

        client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
        messages = [{"role": m.role, "content": m.content} for m in body.messages]

        _api_kwargs: dict = dict(
            model=_chat_model,
            max_tokens=_chat_tokens,
            system=_system_blocks,
            messages=messages,
        )
        if _chat_top_p is not None:
            _api_kwargs["top_p"] = _chat_top_p
        if _chat_top_k is not None:
            _api_kwargs["top_k"] = _chat_top_k

        msg = client.messages.create(**_api_kwargs)

        raw = msg.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]

        try:
            result = json.loads(raw)
        except Exception:
            result = {"reply": raw, "extracted_tasks": [], "suggest_replan": False}

        # Persist extracted tasks
        created_tasks: list[dict] = []
        for task in (result.get("extracted_tasks") or []):
            title = (task.get("title") or "").strip()
            if not title:
                continue
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute("""
                INSERT INTO tasks (user_id, assigned_to, title, description)
                VALUES (%s::uuid, %s::uuid, %s, %s) RETURNING task_id::text
            """, (user["user_id"], user["user_id"], title, task.get("notes")))
            row = cur.fetchone()
            created_tasks.append({"task_id": str(row["task_id"]), "title": title, "urgency": task.get("urgency", "medium")})

        # Persist extracted follow-ups as contact reminders (or tasks if contact not found)
        created_followups: list[dict] = []
        for fu in (result.get("extracted_followups") or []):
            contact_name_or_email = (fu.get("contact_name") or "").strip()
            action = (fu.get("action") or "").strip()
            if not action:
                continue
            due_days = int(fu.get("due_days") or 2)
            due_date = (datetime.now(CST).date() + timedelta(days=due_days)).isoformat()

            # Try to find contact by name or email
            cur2 = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur2.execute(
                """
                SELECT contact_id, name FROM contacts
                WHERE (LOWER(name) ILIKE %s OR LOWER(email) ILIKE %s) AND NOT archived
                LIMIT 1
                """,
                (f"%{contact_name_or_email.lower()}%", f"%{contact_name_or_email.lower()}%"),
            )
            contact = cur2.fetchone()

            if contact:
                cur2.execute(
                    """
                    INSERT INTO contact_reminders
                        (contact_id, reminder_type, title, due_date, auto_generated)
                    VALUES (%s, 'follow_up', %s, %s, true)
                    RETURNING reminder_id
                    """,
                    (contact["contact_id"], action, due_date),
                )
                row = cur2.fetchone()
                cur2.execute(
                    "UPDATE contacts SET updated_at = NOW() WHERE contact_id = %s",
                    (contact["contact_id"],),
                )
                created_followups.append({
                    "type": "reminder",
                    "id": str(row["reminder_id"]),
                    "title": action,
                    "contact_name": contact["name"],
                    "due_date": due_date,
                })
            else:
                # Fallback: create a task
                title = f"Email follow-up: {action}" + (f" ({contact_name_or_email})" if contact_name_or_email else "")
                cur2.execute(
                    """
                    INSERT INTO tasks (user_id, assigned_to, title, due_date)
                    VALUES (%s::uuid, %s::uuid, %s, %s) RETURNING task_id::text
                    """,
                    (user["user_id"], user["user_id"], title, due_date),
                )
                row = cur2.fetchone()
                created_followups.append({
                    "type": "task",
                    "id": str(row["task_id"]),
                    "title": title,
                    "due_date": due_date,
                })

        if created_tasks or created_followups:
            conn.commit()

        return {
            "reply": result.get("reply", ""),
            "extracted_tasks": created_tasks,
            "extracted_followups": created_followups,
            "suggest_replan": result.get("suggest_replan", False),
        }
    finally:
        conn.close()