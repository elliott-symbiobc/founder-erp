"""
milestones.py — Project milestones, resources, strategic goals, and templates.

Milestones (intermediate level: project → milestone → tasks):
GET    /projects/{id}/milestones                        — list milestones
POST   /projects/{id}/milestones                        — create milestone
PATCH  /projects/{id}/milestones/{mid}                  — update milestone
DELETE /projects/{id}/milestones/{mid}                  — delete milestone
POST   /projects/{id}/milestones/{mid}/complete         — mark complete
GET    /projects/{id}/milestones/{mid}/assignees        — list assignees
POST   /projects/{id}/milestones/{mid}/assignees        — add assignee
DELETE /projects/{id}/milestones/{mid}/assignees/{uid}  — remove assignee
GET    /projects/{id}/milestones/{mid}/dependencies     — list blocking deps
POST   /projects/{id}/milestones/{mid}/dependencies     — add dependency
DELETE /projects/{id}/milestones/{mid}/dependencies/{dep_id} — remove dep
POST   /projects/{id}/milestones/from-template          — instantiate template

Resources:
GET    /projects/{id}/resources             — list resources
POST   /projects/{id}/resources             — create resource
PATCH  /projects/{id}/resources/{rid}       — update resource
DELETE /projects/{id}/resources/{rid}       — delete resource

Strategic Goals:
GET    /strategic-goals                     — list all goals
POST   /strategic-goals                     — create goal
PATCH  /strategic-goals/{gid}               — update goal
DELETE /strategic-goals/{gid}               — delete goal
GET    /projects/{id}/goals                 — list goal links for project
POST   /projects/{id}/goals                 — link project to goal
DELETE /projects/{id}/goals/{gid}           — unlink

Templates:
GET    /project-templates                   — list all templates
GET    /project-templates/{tid}             — template detail with milestones+tasks
POST   /project-templates                   — create custom template
PATCH  /project-templates/{tid}             — update template
DELETE /project-templates/{tid}             — delete (non-default only)

Detail Configs:
GET    /project-detail-configs              — list all configs
POST   /project-detail-configs              — create config
PATCH  /project-detail-configs/{cid}        — update config
DELETE /project-detail-configs/{cid}        — delete

Reminder Templates:
GET    /reminder-templates                  — list
POST   /reminder-templates                  — create
PATCH  /reminder-templates/{rid}            — update
DELETE /reminder-templates/{rid}            — delete
"""

import logging
import os
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException, Query, Request

from app.routers.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(tags=["milestones"])


def _conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _fmt_row(row) -> dict:
    d = dict(row)
    for k, v in d.items():
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
        elif hasattr(v, "__str__") and type(v).__name__ == "UUID":
            d[k] = str(v)
    return d


def _fmt_rows(rows) -> list:
    return [_fmt_row(r) for r in rows]


# ─────────────────────────────────────────────────────────────────────────────
# MILESTONES
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/milestones")
def list_milestones(project_id: str):
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Self-healing reconciliation: catch milestones whose tasks are all
            # done but whose status wasn't rolled up (e.g. bulk imports/backfills/
            # direct DB edits that bypass the update_task() cascade in tasks.py).
            cur.execute(
                """
                UPDATE project_milestones m
                SET status = 'complete', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
                WHERE m.project_id = %s
                  AND m.status != 'complete'
                  AND EXISTS (SELECT 1 FROM tasks t WHERE t.milestone_id = m.milestone_id)
                  AND NOT EXISTS (
                      SELECT 1 FROM tasks t WHERE t.milestone_id = m.milestone_id AND t.status != 'done'
                  )
                """,
                (project_id,),
            )
            conn.commit()

            # Milestones with assignee list and blocking status
            cur.execute("""
                SELECT
                    m.*,
                    COALESCE(u.full_name, u.name) as owner_name,
                    (
                        SELECT json_agg(json_build_object(
                            'user_id', ma.user_id,
                            'role', ma.role,
                            'name', COALESCE(au.full_name, au.name)
                        ) ORDER BY ma.created_at)
                        FROM milestone_assignees ma
                        JOIN users au ON au.user_id = ma.user_id
                        WHERE ma.milestone_id = m.milestone_id
                    ) as assignees,
                    (
                        SELECT COUNT(*) FROM milestone_dependencies md
                        WHERE md.milestone_id = m.milestone_id
                    ) as blocked_by_count,
                    (
                        SELECT COUNT(*) FROM milestone_dependencies md
                        WHERE md.depends_on_milestone_id = m.milestone_id
                    ) as blocks_count,
                    (
                        SELECT COUNT(*) FROM tasks t
                        WHERE t.milestone_id = m.milestone_id AND t.status = 'open'
                    ) as open_task_count,
                    (
                        SELECT COUNT(*) FROM tasks t
                        WHERE t.milestone_id = m.milestone_id AND t.status = 'done'
                    ) as done_task_count
                FROM project_milestones m
                LEFT JOIN users u ON u.user_id = m.owner_id
                WHERE m.project_id = %s
                ORDER BY m.sort_order ASC, m.created_at ASC
            """, (project_id,))
            return _fmt_rows(cur.fetchall())
    finally:
        conn.close()


