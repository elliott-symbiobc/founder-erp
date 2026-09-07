"""
transfers.py — move a record between the two funding boards.

An investor and a funding opportunity are the same thing seen from two angles:
somebody who might give us money. Which board a record belongs on is a judgement
that changes — a VC turns out to run a grant programme, a "non-dilutive" accelerator
turns out to want equity — and until now the only way to act on that was to retype
the record and abandon its history.

The two shapes do not line up field for field, so the mapping is explicit and the
same code produces both the preview and the write. A preview that is generated
separately from the write is a preview that eventually lies.

Three kinds of field:

  mapped     a real destination column         firm -> title
  folded     no column, but worth keeping      fund size, geography, deadlines
             — written into one dated note on the new record
  dropped    meaningless on the other side     alignment scores, enrichment run
             state. Named in the response so the caller can say so out loud.

GET  /transfers/investor/{id}/preview            — what would happen
POST /transfers/investor/{id}/to-opportunity     — do it
GET  /transfers/opportunity/{id}/preview
POST /transfers/opportunity/{id}/to-investor
"""
import logging
import os
import re
import uuid
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException, Request

logger = logging.getLogger(__name__)


def get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])

router = APIRouter(prefix="/transfers", tags=["transfers"])

# The board columns each side offers, in board order.
OPPORTUNITY_STAGES = ["New", "In Progress", "Applied", "Won", "Rejected", "Withdrawn"]
INVESTOR_STAGES = ["Lead", "Prospect", "Qualification", "Negotiation", "Nurture",
                   "Closed Lost", "Closed Won"]

# Stage is a judgement the person transferring has to make, but an obvious
# default costs them a click. A record being worked as an application is
# In Progress; an investor arriving from the other board has not been worked
# as an investor yet, so it starts where new investors start.
DEFAULT_OPPORTUNITY_STAGE = "In Progress"
DEFAULT_INVESTOR_STAGE = "Prospect"


# ── Value conversion ─────────────────────────────────────────────────────────

_AMOUNT_RE = re.compile(
    r"(\d[\d,]*(?:\.\d+)?)\s*([kmb])?", re.IGNORECASE)
_MULTIPLIER = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}


def _amount_from_text(*candidates) -> Optional[float]:
    """The largest figure any of these strings mentions, or None.

    Investors record a check size as prose — "$500K–$2M", "up to 1.5m", "varies".
    An opportunity's amount is a number, and the number that matters is the
    ceiling: it is what the award is worth at best, which is the same thing the
    top of a check-size range means. Anything unparseable stays None and travels
    on as text in amount_notes instead, because a wrong number is worse than none.
    """
    best = None
    for text in candidates:
        if not text:
            continue
        for digits, suffix in _AMOUNT_RE.findall(str(text)):
            try:
                value = float(digits.replace(",", ""))
            except ValueError:
                continue
            value *= _MULTIPLIER.get((suffix or "").lower(), 1)
            # A bare year is not money. Check sizes below a thousand are almost
            # always a typo'd "500" meaning 500K, but guessing which is worse
            # than leaving it in the notes.
            if 1900 <= value <= 2100 and not suffix:
                continue
            if best is None or value > best:
                best = value
    return best


def _amount_to_text(amount, currency: Optional[str]) -> Optional[str]:
    """A numeric award as the prose an investor record expects."""
    if amount is None:
        return None
    symbol = {"USD": "$", "EUR": "€", "GBP": "£"}.get((currency or "USD").upper(), "")
    value = float(amount)
    if value >= 1_000_000:
        body = f"{value / 1_000_000:.2f}".rstrip("0").rstrip(".") + "M"
    elif value >= 1_000:
        body = f"{value / 1_000:.0f}K"
    else:
        body = f"{value:.0f}"
    return f"{symbol}{body}{'' if symbol else ' ' + (currency or '')}".strip()


# The enricher writes these words into a field it could not fill. Carrying them
# across would turn "we do not know the award" into a sentence that looks like
# an answer, so they are treated as the blanks they are.
_PLACEHOLDERS = {"unknown", "n/a", "na", "none", "tbd", "tbc", "-", "—", "not specified",
                 "not stated", "unspecified", "unrated"}


