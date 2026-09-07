"""
crm.py — CRM pipeline endpoints.

GET    /crm/deals               — list all deals grouped by stage
GET    /crm/deals/{id}          — single deal
POST   /crm/deals               — create deal
PATCH  /crm/deals/{id}          — update deal (incl. stage move)
DELETE /crm/deals/{id}          — archive deal (or permanently delete if already archived)

GET    /crm/icp                 — get ICP profile
PUT    /crm/icp                 — save ICP profile

GET    /crm/leads               — list sales leads
POST   /crm/leads               — create lead
PATCH  /crm/leads/{id}          — update lead
DELETE /crm/leads/{id}          — archive lead
"""

import csv
import io
import json
import logging
import os
import threading
import uuid
from datetime import date, datetime, timezone, timedelta
from typing import List, Optional

import httpx
import psycopg2
import psycopg2.extras
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/crm", tags=["crm"])

STAGES = [
    "Lead",
    "Prospect",
    "Qualification",
    "Initial Assessment",
    "Contract Sent",
    "Closed Won",
    "Closed Lost",
]

LEAD_SOURCE_OTHER = "Other (Specify in Deal Description)"


# Lead source is mandatory from "Prospect" onward (every stage after "Lead").
def _stage_requires_lead_source(stage: str) -> bool:
    if stage not in STAGES:
        return False
    return STAGES.index(stage) >= STAGES.index("Prospect")



def _conn():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def _require_user(request: Request) -> str:
    uid = request.headers.get("X-User-Id")
    if not uid:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return uid


# ── CRM Systems ───────────────────────────────────────────────────────────────

def ensure_crm_systems():
    """Idempotent startup: create systems table, add system_id columns, seed Bakery."""
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS crm_systems (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name        TEXT NOT NULL,
                spreadsheet_id TEXT,
                description TEXT,
                created_at  TIMESTAMPTZ DEFAULT now(),
                updated_at  TIMESTAMPTZ DEFAULT now()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS system_projects (
                system_id  UUID NOT NULL REFERENCES crm_systems(id) ON DELETE CASCADE,
                project_id UUID NOT NULL,
                linked_at  TIMESTAMPTZ DEFAULT now(),
                PRIMARY KEY (system_id, project_id)
            )
        """)
        cur.execute("ALTER TABLE sales_leads    ADD COLUMN IF NOT EXISTS system_id UUID REFERENCES crm_systems(id)")
        cur.execute("ALTER TABLE icp_profile    ADD COLUMN IF NOT EXISTS system_id UUID")
        cur.execute("ALTER TABLE scoring_config ADD COLUMN IF NOT EXISTS system_id UUID")
        # Add id sequences so new per-system rows can be inserted
        cur.execute("CREATE SEQUENCE IF NOT EXISTS icp_profile_id_seq    START WITH 2")
        cur.execute("CREATE SEQUENCE IF NOT EXISTS scoring_config_id_seq START WITH 2")
        cur.execute("ALTER TABLE icp_profile    ALTER COLUMN id SET DEFAULT nextval('icp_profile_id_seq')")
        cur.execute("ALTER TABLE scoring_config ALTER COLUMN id SET DEFAULT nextval('scoring_config_id_seq')")
        conn.commit()

        # Seed default "Bakery" system if none exists
        cur.execute("SELECT id FROM crm_systems LIMIT 1")
        if not cur.fetchone():
            cur.execute(
                "INSERT INTO crm_systems (name, spreadsheet_id) VALUES (%s,%s) RETURNING id",
                ["Bakery", DEFAULT_SPREADSHEET_ID],
            )
            system_id = str(cur.fetchone()["id"])
            cur.execute("UPDATE sales_leads    SET system_id=%s::uuid WHERE system_id IS NULL", [system_id])
            cur.execute("UPDATE icp_profile    SET system_id=%s::uuid WHERE system_id IS NULL", [system_id])
            cur.execute("UPDATE scoring_config SET system_id=%s::uuid WHERE system_id IS NULL", [system_id])
            conn.commit()
    except Exception as e:
        logger.error("ensure_crm_systems error: %s", e)
        try: conn.rollback()
        except Exception: pass
    finally:
        conn.close()


def _system_row(row) -> dict:
    d = dict(row)
    d["id"] = str(d["id"])
    for k, v in d.items():
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


class SystemCreate(BaseModel):
    name: str
    spreadsheet_id: Optional[str] = None
    description: Optional[str] = None


class SystemUpdate(BaseModel):
    name: Optional[str] = None
    spreadsheet_id: Optional[str] = None
    description: Optional[str] = None


@router.get("/systems")
def list_systems(request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT s.*, COUNT(l.id) AS lead_count
            FROM crm_systems s
            LEFT JOIN sales_leads l ON l.system_id = s.id AND l.archived = false
            GROUP BY s.id
            ORDER BY s.created_at
        """)
        rows = cur.fetchall()
        result = []
        for r in rows:
            d = _system_row(r)
            d["lead_count"] = int(r["lead_count"])
            result.append(d)
        return result
    finally:
        conn.close()


@router.post("/systems")
def create_system(body: SystemCreate, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO crm_systems (name, spreadsheet_id, description) VALUES (%s,%s,%s) RETURNING *",
            [body.name, body.spreadsheet_id, body.description,],
        )
        row = cur.fetchone()
        system_id = str(row["id"])
        # Seed empty ICP and scoring config for the new system
        cur.execute(
            "INSERT INTO icp_profile (system_id) VALUES (%s::uuid)",
            [system_id],
        )
        cur.execute(
            "INSERT INTO scoring_config (system_id, weights, industry_keywords) VALUES (%s::uuid,%s::jsonb,%s::jsonb)",
            [system_id, json.dumps(DEFAULT_WEIGHTS), json.dumps(DEFAULT_KEYWORDS)],
        )
        conn.commit()
    finally:
        conn.close()
    return _system_row(row)


@router.patch("/systems/{sid}")
def update_system(sid: str, body: SystemUpdate, request: Request):
    _require_user(request)
    fields, vals = [], []
    if body.name is not None:           fields.append("name=%s");                         vals.append(body.name)
    if body.spreadsheet_id is not None: fields.append("spreadsheet_id=%s");              vals.append(body.spreadsheet_id)
    if body.description is not None:    fields.append("description=%s");                 vals.append(body.description)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    fields.append("updated_at=now()")
    vals.append(sid)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(f"UPDATE crm_systems SET {', '.join(fields)} WHERE id=%s::uuid RETURNING *", vals)
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404)
    return _system_row(row)