@router.post("/projects/{project_id}/milestones", status_code=201)
def create_milestone(project_id: str, body: dict, request: Request):
    user = get_current_user(request)
    if not body.get("title"):
        raise HTTPException(status_code=400, detail="title required")

    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Get next sort_order
            cur.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM project_milestones WHERE project_id = %s",
                (project_id,)
            )
            next_order = cur.fetchone()["next_order"]

            cur.execute("""
                INSERT INTO project_milestones
                    (project_id, title, description, milestone_type, status,
                     due_date, start_date, owner_id, sort_order,
                     document_deliverable, auto_reminder_config, integration_refs,
                     parent_milestone_id, template_milestone_id)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING milestone_id
            """, (
                project_id,
                body["title"],
                body.get("description"),
                body.get("milestone_type", "objective"),
                body.get("status", "pending"),
                body.get("due_date") or None,
                body.get("start_date") or None,
                body.get("owner_id") or (user["user_id"] if user else None),
                body.get("sort_order", next_order),
                bool(body.get("document_deliverable", False)),
                psycopg2.extras.Json(body.get("auto_reminder_config", {})),
                psycopg2.extras.Json(body.get("integration_refs", {})),
                body.get("parent_milestone_id") or None,
                body.get("template_milestone_id") or None,
            ))
            row = cur.fetchone()
            mid = str(row["milestone_id"])

            # Add assignees if provided
            assignees = body.get("assignees", [])
            if user and not any(a.get("user_id") == user["user_id"] for a in assignees):
                assignees = [{"user_id": user["user_id"], "role": "assignee"}] + assignees
            for a in assignees:
                if a.get("user_id"):
                    cur.execute("""
                        INSERT INTO milestone_assignees (milestone_id, user_id, role)
                        VALUES (%s, %s, %s) ON CONFLICT DO NOTHING
                    """, (mid, a["user_id"], a.get("role", "assignee")))

            conn.commit()
            return {"milestone_id": mid}
    finally:
        conn.close()


MILESTONE_UPDATABLE = {
    "title", "description", "milestone_type", "status",
    "due_date", "start_date", "owner_id", "sort_order",
    "document_deliverable", "auto_reminder_config", "integration_refs",
    "drive_file_id", "drive_file_name", "parent_milestone_id",
}


@router.patch("/projects/{project_id}/milestones/{milestone_id}")
def update_milestone(project_id: str, milestone_id: str, body: dict, request: Request):
    user = get_current_user(request)
    updates = {k: v for k, v in body.items() if k in MILESTONE_UPDATABLE}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields")

    # Serialize JSONB fields
    for jf in ("auto_reminder_config", "integration_refs"):
        if jf in updates and isinstance(updates[jf], dict):
            updates[jf] = psycopg2.extras.Json(updates[jf])

    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values()) + [milestone_id, project_id]

    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"UPDATE project_milestones SET {set_clause}, updated_at=NOW() WHERE milestone_id=%s AND project_id=%s RETURNING status",
                values,
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Milestone not found")
            new_status = cur.fetchone()["status"]

            # When activated, unlock the first locked task to start the sequential chain
            if new_status == "in_progress":
                cur.execute(
                    """
                    UPDATE tasks SET locked = false
                    WHERE task_id = (
                        SELECT task_id FROM tasks
                        WHERE milestone_id = %s::uuid AND locked = true
                        ORDER BY sort_order ASC NULLS LAST, created_at ASC
                        LIMIT 1
                    )
                    RETURNING task_id::text, title, assigned_to::text
                    """,
                    (milestone_id,),
                )
                unlocked = cur.fetchone()
                if unlocked and unlocked.get("assigned_to"):
                    sender_id = user["user_id"] if user else unlocked["assigned_to"]
                    if unlocked["assigned_to"] != sender_id:
                        try:
                            from app.routers.notifications import create_notification
                            create_notification(
                                conn,
                                recipient_id=unlocked["assigned_to"],
                                sender_id=sender_id,
                                notification_type="task_assigned",
                                entity_type="task",
                                entity_id=unlocked["task_id"],
                                title=f"Task ready: {unlocked['title']}",
                                message="An objective you're assigned to has been activated.",
                            )
                        except Exception:
                            pass
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/projects/{project_id}/milestones/{milestone_id}/complete")
def complete_milestone(project_id: str, milestone_id: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE project_milestones
                SET status='complete', completed_at=NOW(), updated_at=NOW()
                WHERE milestone_id=%s AND project_id=%s
            """, (milestone_id, project_id))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Milestone not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/projects/{project_id}/milestones/{milestone_id}/activate")
def activate_milestone(project_id: str, milestone_id: str):
    """Unlock the first locked task in this objective to start the sequential chain."""
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE tasks SET locked = false
                WHERE task_id = (
                    SELECT task_id FROM tasks
                    WHERE milestone_id = %s::uuid AND project_id = %s::uuid AND locked = true
                    ORDER BY sort_order ASC NULLS LAST, created_at ASC
                    LIMIT 1
                )
                """,
                (milestone_id, project_id)
            )
            count = cur.rowcount
            conn.commit()
            return {"unlocked": count}
    finally:
        conn.close()