def _blank(value) -> bool:
    if value in (None, "", [], {}):
        return True
    return str(value).strip().lower() in _PLACEHOLDERS


def _folded_note(heading: str, pairs) -> Optional[str]:
    """One dated note carrying every field with no column to land in.

    Written rather than dropped because these are the fields somebody typed by
    hand — a deadline, a fund size, why we thought it was a fit — and losing
    them is what makes people distrust a transfer button.
    """
    lines = [f"**{label}:** {value}" for label, value in pairs if not _blank(value)]
    if not lines:
        return None
    return heading + "\n\n" + "\n".join(lines)


def _actor(request) -> Optional[str]:
    raw = request.headers.get("X-User-Id") if request else None
    if not raw:
        return None
    try:
        return str(uuid.UUID(raw))
    except (ValueError, AttributeError, TypeError):
        return None


# ── Plans ────────────────────────────────────────────────────────────────────
#
# A plan is the whole transfer decided in advance: the destination row, the
# note that catches everything the destination has no room for, and the list of
# fields nobody should expect to survive. Preview renders it; the write executes
# it. There is deliberately no second code path.

def _plan_investor_to_opportunity(inv: dict) -> dict:
    title = (inv.get("firm") or inv.get("name") or "Untitled").strip()
    amount = _amount_from_text(inv.get("check_size_max"), inv.get("avg_check_size"),
                               inv.get("check_size_min"))

    check_range = " – ".join(x for x in [inv.get("check_size_min"),
                                         inv.get("check_size_max")] if x)
    amount_notes = inv.get("avg_check_size") or check_range or None
    if amount is None and amount_notes:
        # Nothing parsed, so the prose is all there is; say so where the figure
        # would have been rather than leaving the field looking blank-by-choice.
        amount_notes = f"Check size: {amount_notes}"

    fields = {
        "title": title,
        # Investors are equity by definition — that is what puts them on that
        # board — so this is a fact about the record, not a guess.
        "dilution": "dilutive",
        "funding_type": inv.get("funding_type"),
        "amount": amount,
        "amount_notes": amount_notes,
        "source_link": inv.get("source_link") or inv.get("website"),
        "tags": list(inv.get("tags") or []),
        "assignee_id": inv.get("assigned_to"),
        "linked_project_id": inv.get("linked_project_id"),
        "next_action": None,
    }

    details = {
        "fit_rationale": inv.get("description"),
        "focus_areas": inv.get("focus"),
        # investment_stage is which rounds they back, which is not what
        # equity_taken asks. It goes in the note rather than the wrong column.
        "equity_taken": None,
        "program_contact": " · ".join(
            x for x in [inv.get("name"), inv.get("role"), inv.get("email")] if x) or None,
    }

    note = _folded_note(
        "Transferred from Investors.",
        [("Investor type", inv.get("investor_type") or inv.get("firm_type")),
         ("Primary contact", " · ".join(x for x in [inv.get("name"), inv.get("role")] if x)),
         ("Email", inv.get("email")),
         ("Phone", inv.get("office_phone") or inv.get("cell_phone")),
         ("HQ", inv.get("hq")),
         ("Address", inv.get("address")),
         ("Geographic focus", inv.get("geo_focus")),
         ("Investment stage", inv.get("investment_stage")),
         ("Fund size", inv.get("fund_size")),
         ("Fund launched", inv.get("fund_launch_year")),
         ("Check size", check_range or inv.get("avg_check_size")),
         ("Partners", inv.get("partners")),
         ("Portfolio", ", ".join(inv.get("portfolio") or []) or None),
         ("LinkedIn", inv.get("linkedin")),
         ("Portfolio page", inv.get("portfolio_url")),
         ("Website", inv.get("website")),
         ("Warm intro", inv.get("intro_type")),
         ("Intro notes", inv.get("intro_notes")),
         ("Notes", inv.get("notes")),
         ("Enrichment notes", inv.get("enrichment_notes")),
         ("Was", f"{inv.get('pipeline_stage') or '—'} · {inv.get('status') or 'no status'}")],
    )

    return {
        "fields": fields,
        "details": details,
        "note": note,
        "dropped": _dropped_investor_fields(inv),
    }


