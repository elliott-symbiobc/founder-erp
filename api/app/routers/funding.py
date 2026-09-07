"""
funding.py — Funding opportunities endpoints.

GET    /funding                              — list all opportunities (filterable)
GET    /funding/funding-types                — the funding type vocabulary
POST   /funding/funding-types                — add a type
PATCH  /funding/funding-types/{type_id}      — rename / recolour / reorder a type
DELETE /funding/funding-types/{type_id}      — remove a type, reassigning its records
GET    /funding/kb                           — Open ERP Knowledge Base entries
POST   /funding/kb                           — add a knowledge base entry
PATCH  /funding/kb/{entry_id}                — edit an entry
DELETE /funding/kb/{entry_id}                — remove an entry
GET    /funding/{opportunity_id}/notes       — dated note entries, newest first
POST   /funding/{opportunity_id}/notes       — add a note
PATCH  /funding/notes/{note_id}              — edit a note body
DELETE /funding/notes/{note_id}              — remove a note
GET    /funding/{opportunity_id}/history     — stage-move history
GET    /funding/{opportunity_id}/details     — Opportunity Details (1:1, joined on id)
PATCH  /funding/{opportunity_id}/details     — edit the details record
GET    /funding/{opportunity_id}/application — the questions asked and answered
POST   /funding/{opportunity_id}/application — add a question (optionally from the KB)
PATCH  /funding/application/{answer_id}      — edit a question or answer
DELETE /funding/application/{answer_id}      — remove one
POST   /funding/application/{id}/to-kb       — save an answer to the Knowledge Base
GET    /funding/research-platforms           — Opportunity Discovery sources
POST   /funding/research-platforms           — add a source
PATCH  /funding/research-platforms/{id}      — edit a source
DELETE /funding/research-platforms/{id}      — remove a source
GET    /funding/export                       — the filtered view as CSV
POST   /funding/import                       — bulk-load opportunities from CSV
POST   /funding                              — create opportunity
PATCH  /funding/{opportunity_id}             — update fields
DELETE /funding/{opportunity_id}             — delete opportunity
GET    /funding/{opportunity_id}/suggestions — matched emails awaiting review
POST   /funding/suggestions/{id}/accept      — file a suggestion to the timeline
POST   /funding/suggestions/{id}/dismiss     — reject a suggestion for good
POST   /funding/suggestions/{id}/unaccept    — detach an attached email
GET    /funding/suggestions/pending-count    — open suggestions per opportunity
POST   /funding/{opportunity_id}/backfill    — re-scan synced mail for this record
POST   /funding/backfill-all                 — the same sweep across the board

Activity (email timeline, composer, meetings) is served by the entity-generic
/comms router under entity_type 'funding'; see 130_funding_activity.
"""

import csv
import io
import logging
import os
import re
import uuid
from datetime import datetime
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/funding", tags=["funding"])

# "notes" is deliberately absent: the blob became funding_notes entries in 129.
# A PATCH carrying it is ignored rather than silently overwriting the log.
UPDATABLE = {
    "title", "stage", "deadline", "deadline_time", "tags", "funding_type",
    "dilution", "amount", "amount_currency", "amount_notes", "decision_date",
    "funding_dispersion", "source_link", "gcal_event_id",
    "assignee_id", "linked_project_id",
    # Screening properties (134). last_verified is DATE — an empty string must
    # reach the column as NULL, never as text.
    "eligibility", "cost_share_match", "org_fit", "last_verified", "next_action",
}

def _actor_id(request) -> Optional[str]:
    """The user behind the request, or None. The header is client-supplied, so
    a non-UUID value is dropped rather than handed to a uuid column."""
    raw = request.headers.get("X-User-Id") if request else None
    if not raw:
        return None
    try:
        return str(uuid.UUID(raw))
    except (ValueError, AttributeError, TypeError):
        return None


def _claim_unassigned(cur, opportunity_id, user_id) -> bool:
    """Give an ownerless opportunity to whoever is working it.

    Opportunities were the only board that never assigned anything: the investor
    create endpoint has always stamped its actor, this one never did, so 619 of
    630 records had no owner and the column was decoration.

    Two rules, and the second is the one that matters. Creating a record assigns
    it. Doing anything else to a record nobody owns — moving its stage, editing a
    field, writing a note, answering an application question, accepting an email
    — claims it, because that is what working on something means. A record
    already owned is never reassigned: somebody else's name is a decision, and a
    colleague opening the record to read it is not a reason to overwrite it.
    Bulk and automated paths deliberately do not call this; a nightly enrichment
    run has not decided to own anything.
    """
    if not user_id:
        return False
    cur.execute(
        "UPDATE funding_opportunities SET assignee_id = %s, updated_at = NOW() "
        "WHERE opportunity_id = %s AND assignee_id IS NULL",
        (user_id, opportunity_id))
    return bool(cur.rowcount)


OPENERP_FIT_VALUES = ("Tier 1", "Tier 2", "Tier 3", "Unrated")
RECORD_STATUS_VALUES = ("Unenriched", "Enriched (desk)", "Enriched (verified)", "Ineligible")

_DETAIL_UPDATABLE = {
    "record_status", "fit_rationale", "equity_taken", "focus_areas",
    "application_requirements", "program_contact", "sources", "data_gaps",
}

# amount is NUMERIC as of 126_funding_amount; the prose it used to hold lives in
# amount_notes. Currencies actually present in the data, plus the obvious peers.
CURRENCIES = ("USD", "EUR", "GBP", "CHF", "CAD", "AUD", "JPY")

_CURRENCY_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY"}

# funding_type is the instrument, dilution is whether it costs equity. They were
# one free-text column until 125_funding_types split them; see that migration.
DILUTION_VALUES = ("non-dilutive", "dilutive")

_DILUTION_SPELLINGS = {
    "non-dilutive": "non-dilutive", "non dilutive": "non-dilutive",
    "nondilutive":  "non-dilutive", "non_dilutive": "non-dilutive",
    "equity-free":  "non-dilutive", "grant":        "non-dilutive",
    "dilutive":     "dilutive",     "equity":       "dilutive",
    "vc":           "dilutive",
}


def get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _canon_dilution(value) -> Optional[str]:
    """Anything unrecognised becomes NULL — 'unknown' is a real answer here, and
    guessing wrong puts 'non-dilutive' on an accelerator that takes 6%."""
    if not value:
        return None
    return _DILUTION_SPELLINGS.get(str(value).strip().lower())


def _canon_amount(value):
    """A money field that still has to survive prose being typed into it.

    Stripping every non-digit from the whole string is wrong and was:
    "$500,000 total ($125K for 7% + $375K SAFE)" collapses to 50000012577375,
    which overflows NUMERIC(14,2) and kills the whole import. Each figure is
    tokenised separately and the largest is taken as the award ceiling, with
    the original wording preserved in amount_notes.
    """
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return value if abs(value) < 10 ** 12 else None
    text = str(value).strip()
    if not text or re.search(r"https?://", text):
        return None

    best = None
    for tok in re.findall(r"[0-9][0-9,\.]*\s*[kKmM]?", text):
        digits = re.sub(r"[^0-9.]", "", tok)
        if not digits or digits.count(".") > 1:
            continue
        try:
            num = float(digits)
        except ValueError:
            continue
        if re.search(r"[kK]\s*$", tok):
            num *= 1_000
        elif re.search(r"[mM]\s*$", tok):
            num *= 1_000_000
        # "for 7%" is a stake, not an award.
        if num < 100 and "%" in text:
            continue
        if num >= 10 ** 12:      # beyond the column; treat as a parse artefact
            continue
        best = num if best is None or num > best else best
    return best


def _canon_currency(value) -> Optional[str]:
    """Unrecognised input falls back to the column default rather than storing a
    code nothing can price."""
    if not value:
        return None
    text = str(value).strip()
    if text in _CURRENCY_SYMBOLS:
        return _CURRENCY_SYMBOLS[text]
    upper = text.upper()
    return upper if upper in CURRENCIES else None


