"""
mutual_connection_agent.py — Cross-references sales leads against contacts DB to find warm connections.

Two-tier approach:
  Tier 1 (free): Direct org match — contacts whose organization matches a lead company name.
  Tier 2 (Coresignal, ~10 GW credits/profile): Fetch lead contacts' LinkedIn employment history,
          cross-reference past employers against all contacts' organizations.

Results are written to sales_leads.mutual_connection and the warm_connection score category.
"""

import json
import logging
import os
import re
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone
from typing import Optional

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)


# ── DB helpers ────────────────────────────────────────────────────────────────

def _conn():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def _load_leads(lead_ids=None, unchecked_only=False):
    conn = _conn()
    try:
        cur = conn.cursor()
        if lead_ids:
            cur.execute(
                "SELECT id, company, contacts, mutual_connection FROM sales_leads "
                "WHERE id = ANY(%s::uuid[]) AND archived=false",
                [lead_ids],
            )
        elif unchecked_only:
            cur.execute(
                "SELECT id, company, contacts, mutual_connection FROM sales_leads "
                "WHERE archived=false AND mutual_connection_checked_at IS NULL "
                "ORDER BY company"
            )
        else:
            cur.execute(
                "SELECT id, company, contacts, mutual_connection FROM sales_leads "
                "WHERE archived=false ORDER BY company"
            )
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def _load_contacts():
    """Load all active contacts with name, title, organization, linkedin_url."""
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT contact_id, name, title, organization, linkedin_url, email "
            "FROM contacts WHERE archived=false AND organization IS NOT NULL AND organization != '' "
            "ORDER BY name"
        )
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def _save_result(lead_id: str, mutual_connection: Optional[str]):
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE sales_leads SET mutual_connection=%s, mutual_connection_checked_at=now(), updated_at=now() WHERE id=%s",
            [mutual_connection, lead_id],
        )
        conn.commit()
    finally:
        conn.close()


# ── Company name normalization ────────────────────────────────────────────────

_STRIP_WORDS = re.compile(
    r"\b(inc|llc|ltd|corp|corporation|company|co|group|holdings|international|"
    r"usa|us|north america|na|bakeries|bakery|baking|foods|food|solutions|"
    r"products|services|industries|enterprises|the)\b",
    re.IGNORECASE,
)
_WHITESPACE = re.compile(r"\s+")


def _normalize(name: str) -> str:
    name = name.lower().strip()
    name = re.sub(r"[^\w\s]", " ", name)
    name = _STRIP_WORDS.sub(" ", name)
    return _WHITESPACE.sub(" ", name).strip()


def _companies_match(a: str, b: str) -> bool:
    """Return True if two company names are likely the same entity."""
    if not a or not b:
        return False
    na, nb = _normalize(a), _normalize(b)
    if not na or not nb:
        return False
    # Exact normalized match
    if na == nb:
        return True
    # One contains the other as whole words (handles "General Mills" ↔ "Pillsbury (General Mills)").
    # Word-boundary check prevents "rise" matching inside "enterprise" or "alpha" inside "hudsonalpha".
    if len(na) >= 6 and len(nb) >= 6:
        if (re.search(r"\b" + re.escape(na) + r"\b", nb) or
                re.search(r"\b" + re.escape(nb) + r"\b", na)):
            return True
    return False


# ── GooseWorks / Coresignal ───────────────────────────────────────────────────

def _gw_api_key() -> str:
    creds_path = os.path.expanduser("~/.gooseworks/credentials.json")
    try:
        with open(creds_path) as f:
            return json.load(f)["api_key"]
    except Exception:
        return os.environ.get("GOOSEWORKS_API_KEY", "")