@router.delete("/projects/{project_id}/milestones/{milestone_id}", status_code=204)
def delete_milestone(project_id: str, milestone_id: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            # Unlink tasks before deleting
            cur.execute(
                "UPDATE tasks SET milestone_id=NULL WHERE milestone_id=%s",
                (milestone_id,)
            )
            cur.execute(
                "DELETE FROM project_milestones WHERE milestone_id=%s AND project_id=%s",
                (milestone_id, project_id)
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Milestone not found")
            conn.commit()
    finally:
        conn.close()


# ── Milestone Assignees ───────────────────────────────────────────────────────

@router.get("/projects/{project_id}/milestones/{milestone_id}/assignees")
def list_milestone_assignees(project_id: str, milestone_id: str):
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT ma.id, ma.user_id, ma.role, ma.created_at,
                       COALESCE(u.full_name, u.name) as name
                FROM milestone_assignees ma
                JOIN users u ON u.user_id = ma.user_id
                WHERE ma.milestone_id = %s
                ORDER BY ma.created_at ASC
            """, (milestone_id,))
            return _fmt_rows(cur.fetchall())
    finally:
        conn.close()


@router.post("/projects/{project_id}/milestones/{milestone_id}/assignees", status_code=201)
def add_milestone_assignee(project_id: str, milestone_id: str, body: dict):
    user_id = body.get("user_id")
    role = body.get("role", "assignee")
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id required")
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO milestone_assignees (milestone_id, user_id, role)
                VALUES (%s, %s, %s)
                ON CONFLICT (milestone_id, user_id) DO UPDATE SET role = EXCLUDED.role
                RETURNING id
            """, (milestone_id, user_id, role))
            row = cur.fetchone()
            conn.commit()
            return {"id": str(row["id"])}
    finally:
        conn.close()


@router.delete("/projects/{project_id}/milestones/{milestone_id}/assignees/{user_id}", status_code=204)
def remove_milestone_assignee(project_id: str, milestone_id: str, user_id: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM milestone_assignees WHERE milestone_id=%s AND user_id=%s",
                (milestone_id, user_id)
            )
            conn.commit()
    finally:
        conn.close()


# ── Milestone Dependencies ────────────────────────────────────────────────────

@router.get("/projects/{project_id}/milestones/{milestone_id}/dependencies")
def list_milestone_dependencies(project_id: str, milestone_id: str):
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # What this milestone is blocked by
            cur.execute("""
                SELECT md.id, md.depends_on_milestone_id as blocking_milestone_id,
                       md.dependency_type,
                       m.title as blocking_title, m.status as blocking_status, m.due_date as blocking_due_date
                FROM milestone_dependencies md
                JOIN project_milestones m ON m.milestone_id = md.depends_on_milestone_id
                WHERE md.milestone_id = %s
                ORDER BY md.created_at ASC
            """, (milestone_id,))
            blocked_by = _fmt_rows(cur.fetchall())

            # What this milestone blocks
            cur.execute("""
                SELECT md.id, md.milestone_id as blocked_milestone_id,
                       md.dependency_type,
                       m.title as blocked_title, m.status as blocked_status
                FROM milestone_dependencies md
                JOIN project_milestones m ON m.milestone_id = md.milestone_id
                WHERE md.depends_on_milestone_id = %s
                ORDER BY md.created_at ASC
            """, (milestone_id,))
            blocks = _fmt_rows(cur.fetchall())

            return {"blocked_by": blocked_by, "blocks": blocks}
    finally:
        conn.close()


@router.post("/projects/{project_id}/milestones/{milestone_id}/dependencies", status_code=201)
def add_milestone_dependency(project_id: str, milestone_id: str, body: dict):
    """Mark that milestone_id depends_on (is blocked by) depends_on_milestone_id."""
    depends_on = body.get("depends_on_milestone_id")
    if not depends_on:
        raise HTTPException(status_code=400, detail="depends_on_milestone_id required")
    if depends_on == milestone_id:
        raise HTTPException(status_code=400, detail="A milestone cannot depend on itself")

    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO milestone_dependencies
                    (milestone_id, depends_on_milestone_id, dependency_type)
                VALUES (%s, %s, %s)
                ON CONFLICT (milestone_id, depends_on_milestone_id) DO NOTHING
                RETURNING id
            """, (milestone_id, depends_on, body.get("dependency_type", "finish_to_start")))
            row = cur.fetchone()
            conn.commit()

            # Auto-set milestone status to blocked if blocker is not complete
            cur2 = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur2.execute(
                "SELECT status FROM project_milestones WHERE milestone_id=%s", (depends_on,)
            )
            blocker = cur2.fetchone()
            if blocker and blocker["status"] not in ("complete", "skipped"):
                cur2.execute(
                    "UPDATE project_milestones SET status='blocked', updated_at=NOW() WHERE milestone_id=%s AND status='pending'",
                    (milestone_id,)
                )
                conn.commit()

            return {"id": str(row["id"]) if row else None}
    finally:
        conn.close()


@router.delete("/projects/{project_id}/milestones/{milestone_id}/dependencies/{dep_id}", status_code=204)
def remove_milestone_dependency(project_id: str, milestone_id: str, dep_id: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM milestone_dependencies WHERE id=%s AND milestone_id=%s",
                (dep_id, milestone_id)
            )
            conn.commit()
    finally:
        conn.close()


# ── Instantiate template into a project ──────────────────────────────────────

@router.post("/projects/{project_id}/milestones/from-template")
def apply_template(project_id: str, body: dict, request: Request):
    """Create milestones (and optionally tasks) from a template_id."""
    template_id = body.get("template_id")
    if not template_id:
        raise HTTPException(status_code=400, detail="template_id required")

    include_tasks = bool(body.get("include_tasks", True))
    user = get_current_user(request)
    # Template tasks are assigned to whoever applies the template, so an
    # anonymous caller would mint tasks belonging to nobody -- which is how
    # creator-less, assignee-less rows got into the table in the first place.
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Load template milestones ordered by sort_order
            cur.execute("""
                SELECT * FROM template_milestones
                WHERE template_id = %s ORDER BY sort_order ASC
            """, (template_id,))
            t_milestones = cur.fetchall()
            if not t_milestones:
                raise HTTPException(status_code=404, detail="Template not found or has no milestones")

            # Load all template tasks
            milestone_ids = [str(m["id"]) for m in t_milestones]
            cur.execute("""
                SELECT * FROM template_tasks
                WHERE template_milestone_id = ANY(%s::uuid[])
                ORDER BY sort_order ASC
            """, (milestone_ids,))
            t_tasks_all = cur.fetchall()
            tasks_by_milestone = {}
            for t in t_tasks_all:
                key = str(t["template_milestone_id"])
                tasks_by_milestone.setdefault(key, []).append(t)

            # Get current max sort_order in project
            cur.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM project_milestones WHERE project_id=%s",
                (project_id,)
            )
            base_order = cur.fetchone()["next_order"]

            created_milestone_ids = []
            # Map template milestone id → new project milestone id (for parent linking)
            tmpl_to_proj = {}

            for i, tm in enumerate(t_milestones):
                parent_proj_id = tmpl_to_proj.get(str(tm["parent_id"])) if tm.get("parent_id") else None
                cur.execute("""
                    INSERT INTO project_milestones
                        (project_id, template_milestone_id, title, description,
                         milestone_type, sort_order, document_deliverable,
                         auto_reminder_config, integration_refs, parent_milestone_id)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    RETURNING milestone_id
                """, (
                    project_id,
                    str(tm["id"]),
                    tm["title"],
                    tm.get("description"),
                    tm["milestone_type"],
                    base_order + i,
                    bool(tm.get("document_deliverable", False)),
                    psycopg2.extras.Json(tm.get("auto_reminder_config") or {}),
                    psycopg2.extras.Json(tm.get("integrations") or {}),
                    parent_proj_id,
                ))
                new_mid = str(cur.fetchone()["milestone_id"])
                tmpl_to_proj[str(tm["id"])] = new_mid
                created_milestone_ids.append(new_mid)

                if include_tasks:
                    for tt in tasks_by_milestone.get(str(tm["id"]), []):
                        import uuid as _uuid
                        try:
                            task_uid = str(_uuid.UUID(str(user["user_id"])))
                        except (ValueError, AttributeError, KeyError, TypeError):
                            # Swallowing this used to mean inserting NULL and
                            # producing a task nobody owns. Tasks require both an
                            # owner and an assignee, so fail the request instead.
                            raise HTTPException(status_code=400, detail="Invalid user session")
                        cur.execute("""
                            INSERT INTO tasks
                                (user_id, assigned_to, title, description, activity_type,
                                 project_id, milestone_id, sort_order,
                                 estimated_minutes, status, kanban_status, locked)
                            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'open','todo',true)
                        """, (
                            task_uid,
                            task_uid,
                            tt["title"],
                            tt.get("description"),
                            tt.get("activity_type"),
                            project_id,
                            new_mid,
                            tt["sort_order"],
                            tt.get("estimated_minutes"),
                        ))

            # Update project template_id reference
            cur.execute(
                "UPDATE projects SET template_id=%s, template_applied_at=NOW() WHERE project_id=%s",
                (template_id, project_id)
            )
            conn.commit()
            return {"milestone_ids": created_milestone_ids}
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# RESOURCES
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/resources")
def list_resources(project_id: str):
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT r.*,
                       COALESCE(u.full_name, u.name) as assigned_user_name,
                       m.title as milestone_title
                FROM project_resources r
                LEFT JOIN users u ON u.user_id = r.assigned_user_id
                LEFT JOIN project_milestones m ON m.milestone_id = r.milestone_id
                WHERE r.project_id = %s
                ORDER BY r.resource_type, r.start_date ASC NULLS LAST
            """, (project_id,))
            return _fmt_rows(cur.fetchall())
    finally:
        conn.close()