def _dropped_investor_fields(inv: dict) -> list:
    """Investor-only machinery with no meaning on an application."""
    out = []
    if inv.get("total_score") is not None:
        out.append("Alignment score and its five components")
    if inv.get("tier"):
        out.append(f"Tier ({inv['tier']})")
    if inv.get("is_priority"):
        out.append("Priority star")
    if inv.get("close_reason_code") or inv.get("closed_lost_reason"):
        out.append("Close reason")
    if inv.get("revisit_date"):
        out.append("Revisit date")
    out.append("Status history (the new record starts its own)")
    return out


def _plan_opportunity_to_investor(opp: dict, details: Optional[dict]) -> dict:
    details = details or {}
    fields = {
        "firm": (opp.get("title") or "Untitled").strip(),
        "funding_type": opp.get("funding_type"),
        "avg_check_size": _amount_to_text(opp.get("amount"), opp.get("amount_currency")),
        "source_link": opp.get("source_link"),
        "tags": list(opp.get("tags") or []),
        "assigned_to": opp.get("assignee_id"),
        "linked_project_id": opp.get("linked_project_id"),
        "description": details.get("fit_rationale"),
        "focus": details.get("focus_areas"),
        # firm_type is a free-text thesis descriptor ("Climate tech"), not a
        # category, and an opportunity carries nothing that answers it — so it
        # is left for a human rather than filled with a guess. investor_type is
        # the controlled vocabulary, where a grant programme is 'other'.
        "firm_type": None,
        "investor_type": "other" if opp.get("dilution") == "non-dilutive" else None,
    }

    note = _folded_note(
        "Transferred from Opportunities.",
        [("Stage there", opp.get("stage")),
         ("Award", " ".join(x for x in [
             _amount_to_text(opp.get("amount"), opp.get("amount_currency")),
             opp.get("amount_notes")] if x)),
         ("Dilution", opp.get("dilution")),
         ("Deadline", " ".join(x for x in [str(opp.get("deadline") or ""),
                                           opp.get("deadline_time") or ""]).strip() or None),
         ("Decision date", opp.get("decision_date")),
         ("Dispersion", opp.get("funding_dispersion")),
         ("Eligibility", opp.get("eligibility")),
         ("Cost share / match", opp.get("cost_share_match")),
         ("Open ERP fit", None if opp.get("org_fit") == "Unrated" else opp.get("org_fit")),
         ("Next action", opp.get("next_action")),
         ("Last verified", opp.get("last_verified")),
         ("Requirements", details.get("application_requirements")),
         ("Programme contact", details.get("program_contact")),
         ("Equity taken", details.get("equity_taken")),
         ("Sources", details.get("sources")),
         ("Known gaps", details.get("data_gaps"))],
    )

    dropped = []
    if opp.get("gcal_event_id"):
        dropped.append("Calendar event for the deadline")
    dropped.append("Stage history (the new record starts its own)")
    dropped.append("Application answers, if any")
    return {"fields": fields, "note": note, "dropped": dropped}


# ── Related records ──────────────────────────────────────────────────────────

def _related_counts(cur, entity_type: str, entity_id: str, *, notes_sql: str) -> dict:
    """How much history is hanging off this record, for the confirm dialog."""
    def one(sql, params):
        cur.execute(sql, params)
        return cur.fetchone()["c"]

    return {
        "emails": one("SELECT count(*) c FROM comm_messages "
                      "WHERE entity_type=%s AND entity_id=%s", (entity_type, entity_id)),
        "addresses": one("SELECT count(*) c FROM comm_addresses "
                         "WHERE entity_type=%s AND entity_id=%s", (entity_type, entity_id)),
        "scheduled": one("SELECT count(*) c FROM scheduled_emails "
                         "WHERE entity_type=%s AND entity_id=%s AND status IN ('scheduled','draft')",
                         (entity_type, entity_id)),
        "tasks": one("SELECT count(*) c FROM tasks WHERE source_ref=%s", (str(entity_id),)),
        "notes": one(notes_sql, (entity_id,)),
    }


