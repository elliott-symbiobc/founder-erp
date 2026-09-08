"""
projects.py — Projects module endpoints.

GET    /projects                          — list all projects (filterable)
GET    /projects/{project_id}             — project detail
POST   /projects                          — create project
PATCH  /projects/{project_id}             — update project fields
DELETE /projects/{project_id}             — delete project
POST   /projects/{project_id}/summary     — generate AI summary
PATCH  /projects/{project_id}/summary     — manually edit summary
POST   /crm/deals/{deal_id}/create-project — auto-create project from CRM deal
GET    /projects/{project_id}/fpa-links   — list FP&A contract links
POST   /projects/{project_id}/fpa-links   — link to FP&A contract
DELETE /projects/{project_id}/fpa-links/{link_id} — remove link
"""

import logging
import os
from typing import Optional

import anthropic
import psycopg2
import psycopg2.extras
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request

from app.routers.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["projects"])

# Stage sequences per project type
STAGE_SEQUENCES = {
    "portfolio": ["Prospect", "Qualified", "Assessment", "Proposal", "Legal", "Contracted", "R&D", "Pilot", "Production"],
    "partnership": ["Exploring", "Negotiating", "Agreement", "Active", "Complete"],
    "grant": ["Identified", "In Prep", "Submitted", "Under Review", "Won", "Lost"],
    "internal": ["Backlog", "Planning", "Active", "Validation", "Complete"],
    # legacy fallback
    "crm_opportunity": ["New", "Qualified", "Initial Testing", "Proposition", "Won", "Inactive", "No Response"],
    "project": ["New", "Qualified", "Initial Testing", "Proposition", "Won", "Inactive", "No Response"],
}
STAGE_ORDER = ["New", "Qualified", "Initial Testing", "Proposition", "Won", "Inactive", "No Response"]

UPDATABLE = {
    "name", "description", "project_type", "stage", "status",
    "contact_id", "probability", "expected_revenue",
    "date_start", "date_deadline", "tags", "notes", "section", "crm_type",
    "assigned_to", "revenue_to_date",
    "lead_source", "esg_url", "company_description",
}


def get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("")
def list_projects(
    search: Optional[str] = Query(None),
    project_type: Optional[str] = Query(None),
    crm_type: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    stage: Optional[str] = Query(None),
    contact_id: Optional[str] = Query(None),
    tags: Optional[str] = Query(None),  # comma-separated
):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            filters = []
            params: list = []

            if search:
                filters.append("(p.name ILIKE %s OR p.description ILIKE %s OR c.name ILIKE %s)")
                s = f"%{search}%"
                params.extend([s, s, s])
            if project_type:
                types = [t.strip() for t in project_type.split(",") if t.strip()]
                filters.append("p.project_type = ANY(%s)")
                params.append(types)
            if crm_type:
                filters.append("p.crm_type = %s")
                params.append(crm_type)
            if status:
                statuses = [s.strip() for s in status.split(",") if s.strip()]
                filters.append("p.status = ANY(%s)")
                params.append(statuses)
            if stage:
                filters.append("p.stage = %s")
                params.append(stage)
            if contact_id:
                filters.append("p.contact_id = %s")
                params.append(contact_id)

            if tags:
                tag_list = [t.strip() for t in tags.split(",") if t.strip()]
                if tag_list:
                    filters.append("p.tags && %s")
                    params.append(tag_list)

            where = ("WHERE " + " AND ".join(filters)) if filters else ""

            cur.execute(f"""
                SELECT
                    p.project_id, p.name, p.project_type, p.stage, p.status,
                    p.probability, p.expected_revenue,
                    p.date_start, p.date_deadline,
                    p.tags, p.notes, p.section, p.crm_type,
                    p.odoo_crm_id, p.odoo_project_id,
                    p.created_at, p.updated_at,
                    p.contact_id,
                    c.name as contact_name,
                    c.organization as contact_org,
                    c.avatar_url as contact_avatar,
                    c.email as contact_email,
                    c.title as contact_title,
                    p.assigned_to,
                    COALESCE(u.full_name, u.name) as assigned_to_name,
                    p.linked_opportunity_id, p.linked_investor_id,
                    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.project_id) as task_count,
                    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.project_id AND t.status = 'done') as tasks_done,
                    (SELECT MAX(ci.occurred_at) FROM contact_interactions ci WHERE ci.contact_id = p.contact_id AND ci.interaction_type IN ('email_sent','email_received')) as last_email_at,
                    (SELECT COUNT(*) FROM contact_interactions ci WHERE ci.contact_id = p.contact_id AND ci.interaction_type IN ('email_sent','email_received')) as email_count
                FROM projects p
                LEFT JOIN contacts c ON c.contact_id = p.contact_id
                LEFT JOIN users u ON u.user_id = p.assigned_to
                {where}
                ORDER BY
                    CASE p.status
                        WHEN 'active' THEN 0
                        WHEN 'at_risk' THEN 1
                        WHEN 'off_track' THEN 2
                        WHEN 'on_hold' THEN 3
                        WHEN 'won' THEN 4
                        WHEN 'inactive' THEN 5
                        ELSE 6
                    END,
                    p.date_deadline ASC NULLS LAST,
                    p.name ASC
            """, params)
            rows = cur.fetchall()
            return [dict(r) for r in rows]
    finally:
        conn.close()


# ── Status Settings (before /{project_id} to avoid route conflict) ────────────

