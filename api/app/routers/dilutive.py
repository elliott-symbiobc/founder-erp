"""
dilutive.py — Dilutive (investor) funding tracker endpoints.

GET    /dilutive                     — list all investors (filterable)
POST   /dilutive/import              — bulk CSV import
POST   /dilutive                     — create investor record
PATCH  /dilutive/{investor_id}       — update fields
GET    /dilutive/{investor_id}/history — stage moves, outreach, activities
POST   /dilutive/{investor_id}/activities — log an activity
PATCH  /dilutive/activities/{activity_id} — edit a logged activity
DELETE /dilutive/activities/{activity_id} — delete a logged activity
POST   /dilutive/{investor_id}/history-notes — note on a history entry
PATCH  /dilutive/history-notes/{note_id} — edit a note
DELETE /dilutive/history-notes/{note_id} — delete a note
POST   /dilutive/{investor_id}/enrich — AI-enrich investor/firm details
DELETE /dilutive/{investor_id}       — delete record
"""

import csv
import datetime
import io
import logging
import os
import re
import uuid
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dilutive", tags=["dilutive"])

UPDATABLE = {
    "status", "name", "role", "firm", "firm_type", "investor_type", "intro_type",
    "intro_notes", "email", "notes", "office_phone", "cell_phone",
    "tags", "funding_type", "avg_check_size", "source_link",
    # enrichment fields
    "hq", "address", "geo_focus", "investment_stage", "focus",
    "fund_size", "fund_launch_year", "website", "linkedin",
    "portfolio_url", "partners", "description",
    "check_size_min", "check_size_max",
    "portfolio", "enriched_fields",
    # scoring fields
    "score_focus", "score_stage", "score_check", "score_geo", "score_portfolio",
    "total_score", "tier", "enrichment_notes",
    "is_priority", "linked_project_id",
    "outreach_date", "assigned_to", "outreach_channel",
    # pipeline board (see sql/migrations/092)
    "pipeline_stage", "closed_lost_reason",
    "close_reason_code", "revisit_date", "revisit_trigger",
}

# Fixed pipeline ladder for the investor board — mirrors the contract pipeline
# in /crm. "Lead" is the un-worked import and only appears on the All Investors
# board; the Priority board starts at Prospect.
PIPELINE_STAGES = [
    "Lead", "Prospect", "Qualification", "Negotiation", "Nurture",
    "Closed Lost", "Closed Won",
]

# Where an ending lands, by the group its reason belongs to. A revisit is not a
# loss — it is a deal with a date on it — so it goes somewhere it can be found
# again rather than into the pile nobody reopens.
CLOSE_GROUP_STAGE = {"revisit": "Nurture", "lost": "Closed Lost"}

# The two badge colours, held once. The group decides; the individual reason
# never carries a colour of its own, so a new reason needs no code change.
CLOSE_GROUP_STYLE = {
    "revisit": {"label": "Reach Out Later", "fill": "#FEF3C7", "text": "#B45309"},
    "lost": {"label": "Fully Lost", "fill": "#FEE2E2", "text": "#B91C1C"},
}

# Stages an ending puts a record into. Moving off one of these clears the whole
# ending — reason, revisit plan and end date together.
CLOSED_STAGES = ("Nurture", "Closed Lost", "Closed Won")


def get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


# Fallback system prompt for AI enrichment. Mirrors the "dilutive_enrich" entry in
# app/core/agent_config.py; used when the registry/DB override is unavailable.
_DEFAULT_ENRICH_PROMPT = (
    "You are a venture-capital analyst helping an early-stage startup "
    "research prospective investors. Given an investor or firm, enrich the record with what you know.\n\n"
    "Return ONLY valid JSON with these fields (null for unknown):\n"
    "{\n"
    "  \"firm_type\": string,\n"
    "  \"hq\": string,\n"
    "  \"geo_focus\": string,\n"
    "  \"investment_stage\": string,\n"
    "  \"focus\": string,\n"
    "  \"fund_size\": string,\n"
    "  \"fund_launch_year\": string,\n"
    "  \"website\": string,\n"
    "  \"linkedin\": string,\n"
    "  \"portfolio_url\": string,\n"
    "  \"partners\": string,\n"
    "  \"check_size_min\": string,\n"
    "  \"check_size_max\": string,\n"
    "  \"description\": string,\n"
    "  \"tags\": [string],\n"
    "  \"enrichment_summary\": string\n"
    "}\n\n"
    "firm_type: e.g. 'VC', 'Angel', 'Family Office', 'Corporate VC', 'Accelerator'\n"
    "hq: city, country of headquarters\n"
    "geo_focus: regions where they invest, e.g. 'US, Europe'\n"
    "investment_stage: e.g. 'Pre-seed', 'Seed', 'Series A', 'Seed–Series B'\n"
    "focus: thesis / sectors, e.g. 'Enterprise SaaS, climate, fintech'\n"
    "fund_size: total fund size as string, e.g. '$200M'\n"
    "check_size_min / check_size_max: typical check range, e.g. '$250K' / '$2M'\n"
    "partners: notable partners (comma-separated)\n"
    "description: 2-3 sentences on the firm and its fit for the company\n"
    "tags: relevant tags (max 5)\n"
    "enrichment_summary: one sentence describing what was found\n\n"
    "Only include fields you're reasonably confident about. Do not invent URLs — leave links null if unsure."
)


# ── CSV import helpers ─────────────────────────────────────────────────────────

def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _clean(s) -> Optional[str]:
    s = (s or "").strip()
    return None if not s or s in ("0", "-", "?", "N/A", "#N/A") else s


def _extract_email(val: str):
    v = (val or "").strip()
    if not v:
        return None, None
    if "@" in v:
        return v.lower(), None
    if "linkedin.com" in v:
        return None, v
    return None, None


def _normalize_row(row: dict) -> dict:
    """Return a copy of row with all keys stripped of whitespace."""
    return {k.strip(): v for k, v in row.items()}


def _get(row: dict, *keys: str) -> str:
    """Try multiple key names (handles columns with trailing spaces etc.)."""
    for k in keys:
        v = row.get(k) or row.get(k.strip()) or ""
        if v:
            return v
    return ""


def _map_csv_row(row: dict) -> Optional[dict]:
    row = _normalize_row(row)
    firm_raw = (row.get("Name") or "").strip()
    if not firm_raw or firm_raw == "Name":
        return None

    e1, li1 = _extract_email(row.get("Email") or "")
    e2, li2 = _extract_email(row.get("Email 1") or "")
    primary_email = e1 or e2

    li_col = _clean(_get(row, "LinkedIn", "Linkedin"))
    linkedin = li_col or li1 or li2

    launch_raw = _clean(row.get("Launch of Latest Fund") or "")
    fund_launch = None if not launch_raw or launch_raw == "0" else launch_raw

    focus_val = _clean(row.get("Focus") or "")

    return {
        "firm":             firm_raw,
        "name":             _clean(row.get("Partners") or ""),
        "role":             _clean(row.get("Person Role") or ""),
        "firm_type":        _clean(row.get("Type") or ""),
        "email":            primary_email,
        "linkedin":         linkedin,
        "website":          _clean(row.get("Website") or ""),
        "hq":               _clean(_get(row, "HQ", "HQ ")),
        "address":          _clean(row.get("Address") or ""),
        "geo_focus":        _clean(row.get("Geo Focus") or ""),
        "investment_stage": _clean(row.get("Investment Stage") or ""),
        "focus":            focus_val,
        "fund_size":        _clean(row.get("Fund Size") or ""),
        "fund_launch_year": fund_launch,
        "portfolio_url":    _clean(row.get("Portfolio URL") or ""),
        "check_size_min":   _clean(_get(row, "Ticket Sizes Min/Range", "Ticket Size Min/Range")),
        "check_size_max":   _clean(row.get("Ticket Size Max") or ""),
        "description":      _clean(row.get("Description of Company") or ""),
        "avg_check_size":   _clean(row.get("Ticket Size Max") or ""),
        "tags":             [focus_val] if focus_val else [],
    }


def _dedup_key(rec: dict) -> str:
    firm_key    = _norm(rec.get("firm") or "")
    email_key   = _norm(rec.get("email") or "")
    partner_key = _norm(rec.get("name") or "")[:30]
    secondary   = email_key if email_key else partner_key
    return f"{firm_key}|{secondary}"


# Enrichment fields that get filled in on upsert (never overwrite user-set values)
_UPSERT_FIELDS = [
    "name", "role", "firm_type", "email", "linkedin", "website",
    "hq", "address", "geo_focus", "investment_stage", "focus",
    "fund_size", "fund_launch_year", "portfolio_url",
    "check_size_min", "check_size_max", "avg_check_size", "description",
]


# ── Bulk CSV import ────────────────────────────────────────────────────────────

@router.post("/import")
async def import_csv(file: UploadFile = File(...)):
    raw = await file.read()
    text = None
    for enc in ("utf-8-sig", "utf-8", "latin-1", "cp1252"):
        try:
            text = raw.decode(enc)
            break
        except Exception:
            continue
    if text is None:
        raise HTTPException(status_code=400, detail="Could not decode CSV file")

    reader = csv.DictReader(io.StringIO(text))
    records: list[dict] = []
    seen: set[str] = set()
    skipped_dup = 0

    for row in reader:
        rec = _map_csv_row(row)
        if rec is None:
            continue
        key = _dedup_key(rec)
        if key in seen:
            skipped_dup += 1
            continue
        seen.add(key)
        records.append(rec)

    conn = get_conn()
    inserted = 0
    updated = 0
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Load existing records for upsert matching
            cur.execute(
                "SELECT investor_id, firm, email, name, "
                + ", ".join(_UPSERT_FIELDS)
                + " FROM dilutive_investors WHERE firm IS NOT NULL"
            )
            existing: dict[str, dict] = {}
            for r in cur.fetchall():
                existing[_dedup_key({"firm": r["firm"] or "", "email": r["email"] or "", "name": r["name"] or ""})] = dict(r)

            for rec in records:
                key = _dedup_key(rec)
                if key in existing:
                    # Upsert: fill in NULL fields only (never overwrite existing data)
                    db_row = existing[key]
                    patch = {
                        f: rec[f] for f in _UPSERT_FIELDS
                        if rec.get(f) and not db_row.get(f)
                    }
                    if patch:
                        set_clause = ", ".join(f"{k} = %s" for k in patch)
                        cur.execute(
                            f"UPDATE dilutive_investors SET {set_clause}, updated_at = NOW() WHERE investor_id = %s",
                            list(patch.values()) + [db_row["investor_id"]],
                        )
                        updated += 1
                    continue

                cur.execute("""
                    INSERT INTO dilutive_investors
                        (status, name, role, firm, firm_type, email, linkedin,
                         website, hq, address, geo_focus, investment_stage, focus,
                         fund_size, fund_launch_year, portfolio_url,
                         check_size_min, check_size_max, avg_check_size,
                         description, tags)
                    VALUES
                        (%s,%s,%s,%s,%s,%s,%s,
                         %s,%s,%s,%s,%s,%s,
                         %s,%s,%s,
                         %s,%s,%s,
                         %s,%s)
                    RETURNING investor_id
                """, (
                    # Imported rows land in the directory unworked: nobody owes
                    # anybody a move yet, so they carry no status.
                    None,
                    rec["name"], rec["role"], rec["firm"], rec["firm_type"],
                    rec["email"], rec["linkedin"], rec["website"], rec["hq"],
                    rec["address"], rec["geo_focus"], rec["investment_stage"],
                    rec["focus"], rec["fund_size"], rec["fund_launch_year"],
                    rec["portfolio_url"], rec["check_size_min"],
                    rec["check_size_max"], rec["avg_check_size"],
                    rec["description"], rec["tags"],
                ))
                cur.fetchone()
                inserted += 1

        conn.commit()

        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM dilutive_investors")
            total = cur.fetchone()[0]

        return {
            "inserted": inserted,
            "updated": updated,
            "skipped_duplicate": skipped_dup,
            "total_in_db": total,
        }
    except Exception as e:
        conn.rollback()
        logger.exception("CSV import failed")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