def _canon_funding_type(cur, value) -> Optional[str]:
    """Resolve a written funding type against the vocabulary.

    Case-insensitive, so 'grant' and 'Grant' are the same row. A value that is
    genuinely new is added to the vocabulary rather than rejected or dropped:
    an import or an enrichment run should never lose a classification, and a
    value that exists on records but not in the table is worse than a spurious
    row — it would be missing from the dropdown and the filter, leaving those
    records untypeable. Same reasoning as 113_investor_type_other.
    """
    if value is None:
        return None
    name = str(value).strip()
    if not name:
        return None
    cur.execute("SELECT name FROM funding_types WHERE lower(name) = lower(%s)", (name,))
    row = cur.fetchone()
    if row:
        return row["name"] if isinstance(row, dict) else row[0]
    cur.execute(
        "INSERT INTO funding_types (name, color, sort_order) VALUES (%s, 'gray', 90) "
        "ON CONFLICT (name) DO NOTHING",
        (name,),
    )
    return name


# ── List ──────────────────────────────────────────────────────────────────────

# Board order, shared by the list and the export so a downloaded CSV comes out
# in the order the user was looking at.
_STAGE_ORDER = """
    CASE fo.stage
        WHEN 'New'         THEN 0
        WHEN 'In Progress' THEN 1
        WHEN 'Applied'     THEN 2
        WHEN 'Won'         THEN 3
        WHEN 'Rejected'    THEN 4
        WHEN 'Withdrawn'   THEN 5
        ELSE 6
    END,
    fo.deadline ASC NULLS LAST,
    fo.title ASC
"""


def _list_filters(search, stage, tags) -> tuple[list[str], list]:
    """WHERE fragments shared by the list and the CSV export."""
    filters: list[str] = []
    params: list = []
    if search:
        filters.append(
            "(fo.title ILIKE %s OR EXISTS (SELECT 1 FROM funding_notes sn "
            "WHERE sn.opportunity_id = fo.opportunity_id AND sn.body ILIKE %s))")
        s = f"%{search}%"
        params.extend([s, s])
    if stage:
        stages = [v.strip() for v in stage.split(",") if v.strip()]
        if stages:
            filters.append("fo.stage = ANY(%s)")
            params.append(stages)
    if tags:
        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
        if tag_list:
            filters.append("fo.tags && %s")
            params.append(tag_list)
    return filters, params


@router.get("")
def list_opportunities(
    search: Optional[str] = Query(None),
    stage: Optional[str] = Query(None),       # comma-separated
    tags: Optional[str] = Query(None),         # comma-separated
):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            filters, params = _list_filters(search, stage, tags)
            where = ("WHERE " + " AND ".join(filters)) if filters else ""

            cur.execute(f"""
                SELECT
                    fo.opportunity_id, fo.title, fo.stage, fo.deadline, fo.deadline_time, fo.tags,
                    fo.funding_type, fo.dilution,
                    fo.amount, fo.amount_currency, fo.amount_notes,
                    fo.decision_date, fo.funding_dispersion,
                    fo.source_link, fo.gcal_event_id,
                    fo.eligibility, fo.cost_share_match, fo.org_fit,
                    fo.last_verified, fo.next_action,
                    (SELECT n.body FROM funding_notes n
                      WHERE n.opportunity_id = fo.opportunity_id
                      ORDER BY n.created_at DESC LIMIT 1) AS latest_note,
                    (SELECT COUNT(*) FROM funding_notes n
                      WHERE n.opportunity_id = fo.opportunity_id)::int AS notes_count,
                    fo.assignee_id,
                    COALESCE(u.full_name, u.name, u.email) AS assignee_name,
                    fo.linked_project_id,
                    fo.created_at, fo.updated_at
                FROM funding_opportunities fo
                LEFT JOIN users u ON u.user_id = fo.assignee_id
                {where}
                ORDER BY {_STAGE_ORDER}
            """, params)
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


# ── Funding types CRUD ────────────────────────────────────────────────────────
# The vocabulary behind the Funding Type dropdown. Records reference a type by
# name, not by id — a rename is then a single UPDATE here plus one on the
# records, and nothing breaks if a row is deleted out from under them.

@router.get("/funding-types")
def list_funding_types():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT t.id, t.name, t.color, t.sort_order,
                       COUNT(fo.opportunity_id) AS opportunity_count
                FROM funding_types t
                LEFT JOIN funding_opportunities fo ON fo.funding_type = t.name
                GROUP BY t.id, t.name, t.color, t.sort_order
                ORDER BY t.sort_order, t.id
            """)
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/funding-types", status_code=201)
def create_funding_type(body: dict):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    color = (body.get("color") or "gray").strip()
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "INSERT INTO funding_types (name, color, sort_order) "
                "VALUES (%s, %s, (SELECT COALESCE(MAX(sort_order),0)+10 FROM funding_types)) "
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


@router.patch("/funding-types/{type_id}")
def update_funding_type(type_id: int, body: dict):
    allowed = {"name", "color", "sort_order"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT name FROM funding_types WHERE id = %s", (type_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Funding type not found")
            old_name = row["name"]
            cur.execute(
                f"UPDATE funding_types SET {set_clause} WHERE id = %s",
                list(updates.values()) + [type_id],
            )
            # Records point at the name, so a rename has to carry them along or
            # they would all fall out of the vocabulary at once.
            new_name = (updates.get("name") or "").strip()
            if new_name and new_name != old_name:
                cur.execute(
                    "UPDATE funding_opportunities SET funding_type = %s WHERE funding_type = %s",
                    (new_name, old_name),
                )
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/funding-types/{type_id}", status_code=204)
def delete_funding_type(type_id: int, reassign_to: Optional[str] = Query(None)):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT name FROM funding_types WHERE id = %s", (type_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Funding type not found")
            old_name = row["name"]
            cur.execute(
                "UPDATE funding_opportunities SET funding_type = %s WHERE funding_type = %s",
                (reassign_to or None, old_name),
            )
            cur.execute("DELETE FROM funding_types WHERE id = %s", (type_id,))
            conn.commit()
    finally:
        conn.close()


# ── Open ERP Knowledge Base ─────────────────────────────────────────────────────
# Reusable answers to the questions every application asks. Read far more often
# than written — the list endpoint returns everything, because the whole point
# is to scan it while a form is open in the next tab.

_KB_UPDATABLE = {"category", "question", "answer", "links", "tags", "sort_order"}


@router.get("/kb")
def list_kb_entries(category: Optional[str] = Query(None), search: Optional[str] = Query(None)):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            filters, params = [], []
            if category:
                filters.append("k.category = %s")
                params.append(category)
            if search:
                filters.append("(k.question ILIKE %s OR k.answer ILIKE %s)")
                params.extend([f"%{search}%", f"%{search}%"])
            where = ("WHERE " + " AND ".join(filters)) if filters else ""
            cur.execute(f"""
                SELECT k.entry_id, k.category, k.question, k.answer, k.links, k.tags,
                       k.sort_order, k.updated_by,
                       COALESCE(u.full_name, u.name, u.email) AS updated_by_name,
                       k.created_at, k.updated_at
                FROM funding_kb_entries k
                LEFT JOIN users u ON u.user_id = k.updated_by
                {where}
                ORDER BY k.sort_order, k.created_at
            """, params)
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/kb", status_code=201)
def create_kb_entry(body: dict, request: Request):
    question = (body.get("question") or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO funding_kb_entries
                    (category, question, answer, links, tags, sort_order, updated_by)
                VALUES (%s, %s, %s, %s, %s,
                        (SELECT COALESCE(MAX(sort_order),0)+10 FROM funding_kb_entries), %s)
                RETURNING entry_id
            """, (
                (body.get("category") or "General").strip(),
                question,
                body.get("answer") or None,
                body.get("links", []),
                body.get("tags", []),
                request.headers.get("X-User-Id") or None,
            ))
            row = cur.fetchone()
            conn.commit()
            return {"entry_id": str(row["entry_id"])}
    finally:
        conn.close()