DEFAULT_STATUS_CRITERIA = {
    "in_progress": "Active work is underway. Recent outbound emails or meetings have occurred, tasks are being completed, and the client is engaged.",
    "waiting_client": "Founder ERP has sent the most recent communication and is waiting for a client reply. No response received in the last 3-7 days.",
    "waiting_sbc": "The client sent the most recent email or is expecting a response or deliverable from Founder ERP. Open Founder ERP-assigned tasks exist.",
    "awaiting_vendor": "Progress is blocked on a third-party vendor, lab result, or external dependency. Not waiting on the client directly.",
}


@router.get("/status-settings")
def get_status_settings_early():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT criteria FROM project_status_settings ORDER BY id DESC LIMIT 1")
            row = cur.fetchone()
            return {"criteria": row["criteria"] if row else DEFAULT_STATUS_CRITERIA}
    finally:
        conn.close()


@router.put("/status-settings")
def update_status_settings_early(body: dict):
    criteria = body.get("criteria", {})
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM project_status_settings ORDER BY id DESC LIMIT 1")
            row = cur.fetchone()
            if row:
                cur.execute(
                    "UPDATE project_status_settings SET criteria=%s, updated_at=NOW() WHERE id=%s",
                    (psycopg2.extras.Json(criteria), row[0]),
                )
            else:
                cur.execute(
                    "INSERT INTO project_status_settings (criteria) VALUES (%s)",
                    (psycopg2.extras.Json(criteria),),
                )
        conn.commit()
        return {"criteria": criteria}
    finally:
        conn.close()



