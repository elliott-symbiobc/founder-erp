"""
investor_discovery_agent.py — Investor discovery agent.

Queries Fundable POST /investors with biotech/food/synbio filters,
deduplicates against existing dilutive_investors, and bulk-inserts net-new records.

Cost: $0.66/call dynamic pricing for POST /investors (up to 100 results per page).
A full discovery run (4 pages × 100) costs ~$2.64.
"""

import json
import logging
import os
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Optional

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)

# Fundable industry permalinks relevant to Open ERP
OPENERP_INDUSTRIES = [
    "biotechnology",
    "food-and-beverage",
    "plant-based-foods",
    "agriculture",
    "food-processing",
    "health-care",
    "pharmaceuticals",
    "synthetic-biology",
    "organic-food",
]

# Minimum deal count in last 12 months to filter out inactive investors
MIN_RECENT_DEALS = 1

_GW_BASE = "https://api.gooseworks.ai/v1/proxy/orthogonal"


# ── DB helpers ────────────────────────────────────────────────────────────────

def _conn():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def _gw_api_key() -> str:
    creds_path = os.path.expanduser("~/.gooseworks/credentials.json")
    try:
        with open(creds_path) as f:
            return json.load(f)["api_key"]
    except Exception:
        return os.environ.get("GOOSEWORKS_API_KEY", "")


def _get_existing_keys() -> set:
    """Return set of (domain, firm_name_lower) tuples for dedup."""
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT LOWER(COALESCE(website, '')), LOWER(COALESCE(firm, '')) FROM dilutive_investors")
        keys = set()
        for domain_raw, firm_lower in cur.fetchall():
            # extract domain from website URL
            import re
            m = re.search(r"https?://(?:www\.)?([^/]+)", domain_raw or "")
            domain = m.group(1).lower() if m else ""
            if domain:
                keys.add(("domain", domain))
            if firm_lower:
                keys.add(("firm", firm_lower))
        return keys
    finally:
        conn.close()


def _is_duplicate(investor: dict, existing_keys: set) -> bool:
    """Return True if investor already exists in DB."""
    import re
    domain = investor.get("domain", "") or ""
    name = (investor.get("name") or "").lower()
    website = investor.get("website") or ""
    if not domain and website:
        m = re.search(r"https?://(?:www\.)?([^/]+)", website)
        domain = m.group(1).lower() if m else ""

    if domain and ("domain", domain.lower()) in existing_keys:
        return True
    if name and ("firm", name) in existing_keys:
        return True
    return False


def _insert_investors(investors: list) -> int:
    """Insert net-new investors. Returns count inserted."""
    if not investors:
        return 0

    conn = _conn()
    inserted = 0
    try:
        with conn.cursor() as cur:
            for inv in investors:
                loc = inv.get("location") or {}
                city = (loc.get("city") or {}).get("name", "")
                country = (loc.get("country") or {}).get("name", "")
                hq = f"{city}, {country}".strip(", ") if city or country else None

                # Build focus from top_industries
                top_ind = [i["name"] for i in (inv.get("top_industries") or [])[:5]]
                focus = ", ".join(top_ind) if top_ind else None

                # Build geo_focus from top_locations
                top_loc = list({(l.get("full_name") or l.get("name", "")).split(",")[0].strip()
                                for l in (inv.get("top_locations") or [])[:3]})
                geo_focus = ", ".join(top_loc) if top_loc else None

                website = inv.get("website") or None
                linkedin = inv.get("linkedin") or None
                description = inv.get("description") or None
                firm = inv.get("name") or ""

                cur.execute("""
                    INSERT INTO dilutive_investors
                        (firm, firm_type, hq, geo_focus, focus, website, linkedin,
                         description, status, source_link, notes)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                """, [
                    firm, "VC", hq, geo_focus, focus, website, linkedin,
                    description,
                    "New",        # default status
                    inv.get("crunchbase") or inv.get("pitchbook"),
                    f"Discovered via Fundable discovery agent on {datetime.now(timezone.utc).date().isoformat()}. "
                    f"Deal count (12mo): {inv.get('deal_count_last_12_months', 0)}",
                ])
                if cur.rowcount:
                    inserted += 1
        conn.commit()
    finally:
        conn.close()
    return inserted


