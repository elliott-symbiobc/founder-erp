"""
lead_scorer.py — Rule-based lead priority scoring.

Scores each lead 0–100 based on company profile and ICP match.
Writes priority_score (int) and score_breakdown (JSONB) back to the lead row.
Does NOT overwrite manually-set priority unless auto_override=True.

─── Scoring criteria (edit here to tune) ────────────────────────────────────
  Company size        0–25 pts   (employee_count or tier_size)
  Revenue             0–25 pts   (est_revenue string parsed to $M)
  Contact quality     0–20 pts   (contacts with emails found)
  ICP match           0–15 pts   (industry + region)
  Engagement          0–10 pts   (mutual connection, recommended action)
  Enrichment          0–5  pts   (data completeness bonus)
─────────────────────────────────────────────────────────────────────────────
"""

import json
import logging
import os
import re
from typing import Optional

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)

# ── Configurable criteria ─────────────────────────────────────────────────────

# Default keywords — overridden by DB scoring_config if present
_DEFAULT_INDUSTRY_KEYWORDS = [
    "food", "bak", "confection", "flour", "grain", "cereal", "pastry",
    "snack", "beverage", "ingredient", "dairy", "agriculture",
]

_DEFAULT_WEIGHTS = {
    "company_size": 25, "revenue": 20, "contact_quality": 15,
    "icp_match": 15, "warm_connection": 15, "engagement": 5, "completeness": 5,
}

# Module-level cache (refreshed each score_leads call)
INDUSTRY_KEYWORDS = list(_DEFAULT_INDUSTRY_KEYWORDS)

# Tier-size keyword → approximate employee midpoint
TIER_SIZE_MAP = {
    "enterprise": 5000,
    "large": 1000,
    "mid": 400,
    "medium": 400,
    "small": 75,
    "micro": 15,
}


# ── Revenue parser ────────────────────────────────────────────────────────────

def _parse_revenue_millions(s: str) -> Optional[float]:
    """Parse strings like '$50M–100M', '$1B+', '200 million' → float in $M."""
    if not s:
        return None
    s = s.lower().replace(",", "").replace("$", "").strip()
    # billions
    m = re.search(r"(\d+(?:\.\d+)?)\s*b", s)
    if m:
        return float(m.group(1)) * 1000
    # millions
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:m|million)", s)
    if m:
        return float(m.group(1))
    # plain large number
    m = re.search(r"(\d+(?:\.\d+)?)", s)
    if m:
        v = float(m.group(1))
        return v if v >= 1 else None
    return None


# ── Core scoring ──────────────────────────────────────────────────────────────

def score_lead(lead: dict, icp: dict, weights: dict = None, industry_keywords: list = None) -> tuple[int, dict]:
    """
    Returns (score 0–100, breakdown dict).
    breakdown keys match criteria names with points awarded and max possible.
    weights: dict of {category: max_pts} — defaults to _DEFAULT_WEIGHTS.
    """
    if weights is None:
        weights = _DEFAULT_WEIGHTS
    if industry_keywords is None:
        industry_keywords = INDUSTRY_KEYWORDS

    breakdown = {}
    W = weights  # shorthand

    # ── 1. Company size ──────────────────────────────────────────────────────
    max_s = W.get("company_size", 25)
    emp = lead.get("employee_count")
    size_pts = 0
    if emp:
        if emp >= 2000:   size_pts = max_s
        elif emp >= 1000: size_pts = round(max_s * 0.80)
        elif emp >= 500:  size_pts = round(max_s * 0.56)
        elif emp >= 200:  size_pts = round(max_s * 0.32)
        elif emp >= 50:   size_pts = round(max_s * 0.16)
    else:
        ts = (lead.get("tier_size") or "").lower()
        for keyword, approx_emp in TIER_SIZE_MAP.items():
            if keyword in ts:
                if approx_emp >= 2000:   size_pts = max_s
                elif approx_emp >= 1000: size_pts = round(max_s * 0.80)
                elif approx_emp >= 500:  size_pts = round(max_s * 0.56)
                elif approx_emp >= 200:  size_pts = round(max_s * 0.32)
                else:                    size_pts = round(max_s * 0.16)
                break
    breakdown["company_size"] = size_pts

    # ── 2. Revenue ───────────────────────────────────────────────────────────
    max_r = W.get("revenue", 25)
    rev_m = _parse_revenue_millions(lead.get("est_revenue") or "")
    rev_pts = 0
    if rev_m:
        if rev_m >= 1000:  rev_pts = max_r
        elif rev_m >= 500: rev_pts = round(max_r * 0.80)
        elif rev_m >= 100: rev_pts = round(max_r * 0.60)
        elif rev_m >= 50:  rev_pts = round(max_r * 0.40)
        elif rev_m >= 10:  rev_pts = round(max_r * 0.20)
    breakdown["revenue"] = rev_pts

    # ── 3. Contact quality ───────────────────────────────────────────────────
    max_c = W.get("contact_quality", 20)
    contacts = lead.get("contacts") or []
    if isinstance(contacts, str):
        try:
            contacts = json.loads(contacts)
        except Exception:
            contacts = []
    with_email = sum(1 for c in contacts if c.get("email"))
    contact_pts = 0
    if with_email >= 3:       contact_pts = max_c
    elif with_email >= 2:     contact_pts = round(max_c * 0.80)
    elif with_email >= 1:     contact_pts = round(max_c * 0.60)
    elif len(contacts) >= 1:  contact_pts = round(max_c * 0.25)
    breakdown["contact_quality"] = contact_pts

    # ── 4. ICP match ─────────────────────────────────────────────────────────
    max_i = W.get("icp_match", 15)
    icp_pts = 0
    industry = (lead.get("industry") or "").lower()
    key_products = (lead.get("key_products") or "").lower()
    icp_industries = [s.lower() for s in (icp.get("target_industries") or [])]
    industry_hit = (
        any(kw in industry for kw in industry_keywords) or
        any(kw in key_products for kw in industry_keywords) or
        any(ind in industry for ind in icp_industries if ind)
    )
    if industry_hit:
        icp_pts += round(max_i * 0.53)
    icp_regions = [r.lower() for r in (icp.get("target_regions") or [])]
    lead_region = (lead.get("region") or "").lower()
    if icp_regions and any(r in lead_region or lead_region in r for r in icp_regions):
        icp_pts += round(max_i * 0.47)
    elif not icp_regions:
        icp_pts += round(max_i * 0.27)
    breakdown["icp_match"] = icp_pts

    # ── 5. Warm connection ───────────────────────────────────────────────────
    max_w = W.get("warm_connection", 15)
    warm_pts = max_w if lead.get("mutual_connection") else 0
    breakdown["warm_connection"] = warm_pts

    # ── 6. Engagement ────────────────────────────────────────────────────────
    max_e = W.get("engagement", 5)
    eng_pts = 0
    if lead.get("recommended_action"): eng_pts += round(max_e * 0.50)
    if lead.get("org_fit"):         eng_pts += round(max_e * 0.50)
    breakdown["engagement"] = eng_pts

    # ── 7. Completeness ──────────────────────────────────────────────────────
    max_k = W.get("completeness", 5)
    comp_pts = 0
    if lead.get("enrichment_status") == "enriched": comp_pts += round(max_k * 0.60)
    if lead.get("website"):                          comp_pts += round(max_k * 0.20)
    if lead.get("description"):                      comp_pts += round(max_k * 0.20)
    breakdown["completeness"] = comp_pts

    total = sum(v for k, v in breakdown.items())
    total = min(total, 100)
    breakdown["total"] = total
    # store max per category so frontend can render progress bars
    breakdown["_max"] = {k: W.get(k, 0) for k in ["company_size", "revenue", "contact_quality", "icp_match", "warm_connection", "engagement", "completeness"]}
    return total, breakdown


