"""
lead_acquisition_agent.py — Three acquisition channels for new sales leads:

  1. apollo_search  — Apollo mixed_companies/search filtered by industry keywords,
                      employee count, and region. Free to search; deduplicates
                      against existing leads before inserting.

  2. job_signals    — JobSpy scrapes LinkedIn for bakery/food companies actively
                      hiring R&D, Innovation, or Procurement roles (buying signal).
                      No API cost.

  3. event_scrape   — Scrapes a conference exhibitor/speaker page URL, extracts
                      company names via BeautifulSoup + simple heuristics, then
                      deduplicates and inserts new leads.

Each channel returns {"added": N, "skipped": N, "companies": [...added names]}
"""

import json
import logging
import os
import re
import time
import urllib.request
import urllib.error
import urllib.parse
from typing import Optional

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)


# ── DB helpers ────────────────────────────────────────────────────────────────

def _conn():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def _existing_companies() -> set[str]:
    """Return a set of normalized existing lead company names + domains."""
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT company, website FROM sales_leads WHERE archived=false")
        rows = cur.fetchall()
    finally:
        conn.close()
    seen = set()
    for r in rows:
        if r["company"]:
            seen.add(_normalize(r["company"]))
        if r["website"]:
            seen.add(_extract_domain(r["website"]))
    return seen


def _add_lead(company: str, domain: str = None, source: str = "apollo_search",
              region: str = None, tier_size: str = None, est_revenue: str = None,
              website: str = None, industry: str = None, employee_count: int = None) -> bool:
    """Insert a new lead. Returns True if inserted, False if duplicate."""
    conn = _conn()
    try:
        cur = conn.cursor()
        website = website or (f"https://{domain}" if domain else None)
        cur.execute(
            """INSERT INTO sales_leads
               (company, website, source, region, tier_size, est_revenue,
                industry, employee_count, enrichment_status, reach_out_status, archived)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'pending','not_contacted',false)
               ON CONFLICT DO NOTHING""",
            [company, website, source, region, tier_size, est_revenue,
             industry, employee_count],
        )
        inserted = cur.rowcount > 0
        conn.commit()
        return inserted
    finally:
        conn.close()


# ── Normalization / dedup helpers ─────────────────────────────────────────────

_STRIP = re.compile(
    r"\b(inc|llc|ltd|corp|corporation|company|co|group|holdings|international|"
    r"usa|us|north america|na|bakeries|bakery|baking|foods|food|solutions|"
    r"products|services|industries|enterprises|the)\b",
    re.IGNORECASE,
)


def _normalize(name: str) -> str:
    name = name.lower().strip()
    name = re.sub(r"[^\w\s]", " ", name)
    name = _STRIP.sub(" ", name)
    return re.sub(r"\s+", " ", name).strip()


def _extract_domain(url: str) -> str:
    m = re.search(r"https?://(?:www\.)?([^/]+)", url or "")
    return m.group(1).lower() if m else ""


def _tier_from_employees(n: Optional[int]) -> str:
    if not n:
        return None
    if n < 200:   return "Small"
    if n < 1000:  return "Mid-Market"
    if n < 5000:  return "Large"
    return "Enterprise"


# ── GooseWorks API key ────────────────────────────────────────────────────────

def _gw_api_key() -> str:
    creds_path = os.path.expanduser("~/.gooseworks/credentials.json")
    try:
        with open(creds_path) as f:
            return json.load(f)["api_key"]
    except Exception:
        return os.environ.get("GOOSEWORKS_API_KEY", "")


# ═══════════════════════════════════════════════════════════════════════════════
# Channel 1 — Apollo company search
# ═══════════════════════════════════════════════════════════════════════════════

_APOLLO_BASE = "https://api.gooseworks.ai/v1/proxy/apollo"

DEFAULT_KEYWORDS = ["bakery", "baking", "bread manufacturer", "specialty ingredients",
                    "food manufacturing", "CPG food", "packaged foods"]
DEFAULT_EMPLOYEE_RANGES = ["51,200", "201,1000", "1001,5000", "5001,50000"]
DEFAULT_LOCATIONS = ["United States", "Canada"]