# ── Statuses CRUD ─────────────────────────────────────────────────────────────

# ── Close reasons ─────────────────────────────────────────────────────────────

def _close_reason(cur, code):
    """The reason row, or a 422 naming the code that does not exist."""
    cur.execute(
        "SELECT code, label, reason_group, excludes_reporting FROM dilutive_close_reasons"
        " WHERE code = %s AND is_active",
        (code,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=422, detail=f"Unknown close reason: {code}")
    return dict(row)


@router.get("/close-reasons")
def list_close_reasons():
    """The option set for the ending dialog, colours included.

    Colour and routing come from the group, resolved here, so the client renders
    whatever it is handed and a reason added to the table tomorrow needs no
    change on either side.
    """
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT code, label, reason_group, excludes_reporting FROM dilutive_close_reasons"
                " WHERE is_active ORDER BY sort_order, label"
            )
            return [{
                **dict(r),
                "stage": CLOSE_GROUP_STAGE[r["reason_group"]],
                "group_label": CLOSE_GROUP_STYLE[r["reason_group"]]["label"],
                "fill": CLOSE_GROUP_STYLE[r["reason_group"]]["fill"],
                "text_color": CLOSE_GROUP_STYLE[r["reason_group"]]["text"],
                # A revisit is a promise to come back, so it has to say when.
                "requires_revisit": r["reason_group"] == "revisit",
            } for r in cur.fetchall()]
    finally:
        conn.close()


@router.get("/reports/closed-lost")
def closed_lost_report():
    """Endings broken down by reason, split revisit vs lost at the top.

    Records whose reason excludes them from reporting are counted separately
    and kept out of both totals — a duplicate is not a lost deal, and leaving it
    in would quietly inflate every number built on this.
    """
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT r.code, r.label, r.reason_group, r.excludes_reporting,
                       count(*) AS n,
                       count(*) FILTER (WHERE i.revisit_date IS NOT NULL
                                          AND i.revisit_date <= CURRENT_DATE) AS due_now
                FROM dilutive_investors i
                JOIN dilutive_close_reasons r ON r.code = i.close_reason_code
                GROUP BY r.code, r.label, r.reason_group, r.excludes_reporting, r.sort_order
                ORDER BY r.sort_order
                """
            )
            rows = [dict(r) for r in cur.fetchall()]

            groups = {}
            for g in ("revisit", "lost"):
                items = [r for r in rows if r["reason_group"] == g and not r["excludes_reporting"]]
                groups[g] = {
                    "label": CLOSE_GROUP_STYLE[g]["label"],
                    "fill": CLOSE_GROUP_STYLE[g]["fill"],
                    "text_color": CLOSE_GROUP_STYLE[g]["text"],
                    "total": sum(r["n"] for r in items),
                    "due_now": sum(r["due_now"] for r in items),
                    "reasons": [
                        {"code": r["code"], "label": r["label"], "count": r["n"],
                         "due_now": r["due_now"]}
                        for r in items
                    ],
                }

            excluded = [r for r in rows if r["excludes_reporting"]]

            # Ended, but before the reason field existed. Named rather than
            # dropped, so the breakdown adds up to what the board shows.
            cur.execute(
                """SELECT count(*) AS n FROM dilutive_investors
                   WHERE pipeline_stage IN ('Closed Lost', 'Nurture')
                     AND close_reason_code IS NULL"""
            )
            uncategorised = cur.fetchone()["n"]

            return {
                "groups": groups,
                "total": groups["revisit"]["total"] + groups["lost"]["total"],
                "uncategorised": uncategorised,
                "excluded_from_reporting": {
                    "total": sum(r["n"] for r in excluded),
                    "reasons": [{"code": r["code"], "label": r["label"], "count": r["n"]}
                                for r in excluded],
                },
            }
    finally:
        conn.close()


@router.get("/statuses")
def list_statuses():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT s.id, s.name, s.color, s.sort_order,
                       COUNT(i.investor_id) AS investor_count
                FROM dilutive_statuses s
                LEFT JOIN dilutive_investors i ON i.status = s.name
                GROUP BY s.id, s.name, s.color, s.sort_order
                ORDER BY s.sort_order, s.id
            """)
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/statuses", status_code=201)
def create_status(body: dict):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    color = (body.get("color") or "gray").strip()
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "INSERT INTO dilutive_statuses (name, color, sort_order) "
                "VALUES (%s, %s, (SELECT COALESCE(MAX(sort_order),0)+10 FROM dilutive_statuses)) "
                "RETURNING id, name, color, sort_order",
                (name, color),
            )
            row = dict(cur.fetchone())
            conn.commit()
            return row
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=409, detail=str(e))
    finally:
        conn.close()


@router.patch("/statuses/{status_id}")
def update_status(status_id: int, body: dict):
    allowed = {"name", "color", "sort_order"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE dilutive_statuses SET {set_clause} WHERE id = %s",
                list(updates.values()) + [status_id],
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Status not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/statuses/{status_id}", status_code=204)
def delete_status(status_id: int, reassign_to: Optional[str] = Query(None)):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT name FROM dilutive_statuses WHERE id = %s", (status_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Status not found")
            old_name = row["name"]
            # Reassign investors using this status. Without a target they are
            # left blank rather than forced onto some other status.
            new_status = reassign_to or None
            cur.execute(
                "UPDATE dilutive_investors SET status = %s WHERE status = %s",
                (new_status, old_name),
            )
            cur.execute("DELETE FROM dilutive_statuses WHERE id = %s", (status_id,))
            conn.commit()
    finally:
        conn.close()


# ── Investor Types CRUD ─────────────────────────────────────────────────────────

@router.get("/investor-types")
def list_investor_types():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT t.id, t.name, t.color, t.sort_order,
                       COUNT(i.investor_id) AS investor_count
                FROM dilutive_investor_types t
                LEFT JOIN dilutive_investors i ON i.investor_type = t.name
                GROUP BY t.id, t.name, t.color, t.sort_order
                ORDER BY t.sort_order, t.id
            """)
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/investor-types", status_code=201)
def create_investor_type(body: dict):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    color = (body.get("color") or "gray").strip()
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "INSERT INTO dilutive_investor_types (name, color, sort_order) "
                "VALUES (%s, %s, (SELECT COALESCE(MAX(sort_order),0)+10 FROM dilutive_investor_types)) "
                "RETURNING id, name, color, sort_order",
                (name, color),
            )
            row = dict(cur.fetchone())
            conn.commit()
            return row
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=409, detail=str(e))
    finally:
        conn.close()


@router.patch("/investor-types/{type_id}")
def update_investor_type(type_id: int, body: dict):
    allowed = {"name", "color", "sort_order"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE dilutive_investor_types SET {set_clause} WHERE id = %s",
                list(updates.values()) + [type_id],
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Investor type not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/investor-types/{type_id}", status_code=204)
def delete_investor_type(type_id: int, reassign_to: Optional[str] = Query(None)):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT name FROM dilutive_investor_types WHERE id = %s", (type_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Investor type not found")
            old_name = row["name"]
            new_type = reassign_to or None
            cur.execute(
                "UPDATE dilutive_investors SET investor_type = %s WHERE investor_type = %s",
                (new_type, old_name),
            )
            cur.execute("DELETE FROM dilutive_investor_types WHERE id = %s", (type_id,))
            conn.commit()
    finally:
        conn.close()


# ── Focus Options CRUD ───────────────────────────────────────────────────────────

@router.get("/focus-options")
def list_focus_options():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT id, name, color, sort_order
                FROM dilutive_focus_options
                ORDER BY sort_order, id
            """)
            options = [dict(r) for r in cur.fetchall()]
            cur.execute(
                "SELECT focus FROM dilutive_investors WHERE focus IS NOT NULL AND focus != ''"
            )
            counts: dict = {}
            for r in cur.fetchall():
                for token in re.split(r"[,;&]", r["focus"] or ""):
                    token = token.strip()
                    if token:
                        counts[token.lower()] = counts.get(token.lower(), 0) + 1
            for o in options:
                o["investor_count"] = counts.get(o["name"].lower(), 0)
            return options
    finally:
        conn.close()


@router.post("/focus-options", status_code=201)
def create_focus_option(body: dict):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    color = (body.get("color") or "gray").strip()
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "INSERT INTO dilutive_focus_options (name, color, sort_order) "
                "VALUES (%s, %s, (SELECT COALESCE(MAX(sort_order),0)+10 FROM dilutive_focus_options)) "
                "RETURNING id, name, color, sort_order",
                (name, color),
            )
            row = dict(cur.fetchone())
            conn.commit()
            return row
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=409, detail=str(e))
    finally:
        conn.close()


@router.patch("/focus-options/{option_id}")
def update_focus_option(option_id: int, body: dict):
    allowed = {"name", "color", "sort_order"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE dilutive_focus_options SET {set_clause} WHERE id = %s",
                list(updates.values()) + [option_id],
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Focus option not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/focus-options/{option_id}", status_code=204)
def delete_focus_option(option_id: int):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT name FROM dilutive_focus_options WHERE id = %s", (option_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Focus option not found")
            old_name = row["name"].strip().lower()

            cur.execute(
                "SELECT investor_id, focus FROM dilutive_investors WHERE focus ILIKE %s",
                (f"%{row['name']}%",)
            )
            for r in cur.fetchall():
                tokens = [t.strip() for t in re.split(r"[,;&]", r["focus"] or "") if t.strip()]
                kept = [t for t in tokens if t.strip().lower() != old_name]
                if len(kept) != len(tokens):
                    cur.execute(
                        "UPDATE dilutive_investors SET focus = %s WHERE investor_id = %s",
                        (", ".join(kept) or None, r["investor_id"]),
                    )

            cur.execute("DELETE FROM dilutive_focus_options WHERE id = %s", (option_id,))
            conn.commit()
    finally:
        conn.close()


# ── Stage Options CRUD (multi-value, comma-joined on dilutive_investors.investment_stage) ──