@router.patch("/kb/{entry_id}")
def update_kb_entry(entry_id: str, body: dict, request: Request):
    updates = {k: v for k, v in body.items() if k in _KB_UPDATABLE}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values())
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE funding_kb_entries SET {set_clause}, updated_by = %s, updated_at = NOW() "
                f"WHERE entry_id = %s",
                values + [request.headers.get("X-User-Id") or None, entry_id],
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Entry not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/kb/{entry_id}", status_code=204)
def delete_kb_entry(entry_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM funding_kb_entries WHERE entry_id = %s", (entry_id,))
            conn.commit()
    finally:
        conn.close()


# ── Notes & stage history ─────────────────────────────────────────────────────
# Notes are dated entries (129 replaced the blob); history is written by the
# create/update handlers above. Both read newest-first for the timeline.

@router.get("/{opportunity_id}/notes")
def list_notes(opportunity_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT n.note_id, n.body, n.author_id,
                       COALESCE(u.full_name, u.name, u.email) AS author_name,
                       n.created_at, n.updated_at
                FROM funding_notes n
                LEFT JOIN users u ON u.user_id = n.author_id
                WHERE n.opportunity_id = %s
                ORDER BY n.created_at DESC
            """, (opportunity_id,))
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/{opportunity_id}/notes", status_code=201)
def add_note(opportunity_id: str, body: dict, request: Request):
    text = (body.get("body") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="body is required")
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "INSERT INTO funding_notes (opportunity_id, body, author_id) "
                "VALUES (%s, %s, %s) RETURNING note_id",
                (opportunity_id, text, request.headers.get("X-User-Id") or None))
            row = cur.fetchone()
            _claim_unassigned(cur, opportunity_id, _actor_id(request))
            conn.commit()
            return {"note_id": str(row["note_id"])}
    except psycopg2.errors.ForeignKeyViolation:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    finally:
        conn.close()


@router.patch("/notes/{note_id}")
def update_note(note_id: str, body: dict):
    text = (body.get("body") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="body is required")
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE funding_notes SET body = %s, updated_at = NOW() WHERE note_id = %s",
                (text, note_id))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Note not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/notes/{note_id}", status_code=204)
def delete_note(note_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM funding_notes WHERE note_id = %s", (note_id,))
            conn.commit()
    finally:
        conn.close()


@router.get("/{opportunity_id}/history")
def list_stage_history(opportunity_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT h.history_id, h.changed_at, h.stage_from, h.stage_to,
                       h.changed_by,
                       COALESCE(u.full_name, u.name, u.email) AS changed_by_name
                FROM funding_stage_history h
                LEFT JOIN users u ON u.user_id = h.changed_by
                WHERE h.opportunity_id = %s
                ORDER BY h.changed_at DESC
            """, (opportunity_id,))
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


# ── Opportunity Details ───────────────────────────────────────────────────────
# The enrichment metadata, kept off the board so the decision view stays a
# decision view. One row per opportunity, joined on the id (134).

@router.get("/{opportunity_id}/details")
def get_opportunity_details(opportunity_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Created on demand, so a record added before this schema existed
            # still opens its tab instead of 404ing.
            cur.execute(
                "INSERT INTO funding_opportunity_details (opportunity_id) VALUES (%s) "
                "ON CONFLICT (opportunity_id) DO NOTHING", (opportunity_id,))
            cur.execute(
                "SELECT * FROM funding_opportunity_details WHERE opportunity_id = %s",
                (opportunity_id,))
            row = cur.fetchone()
            conn.commit()
            if not row:
                raise HTTPException(status_code=404, detail="Opportunity not found")
            return dict(row)
    except psycopg2.errors.ForeignKeyViolation:
        conn.rollback()
        raise HTTPException(status_code=404, detail="Opportunity not found")
    finally:
        conn.close()


@router.patch("/{opportunity_id}/details")
def update_opportunity_details(opportunity_id: str, body: dict, request: Request = None):
    updates = {k: v for k, v in body.items() if k in _DETAIL_UPDATABLE}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")
    if "record_status" in updates and updates["record_status"] not in RECORD_STATUS_VALUES:
        raise HTTPException(
            status_code=400,
            detail=f"record_status must be one of {', '.join(RECORD_STATUS_VALUES)}")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"INSERT INTO funding_opportunity_details (opportunity_id) VALUES (%s) "
                f"ON CONFLICT (opportunity_id) DO NOTHING", (opportunity_id,))
            cur.execute(
                f"UPDATE funding_opportunity_details SET {set_clause}, updated_at = NOW() "
                f"WHERE opportunity_id = %s",
                list(updates.values()) + [opportunity_id])
            _claim_unassigned(cur, opportunity_id, _actor_id(request))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Opportunity not found")
            conn.commit()
        return {"ok": True}
    except psycopg2.errors.ForeignKeyViolation:
        conn.rollback()
        raise HTTPException(status_code=404, detail="Opportunity not found")
    finally:
        conn.close()


# ── Application answers ───────────────────────────────────────────────────────
# The questions a funder asked and what we wrote back. Entered by hand; the
# Knowledge Base is wired to it in both directions (133).

_ANSWER_UPDATABLE = {"question", "answer", "word_limit", "sort_order", "kb_entry_id"}


@router.get("/{opportunity_id}/application")
def list_application_answers(opportunity_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT a.answer_id, a.question, a.answer, a.word_limit, a.sort_order,
                       a.kb_entry_id, k.question AS kb_question,
                       a.author_id,
                       COALESCE(u.full_name, u.name, u.email) AS author_name,
                       a.created_at, a.updated_at
                FROM funding_application_answers a
                LEFT JOIN funding_kb_entries k ON k.entry_id = a.kb_entry_id
                LEFT JOIN users u ON u.user_id = a.author_id
                WHERE a.opportunity_id = %s
                ORDER BY a.sort_order, a.created_at
            """, (opportunity_id,))
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/{opportunity_id}/application", status_code=201)
def add_application_answer(opportunity_id: str, body: dict, request: Request):
    """Add a question, optionally seeded from a Knowledge Base entry.

    Passing kb_entry_id copies that entry's text in as the starting draft rather
    than referencing it live — the answer will be reworded to this funder's
    limit, and the Knowledge Base should not change because one application
    trimmed a sentence.
    """
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            question = (body.get("question") or "").strip()
            answer = body.get("answer")
            kb_entry_id = body.get("kb_entry_id") or None

            if kb_entry_id:
                cur.execute(
                    "SELECT question, answer FROM funding_kb_entries WHERE entry_id = %s",
                    (kb_entry_id,))
                kb = cur.fetchone()
                if not kb:
                    raise HTTPException(status_code=404, detail="Knowledge base entry not found")
                question = question or kb["question"]
                if answer is None:
                    answer = kb["answer"]

            if not question:
                raise HTTPException(status_code=400, detail="question is required")

            cur.execute("""
                INSERT INTO funding_application_answers
                    (opportunity_id, question, answer, word_limit, kb_entry_id,
                     sort_order, author_id)
                VALUES (%s, %s, %s, %s, %s,
                        (SELECT COALESCE(MAX(sort_order),0)+10
                           FROM funding_application_answers WHERE opportunity_id = %s), %s)
                RETURNING answer_id
            """, (
                opportunity_id, question, answer, body.get("word_limit") or None,
                kb_entry_id, opportunity_id, request.headers.get("X-User-Id") or None,
            ))
            row = cur.fetchone()
            _claim_unassigned(cur, opportunity_id, _actor_id(request))
            conn.commit()
            return {"answer_id": str(row["answer_id"])}
    except psycopg2.errors.ForeignKeyViolation:
        conn.rollback()
        raise HTTPException(status_code=404, detail="Opportunity not found")
    finally:
        conn.close()


@router.patch("/application/{answer_id}")
def update_application_answer(answer_id: str, body: dict, request: Request):
    updates = {k: v for k, v in body.items() if k in _ANSWER_UPDATABLE}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE funding_application_answers SET {set_clause}, author_id = %s, "
                f"updated_at = NOW() WHERE answer_id = %s",
                list(updates.values()) + [request.headers.get("X-User-Id") or None, answer_id],
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Answer not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/application/{answer_id}", status_code=204)
def delete_application_answer(answer_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM funding_application_answers WHERE answer_id = %s",
                        (answer_id,))
            conn.commit()
    finally:
        conn.close()


@router.post("/application/{answer_id}/to-kb")
def promote_answer_to_kb(answer_id: str, request: Request, body: Optional[dict] = None):
    """Send a written answer to the Knowledge Base.

    Where the answer already came from an entry, that entry is updated —
    otherwise a second copy of the same question would accumulate every time an
    application reused it. Where it did not, a new entry is created and linked
    back, so the entry records which submission it was proven on.
    """
    user_id = request.headers.get("X-User-Id") or None
    # Category is the only thing this takes, and only when creating. A caller
    # with nothing to say should not have to post an empty object.
    category = ((body or {}).get("category") or "").strip() or "General"
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT question, answer, kb_entry_id FROM funding_application_answers "
                "WHERE answer_id = %s", (answer_id,))
            a = cur.fetchone()
            if not a:
                raise HTTPException(status_code=404, detail="Answer not found")
            if not (a["answer"] or "").strip():
                raise HTTPException(status_code=400,
                                    detail="Nothing to save — this question has no answer yet.")

            if a["kb_entry_id"]:
                cur.execute(
                    "UPDATE funding_kb_entries SET answer = %s, updated_by = %s, "
                    "updated_at = NOW() WHERE entry_id = %s",
                    (a["answer"], user_id, a["kb_entry_id"]))
                entry_id = a["kb_entry_id"]
                created = False
            else:
                cur.execute("""
                    INSERT INTO funding_kb_entries (category, question, answer, sort_order, updated_by)
                    VALUES (%s, %s, %s,
                            (SELECT COALESCE(MAX(sort_order),0)+10 FROM funding_kb_entries), %s)
                    RETURNING entry_id
                """, (category, a["question"], a["answer"], user_id))
                entry_id = cur.fetchone()["entry_id"]
                cur.execute(
                    "UPDATE funding_application_answers SET kb_entry_id = %s WHERE answer_id = %s",
                    (entry_id, answer_id))
                created = True
            conn.commit()
        return {"entry_id": str(entry_id), "created": created}
    finally:
        conn.close()


# ── Opportunity Discovery: research platforms ─────────────────────────────────

_PLATFORM_UPDATABLE = {"name", "url", "category", "notes", "is_active",
                       "last_checked", "sort_order"}


@router.get("/research-platforms")
def list_research_platforms(include_inactive: bool = Query(True)):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            where = "" if include_inactive else "WHERE is_active"
            cur.execute(f"""
                SELECT platform_id, name, url, category, notes, is_active,
                       last_checked, sort_order, created_at, updated_at
                FROM funding_research_platforms
                {where}
                ORDER BY sort_order, name
            """)
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/research-platforms", status_code=201)
def create_research_platform(body: dict):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                INSERT INTO funding_research_platforms (name, url, category, notes, sort_order)
                VALUES (%s, %s, %s, %s,
                        (SELECT COALESCE(MAX(sort_order),0)+10 FROM funding_research_platforms))
                RETURNING platform_id
            """, (
                name,
                body.get("url") or None,
                body.get("category") or None,
                body.get("notes") or None,
            ))
            row = cur.fetchone()
            conn.commit()
            return {"platform_id": str(row["platform_id"])}
    finally:
        conn.close()


@router.patch("/research-platforms/{platform_id}")
def update_research_platform(platform_id: str, body: dict):
    updates = {k: v for k, v in body.items() if k in _PLATFORM_UPDATABLE}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE funding_research_platforms SET {set_clause}, updated_at = NOW() "
                f"WHERE platform_id = %s",
                list(updates.values()) + [platform_id],
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Platform not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/research-platforms/{platform_id}", status_code=204)
def delete_research_platform(platform_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM funding_research_platforms WHERE platform_id = %s",
                        (platform_id,))
            conn.commit()
    finally:
        conn.close()


# ── CSV export ────────────────────────────────────────────────────────────────
# Declared ahead of the id-bearing routes for the same reason the investor
# export is: "/export" must not be read as an opportunity id.

@router.get("/export")
def export_opportunities(
    search: Optional[str] = Query(None),
    stage: Optional[str] = Query(None),
    tags: Optional[str] = Query(None),
):
    """The current view as CSV — same filters the board is showing."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            filters, params = _list_filters(search, stage, tags)
            where = ("WHERE " + " AND ".join(filters)) if filters else ""

            cur.execute(f"""
                SELECT
                    fo.stage, fo.title, fo.funding_type, fo.dilution,
                    fo.amount, fo.amount_currency, fo.amount_notes,
                    fo.org_fit, fo.eligibility, fo.cost_share_match,
                    fo.next_action, fo.last_verified,
                    fo.deadline, fo.deadline_time, fo.decision_date,
                    fo.funding_dispersion, fo.source_link,
                    array_to_string(fo.tags, '; ') AS tags,
                    COALESCE(u.full_name, u.name, u.email) AS assignee,
                    (SELECT string_agg(to_char(n.created_at, 'YYYY-MM-DD') || ': ' || n.body,
                                       E'\n' ORDER BY n.created_at)
                       FROM funding_notes n
                      WHERE n.opportunity_id = fo.opportunity_id) AS notes,
                    fo.created_at, fo.updated_at
                FROM funding_opportunities fo
                LEFT JOIN users u ON u.user_id = fo.assignee_id
                {where}
                ORDER BY {_STAGE_ORDER}
            """, params)
            rows = cur.fetchall()

        output = io.StringIO()
        if rows:
            writer = csv.DictWriter(output, fieldnames=rows[0].keys())
            writer.writeheader()
            for row in rows:
                writer.writerow({k: ("" if v is None else str(v)) for k, v in row.items()})
        output.seek(0)

        filtered = any([search, stage, tags])
        filename = "applications_filtered.csv" if filtered else "applications.csv"
        # Excel reads a .csv as the system codepage unless the file opens with a
        # UTF-8 BOM, which turns € into â¬ and silently corrupts the sheet the
        # moment it is saved again. The BOM plus an explicit charset is what
        # makes a round trip through Excel non-destructive.
        return StreamingResponse(
            iter(["\ufeff" + output.getvalue()]),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    finally:
        conn.close()


# ── CSV import ────────────────────────────────────────────────────────────────

# Header spellings accepted for each column, so a sheet exported from a funder
# portal or a colleague's tracker imports without being reshaped by hand.
_CSV_ALIASES = {
    "title":              ("title", "name", "opportunity", "program", "programme", "grant"),
    "stage":              ("stage", "status"),
    "funding_type":       ("funding_type", "funding type", "type", "instrument"),
    "dilution":           ("dilution", "dilutive", "equity", "dilution type"),
    "amount":             ("amount", "award", "value", "funding amount"),
    "amount_currency":    ("amount_currency", "currency", "ccy"),
    "amount_notes":       ("amount_notes", "amount notes", "award notes"),
    "deadline":           ("deadline", "due", "due date", "close date", "closing date"),
    "deadline_time":      ("deadline_time", "deadline time"),
    "decision_date":      ("decision_date", "decision date", "decision"),
    "funding_dispersion": ("funding_dispersion", "funding dispersion", "dispersion"),
    "source_link":        ("source_link", "source link", "link", "url"),
    "tags":               ("tags", "tag", "keywords"),
    "notes":              ("notes", "note", "comments", "description"),
    # Screening properties (134)
    "eligibility":        ("eligibility", "eligible", "who can apply"),
    "cost_share_match":   ("cost_share_match", "cost share", "cost_share", "match"),
    "org_fit":         ("org_fit", "fit", "tier"),
    "last_verified":      ("last_verified", "last verified", "verified"),
    "next_action":        ("next_action", "next action", "action"),
    # Opportunity Details (134) — written to the linked record, not the board
    "record_status":      ("record_status", "record status", "status detail"),
    "fit_rationale":      ("fit_rationale", "fit rationale", "rationale"),
    "equity_taken":       ("equity_taken", "equity taken", "equity"),
    "focus_areas":        ("focus_areas", "focus areas", "focus"),
    "application_requirements": ("application_requirements", "application requirements", "requirements"),
    "program_contact":    ("program_contact", "program contact", "contact"),
    "sources":            ("sources", "source", "provenance"),
    "data_gaps":          ("data_gaps", "data gaps", "gaps"),
}

# Columns that live on the details record rather than the board.
_DETAIL_CSV_FIELDS = ("record_status", "fit_rationale", "equity_taken", "focus_areas",
                      "application_requirements", "program_contact", "sources", "data_gaps")

# Text that appears in a date column and is not a date. It carries meaning, so
# it moves to next_action rather than being dropped — but it never reaches a
# DATE column, where it would break every sort and deadline automation.
_NON_DATE_TEXT = {"unknown", "n/a", "na", "none", "tbd", "tba", "[not available]",
                  "rolling", "varies", "ongoing", ""}


def _norm_title(title: str) -> str:
    """Identity key for a programme name.

    Punctuation and case are stripped because the same programme arrives as
    "Plug and Play – Food & Beverage" and "Plug and Play - Food & Beverage"
    across sources — an en-dash apart. Exact-title matching splits those into
    two records, which is how duplicates got into this board in the first place.
    """
    return re.sub(r"[^a-z0-9]", "", (title or "").lower())

_IMPORT_STAGES = {s.lower(): s for s in
                  ("New", "In Progress", "Applied", "Won", "Rejected", "Withdrawn")}

# DD-Mon-YY is how the research exports write a real deadline ("20-Aug-26",
# "28-Apr-26"). Without it every one of those parsed as prose and the deadline
# was silently dropped — the exact failure the date rules exist to prevent.
# Month-only values ("Dec-26") are deliberately absent: turning one into the
# 1st invents a precision the source never had.
_DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%m/%d/%y",
                 "%d-%b-%y", "%d-%b-%Y", "%d %b %Y",
                 "%b %d, %Y", "%B %d, %Y")


def _parse_date(value: Optional[str]) -> Optional[str]:
    """Only `deadline` is a real date column; an unparseable cell is dropped
    rather than guessed at, so nothing lands on a wrong day."""
    if not value:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(value.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _write_details(cur, opportunity_id, rec):
    """Upsert the linked Opportunity Details record.

    Only fills a blank — an import must never overwrite research someone did by
    hand, which is the same rule the board columns follow.
    """
    values = {f: (rec.get(f) or "Unknown") for f in _DETAIL_CSV_FIELDS}
    if values.get("record_status") not in RECORD_STATUS_VALUES:
        raw = (values.get("record_status") or "").lower()
        # 'unenriched' contains 'enriched'; test the negative first or every
        # unresearched row imports as researched.
        if "unenriched" in raw:
            values["record_status"] = "Unenriched"
        elif "ineligible" in raw:
            values["record_status"] = "Ineligible"
        elif "verified" in raw:
            values["record_status"] = "Enriched (verified)"
        elif "enriched" in raw:
            values["record_status"] = "Enriched (desk)"
        else:
            values["record_status"] = "Unenriched"
    cur.execute("""
        INSERT INTO funding_opportunity_details
            (opportunity_id, record_status, fit_rationale, equity_taken, focus_areas,
             application_requirements, program_contact, sources, data_gaps)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (opportunity_id) DO UPDATE SET
            record_status = CASE WHEN funding_opportunity_details.record_status = 'Unenriched'
                                 THEN EXCLUDED.record_status
                                 ELSE funding_opportunity_details.record_status END,
            fit_rationale = COALESCE(NULLIF(funding_opportunity_details.fit_rationale, 'Unknown'), EXCLUDED.fit_rationale),
            equity_taken  = COALESCE(NULLIF(funding_opportunity_details.equity_taken, 'Unknown'), EXCLUDED.equity_taken),
            focus_areas   = COALESCE(NULLIF(funding_opportunity_details.focus_areas, 'Unknown'), EXCLUDED.focus_areas),
            application_requirements = COALESCE(NULLIF(funding_opportunity_details.application_requirements, 'Unknown'), EXCLUDED.application_requirements),
            program_contact = COALESCE(NULLIF(funding_opportunity_details.program_contact, 'Unknown'), EXCLUDED.program_contact),
            sources       = COALESCE(NULLIF(funding_opportunity_details.sources, 'Unknown'), EXCLUDED.sources),
            data_gaps     = COALESCE(NULLIF(funding_opportunity_details.data_gaps, 'Unknown'), EXCLUDED.data_gaps),
            updated_at = NOW()
    """, (opportunity_id, values["record_status"], values["fit_rationale"],
          values["equity_taken"], values["focus_areas"],
          values["application_requirements"], values["program_contact"],
          values["sources"], values["data_gaps"]))


def _map_csv_row(row: dict) -> Optional[dict]:
    """One CSV row → an opportunity, or None when there is no usable title."""
    lookup = {(k or "").strip().lower(): (v or "").strip()
              for k, v in row.items() if k}

    rec: dict = {}
    for field, aliases in _CSV_ALIASES.items():
        for alias in aliases:
            if lookup.get(alias):
                rec[field] = lookup[alias]
                break

    if not rec.get("title"):
        return None

    # An unrecognised stage is filed as New rather than rejected — losing a
    # whole row over one odd cell helps nobody.
    rec["stage"] = _IMPORT_STAGES.get((rec.get("stage") or "").lower(), "New")

    # A recurrence ("Annual cohort; applications typically Q1") is real
    # information sitting in the wrong column. Keep it as an instruction and
    # leave the date empty, rather than inventing a date or losing the pattern.
    for date_col, carry in (("deadline", "next_action"), ("decision_date", "notes")):
        raw_date = (rec.get(date_col) or "").strip()
        if raw_date and _parse_date(raw_date) is None:
            if raw_date.lower() not in _NON_DATE_TEXT:
                prose = (f"No fixed {date_col.replace('_', ' ')} — {raw_date}"
                         if carry == "next_action" else f"{date_col}: {raw_date}")
                rec[carry] = "; ".join(filter(None, [rec.get(carry), prose]))
            rec[date_col] = None
    rec["last_verified"] = _parse_date(rec.get("last_verified"))

    fit = (rec.get("org_fit") or "")
    m = re.search(r"TIER\s*([123])", fit, re.I)
    rec["org_fit"] = f"Tier {m.group(1)}" if m else "Unrated"
    if fit and not m:
        rec.setdefault("fit_rationale", fit)
    elif fit:
        rec["fit_rationale"] = rec.get("fit_rationale") or fit
    rec["tags"] = [t.strip() for t in re.split(r"[;,]", rec.get("tags", "")) if t.strip()]
    rec["deadline"] = _parse_date(rec.get("deadline"))
    rec["dilution"] = _canon_dilution(rec.get("dilution"))

    # A sheet still spells the award '$50K–$1M'. Keep the number in amount and
    # the wording in amount_notes rather than dropping either — the same split
    # 126_funding_amount applied to the data already here.
    raw_amount = rec.get("amount")
    rec["amount_currency"] = _canon_currency(rec.get("amount_currency")) \
        or _canon_currency(next((c for c in _CURRENCY_SYMBOLS if c in (raw_amount or "")), None)) \
        or "USD"
    rec["amount"] = _canon_amount(raw_amount)
    if not rec.get("amount_notes") and raw_amount \
            and not re.fullmatch(r"[$€£¥]?\s*[0-9][0-9,.]*\s*[kKmM]?", raw_amount.strip()):
        rec["amount_notes"] = raw_amount.strip()
    return rec


@router.post("/import")
async def import_csv(file: UploadFile = File(...)):
    """Bulk-load opportunities. Rows are matched on title, so re-importing an
    updated sheet tops up the records already here instead of duplicating them.
    Only blank fields are filled: an import can never overwrite worked-on data.
    """
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
    seen: dict = {}
    skipped_dup = 0
    # Which titles collided, not just how many. A count tells you a duplicate
    # exists; the group tells you which two rows disagree about the equity
    # terms, and that is the part that costs money.
    dup_groups: dict = {}

    for row in reader:
        rec = _map_csv_row(row)
        if rec is None:
            continue
        key = _norm_title(rec["title"])
        if key in seen:
            skipped_dup += 1
            dup_groups.setdefault(key, {"kept": seen[key], "dropped": []})
            dup_groups[key]["dropped"].append({
                "title": rec["title"],
                "funding_type": rec.get("funding_type"),
                "equity_taken": rec.get("equity_taken"),
                "org_fit": rec.get("org_fit"),
                "source_link": rec.get("source_link"),
            })
            continue
        seen[key] = rec["title"]
        records.append(rec)

    if not records:
        raise HTTPException(
            status_code=400,
            detail="No usable rows — the file needs a 'title' column with values.",
        )

    # Everything the CSV may fill in on an existing row. Title identifies the
    # record and stage is the user's call, so neither is touched on update.
    fillable = ("deadline", "deadline_time", "decision_date", "funding_type",
                "dilution", "amount", "amount_currency", "amount_notes",
                "funding_dispersion", "source_link", "eligibility",
                "cost_share_match", "org_fit", "last_verified", "next_action")

    inserted = updated = 0
    # Rows whose programme already exists on the board under a different
    # spelling. Surfaced so a re-import cannot quietly fork a record.
    matched_existing: list = []
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT opportunity_id, title FROM funding_opportunities")
            existing, existing_titles = {}, {}
            for r in cur.fetchall():
                k = _norm_title(r["title"])
                existing[k] = r["opportunity_id"]
                existing_titles[k] = r["title"]

            for rec in records:
                # Resolved against the vocabulary here rather than in _map_csv_row
                # because an unseen type has to be registered, which needs the cursor.
                rec["funding_type"] = _canon_funding_type(cur, rec.get("funding_type"))

                key = _norm_title(rec["title"])
                oid = existing.get(key)
                if oid is not None and existing_titles.get(key) != rec["title"]:
                    matched_existing.append({"csv_title": rec["title"],
                                             "existing_title": existing_titles[key]})
                if oid is None:
                    cur.execute("""
                        INSERT INTO funding_opportunities
                            (title, stage, deadline, deadline_time, tags, funding_type,
                             dilution, amount, amount_currency, amount_notes,
                             decision_date, funding_dispersion, source_link,
                             eligibility, cost_share_match, org_fit,
                             last_verified, next_action)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        RETURNING opportunity_id
                    """, (
                        rec["title"], rec["stage"], rec.get("deadline"),
                        rec.get("deadline_time"), rec.get("tags", []),
                        rec.get("funding_type"), rec.get("dilution"),
                        rec.get("amount"), rec.get("amount_currency", "USD"),
                        rec.get("amount_notes"),
                        rec.get("decision_date"), rec.get("funding_dispersion"),
                        rec.get("source_link"),
                        # 'Unknown' is written explicitly so an unresearched
                        # field is distinguishable from a researched-empty one.
                        rec.get("eligibility") or "Unknown",
                        rec.get("cost_share_match") or "Unknown",
                        rec.get("org_fit") or "Unrated",
                        rec.get("last_verified"),
                        rec.get("next_action") or "Verify against primary source",
                    ))
                    new_id = cur.fetchone()["opportunity_id"]
                    _write_details(cur, new_id, rec)
                    if rec.get("notes"):
                        cur.execute(
                            "INSERT INTO funding_notes (opportunity_id, body) VALUES (%s, %s)",
                            (new_id, rec["notes"]))
                    inserted += 1
                    continue

                sets, values = [], []
                for col in fillable:
                    val = rec.get(col)
                    if val in (None, ""):
                        continue
                    # A placeholder is an empty field wearing a label. org_fit
                    # is NOT NULL DEFAULT 'Unrated' and the screening columns are
                    # seeded 'Unknown' on insert, so a plain COALESCE would treat
                    # every one of them as already-answered and refuse to fill it.
                    if col in ("org_fit", "eligibility", "cost_share_match", "next_action"):
                        sets.append(
                            f"{col} = COALESCE(NULLIF(NULLIF({col}, 'Unknown'), 'Unrated'), %s)")
                    else:
                        sets.append(f"{col} = COALESCE({col}, %s)")
                    values.append(val)
                if rec.get("tags"):
                    sets.append("tags = CASE WHEN tags IS NULL OR cardinality(tags) = 0 "
                                "THEN %s::text[] ELSE tags END")
                    values.append(rec["tags"])
                # Same fill-blank-only rule the columns follow: a note from the
                # sheet lands only where nothing has been written yet, so
                # re-importing a sheet never stacks duplicate entries.
                _write_details(cur, oid, rec)
                note_added = False
                if rec.get("notes"):
                    cur.execute(
                        "INSERT INTO funding_notes (opportunity_id, body) "
                        "SELECT %s, %s WHERE NOT EXISTS "
                        "(SELECT 1 FROM funding_notes WHERE opportunity_id = %s)",
                        (oid, rec["notes"], oid))
                    note_added = cur.rowcount > 0
                if not sets:
                    if note_added:
                        updated += 1
                    continue
                values.append(oid)
                cur.execute(
                    f"UPDATE funding_opportunities SET {', '.join(sets)}, updated_at = NOW() "
                    f"WHERE opportunity_id = %s", values)
                updated += 1

            cur.execute("SELECT COUNT(*) AS n FROM funding_opportunities")
            total = cur.fetchone()["n"]
            conn.commit()
    finally:
        conn.close()

    return {
        "inserted": inserted,
        "updated": updated,
        "skipped_duplicate": skipped_dup,
        "total_in_db": total,
        # Named, not just counted — the rows that disagree are the ones worth
        # your attention, and a bare count hides them.
        "duplicate_groups": [
            {"kept_title": g["kept"], "dropped": g["dropped"]}
            for g in dup_groups.values()
        ],
        "matched_existing": matched_existing,
    }


# ── Create ────────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_opportunity(body: dict, request: Request):
    if not body.get("title"):
        raise HTTPException(status_code=400, detail="title is required")

    user_id = request.headers.get("X-User-Id") or None
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            stage = body.get("stage", "New")
            cur.execute("""
                INSERT INTO funding_opportunities
                    (title, stage, deadline, deadline_time, tags, funding_type,
                     dilution, amount, amount_currency, amount_notes,
                     decision_date, funding_dispersion, source_link, assignee_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING opportunity_id
            """, (
                body["title"],
                stage,
                body.get("deadline") or None,
                body.get("deadline_time") or None,
                body.get("tags", []),
                _canon_funding_type(cur, body.get("funding_type")),
                _canon_dilution(body.get("dilution")),
                _canon_amount(body.get("amount")),
                _canon_currency(body.get("amount_currency")) or "USD",
                body.get("amount_notes") or None,
                body.get("decision_date") or None,
                body.get("funding_dispersion") or None,
                body.get("source_link") or None,
                # Whoever adds it owns it, unless they named someone else — the
                # same rule the investor board has always used.
                body.get("assignee_id") or _actor_id(request),
            ))
            row = cur.fetchone()
            oid = row["opportunity_id"]
            # A note typed into the create form is the record's first entry.
            if body.get("notes"):
                cur.execute(
                    "INSERT INTO funding_notes (opportunity_id, body, author_id) "
                    "VALUES (%s, %s, %s)",
                    (oid, body["notes"], user_id))
            # stage_from NULL marks creation, so the timeline starts at the start.
            cur.execute(
                "INSERT INTO funding_stage_history "
                "(opportunity_id, stage_from, stage_to, changed_by) "
                "VALUES (%s, NULL, %s, %s)",
                (oid, stage, user_id))
            conn.commit()
            return {"opportunity_id": str(oid)}
    finally:
        conn.close()


# ── Update ────────────────────────────────────────────────────────────────────

@router.patch("/{opportunity_id}")
def update_opportunity(opportunity_id: str, body: dict, request: Request):
    updates = {k: v for k, v in body.items() if k in UPDATABLE}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    if "dilution" in updates:
        updates["dilution"] = _canon_dilution(updates["dilution"])
    if "amount" in updates:
        updates["amount"] = _canon_amount(updates["amount"])
    if "amount_currency" in updates:
        updates["amount_currency"] = _canon_currency(updates["amount_currency"]) or "USD"
    if "last_verified" in updates and not (updates["last_verified"] or ""):
        # '' would be written as text into a DATE column and error; the honest
        # value for "never verified" is NULL.
        updates["last_verified"] = None
    if "org_fit" in updates and updates["org_fit"] not in OPENERP_FIT_VALUES:
        raise HTTPException(status_code=400,
                            detail=f"org_fit must be one of {', '.join(OPENERP_FIT_VALUES)}")

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Every write goes through the vocabulary, so the dropdown, the AI
            # enricher and a hand-rolled API call cannot disagree about what a
            # type is called.
            if "funding_type" in updates:
                updates["funding_type"] = _canon_funding_type(cur, updates["funding_type"])

            # A stage move is an event, not just a value — the old stage is read
            # under lock so concurrent moves each record their own true step.
            old_stage = None
            if "stage" in updates:
                cur.execute(
                    "SELECT stage FROM funding_opportunities WHERE opportunity_id = %s FOR UPDATE",
                    (opportunity_id,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="Opportunity not found")
                old_stage = row["stage"]

            set_clause = ", ".join(f"{k} = %s" for k in updates)
            values = list(updates.values()) + [opportunity_id]
            cur.execute(
                f"UPDATE funding_opportunities SET {set_clause}, updated_at = NOW() WHERE opportunity_id = %s",
                values,
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Opportunity not found")
            if "stage" in updates and updates["stage"] != old_stage:
                cur.execute(
                    "INSERT INTO funding_stage_history "
                    "(opportunity_id, stage_from, stage_to, changed_by) "
                    "VALUES (%s, %s, %s, %s)",
                    (opportunity_id, old_stage, updates["stage"],
                     request.headers.get("X-User-Id") or None))
            # Editing a field or dragging a card is working on it. Skipped when
            # the edit IS the assignment — that has already said who owns it.
            if "assignee_id" not in updates:
                _claim_unassigned(cur, opportunity_id, _actor_id(request))
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{opportunity_id}", status_code=204)
def delete_opportunity(opportunity_id: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM funding_opportunities WHERE opportunity_id = %s",
                (opportunity_id,),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Opportunity not found")
            conn.commit()
    finally:
        conn.close()

# ── Link / create grant project ───────────────────────────────────────────────

@router.post("/{opportunity_id}/link-project", status_code=201)
def link_project_from_opportunity(opportunity_id: str):
    """Create a grant project linked to this funding opportunity, or return existing."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT opportunity_id, title, funding_type, amount, deadline, tags, "
                "source_link, linked_project_id, "
                "(SELECT string_agg(to_char(n.created_at, 'YYYY-MM-DD') || ': ' || n.body, "
                " E'\\n' ORDER BY n.created_at) FROM funding_notes n "
                " WHERE n.opportunity_id = funding_opportunities.opportunity_id) AS notes "
                "FROM funding_opportunities WHERE opportunity_id = %s",
                (opportunity_id,),
            )
            opp = cur.fetchone()
            if not opp:
                raise HTTPException(status_code=404, detail="Opportunity not found")

            # Already linked — return the existing project
            if opp["linked_project_id"]:
                cur.execute("SELECT project_id, name FROM projects WHERE project_id = %s", (opp["linked_project_id"],))
                proj = cur.fetchone()
                if proj:
                    return {"project_id": str(proj["project_id"]), "created": False}

            # Create the project
            import uuid as _uuid
            new_id = str(_uuid.uuid4())
            cur.execute("""
                INSERT INTO projects
                    (project_id, name, project_type, stage, status, notes, date_deadline,
                     linked_opportunity_id)
                VALUES (%s, %s, 'grant', 'Identified', 'in_progress', %s, %s, %s)
            """, (
                new_id,
                opp["title"],
                opp["notes"],
                opp["deadline"],
                opportunity_id,
            ))
            # Wire back
            cur.execute(
                "UPDATE funding_opportunities SET linked_project_id = %s WHERE opportunity_id = %s",
                (new_id, opportunity_id),
            )
            conn.commit()
            return {"project_id": new_id, "created": True}
    finally:
        conn.close()


# ── Email suggestions (Opportunity Activity) ──────────────────────────────────
# Applications have no contacts, so mail reaches them through the domain/subject
# matcher in comm_sync, which files here rather than into the shared timeline.
# Accepting is what promotes a suggestion into a real comm_messages row.

@router.get("/{opportunity_id}/suggestions")
def list_suggestions(opportunity_id: str, status: str = Query("suggested")):
    if status not in ("suggested", "accepted", "dismissed", "all"):
        raise HTTPException(status_code=400, detail="Unknown status filter")
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            where = "WHERE opportunity_id = %s"
            params = [opportunity_id]
            if status != "all":
                where += " AND status = %s"
                params.append(status)
            cur.execute(f"""
                SELECT suggestion_id, gmail_message_id, thread_id, subject, snippet,
                       from_email, to_emails, occurred_at, direction, match_reason,
                       status, resolved_at
                FROM funding_email_suggestions
                {where}
                ORDER BY occurred_at DESC
                LIMIT 200
            """, params)
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/suggestions/{suggestion_id}/accept")
def accept_suggestion(suggestion_id: str, request: Request):
    """Promote a suggestion to a real timeline entry.

    Two things happen, and the second matters more than the first: the message
    is written to comm_messages, and the counterparty's address is registered
    against the opportunity. From then on the ordinary exact-address rule owns
    that conversation and the heuristic never runs for it again.
    """
    user_id = request.headers.get("X-User-Id") or None
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM funding_email_suggestions WHERE suggestion_id = %s FOR UPDATE",
                (suggestion_id,))
            s = cur.fetchone()
            if not s:
                raise HTTPException(status_code=404, detail="Suggestion not found")
            if s["status"] == "accepted":
                return {"ok": True, "already": True}

            cur.execute("""
                INSERT INTO comm_messages
                    (entity_type, entity_id, gmail_message_id, thread_id, direction,
                     subject, snippet, from_email, to_emails, occurred_at, seen_by,
                     mailbox_user_id)
                VALUES ('funding', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT DO NOTHING
            """, (
                s["opportunity_id"], s["gmail_message_id"], s["thread_id"],
                s["direction"], s["subject"], s["snippet"], s["from_email"],
                list(s["to_emails"] or []), s["occurred_at"], s["seen_by"],
                # The suggestion was raised by one mailbox's crawl; its thread
                # id belongs to that mailbox and travels with the row.
                s["seen_by"],
            ))

            # Learn the counterparty, so the exact-address rule owns this
            # conversation from here and the heuristics are never needed for it
            # again. from_email for an inbound message is the sender; a
            # backfilled row has no sender column to draw on, so the outside
            # addresses collected in to_emails stand in. Our own addresses are
            # never learned — they would match every opportunity at once.
            learn = []
            if s["direction"] == "inbound" and s["from_email"]:
                learn.append(s["from_email"])
            learn.extend(s["to_emails"] or [])
            if learn:
                cur.execute(
                    "SELECT DISTINCT lower(split_part(COALESCE(google_email,''),'@',2)) AS d "
                    "FROM google_oauth_tokens WHERE google_email IS NOT NULL")
                ours = {r["d"] for r in cur.fetchall() if r["d"]} or {"example.com"}
                for addr in {a.lower().strip() for a in learn if a and "@" in a}:
                    if addr.split("@")[-1] in ours:
                        continue
                    cur.execute("""
                        INSERT INTO comm_addresses (entity_type, entity_id, email)
                        VALUES ('funding', %s, %s)
                        ON CONFLICT (entity_type, entity_id, email) DO NOTHING
                    """, (s["opportunity_id"], addr))

            cur.execute(
                "UPDATE funding_email_suggestions SET status = 'accepted', "
                "resolved_by = %s, resolved_at = NOW() WHERE suggestion_id = %s",
                (user_id, suggestion_id))
            # Judging whether an email belongs to this opportunity is working on
            # it, and it is often the first thing anyone does to one.
            _claim_unassigned(cur, s["opportunity_id"], _actor_id(request))
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/suggestions/{suggestion_id}/dismiss")
def dismiss_suggestion(suggestion_id: str, request: Request):
    """Dismissed rows are kept, not deleted — the UNIQUE key on
    (opportunity_id, gmail_message_id) is what stops the next sync re-offering
    a message someone has already rejected."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE funding_email_suggestions SET status = 'dismissed', "
                "resolved_by = %s, resolved_at = NOW() WHERE suggestion_id = %s",
                (request.headers.get("X-User-Id") or None, suggestion_id))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Suggestion not found")
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/suggestions/{suggestion_id}/unaccept")
def unaccept_suggestion(suggestion_id: str, request: Request):
    """Detach an email that was attached to this opportunity.

    Removes the timeline row and marks the suggestion dismissed rather than
    deleting it — dismissed is what stops the matcher offering it again, so an
    email removed on purpose stays removed.

    The learned address is deliberately left alone. It may have been the reason
    several other messages were filed correctly, and withdrawing it would
    silently orphan them; unlinking one message should not undo a whole
    conversation. Remove the address from the Activity panel if that is what
    was meant.
    """
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT opportunity_id, gmail_message_id FROM funding_email_suggestions "
                "WHERE suggestion_id = %s", (suggestion_id,))
            s = cur.fetchone()
            if not s:
                raise HTTPException(status_code=404, detail="Suggestion not found")
            cur.execute(
                "DELETE FROM comm_messages WHERE entity_type = 'funding' "
                "AND entity_id = %s AND gmail_message_id = %s",
                (s["opportunity_id"], s["gmail_message_id"]))
            cur.execute(
                "UPDATE funding_email_suggestions SET status = 'dismissed', "
                "resolved_by = %s, resolved_at = NOW() WHERE suggestion_id = %s",
                (request.headers.get("X-User-Id") or None, suggestion_id))
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/{opportunity_id}/detach-email")
def detach_email(opportunity_id: str, body: dict, request: Request):
    """Detach an email from the Activity timeline.

    Keyed on the Gmail id because that is what the timeline shows; the caller
    should not have to know whether the message arrived through a suggestion or
    was sent from the composer. Where a suggestion exists it is marked
    dismissed, which is what stops the matcher offering the message again —
    without that the next sweep would simply put it back.
    """
    msg_id = (body.get("gmail_message_id") or "").strip()
    if not msg_id:
        raise HTTPException(status_code=400, detail="gmail_message_id is required")
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM comm_messages WHERE entity_type = 'funding' "
                "AND entity_id = %s AND gmail_message_id = %s",
                (opportunity_id, msg_id))
            removed = cur.rowcount
            cur.execute(
                "UPDATE funding_email_suggestions SET status = 'dismissed', "
                "resolved_by = %s, resolved_at = NOW() "
                "WHERE opportunity_id = %s AND gmail_message_id = %s",
                (request.headers.get("X-User-Id") or None, opportunity_id, msg_id))
            conn.commit()
        if not removed:
            raise HTTPException(status_code=404, detail="Message not on this opportunity")
        return {"ok": True}
    finally:
        conn.close()


@router.post("/{opportunity_id}/backfill")
def backfill_opportunity(opportunity_id: str):
    """Re-scan already-synced mail for this opportunity.

    The live matcher only sees messages as Gmail delivers them, so an
    opportunity added after a conversation started is blind to it. This walks
    the contacts crawl's history instead — no Gmail call, no quota, safe to
    re-run.
    """
    from app.tasks.comm_sync import backfill_funding_suggestions
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            found = backfill_funding_suggestions(cur, opportunity_id=opportunity_id)
            conn.commit()
        return {"found": found}
    finally:
        conn.close()


@router.post("/backfill-all")
def backfill_all_opportunities():
    """The same sweep across every opportunity. Run once after importing a board."""
    from app.tasks.comm_sync import backfill_funding_suggestions
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            found = backfill_funding_suggestions(cur)
            conn.commit()
        return {"found": found}
    finally:
        conn.close()


@router.get("/suggestions/pending-count")
def pending_suggestion_counts():
    """Open suggestions per opportunity, for the badge on the board."""
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT opportunity_id::text AS id, COUNT(*)::int AS n "
                "FROM funding_email_suggestions WHERE status = 'suggested' "
                "GROUP BY opportunity_id")
            return {r["id"]: r["n"] for r in cur.fetchall()}
    finally:
        conn.close()



# ── Users list (for assignee picker) ──────────────────────────────────────────

@router.get("/users")
def list_users():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT user_id, email, COALESCE(full_name, name, email) AS display_name "
                "FROM users WHERE is_active = true ORDER BY display_name ASC"
            )
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


# ── AI Enrichment ──────────────────────────────────────────────────────────────

@router.post("/{opportunity_id}/enrich")
def enrich_opportunity(opportunity_id: str):
    import anthropic
    import json as _json
    from app.core.agent_config import get_agent_config
    from app.agents.usage_logger import log_anthropic_call

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT title, stage, funding_type, dilution, amount, amount_currency, "
                "amount_notes, tags, source_link, decision_date, "
                "(SELECT string_agg(to_char(n.created_at, 'YYYY-MM-DD') || ': ' || n.body, "
                " E'\\n' ORDER BY n.created_at DESC) FROM ("
                "   SELECT body, created_at FROM funding_notes fn "
                "   WHERE fn.opportunity_id = funding_opportunities.opportunity_id "
                "   ORDER BY created_at DESC LIMIT 5) n) AS notes "
                "FROM funding_opportunities WHERE opportunity_id = %s",
                (opportunity_id,),
            )
            opp = cur.fetchone()
            cur.execute("SELECT name FROM funding_types ORDER BY sort_order, id")
            vocabulary = [r["name"] for r in cur.fetchall()]
    finally:
        conn.close()

    if not opp:
        raise HTTPException(status_code=404, detail="Opportunity not found")

    cfg = get_agent_config("funding_enrich")
    model = cfg.get("model") or "claude-haiku-4-5-20251001"
    max_tokens = cfg.get("max_tokens") or 1024
    system_prompt = cfg.get("system_prompt_override") or cfg.get("default_system_prompt") or ""

    user_msg = (
        f"Funding opportunity to enrich:\n\n"
        f"Title: {opp['title']}\n"
        f"Stage: {opp['stage']}\n"
        f"Current funding_type: {opp['funding_type'] or 'unknown'}\n"
        f"Current dilution: {opp['dilution'] or 'unknown'}\n"
        f"Current amount: {opp['amount'] or 'unknown'} {opp['amount_currency'] or ''}\n"
        f"Current amount notes: {opp['amount_notes'] or 'none'}\n"
        f"Current tags: {', '.join(opp['tags']) if opp['tags'] else 'none'}\n"
        f"Current decision_date: {opp['decision_date'] or 'unknown'}\n"
        f"Source link: {opp['source_link'] or 'none'}\n"
        f"Current notes: {opp['notes'] or 'none'}\n"
        # funding_type is a controlled vocabulary now. Left unconstrained the
        # model reinvents the free text 125_funding_types just cleaned up.
        f"\nfunding_type must be exactly one of: {', '.join(vocabulary)}. "
        f"Omit it if none fits.\n"
        f"dilution must be exactly one of: {', '.join(DILUTION_VALUES)}. "
        f"Omit it unless the source actually says which it is.\n"
        # amount stopped being free text in 126_funding_amount. A range or an
        # equity condition belongs in amount_notes, not smuggled into the number.
        f"amount must be a plain number with no symbols, separators or suffixes "
        f"— the ceiling, if the award is a range. amount_currency must be one of: "
        f"{', '.join(CURRENCIES)}. Put ranges, equity stakes, in-kind benefits and "
        f"any condition on the award in amount_notes instead.\n"
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
            operation="funding_enrich",
            model=model,
            input_tokens=msg.usage.input_tokens,
            output_tokens=msg.usage.output_tokens,
        )
    except Exception as exc:
        logger.error("Enrichment API call failed: %s", exc)
        raise HTTPException(status_code=502, detail="AI enrichment failed")

    raw = msg.content[0].text.strip()
    if raw.startswith("```"):
        lines = raw.splitlines()
        raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    try:
        result = _json.loads(raw)
    except Exception:
        raise HTTPException(status_code=502, detail="AI returned unparseable response")

    # The prompt asks for a vocabulary value; this is what makes it true. A
    # suggestion the user never accepts still shows in the diff panel, so an
    # invented type would read as a real option — drop it instead.
    if result.get("funding_type"):
        match = next((v for v in vocabulary
                      if v.lower() == str(result["funding_type"]).strip().lower()), None)
        result["funding_type"] = match
        if match is None:
            result.pop("funding_type")
    if "dilution" in result:
        result["dilution"] = _canon_dilution(result.get("dilution"))
        if result["dilution"] is None:
            result.pop("dilution")
    if "amount" in result:
        result["amount"] = _canon_amount(result.get("amount"))
        if result["amount"] is None:
            result.pop("amount")
    if "amount_currency" in result:
        result["amount_currency"] = _canon_currency(result.get("amount_currency"))
        if result["amount_currency"] is None:
            result.pop("amount_currency")

    return result


# ── Fundraising Plan CRUD ──────────────────────────────────────────────────────

@router.get("/plan")
def get_plan():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT config FROM funding_plan WHERE id = 'default'")
            row = cur.fetchone()
            return row["config"] if row and row["config"] else {}
    finally:
        conn.close()


@router.put("/plan")
def save_plan(body: dict):
    import json as _json
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO funding_plan (id, config, updated_at) VALUES ('default', %s, NOW()) "
                "ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()",
                (_json.dumps(body),),
            )
            conn.commit()
        return {"ok": True}
    finally:
        conn.close()