@router.delete("/systems/{sid}")
def delete_system(sid: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM crm_systems")
        if cur.fetchone()[0] <= 1:
            raise HTTPException(status_code=400, detail="Cannot delete the last system")
        cur.execute("DELETE FROM crm_systems WHERE id=%s::uuid", [sid])
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.get("/systems/{sid}")
def get_system(sid: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT s.*, COUNT(l.id) AS lead_count
            FROM crm_systems s
            LEFT JOIN sales_leads l ON l.system_id = s.id AND l.archived = false
            WHERE s.id = %s::uuid
            GROUP BY s.id
        """, [sid])
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        d = _system_row(row)
        d["lead_count"] = int(row["lead_count"])
        # Lead priority breakdown
        cur.execute("""
            SELECT priority, COUNT(*) AS cnt
            FROM sales_leads
            WHERE system_id = %s::uuid AND archived = false AND priority IS NOT NULL
            GROUP BY priority
        """, [sid])
        d["lead_priority_counts"] = {r["priority"]: int(r["cnt"]) for r in cur.fetchall()}
        return d
    finally:
        conn.close()


@router.get("/systems/{sid}/projects")
def list_system_projects(sid: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT p.project_id, p.name, p.project_type, p.stage, p.status,
                   p.expected_revenue, p.date_deadline, p.tags, p.crm_type,
                   sp.linked_at
            FROM system_projects sp
            JOIN projects p ON p.project_id = sp.project_id
            WHERE sp.system_id = %s::uuid
            ORDER BY sp.linked_at DESC
        """, [sid])
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            for k, v in d.items():
                if hasattr(v, "isoformat"):
                    d[k] = v.isoformat()
            d["project_id"] = str(d["project_id"])
            rows.append(d)
        return rows
    finally:
        conn.close()


@router.post("/systems/{sid}/projects", status_code=201)
def link_system_project(sid: str, request: Request, body: dict):
    _require_user(request)
    pid = body.get("project_id")
    if not pid:
        raise HTTPException(status_code=400, detail="project_id required")
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO system_projects (system_id, project_id) VALUES (%s::uuid, %s::uuid) ON CONFLICT DO NOTHING",
            [sid, pid],
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.delete("/systems/{sid}/projects/{pid}", status_code=204)
def unlink_system_project(sid: str, pid: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM system_projects WHERE system_id=%s::uuid AND project_id=%s::uuid",
            [sid, pid],
        )
        conn.commit()
    finally:
        conn.close()


# ── Deal model constants ──────────────────────────────────────────────────────

USER_SETTABLE_STATUSES = ["new", "awaiting_internal", "awaiting_client"]
SYSTEM_STATUSES = ["won", "nurture", "lost"]

# Re-approach clock, in days, keyed by Closed Lost Category.
# None => not worth re-approaching (status becomes "lost" instead of "nurture").
REAPPROACH_CLOCK = {
    "Funding": 90,
    "Timing": 90,
    "Pricing": 90,
    "Other": 90,
    "Expired": 120,
    "No decision": 180,
    "Competitor": 365,
    "Unqualified": None,
    "Technical / methodology fit": None,
}

COMPOSITION_COLS = [
    "comp_protein", "comp_lipid", "comp_starch", "comp_cellulose",
    "comp_hemicellulose", "comp_lignin", "comp_ash",
]

# Expected Close Date is seeded on first entry into a dated stage: today + offset.
# It stays blank (and unasked for) at Lead / Prospect.
STAGE_CLOSE_OFFSETS = {
    "Qualification": 90,
    "Initial Assessment": 60,
    "Contract Sent": 21,
}


def _to_date(v):
    if v is None:
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except Exception:
        return None


def _past_red_trigger(deal, today):
    """Stage-specific 'red' threshold for the urgency flag."""
    stage = deal.get("stage")
    if stage in ("Qualification", "Initial Assessment", "Contract Sent"):
        ecd = _to_date(deal.get("expected_close_date"))
        return ecd is not None and today > ecd
    if stage == "Lead":
        sd = _to_date(deal.get("start_date"))
        return sd is not None and (today - sd).days > 21
    if stage == "Prospect":
        d0 = _to_date(deal.get("date_entered_current_stage"))
        return d0 is not None and (today - d0).days > 30
    return False


def _urgency_flag(deal, min_open_due, today=None):
    """Read-only colour signal derived from Status + dates (recomputed on read).
    Returns purple/green/yellow/red for open deals, or the status itself for
    won/nurture/lost (their colour is unchanged), or None when status is unset."""
    if today is None:
        today = date.today()
    status = deal.get("status")
    if status in ("won", "nurture", "lost"):
        return status
    if status == "new":
        sd = _to_date(deal.get("start_date")) or today
        return "purple" if (today - sd).days <= 7 else "red"
    if status == "awaiting_internal":
        if _past_red_trigger(deal, today):
            return "red"
        due = _to_date(min_open_due)
        return "yellow" if (due is not None and due < today) else "green"
    if status == "awaiting_client":
        if _past_red_trigger(deal, today):
            return "red"
        sc = _to_date(deal.get("status_changed_at")) or today
        return "yellow" if (today - sc).days >= 8 else "green"
    return None


def _stage_index(stage):
    try:
        return STAGES.index(stage)
    except ValueError:
        return -1


# ── Stage-entry validation ────────────────────────────────────────────────────

def _load_deal_context(cur, deal_id):
    """Everything the stage gate needs, in one place."""
    cur.execute("SELECT * FROM crm_deals WHERE deal_id=%s", [deal_id])
    deal = cur.fetchone()
    if not deal:
        raise HTTPException(status_code=404, detail="Deal not found")
    deal = dict(deal)

    cur.execute(
        """
        SELECT c.contact_id, c.name, c.role_in_decision, c.contact_function
        FROM crm_deal_contacts dc
        JOIN contacts c ON c.contact_id = dc.contact_id
        WHERE dc.deal_id = %s AND dc.is_primary
        LIMIT 1
        """,
        [deal_id],
    )
    primary = cur.fetchone()

    cur.execute("SELECT * FROM crm_sidestreams WHERE deal_id=%s", [deal_id])
    side = cur.fetchone()

    cur.execute("SELECT * FROM crm_plan_items WHERE deal_id=%s", [deal_id])
    items = [dict(r) for r in cur.fetchall()]

    return deal, (dict(primary) if primary else None), (dict(side) if side else None), items


def _blank(v):
    if v is None:
        return True
    if isinstance(v, str):
        return v.strip() == ""
    if isinstance(v, (list, tuple)):
        return len(v) == 0
    return False


def validate_stage_entry(cur, deal_id, target_stage):
    """Return a list of missing field labels blocking entry into target_stage.

    Requirements are CUMULATIVE: entering a stage enforces every requirement of
    the stages before it, so a deal cannot skip a gate. Closed Lost is an exit
    rather than a progression — a deal can be lost from any stage — so it only
    enforces the always-on fields plus its own category/reason.
    """
    deal, primary, side, items = _load_deal_context(cur, deal_id)
    target_idx = _stage_index(target_stage)
    missing = []

    def need(cond, label):
        if cond:
            missing.append(label)

    # ── Required, always (on every open deal) ────────────────────────────────
    need(_blank(deal.get("company_id")), "Company")
    need(_blank(deal.get("title")), "Name")
    need(_blank(deal.get("status")), "Status")
    need(_blank(deal.get("start_date")), "Start Date")

    if target_stage == "Closed Lost":
        cat = deal.get("closed_lost_category")
        need(_blank(cat), "Closed Lost Category")
        if cat == "Other":
            need(_blank(deal.get("closed_lost_reason")), "Closed Lost Reason")
        return missing

    # Any open task satisfies the requirement — a Plan item OR an Activity task
    # (the shared tasks table, e.g. a follow-up / review task), matching the
    # Plan & Activity section where both live together.
    open_next_steps = [i for i in items if i["status"] == "open"]
    has_open_task = bool(open_next_steps)
    if not has_open_task:
        cur.execute(
            "SELECT 1 FROM tasks WHERE source_ref = %s AND status = 'open' LIMIT 1",
            [str(deal_id)],
        )
        has_open_task = cur.fetchone() is not None

    # ── Prospect and beyond ─────────────────────────────────────────────────
    if target_idx >= _stage_index("Prospect"):
        need(primary is None, "Contact (Primary)")
        need(_blank(deal.get("deal_lead_id")), "Deal Lead")
        need(_blank(deal.get("deal_source")), "Deal Source")
        if deal.get("deal_source") == LEAD_SOURCE_OTHER:
            need(_blank(deal.get("description")),
                 'Deal Description (required when Deal Source is "Other")')
        # Every open deal carries at least one open Next Step.
        if target_idx < _stage_index("Closed Won"):
            need(not has_open_task, "An open task (Plan & Activity)")

    # ── Qualification and beyond ────────────────────────────────────────────
    if target_idx >= _stage_index("Qualification"):
        need(_blank(deal.get("expected_close_date")), "Expected Close Date")
        need(_blank(deal.get("site_country_region")), "Site Country / Region")
        if primary is not None:
            need(_blank(primary.get("role_in_decision")),
                 "Role in Decision (primary contact)")
            need(_blank(primary.get("contact_function")),
                 "Function (primary contact)")
        need(side is None or _blank(side.get("substrate_type")),
             "Substrate / Type (Sidestream)")

    # ── Initial Assessment and beyond ───────────────────────────────────────
    if target_idx >= _stage_index("Initial Assessment"):
        nda = [i for i in items if i["item_type"] == "nda" and i.get("nda_signed_date")]
        need(not nda, "A signed NDA (Plan)")

        if side is None:
            missing.extend([
                "Volume + Unit (Sidestream)", "Composition (Sidestream)",
                "Moisture / Basis (Sidestream)",
                "Sample or Data Received (Sidestream)", "Location (Sidestream)",
                "Desired Output (Sidestream)",
            ])
        else:
            need(_blank(side.get("volume")) or _blank(side.get("volume_unit")),
                 "Volume + Unit (Sidestream)")
            has_comp = any(side.get(c) is not None for c in COMPOSITION_COLS)
            need(not has_comp, "Composition (Sidestream)")
            need(_blank(side.get("moisture_basis")), "Moisture / Basis (Sidestream)")
            need(_blank(side.get("sample_or_data_received")),
                 "Sample or Data Received (Sidestream)")
            need(_blank(side.get("location")), "Location (Sidestream)")
            need(_blank(side.get("desired_output")), "Desired Output (Sidestream)")

    # ── Contract Sent and beyond ────────────────────────────────────────────
    if target_idx >= _stage_index("Contract Sent"):
        need(_blank(deal.get("projected_revenue")), "Projected Revenue")
        fs = [i for i in items if i["item_type"] == "feasibility_study"]
        need(not fs, "A Feasibility Study (Plan)")

    # ── Closed Won ──────────────────────────────────────────────────────────
    if target_stage == "Closed Won":
        need(_blank(deal.get("success_criteria")), "Success Criteria")

    # ── Conditional rules that apply at any stage once data exists ──────────
    if side is not None:
        has_comp = any(side.get(c) is not None for c in COMPOSITION_COLS)
        if has_comp and _blank(side.get("composition_data_source")):
            missing.append("Composition Data Source (Sidestream)")

    # de-duplicate, preserve order
    seen, out = set(), []
    for m in missing:
        if m not in seen:
            seen.add(m)
            out.append(m)
    return out


def _set_expected_close_for_stage(cur, deal_id, target_stage):
    """Entry into Qualification / Initial Assessment / Contract Sent sets the
    Expected Close Date to today + the stage offset, OVERWRITING whatever was
    there (including a hand-set date): the standard wins on a stage change.
    Between stage changes the field is freely editable and a manual edit holds
    until the next change. Lead / Prospect have no offset, so the field is left
    untouched (empty) there."""
    offset = STAGE_CLOSE_OFFSETS.get(target_stage)
    if offset is None:
        return
    cur.execute(
        "UPDATE crm_deals SET expected_close_date = CURRENT_DATE + %s::int,"
        " updated_at=now() WHERE deal_id=%s",
        [offset, deal_id],
    )


def _record_stage_change(cur, deal_id, stage_from, stage_to, changed_by):
    """Append the transition to the read-only history and reset the current-stage
    clock. Never updates or deletes prior rows."""
    cur.execute(
        "INSERT INTO crm_stage_history (deal_id, stage_from, stage_to, changed_by)"
        " VALUES (%s,%s,%s,%s)",
        [deal_id, stage_from, stage_to, changed_by],
    )
    cur.execute(
        "UPDATE crm_deals SET date_entered_current_stage = CURRENT_DATE,"
        " updated_at=now() WHERE deal_id=%s",
        [deal_id],
    )


def _apply_closed_lost_effects(cur, deal_id):
    """Derive Status and Re-approach Date from the deal's Closed Lost category clock.
    Re-run whenever the category changes so both stay in step with it. The loss
    anchor (end_date) is preserved; the re-approach date is measured from it."""
    cur.execute("SELECT closed_lost_category FROM crm_deals WHERE deal_id=%s", [deal_id])
    cat = (cur.fetchone() or {}).get("closed_lost_category")
    days = REAPPROACH_CLOCK.get(cat, 90)
    if days is None:
        cur.execute(
            "UPDATE crm_deals SET end_date=COALESCE(end_date, CURRENT_DATE),"
            " status='lost', reapproach_date=NULL, status_changed_at=now(), updated_at=now() WHERE deal_id=%s",
            [deal_id],
        )
    else:
        cur.execute(
            "UPDATE crm_deals SET end_date=COALESCE(end_date, CURRENT_DATE),"
            " status='nurture',"
            " reapproach_date=COALESCE(end_date, CURRENT_DATE) + %s::int,"
            " status_changed_at=now(), updated_at=now() WHERE deal_id=%s",
            [days, deal_id],
        )


def _apply_stage_side_effects(cur, deal_id, new_stage):
    """End Date, Status and Re-approach Date are driven by the stage, not by hand."""
    if new_stage == "Closed Won":
        cur.execute(
            "UPDATE crm_deals SET end_date=COALESCE(end_date, CURRENT_DATE), status='won',"
            " reapproach_date=NULL, status_changed_at=now(), updated_at=now() WHERE deal_id=%s",
            [deal_id],
        )
    elif new_stage == "Closed Lost":
        _apply_closed_lost_effects(cur, deal_id)
    else:
        # Re-opened: clear the close stamp and hand status back to the user.
        cur.execute(
            "UPDATE crm_deals SET end_date=NULL, reapproach_date=NULL,"
            " status_changed_at=CASE WHEN status IN ('won','nurture','lost') THEN now() ELSE status_changed_at END,"
            " status=CASE WHEN status IN ('won','nurture','lost') THEN 'awaiting_internal' ELSE status END,"
            " updated_at=now() WHERE deal_id=%s",
            [deal_id],
        )


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("/deals")
def list_deals(
    request: Request,
    stage: Optional[str] = None,
    contract_type: Optional[str] = None,
    archived: bool = False,
):
    _require_user(request)
    # Default board shows active deals; archived=true returns the archive instead.
    where, params = ["d.archived=%s"], [archived]
    if stage:
        where.append("d.stage=%s")
        params.append(stage)
    if contract_type:
        where.append("d.contract_type=%s")
        params.append(contract_type)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT d.*,
                   co.name AS company_name,
                   pc.name AS primary_contact_name,
                   u.name  AS deal_lead_name,
                   s.substrate_type,
                   (SELECT count(*) FROM (
                       SELECT 1 FROM crm_plan_items p
                         WHERE p.deal_id=d.deal_id AND p.status='open'
                       UNION ALL
                       SELECT 1 FROM tasks t
                         WHERE t.source_ref = d.deal_id::text AND t.status='open'
                     ) _ot) AS open_next_steps,
                   (SELECT count(*) FROM (
                       SELECT p.due_date AS dd FROM crm_plan_items p
                         WHERE p.deal_id=d.deal_id AND p.status='open'
                       UNION ALL
                       SELECT t.due_date AS dd FROM tasks t
                         WHERE t.source_ref = d.deal_id::text AND t.status='open'
                     ) _od WHERE _od.dd < CURRENT_DATE) AS overdue_next_steps,
                   (SELECT min(dd) FROM (
                       SELECT p.due_date AS dd FROM crm_plan_items p
                         WHERE p.deal_id=d.deal_id AND p.status='open' AND p.due_date IS NOT NULL
                       UNION ALL
                       SELECT t.due_date AS dd FROM tasks t
                         WHERE t.source_ref = d.deal_id::text AND t.status='open' AND t.due_date IS NOT NULL
                     ) _md) AS min_open_due,
                   la.ts   AS last_activity_at,
                   la.kind AS last_activity_kind
            FROM crm_deals d
            LEFT JOIN companies co ON co.company_id = d.company_id
            LEFT JOIN users u      ON u.user_id     = d.deal_lead_id
            LEFT JOIN crm_sidestreams s ON s.deal_id = d.deal_id
            LEFT JOIN LATERAL (
              SELECT c.name FROM crm_deal_contacts dc
              JOIN contacts c ON c.contact_id = dc.contact_id
              WHERE dc.deal_id = d.deal_id AND dc.is_primary LIMIT 1
            ) pc ON true
            LEFT JOIN LATERAL (
              SELECT ts, kind FROM (
                SELECT m.occurred_at AS ts, m.kind AS kind
                  FROM comm_messages m
                  WHERE m.entity_type = 'deal' AND m.entity_id = d.deal_id
                    AND m.occurred_at <= now()
                UNION ALL
                SELECT t.updated_at AS ts, 'task'::text AS kind
                  FROM tasks t
                  WHERE t.source_ref = d.deal_id::text AND t.status = 'done'
              ) _acts ORDER BY ts DESC LIMIT 1
            ) la ON true
            WHERE """ + " AND ".join(where) + """
            ORDER BY d.expected_close_date NULLS LAST, d.created_at
            """,
            params,
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    deals = [_jsonsafe(dict(r)) for r in rows]
    for d in deals:
        d["urgency"] = _urgency_flag(d, d.get("min_open_due"))
    by_stage = {s: [] for s in STAGES}
    for d in deals:
        by_stage.setdefault(d.get("stage") or "Lead", []).append(d)
    return {"deals": deals, "by_stage": by_stage, "stages": STAGES}


# ── Import / Export ──────────────────────────────

_EXPORT_COLUMNS = [
    "company", "title", "contract_type", "stage", "status", "deal_lead",
    "site_country_region", "deal_source", "projected_revenue",
    "start_date", "expected_close_date", "end_date", "date_entered_current_stage",
    "success_criteria", "closed_lost_category", "closed_lost_reason",
    "description", "reapproach_date", "created_at",
]


@router.get("/deals/export")
def export_deals(request: Request,
                 contract_type: Optional[str] = Query(None),
                 archived: bool = Query(False)):
    """Download the current board as a CSV (one row per deal)."""
    _require_user(request)
    where = ["d.archived = %s"]
    params: list = [archived]
    if contract_type:
        where.append("d.contract_type = %s")
        params.append(contract_type)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            f"""
            SELECT co.name AS company, d.title, d.contract_type, d.stage, d.status,
                   u.name AS deal_lead, d.site_country_region, d.deal_source,
                   d.projected_revenue, d.start_date, d.expected_close_date, d.end_date,
                   d.date_entered_current_stage, d.success_criteria,
                   d.closed_lost_category, d.closed_lost_reason, d.description,
                   d.reapproach_date, d.created_at
            FROM crm_deals d
            LEFT JOIN companies co ON co.company_id = d.company_id
            LEFT JOIN users u ON u.user_id = d.deal_lead_id
            WHERE {' AND '.join(where)}
            ORDER BY co.name NULLS LAST, d.title
            """,
            params,
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=_EXPORT_COLUMNS)
    writer.writeheader()
    for row in rows:
        r = dict(row)
        writer.writerow({k: ("" if r.get(k) is None else str(r.get(k))) for k in _EXPORT_COLUMNS})
    output.seek(0)
    label = (contract_type or "deals").replace("/", "-")
    fname = f"crm_{'archived_' if archived else ''}{label}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


def _pick(r: dict, *keys):
    """First non-empty value among the given CSV column aliases."""
    for k in keys:
        v = r.get(k)
        if v is not None and str(v).strip() != "":
            return str(v).strip()
    return None


@router.post("/deals/import")
async def import_deals(request: Request,
                       file: UploadFile = File(...),
                       contract_type: Optional[str] = Query(None)):
    """Create deals from a CSV. Columns are matched by header name (company,
    title, stage, status, deal_lead, deal_source, projected_revenue,
    start_date, expected_close_date, site_country_region, success_criteria,
    description). Company is matched by name (created if new); deal lead is
    matched by name or email. Each row is committed on its own so one bad row
    never sinks the rest."""
    uid = _require_user(request)
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1", errors="replace")

    reader = csv.DictReader(io.StringIO(text))
    created = skipped = 0
    errors: list = []
    default_ctype = contract_type or "rd_contract"

    conn = _conn()
    try:
        cur = conn.cursor()
        for i, raw_row in enumerate(reader, start=2):  # header is line 1
            r = {
                (k or "").strip().lower().replace(" ", "_"): v
                for k, v in raw_row.items()
            }
            title = _pick(r, "title", "deal", "name")
            company_name = _pick(r, "company", "company_name")
            if not title and not company_name:
                skipped += 1
                continue
            if not title:
                title = company_name  # a bare company row becomes a titled deal
            try:
                company_id = None
                if company_name:
                    cur.execute(
                        "SELECT company_id FROM companies WHERE lower(name)=lower(%s) LIMIT 1",
                        [company_name],
                    )
                    crow = cur.fetchone()
                    if crow:
                        company_id = crow["company_id"]
                    else:
                        cur.execute(
                            "INSERT INTO companies (name) VALUES (%s) RETURNING company_id",
                            [company_name],
                        )
                        company_id = cur.fetchone()["company_id"]

                stage = _pick(r, "stage") or "Lead"
                if stage not in STAGES:
                    stage = "Lead"
                ctype = _pick(r, "contract_type") or default_ctype

                lead_id = None
                lead_ref = _pick(r, "deal_lead", "deal_lead_name", "owner",
                                 "deal_lead_email", "deal_owner")
                if lead_ref:
                    cur.execute(
                        "SELECT user_id FROM users WHERE lower(name)=lower(%s) "
                        "OR lower(email)=lower(%s) LIMIT 1",
                        [lead_ref, lead_ref],
                    )
                    urow = cur.fetchone()
                    if urow:
                        lead_id = urow["user_id"]

                proj_raw = _pick(r, "projected_revenue", "expected_revenue", "revenue")
                proj_val = None
                if proj_raw:
                    try:
                        proj_val = float(proj_raw.replace(",", "").replace("$", ""))
                    except ValueError:
                        proj_val = None

                cur.execute(
                    """
                    INSERT INTO crm_deals
                      (title, company_id, stage, contract_type, description, deal_source,
                       site_country_region, deal_lead_id, projected_revenue, success_criteria,
                       start_date, expected_close_date, status, status_changed_at, created_by)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                            COALESCE(%s::date, CURRENT_DATE), %s::date, 'new', now(), %s)
                    RETURNING deal_id
                    """,
                    [title, company_id, stage, ctype, _pick(r, "description"),
                     _pick(r, "deal_source", "source"), _pick(r, "site_country_region", "region"),
                     lead_id, proj_val, _pick(r, "success_criteria"),
                     _pick(r, "start_date"), _pick(r, "expected_close_date", "close_date"), uid],
                )
                did = cur.fetchone()["deal_id"]
                cur.execute(
                    "INSERT INTO crm_stage_history (deal_id, stage_from, stage_to, changed_by)"
                    " VALUES (%s, NULL, %s, %s)",
                    [did, stage, uid],
                )
                cur.execute(
                    "UPDATE crm_deals SET date_entered_current_stage = CURRENT_DATE WHERE deal_id=%s",
                    [did],
                )
                _set_expected_close_for_stage(cur, did, stage)
                conn.commit()
                created += 1
            except Exception as e:  # noqa: BLE001 — one row must not sink the file
                conn.rollback()
                errors.append(f"Row {i}: {type(e).__name__}: {str(e)[:120]}")
    finally:
        conn.close()

    return {"created": created, "skipped": skipped,
            "error_count": len(errors), "errors": errors[:20]}



# ── Single ────────────────────────────────────────────────────────────────────

@router.get("/deals/{deal_id}")
def get_deal(deal_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM crm_deals WHERE deal_id=%s", [deal_id])
        row = cur.fetchone()
        min_open = None
        if row:
            cur.execute(
                "SELECT min(due_date) AS m FROM crm_plan_items"
                " WHERE deal_id=%s AND status='open' AND due_date IS NOT NULL",
                [deal_id],
            )
            min_open = (cur.fetchone() or {}).get("m")
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404)
    deal = _jsonsafe(dict(row))
    deal["urgency"] = _urgency_flag(deal, min_open)
    return deal


# ── Create ────────────────────────────────────────────────────────────────────

class DealCreate(BaseModel):
    title: str
    company_id: Optional[str] = None
    stage: str = "Lead"
    contract_type: str = "rd_contract"
    description: Optional[str] = None
    deal_source: Optional[str] = None
    start_date: Optional[str] = None
    expected_close_date: Optional[str] = None


@router.post("/deals")
def create_deal(body: DealCreate, request: Request):
    uid = _require_user(request)
    if body.stage not in STAGES:
        raise HTTPException(status_code=400, detail=f"Invalid stage: {body.stage}")
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO crm_deals
              (title, company_id, stage, contract_type, description, deal_source,
               start_date, expected_close_date, status, status_changed_at, created_by)
            VALUES (%s,%s,%s,%s,%s,%s,COALESCE(%s::date, CURRENT_DATE),%s::date,'new',now(),%s)
            RETURNING *
            """,
            [body.title, body.company_id, body.stage, body.contract_type,
             body.description, body.deal_source, body.start_date,
             body.expected_close_date, uid],
        )
        row = cur.fetchone()
        did = row["deal_id"]
        # Record creation as a stage entry (captures deals created at a later stage)
        # and start the current-stage clock.
        cur.execute(
            "INSERT INTO crm_stage_history (deal_id, stage_from, stage_to, changed_by)"
            " VALUES (%s, NULL, %s, %s)",
            [did, body.stage, uid],
        )
        cur.execute(
            "UPDATE crm_deals SET date_entered_current_stage = CURRENT_DATE WHERE deal_id=%s",
            [did],
        )
        # Entering a dated stage applies the Expected Close Date standard (overwrites).
        _set_expected_close_for_stage(cur, did, body.stage)
        cur.execute("SELECT * FROM crm_deals WHERE deal_id=%s", [did])
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    return _jsonsafe(dict(row))