@router.post("/calculate-all-statuses")
async def calculate_all_statuses(background_tasks: BackgroundTasks):
    """Fire-and-forget: recalculate AI status for every active project."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT project_id FROM projects ORDER BY updated_at DESC")
            ids = [r["project_id"] for r in cur.fetchall()]
    finally:
        conn.close()

    async def run_all():
        import asyncio
        sem = asyncio.Semaphore(5)  # max 5 concurrent Claude calls
        async def one(pid):
            async with sem:
                try:
                    await calculate_status(pid)
                except Exception:
                    pass
        await asyncio.gather(*[one(pid) for pid in ids])

    background_tasks.add_task(run_all)
    return {"queued": len(ids)}


# ── Get one ───────────────────────────────────────────────────────────────────

@router.get("/{project_id}")
def get_project(project_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Project + contact
            cur.execute("""
                SELECT p.*, c.name as contact_name, c.organization as contact_org,
                       c.avatar_url as contact_avatar, c.email as contact_email,
                       c.title as contact_title, c.tags as contact_tags,
                       c.ai_summary as contact_summary,
                       p.ai_summary, p.ai_summary_generated_at,
                       u.user_id as assigned_to_id,
                       COALESCE(u.full_name, u.name) as assigned_to_name
                FROM projects p
                LEFT JOIN contacts c ON c.contact_id = p.contact_id
                LEFT JOIN users u ON u.user_id = p.assigned_to
                WHERE p.project_id = %s
            """, (project_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Project not found")
            result = dict(row)

            # Tasks
            cur.execute("""
                SELECT task_id, name, stage, state, is_done, date_deadline, description
                FROM project_tasks
                WHERE project_id = %s
                ORDER BY
                    CASE state
                        WHEN 'in_progress' THEN 0
                        WHEN 'blocked'     THEN 1
                        WHEN 'done'        THEN 2
                        WHEN 'canceled'    THEN 3
                        ELSE 4
                    END,
                    date_deadline ASC NULLS LAST,
                    name ASC
            """, (project_id,))
            result["tasks"] = [dict(t) for t in cur.fetchall()]

            # All linked contacts (project_contacts junction table)
            cur.execute("""
                SELECT pc.id, pc.contact_id, pc.role, pc.is_primary, pc.created_at,
                       c.name, c.email, c.organization, c.title, c.avatar_url
                FROM project_contacts pc
                JOIN contacts c ON c.contact_id = pc.contact_id
                WHERE pc.project_id = %s
                ORDER BY pc.is_primary DESC, pc.created_at ASC
            """, (project_id,))
            result["project_contacts"] = [dict(r) for r in cur.fetchall()]

            # Email activity from ALL linked contacts, across ALL users
            # Build list of all contact_ids for this project
            all_contact_ids = [r["contact_id"] for r in result.get("project_contacts", []) if r.get("contact_id")]
            if result.get("contact_id") and result["contact_id"] not in [str(c) for c in all_contact_ids]:
                all_contact_ids.append(result["contact_id"])

            if all_contact_ids:
                ids_cast = [str(c) for c in all_contact_ids]
                cur.execute("""
                    SELECT ci.interaction_type, ci.subject, ci.content_preview,
                           ci.occurred_at, ci.direction,
                           c.name as contact_name, c.organization as contact_org
                    FROM contact_interactions ci
                    JOIN contacts c ON c.contact_id = ci.contact_id
                    WHERE ci.contact_id = ANY(%s::uuid[])
                      AND ci.interaction_type IN ('email_sent','email_received','meeting')
                    ORDER BY ci.occurred_at DESC
                    LIMIT 30
                """, (ids_cast,))
                result["email_activity"] = [dict(r) for r in cur.fetchall()]

                # Open contact reminders across all linked contacts
                cur.execute("""
                    SELECT cr.reminder_id, cr.reminder_type, cr.title, cr.description,
                           cr.due_date, cr.auto_generated, cr.created_at,
                           c.name as contact_name
                    FROM contact_reminders cr
                    JOIN contacts c ON c.contact_id = cr.contact_id
                    WHERE cr.contact_id = ANY(%s::uuid[]) AND cr.resolved = FALSE
                    ORDER BY cr.due_date ASC NULLS LAST, cr.created_at DESC
                """, (ids_cast,))
                result["contact_reminders"] = [dict(r) for r in cur.fetchall()]
            else:
                result["email_activity"] = []
                result["contact_reminders"] = []

            # Milestone summary for detail view
            cur.execute("""
                SELECT milestone_id, title, milestone_type, status, due_date, sort_order,
                       document_deliverable,
                       (SELECT COUNT(*) FROM tasks t WHERE t.milestone_id = m.milestone_id AND t.status='open') as open_tasks,
                       (SELECT COUNT(*) FROM tasks t WHERE t.milestone_id = m.milestone_id AND t.status='done') as done_tasks
                FROM project_milestones m
                WHERE m.project_id = %s
                ORDER BY m.sort_order ASC
            """, (project_id,))
            result["milestones"] = [dict(r) for r in cur.fetchall()]

            # Strategic goals linked to project
            cur.execute("""
                SELECT pgl.id, pgl.goal_id, pgl.contribution_notes,
                       g.title, g.category, g.status, g.target_date
                FROM project_goal_links pgl
                JOIN strategic_goals g ON g.goal_id = pgl.goal_id
                WHERE pgl.project_id = %s
                ORDER BY g.category, g.title
            """, (project_id,))
            result["strategic_goals"] = [dict(r) for r in cur.fetchall()]

            # FP&A links
            cur.execute(
                "SELECT * FROM project_fpa_links WHERE project_id = %s ORDER BY created_at",
                (project_id,)
            )
            result["fpa_links"] = [dict(r) for r in cur.fetchall()]

            return result
    finally:
        conn.close()


# ── Tasks sub-resource ────────────────────────────────────────────────────────

@router.get("/{project_id}/tasks")
def list_tasks(project_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT * FROM project_tasks WHERE project_id = %s
                ORDER BY is_done ASC, date_deadline ASC NULLS LAST, name ASC
            """, (project_id,))
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.patch("/{project_id}/tasks/{task_id}")
def update_task(project_id: str, task_id: str, body: dict):
    allowed = {"name", "stage", "state", "is_done", "date_deadline", "description"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values()) + [task_id, project_id]
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE project_tasks SET {set_clause}, updated_at=NOW() WHERE task_id=%s AND project_id=%s",
                values,
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Task not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/{project_id}/tasks", status_code=201)
def create_task(project_id: str, body: dict):
    if not body.get("name"):
        raise HTTPException(status_code=400, detail="name required")
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO project_tasks (project_id, name, stage, state, date_deadline, description)
                VALUES (%s,%s,%s,%s,%s,%s) RETURNING task_id
            """, (project_id, body["name"], body.get("stage"), body.get("state","in_progress"),
                  body.get("date_deadline"), body.get("description")))
            row = cur.fetchone()
            conn.commit()
            return {"task_id": str(row["task_id"])}
    finally:
        conn.close()


@router.delete("/{project_id}/tasks/{task_id}", status_code=204)
def delete_task(project_id: str, task_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM project_tasks WHERE task_id=%s AND project_id=%s", (task_id, project_id))
            conn.commit()
    finally:
        conn.close()


# ── Resolve contact reminder from project context ─────────────────────────────

@router.patch("/{project_id}/reminders/{reminder_id}/resolve")
def resolve_reminder(project_id: str, reminder_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            # Verify reminder belongs to contact linked to this project
            cur.execute("""
                UPDATE contact_reminders cr
                SET resolved = TRUE, resolved_at = NOW()
                FROM projects p
                WHERE cr.reminder_id = %s
                  AND p.project_id = %s
                  AND cr.contact_id = p.contact_id
            """, (reminder_id, project_id))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Reminder not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── Create ────────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_project(body: dict, request: Request):
    if not body.get("name"):
        raise HTTPException(status_code=400, detail="name is required")

    user = get_current_user(request)
    creator_id = user["user_id"] if user else None

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO projects (
                    name, description, project_type, stage, status,
                    contact_id, probability, expected_revenue,
                    date_start, date_deadline, tags, notes, assigned_to,
                    -- crm_type and section were not inserted at all, so a
                    -- project created through the API always landed as a plain
                    -- lead with no section. Those two columns are what separate
                    -- an R&D contract from a portfolio contract from a
                    -- partnership -- without them the row lands in the wrong
                    -- pipeline and the Projects board files it under the wrong
                    -- tab.
                    crm_type, section
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::uuid,%s,%s)
                RETURNING project_id
            """, (
                body["name"],
                body.get("description"),
                # Defaults must be values the rest of the system actually uses.
                # These were "project" and "active", and neither is a real value:
                # types are crm_opportunity / partnership / grant / marketing /
                # portfolio, and statuses are in_progress / waiting_sbc /
                # waiting_client. A project created without them explicitly set
                # landed with a status nothing filters on -- the same mismatch
                # that left the Tasks page's project dropdown empty. The
                # Projects page passes both, which is why this went unnoticed.
                body.get("project_type") or "crm_opportunity",
                body.get("stage"),
                body.get("status") or "in_progress",
                body.get("contact_id"),
                body.get("probability"),
                body.get("expected_revenue"),
                body.get("date_start"),
                body.get("date_deadline"),
                body.get("tags", []),
                body.get("notes"),
                body.get("assigned_to") or creator_id,
                body.get("crm_type") or "lead",
                # section is CHECK-constrained to client/partnership, so an
                # unrecognised value must become NULL rather than fail the write.
                body.get("section") if body.get("section") in ("client", "partnership") else None,
            ))
            row = cur.fetchone()
            conn.commit()
            return {"project_id": str(row["project_id"])}
    finally:
        conn.close()


# ── Update ────────────────────────────────────────────────────────────────────