@router.get("/stage-options")
def list_stage_options():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT id, name, color, sort_order
                FROM dilutive_stage_options
                ORDER BY sort_order, id
            """)
            options = [dict(r) for r in cur.fetchall()]
            cur.execute(
                "SELECT investment_stage FROM dilutive_investors "
                "WHERE investment_stage IS NOT NULL AND investment_stage != ''"
            )
            counts: dict = {}
            for r in cur.fetchall():
                for token in re.split(r"[,;]", r["investment_stage"] or ""):
                    token = token.strip()
                    if token:
                        counts[token.lower()] = counts.get(token.lower(), 0) + 1
            for o in options:
                o["investor_count"] = counts.get(o["name"].lower(), 0)
            return options
    finally:
        conn.close()


@router.post("/stage-options", status_code=201)
def create_stage_option(body: dict):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    color = (body.get("color") or "gray").strip()
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "INSERT INTO dilutive_stage_options (name, color, sort_order) "
                "VALUES (%s, %s, (SELECT COALESCE(MAX(sort_order),0)+10 FROM dilutive_stage_options)) "
                "RETURNING id, name, color, sort_order",
                (name, color),
            )
            row = dict(cur.fetchone())
            conn.commit()
            return row
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=409, detail=str(e))
    finally:
        conn.close()


@router.patch("/stage-options/{option_id}")
def update_stage_option(option_id: int, body: dict):
    allowed = {"name", "color", "sort_order"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE dilutive_stage_options SET {set_clause} WHERE id = %s",
                list(updates.values()) + [option_id],
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Stage option not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/stage-options/{option_id}", status_code=204)
def delete_stage_option(option_id: int):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT name FROM dilutive_stage_options WHERE id = %s", (option_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Stage option not found")
            old_name = row["name"].strip().lower()

            cur.execute(
                "SELECT investor_id, investment_stage FROM dilutive_investors "
                "WHERE investment_stage ILIKE %s", (f"%{row['name']}%",)
            )
            for r in cur.fetchall():
                tokens = [t.strip() for t in re.split(r"[,;]", r["investment_stage"] or "") if t.strip()]
                kept = [t for t in tokens if t.strip().lower() != old_name]
                if len(kept) != len(tokens):
                    cur.execute(
                        "UPDATE dilutive_investors SET investment_stage = %s WHERE investor_id = %s",
                        (", ".join(kept) or None, r["investor_id"]),
                    )

            cur.execute("DELETE FROM dilutive_stage_options WHERE id = %s", (option_id,))
            conn.commit()
    finally:
        conn.close()


# ── Facets (distinct values for filter dropdowns) ─────────────────────────────

_GEO_ALIASES: dict = {
    # English shorthand → canonical country name
    "us": "United States", "usa": "United States", "u.s.": "United States",
    "u.s.a.": "United States", "united states of america": "United States",
    "uk": "United Kingdom", "gb": "United Kingdom", "great britain": "United Kingdom",
    "england": "United Kingdom", "scotland": "United Kingdom", "wales": "United Kingdom",
    "uae": "United Arab Emirates", "eu": "European Union",
    "ca": "Canada",  # will be overridden by state check below
    "au": "Australia", "nz": "New Zealand", "sg": "Singapore",
    "de": "Germany", "fr": "France", "nl": "Netherlands", "ch": "Switzerland",
    "se": "Sweden", "no": "Norway", "dk": "Denmark", "fi": "Finland",
    "il": "Israel", "in": "India", "cn": "China", "jp": "Japan",
    "kr": "South Korea", "br": "Brazil",
}

# US states (abbrev → country)
_US_STATES = {
    "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia",
    "ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj",
    "nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt",
    "va","wa","wv","wi","wy","dc",
}

# Canadian provinces (abbrev → country)
_CA_PROVINCES = {"ab","bc","mb","nb","nl","ns","nt","nu","on","pe","qc","sk","yt"}


def _apply_assigned_to_filter(assigned_to: Optional[str], filters: list, params: list) -> None:
    """Filter by investor owner. Accepts a comma-separated list of user ids plus
    the sentinel 'none' for unassigned records, so "mine or unowned" is one
    query. Unparseable ids are dropped rather than reaching the uuid cast."""
    if not assigned_to:
        return
    vals = [v.strip() for v in assigned_to.split(",") if v.strip()]
    want_unassigned = "none" in vals
    uids = []
    for v in vals:
        if v == "none":
            continue
        try:
            uids.append(str(uuid.UUID(v)))
        except (ValueError, AttributeError, TypeError):
            continue
    clauses = []
    if uids:
        clauses.append("assigned_to = ANY(%s::uuid[])")
        params.append(uids)
    if want_unassigned:
        clauses.append("assigned_to IS NULL")
    if clauses:
        filters.append("(" + " OR ".join(clauses) + ")")


def _normalize_geo(raw: str) -> str:
    """Normalize a single geo token to a canonical country/region name."""
    s = raw.strip()
    key = s.lower()
    if key in _GEO_ALIASES:
        return _GEO_ALIASES[key]
    # "City, ST" or "City, Province" pattern
    if "," in s:
        parts = [p.strip() for p in s.split(",")]
        # Last part might be a state/province abbrev
        suffix = parts[-1].lower()
        if suffix in _US_STATES:
            return "United States"
        if suffix in _CA_PROVINCES:
            return "Canada"
        # Last part might itself be a country
        if suffix in _GEO_ALIASES:
            return _GEO_ALIASES[suffix]
        # Return last meaningful part title-cased (likely the country)
        return parts[-1].strip().title()
    return s.title() if s.isupper() and len(s) <= 3 else s


def _split_normalize_geo(raw: str) -> list:
    """Split a compound geo string (e.g. 'US, Canada' or 'USA/Canada') and normalize each part."""
    parts = re.split(r"[,;/|]", raw)
    seen = set()
    result = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        canonical = _normalize_geo(p)
        key = canonical.lower()
        if key not in seen:
            seen.add(key)
            result.append(canonical)
    return result


def _split_normalize_focus(raw: str) -> list:
    """Split compound focus values, title-case each part, deduplicate case-insensitively."""
    parts = re.split(r"[,;&]", raw)
    seen = set()
    result = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        key = p.lower()
        if key not in seen:
            seen.add(key)
            result.append(p.title())
    return result


@router.get("/facets")
def get_facets():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            facets: dict = {}

            # firm_type, investor_type and status — return raw unique values
            for col in ("firm_type", "investor_type", "status"):
                cur.execute(
                    f"SELECT {col} as val, COUNT(*) as n FROM dilutive_investors "
                    f"WHERE {col} IS NOT NULL AND {col} != '' "
                    f"GROUP BY {col} ORDER BY n DESC"
                )
                facets[col] = [r["val"] for r in cur.fetchall()]

            # hq — normalize to country level
            cur.execute(
                "SELECT hq as val FROM dilutive_investors WHERE hq IS NOT NULL AND hq != ''"
            )
            hq_counts: dict = {}
            for r in cur.fetchall():
                canonical = _normalize_geo(r["val"])
                hq_counts[canonical] = hq_counts.get(canonical, 0) + 1
            facets["hq"] = sorted(hq_counts.keys(), key=lambda k: -hq_counts[k])

            # geo_focus — split compound values, normalize each part
            cur.execute(
                "SELECT geo_focus as val FROM dilutive_investors WHERE geo_focus IS NOT NULL AND geo_focus != ''"
            )
            geo_counts: dict = {}
            for r in cur.fetchall():
                for part in _split_normalize_geo(r["val"]):
                    geo_counts[part] = geo_counts.get(part, 0) + 1
            facets["geo_focus"] = sorted(geo_counts.keys(), key=lambda k: -geo_counts[k])

            # focus — split compound values, deduplicate case-insensitively
            cur.execute(
                "SELECT focus as val FROM dilutive_investors WHERE focus IS NOT NULL AND focus != ''"
            )
            focus_seen: dict = {}  # lowercase → preferred casing (first seen)
            focus_counts: dict = {}
            for r in cur.fetchall():
                for part in _split_normalize_focus(r["val"]):
                    key = part.lower()
                    if key not in focus_seen:
                        focus_seen[key] = part
                    focus_counts[key] = focus_counts.get(key, 0) + 1
            facets["focus"] = [focus_seen[k] for k in sorted(focus_counts, key=lambda k: -focus_counts[k])]

            # investment_stage: split by comma, deduplicate case-insensitively
            cur.execute(
                "SELECT TRIM(stage) as val FROM dilutive_investors, "
                "UNNEST(STRING_TO_ARRAY(investment_stage, ',')) AS stage "
                "WHERE investment_stage IS NOT NULL"
            )
            stage_seen: dict = {}
            stage_counts: dict = {}
            for r in cur.fetchall():
                v = (r["val"] or "").strip()
                if not v:
                    continue
                key = v.lower()
                if key not in stage_seen:
                    stage_seen[key] = v
                stage_counts[key] = stage_counts.get(key, 0) + 1
            facets["investment_stage"] = [stage_seen[k] for k in sorted(stage_counts, key=lambda k: -stage_counts[k])]

            return facets
    finally:
        conn.close()


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("")
def list_investors(
    search: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    focus: Optional[str] = Query(None),
    firm_type: Optional[str] = Query(None),
    investor_type: Optional[str] = Query(None),
    hq: Optional[str] = Query(None),
    stage: Optional[str] = Query(None),
    geo_focus: Optional[str] = Query(None),
    tier: Optional[str] = Query(None),
    assigned_to: Optional[str] = Query(None),
    priority_only: bool = Query(False),
    enriched: Optional[str] = Query(None),
    pipeline_stage: Optional[str] = Query(None),
    # The kanban board is unpaginated — it pulls the whole (filtered) set in one
    # request so every column is complete, hence the high ceiling.
    limit: int = Query(100, ge=1, le=5000),
    offset: int = Query(0, ge=0),
):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            filters: list[str] = []
            params: list = []

            if search:
                filters.append(
                    "(name ILIKE %s OR firm ILIKE %s OR notes ILIKE %s "
                    "OR intro_notes ILIKE %s OR focus ILIKE %s "
                    "OR hq ILIKE %s OR geo_focus ILIKE %s OR description ILIKE %s "
                    "OR investment_stage ILIKE %s OR firm_type ILIKE %s)"
                )
                s = f"%{search}%"
                params.extend([s] * 10)
            if status:
                vals = [v.strip() for v in status.split(",") if v.strip()]
                filters.append("status = ANY(%s)")
                params.append(vals)
            if focus:
                vals = [v.strip() for v in focus.split(",") if v.strip()]
                focus_clauses = " OR ".join("focus ILIKE %s" for _ in vals)
                filters.append(f"({focus_clauses})")
                params.extend(f"%{v}%" for v in vals)
            if firm_type:
                vals = [v.strip() for v in firm_type.split(",") if v.strip()]
                filters.append("firm_type = ANY(%s)")
                params.append(vals)
            if investor_type:
                vals = [v.strip() for v in investor_type.split(",") if v.strip()]
                filters.append("investor_type = ANY(%s)")
                params.append(vals)
            if hq:
                vals = [v.strip() for v in hq.split(",") if v.strip()]
                hq_clauses = " OR ".join("hq ILIKE %s" for _ in vals)
                filters.append(f"({hq_clauses})")
                params.extend(f"%{v}%" for v in vals)
            if stage:
                vals = [v.strip() for v in stage.split(",") if v.strip()]
                stage_clauses = " OR ".join("investment_stage ILIKE %s" for _ in vals)
                filters.append(f"({stage_clauses})")
                params.extend(f"%{v}%" for v in vals)
            if geo_focus:
                vals = [v.strip() for v in geo_focus.split(",") if v.strip()]
                geo_clauses = " OR ".join("geo_focus ILIKE %s" for _ in vals)
                filters.append(f"({geo_clauses})")
                params.extend(f"%{v}%" for v in vals)
            if tier:
                vals = [v.strip() for v in tier.split(",") if v.strip()]
                filters.append("tier = ANY(%s)")
                params.append(vals)
            _apply_assigned_to_filter(assigned_to, filters, params)
            if priority_only:
                filters.append("is_priority = TRUE")
            if pipeline_stage:
                vals = [v.strip() for v in pipeline_stage.split(",") if v.strip()]
                filters.append("pipeline_stage = ANY(%s)")
                params.append(vals)
            if enriched == "enriched":
                filters.append("enriched_fields IS NOT NULL AND array_length(enriched_fields, 1) > 0")
            elif enriched == "unenriched":
                filters.append("(enriched_fields IS NULL OR array_length(enriched_fields, 1) IS NULL)")

            where = ("WHERE " + " AND ".join(filters)) if filters else ""

            # Total count for pagination
            cur.execute(f"SELECT COUNT(*) FROM dilutive_investors {where}", params)
            total = cur.fetchone()["count"]

            cur.execute(f"""
                SELECT
                    investor_id, status, name, role, firm, firm_type, investor_type,
                    intro_type, intro_notes, email, notes,
                    office_phone, cell_phone, tags, funding_type,
                    avg_check_size, source_link,
                    hq, address, geo_focus, investment_stage, focus,
                    fund_size, fund_launch_year, website, linkedin,
                    portfolio_url, partners, description,
                    check_size_min, check_size_max,
                    portfolio, enriched_fields,
                    score_focus, score_stage, score_check, score_geo, score_portfolio,
                    total_score, tier, enrichment_notes, is_priority,
                    pipeline_stage, closed_lost_reason, stage_entered_at,
                    outreach_channel,
                    -- Last communication, for the "3d ago ↓" marker on the card.
                    (SELECT m.occurred_at FROM comm_messages m
                      WHERE m.entity_type = 'investor' AND m.entity_id = dilutive_investors.investor_id
                      ORDER BY m.occurred_at DESC LIMIT 1) AS last_comm_at,
                    (SELECT m.direction FROM comm_messages m
                      WHERE m.entity_type = 'investor' AND m.entity_id = dilutive_investors.investor_id
                      ORDER BY m.occurred_at DESC LIMIT 1) AS last_comm_direction,
                    (SELECT COUNT(*) FROM scheduled_emails se
                      WHERE se.entity_type = 'investor' AND se.entity_id = dilutive_investors.investor_id
                        AND se.status = 'scheduled') AS scheduled_count,
                    -- Open tasks, so a card can show what is planned and flag
                    -- when nothing is.
                    COALESCE((
                        SELECT json_agg(x ORDER BY x.due_date NULLS LAST, x.created_at)
                        FROM (
                            SELECT t.task_id, t.title, t.due_date, t.created_at
                            FROM tasks t
                            WHERE t.source_ref = dilutive_investors.investor_id::text
                              AND t.status = 'open'
                            LIMIT 5
                        ) x
                    ), '[]'::json) AS open_tasks,
                    linked_project_id, outreach_date,
                    assigned_to,
                    -- Scalar subquery, not a join: the filters above use bare
                    -- column names and joining users would make `name` ambiguous.
                    (SELECT COALESCE(u.full_name, u.name, u.email)
                     FROM users u WHERE u.user_id = dilutive_investors.assigned_to
                    ) AS assigned_to_name,
                    -- Warm intro contacts, resolved here so the detail panel can
                    -- name them straight from the list row.
                    (SELECT COALESCE(json_agg(json_build_object(
                                'contact_id', c.contact_id, 'name', c.name,
                                'email', c.email, 'organization', c.organization)
                              ORDER BY ic.created_at), '[]'::json)
                     FROM dilutive_investor_intro_contacts ic
                     JOIN contacts c ON c.contact_id = ic.contact_id
                     WHERE ic.investor_id = dilutive_investors.investor_id
                    ) AS intro_contacts,
                    created_at, updated_at
                FROM dilutive_investors
                {where}
                ORDER BY
                    CASE status
                        WHEN 'Need to Follow Up' THEN 0
                        WHEN 'In Progress'        THEN 1
                        WHEN 'Not Started'        THEN 2
                        WHEN 'Committed'          THEN 3
                        WHEN 'Passed'             THEN 4
                        ELSE 5
                    END,
                    firm ASC NULLS LAST,
                    name ASC NULLS LAST
                LIMIT %s OFFSET %s
            """, params + [limit, offset])
            rows = [dict(r) for r in cur.fetchall()]
            return {"rows": rows, "total": total, "limit": limit, "offset": offset}
    finally:
        conn.close()


# ── Export ────────────────────────────────────────────────────────────────────

@router.get("/export")
def export_investors(
    search: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    focus: Optional[str] = Query(None),
    firm_type: Optional[str] = Query(None),
    investor_type: Optional[str] = Query(None),
    hq: Optional[str] = Query(None),
    stage: Optional[str] = Query(None),
    geo_focus: Optional[str] = Query(None),
    assigned_to: Optional[str] = Query(None),
    priority_only: bool = Query(False),
    enriched: Optional[str] = Query(None),
    pipeline_stage: Optional[str] = Query(None),
):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            filters: list[str] = []
            params: list = []

            if search:
                filters.append(
                    "(name ILIKE %s OR firm ILIKE %s OR notes ILIKE %s "
                    "OR intro_notes ILIKE %s OR focus ILIKE %s "
                    "OR hq ILIKE %s OR geo_focus ILIKE %s OR description ILIKE %s "
                    "OR investment_stage ILIKE %s OR firm_type ILIKE %s)"
                )
                s = f"%{search}%"
                params.extend([s] * 10)
            if status:
                vals = [v.strip() for v in status.split(",") if v.strip()]
                filters.append("status = ANY(%s)")
                params.append(vals)
            if focus:
                vals = [v.strip() for v in focus.split(",") if v.strip()]
                focus_clauses = " OR ".join("focus ILIKE %s" for _ in vals)
                filters.append(f"({focus_clauses})")
                params.extend(f"%{v}%" for v in vals)
            if firm_type:
                vals = [v.strip() for v in firm_type.split(",") if v.strip()]
                filters.append("firm_type = ANY(%s)")
                params.append(vals)
            if investor_type:
                vals = [v.strip() for v in investor_type.split(",") if v.strip()]
                filters.append("investor_type = ANY(%s)")
                params.append(vals)
            if hq:
                vals = [v.strip() for v in hq.split(",") if v.strip()]
                hq_clauses = " OR ".join("hq ILIKE %s" for _ in vals)
                filters.append(f"({hq_clauses})")
                params.extend(f"%{v}%" for v in vals)
            if stage:
                vals = [v.strip() for v in stage.split(",") if v.strip()]
                stage_clauses = " OR ".join("investment_stage ILIKE %s" for _ in vals)
                filters.append(f"({stage_clauses})")
                params.extend(f"%{v}%" for v in vals)
            if geo_focus:
                vals = [v.strip() for v in geo_focus.split(",") if v.strip()]
                geo_clauses = " OR ".join("geo_focus ILIKE %s" for _ in vals)
                filters.append(f"({geo_clauses})")
                params.extend(f"%{v}%" for v in vals)
            _apply_assigned_to_filter(assigned_to, filters, params)
            if priority_only:
                filters.append("is_priority = TRUE")
            if pipeline_stage:
                vals = [v.strip() for v in pipeline_stage.split(",") if v.strip()]
                filters.append("pipeline_stage = ANY(%s)")
                params.append(vals)
            if enriched == "enriched":
                filters.append("enriched_fields IS NOT NULL AND array_length(enriched_fields, 1) > 0")
            elif enriched == "unenriched":
                filters.append("(enriched_fields IS NULL OR array_length(enriched_fields, 1) IS NULL)")

            where = ("WHERE " + " AND ".join(filters)) if filters else ""

            cur.execute(f"""
                SELECT
                    pipeline_stage, closed_lost_reason,
                    status, firm, name, role, firm_type, investor_type,
                    investment_stage, focus, hq, geo_focus,
                    intro_type, intro_notes, email,
                    office_phone, cell_phone,
                    check_size_min, check_size_max,
                    fund_size, fund_launch_year,
                    website, linkedin, portfolio_url,
                    partners, description, notes,
                    created_at, updated_at
                FROM dilutive_investors
                {where}
                ORDER BY
                    CASE status
                        WHEN 'Need to Follow Up' THEN 0
                        WHEN 'In Progress'        THEN 1
                        WHEN 'Not Started'        THEN 2
                        WHEN 'Committed'          THEN 3
                        WHEN 'Passed'             THEN 4
                        ELSE 5
                    END,
                    firm ASC NULLS LAST,
                    name ASC NULLS LAST
            """, params)
            rows = cur.fetchall()

        output = io.StringIO()
        if rows:
            writer = csv.DictWriter(output, fieldnames=rows[0].keys())
            writer.writeheader()
            for row in rows:
                writer.writerow({k: ("" if v is None else str(v)) for k, v in row.items()})

        output.seek(0)
        is_filtered = any([search, status, focus, firm_type, hq, stage, geo_focus])
        filename = "investors_filtered.csv" if is_filtered else "investors.csv"
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    finally:
        conn.close()


# ── Create ────────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_investor(body: dict, request: Request = None):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO dilutive_investors
                    (status, name, role, firm, firm_type, investor_type, intro_type,
                     intro_notes, email, notes, office_phone, cell_phone,
                     tags, funding_type, avg_check_size, source_link,
                     hq, address, geo_focus, investment_stage, focus,
                     fund_size, fund_launch_year, website, linkedin,
                     portfolio_url, partners, description,
                     check_size_min, check_size_max, portfolio, enriched_fields,
                     is_priority, pipeline_stage, assigned_to)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                        %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::uuid)
                RETURNING investor_id
            """, (
                body.get("status") or None,
                body.get("name") or None,
                body.get("role") or None,
                body.get("firm") or None,
                body.get("firm_type") or None,
                body.get("investor_type") or None,
                body.get("intro_type") or None,
                body.get("intro_notes") or None,
                body.get("email") or None,
                body.get("notes") or None,
                body.get("office_phone") or None,
                body.get("cell_phone") or None,
                body.get("tags", []),
                body.get("funding_type") or None,
                body.get("avg_check_size") or None,
                body.get("source_link") or None,
                body.get("hq") or None,
                body.get("address") or None,
                body.get("geo_focus") or None,
                body.get("investment_stage") or None,
                body.get("focus") or None,
                body.get("fund_size") or None,
                body.get("fund_launch_year") or None,
                body.get("website") or None,
                body.get("linkedin") or None,
                body.get("portfolio_url") or None,
                body.get("partners") or None,
                body.get("description") or None,
                body.get("check_size_min") or None,
                body.get("check_size_max") or None,
                body.get("portfolio") or [],
                body.get("enriched_fields") or [],
                bool(body.get("is_priority")),
                body.get("pipeline_stage") if body.get("pipeline_stage") in PIPELINE_STAGES else "Lead",
                # Whoever adds an investor owns it, unless they named someone else.
                body.get("assigned_to") or _actor_id(request),
            ))
            row = cur.fetchone()
            if body.get("email"):
                from app.tasks.comm_sync import ensure_contact_address
                ensure_contact_address(
                    cur, "investor", str(row["investor_id"]),
                    email=body.get("email"), name=body.get("name"),
                    role=body.get("role"), organization=body.get("firm"),
                )
            # Open the history at the pipeline stage the card starts on. Status
            # is not part of the feed, so it is not seeded.
            _record_stage_change(
                cur, row["investor_id"], None,
                body.get("pipeline_stage") if body.get("pipeline_stage") in PIPELINE_STAGES else "Lead",
                _actor_id(request),
            )
            conn.commit()
            return {"investor_id": str(row["investor_id"])}
    finally:
        conn.close()