RESOURCE_FIELDS = {
    "resource_type", "label", "quantity", "unit",
    "start_date", "end_date", "cost_estimate",
    "assigned_user_id", "equipment_id", "notes", "milestone_id",
}


@router.post("/projects/{project_id}/resources", status_code=201)
def create_resource(project_id: str, body: dict):
    if not body.get("label") or not body.get("resource_type"):
        raise HTTPException(status_code=400, detail="label and resource_type required")
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO project_resources
                    (project_id, resource_type, label, quantity, unit,
                     start_date, end_date, cost_estimate,
                     assigned_user_id, equipment_id, notes, milestone_id)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
            """, (
                project_id,
                body["resource_type"],
                body["label"],
                body.get("quantity"),
                body.get("unit"),
                body.get("start_date") or None,
                body.get("end_date") or None,
                body.get("cost_estimate"),
                body.get("assigned_user_id") or None,
                body.get("equipment_id") or None,
                body.get("notes"),
                body.get("milestone_id") or None,
            ))
            row = cur.fetchone()
            conn.commit()
            return {"id": str(row["id"])}
    finally:
        conn.close()


@router.patch("/projects/{project_id}/resources/{resource_id}")
def update_resource(project_id: str, resource_id: str, body: dict):
    updates = {k: v for k, v in body.items() if k in RESOURCE_FIELDS}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values()) + [resource_id, project_id]
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE project_resources SET {set_clause}, updated_at=NOW() WHERE id=%s AND project_id=%s",
                values,
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404)
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/projects/{project_id}/resources/{resource_id}", status_code=204)
def delete_resource(project_id: str, resource_id: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM project_resources WHERE id=%s AND project_id=%s", (resource_id, project_id))
            conn.commit()
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# STRATEGIC GOALS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/strategic-goals")
def list_goals(status: Optional[str] = Query(None)):
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if status:
                cur.execute("""
                    SELECT g.*,
                           COALESCE(u.full_name, u.name) as owner_name,
                           (SELECT COUNT(*) FROM project_goal_links pgl WHERE pgl.goal_id = g.goal_id) as project_count
                    FROM strategic_goals g
                    LEFT JOIN users u ON u.user_id = g.owner_id
                    WHERE g.status = %s
                    ORDER BY g.sort_order, g.target_date ASC NULLS LAST
                """, (status,))
            else:
                cur.execute("""
                    SELECT g.*,
                           COALESCE(u.full_name, u.name) as owner_name,
                           (SELECT COUNT(*) FROM project_goal_links pgl WHERE pgl.goal_id = g.goal_id) as project_count
                    FROM strategic_goals g
                    LEFT JOIN users u ON u.user_id = g.owner_id
                    ORDER BY
                        CASE g.status WHEN 'active' THEN 0 WHEN 'achieved' THEN 1 ELSE 2 END,
                        g.sort_order, g.target_date ASC NULLS LAST
                """)
            return _fmt_rows(cur.fetchall())
    finally:
        conn.close()


@router.post("/strategic-goals", status_code=201)
def create_goal(body: dict, request: Request):
    user = get_current_user(request)
    if not body.get("title"):
        raise HTTPException(status_code=400, detail="title required")
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO strategic_goals (title, description, category, target_date, status, owner_id, sort_order)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                RETURNING goal_id
            """, (
                body["title"],
                body.get("description"),
                body.get("category"),
                body.get("target_date") or None,
                body.get("status", "active"),
                body.get("owner_id") or (user["user_id"] if user else None),
                body.get("sort_order", 0),
            ))
            row = cur.fetchone()
            conn.commit()
            return {"goal_id": str(row["goal_id"])}
    finally:
        conn.close()