@router.patch("/{project_id}")
def update_project(project_id: str, body: dict):
    updates = {k: v for k, v in body.items() if k in UPDATABLE}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    # When crm_type changes to "project" (client), auto-assign client section.
    # Do NOT reset section for other crm_types — partnership section must be preserved.
    if "crm_type" in updates and "section" not in updates:
        if updates["crm_type"] == "project":
            updates["section"] = "client"

    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values()) + [project_id]

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE projects SET {set_clause}, updated_at = NOW() WHERE project_id = %s",
                values,
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project not found")
            # Auto-unarchive contact when linking to a project
            if "contact_id" in updates and updates["contact_id"]:
                cur.execute(
                    "UPDATE contacts SET archived = false, updated_at = NOW() WHERE contact_id = %s AND archived = true",
                    (updates["contact_id"],),
                )
            # Sync back to linked funding entry
            # notes is no longer synced to the opportunity: 129 made opportunity
            # notes a dated log, and a blob sync would overwrite the history.
            SYNC_TO_OPP = {"name": "title", "date_deadline": "deadline", "status": "stage"}
            SYNC_TO_INV = {"notes": "notes"}
            opp_fields = {opp_col: updates[proj_col] for proj_col, opp_col in SYNC_TO_OPP.items() if proj_col in updates}
            inv_fields  = {inv_col:  updates[proj_col] for proj_col, inv_col  in SYNC_TO_INV.items()  if proj_col in updates}
            if opp_fields or inv_fields:
                cur.execute(
                    "SELECT linked_opportunity_id, linked_investor_id FROM projects WHERE project_id = %s",
                    (project_id,),
                )
                links = cur.fetchone()
                if links and links[0] and opp_fields:
                    # Stage moves are events on the funding side (129) — a sync
                    # that skips the log would leave silent gaps in the history.
                    if "stage" in opp_fields:
                        cur.execute(
                            "SELECT stage FROM funding_opportunities WHERE opportunity_id = %s",
                            (str(links[0]),))
                        prev = cur.fetchone()
                        if prev and prev[0] != opp_fields["stage"]:
                            cur.execute(
                                "INSERT INTO funding_stage_history "
                                "(opportunity_id, stage_from, stage_to) VALUES (%s, %s, %s)",
                                (str(links[0]), prev[0], opp_fields["stage"]))
                    opp_set = ", ".join(f"{k} = %s" for k in opp_fields)
                    cur.execute(
                        f"UPDATE funding_opportunities SET {opp_set}, updated_at = NOW() WHERE opportunity_id = %s",
                        list(opp_fields.values()) + [str(links[0])],
                    )
                if links and links[1] and inv_fields:
                    inv_set = ", ".join(f"{k} = %s" for k in inv_fields)
                    cur.execute(
                        f"UPDATE dilutive_investors SET {inv_set}, updated_at = NOW() WHERE investor_id = %s",
                        list(inv_fields.values()) + [str(links[1])],
                    )
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── Company Info Generation ───────────────────────────────────────────────────

@router.post("/{project_id}/generate-company-info", status_code=200)
def generate_company_info(project_id: str, request: Request):
    """Use Claude with web_search to generate a company description and find ESG/sustainability links."""
    from app.routers.auth import get_current_user
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT p.name, p.notes, c.organization as contact_org, c.name as contact_name "
                "FROM projects p "
                "LEFT JOIN contacts c ON c.contact_id = p.contact_id "
                "WHERE p.project_id = %s", (project_id,)
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Project not found")

    company = row.get("contact_org") or row.get("contact_name") or row.get("name") or ""
    if not company:
        raise HTTPException(status_code=422, detail="No company name found on project")

    import anthropic, json as _json, os
    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))

    prompt = (
        f"Research the company \"{company}\" and provide two things:\n"
        f"1. A 2-3 sentence company description covering: company size/type, main products or services, and primary sales channels. Be factual and concise.\n"
        f"2. The URL of their sustainability, ESG, or CSR page/report if one exists publicly. Only include a URL if you are confident it is real and accessible.\n\n"
        f"Respond ONLY with valid JSON: {{\"description\": \"...\", \"esg_url\": \"...or null\"}}"
    )

    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            tools=[{"type": "web_search_20250305", "name": "web_search"}],
            messages=[{"role": "user", "content": prompt}],
        )
        # Extract the final text block and strip citation tags
        import re
        result_text = ""
        for block in response.content:
            if hasattr(block, "text"):
                result_text = block.text
        result_text = re.sub(r'<cite[^>]*>|</cite>', '', result_text)
        # Parse JSON from response
        m = re.search(r'\{[^{}]+\}', result_text, re.DOTALL)
        if not m:
            raise ValueError("No JSON found in response")
        data = _json.loads(m.group())
        description = (data.get("description") or "").strip()
        esg_url = data.get("esg_url") or None

        # Persist to DB
        conn2 = get_conn()
        try:
            with conn2.cursor() as cur:
                cur.execute(
                    "UPDATE projects SET company_description=%s, esg_url=%s, updated_at=NOW() WHERE project_id=%s",
                    (description or None, esg_url, project_id)
                )
                conn2.commit()
        finally:
            conn2.close()

        return {"description": description, "esg_url": esg_url}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")


# ── Link / create contact ─────────────────────────────────────────────────────