def _fetch_coresignal_profile(linkedin_url: str) -> Optional[dict]:
    """Fetch a Coresignal multi-source employee profile. Returns the JSON dict or None."""
    api_key = _gw_api_key()
    if not api_key:
        logger.warning("GooseWorks API key not found; skipping Coresignal lookup")
        return None
    encoded_url = urllib.parse.quote(linkedin_url.rstrip("/"), safe="")
    url = f"https://api.gooseworks.ai/v1/proxy/coresignal/v2/employee_multi_source/collect/{encoded_url}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")[:200]
        logger.warning("Coresignal %s → HTTP %d: %s", linkedin_url, e.code, body)
        return None
    except Exception as e:
        logger.warning("Coresignal %s → %s", linkedin_url, e)
        return None


def _get_past_companies(profile: dict) -> list[str]:
    """Extract past (non-active) employer names from a Coresignal profile."""
    exp = profile.get("experience") or []
    if not isinstance(exp, list):
        return []
    companies = []
    for e in exp:
        if not isinstance(e, dict):
            continue
        if e.get("active_experience"):
            continue  # skip current role
        name = e.get("company_name", "").strip()
        if name:
            companies.append(name)
    return companies


# ── Per-lead connection check ─────────────────────────────────────────────────

def _check_lead(lead: dict, contacts: list) -> Optional[str]:
    """
    Returns a human-readable mutual connection string if found, else None.
    Writes the result (including None) to sales_leads.mutual_connection.
    """
    company = lead["company"]
    lead_contacts_raw = lead.get("contacts") or []
    if isinstance(lead_contacts_raw, str):
        try:
            lead_contacts_raw = json.loads(lead_contacts_raw)
        except Exception:
            lead_contacts_raw = []

    # ── Tier 1: Direct org match ──────────────────────────────────────────────
    direct = [
        c for c in contacts
        if _companies_match(c.get("organization", ""), company)
    ]
    if direct:
        c = direct[0]
        result = f"{c['name']} ({c.get('title') or c.get('organization')}) is in your network at {company}"
        logger.info("Tier-1 match [%s]: %s", company, result)
        return result

    # ── Tier 2: Coresignal employment history ────────────────────────────────
    for lc in lead_contacts_raw:
        li_url = lc.get("linkedin", "").strip()
        if not li_url or "linkedin.com" not in li_url:
            continue

        logger.info("Coresignal lookup for %s @ %s (%s)", lc.get("name"), company, li_url)
        profile = _fetch_coresignal_profile(li_url)
        if not profile:
            continue

        past_cos = _get_past_companies(profile)
        for past_co in past_cos:
            for c in contacts:
                if _companies_match(c.get("organization", ""), past_co):
                    result = (
                        f"{lc.get('name')} ({lc.get('title')} at {company}) "
                        f"previously worked at {past_co} — "
                        f"{c['name']} ({c.get('title') or c.get('organization')}) "
                        f"is in your network there"
                    )
                    logger.info("Tier-2 match [%s]: %s", company, result)
                    return result

    return None


# ── Public entry point ────────────────────────────────────────────────────────

def run_mutual_connections(lead_ids: Optional[list] = None, unchecked_only: bool = True) -> dict:
    """
    Check all leads (or a subset) for mutual connections with the contacts DB.
    Updates sales_leads.mutual_connection for each lead checked.
    Returns a summary dict.
    """
    contacts = _load_contacts()
    leads = _load_leads(lead_ids=lead_ids, unchecked_only=unchecked_only)

    if not leads:
        return {"checked": 0, "found": 0, "message": "No leads to check"}

    logger.info("Checking %d leads for mutual connections against %d contacts", len(leads), len(contacts))

    found = 0
    for lead in leads:
        try:
            result = _check_lead(lead, contacts)
            _save_result(str(lead["id"]), result)
            if result:
                found += 1
                logger.info("Found connection for %s: %s", lead["company"], result)
            else:
                logger.info("No connection found for %s", lead["company"])
        except Exception as e:
            logger.error("Error checking %s: %s", lead["company"], e)

    return {
        "checked": len(leads),
        "found": found,
        "not_found": len(leads) - found,
    }