@router.patch("/strategic-goals/{goal_id}")
def update_goal(goal_id: str, body: dict):
    allowed = {"title", "description", "category", "target_date", "status", "owner_id", "sort_order"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values()) + [goal_id]
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE strategic_goals SET {set_clause}, updated_at=NOW() WHERE goal_id=%s",
                values,
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404)
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/strategic-goals/{goal_id}", status_code=204)
def delete_goal(goal_id: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM strategic_goals WHERE goal_id=%s", (goal_id,))
            conn.commit()
    finally:
        conn.close()


# ── Project ↔ Goal links ──────────────────────────────────────────────────────

@router.get("/projects/{project_id}/goals")
def list_project_goals(project_id: str):
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT pgl.id, pgl.goal_id, pgl.contribution_notes, pgl.created_at,
                       g.title, g.category, g.status, g.target_date
                FROM project_goal_links pgl
                JOIN strategic_goals g ON g.goal_id = pgl.goal_id
                WHERE pgl.project_id = %s
                ORDER BY g.category, g.title
            """, (project_id,))
            return _fmt_rows(cur.fetchall())
    finally:
        conn.close()


@router.post("/projects/{project_id}/goals", status_code=201)
def link_project_goal(project_id: str, body: dict):
    goal_id = body.get("goal_id")
    if not goal_id:
        raise HTTPException(status_code=400, detail="goal_id required")
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO project_goal_links (project_id, goal_id, contribution_notes)
                VALUES (%s, %s, %s)
                ON CONFLICT (project_id, goal_id) DO UPDATE SET contribution_notes = EXCLUDED.contribution_notes
                RETURNING id
            """, (project_id, goal_id, body.get("contribution_notes")))
            row = cur.fetchone()
            conn.commit()
            return {"id": str(row["id"])}
    finally:
        conn.close()