@router.post("/{project_id}/link-contact")
def link_contact(project_id: str, body: dict):
    """Link an existing contact or create a new one, then attach to this project."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            contact_id = body.get("contact_id")
            if not contact_id:
                # Create a new contact from provided fields
                name = (body.get("name") or "").strip()
                if not name:
                    raise HTTPException(status_code=400, detail="contact_id or name required")
                cur.execute("""
                    INSERT INTO contacts (name, email, phone, organization, title, notes)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING contact_id
                """, (
                    name,
                    body.get("email") or None,
                    body.get("phone") or None,
                    body.get("organization") or None,
                    body.get("title") or None,
                    body.get("notes") or None,
                ))
                row = cur.fetchone()
                contact_id = str(row["contact_id"])

            # Unarchive if needed and link
            cur.execute(
                "UPDATE contacts SET archived = false, updated_at = NOW() WHERE contact_id = %s AND archived = true",
                (contact_id,),
            )
            cur.execute(
                "UPDATE projects SET contact_id = %s, updated_at = NOW() WHERE project_id = %s",
                (contact_id, project_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project not found")
            # Keep project_contacts in sync — upsert as primary
            cur.execute("UPDATE project_contacts SET is_primary = FALSE WHERE project_id = %s", (project_id,))
            cur.execute("""
                INSERT INTO project_contacts (project_id, contact_id, role, is_primary)
                VALUES (%s, %s, 'primary', TRUE)
                ON CONFLICT (project_id, contact_id) DO UPDATE SET is_primary = TRUE, role = 'primary'
            """, (project_id, contact_id))
            conn.commit()
        return {"ok": True, "contact_id": contact_id}
    finally:
        conn.close()


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM projects WHERE project_id = %s", (project_id,))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project not found")
            conn.commit()
    finally:
        conn.close()


# ── Project contacts (junction table) ────────────────────────────────────────

CONTACT_ROLES = ["primary", "technical_liaison", "decision_maker", "billing", "legal", "advisor", "partner", "other"]


@router.get("/{project_id}/contacts")
def list_project_contacts(project_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT pc.id, pc.contact_id, pc.role, pc.is_primary, pc.created_at,
                       c.name, c.email, c.organization, c.title, c.avatar_url
                FROM project_contacts pc
                JOIN contacts c ON c.contact_id = pc.contact_id
                WHERE pc.project_id = %s
                ORDER BY pc.is_primary DESC, pc.created_at ASC
            """, (project_id,))
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/{project_id}/contacts", status_code=201)
def add_project_contact(project_id: str, body: dict):
    contact_id = body.get("contact_id")
    role = body.get("role", "contact")
    is_primary = bool(body.get("is_primary", False))
    if not contact_id:
        raise HTTPException(status_code=400, detail="contact_id required")
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if is_primary:
                cur.execute("UPDATE project_contacts SET is_primary = FALSE WHERE project_id = %s", (project_id,))
                cur.execute("UPDATE projects SET contact_id = %s, updated_at = NOW() WHERE project_id = %s", (contact_id, project_id))
            cur.execute("""
                INSERT INTO project_contacts (project_id, contact_id, role, is_primary)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (project_id, contact_id) DO UPDATE SET role = EXCLUDED.role, is_primary = EXCLUDED.is_primary
                RETURNING *
            """, (project_id, contact_id, role, is_primary))
            row = cur.fetchone()
            conn.commit()
            return dict(row)
    finally:
        conn.close()


@router.patch("/{project_id}/contacts/{contact_id}")
def update_project_contact(project_id: str, contact_id: str, body: dict):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if body.get("is_primary"):
                cur.execute("UPDATE project_contacts SET is_primary = FALSE WHERE project_id = %s", (project_id,))
                cur.execute("UPDATE projects SET contact_id = %s, updated_at = NOW() WHERE project_id = %s", (contact_id, project_id))
            sets = []
            vals = []
            if "role" in body:
                sets.append("role = %s"); vals.append(body["role"])
            if "is_primary" in body:
                sets.append("is_primary = %s"); vals.append(bool(body["is_primary"]))
            if not sets:
                raise HTTPException(status_code=400, detail="Nothing to update")
            vals += [project_id, contact_id]
            cur.execute(f"UPDATE project_contacts SET {', '.join(sets)} WHERE project_id = %s AND contact_id = %s RETURNING *", vals)
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Contact link not found")
            conn.commit()
            return dict(row)
    finally:
        conn.close()