# ── Update ────────────────────────────────────────────────────────────────────

class DealUpdate(BaseModel):
    title: Optional[str] = None
    company_id: Optional[str] = None
    stage: Optional[str] = None
    status: Optional[str] = None
    contract_type: Optional[str] = None
    description: Optional[str] = None
    site_country_region: Optional[str] = None
    deal_lead_id: Optional[str] = None
    start_date: Optional[str] = None
    expected_close_date: Optional[str] = None
    deal_source: Optional[str] = None
    projected_revenue: Optional[float] = None
    success_criteria: Optional[str] = None
    closed_lost_category: Optional[str] = None
    closed_lost_reason: Optional[str] = None
    email_text: Optional[str] = None


DEAL_PATCH_FIELDS = [
    "title", "company_id", "contract_type", "description", "site_country_region",
    "deal_lead_id", "start_date", "expected_close_date", "deal_source",
    "projected_revenue", "success_criteria", "closed_lost_category",
    "closed_lost_reason", "email_text",
]

# The two columns the table declares NOT NULL. Every other patchable field may
# be emptied again; these can only be changed to something else.
DEAL_NOT_NULL_FIELDS = {"title", "contract_type"}


@router.patch("/deals/{deal_id}")
def update_deal(deal_id: str, body: DealUpdate, request: Request):
    uid = _require_user(request)

    if body.stage and body.stage not in STAGES:
        raise HTTPException(status_code=400, detail=f"Invalid stage: {body.stage}")
    if body.status and body.status not in USER_SETTABLE_STATUSES and body.status not in ("lost", "nurture"):
        raise HTTPException(
            status_code=400,
            detail="Only New / Awaiting Open ERP / Awaiting Client — or Lost / Nurture on a Closed Lost deal — can be set by hand.",
        )

    conn = _conn()
    try:
        cur = conn.cursor()

        # Write the plain fields first so the gate sees this request's values.
        #
        # exclude_unset is what separates "left out of this request" from "sent
        # as null". The panel patches one field per edit, so an explicit null is
        # always a deliberate clear — a date input emptied, a dropdown put back
        # to "—" — and treating it as "unchanged" meant a field could be filled
        # in but never emptied again.
        provided = body.model_dump(exclude_unset=True)
        fields, values = [], []
        for f in DEAL_PATCH_FIELDS:
            if f not in provided:
                continue
            v = provided[f]
            if v is None and f in DEAL_NOT_NULL_FIELDS:
                conn.rollback()
                raise HTTPException(
                    status_code=400,
                    detail=f"{f.replace('_', ' ').title()} cannot be emptied — set it to something else instead.",
                )
            fields.append(f"{f} = %s")
            values.append(v)
        if body.status is not None:
            # Lost / Nurture may be chosen by hand, but only on a Closed Lost deal.
            if body.status in ("lost", "nurture"):
                cur.execute("SELECT stage FROM crm_deals WHERE deal_id=%s", [deal_id])
                if (cur.fetchone() or {}).get("stage") != "Closed Lost":
                    conn.rollback()
                    raise HTTPException(status_code=400,
                        detail="Lost / Nurture can only be set on a Closed Lost deal.")
            fields.append("status = %s")
            values.append(body.status)
            fields.append("status_changed_at = now()")
            # Keep the re-approach date consistent with the chosen outcome.
            if body.status == "lost":
                fields.append("reapproach_date = NULL")
            elif body.status == "nurture":
                fields.append("reapproach_date = COALESCE(reapproach_date, COALESCE(end_date, CURRENT_DATE) + 90)")
        if fields:
            fields.append("updated_at = now()")
            values.append(deal_id)
            cur.execute(
                f"UPDATE crm_deals SET {', '.join(fields)} WHERE deal_id=%s RETURNING deal_id",
                values,
            )
            if not cur.fetchone():
                conn.rollback()
                raise HTTPException(status_code=404, detail="Deal not found")

        # Changing the Closed Lost category on an already-lost deal re-derives its
        # status and re-approach date from the new category's clock.
        if body.closed_lost_category is not None and not body.stage:
            cur.execute("SELECT stage FROM crm_deals WHERE deal_id=%s", [deal_id])
            if (cur.fetchone() or {}).get("stage") == "Closed Lost":
                _apply_closed_lost_effects(cur, deal_id)

        # Stage change: validate, then apply, record history, run side effects.
        if body.stage:
            cur.execute("SELECT stage FROM crm_deals WHERE deal_id=%s", [deal_id])
            prev_stage = (cur.fetchone() or {}).get("stage")
            changed = body.stage != prev_stage
            if changed:
                # The Expected Close Date standard is applied (overwriting) before the
                # gate runs, so entry into Qualification satisfies the requirement.
                _set_expected_close_for_stage(cur, deal_id, body.stage)
            missing = validate_stage_entry(cur, deal_id, body.stage)
            if missing:
                conn.rollback()
                raise HTTPException(
                    status_code=422,
                    detail={
                        "message": f"Cannot move to {body.stage} — complete these first:",
                        "missing": missing,
                        "target_stage": body.stage,
                    },
                )
            cur.execute(
                "UPDATE crm_deals SET stage=%s, updated_at=now() WHERE deal_id=%s",
                [body.stage, deal_id],
            )
            _apply_stage_side_effects(cur, deal_id, body.stage)
            if changed:
                _record_stage_change(cur, deal_id, prev_stage, body.stage, uid)

        if not fields and not body.stage:
            raise HTTPException(status_code=400, detail="No fields to update")

        conn.commit()
        cur.execute("SELECT * FROM crm_deals WHERE deal_id=%s", [deal_id])
        row = cur.fetchone()
    finally:
        conn.close()
    return _jsonsafe(dict(row))