def run_apollo_search(
    keywords: list[str] = None,
    employee_ranges: list[str] = None,
    locations: list[str] = None,
    max_results: int = 50,
) -> dict:
    api_key = _gw_api_key()
    if not api_key:
        return {"error": "GooseWorks API key not found"}

    keywords = keywords or DEFAULT_KEYWORDS
    employee_ranges = employee_ranges or DEFAULT_EMPLOYEE_RANGES
    locations = locations or DEFAULT_LOCATIONS

    existing = _existing_companies()
    added, skipped, companies = 0, 0, []

    page = 1
    fetched = 0
    while fetched < max_results:
        body = {
            "q_organization_keyword_tags": keywords,
            "num_employees_ranges": employee_ranges,
            "organization_locations": locations,
            "per_page": min(25, max_results - fetched),
            "page": page,
        }
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            f"{_APOLLO_BASE}/mixed_companies/search",
            data=data,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read())
        except Exception as e:
            logger.error("Apollo search error page %d: %s", page, e)
            break

        orgs = result.get("organizations") or []
        if not orgs:
            break

        for org in orgs:
            name = (org.get("name") or "").strip()
            if not name:
                continue
            domain = org.get("primary_domain") or ""
            norm = _normalize(name)
            dom_key = domain.lower() if domain else ""

            if norm in existing or (dom_key and dom_key in existing):
                skipped += 1
                continue

            emp = org.get("estimated_num_employees")
            ok = _add_lead(
                company=name,
                domain=domain or None,
                source="apollo_search",
                region=_extract_region(org.get("organization_locations") or org.get("hq_location")),
                tier_size=_tier_from_employees(emp),
                employee_count=emp,
                industry=org.get("industry"),
            )
            if ok:
                existing.add(norm)
                if dom_key:
                    existing.add(dom_key)
                added += 1
                companies.append(name)
                logger.info("Apollo acquisition: added %s", name)
            else:
                skipped += 1

        fetched += len(orgs)
        pagination = result.get("pagination") or {}
        total = pagination.get("total_entries", 0)
        if fetched >= total or len(orgs) < 25:
            break
        page += 1
        time.sleep(0.5)

    logger.info("Apollo search complete: %d added, %d skipped", added, skipped)
    return {"added": added, "skipped": skipped, "companies": companies}


def _extract_region(loc) -> Optional[str]:
    if not loc:
        return None
    if isinstance(loc, list):
        loc = loc[0] if loc else None
    if isinstance(loc, dict):
        country = loc.get("country") or loc.get("name") or ""
        state = loc.get("state") or ""
        return f"{state}, {country}".strip(", ") or None
    if isinstance(loc, str):
        return loc
    return None


# ═══════════════════════════════════════════════════════════════════════════════
# Channel 2 — Job signals (JobSpy)
# ═══════════════════════════════════════════════════════════════════════════════

DEFAULT_JOB_SEARCHES = [
    "VP R&D food",
    "Director Innovation bakery",
    "Head of R&D food manufacturing",
    "Chief Procurement Officer food",
    "VP Procurement food ingredients",
    "R&D Manager bakery ingredients",
]


def run_job_signals(
    searches: list[str] = None,
    hours_old: int = 720,   # 30 days
    max_per_search: int = 25,
) -> dict:
    try:
        from jobspy import scrape_jobs
    except ImportError:
        return {"error": "python-jobspy not installed"}

    searches = searches or DEFAULT_JOB_SEARCHES
    existing = _existing_companies()
    added, skipped, companies = 0, 0, []
    seen_this_run: set[str] = set()

    for query in searches:
        logger.info("Job signals: searching '%s'", query)
        try:
            jobs = scrape_jobs(
                site_name=["linkedin"],
                search_term=query,
                location="United States",
                results_wanted=max_per_search,
                hours_old=hours_old,
                linkedin_fetch_description=False,
            )
        except Exception as e:
            logger.warning("JobSpy error for '%s': %s", query, e)
            continue

        for _, row in jobs.iterrows():
            name = str(row.get("company") or "").strip()
            if not name or name == "nan":
                continue
            norm = _normalize(name)
            if norm in existing or norm in seen_this_run:
                skipped += 1
                continue

            location = str(row.get("location") or "")
            emp_str = str(row.get("company_num_employees") or "")
            emp = None
            m = re.search(r"(\d+)", emp_str.replace(",", ""))
            if m:
                emp = int(m.group(1))

            ok = _add_lead(
                company=name,
                domain=None,
                source="job_signal",
                region=location or None,
                tier_size=_tier_from_employees(emp),
                employee_count=emp,
            )
            if ok:
                existing.add(norm)
                seen_this_run.add(norm)
                added += 1
                companies.append(name)
                logger.info("Job signal acquisition: added %s (from: %s)", name, query)
            else:
                skipped += 1

        time.sleep(1)  # be polite to LinkedIn

    logger.info("Job signals complete: %d added, %d skipped", added, skipped)
    return {"added": added, "skipped": skipped, "companies": companies}