# ── Link / create grant project ───────────────────────────────────────────────

@router.post("/{investor_id}/link-project", status_code=201)
def link_project_from_investor(investor_id: str):
    """Create a grant project linked to this investor entry, or return existing."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT investor_id, firm, name, funding_type, notes, linked_project_id "
                "FROM dilutive_investors WHERE investor_id = %s",
                (investor_id,),
            )
            inv = cur.fetchone()
            if not inv:
                raise HTTPException(status_code=404, detail="Investor not found")

            if inv["linked_project_id"]:
                cur.execute("SELECT project_id, name FROM projects WHERE project_id = %s", (inv["linked_project_id"],))
                proj = cur.fetchone()
                if proj:
                    return {"project_id": str(proj["project_id"]), "created": False}

            import uuid as _uuid
            new_id = str(_uuid.uuid4())
            title = inv["firm"] or inv["name"] or "Investor Project"
            cur.execute("""
                INSERT INTO projects
                    (project_id, name, project_type, stage, status, notes, linked_investor_id)
                VALUES (%s, %s, 'grant', 'Identified', 'in_progress', %s, %s)
            """, (new_id, title, inv["notes"], investor_id))
            cur.execute(
                "UPDATE dilutive_investors SET linked_project_id = %s WHERE investor_id = %s",
                (new_id, investor_id),
            )
            conn.commit()
            return {"project_id": new_id, "created": True}
    finally:
        conn.close()


# ── Get one ───────────────────────────────────────────────────────────────────

# ── Warm intro contacts ───────────────────────────────────────────────────────
#
# Sub-resources rather than an array field on PATCH: two people adding different
# names at the same time should both stick, which a whole-array replace would
# quietly undo. Attach-only — a warm intro comes from somebody already in the
# contact book, so there is no create-a-person path here.

@router.post("/{investor_id}/intro-contacts", status_code=201)
def add_intro_contact(investor_id: str, body: dict):
    contact_id = (body or {}).get("contact_id")
    if not contact_id:
        raise HTTPException(status_code=400, detail="contact_id is required")

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT 1 FROM dilutive_investors WHERE investor_id = %s", (investor_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Investor not found")

            cur.execute(
                "SELECT contact_id, name, email, organization FROM contacts WHERE contact_id = %s",
                (contact_id,),
            )
            contact = cur.fetchone()
            if not contact:
                raise HTTPException(status_code=404, detail="Contact not found")

            # Already attached is the state the caller asked for, not a clash.
            cur.execute(
                """INSERT INTO dilutive_investor_intro_contacts (investor_id, contact_id)
                   VALUES (%s, %s) ON CONFLICT DO NOTHING""",
                (investor_id, contact_id),
            )
            conn.commit()
            return dict(contact)
    finally:
        conn.close()


@router.delete("/{investor_id}/intro-contacts/{contact_id}", status_code=204)
def remove_intro_contact(investor_id: str, contact_id: str):
    """Detaching only drops the link — the contact record itself is untouched."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """DELETE FROM dilutive_investor_intro_contacts
                   WHERE investor_id = %s AND contact_id = %s""",
                (investor_id, contact_id),
            )
            conn.commit()
    finally:
        conn.close()


@router.get("/{investor_id}")
def get_investor(investor_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT i.*,
                       (SELECT COALESCE(u.full_name, u.name, u.email)
                        FROM users u WHERE u.user_id = i.assigned_to) AS assigned_to_name,
   (SELECT COALESCE(json_agg(json_build_object(
                                'contact_id', c.contact_id, 'name', c.name,
                                'email', c.email, 'organization', c.organization)
                              ORDER BY ic.created_at), '[]'::json)
                     FROM dilutive_investor_intro_contacts ic
                     JOIN contacts c ON c.contact_id = ic.contact_id
                     WHERE ic.investor_id = i.investor_id
                    ) AS intro_contacts
                FROM dilutive_investors i WHERE i.investor_id = %s
                """,
                (investor_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Investor not found")
            return dict(row)
    finally:
        conn.close()


# ── History: status changes, outreach, logged activities ──────────────────────



def _sort_key(v):
    """Order dates and timestamps together without comparing naive to aware
    datetimes: compare the calendar day first, then the time within it."""
    if v is None:
        return (datetime.date.min, 0.0)
    if isinstance(v, datetime.datetime):
        return (v.date(), v.hour * 3600 + v.minute * 60 + v.second + v.microsecond / 1e6)
    return (v, 0.0)


def _iso(v):
    return v.isoformat() if v is not None and hasattr(v, "isoformat") else v


@router.get("/{investor_id}/history")
def get_investor_history(investor_id: str):
    """One reverse-chronological feed for the investor: status changes, the
    first-outreach stamp, auto-generated follow-up tasks, and logged
    activities. Newest first."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT outreach_date, linked_project_id FROM dilutive_investors WHERE investor_id = %s",
                (investor_id,),
            )
            inv = cur.fetchone()
            if not inv:
                raise HTTPException(status_code=404, detail="Investor not found")

            entries = []

            cur.execute(
                """
                SELECT h.status_history_id, h.changed_at, h.kind, h.status_from, h.status_to,
                       u.name AS changed_by_name
                FROM dilutive_status_history h
                LEFT JOIN users u ON u.user_id = h.changed_by
                WHERE h.investor_id = %s AND h.kind = 'stage'
                """,
                (investor_id,),
            )
            for r in cur.fetchall():
                entries.append({
                    "kind": r["kind"] or "status",
                    "id": str(r["status_history_id"]),
                    "at": _iso(r["changed_at"]),
                    "status_from": r["status_from"],
                    "status_to": r["status_to"],
                    "actor_name": r["changed_by_name"],
                    "_sort": _sort_key(r["changed_at"]),
                })

            if inv["outreach_date"]:
                entries.append({
                    "kind": "outreach",
                    "id": "outreach",
                    "at": _iso(inv["outreach_date"]),
                    "_sort": _sort_key(inv["outreach_date"]),
                })

            cur.execute(
                """
                SELECT a.activity_id, a.activity_date, a.title, a.description,
                       a.owner_id, a.created_at, u.name AS owner_name
                FROM dilutive_activities a
                LEFT JOIN users u ON u.user_id = a.owner_id
                WHERE a.investor_id = %s
                """,
                (investor_id,),
            )
            activities = cur.fetchall()
            for r in activities:
                aid = str(r["activity_id"])
                entries.append({
                    "kind": "activity",
                    "id": aid,
                    "at": _iso(r["activity_date"]),
                    "title": r["title"],
                    "description": r["description"],
                    "owner_id": str(r["owner_id"]) if r["owner_id"] else None,
                    "actor_name": r["owner_name"],
                    # Same-day activities fall back to insertion order.
                    "_sort": (r["activity_date"], _sort_key(r["created_at"])[1]),
                })

            # Threaded notes, attached to whichever entry they annotate. One
            # query for the whole feed rather than one per entry.
            cur.execute(
                """
                SELECT n.note_id, n.entry_kind, n.entry_id, n.body, n.created_at,
                       u.name AS author_name
                FROM dilutive_history_notes n
                LEFT JOIN users u ON u.user_id = n.author_id
                WHERE n.investor_id = %s
                ORDER BY n.created_at
                """,
                (investor_id,),
            )
            notes_by_entry: dict = {}
            for r in cur.fetchall():
                notes_by_entry.setdefault((r["entry_kind"], r["entry_id"]), []).append({
                    "note_id": str(r["note_id"]),
                    "body": r["body"],
                    "author_name": r["author_name"],
                    "created_at": _iso(r["created_at"]),
                })

            entries.sort(key=lambda e: e["_sort"], reverse=True)
            for e in entries:
                e.pop("_sort", None)
                e["notes"] = notes_by_entry.get((e["kind"], e["id"]), [])

            return {
                "outreach_date": _iso(inv["outreach_date"]),
                "linked_project_id": str(inv["linked_project_id"]) if inv["linked_project_id"] else None,
                "entries": entries,
            }
    finally:
        conn.close()


@router.post("/{investor_id}/activities", status_code=201)
def create_activity(investor_id: str, body: dict, request: Request = None):
    title = (body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=422, detail="title is required")

    owner_id = body.get("owner_id") or _actor_id(request)
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT 1 FROM dilutive_investors WHERE investor_id = %s", (investor_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Investor not found")

            cur.execute(
                """
                INSERT INTO dilutive_activities
                    (investor_id, activity_date, owner_id, title, description)
                VALUES (%s, COALESCE(%s::date, CURRENT_DATE), %s::uuid, %s, %s)
                RETURNING activity_id
                """,
                (investor_id, body.get("activity_date") or None, owner_id,
                 title, body.get("description") or None),
            )
            activity_id = cur.fetchone()["activity_id"]
            conn.commit()
        return {"activity_id": str(activity_id)}
    finally:
        conn.close()


ACTIVITY_UPDATABLE = {"activity_date", "owner_id", "title", "description"}


@router.patch("/activities/{activity_id}")
def update_activity(activity_id: str, body: dict):
    updates = {k: v for k, v in body.items() if k in ACTIVITY_UPDATABLE}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")
    if "title" in updates and not (updates["title"] or "").strip():
        raise HTTPException(status_code=422, detail="title cannot be empty")

    set_parts = []
    values = []
    for k, v in updates.items():
        cast = "::uuid" if k == "owner_id" else "::date" if k == "activity_date" else ""
        set_parts.append(f"{k} = %s{cast}")
        values.append(v or None)
    values.append(activity_id)

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE dilutive_activities SET {', '.join(set_parts)}, updated_at = NOW()"
                " WHERE activity_id = %s",
                values,
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Activity not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/activities/{activity_id}", status_code=204)
def delete_activity(activity_id: str):
    """Removes the activity only. Its tasks stay put — they may be live work on
    a project, so they are never deleted behind the user's back."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM dilutive_history_notes WHERE entry_kind = 'activity' AND entry_id = %s",
                (activity_id,),
            )
            cur.execute("DELETE FROM dilutive_activities WHERE activity_id = %s", (activity_id,))
            conn.commit()
        return None
    finally:
        conn.close()


