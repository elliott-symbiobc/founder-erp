"""
tasks.py — Personal task list.

GET    /tasks                         — list my tasks
POST   /tasks                         — create task
PATCH  /tasks/{id}                    — update task fields
DELETE /tasks/{id}                    — delete task
GET    /tasks/summary                 — counts for dashboard widget
POST   /tasks/reorder                 — update sort_order for multiple tasks
GET    /tasks/users                   — list users available for assignment
POST   /tasks/{id}/generate-email-draft — generate AI email draft for gmail_followup task
"""
import logging
import os
from typing import List, Optional

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from app.routers.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tasks", tags=["tasks"])


def _conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _resolve_conditional_followups(cur, parent_task_id: str):
    """When parent task is done: unlock follow-ups (no response) or cancel them (got response)."""
    cur.execute(
        """
        SELECT t.task_id, t.trigger_days, t.condition,
               p.contact_id, t.created_at AS parent_created_at
        FROM tasks t
        LEFT JOIN tasks parent ON parent.task_id = t.follow_up_of
        LEFT JOIN projects p ON p.project_id = parent.project_id
        WHERE t.follow_up_of = %s::uuid AND t.condition = 'no_response' AND t.status = 'open'
        """,
        (parent_task_id,),
    )
    followups = cur.fetchall()
    for fu in followups:
        contact_id = fu.get("contact_id")
        got_response = False
        if contact_id:
            # Check if any inbound email/interaction arrived from this contact since parent was created
            cur.execute(
                """
                SELECT 1 FROM interactions
                WHERE contact_id = %s::uuid
                  AND direction = 'inbound'
                  AND occurred_at >= %s
                LIMIT 1
                """,
                (contact_id, fu["parent_created_at"]),
            )
            got_response = cur.fetchone() is not None

        if got_response:
            # Response received — cancel the follow-up
            cur.execute(
                "UPDATE tasks SET status = 'done', kanban_status = 'done', updated_at = now() WHERE task_id = %s::uuid",
                (fu["task_id"],),
            )
        else:
            # No response — activate the follow-up with a due date
            trigger_days = fu.get("trigger_days") or 3
            cur.execute(
                """
                UPDATE tasks SET locked = false,
                    due_date = CURRENT_DATE + %s::int,
                    updated_at = now()
                WHERE task_id = %s::uuid
                """,
                (trigger_days, fu["task_id"]),
            )


def _check_conditional_followups_for_project(cur, project_id: str):
    """On task list fetch: cancel any conditional follow-ups where response has now arrived."""
    cur.execute(
        """
        SELECT t.task_id, t.follow_up_of, parent.created_at AS parent_created_at,
               p.contact_id
        FROM tasks t
        JOIN tasks parent ON parent.task_id = t.follow_up_of
        JOIN projects p ON p.project_id = t.project_id
        WHERE t.project_id = %s::uuid
          AND t.condition = 'no_response'
          AND t.status = 'open'
          AND t.locked = false
        """,
        (project_id,),
    )
    active_followups = cur.fetchall()
    for fu in active_followups:
        contact_id = fu.get("contact_id")
        if not contact_id:
            continue
        cur.execute(
            """
            SELECT 1 FROM interactions
            WHERE contact_id = %s::uuid
              AND direction = 'inbound'
              AND occurred_at >= %s
            LIMIT 1
            """,
            (contact_id, fu["parent_created_at"]),
        )
        if cur.fetchone():
            cur.execute(
                "UPDATE tasks SET status = 'done', kanban_status = 'done', updated_at = now() WHERE task_id = %s::uuid",
                (fu["task_id"],),
            )


class TaskCreate(BaseModel):
    title: str
    description: Optional[str] = None
    due_date: Optional[str] = None
    start_date: Optional[str] = None
    estimated_minutes: Optional[int] = None
    project_id: Optional[str] = None
    milestone_id: Optional[str] = None    # new: assign to milestone
    source_note_id: Optional[str] = None
    contact_id: Optional[str] = None
    assigned_to: Optional[str] = None
    assignment_note: Optional[str] = None  # required note shown in notification
    kanban_status: Optional[str] = None   # inbox | todo | in_progress | review | done
    priority: Optional[str] = None        # low | medium | high
    source_ref: Optional[str] = None      # e.g. "funding:{id}" | "dilutive:{id}"
    activity_type: Optional[str] = None   # email | call | document | meeting | todo
    task_type: Optional[str] = None        # deliverable | follow_up | request_approval | send_to_client
    extra_assignees: Optional[List[str]] = None  # additional user_ids for task_assignees
    follow_up_of: Optional[str] = None   # parent task_id for conditional follow-ups
    trigger_days: Optional[int] = None   # days after parent completion to trigger
    condition: Optional[str] = None      # 'no_response'


class TaskPatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    due_date: Optional[str] = None
    start_date: Optional[str] = None
    estimated_minutes: Optional[int] = None
    status: Optional[str] = None          # open | done
    kanban_status: Optional[str] = None   # inbox | todo | in_progress | review | done
    project_id: Optional[str] = None
    milestone_id: Optional[str] = None    # new: assign/move to milestone
    sort_order: Optional[float] = None
    assigned_to: Optional[str] = None
    assignment_note: Optional[str] = None  # required note shown in notification
    priority: Optional[str] = None        # low | medium | high (null = auto-infer)
    activity_type: Optional[str] = None   # email | call | document | meeting | todo
    task_type: Optional[str] = None        # deliverable | follow_up | request_approval | send_to_client
    locked: Optional[bool] = None         # true = template placeholder, hidden from to-do


class ReorderBody(BaseModel):
    task_ids: List[str]


def _fmt(row: dict) -> dict:
    d = dict(row)
    for ts in ("created_at", "updated_at"):
        if d.get(ts) and hasattr(d[ts], "isoformat"):
            d[ts] = d[ts].isoformat()
    for int_f in ("estimated_minutes",):
        if d.get(int_f) is not None:
            d[int_f] = int(d[int_f])
    for uuid_f in ("task_id", "user_id", "source_note_id", "project_id", "contact_id", "assigned_to", "milestone_id", "reviewer_id"):
        if d.get(uuid_f):
            d[uuid_f] = str(d[uuid_f])
    for date_f in ("due_date", "start_date"):
        if d.get(date_f) and hasattr(d[date_f], "isoformat"):
            d[date_f] = d[date_f].isoformat()
    return d


# Enriched task row, shared by the list and single-task endpoints so the two can
# never drift into returning different shapes for the same frontend Task type.
_TASK_SELECT = """
    SELECT t.*,
           p.name         AS project_name,
           p.project_type AS project_type,
           n.title  AS note_title,
           c.name   AS contact_name,
           u.name   AS assigned_to_name,
           rv.name  AS reviewer_name,
           ou.name  AS owner_name,
           m.title  AS milestone_title,
           (
               SELECT json_agg(json_build_object(
                   'user_id', ta.user_id::text,
                   'role', ta.role,
                   'name', COALESCE(au.full_name, au.name)
               ))
               FROM task_assignees ta
               JOIN users au ON au.user_id = ta.user_id
               WHERE ta.task_id = t.task_id
           ) AS extra_assignees,
           (
               SELECT COUNT(*) FROM task_dependencies td WHERE td.task_id = t.task_id
           ) AS blocked_by_count,
           -- The investor a funding task belongs to. source_ref is free text
           -- shared by several modules, so it stays NULL unless it really is an
           -- investor id.
           inv.investor_id::text AS investor_id,
           inv.firm             AS investor_firm
    FROM tasks t
    LEFT JOIN projects p             ON p.project_id  = t.project_id
    LEFT JOIN notes n                ON n.note_id      = t.source_note_id
    LEFT JOIN contacts c             ON c.contact_id   = t.contact_id
    LEFT JOIN users u                ON u.user_id       = t.assigned_to
    LEFT JOIN users ou               ON ou.user_id      = t.user_id
    LEFT JOIN users rv               ON rv.user_id      = t.reviewer_id
    LEFT JOIN project_milestones m   ON m.milestone_id  = t.milestone_id
    -- Compared as text on purpose. source_ref also holds values like
    -- 'email_suggestion' and 'granola:<id>', and Postgres is free to apply a
    -- ::uuid cast before any regex guard sitting beside it in the same ON
    -- clause -- which errors the entire query instead of just not matching.
    LEFT JOIN dilutive_investors inv ON inv.investor_id::text = t.source_ref
"""


@router.get("/summary")
def task_summary(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            """
            SELECT
                COUNT(*) FILTER (WHERE status = 'open')                            AS open_count,
                COUNT(*) FILTER (WHERE status = 'done')                            AS done_count,
                COUNT(*) FILTER (WHERE status = 'open' AND due_date < CURRENT_DATE) AS overdue_count
            FROM tasks
            WHERE assigned_to = %s::uuid
              AND locked = false
            """,
            (user["user_id"],),
        )
        return dict(cur.fetchone())
    finally:
        conn.close()