@router.get("/deals/{deal_id}/stage-check")
def stage_check(deal_id: str, target: str, request: Request):
    """What would block this deal from entering `target`? Drives the UI hints."""
    _require_user(request)
    if target not in STAGES:
        raise HTTPException(status_code=400, detail=f"Invalid stage: {target}")
    conn = _conn()
    try:
        cur = conn.cursor()
        missing = validate_stage_entry(cur, deal_id, target)
    finally:
        conn.close()
    return {"target_stage": target, "missing": missing, "ok": not missing}


# ── Delete (archive) ──────────────────────────────────────────────────────────

@router.delete("/deals/{deal_id}")
def delete_deal(deal_id: str, request: Request):
    """Two-tier delete. An active deal is archived (recoverable). Deleting a deal
    that is ALREADY archived is permanent: the row and its CRM children (plan
    items, contacts, sidestream, stage history, milestones) are removed via ON
    DELETE CASCADE. A linked project is only unlinked (crm_deal_id -> NULL),
    never deleted."""
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT archived FROM crm_deals WHERE deal_id=%s", [deal_id])
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Deal not found")
        if row["archived"]:
            cur.execute("DELETE FROM crm_deals WHERE deal_id=%s", [deal_id])
            # Polymorphic tables the cascade cannot reach.
            for table in ("comm_messages", "comm_addresses", "scheduled_emails"):
                cur.execute(
                    f"DELETE FROM {table} WHERE entity_type='deal' AND entity_id=%s",
                    [deal_id])
            result = {"ok": True, "deleted": "permanent"}
        else:
            cur.execute(
                "UPDATE crm_deals SET archived=true, updated_at=now() WHERE deal_id=%s",
                [deal_id],
            )
            result = {"ok": True, "deleted": "archived"}
        conn.commit()
    finally:
        conn.close()
    return result


# ── Sidestream (exactly one per deal) ─────────────────────────────────────────

class SidestreamUpsert(BaseModel):
    substrate_type: Optional[str] = None
    volume: Optional[float] = None
    volume_unit: Optional[str] = None
    moisture_basis: Optional[str] = None
    comp_protein: Optional[float] = None
    comp_lipid: Optional[float] = None
    comp_starch: Optional[float] = None
    comp_cellulose: Optional[float] = None
    comp_hemicellulose: Optional[float] = None
    comp_lignin: Optional[float] = None
    comp_ash: Optional[float] = None
    composition_data_source: Optional[str] = None
    sample_or_data_received: Optional[str] = None
    location: Optional[str] = None
    desired_output: Optional[List[str]] = None
    current_waste_pnl: Optional[float] = None
    current_waste_pnl_unit: Optional[str] = None
    current_use: Optional[str] = None
    seasonality: Optional[str] = None
    contamination_constraints: Optional[str] = None


SIDESTREAM_FIELDS = [
    "substrate_type", "volume", "volume_unit", "moisture_basis",
    "comp_protein", "comp_lipid", "comp_starch", "comp_cellulose",
    "comp_hemicellulose", "comp_lignin", "comp_ash", "composition_data_source",
    "sample_or_data_received", "location", "desired_output",
    "current_waste_pnl", "current_waste_pnl_unit", "current_use",
    "seasonality", "contamination_constraints",
]


@router.put("/deals/{deal_id}/sidestream")
def upsert_sidestream(deal_id: str, body: SidestreamUpsert, request: Request):
    """A deal carries at most one sidestream; this creates or updates it."""
    _require_user(request)
    payload = {f: getattr(body, f) for f in SIDESTREAM_FIELDS
               if getattr(body, f) is not None}
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT sidestream_id FROM crm_sidestreams WHERE deal_id=%s", [deal_id])
        existing = cur.fetchone()
        if existing:
            if payload:
                sets = ", ".join(f"{k} = %s" for k in payload)
                cur.execute(
                    f"UPDATE crm_sidestreams SET {sets}, updated_at=now() WHERE deal_id=%s RETURNING *",
                    list(payload.values()) + [deal_id],
                )
            else:
                cur.execute("SELECT * FROM crm_sidestreams WHERE deal_id=%s", [deal_id])
        else:
            cols = ["deal_id"] + list(payload)
            cur.execute(
                f"INSERT INTO crm_sidestreams ({', '.join(cols)}) "
                f"VALUES ({', '.join(['%s'] * len(cols))}) RETURNING *",
                [deal_id] + list(payload.values()),
            )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    return _jsonsafe(dict(row))


# ── Plan items (repeating child collection) ───────────────────────────────────

NEXT_STEP_STATUSES = ["open", "done", "cancelled"]
FS_STATUSES = ["Not run", "Requested", "In progress",
               "Halted — no composition data", "GO", "HOLD", "REDIRECT"]


class PlanItemCreate(BaseModel):
    item_type: str
    title: Optional[str] = None
    description: Optional[str] = None
    email_enabled: Optional[bool] = None
    owner_id: Optional[str] = None
    due_date: Optional[str] = None
    status: Optional[str] = None
    body: Optional[str] = None
    email_subject: Optional[str] = None
    nda_signed_date: Optional[str] = None
    fs_target_date: Optional[str] = None
    fs_date_completed: Optional[str] = None
    fs_date_sent_to_client: Optional[str] = None
    fs_analysis_link: Optional[str] = None


PLAN_ITEM_FIELDS = [
    "title", "description", "owner_id", "due_date", "status", "body", "email_subject",
    "email_enabled", "nda_signed_date", "fs_target_date", "fs_date_completed",
    "fs_date_sent_to_client", "fs_analysis_link",
]


def _default_status(item_type):
    return "Not run" if item_type == "feasibility_study" else "open"


def _check_plan_status(item_type, status):
    allowed = FS_STATUSES if item_type == "feasibility_study" else NEXT_STEP_STATUSES
    if status not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status for {item_type}. Allowed: {', '.join(allowed)}",
        )