# ── History notes ─────────────────────────────────────────────────────────────

# What the History feed actually shows, and therefore what a note can hang off.
# 'status' and 'follow_up' entries are no longer rendered, so a note written
# against one would be invisible the moment it was saved.
HISTORY_ENTRY_KINDS = ("stage", "outreach", "activity")


@router.post("/{investor_id}/history-notes", status_code=201)
def create_history_note(investor_id: str, body: dict, request: Request = None):
    """Append a note to one entry in the investor's History feed."""
    text = (body.get("body") or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="body is required")
    entry_kind = body.get("entry_kind")
    if entry_kind not in HISTORY_ENTRY_KINDS:
        raise HTTPException(status_code=422, detail=f"entry_kind must be one of {HISTORY_ENTRY_KINDS}")
    entry_id = (body.get("entry_id") or "").strip()
    if not entry_id:
        raise HTTPException(status_code=422, detail="entry_id is required")

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT 1 FROM dilutive_investors WHERE investor_id = %s", (investor_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Investor not found")
            cur.execute(
                """
                INSERT INTO dilutive_history_notes
                    (investor_id, entry_kind, entry_id, body, author_id)
                VALUES (%s, %s, %s, %s, %s::uuid)
                RETURNING note_id
                """,
                (investor_id, entry_kind, entry_id, text, _actor_id(request)),
            )
            note_id = cur.fetchone()["note_id"]
            conn.commit()
        return {"note_id": str(note_id)}
    finally:
        conn.close()