@router.delete("/projects/{project_id}/goals/{goal_id}", status_code=204)
def unlink_project_goal(project_id: str, goal_id: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM project_goal_links WHERE project_id=%s AND goal_id=%s",
                (project_id, goal_id)
            )
            conn.commit()
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# PROJECT TEMPLATES
# ─────────────────────────────────────────────────────────────────────────────

TYPE_ALIASES = {
    "crm_opportunity": "portfolio",
    "project": "portfolio",
    "poc": "portfolio",
    "funding": "grant",
}

@router.get("/project-templates")
def list_templates(project_type: Optional[str] = Query(None)):
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if project_type:
                canonical = TYPE_ALIASES.get(project_type, project_type)
                cur.execute("""
                    SELECT t.*, COALESCE(u.full_name, u.name) as created_by_name,
                           (SELECT COUNT(*) FROM template_milestones tm WHERE tm.template_id = t.template_id) as milestone_count
                    FROM project_templates t
                    LEFT JOIN users u ON u.user_id = t.created_by
                    WHERE t.project_type = %s
                    ORDER BY t.is_default DESC, t.name ASC
                """, (canonical,))
            else:
                cur.execute("""
                    SELECT t.*, COALESCE(u.full_name, u.name) as created_by_name,
                           (SELECT COUNT(*) FROM template_milestones tm WHERE tm.template_id = t.template_id) as milestone_count
                    FROM project_templates t
                    LEFT JOIN users u ON u.user_id = t.created_by
                    ORDER BY t.project_type, t.is_default DESC, t.name ASC
                """)
            return _fmt_rows(cur.fetchall())
    finally:
        conn.close()


@router.get("/project-templates/{template_id}")
def get_template(template_id: str):
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM project_templates WHERE template_id=%s", (template_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404)
            result = _fmt_row(row)

            cur.execute("""
                SELECT tm.*,
                       json_agg(
                           json_build_object(
                               'id', tt.id,
                               'title', tt.title,
                               'description', tt.description,
                               'activity_type', tt.activity_type,
                               'sort_order', tt.sort_order,
                               'estimated_minutes', tt.estimated_minutes,
                               'integrations', tt.integrations
                           ) ORDER BY tt.sort_order
                       ) FILTER (WHERE tt.id IS NOT NULL) as tasks
                FROM template_milestones tm
                LEFT JOIN template_tasks tt ON tt.template_milestone_id = tm.id
                WHERE tm.template_id = %s
                GROUP BY tm.id
                ORDER BY tm.sort_order ASC
            """, (template_id,))
            result["milestones"] = _fmt_rows(cur.fetchall())
            return result
    finally:
        conn.close()