@router.get("/users")
def list_users_for_tasks(request: Request):
    """Return users that tasks can be assigned to."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            """
            SELECT user_id::text, name, email, COALESCE(user_type, 'employee') AS user_type
            FROM users
            WHERE COALESCE(is_active, true) = true
            ORDER BY name
            """
        )
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.get("")
def list_tasks(
    request: Request,
    status: Optional[str] = Query(None),
    project_id: Optional[str] = Query(None),
    contact_id: Optional[str] = Query(None),
    # Scopes to one pipeline record (an investor or a deal). Like project_id it
    # is a shared view, not a personal to-do list.
    source_ref: Optional[str] = Query(None),
    assigned_to: Optional[str] = Query(None),
    all_users: bool = Query(False),
    # Days of completed work to include alongside open tasks. The Kanban board
    # keeps its Done column populated, but Done grows without limit -- 182 done
    # against 224 open already -- so it asks for a window rather than for
    # everything and quietly hitting the row cap.
    done_within_days: Optional[int] = Query(None, ge=1, le=365),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Tasks are visible team-wide: any authenticated user may ask for all_users
    # and narrow down with the assignee filter. Who may *edit* a task is still
    # enforced per-task on PATCH/DELETE -- this only opens reading.

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        filters: list = []
        params: list = []

        if not project_id and not source_ref:
            if not all_users:
                # Personal to-do: what is assigned to this user. Authorship is
                # deliberately not part of it -- creating a task for someone else
                # should not park it on your own board.
                filters.append("t.assigned_to = %s::uuid")
                params.append(user["user_id"])
            # Either way this is the task board, which lists work that is actually
            # actionable. Locked rows are later steps in a sequential milestone
            # chain that has not reached them yet, so they stay out until the
            # milestone unlocks them.
            filters.append("t.locked = false")
        # Record-scoped views (a project or an investor) show every task on that
        # record, locked ones included, so the whole chain is visible in context.

        if status == "open" and done_within_days:
            # Open work, plus anything finished recently enough to still be worth
            # seeing in the Done column.
            filters.append(
                "(t.status = 'open' OR (t.status = 'done' AND t.completed_at > now() - make_interval(days => %s)))"
            )
            params.append(done_within_days)
        elif status:
            filters.append("t.status = %s")
            params.append(status)
        if project_id:
            filters.append("t.project_id = %s::uuid")
            params.append(project_id)
        if contact_id:
            filters.append("t.contact_id = %s::uuid")
            params.append(contact_id)
        if source_ref:
            filters.append("t.source_ref = %s")
            params.append(source_ref)
        if assigned_to:
            filters.append("t.assigned_to = %s::uuid")
            params.append(assigned_to)

        where = ("WHERE " + " AND ".join(filters)) if filters else ""
        params.extend([limit, offset])

        # Auto-cancel any conditional follow-ups where response has arrived
        if project_id:
            try:
                _check_conditional_followups_for_project(cur, project_id)
                conn.commit()
            except Exception:
                conn.rollback()

        cur.execute(
            f"""
            {_TASK_SELECT}
            {where}
            ORDER BY
                CASE t.status WHEN 'open' THEN 0 ELSE 1 END,
                t.sort_order ASC NULLS LAST,
                CASE WHEN t.due_date IS NOT NULL THEN 0 ELSE 1 END,
                t.due_date ASC NULLS LAST,
                t.created_at DESC
            LIMIT %s OFFSET %s
            """,
            params,
        )
        return [_fmt(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.get("/{task_id}")
def get_task(task_id: str, request: Request):
    """One task, in the same shape as the list. Backs the ?task=<id> deep link
    that opens the Edit Task view from elsewhere in the platform — the task may
    be filtered out of the caller's current board, so it is fetched by id."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(f"{_TASK_SELECT} WHERE t.task_id = %s::uuid", (task_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Task not found")
        # Same visibility rule as the list: tasks are readable team-wide. If this
        # 403'd while the board still listed the task, every teammate's card
        # would open an error instead of the task.
        return _fmt(row)
    finally:
        conn.close()