@router.patch("/history-notes/{note_id}")
def update_history_note(note_id: str, body: dict):
    text = (body.get("body") or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="body cannot be empty")
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE dilutive_history_notes SET body = %s, updated_at = NOW() WHERE note_id = %s",
                (text, note_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Note not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/history-notes/{note_id}", status_code=204)
def delete_history_note(note_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM dilutive_history_notes WHERE note_id = %s", (note_id,))
            conn.commit()
        return None
    finally:
        conn.close()


# ── Update ────────────────────────────────────────────────────────────────────

OUTREACH_STATUS = "Awaiting Investor"


def _actor_id(request) -> Optional[str]:
    """The user behind the request, or None. The header is client-supplied, so a
    non-UUID value is dropped rather than passed to a uuid column."""
    raw = request.headers.get("X-User-Id") if request else None
    if not raw:
        return None
    try:
        return str(uuid.UUID(raw))
    except (ValueError, AttributeError, TypeError):
        return None


def _claim_investor_lead(cur, investor_id, user_id) -> None:
    """First person to write to an investor's history becomes its lead.

    Never overwrites: the `assigned_to IS NULL` guard is part of the UPDATE, so
    an investor that already names an owner is untouched even if someone else
    logs the next activity. Concurrent writers race harmlessly — whichever lands
    first wins and the second matches no rows."""
    if not user_id:
        return
    cur.execute(
        "UPDATE dilutive_investors SET assigned_to = %s::uuid, updated_at = NOW()"
        " WHERE investor_id = %s AND assigned_to IS NULL",
        (user_id, investor_id),
    )


def _record_stage_change(cur, investor_id, stage_from, stage_to, changed_by):
    """Append a pipeline stage move to the read-only history. Never updates or
    deletes prior rows. Clearing a stage is not a transition worth logging — the
    table requires a destination.

    Rows live in dilutive_status_history alongside the retired status log; the
    `kind` column separates them and only 'stage' is read."""
    if stage_to is None:
        return
    cur.execute(
        "INSERT INTO dilutive_status_history (investor_id, kind, status_from, status_to, changed_by)"
        " VALUES (%s,'stage',%s,%s,%s)",
        (investor_id, stage_from, stage_to, changed_by),
    )


@router.patch("/{investor_id}")
def update_investor(investor_id: str, body: dict, request: Request = None):
    updates = {k: v for k, v in body.items() if k in UPDATABLE}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    new_status = updates.get("status")

    new_stage = updates.get("pipeline_stage")
    if new_stage is not None and new_stage not in PIPELINE_STAGES:
        raise HTTPException(status_code=422, detail=f"Unknown pipeline_stage: {new_stage}")

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT status, firm, name, pipeline_stage FROM dilutive_investors WHERE investor_id = %s",
                (investor_id,),
            )
            existing = cur.fetchone()
            if not existing:
                raise HTTPException(status_code=404, detail="Investor not found")

            # An ending: the reason decides where the record goes and what else
            # it has to say before it may be saved.
            ending = None
            if updates.get("close_reason_code"):
                ending = _close_reason(cur, updates["close_reason_code"])
                new_stage = CLOSE_GROUP_STAGE[ending["reason_group"]]
                updates["pipeline_stage"] = new_stage
                if ending["reason_group"] == "revisit":
                    # A revisit with no date and no trigger is a loss wearing a
                    # kinder label; both are required before it can be saved.
                    missing = [f for f in ("revisit_date", "revisit_trigger")
                               if not (updates.get(f) or "")]
                    if missing:
                        raise HTTPException(
                            status_code=422,
                            detail=f"{ending['label']} means coming back — {' and '.join(missing).replace('_', ' ')} required.",
                        )
                else:
                    # Nothing to come back to, so no stale plan is left behind.
                    updates["revisit_date"] = None
                    updates["revisit_trigger"] = None

            # Moving back onto a live stage ends the ending: the reason, the
            # revisit plan and the end date go together, so a record reopened
            # and later re-closed never carries a stale label.
            elif new_stage is not None and new_stage not in CLOSED_STAGES:
                for field in ("closed_lost_reason", "close_reason_code",
                              "revisit_date", "revisit_trigger"):
                    updates.setdefault(field, None)

            # Reject an unknown assignee up front — the raw FK violation would
            # otherwise surface as a 500.
            if updates.get("assigned_to"):
                cur.execute("SELECT 1 FROM users WHERE user_id = %s::uuid", (updates["assigned_to"],))
                if not cur.fetchone():
                    raise HTTPException(status_code=422, detail="Unknown user for assigned_to")

            stamp_outreach = (
                new_status == OUTREACH_STATUS
                and existing["status"] != OUTREACH_STATUS
            )

            set_parts = []
            values = []
            for k, v in updates.items():
                # outreach_date set via status change uses NOW(); skip it here
                if k == "outreach_date" and stamp_outreach:
                    continue
                set_parts.append(f"{k} = %s")
                values.append(v)

            if stamp_outreach:
                set_parts.append("outreach_date = NOW()")

            if new_stage is not None and new_stage != existing["pipeline_stage"]:
                set_parts.append("stage_entered_at = NOW()")

            # Both endings stamp the day the pipeline stopped for this record;
            # reopening clears it, so end_date always means "currently ended".
            if ending is not None:
                set_parts.append("end_date = NOW()")
            elif new_stage is not None and new_stage not in CLOSED_STAGES:
                set_parts.append("end_date = NULL")

            values.append(investor_id)
            cur.execute(
                f"UPDATE dilutive_investors SET {', '.join(set_parts)}, updated_at = NOW() WHERE investor_id = %s",
                values,
            )

            # A hand-typed contact must become a real contact, or the Gmail
            # sync has nothing to match on and the person stays invisible.
            if {"email", "name", "role"} & set(updates):
                cur.execute(
                    "SELECT firm, name, role, email FROM dilutive_investors WHERE investor_id = %s",
                    (investor_id,),
                )
                now_row = cur.fetchone()
                if now_row and now_row["email"]:
                    from app.tasks.comm_sync import ensure_contact_address
                    ensure_contact_address(
                        cur, "investor", investor_id,
                        email=now_row["email"], name=now_row["name"],
                        role=now_row["role"], organization=now_row["firm"],
                    )

            actor_id = _actor_id(request)

            # Status transitions are neither logged nor do they claim ownership.
            # The feed tracks pipeline stage, and so does the investor lead:
            # ownership follows pipeline moves and starring, nothing else.
            #
            # Kanban drags across columns land here.
            if new_stage is not None and new_stage != existing["pipeline_stage"]:
                _record_stage_change(
                    cur, investor_id, existing["pipeline_stage"], new_stage, actor_id,
                )
                if "assigned_to" not in updates:
                    _claim_investor_lead(cur, investor_id, actor_id)

            # Outreach used to spawn a "Follow up with X" task due in 7 days.
            # That produced a queue of generic nags nobody closed — 20 of the 22
            # were overdue and 8 had already been actioned. The board now flags
            # an investor with nothing planned instead, and a real follow-up is
            # either a task someone wrote or a scheduled email that cancels
            # itself on a reply. outreach_date is still stamped; only the task
            # generation is gone.

            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/{investor_id}/priority")
def toggle_priority(investor_id: str, body: dict = None, request: Request = None):
    """Set or toggle is_priority. Body: {"is_priority": true/false} or omit to toggle.

    Starring is a pipeline action: it moves an un-worked record onto the board
    and claims it for whoever starred it."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT is_priority, pipeline_stage FROM dilutive_investors WHERE investor_id = %s",
                (investor_id,),
            )
            existing = cur.fetchone()
            if not existing:
                raise HTTPException(status_code=404, detail="Investor not found")

            if body is not None and "is_priority" in body:
                new_val = bool(body["is_priority"])
            else:
                new_val = not existing["is_priority"]

            cur.execute(
                "UPDATE dilutive_investors SET is_priority = %s, updated_at = NOW() WHERE investor_id = %s",
                (new_val, investor_id),
            )

            if new_val:
                actor_id = _actor_id(request)
                # The Priority board has no Lead column, so promoting an
                # untouched record onto it moves it to the first stage that
                # board shows — recorded in History like any other stage move.
                # A record already past Lead keeps its position; starring must
                # never walk someone's progress backwards.
                if existing["pipeline_stage"] == "Lead":
                    cur.execute(
                        "UPDATE dilutive_investors SET pipeline_stage = 'Prospect',"
                        " stage_entered_at = NOW() WHERE investor_id = %s",
                        (investor_id,),
                    )
                    _record_stage_change(cur, investor_id, "Lead", "Prospect", actor_id)
                # Claimed whether or not the stage moved — starring the record
                # is itself taking it on.
                _claim_investor_lead(cur, investor_id, actor_id)

            conn.commit()
        return {"ok": True, "is_priority": new_val}
    finally:
        conn.close()


# ── AI Enrichment ─────────────────────────────────────────────────────────────

@router.post("/{investor_id}/enrich")
def enrich_investor(investor_id: str):
    import anthropic
    import json as _json
    from app.core.agent_config import get_agent_config
    from app.agents.usage_logger import log_anthropic_call

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT name, role, firm, firm_type, hq, geo_focus, investment_stage, "
                "focus, fund_size, website, linkedin, source_link, notes "
                "FROM dilutive_investors WHERE investor_id = %s",
                (investor_id,),
            )
            inv = cur.fetchone()
    finally:
        conn.close()

    if not inv:
        raise HTTPException(status_code=404, detail="Investor not found")

    cfg = get_agent_config("dilutive_enrich")
    model = cfg.get("model") or "claude-haiku-4-5-20251001"
    max_tokens = cfg.get("max_tokens") or 1024
    system_prompt = (
        cfg.get("system_prompt_override")
        or cfg.get("default_system_prompt")
        or _DEFAULT_ENRICH_PROMPT
    )

    user_msg = (
        f"Investor to enrich:\n\n"
        f"Name: {inv['name'] or 'unknown'}\n"
        f"Role: {inv['role'] or 'unknown'}\n"
        f"Firm: {inv['firm'] or 'unknown'}\n"
        f"Current firm_type: {inv['firm_type'] or 'unknown'}\n"
        f"Current HQ: {inv['hq'] or 'unknown'}\n"
        f"Current geo_focus: {inv['geo_focus'] or 'unknown'}\n"
        f"Current investment_stage: {inv['investment_stage'] or 'unknown'}\n"
        f"Current focus: {inv['focus'] or 'unknown'}\n"
        f"Current fund_size: {inv['fund_size'] or 'unknown'}\n"
        f"Website: {inv['website'] or 'none'}\n"
        f"LinkedIn: {inv['linkedin'] or 'none'}\n"
        f"Source link: {inv['source_link'] or 'none'}\n"
        f"Current notes: {inv['notes'] or 'none'}\n"
    )

    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
    try:
        msg = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system_prompt,
            messages=[{"role": "user", "content": user_msg}],
        )
        log_anthropic_call(
            operation="dilutive_enrich",
            model=model,
            input_tokens=msg.usage.input_tokens,
            output_tokens=msg.usage.output_tokens,
        )
    except Exception as exc:
        logger.error("Investor enrichment API call failed: %s", exc)
        raise HTTPException(status_code=502, detail="AI enrichment failed")

    raw = msg.content[0].text.strip()
    if raw.startswith("```"):
        lines = raw.splitlines()
        raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    try:
        result = _json.loads(raw)
    except Exception:
        raise HTTPException(status_code=502, detail="AI returned unparseable response")

    return result


# ── Scoring Rubric ────────────────────────────────────────────────────────────

_DEFAULT_RUBRIC = {
    "focus": {
        "label": "Thesis Fit",
        "description": "How closely does the investor's thesis match the company's sector and stage.",
        "max": 4,
        "levels": {
            "0": "No exposure to the company's sector at all",
            "1": "Generalist — invests across many sectors with no focus on the company's",
            "2": "Adjacent sectors — relevant, but no specific thesis in the company's space",
            "3": "Clear focus on the company's sector — invests in comparable companies",
            "4": "Explicit thesis in the company's niche — this is their primary focus area",
        },
    },
    "stage": {
        "label": "Stage Fit",
        "description": "Does the investor write first checks at the company's current round stage?",
        "max": 4,
        "levels": {
            "0": "Series B+ / growth equity only — does not make first checks before Series A",
            "1": "Primarily Series A–B — occasionally co-invests at seed but rarely leads",
            "2": "Seed to Series A — comfortable at seed but not primarily pre-seed",
            "3": "Pre-seed and seed — this is their primary entry stage",
            "4": "Dedicated pre-seed / seed fund — 50%+ of deals at pre-seed or seed, first-check mandate",
        },
    },
    "check": {
        "label": "Check Size Fit",
        "description": "Does the investor's typical first check fit Open ERP's round ($500K–$3M total raise)?",
        "max": 4,
        "levels": {
            "0": "First check consistently >$5M (too large for our current round) OR angel-only (<$50K)",
            "1": "First check $2M–$5M (would dominate the round) or $50K–$200K (too small to matter)",
            "2": "First check $200K–$500K — can participate as a small check, not a lead",
            "3": "First check $500K–$2M — fits well as a lead or co-lead investor",
            "4": "First check $500K–$2M AND actively leads or syndicates seed rounds in our space",
        },
    },
    "geo": {
        "label": "Geographic Fit",
        "description": "Will this investor back a US-based company? Open ERP is in Chicago. Remote-friendly or US-focused investors score higher.",
        "max": 4,
        "levels": {
            "0": "Strictly invests in a single non-US region with no exceptions (e.g. Southeast Asia only, MENA only)",
            "1": "Predominantly non-US — will occasionally invest globally but North America is not a focus",
            "2": "Global mandate or North America included — no geographic restriction on US companies",
            "3": "Domestic investor with an active portfolio in the company's sector",
            "4": "Domestic, remote-friendly or locally present, and well-networked in the sector",
        },
    },
    "portfolio": {
        "label": "Portfolio Signal",
        "description": "Does the existing portfolio show conviction in the company's space? Signals the investor understands it and has relevant relationships.",
        "max": 4,
        "levels": {
            "0": "No portfolio companies in bio, food, ag, climate, or adjacent spaces",
            "1": "1–2 loosely adjacent companies (e.g. general health, traditional food brands)",
            "2": "3+ companies in adjacent sectors — shows sector interest",
            "3": "Active portfolio in the company's sector — multiple relevant bets",
            "4": "Proven track record in the niche — portfolio exits or marquee bets in the space",
        },
    },
}


_DEFAULT_CRITERIA = {
    "company_stage": "Pre-seed",
    "target_raise_min": 500000,
    "target_raise_max": 3000000,
    "target_stages": ["Pre-seed", "Seed"],
    "target_geo": ["United States", "North America", "Canada"],
    "target_sectors": [],
    "check_target_min": 500000,
    "check_target_max": 2000000,
}


def _ensure_scoring_config(cur) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS dilutive_scoring_config (
            id SERIAL PRIMARY KEY,
            rubric JSONB NOT NULL DEFAULT '{}',
            tier_thresholds JSONB NOT NULL DEFAULT '{"tier1":17,"tier2":13,"tier3":9,"tier4":5}',
            criteria JSONB NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    # migrate: add criteria column if missing
    cur.execute("""
        ALTER TABLE dilutive_scoring_config
        ADD COLUMN IF NOT EXISTS criteria JSONB NOT NULL DEFAULT '{}'
    """)


@router.get("/scoring-rubric")
def get_scoring_rubric():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            _ensure_scoring_config(cur)
            conn.commit()
            cur.execute("SELECT rubric, tier_thresholds, criteria FROM dilutive_scoring_config ORDER BY id LIMIT 1")
            row = cur.fetchone()
            if row:
                return {
                    "rubric": row["rubric"] or _DEFAULT_RUBRIC,
                    "tier_thresholds": row["tier_thresholds"],
                    "criteria": row["criteria"] or _DEFAULT_CRITERIA,
                }
            return {
                "rubric": _DEFAULT_RUBRIC,
                "tier_thresholds": {"tier1": 17, "tier2": 13, "tier3": 9, "tier4": 5},
                "criteria": _DEFAULT_CRITERIA,
            }
    finally:
        conn.close()


@router.put("/scoring-rubric")
def save_scoring_rubric(body: dict):
    rubric = body.get("rubric", _DEFAULT_RUBRIC)
    thresholds = body.get("tier_thresholds", {"tier1": 17, "tier2": 13, "tier3": 9, "tier4": 5})
    criteria = body.get("criteria", _DEFAULT_CRITERIA)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            _ensure_scoring_config(cur)
            cur.execute("SELECT id FROM dilutive_scoring_config ORDER BY id LIMIT 1")
            row = cur.fetchone()
            if row:
                cur.execute(
                    "UPDATE dilutive_scoring_config SET rubric=%s, tier_thresholds=%s, criteria=%s, updated_at=NOW() WHERE id=%s",
                    (psycopg2.extras.Json(rubric), psycopg2.extras.Json(thresholds), psycopg2.extras.Json(criteria), row[0]),
                )
            else:
                cur.execute(
                    "INSERT INTO dilutive_scoring_config (rubric, tier_thresholds, criteria) VALUES (%s, %s, %s)",
                    (psycopg2.extras.Json(rubric), psycopg2.extras.Json(thresholds), psycopg2.extras.Json(criteria)),
                )
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def _parse_money(s) -> Optional[float]:
    """Parse '$500K', '$2M', '500000' → float or None."""
    if not s:
        return None
    s = str(s).upper().replace(",", "").replace("$", "").strip()
    try:
        if s.endswith("M"):
            return float(s[:-1]) * 1_000_000
        if s.endswith("K"):
            return float(s[:-1]) * 1_000
        return float(s)
    except (ValueError, TypeError):
        return None


def _score_investor(inv: dict, criteria: dict) -> dict:
    """
    Rules-based scoring of a single investor dict against criteria.
    Returns {score_focus, score_stage, score_check, score_geo, score_portfolio, total_score, tier}.
    Only scores dimensions where the investor has relevant data.
    """
    target_sectors = [s.lower() for s in (criteria.get("target_sectors") or [])]
    target_stages  = [s.lower() for s in (criteria.get("target_stages") or [])]
    target_geo     = [g.lower() for g in (criteria.get("target_geo") or [])]
    check_min      = _parse_money(criteria.get("check_target_min")) or 0
    check_max      = _parse_money(criteria.get("check_target_max")) or float("inf")

    scores = {}

    # ── Focus score ───────────────────────────────────────────────────────────
    focus_text = ((inv.get("focus") or "") + " " + (inv.get("description") or "")).lower()
    if focus_text.strip():
        matches = sum(1 for s in target_sectors if s in focus_text)
        if matches == 0:
            scores["score_focus"] = 0
        elif matches == 1:
            scores["score_focus"] = 1
        elif matches <= 2:
            scores["score_focus"] = 2
        elif matches <= 4:
            scores["score_focus"] = 3
        else:
            scores["score_focus"] = 4

    # ── Stage score ───────────────────────────────────────────────────────────
    stage_text = (inv.get("investment_stage") or "").lower()
    if stage_text:
        stage_matches = sum(1 for t in target_stages if t in stage_text)
        if stage_matches == 0:
            # Check if it's growth-only
            if any(x in stage_text for x in ["series c", "series d", "growth", "late"]):
                scores["score_stage"] = 0
            elif any(x in stage_text for x in ["series b"]):
                scores["score_stage"] = 1
            else:
                scores["score_stage"] = 1
        elif stage_matches == 1:
            scores["score_stage"] = 3
        else:
            scores["score_stage"] = 4

    # ── Check size score ──────────────────────────────────────────────────────
    inv_min = _parse_money(inv.get("check_size_min"))
    inv_max = _parse_money(inv.get("check_size_max"))
    if inv_min is not None or inv_max is not None:
        lo = inv_min or inv_max or 0
        hi = inv_max or inv_min or float("inf")
        # Overlap with target check range
        overlap = min(hi, check_max) - max(lo, check_min)
        if overlap <= 0:
            # No overlap — how far off?
            if lo > check_max * 2:
                scores["score_check"] = 0  # way too big
            elif hi < check_min / 2:
                scores["score_check"] = 0  # way too small
            else:
                scores["score_check"] = 1
        else:
            # Has overlap — how much?
            target_range = check_max - check_min
            pct = overlap / target_range if target_range > 0 else 1.0
            if pct >= 0.8:
                scores["score_check"] = 4
            elif pct >= 0.5:
                scores["score_check"] = 3
            else:
                scores["score_check"] = 2

    # ── Geo score ─────────────────────────────────────────────────────────────
    geo_text = ((inv.get("geo_focus") or "") + " " + (inv.get("hq") or "")).lower()
    if geo_text.strip():
        geo_matches = sum(1 for g in target_geo if g in geo_text)
        if geo_matches == 0:
            scores["score_geo"] = 1 if "global" in geo_text or "worldwide" in geo_text else 0
        elif geo_matches == 1:
            scores["score_geo"] = 3
        else:
            scores["score_geo"] = 4

    # ── Portfolio score — keep existing (set by AI enrichment) ───────────────
    # Do NOT overwrite portfolio score here — it requires AI assessment.
    # Only recalculate total_score and tier if portfolio was already set.

    return scores


@router.post("/rescore")
def rescore_all():
    """
    Re-score all investors using rules-based scoring against saved criteria.
    Portfolio scores (score_portfolio) are preserved — they require AI assessment.
    Only investors with at least some enriched data (focus, stage, or check_size) get scored.
    """
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            _ensure_scoring_config(cur)
            conn.commit()

            cur.execute("SELECT tier_thresholds, criteria FROM dilutive_scoring_config ORDER BY id LIMIT 1")
            row = cur.fetchone()
            thresholds = row["tier_thresholds"] if row else {"tier1": 17, "tier2": 13, "tier3": 9, "tier4": 5}
            criteria = (row["criteria"] if row else {}) or _DEFAULT_CRITERIA
            t1, t2, t3, t4 = thresholds["tier1"], thresholds["tier2"], thresholds["tier3"], thresholds["tier4"]

            # Load all investors with any scoreable data
            cur.execute("""
                SELECT investor_id, focus, description, investment_stage,
                       check_size_min, check_size_max, geo_focus, hq, score_portfolio
                FROM dilutive_investors
                WHERE focus IS NOT NULL OR investment_stage IS NOT NULL
                   OR check_size_min IS NOT NULL OR hq IS NOT NULL
            """)
            investors = cur.fetchall()

        updated = 0
        conn2 = get_conn()
        try:
            with conn2.cursor() as cur2:
                for inv in investors:
                    scores = _score_investor(dict(inv), criteria)
                    if not scores:
                        continue

                    # Preserve existing portfolio score
                    score_portfolio = inv["score_portfolio"] or 0
                    total = (
                        scores.get("score_focus", 0) +
                        scores.get("score_stage", 0) +
                        scores.get("score_check", 0) +
                        scores.get("score_geo", 0) +
                        score_portfolio
                    )

                    if total >= t1:
                        tier = "Tier 1 — Strong Fit"
                    elif total >= t2:
                        tier = "Tier 2 — Good Fit"
                    elif total >= t3:
                        tier = "Tier 3 — Possible Fit"
                    elif total >= t4:
                        tier = "Tier 4 — Weak Fit"
                    else:
                        tier = "Tier 5 — No Fit"

                    set_parts = ["total_score = %s", "tier = %s", "updated_at = NOW()"]
                    vals = [total, tier]
                    for dim in ("score_focus", "score_stage", "score_check", "score_geo"):
                        if dim in scores:
                            set_parts.append(f"{dim} = %s")
                            vals.append(scores[dim])

                    vals.append(str(inv["investor_id"]))
                    cur2.execute(
                        f"UPDATE dilutive_investors SET {', '.join(set_parts)} WHERE investor_id = %s",
                        vals,
                    )
                    updated += 1
                conn2.commit()
        finally:
            conn2.close()

        return {"updated": updated}
    finally:
        conn.close()


@router.delete("/scores", status_code=200)
def clear_all_scores():
    """Clear all AI-generated scores so investors can be re-scored cleanly."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE dilutive_investors
                SET score_focus = NULL, score_stage = NULL, score_check = NULL,
                    score_geo = NULL, score_portfolio = NULL,
                    total_score = NULL, tier = NULL, updated_at = NOW()
            """)
            cleared = cur.rowcount
            conn.commit()
        return {"cleared": cleared}
    finally:
        conn.close()


@router.get("/enrich-status")
def enrich_status():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    COUNT(*) FILTER (WHERE enriched_fields IS NOT NULL AND array_length(enriched_fields, 1) > 0) AS enriched,
                    COUNT(*) FILTER (WHERE enriched_fields IS NULL OR array_length(enriched_fields, 1) IS NULL) AS pending,
                    COUNT(*) AS total
                FROM dilutive_investors
            """)
            row = cur.fetchone()
            return {"enriched": row[0], "pending": row[1], "total": row[2]}
    finally:
        conn.close()