def _move_comms(cur, *, from_type, from_id, to_type, to_id):
    """Re-key the email history onto the new record.

    Moved, not copied: it is one conversation with one counterparty, and having
    it answer to two records is how a timeline starts disagreeing with itself.
    The destination is always a record created moments ago, so the uniqueness
    guards can only fire on a retry — which is exactly when they should.
    """
    cur.execute(
        """DELETE FROM comm_messages src
            WHERE src.entity_type=%s AND src.entity_id=%s
              AND src.rfc_message_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM comm_messages dst
                           WHERE dst.entity_type=%s AND dst.entity_id=%s
                             AND dst.rfc_message_id = src.rfc_message_id)""",
        (from_type, from_id, to_type, to_id))
    cur.execute(
        "UPDATE comm_messages SET entity_type=%s, entity_id=%s "
        "WHERE entity_type=%s AND entity_id=%s",
        (to_type, to_id, from_type, from_id))
    moved = cur.rowcount

    cur.execute(
        """DELETE FROM comm_addresses src
            WHERE src.entity_type=%s AND src.entity_id=%s
              AND EXISTS (SELECT 1 FROM comm_addresses dst
                           WHERE dst.entity_type=%s AND dst.entity_id=%s
                             AND lower(dst.email) = lower(src.email))""",
        (from_type, from_id, to_type, to_id))
    cur.execute(
        "UPDATE comm_addresses SET entity_type=%s, entity_id=%s "
        "WHERE entity_type=%s AND entity_id=%s",
        (to_type, to_id, from_type, from_id))

    cur.execute(
        "UPDATE scheduled_emails SET entity_type=%s, entity_id=%s "
        "WHERE entity_type=%s AND entity_id=%s",
        (to_type, to_id, from_type, from_id))
    return moved


def _move_tasks(cur, from_id, to_id) -> int:
    """Tasks find their record through source_ref, so that is all there is to it."""
    cur.execute("UPDATE tasks SET source_ref=%s WHERE source_ref=%s",
                (str(to_id), str(from_id)))
    return cur.rowcount


def _copy_comms(cur, *, from_type, from_id, to_type, to_id) -> int:
    """Give the duplicate its own copy of the conversation.

    Legal where moving is not optional: uniqueness is per record, so the same
    email can sit on both. It does mean future mail from that address files to
    both records, which is the point of duplicating rather than an accident —
    but it is why the dialog asks rather than assuming.

    Queued sends are never copied. Two records holding the same scheduled email
    is two of that email arriving in somebody's inbox.
    """
    cur.execute(
        """INSERT INTO comm_messages
             (entity_type, entity_id, gmail_message_id, thread_id, direction,
              subject, snippet, from_email, to_emails, occurred_at, seen_by,
              sent_by_platform, kind, starts_at, ends_at, attendees, event_link,
              rfc_message_id, attachment_names, notes, mailbox_user_id)
           SELECT %s, %s::uuid, gmail_message_id, thread_id, direction,
                  subject, snippet, from_email, to_emails, occurred_at, seen_by,
                  sent_by_platform, kind, starts_at, ends_at, attendees, event_link,
                  rfc_message_id, attachment_names, notes, mailbox_user_id
             FROM comm_messages WHERE entity_type=%s AND entity_id=%s
           ON CONFLICT DO NOTHING""",
        (to_type, to_id, from_type, from_id))
    copied = cur.rowcount
    cur.execute(
        """INSERT INTO comm_addresses
             (entity_type, entity_id, email, contact_id, is_organizational, sendable)
           SELECT %s, %s::uuid, email, contact_id, is_organizational, sendable
             FROM comm_addresses WHERE entity_type=%s AND entity_id=%s
           ON CONFLICT DO NOTHING""",
        (to_type, to_id, from_type, from_id))
    return copied


def _copy_tasks(cur, from_id, to_id) -> int:
    """Duplicate the open work. Done tasks stay where they were done."""
    cur.execute(
        """INSERT INTO tasks
             (user_id, title, description, due_date, status, project_id, contact_id,
              source, source_ref, estimated_minutes, start_date, assigned_to,
              kanban_status, priority, activity_type, task_type)
           SELECT user_id, title, description, due_date, status, project_id, contact_id,
                  source, %s::text, estimated_minutes, start_date, assigned_to,
                  kanban_status, priority, activity_type, task_type
             FROM tasks WHERE source_ref = %s AND status = 'open'""",
        (str(to_id), str(from_id)))
    return cur.rowcount