@router.get("/deals/{deal_id}/plan-items")
def list_plan_items(deal_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT p.*, u.name AS owner_name
            FROM crm_plan_items p
            LEFT JOIN users u ON u.user_id = p.owner_id
            WHERE p.deal_id=%s
            ORDER BY p.resolved_on DESC NULLS FIRST, p.created_at DESC
            """,
            [deal_id],
        )
        rows = cur.fetchall()
    finally:
        conn.close()
    return [_jsonsafe(dict(r)) for r in rows]


@router.post("/deals/{deal_id}/plan-items", status_code=201)
def create_plan_item(deal_id: str, body: PlanItemCreate, request: Request):
    _require_user(request)
    if body.item_type not in ("next_step", "nda", "feasibility_study", "email", "task", "first_touch"):
        raise HTTPException(status_code=400, detail=f"Invalid type: {body.item_type}")
    status = body.status or _default_status(body.item_type)
    _check_plan_status(body.item_type, status)

    payload = {f: getattr(body, f) for f in PLAN_ITEM_FIELDS
               if getattr(body, f) is not None}
    payload["status"] = status
    conn = _conn()
    try:
        cur = conn.cursor()
        # Default the task owner to the deal's owner (fully editable afterward).
        if payload.get("owner_id") is None:
            cur.execute("SELECT deal_lead_id FROM crm_deals WHERE deal_id=%s", [deal_id])
            drow = cur.fetchone()
            lead = dict(drow).get("deal_lead_id") if drow else None
            if lead is not None:
                payload["owner_id"] = lead
        cols = ["deal_id", "item_type"] + list(payload)
        cur.execute(
            f"INSERT INTO crm_plan_items ({', '.join(cols)}) "
            f"VALUES ({', '.join(['%s'] * len(cols))}) RETURNING *",
            [deal_id, body.item_type] + list(payload.values()),
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    return _jsonsafe(dict(row))


class PlanItemUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    owner_id: Optional[str] = None
    due_date: Optional[str] = None
    status: Optional[str] = None
    body: Optional[str] = None
    email_subject: Optional[str] = None
    email_enabled: Optional[bool] = None
    resolved_on: Optional[str] = None
    nda_signed_date: Optional[str] = None
    fs_target_date: Optional[str] = None
    fs_date_completed: Optional[str] = None
    fs_date_sent_to_client: Optional[str] = None
    fs_analysis_link: Optional[str] = None
    custom_fields: Optional[list] = None
    sort_order: Optional[int] = None


@router.patch("/plan-items/{item_id}")
def update_plan_item(item_id: str, body: PlanItemUpdate, request: Request):
    uid = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT item_type, owner_id FROM crm_plan_items WHERE plan_item_id=%s", [item_id])
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Plan item not found")
        existing = dict(row)
        if body.status is not None:
            _check_plan_status(existing["item_type"], body.status)

        fields, values = [], []
        for f in PLAN_ITEM_FIELDS + ["sort_order"]:
            v = getattr(body, f, None)
            if v is not None:
                fields.append(f"{f} = %s")
                values.append(v)
        if body.custom_fields is not None:
            fields.append("custom_fields = %s::jsonb")
            values.append(json.dumps(body.custom_fields))

        # Closing an unassigned task attributes it to whoever closed it.
        if body.status in ("done", "cancelled") and body.owner_id is None \
                and existing.get("owner_id") is None:
            fields.append("owner_id = %s")
            values.append(uid)

        # resolved_on: reopening clears it; an explicit date edit wins; otherwise a
        # move to done/cancelled stamps today. It stays editable afterward.
        if body.status == "open":
            fields.append("resolved_on = NULL")
        elif body.resolved_on is not None:
            fields.append("resolved_on = %s")
            values.append(body.resolved_on)
        elif body.status in ("done", "cancelled"):
            fields.append("resolved_on = CURRENT_DATE")

        if not fields:
            raise HTTPException(status_code=400, detail="No fields to update")
        fields.append("updated_at = now()")
        values.append(item_id)
        cur.execute(
            f"UPDATE crm_plan_items SET {', '.join(fields)} WHERE plan_item_id=%s RETURNING *",
            values,
        )
        out = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    return _jsonsafe(dict(out))


@router.delete("/plan-items/{item_id}", status_code=204)
def delete_plan_item(item_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM crm_plan_items WHERE plan_item_id=%s", [item_id])
        conn.commit()
    finally:
        conn.close()


# ── Buying-group attributes (held per contact) ────────────────────────────────

class BuyingRole(BaseModel):
    role_in_decision: Optional[str] = None
    contact_function: Optional[str] = None


@router.patch("/contacts/{contact_id}/buying-role")
def set_buying_role(contact_id: str, body: BuyingRole, request: Request):
    _require_user(request)
    fields, values = [], []
    for f in ("role_in_decision", "contact_function"):
        v = getattr(body, f)
        if v is not None:
            fields.append(f"{f} = %s")
            values.append(v)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    values.append(contact_id)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            f"UPDATE contacts SET {', '.join(fields)} WHERE contact_id=%s "
            f"RETURNING contact_id, name, role_in_decision, contact_function",
            values,
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Contact not found")
    return _jsonsafe(dict(row))


# ── Primary contact link ──────────────────────────────────────────────────────

class DealContactLink(BaseModel):
    contact_id: str
    role: str = "contact"
    is_primary: bool = False


@router.post("/deals/{deal_id}/contacts", status_code=201)
def link_deal_contact(deal_id: str, body: DealContactLink, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        if body.is_primary:
            cur.execute(
                "UPDATE crm_deal_contacts SET is_primary=false WHERE deal_id=%s", [deal_id]
            )
        cur.execute(
            """
            INSERT INTO crm_deal_contacts (deal_id, contact_id, role, is_primary)
            VALUES (%s,%s,%s,%s)
            ON CONFLICT (deal_id, contact_id)
            DO UPDATE SET role=EXCLUDED.role, is_primary=EXCLUDED.is_primary
            RETURNING *
            """,
            [deal_id, body.contact_id, body.role, body.is_primary],
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    return _jsonsafe(dict(row))


@router.delete("/deals/{deal_id}/contacts/{contact_id}", status_code=204)
def unlink_deal_contact(deal_id: str, contact_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM crm_deal_contacts WHERE deal_id=%s AND contact_id=%s",
            [deal_id, contact_id],
        )
        conn.commit()
    finally:
        conn.close()


def _jsonsafe(d):
    """Normalise DB row values (datetime/date/Decimal/UUID) for JSON output."""
    import uuid as _uuid
    from decimal import Decimal as _Decimal
    out = {}
    for k, v in d.items():
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
        elif isinstance(v, _Decimal):
            out[k] = float(v)
        elif isinstance(v, _uuid.UUID):
            out[k] = str(v)
        else:
            out[k] = v
    return out


# ── Deal detail — everything the detail view renders ──────────────────────────

@router.get("/deals/{deal_id}/detail")
def deal_detail(deal_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()

        cur.execute(
            """
            SELECT d.*, co.name AS company_name, u.name AS deal_lead_name
            FROM crm_deals d
            LEFT JOIN companies co ON co.company_id = d.company_id
            LEFT JOIN users u      ON u.user_id     = d.deal_lead_id
            WHERE d.deal_id=%s
            """,
            [deal_id],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Deal not found")
        deal = _jsonsafe(dict(row))

        cur.execute(
            """
            SELECT c.contact_id, c.name, c.email, c.phone, c.title,
                   c.role_in_decision, c.contact_function,
                   dc.role, dc.is_primary
            FROM crm_deal_contacts dc
            JOIN contacts c ON c.contact_id = dc.contact_id
            WHERE dc.deal_id = %s
            ORDER BY dc.is_primary DESC, c.name
            """,
            [deal_id],
        )
        contacts = [_jsonsafe(dict(r)) for r in cur.fetchall()]

        cur.execute(
            """
            SELECT co.company_id, co.name, co.website_url, co.industry, co.logo_url
            FROM companies co WHERE co.company_id = %s
            """,
            [deal.get("company_id")],
        )
        crow = cur.fetchone()
        company = _jsonsafe(dict(crow)) if crow else None

        cur.execute("SELECT * FROM crm_sidestreams WHERE deal_id=%s", [deal_id])
        srow = cur.fetchone()
        sidestream = _jsonsafe(dict(srow)) if srow else None

        cur.execute(
            """
            SELECT p.*, u.name AS owner_name
            FROM crm_plan_items p
            LEFT JOIN users u ON u.user_id = p.owner_id
            WHERE p.deal_id=%s
            ORDER BY p.resolved_on DESC NULLS FIRST, p.created_at DESC
            """,
            [deal_id],
        )
        plan_items = [_jsonsafe(dict(r)) for r in cur.fetchall()]

        cur.execute(
            """
            SELECT h.stage_history_id, h.changed_at, h.stage_from, h.stage_to,
                   u.name AS changed_by_name
            FROM crm_stage_history h
            LEFT JOIN users u ON u.user_id = h.changed_by
            WHERE h.deal_id=%s
            ORDER BY h.changed_at, h.stage_history_id
            """,
            [deal_id],
        )
        stage_history = [_jsonsafe(dict(r)) for r in cur.fetchall()]

        # Open-task requirement + urgency due date span both the plan and the
        # Activity task list (auto follow-ups included), so count them together.
        cur.execute(
            """
            SELECT count(*) FILTER (WHERE status='open') AS open_cnt,
                   min(due_date) FILTER (WHERE status='open' AND due_date IS NOT NULL) AS min_due
            FROM (
                SELECT status, due_date FROM crm_plan_items WHERE deal_id=%s
                UNION ALL
                SELECT status, due_date FROM tasks WHERE source_ref=%s
            ) _all
            """,
            [deal_id, str(deal_id)],
        )
        _tr = cur.fetchone() or {}
        open_task_count = _tr.get("open_cnt") or 0
        min_open = _tr.get("min_due")
    finally:
        conn.close()

    deal["urgency"] = _urgency_flag(deal, min_open)

    return {
        "deal": deal,
        "company": company,
        "contacts": contacts,
        "sidestream": sidestream,
        "plan_items": plan_items,
        "open_task_count": open_task_count,
        "stage_history": stage_history,
    }


# ── ICP Profile ───────────────────────────────────────────────────────────────

class IcpProfile(BaseModel):
    company_url: Optional[str] = None
    product_description: Optional[str] = None
    price_point: Optional[str] = None
    current_customers: List[str] = []
    competitors: List[str] = []
    target_titles: List[str] = []
    target_seniority: List[str] = []
    company_size_min: Optional[int] = None
    company_size_max: Optional[int] = None
    target_industries: List[str] = []
    target_regions: List[str] = []
    signals: List[str] = []
    exclude_titles: List[str] = []
    exclude_industries: List[str] = []
    exclude_company_types: List[str] = []
    exclude_company_size_min: Optional[int] = None
    exclude_company_size_max: Optional[int] = None
    exclude_companies: List[str] = []


@router.get("/icp")
def get_icp(request: Request, system_id: Optional[str] = None):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        if system_id:
            cur.execute("SELECT * FROM icp_profile WHERE system_id=%s::uuid", [system_id])
        else:
            cur.execute("SELECT * FROM icp_profile WHERE id=1")
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return {}
    d = dict(row)
    d.pop("id", None)
    for k, v in d.items():
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


@router.put("/icp")
def save_icp(body: IcpProfile, request: Request, system_id: Optional[str] = None):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        where = "system_id=%s::uuid" if system_id else "id=1"
        params = [
            body.company_url, body.product_description, body.price_point,
            json.dumps(body.current_customers), json.dumps(body.competitors),
            json.dumps(body.target_titles), json.dumps(body.target_seniority),
            body.company_size_min, body.company_size_max,
            json.dumps(body.target_industries), json.dumps(body.target_regions),
            json.dumps(body.signals),
            json.dumps(body.exclude_titles), json.dumps(body.exclude_industries),
            json.dumps(body.exclude_company_types),
            body.exclude_company_size_min, body.exclude_company_size_max,
            json.dumps(body.exclude_companies),
        ]
        if system_id:
            params.append(system_id)
        cur.execute(f"""
            UPDATE icp_profile SET
                company_url=%s, product_description=%s, price_point=%s,
                current_customers=%s::jsonb, competitors=%s::jsonb,
                target_titles=%s::jsonb, target_seniority=%s::jsonb,
                company_size_min=%s, company_size_max=%s,
                target_industries=%s::jsonb, target_regions=%s::jsonb,
                signals=%s::jsonb,
                exclude_titles=%s::jsonb, exclude_industries=%s::jsonb,
                exclude_company_types=%s::jsonb,
                exclude_company_size_min=%s, exclude_company_size_max=%s,
                exclude_companies=%s::jsonb,
                updated_at=now()
            WHERE {where}
        """, params)
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}

# ── Scoring config ───────────────────────────────────────────────────────────

DEFAULT_WEIGHTS = {
    "company_size": 25, "revenue": 20, "contact_quality": 15,
    "icp_match": 15, "warm_connection": 15, "engagement": 5, "completeness": 5,
}
DEFAULT_KEYWORDS = [
    "food", "bak", "confection", "flour", "grain", "cereal", "pastry",
    "snack", "beverage", "ingredient", "dairy", "agriculture",
]


@router.get("/scoring-config")
def get_scoring_config(request: Request, system_id: Optional[str] = None):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        if system_id:
            cur.execute("SELECT weights, industry_keywords FROM scoring_config WHERE system_id=%s::uuid", [system_id])
        else:
            cur.execute("SELECT weights, industry_keywords FROM scoring_config WHERE id=1")
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return {"weights": DEFAULT_WEIGHTS, "industry_keywords": DEFAULT_KEYWORDS}
    return {"weights": dict(row["weights"]), "industry_keywords": list(row["industry_keywords"])}


class ScoringConfig(BaseModel):
    weights: dict
    industry_keywords: List[str]


@router.put("/scoring-config")
def save_scoring_config(body: ScoringConfig, request: Request, system_id: Optional[str] = None):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        if system_id:
            cur.execute(
                "UPDATE scoring_config SET weights=%s::jsonb, industry_keywords=%s::jsonb, updated_at=now() WHERE system_id=%s::uuid",
                [json.dumps(body.weights), json.dumps(body.industry_keywords), system_id],
            )
        else:
            cur.execute(
                "UPDATE scoring_config SET weights=%s::jsonb, industry_keywords=%s::jsonb, updated_at=now() WHERE id=1",
                [json.dumps(body.weights), json.dumps(body.industry_keywords)],
            )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


# ── Sales Leads ───────────────────────────────────────────────────────────────

LEAD_TEXT_FIELDS = [
    "company", "priority", "reach_out_status", "mutual_connection",
    "recommended_action", "notes", "website", "tier_size", "region",
    "city", "address", "key_products", "est_revenue", "org_fit", "source",
    "industry", "description", "company_linkedin",
]
LEAD_INT_FIELDS = ["employee_count", "founded_year", "priority_score"]


def _lead_dict(row):
    d = dict(row)
    for k, v in d.items():
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    if "id" in d:
        d["id"] = str(d["id"])
    if "contacts" not in d or d["contacts"] is None:
        d["contacts"] = []
    if "technologies" not in d or d["technologies"] is None:
        d["technologies"] = []
    if "score_breakdown" not in d or d["score_breakdown"] is None:
        d["score_breakdown"] = {}
    if "field_sources" not in d or d["field_sources"] is None:
        d["field_sources"] = {}
    return d


class LeadCreate(BaseModel):
    company: str
    system_id: Optional[str] = None
    priority: Optional[str] = None
    reach_out_status: Optional[str] = None
    mutual_connection: Optional[str] = None
    recommended_action: Optional[str] = None
    notes: Optional[str] = None
    website: Optional[str] = None
    tier_size: Optional[str] = None
    region: Optional[str] = None
    city: Optional[str] = None
    address: Optional[str] = None
    key_products: Optional[str] = None
    est_revenue: Optional[str] = None
    org_fit: Optional[str] = None
    source: str = "manual"
    contacts: List[dict] = []
    industry: Optional[str] = None
    description: Optional[str] = None
    company_linkedin: Optional[str] = None
    employee_count: Optional[int] = None
    founded_year: Optional[int] = None
    technologies: List[str] = []


class LeadUpdate(BaseModel):
    company: Optional[str] = None
    priority: Optional[str] = None
    reach_out_status: Optional[str] = None
    mutual_connection: Optional[str] = None
    recommended_action: Optional[str] = None
    notes: Optional[str] = None
    website: Optional[str] = None
    tier_size: Optional[str] = None
    region: Optional[str] = None
    city: Optional[str] = None
    address: Optional[str] = None
    key_products: Optional[str] = None
    est_revenue: Optional[str] = None
    org_fit: Optional[str] = None
    source: Optional[str] = None
    contacts: Optional[List[dict]] = None
    industry: Optional[str] = None
    description: Optional[str] = None
    company_linkedin: Optional[str] = None
    employee_count: Optional[int] = None
    founded_year: Optional[int] = None
    technologies: Optional[List[str]] = None
    field_sources: Optional[dict] = None


@router.get("/leads")
def list_leads(request: Request, priority: Optional[str] = None, source: Optional[str] = None, system_id: Optional[str] = None):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        clauses, vals = ["archived = false"], []
        if priority:
            clauses.append("priority = %s")
            vals.append(priority)
        if source:
            clauses.append("source = %s")
            vals.append(source)
        if system_id:
            clauses.append("system_id = %s::uuid")
            vals.append(system_id)
        cur.execute(
            f"SELECT * FROM sales_leads WHERE {' AND '.join(clauses)} ORDER BY "
            "CASE priority WHEN 'IMMEDIATE' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END, company",
            vals,
        )
        return [_lead_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/leads")
def create_lead(body: LeadCreate, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cols, vals, placeholders = [], [], []
        for f in LEAD_TEXT_FIELDS:
            if getattr(body, f, None) is not None:
                cols.append(f); vals.append(getattr(body, f)); placeholders.append("%s")
        for f in LEAD_INT_FIELDS:
            if getattr(body, f, None) is not None:
                cols.append(f); vals.append(getattr(body, f)); placeholders.append("%s")
        cols.append("contacts"); vals.append(json.dumps(body.contacts)); placeholders.append("%s::jsonb")
        cols.append("technologies"); vals.append(json.dumps(body.technologies)); placeholders.append("%s::jsonb")
        if body.system_id:
            cols.append("system_id"); vals.append(body.system_id); placeholders.append("%s::uuid")
        cur.execute(
            f"INSERT INTO sales_leads ({', '.join(cols)}) VALUES ({', '.join(placeholders)}) RETURNING *",
            vals,
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    _sync_sheets_bg()
    return _lead_dict(row)


@router.get("/leads/acquire/stats")
def acquisition_stats(request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT
                source,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE enrichment_status = 'pending') AS pending,
                COUNT(*) FILTER (WHERE enrichment_status = 'enriched') AS enriched,
                MAX(created_at) AS last_added
            FROM sales_leads
            WHERE archived = false AND source IN ('apollo_search','job_signal','event_scrape')
            GROUP BY source
        """)
        rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            if r.get("last_added") and hasattr(r["last_added"], "isoformat"):
                r["last_added"] = r["last_added"].isoformat()
        cur.execute("""
            SELECT source, status, added, skipped, started_at, finished_at
            FROM acquisition_runs
            WHERE (source, started_at) IN (
                SELECT source, MAX(started_at) FROM acquisition_runs GROUP BY source
            )
        """)
        last_runs = {r["source"]: dict(r) for r in cur.fetchall()}
        for v in last_runs.values():
            for k in ("started_at", "finished_at"):
                if v.get(k) and hasattr(v[k], "isoformat"):
                    v[k] = v[k].isoformat()
        return {"by_source": rows, "last_runs": last_runs}
    finally:
        conn.close()