@router.post("/enrich-batch-v2")
def enrich_batch_v2(body: dict):
    """New enrichment batch using the investor_enrichment_agent (Fundable + Apollo + web_search + scoring)."""
    from app.agents.investor_enrichment_agent import run_enrichment
    max_investors = min(int(body.get("max_investors", 5000)), 5000)
    investor_ids = body.get("investor_ids") or None
    all_investors = bool(body.get("all_investors", False))
    result = run_enrichment(investor_ids=investor_ids, max_investors=max_investors, all_investors=all_investors)
    return result


@router.post("/discover")
def discover_investors(body: dict = None):
    """
    Discover new investors via Fundable filter search.
    Body params (all optional):
      - max_pages: int (default 2, each page ~$0.66, up to 100 results)
      - page_size: int (default 100, max 100)
      - industries: list[str] (Fundable industry permalinks, defaults to Open ERP set)
      - locations: list[str] (Fundable location permalinks, e.g. ['north-america'])
      - min_recent_deals: int (default 1, filters inactive investors)
    """
    from app.agents.investor_discovery_agent import run_discovery
    body = body or {}
    result = run_discovery(
        max_pages=min(int(body.get("max_pages", 2)), 10),
        page_size=min(int(body.get("page_size", 100)), 100),
        industries=body.get("industries") or None,
        locations=body.get("locations") or None,
        min_recent_deals=int(body.get("min_recent_deals", 1)),
    )
    return result