# Moving takes everything by default — the record is leaving, so anything left
# behind is orphaned. Duplicating takes only what is safe to have twice: notes
# and contacts describe the counterparty and are true of both records, while a
# second copy of the mail history and the to-do list is work appearing twice.
_CARRY_ON_MOVE = {"emails": True, "notes": True, "tasks": True, "contacts": True}
_CARRY_ON_COPY = {"emails": False, "notes": True, "tasks": False, "contacts": True}


def _carry_test(carry: dict, keep_source: bool):
    defaults = _CARRY_ON_COPY if keep_source else _CARRY_ON_MOVE
    return lambda key: bool(carry.get(key, defaults.get(key, True)))


# ── Investor -> Opportunity ──────────────────────────────────────────────────

def _load_investor(cur, investor_id: str) -> dict:
    cur.execute("SELECT * FROM dilutive_investors WHERE investor_id=%s", (investor_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Investor not found")
    return dict(row)


@router.get("/investor/{investor_id}/preview")
def preview_investor_transfer(investor_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            inv = _load_investor(cur, investor_id)
            plan = _plan_investor_to_opportunity(inv)
            counts = _related_counts(
                cur, "investor", investor_id,
                notes_sql="SELECT count(*) c FROM dilutive_activities WHERE investor_id=%s")
            cur.execute("SELECT count(*) c FROM dilutive_investor_intro_contacts "
                        "WHERE investor_id=%s", (investor_id,))
            counts["intro_contacts"] = cur.fetchone()["c"]
            names = _user_names(cur)
            return {
                "direction": "investor_to_opportunity",
                "source_label": inv.get("firm") or inv.get("name") or "Untitled",
                "target_label": plan["fields"]["title"],
                "stages": OPPORTUNITY_STAGES,
                "default_stage": DEFAULT_OPPORTUNITY_STAGE,
                "mapped": [
                    {"from": f, "to": t, "value": _display(plan, key, names)}
                    for f, t, key in [
                        ("Firm", "Title", "title"),
                        ("Funding type", "Funding type", "funding_type"),
                        ("Check size", "Award amount", "amount"),
                        ("Source link", "Source link", "source_link"),
                        ("Tags", "Tags", "tags"),
                        ("Owner", "Assignee", "assignee_id"),
                        ("Description", "Fit rationale", "fit_rationale"),
                        ("Focus", "Focus areas", "focus_areas"),
                    ]
                ],
                "folded": bool(plan["note"]),
                "folded_preview": plan["note"],
                "dropped": plan["dropped"],
                "carries": counts,
            }
    finally:
        conn.close()


def _display(plan: dict, key: str, names: Optional[dict] = None):
    value = plan["fields"].get(key, plan.get("details", {}).get(key))
    if isinstance(value, list):
        return ", ".join(str(v) for v in value) or None
    # Owner fields hold a user id; a preview that prints a uuid at somebody is
    # not showing them what will happen.
    if names and key in ("assignee_id", "assigned_to") and value:
        return names.get(str(value), "Unassigned")
    return None if _blank(value) else value


def _user_names(cur) -> dict:
    cur.execute("SELECT user_id::text AS id, COALESCE(full_name, name, email) AS n FROM users")
    return {r["id"]: r["n"] for r in cur.fetchall()}


@router.post("/investor/{investor_id}/to-opportunity", status_code=201)
def transfer_investor_to_opportunity(investor_id: str, body: dict, request: Request = None):
    """Create the opportunity, hand it the investor's history, retire the investor.

    keep_source leaves the investor row in place. The email history and tasks
    still move — one conversation cannot belong to two records — so what stays
    behind is the investor's own fields and its scores, which is what somebody
    keeping it usually wants it for.
    """
    stage = body.get("stage") or DEFAULT_OPPORTUNITY_STAGE
    if stage not in OPPORTUNITY_STAGES:
        raise HTTPException(status_code=400, detail=f"Unknown stage: {stage}")
    keep_source = bool(body.get("keep_source"))
    carry = body.get("carry") or {}
    want = _carry_test(carry, keep_source)
    actor = _actor(request)

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            inv = _load_investor(cur, investor_id)
            plan = _plan_investor_to_opportunity(inv)
            f = plan["fields"]

            cur.execute(
                """INSERT INTO funding_opportunities
                     (title, stage, tags, funding_type, dilution, amount,
                      amount_currency, amount_notes, source_link, assignee_id,
                      linked_project_id)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   RETURNING opportunity_id""",
                (f["title"], stage, f["tags"], f["funding_type"], f["dilution"],
                 f["amount"], "USD", f["amount_notes"], f["source_link"],
                 f["assignee_id"], f["linked_project_id"]))
            oid = cur.fetchone()["opportunity_id"]

            # stage_from NULL is what the board reads as "created here".
            cur.execute(
                "INSERT INTO funding_stage_history "
                "(opportunity_id, stage_from, stage_to, changed_by) VALUES (%s,NULL,%s,%s)",
                (oid, stage, actor))

            d = plan["details"]
            if any(d.values()):
                cur.execute(
                    """INSERT INTO funding_opportunity_details
                         (opportunity_id, fit_rationale, focus_areas, equity_taken,
                          program_contact)
                       VALUES (%s,%s,%s,%s,%s)
                       ON CONFLICT (opportunity_id) DO UPDATE SET
                         fit_rationale = COALESCE(funding_opportunity_details.fit_rationale,
                                                  EXCLUDED.fit_rationale),
                         focus_areas   = COALESCE(funding_opportunity_details.focus_areas,
                                                  EXCLUDED.focus_areas),
                         equity_taken  = COALESCE(funding_opportunity_details.equity_taken,
                                                  EXCLUDED.equity_taken),
                         program_contact = COALESCE(funding_opportunity_details.program_contact,
                                                    EXCLUDED.program_contact)""",
                    (oid, d["fit_rationale"], d["focus_areas"], d["equity_taken"],
                     d["program_contact"]))

            if plan["note"]:
                cur.execute(
                    "INSERT INTO funding_notes (opportunity_id, body, author_id) "
                    "VALUES (%s,%s,%s)", (oid, plan["note"], actor))

            moved = {"emails": 0, "tasks": 0, "notes": 0, "contacts": 0}

            if want("notes"):
                # The investor's dated log becomes the opportunity's dated log.
                cur.execute(
                    """INSERT INTO funding_notes (opportunity_id, body, author_id, created_at)
                       SELECT %s::uuid,
                              CASE WHEN COALESCE(description,'') = '' THEN title
                                   ELSE title || E'\\n\\n' || description END,
                              owner_id, created_at
                         FROM dilutive_activities WHERE investor_id = %s""",
                    (oid, investor_id))
                moved["notes"] = cur.rowcount
                if not keep_source:
                    cur.execute("DELETE FROM dilutive_activities WHERE investor_id=%s",
                                (investor_id,))

            if want("contacts"):
                # Everyone tracked against the investor — the addresses the sync
                # matches on and anyone named as a warm intro.
                cur.execute(
                    """INSERT INTO funding_opportunity_contacts (opportunity_id, contact_id, role)
                       SELECT DISTINCT %s::uuid, contact_id, NULL FROM comm_addresses
                        WHERE entity_type='investor' AND entity_id=%s AND contact_id IS NOT NULL
                       ON CONFLICT DO NOTHING""",
                    (oid, investor_id))
                moved["contacts"] = cur.rowcount
                cur.execute(
                    """INSERT INTO funding_opportunity_contacts (opportunity_id, contact_id, role)
                       SELECT %s::uuid, contact_id, 'Warm intro'
                         FROM dilutive_investor_intro_contacts WHERE investor_id=%s
                       ON CONFLICT DO NOTHING""",
                    (oid, investor_id))
                moved["contacts"] += cur.rowcount

            if want("emails"):
                carry_comms = _copy_comms if keep_source else _move_comms
                moved["emails"] = carry_comms(cur, from_type="investor", from_id=investor_id,
                                              to_type="funding", to_id=oid)
            if want("tasks"):
                moved["tasks"] = (_copy_tasks if keep_source else _move_tasks)(
                    cur, investor_id, oid)

            if keep_source:
                cur.execute(
                    "UPDATE dilutive_investors SET notes = "
                    "COALESCE(NULLIF(notes,'') || E'\\n\\n', '') || %s, updated_at=NOW() "
                    "WHERE investor_id=%s",
                    (f"Duplicated onto the Opportunities board on {_today(cur)}.",
                     investor_id))
            else:
                cur.execute("DELETE FROM dilutive_investors WHERE investor_id=%s",
                            (investor_id,))

            conn.commit()
            return {"opportunity_id": str(oid), "moved": moved,
                    "source_kept": keep_source, "stage": stage}
    finally:
        conn.close()


# ── Opportunity -> Investor ──────────────────────────────────────────────────

def _load_opportunity(cur, opportunity_id: str):
    cur.execute("SELECT * FROM funding_opportunities WHERE opportunity_id=%s",
                (opportunity_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    cur.execute("SELECT * FROM funding_opportunity_details WHERE opportunity_id=%s",
                (opportunity_id,))
    det = cur.fetchone()
    return dict(row), (dict(det) if det else None)


@router.get("/opportunity/{opportunity_id}/preview")
def preview_opportunity_transfer(opportunity_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            opp, det = _load_opportunity(cur, opportunity_id)
            plan = _plan_opportunity_to_investor(opp, det)
            counts = _related_counts(
                cur, "funding", opportunity_id,
                notes_sql="SELECT count(*) c FROM funding_notes WHERE opportunity_id=%s")
            cur.execute("SELECT count(*) c FROM funding_opportunity_contacts "
                        "WHERE opportunity_id=%s", (opportunity_id,))
            counts["contacts"] = cur.fetchone()["c"]
            cur.execute("SELECT name FROM dilutive_statuses ORDER BY sort_order")
            statuses = [r["name"] for r in cur.fetchall()]
            names = _user_names(cur)
            return {
                "direction": "opportunity_to_investor",
                "source_label": opp.get("title"),
                "target_label": plan["fields"]["firm"],
                "stages": INVESTOR_STAGES,
                "default_stage": DEFAULT_INVESTOR_STAGE,
                "statuses": statuses,
                "default_status": statuses[0] if statuses else None,
                "mapped": [
                    {"from": f, "to": t, "value": _display(plan, key, names)}
                    for f, t, key in [
                        ("Title", "Firm", "firm"),
                        ("Funding type", "Funding type", "funding_type"),
                        ("Award amount", "Average check size", "avg_check_size"),
                        ("Source link", "Source link", "source_link"),
                        ("Tags", "Tags", "tags"),
                        ("Assignee", "Owner", "assigned_to"),
                        ("Fit rationale", "Description", "description"),
                        ("Focus areas", "Focus", "focus"),
                    ]
                ],
                "folded": bool(plan["note"]),
                "folded_preview": plan["note"],
                "dropped": plan["dropped"],
                "carries": counts,
            }
    finally:
        conn.close()


@router.post("/opportunity/{opportunity_id}/to-investor", status_code=201)
def transfer_opportunity_to_investor(opportunity_id: str, body: dict, request: Request = None):
    stage = body.get("stage") or DEFAULT_INVESTOR_STAGE
    if stage not in INVESTOR_STAGES:
        raise HTTPException(status_code=400, detail=f"Unknown stage: {stage}")
    keep_source = bool(body.get("keep_source"))
    carry = body.get("carry") or {}
    want = _carry_test(carry, keep_source)
    actor = _actor(request)

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            opp, det = _load_opportunity(cur, opportunity_id)
            plan = _plan_opportunity_to_investor(opp, det)
            f = plan["fields"]

            cur.execute("SELECT name FROM dilutive_statuses ORDER BY sort_order LIMIT 1")
            first_status = (cur.fetchone() or {}).get("name")
            status = body.get("status") or first_status

            # Lead is the unworked pool; anything past it is being worked, and a
            # record being worked belongs on the priority board.
            is_priority = body.get("is_priority")
            if is_priority is None:
                is_priority = stage != "Lead"

            cur.execute(
                """INSERT INTO dilutive_investors
                     (firm, firm_type, investor_type, status, pipeline_stage,
                      is_priority, funding_type, avg_check_size, source_link, tags,
                      assigned_to, linked_project_id, description, focus)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   RETURNING investor_id""",
                (f["firm"], f["firm_type"], f["investor_type"], status, stage,
                 bool(is_priority), f["funding_type"], f["avg_check_size"],
                 f["source_link"], f["tags"], f["assigned_to"],
                 f["linked_project_id"], f["description"], f["focus"]))
            iid = cur.fetchone()["investor_id"]

            # status_from NULL is what the History feed reads as "started here".
            # Both ladders get an opening entry: the board tracks stage, the
            # panel tracks status, and a record with neither looks like a bug.
            cur.execute(
                "INSERT INTO dilutive_status_history "
                "(investor_id, status_from, status_to, changed_by, kind) "
                "VALUES (%s,NULL,%s,%s,'status')",
                (iid, status, actor))
            cur.execute(
                "INSERT INTO dilutive_status_history "
                "(investor_id, status_from, status_to, changed_by, kind) "
                "VALUES (%s,NULL,%s,%s,'stage')",
                (iid, stage, actor))

            if plan["note"]:
                cur.execute(
                    """INSERT INTO dilutive_activities
                         (investor_id, title, description, owner_id)
                       VALUES (%s, 'Transferred from Opportunities', %s, %s)""",
                    (iid, plan["note"], actor))

            moved = {"emails": 0, "tasks": 0, "notes": 0, "contacts": 0}

            if want("notes"):
                cur.execute(
                    """INSERT INTO dilutive_activities
                         (investor_id, title, description, owner_id, activity_date, created_at)
                       SELECT %s::uuid, 'Note', body, author_id, created_at::date, created_at
                         FROM funding_notes WHERE opportunity_id=%s""",
                    (iid, opportunity_id))
                moved["notes"] = cur.rowcount
                if not keep_source:
                    cur.execute("DELETE FROM funding_notes WHERE opportunity_id=%s",
                                (opportunity_id,))

            if want("contacts"):
                # An opportunity's contacts become tracked addresses, which is
                # both how the panel lists them and what the Gmail sync matches
                # on — so the new record starts already watching the right mail.
                from app.tasks.comm_sync import ensure_contact_address
                cur.execute(
                    """SELECT c.contact_id, c.name, c.email, c.organization, foc.role
                         FROM funding_opportunity_contacts foc
                         JOIN contacts c ON c.contact_id = foc.contact_id
                        WHERE foc.opportunity_id=%s""",
                    (opportunity_id,))
                for row in cur.fetchall():
                    if not row["email"]:
                        continue
                    try:
                        ensure_contact_address(
                            cur, "investor", str(iid), email=row["email"],
                            name=row["name"], role=row["role"],
                            organization=row["organization"] or f["firm"])
                        moved["contacts"] += 1
                    except Exception:
                        logger.exception("contact %s did not transfer", row["contact_id"])

            if want("emails"):
                carry_comms = _copy_comms if keep_source else _move_comms
                moved["emails"] = carry_comms(cur, from_type="funding", from_id=opportunity_id,
                                              to_type="investor", to_id=iid)
            if want("tasks"):
                moved["tasks"] = (_copy_tasks if keep_source else _move_tasks)(
                    cur, opportunity_id, iid)

            if keep_source:
                cur.execute(
                    "INSERT INTO funding_notes (opportunity_id, body, author_id) "
                    "VALUES (%s,%s,%s)",
                    (opportunity_id,
                     "Duplicated onto the Investors board.", actor))
            else:
                cur.execute("DELETE FROM funding_opportunities WHERE opportunity_id=%s",
                            (opportunity_id,))

            conn.commit()
            return {"investor_id": str(iid), "moved": moved,
                    "source_kept": keep_source, "stage": stage, "status": status}
    finally:
        conn.close()


def _today(cur) -> str:
    cur.execute("SELECT to_char(CURRENT_DATE, 'DD Mon YYYY') AS d")
    return cur.fetchone()["d"]