@router.post("", status_code=201)
def create_task(body: TaskCreate, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not body.title.strip():
        raise HTTPException(status_code=422, detail="title is required")

    kanban = body.kanban_status or ""
    if kanban not in ("inbox", "todo", "in_progress", "review", "done"):
        kanban = ""

    # Work you did not choose starts in Inbox so it is reviewed rather than
    # silently mixed into your own To Do pile. Only applies when the caller did
    # not ask for a column outright -- an explicit kanban_status always wins.
    if not kanban:
        delegated = bool(body.assigned_to) and body.assigned_to != user["user_id"]
        kanban = "inbox" if delegated else "todo"

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        # Set sort_order to max existing + 10
        cur.execute(
            "SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order FROM tasks WHERE user_id = %s::uuid",
            (user["user_id"],),
        )
        next_order = cur.fetchone()["next_order"]

        priority = body.priority if body.priority in ("low", "medium", "high") else None
        cur.execute(
            """
            INSERT INTO tasks
                (user_id, title, description, due_date, start_date, estimated_minutes,
                 project_id, milestone_id, source_note_id, contact_id, assigned_to,
                 kanban_status, sort_order, priority, source_ref, activity_type, task_type,
                 follow_up_of, trigger_days, condition,
                 locked, assignment_note)
            VALUES (%s::uuid, %s, %s, %s::date, %s::date, %s, %s::uuid, %s::uuid, %s::uuid, %s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s::uuid, %s, %s, %s, %s)
            RETURNING *
            """,
            (
                user["user_id"], body.title.strip(), body.description,
                body.due_date or None,
                body.start_date or None,
                body.estimated_minutes or None,
                body.project_id or None,
                body.milestone_id or None,
                body.source_note_id or None,
                body.contact_id or None,
                body.assigned_to or user["user_id"],
                kanban,
                next_order,
                priority,
                body.source_ref or None,
                body.activity_type or None,
                body.task_type or None,
                body.follow_up_of or None,
                body.trigger_days or None,
                body.condition or None,
                True if body.condition else False,  # conditional follow-ups start locked
                (body.assignment_note or "").strip() or None,
            ),
        )
        row = _fmt(cur.fetchone())

        # Add extra assignees to task_assignees junction table
        if body.extra_assignees:
            for uid in body.extra_assignees:
                if uid != user["user_id"]:
                    cur.execute(
                        "INSERT INTO task_assignees (task_id, user_id) VALUES (%s::uuid, %s::uuid) ON CONFLICT DO NOTHING",
                        (row["task_id"], uid),
                    )

        # Notify assignee only if assigned to someone other than the creator
        assigned_to_resolved = row.get("assigned_to")
        if assigned_to_resolved and assigned_to_resolved != user["user_id"]:
            try:
                from app.routers.notifications import create_notification
                create_notification(
                    conn,
                    recipient_id=assigned_to_resolved,
                    sender_id=user["user_id"],
                    notification_type="task_assigned",
                    entity_type="task",
                    entity_id=row["task_id"],
                    title=f"Task assigned: {row['title']}",
                    message=body.assignment_note,
                )
            except Exception:
                pass

        conn.commit()
        try:
            from app.worker import embed_content_task
            embed_content_task.delay("tasks", row["task_id"], user["user_id"])
        except Exception:
            pass
        return row
    finally:
        conn.close()


@router.post("/reorder")
def reorder_tasks(body: ReorderBody, request: Request):
    """Set sort_order for an ordered list of task IDs."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor()
        for i, tid in enumerate(body.task_ids):
            cur.execute(
                """
                UPDATE tasks SET sort_order = %s, updated_at = now()
                WHERE task_id = %s::uuid AND user_id = %s::uuid
                """,
                ((i + 1) * 10.0, tid, user["user_id"]),
            )
        conn.commit()
        return {"status": "ok", "count": len(body.task_ids)}
    finally:
        conn.close()


@router.patch("/{task_id}")
def update_task(task_id: str, body: TaskPatch, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT user_id, assigned_to, locked, source_ref FROM tasks WHERE task_id = %s::uuid",
            (task_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Task not found")
        prev_locked = row.get("locked", False)
        # A task hanging off a pipeline record (an investor, a deal) belongs to
        # that record, not to a person — the same reason list_tasks treats
        # source_ref as a shared view. Whoever is looking at the card must be
        # able to tick it off, whether or not they happen to own it.
        shared = bool(row.get("source_ref"))
        if (not shared
                and str(row["user_id"]) != user["user_id"]
                and str(row.get("assigned_to") or "") != user["user_id"]):
            raise HTTPException(status_code=403, detail="Not authorised")

        sets: list[str] = ["updated_at = now()"]
        params: list = []

        if body.title is not None:
            sets.append("title = %s"); params.append(body.title.strip())
        if body.description is not None:
            sets.append("description = %s"); params.append(body.description or None)
        if body.due_date is not None:
            sets.append("due_date = %s::date"); params.append(body.due_date or None)
        if body.start_date is not None:
            sets.append("start_date = %s::date"); params.append(body.start_date or None)
        if body.estimated_minutes is not None:
            sets.append("estimated_minutes = %s"); params.append(body.estimated_minutes or None)
        if body.status is not None:
            if body.status not in ("open", "done"):
                raise HTTPException(status_code=422, detail="status must be open or done")
            sets.append("status = %s"); params.append(body.status)
            # Stamp completion, and clear it on reopen so completed_at always
            # means "this is finished and this is when". COALESCE keeps the
            # original time when a done task is saved again -- otherwise every
            # later edit would quietly restate when it was finished.
            if body.status == "done":
                sets.append("completed_at = COALESCE(completed_at, now())")
            else:
                sets.append("completed_at = NULL")
            # Mirror into kanban_status, but only when the caller left it alone.
            if body.status == "done":
                if body.kanban_status is None:
                    sets.append("kanban_status = 'done'")
            elif body.kanban_status is None:
                # Reopening: restore to todo if currently done
                sets.append("kanban_status = CASE WHEN kanban_status = 'done' THEN 'todo' ELSE kanban_status END")
        if body.kanban_status is not None:
            if body.kanban_status not in ("inbox", "todo", "in_progress", "review", "done"):
                raise HTTPException(status_code=422, detail="invalid kanban_status")
            sets.append("kanban_status = %s"); params.append(body.kanban_status)
            # Same in reverse. Dragging a card to Done completes it, so it must
            # stamp completed_at exactly as setting status would.
            if body.kanban_status == "done":
                if body.status is None:
                    sets.append("status = 'done'")
                    sets.append("completed_at = COALESCE(completed_at, now())")
            elif body.status is None:
                sets.append("status = CASE WHEN status = 'done' THEN 'open' ELSE status END")
                sets.append("completed_at = CASE WHEN status = 'done' THEN NULL ELSE completed_at END")
        if body.project_id is not None:
            sets.append("project_id = %s::uuid"); params.append(body.project_id or None)
        if body.milestone_id is not None:
            sets.append("milestone_id = %s::uuid"); params.append(body.milestone_id or None)
        if body.sort_order is not None:
            sets.append("sort_order = %s"); params.append(body.sort_order)
        prev_assignee = str(row["assigned_to"]) if row.get("assigned_to") else None
        if body.assigned_to is not None:
            sets.append("assigned_to = %s::uuid"); params.append(body.assigned_to or None)
            # Reassigning to someone else drops the task back into their Inbox
            # for review, unless the caller named a column explicitly. Handing a
            # task straight back to yourself is not a delegation and stays put.
            handed_off = (
                body.assigned_to
                and body.assigned_to != prev_assignee
                and body.assigned_to != user["user_id"]
            )
            if handed_off and body.kanban_status is None and body.status is None:
                sets.append("kanban_status = 'inbox'")
            if handed_off:
                sets.append("assignment_note = %s")
                params.append((body.assignment_note or "").strip() or None)
        if body.priority is not None:
            if body.priority not in ("low", "medium", "high", ""):
                raise HTTPException(status_code=422, detail="priority must be low, medium, or high")
            sets.append("priority = %s"); params.append(body.priority or None)
        if body.activity_type is not None:
            sets.append("activity_type = %s"); params.append(body.activity_type or None)
        if body.task_type is not None:
            sets.append("task_type = %s"); params.append(body.task_type or None)
        if body.locked is not None:
            sets.append("locked = %s"); params.append(body.locked)

        if len(sets) == 1:
            raise HTTPException(status_code=422, detail="No fields to update")

        params.append(task_id)
        cur.execute(
            f"UPDATE tasks SET {', '.join(sets)} WHERE task_id = %s::uuid RETURNING *",
            params,
        )
        row = _fmt(cur.fetchone())

        # Notify assignee when task is newly assigned or manually unlocked
        existing_assignee = str(row.get("assigned_to") or "") if row.get("assigned_to") else None
        notif_recipient = body.assigned_to if body.assigned_to else None
        notif_title = None

        if body.assigned_to:
            # Explicit (re-)assignment. Only a real hand-off notifies: the edit
            # form sends assigned_to on every save, so without the changed check
            # each save of your own task raised a fresh "Task assigned" for
            # work you already had.
            notif_recipient = body.assigned_to
            notif_title = f"Task assigned: {row['title']}"
        elif body.locked is False and prev_locked and existing_assignee:
            # Task manually unlocked — notify pre-existing assignee it's now active
            notif_recipient = existing_assignee
            notif_title = f"Task ready: {row['title']}"

        # Nobody needs telling about their own decision, and an assignee that
        # did not change is not an assignment. The create path already skips
        # self-assignment; this one never did.
        if notif_recipient == user["user_id"]:
            notif_recipient = None
        elif body.assigned_to and body.assigned_to == prev_assignee:
            notif_recipient = None

        if notif_recipient:
            try:
                from app.routers.notifications import create_notification
                create_notification(
                    conn,
                    recipient_id=notif_recipient,
                    sender_id=user["user_id"],
                    notification_type="task_assigned",
                    entity_type="task",
                    entity_id=task_id,
                    title=notif_title,
                    message=body.assignment_note,
                )
            except Exception:
                pass

        # Auto-resolve linked contact_reminder when done
        if body.status == "done" or body.kanban_status == "done":
            cur.execute(
                """
                UPDATE contact_reminders
                SET resolved = true, resolved_at = NOW()
                WHERE task_id = %s::uuid AND resolved = false
                """,
                (task_id,),
            )

        # Sequential unlock: when a task is completed, unlock the next locked task in the same objective
        if (body.status == "done" or body.kanban_status == "done") and row.get("milestone_id"):
            cur.execute(
                """
                UPDATE tasks SET locked = false
                WHERE task_id = (
                    SELECT task_id FROM tasks
                    WHERE milestone_id = %s::uuid
                      AND locked = true
                    ORDER BY sort_order ASC NULLS LAST, created_at ASC
                    LIMIT 1
                )
                RETURNING task_id::text, title, assigned_to::text
                """,
                (row["milestone_id"],),
            )
            unlocked = cur.fetchone()
            if unlocked and unlocked.get("assigned_to") and unlocked["assigned_to"] != user["user_id"]:
                try:
                    from app.routers.notifications import create_notification
                    create_notification(
                        conn,
                        recipient_id=unlocked["assigned_to"],
                        sender_id=user["user_id"],
                        notification_type="task_assigned",
                        entity_type="task",
                        entity_id=unlocked["task_id"],
                        title=f"Task ready: {unlocked['title']}",
                        message="A task assigned to you has been unlocked and is ready to start.",
                    )
                except Exception:
                    pass

        # Conditional follow-ups: when a task is marked done, resolve any follow-up tasks
        if body.status == "done" or body.kanban_status == "done":
            _resolve_conditional_followups(cur, task_id)

        # Roll task completion up to the parent milestone
        if row.get("milestone_id") and (body.status is not None or body.kanban_status is not None):
            if body.status == "done" or body.kanban_status == "done":
                cur.execute(
                    """
                    UPDATE project_milestones SET status = 'complete', completed_at = NOW(), updated_at = NOW()
                    WHERE milestone_id = %s::uuid
                      AND status != 'complete'
                      AND NOT EXISTS (
                          SELECT 1 FROM tasks WHERE milestone_id = %s::uuid AND status != 'done'
                      )
                    """,
                    (row["milestone_id"], row["milestone_id"]),
                )
            else:
                cur.execute(
                    """
                    UPDATE project_milestones SET status = 'in_progress', completed_at = NULL, updated_at = NOW()
                    WHERE milestone_id = %s::uuid AND status = 'complete'
                    """,
                    (row["milestone_id"],),
                )

        conn.commit()
        try:
            from app.worker import embed_content_task
            embed_content_task.delay("tasks", task_id, user["user_id"])
        except Exception:
            pass
        return row
    finally:
        conn.close()


@router.delete("/{task_id}", status_code=204)
def delete_task(task_id: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT user_id, assigned_to, source_ref FROM tasks WHERE task_id = %s::uuid",
            (task_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Task not found")
        # Shared pipeline tasks: see the note in update_task. Deletion was even
        # stricter than editing — not even the assignee could remove one.
        shared = bool(row[2])
        if (not shared
                and str(row[0]) != user["user_id"]
                and str(row[1] or "") != user["user_id"]):
            raise HTTPException(status_code=403, detail="Not authorised")
        cur.execute(
            "UPDATE contact_reminders SET resolved = true, resolved_at = NOW() WHERE task_id = %s::uuid AND resolved = false",
            (task_id,),
        )
        cur.execute("DELETE FROM tasks WHERE task_id = %s::uuid", (task_id,))
        conn.commit()
    finally:
        conn.close()


@router.post("/{task_id}/generate-email-draft")
def generate_email_draft(task_id: str, request: Request):
    """Generate a suggested reply email for a task linked to a contact."""
    import anthropic

    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            """
            SELECT t.task_id, t.title, t.description, t.source, t.contact_id,
                   c.name AS contact_name, c.email AS contact_email
            FROM tasks t
            LEFT JOIN contacts c ON c.contact_id = t.contact_id
            WHERE t.task_id = %s::uuid AND t.user_id = %s::uuid
            """,
            (task_id, user["user_id"]),
        )
        task = cur.fetchone()
    finally:
        conn.close()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not task["contact_id"]:
        raise HTTPException(status_code=422, detail="Task is not linked to a contact")
    if not task["contact_email"]:
        raise HTTPException(status_code=422, detail="Contact has no email address")

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            """
            SELECT interaction_id, interaction_type, direction, subject,
                   content_preview, full_content, occurred_at, external_id
            FROM contact_interactions
            WHERE contact_id = %s::uuid
              AND interaction_type IN ('email_sent', 'email_received')
            ORDER BY occurred_at DESC
            LIMIT 10
            """,
            (str(task["contact_id"]),),
        )
        interactions = cur.fetchall()
    finally:
        conn.close()

    interaction_lines = []
    for i in interactions:
        direction = "You sent" if i["direction"] == "outbound" else f"{task['contact_name']} sent"
        subj = (i["subject"] or "(no subject)").strip()[:100]
        preview = (i["content_preview"] or "").strip()[:200]
        date_str = i["occurred_at"].strftime("%b %d") if i["occurred_at"] else ""
        interaction_lines.append(f"- {date_str}: {direction} — Subject: {subj}. {preview}")

    context_block = "\n".join(interaction_lines) if interaction_lines else "No previous email history."

    prompt = (
        f"You are drafting a follow-up email for the user.\n\n"
        f"Task: {task['title']}\n"
        f"Context: {task['description'] or 'No additional context.'}\n\n"
        f"Contact: {task['contact_name']} ({task['contact_email']})\n\n"
        f"Recent email history with this contact:\n{context_block}\n\n"
        f"Write a concise, professional follow-up email. "
        f"Return ONLY valid JSON with two keys: \"subject\" (string) and \"body\" (string, plain text, no markdown). "
        f"The tone should be warm but professional. Keep the body under 150 words."
    )

    try:
        client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        import json as _json
        text = message.content[0].text.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        draft = _json.loads(text)
        subject = draft.get("subject", f"Following up — {task['title']}")
        body = draft.get("body", "")
    except Exception as e:
        logger.warning("Claude draft generation failed: %s", e)
        subject = f"Following up — {task['title']}"
        body = f"Hi {task['contact_name']},\n\nI wanted to follow up on my previous message.\n\nBest regards"

    history = []
    for i in interactions:
        history.append({
            "interaction_id": str(i["interaction_id"]),
            "direction": i["direction"],
            "subject": i["subject"] or "(no subject)",
            "preview": i["content_preview"] or "",
            "body": i["full_content"] or i["content_preview"] or "",
            "occurred_at": i["occurred_at"].isoformat() if i["occurred_at"] else None,
            "gmail_id": i["external_id"],
        })

    return {
        "subject": subject,
        "body": body,
        "to_email": task["contact_email"],
        "to_name": task["contact_name"],
        "contact_id": str(task["contact_id"]),
        "history": history,
    }


# ── Task Assignees (many-to-many) ─────────────────────────────────────────────

@router.get("/{task_id}/assignees")
def list_task_assignees(task_id: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT ta.id, ta.user_id::text, ta.role, ta.created_at,
                   COALESCE(u.full_name, u.name) as name, u.avatar_url
            FROM task_assignees ta
            JOIN users u ON u.user_id = ta.user_id
            WHERE ta.task_id = %s::uuid
            ORDER BY ta.created_at ASC
        """, (task_id,))
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/{task_id}/assignees", status_code=201)
def add_task_assignee(task_id: str, body: dict, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    uid = body.get("user_id")
    if not uid:
        raise HTTPException(status_code=400, detail="user_id required")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            INSERT INTO task_assignees (task_id, user_id, role)
            VALUES (%s::uuid, %s::uuid, %s)
            ON CONFLICT (task_id, user_id) DO UPDATE SET role = EXCLUDED.role
            RETURNING id
        """, (task_id, uid, body.get("role", "assignee")))
        row = cur.fetchone()
        # Notify if different from current user
        if uid != user["user_id"]:
            try:
                from app.routers.notifications import create_notification
                create_notification(
                    conn,
                    recipient_id=uid,
                    sender_id=user["user_id"],
                    notification_type="task_assigned",
                    entity_type="task",
                    entity_id=task_id,
                    title="You were added as a task assignee",
                    message=body.get("note"),
                )
            except Exception:
                pass
        conn.commit()
        return {"id": str(row["id"])}
    finally:
        conn.close()


@router.delete("/{task_id}/assignees/{user_id}", status_code=204)
def remove_task_assignee(task_id: str, user_id: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM task_assignees WHERE task_id=%s::uuid AND user_id=%s::uuid",
            (task_id, user_id)
        )
        conn.commit()
    finally:
        conn.close()


# ── Task Dependencies (blocking) ──────────────────────────────────────────────

class ReviewRequestBody(BaseModel):
    reviewer_id: str
    note: str                      # what kind of review is wanted


class ReviewResolveBody(BaseModel):
    action: str                    # approved | changes_requested
    note: Optional[str] = None     # the reviewer's reply


@router.post("/{task_id}/review")
def request_review(task_id: str, body: ReviewRequestBody, request: Request):
    """Ask a specific person to review a task.

    Moving a card to Review used to tell nobody. A review is a request made of
    a named person, and the note is required rather than optional: "check my
    numbers" and "does this read right" want different attention, and a
    reviewer who has to guess will guess wrong.
    """
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not body.note.strip():
        raise HTTPException(status_code=422, detail="Say what kind of review you need")
    if body.reviewer_id == user["user_id"]:
        raise HTTPException(status_code=422, detail="Pick someone other than yourself to review")

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            """
            UPDATE tasks
            SET reviewer_id = %s::uuid,
                review_note = %s,
                review_requested_at = now(),
                kanban_status = 'review',
                status = CASE WHEN status = 'done' THEN 'open' ELSE status END,
                updated_at = now()
            WHERE task_id = %s::uuid
            RETURNING *
            """,
            (body.reviewer_id, body.note.strip(), task_id),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Task not found")

        try:
            from app.routers.notifications import create_notification
            create_notification(
                conn,
                recipient_id=body.reviewer_id,
                sender_id=user["user_id"],
                notification_type="review_requested",
                entity_type="task",
                entity_id=task_id,
                title=f"Review requested: {row['title']}",
                message=body.note.strip(),
            )
        except Exception:
            pass  # a missed notification must not lose the review request

        conn.commit()
        return _fmt(row)
    finally:
        conn.close()


@router.post("/{task_id}/review/resolve")
def resolve_review(task_id: str, body: ReviewResolveBody, request: Request):
    """Approve a task under review, or send it back for changes.

    Approving completes the task; asking for changes returns it to In Progress.
    Either way reviewer_id is cleared, so its presence always means a review is
    genuinely outstanding rather than merely once requested.
    """
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if body.action not in ("approved", "changes_requested"):
        raise HTTPException(status_code=422, detail="action must be approved or changes_requested")

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT task_id, title, reviewer_id, assigned_to, user_id FROM tasks WHERE task_id = %s::uuid",
            (task_id,),
        )
        task = cur.fetchone()
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        if not task["reviewer_id"] or str(task["reviewer_id"]) != user["user_id"]:
            raise HTTPException(status_code=403, detail="This review was not requested of you")

        approved = body.action == "approved"
        cur.execute(
            """
            UPDATE tasks
            SET reviewer_id = NULL,
                review_note = NULL,
                review_requested_at = NULL,
                kanban_status = %s,
                status = %s,
                -- Approving completes the task, so it stamps completion like
                -- any other route to done.
                completed_at = CASE WHEN %s THEN COALESCE(completed_at, now()) ELSE NULL END,
                updated_at = now()
            WHERE task_id = %s::uuid
            RETURNING *
            """,
            ("done" if approved else "in_progress", "done" if approved else "open", approved, task_id),
        )
        row = cur.fetchone()

        # Tell whoever asked. Falls back to the creator when the task is
        # unassigned in between, so the outcome never lands nowhere.
        recipient = str(task["assigned_to"] or task["user_id"] or "")
        if recipient and recipient != user["user_id"]:
            try:
                from app.routers.notifications import create_notification
                create_notification(
                    conn,
                    recipient_id=recipient,
                    sender_id=user["user_id"],
                    notification_type="review_resolved",
                    entity_type="task",
                    entity_id=task_id,
                    title=(
                        f"Review approved: {task['title']}" if approved
                        else f"Changes requested: {task['title']}"
                    ),
                    message=(body.note or "").strip() or None,
                )
            except Exception:
                pass

        conn.commit()
        return _fmt(row)
    finally:
        conn.close()


@router.get("/{task_id}/dependencies")
def list_task_dependencies(task_id: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT td.id, td.depends_on_task_id::text as blocking_task_id,
                   t.title as blocking_title, t.status as blocking_status, t.due_date as blocking_due_date
            FROM task_dependencies td
            JOIN tasks t ON t.task_id = td.depends_on_task_id
            WHERE td.task_id = %s::uuid
        """, (task_id,))
        blocked_by = [dict(r) for r in cur.fetchall()]
        cur.execute("""
            SELECT td.id, td.task_id::text as blocked_task_id,
                   t.title as blocked_title, t.status as blocked_status
            FROM task_dependencies td
            JOIN tasks t ON t.task_id = td.task_id
            WHERE td.depends_on_task_id = %s::uuid
        """, (task_id,))
        blocks = [dict(r) for r in cur.fetchall()]
        return {"blocked_by": blocked_by, "blocks": blocks}
    finally:
        conn.close()


@router.post("/{task_id}/dependencies", status_code=201)
def add_task_dependency(task_id: str, body: dict, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    depends_on = body.get("depends_on_task_id")
    if not depends_on:
        raise HTTPException(status_code=400, detail="depends_on_task_id required")
    if depends_on == task_id:
        raise HTTPException(status_code=400, detail="A task cannot depend on itself")
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            INSERT INTO task_dependencies (task_id, depends_on_task_id)
            VALUES (%s::uuid, %s::uuid)
            ON CONFLICT DO NOTHING
            RETURNING id
        """, (task_id, depends_on))
        row = cur.fetchone()
        conn.commit()
        return {"id": str(row["id"]) if row else None}
    finally:
        conn.close()


@router.delete("/{task_id}/dependencies/{dep_id}", status_code=204)
def remove_task_dependency(task_id: str, dep_id: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM task_dependencies WHERE id=%s::uuid AND task_id=%s::uuid",
            (dep_id, task_id)
        )
        conn.commit()
    finally:
        conn.close()