@router.get("/enrichment-runs")
def get_enrichment_runs(investor_id: Optional[str] = Query(None), limit: int = Query(20)):
    """List recent enrichment run traces."""
    from app.agents.investor_enrichment_agent import _ensure_run_table
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            _ensure_run_table(cur)
            conn.commit()
            if investor_id:
                cur.execute(
                    "SELECT id, investor_id, firm, status, credits_used, started_at, finished_at, steps "
                    "FROM dilutive_enrichment_runs WHERE investor_id=%s ORDER BY started_at DESC LIMIT %s",
                    [investor_id, limit],
                )
            else:
                cur.execute(
                    "SELECT id, investor_id, firm, status, credits_used, started_at, finished_at, steps "
                    "FROM dilutive_enrichment_runs ORDER BY started_at DESC LIMIT %s",
                    [limit],
                )
            rows = cur.fetchall()
            return {"runs": [dict(r) for r in rows]}
    finally:
        conn.close()


@router.post("/enrich-batch")
def enrich_batch(body: dict):
    import anthropic
    import json as _json
    from app.core.agent_config import get_agent_config
    from app.agents.usage_logger import log_anthropic_call

    max_investors = min(int(body.get("max_investors", 5)), 50)

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT investor_id, name, role, firm, firm_type, hq, geo_focus,
                       investment_stage, focus, fund_size, website, linkedin,
                       source_link, notes
                FROM dilutive_investors
                WHERE enriched_fields IS NULL OR array_length(enriched_fields, 1) IS NULL
                ORDER BY created_at ASC
                LIMIT %s
            """, (max_investors,))
            investors = cur.fetchall()
    finally:
        conn.close()

    if not investors:
        return {"enriched": 0, "message": "No unenriched investors found"}

    cfg = get_agent_config("dilutive_enrich")
    model = cfg.get("model") or "claude-haiku-4-5-20251001"
    max_tokens = cfg.get("max_tokens") or 1024
    system_prompt = cfg.get("system_prompt_override") or cfg.get("default_system_prompt") or _DEFAULT_ENRICH_PROMPT
    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))

    enriched_count = 0
    errors = []
    for inv in investors:
        user_msg = (
            f"Investor to enrich:\n\n"
            f"Name: {inv['name'] or 'unknown'}\n"
            f"Role: {inv['role'] or 'unknown'}\n"
            f"Firm: {inv['firm'] or 'unknown'}\n"
            f"Current firm_type: {inv['firm_type'] or 'unknown'}\n"
            f"Current HQ: {inv['hq'] or 'unknown'}\n"
            f"Current geo_focus: {inv['geo_focus'] or 'unknown'}\n"
            f"Current investment_stage: {inv['investment_stage'] or 'unknown'}\n"
            f"Current focus: {inv['focus'] or 'unknown'}\n"
            f"Current fund_size: {inv['fund_size'] or 'unknown'}\n"
            f"Website: {inv['website'] or 'none'}\n"
            f"LinkedIn: {inv['linkedin'] or 'none'}\n"
            f"Source link: {inv['source_link'] or 'none'}\n"
            f"Current notes: {inv['notes'] or 'none'}\n"
        )
        try:
            msg = client.messages.create(
                model=model, max_tokens=max_tokens, system=system_prompt,
                messages=[{"role": "user", "content": user_msg}],
            )
            log_anthropic_call(operation="dilutive_enrich", model=model,
                               input_tokens=msg.usage.input_tokens, output_tokens=msg.usage.output_tokens)
            raw = msg.content[0].text.strip()
            if raw.startswith("```"):
                lines = raw.splitlines()
                raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
            result = _json.loads(raw)

            ENRICH_FIELDS = ["firm_type", "hq", "geo_focus", "investment_stage", "focus",
                             "fund_size", "fund_launch_year", "website", "linkedin",
                             "portfolio_url", "partners", "check_size_min", "check_size_max",
                             "description"]
            updates = {k: v for k, v in result.items() if k in ENRICH_FIELDS and v}
            filled = list(updates.keys())
            if filled:
                updates["enriched_fields"] = filled
                if result.get("enrichment_summary"):
                    updates["enrichment_notes"] = result["enrichment_summary"]
                set_clause = ", ".join(f"{k} = %s" for k in updates)
                conn2 = get_conn()
                try:
                    with conn2.cursor() as cur2:
                        cur2.execute(
                            f"UPDATE dilutive_investors SET {set_clause}, updated_at=NOW() WHERE investor_id=%s",
                            list(updates.values()) + [str(inv["investor_id"])],
                        )
                        conn2.commit()
                finally:
                    conn2.close()
            enriched_count += 1
        except Exception as exc:
            errors.append({"investor_id": str(inv["investor_id"]), "firm": inv["firm"], "error": str(exc)})
            logger.warning("Batch enrich failed for %s: %s", inv["investor_id"], exc)

    return {"enriched": enriched_count, "errors": errors}


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{investor_id}", status_code=204)
def delete_investor(investor_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM dilutive_investors WHERE investor_id = %s",
                (investor_id,),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Investor not found")
            # comm_* and scheduled_emails are polymorphic (investor | deal |
            # funding), so no foreign key can reach them. Nine deleted
            # investors had left 7,071 message rows and 1,610 tracked
            # addresses behind, still being matched on by every sync.
            for table in ("comm_messages", "comm_addresses", "scheduled_emails"):
                cur.execute(
                    f"DELETE FROM {table} WHERE entity_type = 'investor' "
                    "AND entity_id = %s",
                    (investor_id,),
                )
            conn.commit()
    finally:
        conn.close()