# ── Fundable API call ─────────────────────────────────────────────────────────

def _fundable_post(body: dict) -> dict:
    key = _gw_api_key()
    if not key:
        return {"error": "GooseWorks API key not found"}

    payload = {"api": "fundable", "path": "/investors", "method": "POST", "body": body}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{_GW_BASE}/run",
        data=data,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8")[:400]
        return {"error": f"HTTP {e.code}: {body_text}"}
    except Exception as e:
        return {"error": str(e)}


# ── Discovery run ─────────────────────────────────────────────────────────────

def run_discovery(
    max_pages: int = 4,
    page_size: int = 100,
    industries: Optional[list] = None,
    locations: Optional[list] = None,
    min_recent_deals: int = MIN_RECENT_DEALS,
) -> dict:
    """
    Discover net-new investors via Fundable filter search.

    Args:
        max_pages: Number of pages to fetch (each page costs ~$0.66)
        page_size: Results per page (max 100)
        industries: Fundable industry permalinks (defaults to OPENERP_INDUSTRIES)
        locations: Fundable location permalinks (e.g. ['north-america', 'united-states'])
        min_recent_deals: Filter out investors with fewer than N deals in last 12 months

    Returns:
        dict with fetched, duplicates, inserted, pages, errors, credits_used
    """
    if industries is None:
        industries = OPENERP_INDUSTRIES

    existing_keys = _get_existing_keys()
    logger.info("Discovery: existing DB keys loaded (%d)", len(existing_keys))

    total_fetched = 0
    total_dupes = 0
    total_inserted = 0
    total_credits = 0.0
    all_new = []
    errors = []

    for page in range(max_pages):
        body = {
            "company_investments": {
                "industries": industries,
                "min_matching_deals": min_recent_deals,
            },
            "page": page,
            "page_size": page_size,
            "sort_by": "most_recent_deal",
        }
        if locations:
            body["investor"] = {"locations": locations}

        logger.info("Discovery page %d/%d (industries=%s)", page + 1, max_pages, industries[:3])
        result = _fundable_post(body)

        if result.get("error"):
            errors.append({"page": page, "error": result["error"]})
            logger.error("Discovery page %d error: %s", page, result["error"])
            continue

        total_credits += 0.66  # approximate per-call cost

        data = result.get("data") or {}
        investors = data.get("investors") or []
        total_fetched += len(investors)

        net_new = []
        for inv in investors:
            # Filter by recent activity
            if (inv.get("deal_count_last_12_months") or 0) < min_recent_deals:
                continue
            if _is_duplicate(inv, existing_keys):
                total_dupes += 1
                continue

            net_new.append(inv)
            # Add to existing_keys so we don't double-insert across pages
            import re
            domain = inv.get("domain", "") or ""
            website = inv.get("website") or ""
            if not domain and website:
                m = re.search(r"https?://(?:www\.)?([^/]+)", website)
                domain = m.group(1).lower() if m else ""
            if domain:
                existing_keys.add(("domain", domain.lower()))
            name = (inv.get("name") or "").lower()
            if name:
                existing_keys.add(("firm", name))

        all_new.extend(net_new)
        logger.info("Page %d: %d fetched, %d new (running total: %d new)",
                    page + 1, len(investors), len(net_new), len(all_new))

        # Stop if we're getting empty pages
        if len(investors) < page_size:
            break

    # Bulk insert all net-new
    if all_new:
        total_inserted = _insert_investors(all_new)

    return {
        "fetched": total_fetched,
        "duplicates_skipped": total_dupes,
        "inserted": total_inserted,
        "pages_run": min(max_pages, (page + 1) if 'page' in dir() else 0),
        "errors": errors,
        "credits_used": round(total_credits, 3),
    }