@router.post("/project-templates", status_code=201)
def create_template(body: dict, request: Request):
    user = get_current_user(request)
    if not body.get("name") or not body.get("project_type"):
        raise HTTPException(status_code=400, detail="name and project_type required")
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO project_templates (name, description, project_type, is_default, is_shared, created_by, config)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                RETURNING template_id
            """, (
                body["name"],
                body.get("description"),
                body["project_type"],
                bool(body.get("is_default", False)),
                bool(body.get("is_shared", True)),
                user["user_id"] if user else None,
                psycopg2.extras.Json(body.get("config", {})),
            ))
            row = cur.fetchone()
            conn.commit()
            return {"template_id": str(row["template_id"])}
    finally:
        conn.close()


@router.patch("/project-templates/{template_id}")
def update_template(template_id: str, body: dict):
    allowed = {"name", "description", "project_type", "is_shared", "config"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields")
    if "config" in updates and isinstance(updates["config"], dict):
        updates["config"] = psycopg2.extras.Json(updates["config"])
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values()) + [template_id]
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE project_templates SET {set_clause}, updated_at=NOW() WHERE template_id=%s",
                values,
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404)
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/project-templates/{template_id}", status_code=204)
def delete_template(template_id: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM project_templates WHERE template_id=%s AND is_default=false",
                (template_id,)
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=403, detail="Cannot delete default templates")
            conn.commit()
    finally:
        conn.close()


# ── Template milestone CRUD ───────────────────────────────────────────────────

@router.post("/project-templates/{template_id}/milestones", status_code=201)
def add_template_milestone(template_id: str, body: dict):
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM template_milestones WHERE template_id=%s",
                (template_id,)
            )
            sort_order = cur.fetchone()["next_order"]
            cur.execute("""
                INSERT INTO template_milestones
                    (template_id, title, description, milestone_type, sort_order,
                     default_duration_days, document_deliverable, is_blocking)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id, title, milestone_type, sort_order, description,
                          default_duration_days, document_deliverable, is_blocking, created_at
            """, (
                template_id,
                body.get("title", "New Milestone"),
                body.get("description"),
                body.get("milestone_type", "objective"),
                body.get("sort_order", sort_order),
                body.get("default_duration_days"),
                bool(body.get("document_deliverable", False)),
                bool(body.get("is_blocking", False)),
            ))
            row = cur.fetchone()
            conn.commit()
            return _fmt_row(row)
    finally:
        conn.close()


@router.patch("/template-milestones/{milestone_id}")
def update_template_milestone(milestone_id: str, body: dict):
    allowed = {"title", "description", "milestone_type", "sort_order",
               "default_duration_days", "document_deliverable", "is_blocking"}
    updates = {k: v for k, v in body.items() if k in allowed and v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values()) + [milestone_id]
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE template_milestones SET {set_clause} WHERE id=%s",
                values,
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404)
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/template-milestones/{milestone_id}", status_code=204)
def delete_template_milestone(milestone_id: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM template_milestones WHERE id=%s", (milestone_id,))
            conn.commit()
    finally:
        conn.close()


@router.post("/template-milestones/{milestone_id}/tasks", status_code=201)
def add_template_task(milestone_id: str, body: dict):
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM template_tasks WHERE template_milestone_id=%s",
                (milestone_id,)
            )
            sort_order = cur.fetchone()["next_order"]
            cur.execute("""
                INSERT INTO template_tasks
                    (template_milestone_id, title, description, activity_type, sort_order, estimated_minutes)
                VALUES (%s,%s,%s,%s,%s,%s)
                RETURNING id, title, description, activity_type, sort_order, estimated_minutes
            """, (
                milestone_id,
                body.get("title", "New Task"),
                body.get("description"),
                body.get("activity_type"),
                body.get("sort_order", sort_order),
                body.get("estimated_minutes"),
            ))
            row = cur.fetchone()
            conn.commit()
            return _fmt_row(row)
    finally:
        conn.close()


@router.patch("/template-tasks/{task_id}")
def update_template_task(task_id: str, body: dict):
    allowed = {"title", "description", "activity_type", "sort_order", "estimated_minutes"}
    updates = {k: v for k, v in body.items() if k in allowed and v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values()) + [task_id]
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE template_tasks SET {set_clause} WHERE id=%s", values)
            if cur.rowcount == 0:
                raise HTTPException(status_code=404)
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/template-tasks/{task_id}", status_code=204)
def delete_template_task(task_id: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM template_tasks WHERE id=%s", (task_id,))
            conn.commit()
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# PROJECT DETAIL CONFIGS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/project-detail-configs")
def list_detail_configs(project_type: Optional[str] = Query(None)):
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if project_type:
                cur.execute("""
                    SELECT c.*, COALESCE(u.full_name, u.name) as created_by_name
                    FROM project_detail_configs c
                    LEFT JOIN users u ON u.user_id = c.created_by
                    WHERE c.project_type = %s OR c.project_type IS NULL
                    ORDER BY c.is_default DESC, c.name ASC
                """, (project_type,))
            else:
                cur.execute("""
                    SELECT c.*, COALESCE(u.full_name, u.name) as created_by_name
                    FROM project_detail_configs c
                    LEFT JOIN users u ON u.user_id = c.created_by
                    ORDER BY c.project_type NULLS LAST, c.is_default DESC, c.name ASC
                """)
            return _fmt_rows(cur.fetchall())
    finally:
        conn.close()


@router.post("/project-detail-configs", status_code=201)
def create_detail_config(body: dict, request: Request):
    user = get_current_user(request)
    if not body.get("name") or not body.get("config"):
        raise HTTPException(status_code=400, detail="name and config required")
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO project_detail_configs
                    (name, project_type, is_default, is_shared, created_by, config)
                VALUES (%s,%s,%s,%s,%s,%s)
                RETURNING config_id
            """, (
                body["name"],
                body.get("project_type"),
                bool(body.get("is_default", False)),
                bool(body.get("is_shared", True)),
                user["user_id"] if user else None,
                psycopg2.extras.Json(body["config"]),
            ))
            row = cur.fetchone()
            conn.commit()
            return {"config_id": str(row["config_id"])}
    finally:
        conn.close()