@router.get("/leads/acquire/run/{run_id}")
def get_acquisition_run(run_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM acquisition_runs WHERE id=%s", [run_id])
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404)
    d = dict(row)
    d["id"] = str(d["id"])
    for k in ("started_at", "finished_at"):
        if d.get(k) and hasattr(d[k], "isoformat"):
            d[k] = d[k].isoformat()
    return d


@router.get("/leads/{lead_id}")
def get_lead(lead_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM sales_leads WHERE id=%s AND archived=false", [lead_id])
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404)
    return _lead_dict(row)


@router.patch("/leads/{lead_id}")
def update_lead(lead_id: str, body: LeadUpdate, request: Request):
    _require_user(request)
    fields, vals = [], []
    for f in LEAD_TEXT_FIELDS:
        v = getattr(body, f, None)
        if v is not None:
            fields.append(f"{f} = %s"); vals.append(v)
    for f in LEAD_INT_FIELDS:
        v = getattr(body, f, None)
        if v is not None:
            fields.append(f"{f} = %s"); vals.append(v)
    if body.contacts is not None:
        fields.append("contacts = %s::jsonb"); vals.append(json.dumps(body.contacts))
    if body.technologies is not None:
        fields.append("technologies = %s::jsonb"); vals.append(json.dumps(body.technologies))
    if body.field_sources is not None:
        fields.append("field_sources = %s::jsonb"); vals.append(json.dumps(body.field_sources))
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    fields.append("updated_at = now()")
    vals.append(lead_id)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            f"UPDATE sales_leads SET {', '.join(fields)} WHERE id=%s AND archived=false RETURNING *",
            vals,
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404)
    _sync_sheets_bg()
    return _lead_dict(row)


@router.delete("/leads/{lead_id}")
def delete_lead(lead_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("UPDATE sales_leads SET archived=true, updated_at=now() WHERE id=%s", [lead_id])
        conn.commit()
    finally:
        conn.close()
    _sync_sheets_bg()
    return {"ok": True}


# ── Lead Enrichment Agent ─────────────────────────────────────────────────────

class EnrichRequest(BaseModel):
    lead_ids: Optional[List[str]] = None  # None = auto-select pending/failed
    max_leads: int = 5


def _create_run(lead_id: str) -> str:
    """Insert a new enrichment_runs row and return its UUID."""
    run_id = str(uuid.uuid4())
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO enrichment_runs (id, lead_id, status) VALUES (%s, %s, 'running')",
            [run_id, lead_id],
        )
        conn.commit()
    finally:
        conn.close()
    return run_id


@router.post("/leads/enrich")
def enrich_leads(body: EnrichRequest, request: Request):
    """Start async lead enrichment. Returns run_ids immediately; agent runs in background."""
    _require_user(request)

    from app.agents.lead_enrichment_agent import _load_leads

    # Resolve which leads will be enriched so we can create run records up front
    leads = _load_leads(lead_ids=body.lead_ids, max_leads=body.max_leads)
    if not leads:
        return {"started": False, "message": "No leads to enrich", "runs": []}

    run_ids = {str(lead["id"]): _create_run(str(lead["id"])) for lead in leads}

    def _bg():
        try:
            from app.agents.lead_enrichment_agent import run_enrichment
            run_enrichment(lead_ids=[str(l["id"]) for l in leads],
                           max_leads=body.max_leads,
                           run_ids=run_ids)
        except Exception as e:
            logger.error("Background enrichment error: %s", e)
        # Auto-score after enrichment
        try:
            from app.agents.lead_scorer import score_leads as _score
            _score(lead_ids=[str(l["id"]) for l in leads])
        except Exception as e:
            logger.error("Auto-score after enrich error: %s", e)

    threading.Thread(target=_bg, daemon=True).start()

    runs = [{"run_id": run_ids[str(l["id"])], "lead_id": str(l["id"]), "company": l["company"]}
            for l in leads]
    return {"started": True, "runs": runs}


@router.get("/leads/enrich/status")
def enrichment_status(request: Request):
    """Summary of lead enrichment status counts."""
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT enrichment_status, COUNT(*) as count
            FROM sales_leads WHERE archived=false GROUP BY enrichment_status
        """)
        rows = cur.fetchall()
        return {r["enrichment_status"] or "pending": r["count"] for r in rows}
    finally:
        conn.close()


@router.get("/runs/{run_id}")
def get_run(run_id: str, request: Request):
    """Return a single enrichment run with its full step trace."""
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM enrichment_runs WHERE id=%s", [run_id])
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404)
    d = dict(row)
    d["id"] = str(d["id"])
    d["lead_id"] = str(d["lead_id"])
    for k in ("started_at", "finished_at"):
        if d.get(k) and hasattr(d[k], "isoformat"):
            d[k] = d[k].isoformat()
    return d


# ── Mutual Connection Agent ───────────────────────────────────────────────────

class MutualConnectionRequest(BaseModel):
    lead_ids: Optional[List[str]] = None
    unchecked_only: bool = True


@router.post("/leads/mutual-connections")
def find_mutual_connections(body: MutualConnectionRequest, request: Request):
    """Start async mutual connection check. Returns immediately; agent runs in background."""
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        if body.lead_ids:
            cur.execute(
                "SELECT id, company FROM sales_leads WHERE id = ANY(%s::uuid[]) AND archived=false",
                [body.lead_ids],
            )
        elif body.unchecked_only:
            cur.execute(
                "SELECT id, company FROM sales_leads WHERE archived=false AND mutual_connection_checked_at IS NULL"
            )
        else:
            cur.execute("SELECT id, company FROM sales_leads WHERE archived=false")
        leads = [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()

    if not leads:
        return {"started": False, "message": "No leads to check", "lead_count": 0}

    def _bg():
        try:
            from app.agents.mutual_connection_agent import run_mutual_connections
            run_mutual_connections(
                lead_ids=[str(l["id"]) for l in leads],
                unchecked_only=False,
            )
        except Exception as e:
            logger.error("Background mutual connection error: %s", e)
        # Re-score after to update warm_connection category
        try:
            from app.agents.lead_scorer import score_leads as _score
            _score(lead_ids=[str(l["id"]) for l in leads])
        except Exception as e:
            logger.error("Auto-score after mutual connections error: %s", e)

    threading.Thread(target=_bg, daemon=True).start()
    return {"started": True, "lead_count": len(leads), "companies": [l["company"] for l in leads]}


@router.get("/leads/mutual-connections/status")
def mutual_connections_status(request: Request):
    """Return counts of leads by mutual connection check status."""
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE mutual_connection_checked_at IS NULL) AS unchecked,
                COUNT(*) FILTER (WHERE mutual_connection_checked_at IS NOT NULL AND mutual_connection IS NOT NULL) AS found,
                COUNT(*) FILTER (WHERE mutual_connection_checked_at IS NOT NULL AND mutual_connection IS NULL) AS not_found,
                COUNT(*) AS total
            FROM sales_leads WHERE archived=false
        """)
        row = dict(cur.fetchone())
        return row
    finally:
        conn.close()