# ═══════════════════════════════════════════════════════════════════════════════
# Channel 3 — Event / conference page scraper
# ═══════════════════════════════════════════════════════════════════════════════

def run_event_scrape(url: str) -> dict:
    """
    Scrape an event exhibitor/speaker/attendee list page.
    Extracts company names and adds new ones as leads.
    """
    import requests
    from bs4 import BeautifulSoup

    logger.info("Event scrape: fetching %s", url)
    try:
        resp = requests.get(url, timeout=20, headers={
            "User-Agent": "Mozilla/5.0 (compatible; FounderERPBot/1.0)"
        })
        resp.raise_for_status()
    except Exception as e:
        return {"error": f"Failed to fetch page: {e}"}

    soup = BeautifulSoup(resp.text, "html.parser")

    # Remove nav/footer/scripts
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()

    companies = _extract_companies_from_page(soup, url)
    logger.info("Event scrape: extracted %d candidate companies from %s", len(companies), url)

    if not companies:
        return {"error": "No companies found on page — try a more specific exhibitor list URL", "added": 0, "skipped": 0, "companies": []}

    existing = _existing_companies()
    added, skipped, added_names = 0, 0, []

    for name in companies:
        norm = _normalize(name)
        if not norm or len(norm) < 3:
            continue
        if norm in existing:
            skipped += 1
            continue
        ok = _add_lead(company=name, source="event_scrape")
        if ok:
            existing.add(norm)
            added += 1
            added_names.append(name)
            logger.info("Event acquisition: added %s", name)
        else:
            skipped += 1

    logger.info("Event scrape complete: %d added, %d skipped", added, skipped)
    return {"added": added, "skipped": skipped, "companies": added_names, "candidates_found": len(companies)}


def _extract_companies_from_page(soup, url: str) -> list[str]:
    """
    Heuristically extract company names from an event page.
    Tries structured selectors first, falls back to text patterns.
    """
    from bs4 import BeautifulSoup

    candidates = []

    # Strategy 1: Look for exhibitor/company-list structured patterns
    selectors = [
        "[class*='exhibitor']", "[class*='company']", "[class*='sponsor']",
        "[class*='member']", "[class*='participant']", "[class*='attendee']",
        "[class*='booth']", "[class*='brand']",
        "li.company", "div.company", "h3.company", "h2.company",
        "[data-company]", "[itemprop='name']",
    ]
    for sel in selectors:
        for el in soup.select(sel)[:200]:
            text = el.get_text(strip=True)
            if 3 < len(text) < 80 and not _is_noise(text):
                candidates.append(text)

    # Strategy 2: If sparse, look for list items in a main content area
    if len(candidates) < 5:
        main = soup.find("main") or soup.find(id=re.compile(r"content|main|exhibit", re.I)) or soup
        for el in main.find_all(["li", "h3", "h4"])[:500]:
            text = el.get_text(strip=True)
            if 3 < len(text) < 60 and not _is_noise(text):
                candidates.append(text)

    # Deduplicate preserving order
    seen = set()
    out = []
    for c in candidates:
        key = c.lower().strip()
        if key not in seen:
            seen.add(key)
            out.append(c)

    # Filter to food-plausible names (broad check)
    return out[:300]


_NOISE_WORDS = re.compile(
    r"^(home|about|contact|register|login|sign|click|learn more|view|download|"
    r"schedule|program|exhibitor|sponsor|attend|visit|news|back|next|previous|"
    r"all rights|copyright|privacy|terms|\d{1,2}[:/]\d{2}|\$\d)$",
    re.IGNORECASE,
)


def _is_noise(text: str) -> bool:
    return bool(_NOISE_WORDS.match(text.strip())) or len(text.split()) > 10