@router.patch("/project-detail-configs/{config_id}")
def update_detail_config(config_id: str, body: dict):
    allowed = {"name", "project_type", "is_default", "is_shared", "config"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields")
    if "config" in updates and isinstance(updates["config"], dict):
        updates["config"] = psycopg2.extras.Json(updates["config"])
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values()) + [config_id]
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE project_detail_configs SET {set_clause}, updated_at=NOW() WHERE config_id=%s",
                values,
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404)
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/project-detail-configs/{config_id}", status_code=204)
def delete_detail_config(config_id: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM project_detail_configs WHERE config_id=%s AND is_default=false",
                (config_id,)
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=403, detail="Cannot delete default configs")
            conn.commit()
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# REMINDER TEMPLATES
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/reminder-templates")
def list_reminder_templates(project_type: Optional[str] = Query(None)):
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if project_type:
                cur.execute("""
                    SELECT * FROM reminder_templates
                    WHERE (project_type = %s OR project_type IS NULL) AND is_active = true
                    ORDER BY project_type NULLS LAST, name ASC
                """, (project_type,))
            else:
                cur.execute("""
                    SELECT * FROM reminder_templates
                    WHERE is_active = true
                    ORDER BY project_type NULLS LAST, name ASC
                """)
            return _fmt_rows(cur.fetchall())
    finally:
        conn.close()


@router.post("/reminder-templates", status_code=201)
def create_reminder_template(body: dict, request: Request):
    user = get_current_user(request)
    if not body.get("name") or not body.get("trigger_type"):
        raise HTTPException(status_code=400, detail="name and trigger_type required")
    conn = _conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO reminder_templates
                    (name, project_type, trigger_type, trigger_days,
                     subject_template, message_template, auto_send, created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
            """, (
                body["name"],
                body.get("project_type"),
                body["trigger_type"],
                body.get("trigger_days", 3),
                body.get("subject_template"),
                body.get("message_template"),
                bool(body.get("auto_send", False)),
                user["user_id"] if user else None,
            ))
            row = cur.fetchone()
            conn.commit()
            return {"id": str(row["id"])}
    finally:
        conn.close()


@router.patch("/reminder-templates/{rid}")
def update_reminder_template(rid: str, body: dict):
    allowed = {"name", "project_type", "trigger_type", "trigger_days",
               "subject_template", "message_template", "auto_send", "is_active"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values()) + [rid]
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE reminder_templates SET {set_clause}, updated_at=NOW() WHERE id=%s",
                values,
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404)
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/reminder-templates/{rid}", status_code=204)
def delete_reminder_template(rid: str):
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM reminder_templates WHERE id=%s", (rid,))
            conn.commit()
    finally:
        conn.close()