# ── DB helpers ────────────────────────────────────────────────────────────────

def _conn():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def _load_icp(system_id=None):
    conn = _conn()
    try:
        cur = conn.cursor()
        if system_id:
            cur.execute("SELECT * FROM icp_profile WHERE system_id=%s::uuid", [system_id])
        else:
            cur.execute("SELECT * FROM icp_profile WHERE id=1")
        row = cur.fetchone()
        return dict(row) if row else {}
    finally:
        conn.close()


def _load_scoring_config(system_id=None):
    """Returns (weights dict, industry_keywords list) from DB, falling back to defaults."""
    conn = _conn()
    try:
        cur = conn.cursor()
        if system_id:
            cur.execute("SELECT weights, industry_keywords FROM scoring_config WHERE system_id=%s::uuid", [system_id])
        else:
            cur.execute("SELECT weights, industry_keywords FROM scoring_config WHERE id=1")
        row = cur.fetchone()
        if not row:
            return dict(_DEFAULT_WEIGHTS), list(_DEFAULT_INDUSTRY_KEYWORDS)
        w = dict(row["weights"]) if row["weights"] else dict(_DEFAULT_WEIGHTS)
        kw = list(row["industry_keywords"]) if row["industry_keywords"] else list(_DEFAULT_INDUSTRY_KEYWORDS)
        return w, kw
    except Exception:
        return dict(_DEFAULT_WEIGHTS), list(_DEFAULT_INDUSTRY_KEYWORDS)
    finally:
        conn.close()


# ── Public entry point ────────────────────────────────────────────────────────

def score_leads(lead_ids: list = None, system_id: str = None) -> dict:
    """
    Score leads and write priority_score + score_breakdown back to DB.
    lead_ids=None → score all non-archived leads.
    system_id → use ICP/scoring config for that system.
    """
    conn = _conn()
    try:
        cur = conn.cursor()
        if lead_ids:
            cur.execute(
                "SELECT * FROM sales_leads WHERE id = ANY(%s::uuid[]) AND archived=false",
                [lead_ids],
            )
        else:
            cur.execute("SELECT * FROM sales_leads WHERE archived=false")
        leads = [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()
    # Infer system_id from first lead if not provided
    if not system_id and leads:
        sid = leads[0].get("system_id")
        system_id = str(sid) if sid else None
    icp = _load_icp(system_id)
    weights, industry_keywords = _load_scoring_config(system_id)
    # Update module-level keywords so score_lead default picks them up
    global INDUSTRY_KEYWORDS
    INDUSTRY_KEYWORDS = industry_keywords

    results = []
    conn = _conn()
    try:
        cur = conn.cursor()
        for lead in leads:
            score, breakdown = score_lead(lead, icp, weights=weights, industry_keywords=industry_keywords)
            cur.execute(
                "UPDATE sales_leads SET priority_score=%s, score_breakdown=%s::jsonb, updated_at=now() WHERE id=%s",
                [score, json.dumps(breakdown), lead["id"]],
            )
            results.append({"id": str(lead["id"]), "company": lead["company"], "score": score})
            logger.info("Scored %s: %d", lead["company"], score)
        conn.commit()
    finally:
        conn.close()

    return {"scored": len(results), "results": results}