@router.delete("/{project_id}/contacts/{contact_id}", status_code=200)
def remove_project_contact(project_id: str, contact_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM project_contacts WHERE project_id = %s AND contact_id = %s",
                (project_id, contact_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Contact link not found")
            # If this was the primary contact, clear projects.contact_id
            cur.execute(
                "UPDATE projects SET contact_id = NULL, updated_at = NOW() WHERE project_id = %s AND contact_id = %s",
                (project_id, contact_id),
            )
            # Promote oldest remaining contact as primary if any
            cur.execute("""
                UPDATE project_contacts SET is_primary = TRUE
                WHERE id = (
                    SELECT id FROM project_contacts WHERE project_id = %s ORDER BY created_at ASC LIMIT 1
                )
            """, (project_id,))
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── Related projects (same contact) ──────────────────────────────────────────

@router.get("/{project_id}/related")
def get_related(project_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT contact_id FROM projects WHERE project_id = %s", (project_id,))
            row = cur.fetchone()
            if not row or not row["contact_id"]:
                return []
            contact_id = row["contact_id"]
            cur.execute("""
                SELECT project_id, name, project_type, stage, status, crm_type,
                       expected_revenue, date_deadline
                FROM projects
                WHERE contact_id = %s AND project_id != %s
                ORDER BY status ASC, date_deadline ASC NULLS LAST
                LIMIT 10
            """, (contact_id, project_id))
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


# ── AI Summary ────────────────────────────────────────────────────────────────

@router.post("/{project_id}/summary")
async def generate_summary(project_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Core project info
            cur.execute("""
                SELECT p.name, p.project_type, p.stage, p.status, p.crm_type,
                       p.expected_revenue, p.date_start, p.date_deadline, p.notes,
                       c.name as contact_name, c.organization as contact_org,
                       (SELECT COUNT(*) FROM project_tasks pt WHERE pt.project_id = p.project_id AND NOT pt.is_done) as open_tasks,
                       (SELECT COUNT(*) FROM project_tasks pt WHERE pt.project_id = p.project_id AND pt.is_done) as done_tasks
                FROM projects p
                LEFT JOIN contacts c ON c.contact_id = p.contact_id
                WHERE p.project_id = %s
            """, (project_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Project not found")
            p = dict(row)

            # All linked contact IDs
            cur.execute("""
                SELECT DISTINCT contact_id FROM (
                    SELECT contact_id FROM projects WHERE project_id = %s AND contact_id IS NOT NULL
                    UNION
                    SELECT contact_id FROM project_contacts WHERE project_id = %s
                ) sub
            """, (project_id, project_id))
            contact_ids = [r["contact_id"] for r in cur.fetchall()]

            # Recent emails/activities (last 20, most recent first)
            emails = []
            if contact_ids:
                cur.execute("""
                    SELECT ci.interaction_type, ci.subject, ci.content_preview,
                           ci.occurred_at, ci.direction,
                           c.name as contact_name
                    FROM contact_interactions ci
                    JOIN contacts c ON c.contact_id = ci.contact_id
                    WHERE ci.contact_id = ANY(%s)
                    ORDER BY ci.occurred_at DESC
                    LIMIT 20
                """, (contact_ids,))
                emails = [dict(r) for r in cur.fetchall()]

            # Open milestones
            cur.execute("""
                SELECT title, status, due_date
                FROM project_milestones
                WHERE project_id = %s AND status != 'complete'
                ORDER BY due_date ASC NULLS LAST
                LIMIT 5
            """, (project_id,))
            open_milestones = [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()

    # Format recent activity
    activity_lines = []
    for e in emails:
        date = str(e["occurred_at"])[:10]
        direction = "→" if e["direction"] == "outbound" else "←" if e["direction"] == "inbound" else ""
        subject = e.get("subject") or ""
        preview = (e.get("content_preview") or "")[:200]
        activity_lines.append(f"[{date}] {direction} {e['interaction_type']} with {e['contact_name']}: {subject} — {preview}")

    milestone_lines = []
    for m in open_milestones:
        due = f" (due {str(m['due_date'])[:10]})" if m.get("due_date") else ""
        milestone_lines.append(f"- {m['title']} [{m['status']}]{due}")

    contact_line = p.get("contact_name") or ""
    if contact_line and p.get("contact_org"):
        contact_line += f" ({p['contact_org']})"

    prompt = f"""You are a CRM assistant. Based on the recent activity below, write 2-3 sentences describing ONLY the current status of this project right now. Focus on what is happening at this moment: where the conversation stands, what is being waited on, what the next step is, or what was last discussed. Do not describe the project background. Do not give a history. Just the current status. Return only the status text, no labels or headers.

Project: {p['name']}
Stage: {p.get('stage') or 'N/A'} | Status: {p['status']}
Contact: {contact_line or 'N/A'}
Open tasks: {p['open_tasks']} | Completed tasks: {p['done_tasks']}
{f"Open milestones:{chr(10)}{chr(10).join(milestone_lines)}" if milestone_lines else ""}

Recent activity (newest first):
{chr(10).join(activity_lines) if activity_lines else "No recent email or activity on record."}"""

    client = anthropic.AsyncAnthropic()
    msg = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=200,
        messages=[{"role": "user", "content": prompt}],
    )
    summary = msg.content[0].text.strip()

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE projects SET ai_summary=%s, ai_summary_generated_at=NOW(), updated_at=NOW() WHERE project_id=%s",
                (summary, project_id),
            )
            conn.commit()
    finally:
        conn.close()

    return {"summary": summary}


@router.post("/{project_id}/timeline")
async def generate_timeline(project_id: str):
    """Analyze email history and produce an AI narrative timeline of the relationship."""
    import json as _json
    from datetime import datetime as _dt

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT name, project_type, stage FROM projects WHERE project_id=%s", (project_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Project not found")
            project = dict(row)

            cur.execute("""
                SELECT DISTINCT contact_id::text FROM project_contacts WHERE project_id=%s
                UNION
                SELECT contact_id::text FROM projects WHERE project_id=%s AND contact_id IS NOT NULL
            """, (project_id, project_id))
            contact_ids = [r["contact_id"] for r in cur.fetchall()]

            if not contact_ids:
                return {"phases": [], "generated_at": None}

            cur.execute("""
                SELECT ci.interaction_type, ci.subject, ci.content_preview,
                       ci.occurred_at, ci.direction, c.name as contact_name
                FROM contact_interactions ci
                JOIN contacts c ON c.contact_id = ci.contact_id
                WHERE ci.contact_id = ANY(%s::uuid[])
                  AND ci.interaction_type IN ('email_sent','email_received','meeting')
                ORDER BY ci.occurred_at ASC
                LIMIT 60
            """, (contact_ids,))
            emails = [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()

    if not emails:
        return {"phases": [], "generated_at": None}

    def fmt_email(e):
        date = str(e["occurred_at"])[:10]
        direction = "INBOUND" if e.get("direction") == "inbound" else "OUTBOUND"
        lines = [f"[{date}] {direction} — {e.get('contact_name') or 'Unknown'}"]
        if e.get("subject"):
            lines.append(f"Subject: {e['subject']}")
        if e.get("content_preview"):
            lines.append(f"Content: {e['content_preview']}")
        return "\n".join(lines)

    email_block = "\n\n".join(fmt_email(e) for e in emails)

    prompt = f"""You are analyzing the email history for a business project to construct a narrative relationship timeline.

Project: {project['name']} | Type: {project['project_type']} | Stage: {project.get('stage') or 'Unknown'}

Email History (chronological):
{email_block}

Based on the actual content of these conversations, identify 3–6 meaningful phases in how this relationship has progressed. Each phase should describe what was actually discussed, decided, or advanced — not just "emails were exchanged." Focus on the business narrative: what were the key topics, what moved forward, what stalled, what was agreed?

Return a JSON array only, no other text:
[
  {{
    "title": "Short phase title",
    "start_date": "YYYY-MM-DD",
    "end_date": "YYYY-MM-DD",
    "summary": "2-3 sentences describing what actually happened in the relationship during this phase, grounded in the email content."
  }}
]"""

    client = anthropic.AsyncAnthropic()
    msg = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1200,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = msg.content[0].text.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()

    try:
        phases = _json.loads(raw)
    except Exception:
        phases = []

    return {"phases": phases, "generated_at": _dt.utcnow().isoformat()}


@router.patch("/{project_id}/summary")
def update_summary(project_id: str, body: dict):
    summary = (body.get("summary") or "").strip() or None
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE projects SET ai_summary=%s, updated_at=NOW() WHERE project_id=%s",
                (summary, project_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project not found")
            conn.commit()
    finally:
        conn.close()
    return {"ok": True}


# ── Stage sequences ───────────────────────────────────────────────────────────

@router.get("/stage-sequences")
def get_stage_sequences():
    return STAGE_SEQUENCES


# ── FP&A links ────────────────────────────────────────────────────────────────

@router.get("/{project_id}/fpa-links")
def list_fpa_links(project_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM project_fpa_links WHERE project_id=%s ORDER BY created_at",
                (project_id,)
            )
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/{project_id}/fpa-links", status_code=201)
def add_fpa_link(project_id: str, body: dict):
    label = (body.get("contract_label") or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="contract_label required")
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO project_fpa_links (project_id, contract_label, contract_type, link_notes)
                VALUES (%s,%s,%s,%s)
                ON CONFLICT (project_id, contract_label) DO NOTHING
                RETURNING id
            """, (project_id, label, body.get("contract_type"), body.get("link_notes")))
            row = cur.fetchone()
            conn.commit()
            return {"id": str(row["id"]) if row else None}
    finally:
        conn.close()


@router.delete("/{project_id}/fpa-links/{link_id}", status_code=204)
def remove_fpa_link(project_id: str, link_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM project_fpa_links WHERE id=%s AND project_id=%s",
                (link_id, project_id)
            )
            conn.commit()
    finally:
        conn.close()


# ── Funding agent ─────────────────────────────────────────────────────────────

import json as _json


@router.post("/{project_id}/funding-search")
async def funding_search(project_id: str, request: Request):
    """Use Claude to rank funding opportunities by relevance to this project."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT project_id, name, project_type, description, tags FROM projects WHERE project_id=%s",
                (project_id,),
            )
            proj = cur.fetchone()
            if not proj:
                raise HTTPException(status_code=404, detail="Project not found")
            proj = dict(proj)

            cur.execute(
                """SELECT opportunity_id, title, funding_type, amount, stage, tags,
                          (SELECT string_agg(n.body, ' | ' ORDER BY n.created_at DESC)
                             FROM (SELECT body, created_at FROM funding_notes fn
                                   WHERE fn.opportunity_id = funding_opportunities.opportunity_id
                                   ORDER BY created_at DESC LIMIT 3) n) AS notes
                   FROM funding_opportunities
                   WHERE stage NOT IN ('Won','Lost','Rejected')
                   ORDER BY created_at DESC
                   LIMIT 50"""
            )
            opps = [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()

    if not opps:
        return {"results": []}

    # Build compact representation for Claude
    opps_text = "\n".join(
        f"{i+1}. [{o['opportunity_id']}] {o['title']} | type={o.get('funding_type') or 'unknown'} "
        f"amount={o.get('amount') or '?'} stage={o.get('stage')} "
        f"tags={','.join(o.get('tags') or [])} notes={o.get('notes') or ''}"
        for i, o in enumerate(opps)
    )

    prompt = f"""You are evaluating funding opportunities for a project.

Project:
- Name: {proj['name']}
- Type: {proj.get('project_type') or 'unknown'}
- Description: {proj.get('description') or 'No description'}
- Tags: {', '.join(proj.get('tags') or [])}

Funding opportunities (id | title | type | amount | stage | tags | notes):
{opps_text}

For each opportunity, rate its relevance to this project on a scale of 0-10 and give a one-sentence explanation.
Respond ONLY with a JSON array (no markdown), one object per opportunity, in this exact format:
[{{"id":"<uuid>","score":<int>,"reason":"<sentence>"}}]
Include ALL {len(opps)} opportunities. Sort by score descending."""

    client = anthropic.AsyncAnthropic()
    msg = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = msg.content[0].text.strip()

    try:
        scores = _json.loads(raw)
    except Exception:
        # Attempt to extract JSON array if Claude wrapped it
        import re
        m = re.search(r'\[.*\]', raw, re.DOTALL)
        scores = _json.loads(m.group()) if m else []

    score_map = {s["id"]: s for s in scores if isinstance(s, dict) and "id" in s}

    results = []
    for o in opps:
        oid = str(o["opportunity_id"])
        s = score_map.get(oid, {})
        results.append({
            "opportunity_id": oid,
            "title": o["title"],
            "funding_type": o.get("funding_type"),
            "amount": o.get("amount"),
            "stage": o.get("stage"),
            "tags": o.get("tags") or [],
            "relevance_score": s.get("score", 0),
            "relevance_explanation": s.get("reason", ""),
        })

    results.sort(key=lambda x: x["relevance_score"], reverse=True)
    return {"results": results}


# ── AI Status Calculation ──────────────────────────────────────────────────────

@router.post("/{project_id}/calculate-status")
async def calculate_status(project_id: str):
    import json as _json
    from datetime import date

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Project core info
            cur.execute("""
                SELECT p.name, p.project_type, p.stage, p.status, p.notes,
                       p.date_deadline,
                       c.name as contact_name, c.organization as contact_org
                FROM projects p
                LEFT JOIN contacts c ON c.contact_id = p.contact_id
                WHERE p.project_id = %s
            """, (project_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Project not found")
            p = dict(row)

            # All contact IDs linked to project
            cur.execute("""
                SELECT DISTINCT contact_id FROM (
                    SELECT contact_id FROM projects WHERE project_id = %s AND contact_id IS NOT NULL
                    UNION
                    SELECT contact_id FROM project_contacts WHERE project_id = %s
                ) sub
            """, (project_id, project_id))
            contact_ids = [r["contact_id"] for r in cur.fetchall()]

            # Recent emails (last 15)
            emails = []
            if contact_ids:
                cur.execute("""
                    SELECT ci.interaction_type, ci.subject, ci.content_preview,
                           ci.occurred_at, ci.direction, c.name as contact_name
                    FROM contact_interactions ci
                    JOIN contacts c ON c.contact_id = ci.contact_id
                    WHERE ci.contact_id = ANY(%s)
                      AND ci.interaction_type IN ('email_sent','email_received','meeting')
                    ORDER BY ci.occurred_at DESC
                    LIMIT 15
                """, (contact_ids,))
                emails = [dict(r) for r in cur.fetchall()]

            # Open tasks with due dates
            cur.execute("""
                SELECT t.title, t.due_date, t.status, t.kanban_status,
                       u.name as assigned_to_name
                FROM tasks t
                LEFT JOIN users u ON u.user_id = t.assigned_to
                WHERE t.project_id = %s AND t.status = 'open'
                ORDER BY t.due_date ASC NULLS LAST
                LIMIT 20
            """, (project_id,))
            open_tasks = [dict(r) for r in cur.fetchall()]

            # Status criteria
            cur.execute("SELECT criteria FROM project_status_settings ORDER BY id DESC LIMIT 1")
            settings_row = cur.fetchone()
            criteria = settings_row["criteria"] if settings_row else DEFAULT_STATUS_CRITERIA
    finally:
        conn.close()

    today = date.today()

    # Format emails
    email_lines = []
    for e in emails:
        d = str(e["occurred_at"])[:10]
        direction = "→ (outbound)" if e["direction"] == "outbound" else "← (inbound)" if e["direction"] == "inbound" else ""
        subj = e.get("subject") or ""
        preview = (e.get("content_preview") or "")[:150]
        email_lines.append(f"[{d}] {direction} {e['interaction_type']} with {e['contact_name']}: {subj} — {preview}")

    # Format tasks
    task_lines = []
    overdue_count = 0
    for t in open_tasks:
        due = ""
        overdue = ""
        if t.get("due_date"):
            dd = t["due_date"] if isinstance(t["due_date"], date) else date.fromisoformat(str(t["due_date"])[:10])
            days = (dd - today).days
            if days < 0:
                overdue_count += 1
                overdue = f" ⚠ OVERDUE by {abs(days)}d"
            else:
                due = f" (due in {days}d)"
        assigned = f" [assigned: {t['assigned_to_name']}]" if t.get("assigned_to_name") else ""
        task_lines.append(f"- {t['title']}{due}{overdue}{assigned}")

    criteria_block = "\n".join(
        f'  "{k}": {v}' for k, v in criteria.items()
    )

    prompt = f"""You are a project status classifier.

Analyze the project activity below and classify the current status into exactly one of these four values:
- in_progress
- waiting_client
- waiting_sbc
- awaiting_vendor

Status criteria defined by the user:
{criteria_block}

Project: {p['name']}
Contact: {(p.get('contact_name') or '') + (' (' + p['contact_org'] + ')' if p.get('contact_org') else '')}
Stage: {p.get('stage') or 'N/A'}
Overdue tasks: {overdue_count}

Open tasks ({len(open_tasks)} total):
{chr(10).join(task_lines) if task_lines else "No open tasks."}

Recent communications (newest first):
{chr(10).join(email_lines) if email_lines else "No recent email activity."}

Respond with a JSON object with exactly two keys:
- "status": one of "in_progress", "waiting_client", "waiting_sbc", "awaiting_vendor"
- "reason": one sentence explaining why (max 20 words)

Example: {{"status": "waiting_client", "reason": "Last outbound email sent 5 days ago with no reply from client."}}

JSON only, no other text."""

    client = anthropic.AsyncAnthropic()
    msg = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=100,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = msg.content[0].text.strip()

    try:
        result = _json.loads(raw)
        status = result.get("status", "in_progress")
        reason = result.get("reason", "")
    except Exception:
        import re
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        if m:
            result = _json.loads(m.group())
            status = result.get("status", "in_progress")
            reason = result.get("reason", "")
        else:
            status = "in_progress"
            reason = "Could not parse AI response."

    valid = {"in_progress", "waiting_client", "waiting_sbc", "awaiting_vendor"}
    if status not in valid:
        status = "in_progress"

    # Persist the new status
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE projects SET status=%s, updated_at=NOW() WHERE project_id=%s",
                (status, project_id),
            )
        conn.commit()
    finally:
        conn.close()

    return {"status": status, "reason": reason}