# ── Lead Scoring ──────────────────────────────────────────────────────────────

class ScoreRequest(BaseModel):
    lead_ids: Optional[List[str]] = None  # None = score all


@router.post("/leads/score")
def score_leads(body: ScoreRequest, request: Request):
    """Run the rule-based priority scorer on leads."""
    _require_user(request)
    try:
        from app.agents.lead_scorer import score_leads as _score
        return _score(lead_ids=body.lead_ids)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/leads/{lead_id}/score")
def score_single_lead(lead_id: str, request: Request):
    """Score a single lead."""
    _require_user(request)
    try:
        from app.agents.lead_scorer import score_leads as _score
        result = _score(lead_ids=[lead_id])
        # Return updated lead
        conn = _conn()
        try:
            cur = conn.cursor()
            cur.execute("SELECT * FROM sales_leads WHERE id=%s::uuid", [lead_id])
            row = cur.fetchone()
        finally:
            conn.close()
        return _lead_dict(row) if row else result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── GooseWorks balance ────────────────────────────────────────────────────────

import urllib.request as _urllib_req

@router.get("/gooseworks/balance")
def get_gooseworks_balance(request: Request):
    """Proxy GooseWorks /v1/credits and return balance + recent run stats."""
    _require_user(request)
    # Read API key from credentials file
    creds_path = os.path.expanduser("~/.gooseworks/credentials.json")
    try:
        with open(creds_path) as f:
            creds = json.load(f)
        api_key = creds.get("api_key", "")
    except Exception:
        raise HTTPException(status_code=500, detail="GooseWorks credentials not found")

    try:
        req = _urllib_req.Request(
            "https://api.gooseworks.ai/v1/credits",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        )
        with _urllib_req.urlopen(req, timeout=10) as resp:
            gw_data = json.loads(resp.read())
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"GooseWorks API error: {e}")

    # Pull per-run credit stats from our DB
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE status='completed') AS total_runs,
                COALESCE(SUM(credits_used), 0) AS total_credits_used,
                COALESCE(AVG(credits_used) FILTER (WHERE status='completed' AND credits_used > 0), 0) AS avg_credits_per_run,
                COALESCE(MAX(credits_used), 0) AS max_credits_run
            FROM enrichment_runs
            WHERE started_at > now() - interval '30 days'
        """)
        stats = dict(cur.fetchone())
    finally:
        conn.close()

    credits = gw_data.get("data", {})
    return {
        "available": credits.get("available_credits", 0),
        "lifetime_used": credits.get("lifetime_used_credits", 0),
        "lifetime_granted": credits.get("lifetime_granted_credits", 0),
        "cycle_used": credits.get("current_cycle_used_credits", 0),
        "cycle_allocated": credits.get("current_cycle_allocated_credits", 0),
        "consumed_pct": credits.get("consumed_percentage", 0),
        "cost_per_credit_usd": 0.01,
        "runs_30d": int(stats["total_runs"]),
        "credits_used_30d": int(stats["total_credits_used"]),
        "avg_credits_per_run": round(float(stats["avg_credits_per_run"]), 1),
    }


# ── Lead Acquisition ──────────────────────────────────────────────────────────

class ApolloAcquisitionRequest(BaseModel):
    keywords: Optional[List[str]] = None
    employee_ranges: Optional[List[str]] = None
    locations: Optional[List[str]] = None
    max_results: int = 50


class JobSignalsRequest(BaseModel):
    searches: Optional[List[str]] = None
    hours_old: int = 720
    max_per_search: int = 25


class EventScrapeRequest(BaseModel):
    url: str


def _run_acquisition_bg(fn, kwargs: dict):
    """Run an acquisition function in a background thread, updating acquisition_runs."""
    run_id = str(uuid.uuid4())
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO acquisition_runs (id, source, status) VALUES (%s, %s, 'running')",
            [run_id, kwargs.get("_source", "unknown")],
        )
        conn.commit()
    finally:
        conn.close()

    def _bg():
        try:
            result = fn(**{k: v for k, v in kwargs.items() if not k.startswith("_")})
            conn2 = _conn()
            try:
                cur2 = conn2.cursor()
                cur2.execute(
                    "UPDATE acquisition_runs SET status='completed', finished_at=now(), "
                    "added=%s, skipped=%s, result=%s::jsonb WHERE id=%s",
                    [result.get("added", 0), result.get("skipped", 0),
                     json.dumps(result), run_id],
                )
                conn2.commit()
            finally:
                conn2.close()
        except Exception as e:
            logger.error("Acquisition run %s error: %s", run_id, e)
            conn3 = _conn()
            try:
                cur3 = conn3.cursor()
                cur3.execute(
                    "UPDATE acquisition_runs SET status='failed', finished_at=now(), result=%s::jsonb WHERE id=%s",
                    [json.dumps({"error": str(e)}), run_id],
                )
                conn3.commit()
            finally:
                conn3.close()

    threading.Thread(target=_bg, daemon=True).start()
    return run_id


@router.post("/leads/acquire/apollo")
def acquire_apollo(body: ApolloAcquisitionRequest, request: Request):
    _require_user(request)
    from app.agents.lead_acquisition_agent import run_apollo_search
    run_id = _run_acquisition_bg(run_apollo_search, {
        "_source": "apollo_search",
        "keywords": body.keywords,
        "employee_ranges": body.employee_ranges,
        "locations": body.locations,
        "max_results": body.max_results,
    })
    return {"started": True, "run_id": run_id}


@router.post("/leads/acquire/jobs")
def acquire_jobs(body: JobSignalsRequest, request: Request):
    _require_user(request)
    from app.agents.lead_acquisition_agent import run_job_signals
    run_id = _run_acquisition_bg(run_job_signals, {
        "_source": "job_signal",
        "searches": body.searches,
        "hours_old": body.hours_old,
        "max_per_search": body.max_per_search,
    })
    return {"started": True, "run_id": run_id}


@router.post("/leads/acquire/events")
def acquire_events(body: EventScrapeRequest, request: Request):
    _require_user(request)
    from app.agents.lead_acquisition_agent import run_event_scrape
    run_id = _run_acquisition_bg(run_event_scrape, {
        "_source": "event_scrape",
        "url": body.url,
    })
    return {"started": True, "run_id": run_id}


# ── Google Sheets Bidirectional Sync ──────────────────────────────────────────

SHEETS_SYNC_INTERVAL = 300  # seconds between automatic syncs

SHEETS_API             = "https://sheets.googleapis.com/v4/spreadsheets"
GOOGLE_TOKEN_REFRESH   = "https://oauth2.googleapis.com/token"
DEFAULT_SPREADSHEET_ID = "1T_tWv5tTEia93H5v-tCZObfUF4OMtvXIHlGb4yb9eBc"
SHEET_TAB              = "Sheet1"

# Columns synced to the sheet (order defines column A, B, C…)
SHEET_COLS = [
    "id", "company", "priority", "priority_score", "reach_out_status",
    "mutual_connection", "recommended_action", "notes", "website",
    "industry", "region", "city", "employee_count", "est_revenue",
    "tier_size", "key_products", "source", "company_linkedin",
    "description", "technologies", "contacts", "updated_at",
]
_LAST_COL = chr(ord("A") + len(SHEET_COLS) - 1)  # "V"
_SHEET_RANGE = f"{SHEET_TAB}!A:{_LAST_COL}"


def _get_google_token(user_id: str) -> str:
    """Return a valid Google access token (refreshes if needed). Requires drive scope."""
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT access_token, refresh_token, token_expiry, scopes "
            "FROM google_oauth_tokens WHERE user_id = %s",
            [user_id],
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(
            status_code=403,
            detail={"code": "no_google_token",
                    "message": "Google account not connected. Connect via Contacts → Google."},
        )

    scopes = row["scopes"] or []
    if not any("drive" in s or "spreadsheets" in s for s in scopes):
        raise HTTPException(
            status_code=403,
            detail={"code": "needs_drive_scope",
                    "message": "Google Drive access not granted. Re-connect your Google account."},
        )

    expiry = row["token_expiry"]
    if expiry and datetime.now(timezone.utc) >= expiry - timedelta(minutes=2):
        r = httpx.post(
            GOOGLE_TOKEN_REFRESH,
            data={
                "client_id":     os.environ.get("GOOGLE_CLIENT_ID", ""),
                "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET", ""),
                "refresh_token": row["refresh_token"],
                "grant_type":    "refresh_token",
            },
            timeout=15,
        )
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to refresh Google token")
        data = r.json()
        new_token  = data["access_token"]
        new_expiry = datetime.now(timezone.utc) + timedelta(seconds=data.get("expires_in", 3600))
        conn2 = _conn()
        try:
            cur2 = conn2.cursor()
            cur2.execute(
                "UPDATE google_oauth_tokens SET access_token=%s, token_expiry=%s, updated_at=NOW() "
                "WHERE user_id=%s",
                [new_token, new_expiry, user_id],
            )
            conn2.commit()
        finally:
            conn2.close()
        return new_token

    return row["access_token"]


def _lead_to_row(lead: dict) -> list:
    """Convert a lead dict to a sheet row in SHEET_COLS order."""
    row = []
    for col in SHEET_COLS:
        val = lead.get(col)
        if val is None:
            row.append("")
        elif isinstance(val, (list, dict)):
            row.append(json.dumps(val) if val else "")
        else:
            row.append(str(val))
    return row


def _parse_dt(s: str):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def _pick_any_drive_token() -> Optional[str]:
    """Return a valid access token from any user with drive scope, or None."""
    try:
        conn = _conn()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT user_id, access_token, refresh_token, token_expiry "
                "FROM google_oauth_tokens "
                "WHERE scopes::text LIKE '%drive%' "
                "ORDER BY updated_at DESC LIMIT 1"
            )
            row = cur.fetchone()
        finally:
            conn.close()

        if not row:
            return None

        expiry = row["token_expiry"]
        if expiry and datetime.now(timezone.utc) >= expiry - timedelta(minutes=2):
            r = httpx.post(
                GOOGLE_TOKEN_REFRESH,
                data={
                    "client_id":     os.environ.get("GOOGLE_CLIENT_ID", ""),
                    "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET", ""),
                    "refresh_token": row["refresh_token"],
                    "grant_type":    "refresh_token",
                },
                timeout=15,
            )
            if r.status_code != 200:
                return None
            data = r.json()
            new_token  = data["access_token"]
            new_expiry = datetime.now(timezone.utc) + timedelta(seconds=data.get("expires_in", 3600))
            conn2 = _conn()
            try:
                cur2 = conn2.cursor()
                cur2.execute(
                    "UPDATE google_oauth_tokens SET access_token=%s, token_expiry=%s, updated_at=NOW() "
                    "WHERE user_id=%s",
                    [new_token, new_expiry, row["user_id"]],
                )
                conn2.commit()
            finally:
                conn2.close()
            return new_token

        return row["access_token"]
    except Exception:
        return None


def _sync_all_systems_bg():
    """Background-sync every system that has a spreadsheet_id configured."""
    def _run():
        token = _pick_any_drive_token()
        if not token:
            return
        conn = _conn()
        try:
            cur = conn.cursor()
            cur.execute("SELECT spreadsheet_id FROM crm_systems WHERE spreadsheet_id IS NOT NULL AND spreadsheet_id <> ''")
            sheet_ids = [r["spreadsheet_id"] for r in cur.fetchall()]
        except Exception:
            sheet_ids = [DEFAULT_SPREADSHEET_ID]
        finally:
            conn.close()
        for sid in sheet_ids:
            try:
                _do_sync(token, sid)
            except Exception as e:
                logger.warning("Background sheets sync failed (%s): %s", sid, e)
    threading.Thread(target=_run, daemon=True).start()


def _sync_sheets_bg(spreadsheet_id: Optional[str] = None):
    """Sync a single system's sheet (or all systems if no spreadsheet_id given)."""
    if not spreadsheet_id:
        _sync_all_systems_bg()
        return
    def _run():
        token = _pick_any_drive_token()
        if not token:
            return
        try:
            _do_sync(token, spreadsheet_id)
        except Exception as e:
            logger.warning("Background sheets sync failed: %s", e)
    threading.Thread(target=_run, daemon=True).start()


_sync_timer: Optional[threading.Timer] = None


def start_periodic_sync():
    """Schedule bidirectional sync of all systems every SHEETS_SYNC_INTERVAL seconds."""
    global _sync_timer

    def _tick():
        global _sync_timer
        _sync_all_systems_bg()
        _sync_timer = threading.Timer(SHEETS_SYNC_INTERVAL, _tick)
        _sync_timer.daemon = True
        _sync_timer.start()

    _sync_timer = threading.Timer(SHEETS_SYNC_INTERVAL, _tick)
    _sync_timer.daemon = True
    _sync_timer.start()
    logger.info("Sheets auto-sync scheduled every %ds", SHEETS_SYNC_INTERVAL)


class SheetsSyncRequest(BaseModel):
    spreadsheet_id: str = DEFAULT_SPREADSHEET_ID


def _do_sync(token: str, spreadsheet_id: str = DEFAULT_SPREADSHEET_ID) -> dict:
    """
    Core bidirectional sync logic. Called by the HTTP endpoint and the background worker.
    Raises on hard errors; returns stats dict on success.
    """
    auth = {"Authorization": f"Bearer {token}"}

    # ── 1. Read sheet ─────────────────────────────────────────────────────────
    r = httpx.get(
        f"{SHEETS_API}/{spreadsheet_id}/values/{_SHEET_RANGE}",
        headers=auth, timeout=20,
    )
    if r.status_code in (401, 403):
        raise RuntimeError(f"Google Sheets access denied ({r.status_code}): {r.text[:200]}")
    if r.status_code != 200:
        raise RuntimeError(f"Sheets API error {r.status_code}: {r.text[:200]}")

    raw_values = r.json().get("values", [])

    # ── 2. Parse headers / rows ───────────────────────────────────────────────
    if raw_values:
        sheet_headers = [str(h).strip() for h in raw_values[0]]
        sheet_data    = raw_values[1:]
    else:
        sheet_headers = SHEET_COLS[:]
        sheet_data    = []

    col_idx = {h: i for i, h in enumerate(sheet_headers)}

    def gv(row: list, col: str) -> str:
        i = col_idx.get(col)
        if i is None or i >= len(row):
            return ""
        return str(row[i]).strip() if row[i] is not None else ""

    # ── 3. Fetch DB leads ─────────────────────────────────────────────────────
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM sales_leads WHERE archived=false ORDER BY created_at")
        db_by_id = {str(row["id"]): _lead_dict(row) for row in cur.fetchall()}
    finally:
        conn.close()

    # ── 4. Categorise sheet rows ──────────────────────────────────────────────
    sheet_matched: dict[str, tuple[list, int]] = {}
    sheet_new:     list[tuple[list, int]]      = []

    for i, row in enumerate(sheet_data):
        row_num = i + 2
        row_id  = gv(row, "id")
        company = gv(row, "company")
        if not company:
            continue
        if row_id and row_id in db_by_id:
            sheet_matched[row_id] = (row, row_num)
        else:
            sheet_new.append((row, row_num))

    stats = {
        "sheet_to_db_created":   0,
        "db_to_sheet_appended":  0,
        "db_updated_from_sheet": 0,
        "sheet_updated_from_db": 0,
        "no_change":             0,
    }
    batch_updates: list[dict] = []

    # ── 5. Create sheet-new rows in DB ────────────────────────────────────────
    id_writebacks: list[tuple[int, str, str]] = []

    if sheet_new:
        conn = _conn()
        try:
            cur = conn.cursor()
            for row, row_num in sheet_new:
                company = gv(row, "company")
                if not company:
                    continue
                emp_raw = gv(row, "employee_count")
                try:
                    emp_int = int(emp_raw) if emp_raw else None
                except ValueError:
                    emp_int = None
                cur.execute(
                    """INSERT INTO sales_leads
                       (company, priority, reach_out_status, mutual_connection,
                        recommended_action, notes, website, industry, region, city,
                        est_revenue, tier_size, key_products, source, description,
                        company_linkedin, employee_count)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       RETURNING id, updated_at""",
                    [
                        company,
                        gv(row, "priority") or None,
                        gv(row, "reach_out_status") or None,
                        gv(row, "mutual_connection") or None,
                        gv(row, "recommended_action") or None,
                        gv(row, "notes") or None,
                        gv(row, "website") or None,
                        gv(row, "industry") or None,
                        gv(row, "region") or None,
                        gv(row, "city") or None,
                        gv(row, "est_revenue") or None,
                        gv(row, "tier_size") or None,
                        gv(row, "key_products") or None,
                        gv(row, "source") or "manual",
                        gv(row, "description") or None,
                        gv(row, "company_linkedin") or None,
                        emp_int,
                    ],
                )
                result  = cur.fetchone()
                new_id  = str(result["id"])
                upd_iso = result["updated_at"].isoformat()
                id_writebacks.append((row_num, new_id, upd_iso))
                stats["sheet_to_db_created"] += 1
            conn.commit()
        finally:
            conn.close()

    # ── 6. Compare matched rows ───────────────────────────────────────────────
    updates_to_db:    list[tuple[str, list]] = []
    updates_to_sheet: list[tuple[str, int, dict]] = []

    for lead_id, (row, row_num) in sheet_matched.items():
        db_lead  = db_by_id[lead_id]
        sheet_dt = _parse_dt(gv(row, "updated_at"))
        db_dt    = _parse_dt(db_lead.get("updated_at", ""))

        if sheet_dt and db_dt:
            if sheet_dt > db_dt:
                updates_to_db.append((lead_id, row))
            elif db_dt > sheet_dt:
                updates_to_sheet.append((lead_id, row_num, db_lead))
            else:
                stats["no_change"] += 1
        else:
            updates_to_sheet.append((lead_id, row_num, db_lead))

    # ── 7. Apply sheet→DB updates ─────────────────────────────────────────────
    if updates_to_db:
        conn = _conn()
        try:
            cur = conn.cursor()
            for lead_id, row in updates_to_db:
                emp_raw = gv(row, "employee_count")
                try:
                    emp_int = int(emp_raw) if emp_raw else None
                except ValueError:
                    emp_int = None
                cur.execute(
                    """UPDATE sales_leads SET
                       company=%s, priority=%s, reach_out_status=%s, mutual_connection=%s,
                       recommended_action=%s, notes=%s, website=%s, industry=%s,
                       region=%s, city=%s, est_revenue=%s, tier_size=%s,
                       key_products=%s, description=%s, company_linkedin=%s,
                       employee_count=%s, updated_at=now()
                       WHERE id=%s::uuid AND archived=false""",
                    [
                        gv(row, "company") or db_by_id[lead_id]["company"],
                        gv(row, "priority") or None,
                        gv(row, "reach_out_status") or None,
                        gv(row, "mutual_connection") or None,
                        gv(row, "recommended_action") or None,
                        gv(row, "notes") or None,
                        gv(row, "website") or None,
                        gv(row, "industry") or None,
                        gv(row, "region") or None,
                        gv(row, "city") or None,
                        gv(row, "est_revenue") or None,
                        gv(row, "tier_size") or None,
                        gv(row, "key_products") or None,
                        gv(row, "description") or None,
                        gv(row, "company_linkedin") or None,
                        emp_int,
                        lead_id,
                    ],
                )
                stats["db_updated_from_sheet"] += 1
            conn.commit()
        finally:
            conn.close()

    # ── 8. Build sheet batch-update ───────────────────────────────────────────
    for lead_id, row_num, db_lead in updates_to_sheet:
        batch_updates.append({
            "range":  f"{SHEET_TAB}!A{row_num}:{_LAST_COL}{row_num}",
            "values": [_lead_to_row(db_lead)],
        })
        stats["sheet_updated_from_db"] += 1

    _id_col  = chr(ord("A") + SHEET_COLS.index("id"))
    _upd_col = chr(ord("A") + SHEET_COLS.index("updated_at"))
    for row_num, new_id, upd_iso in id_writebacks:
        batch_updates.append({"range": f"{SHEET_TAB}!{_id_col}{row_num}",  "values": [[new_id]]})
        batch_updates.append({"range": f"{SHEET_TAB}!{_upd_col}{row_num}", "values": [[upd_iso]]})

    # ── 9. Append DB leads not yet in sheet ───────────────────────────────────
    db_not_in_sheet = [lead for lid, lead in db_by_id.items() if lid not in sheet_matched]
    rows_to_append  = [_lead_to_row(lead) for lead in db_not_in_sheet]
    stats["db_to_sheet_appended"] = len(rows_to_append)

    # ── 10. Write to Google Sheets ────────────────────────────────────────────
    if not raw_values:
        httpx.put(
            f"{SHEETS_API}/{spreadsheet_id}/values/{_SHEET_RANGE}",
            headers=auth,
            params={"valueInputOption": "USER_ENTERED"},
            json={"values": [SHEET_COLS]},
            timeout=20,
        )

    if batch_updates:
        r2 = httpx.post(
            f"{SHEETS_API}/{spreadsheet_id}/values:batchUpdate",
            headers=auth,
            json={"valueInputOption": "USER_ENTERED", "data": batch_updates},
            timeout=30,
        )
        if r2.status_code != 200:
            raise RuntimeError(f"Sheets batchUpdate error: {r2.text[:200]}")

    if rows_to_append:
        r3 = httpx.post(
            f"{SHEETS_API}/{spreadsheet_id}/values/{_SHEET_RANGE}:append",
            headers=auth,
            params={"valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"},
            json={"values": rows_to_append},
            timeout=30,
        )
        if r3.status_code != 200:
            raise RuntimeError(f"Sheets append error: {r3.text[:200]}")

    return stats


@router.post("/leads/sheets/sync")
def sync_leads_sheets(body: SheetsSyncRequest, request: Request):
    user_id = _require_user(request)
    token   = _get_google_token(user_id)
    try:
        stats = _do_sync(token, body.spreadsheet_id)
    except RuntimeError as e:
        msg = str(e)
        if "access denied" in msg.lower() or "403" in msg:
            raise HTTPException(status_code=403, detail=str(e))
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, "stats": stats}
