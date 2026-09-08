"""
investor_enrichment_agent.py — Investor enrichment agent.

Tool stack per investor:
1. Fundable /investor/search  (GET, $0.011) — fuzzy name → Fundable ID + basic profile
2. Fundable /investor          (GET, $0.066) — full profile by ID: HQ, stages, top_industries, portfolio
3. Apollo /organizations/enrich (GET, free)  — HQ city/state/country, LinkedIn, founded year
4. Claude Sonnet + web_search               — fill gaps (fund size, check size, thesis), then SCORE

Writes enriched fields + scores to dilutive_investors.
Run trace logged to dilutive_enrichment_runs table.
"""

import json
import logging
import os
import re
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Optional

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)

ANTHROPIC_MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 4096

# Scoring dimensions we write back
SCORE_DIMS = ["score_focus", "score_stage", "score_check", "score_geo", "score_portfolio"]

# Fundable API via orthogonal proxy
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


def _load_investors(investor_ids=None, max_investors=10, all_investors=False):
    conn = _conn()
    try:
        cur = conn.cursor()
        if investor_ids:
            cur.execute(
                "SELECT * FROM dilutive_investors WHERE investor_id = ANY(%s::uuid[])",
                [investor_ids],
            )
        elif all_investors:
            cur.execute(
                "SELECT * FROM dilutive_investors ORDER BY created_at ASC LIMIT %s",
                [max_investors],
            )
        else:
            cur.execute(
                """SELECT * FROM dilutive_investors
                   WHERE enriched_fields IS NULL OR array_length(enriched_fields, 1) IS NULL
                   ORDER BY created_at ASC
                   LIMIT %s""",
                [max_investors],
            )
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def _load_scoring_rubric():
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT rubric, tier_thresholds FROM dilutive_scoring_config ORDER BY id LIMIT 1")
        row = cur.fetchone()
        if row:
            return dict(row["rubric"]), dict(row["tier_thresholds"])
        return {}, {"tier1": 17, "tier2": 13, "tier3": 9, "tier4": 5}
    except Exception:
        return {}, {"tier1": 17, "tier2": 13, "tier3": 9, "tier4": 5}
    finally:
        conn.close()


def _save_enrichment(investor_id: str, fields: dict):
    """Write enriched fields + scores to DB.

    Skips any field that already has a value AND was not previously set by
    enrichment (i.e. not in the existing enriched_fields array). This preserves
    manually-entered data while allowing re-enrichment to overwrite prior
    hallucinated/stale enrichment results.
    """
    ENRICH_FIELDS = [
        "firm_type", "hq", "geo_focus", "investment_stage", "focus",
        "fund_size", "fund_launch_year", "website", "linkedin",
        "portfolio_url", "partners", "check_size_min", "check_size_max",
        "description", "enrichment_notes",
    ]

    # Load current record to check what's manually entered vs previously enriched
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT " + ", ".join(ENRICH_FIELDS + ["portfolio", "tags", "enriched_fields"])
                + " FROM dilutive_investors WHERE investor_id = %s",
                [investor_id],
            )
            current = dict(cur.fetchone() or {})
    finally:
        conn.close()

    previously_enriched = set(current.get("enriched_fields") or [])

    def _is_empty(v):
        return v in (None, "", [], {}) or (isinstance(v, list) and len(v) == 0)

    updates = {}
    for k in ENRICH_FIELDS:
        v = fields.get(k)
        if v in (None, "", [], {}):
            continue
        existing = current.get(k)
        # Write if: field is empty OR was previously enriched (not manually entered)
        if _is_empty(existing) or k in previously_enriched:
            updates[k] = v

    # portfolio array: same rule
    if fields.get("portfolio") and isinstance(fields["portfolio"], list):
        existing_portfolio = current.get("portfolio") or []
        if _is_empty(existing_portfolio) or "portfolio" in previously_enriched:
            updates["portfolio"] = fields["portfolio"]

    # tags: only write if currently empty (never overwrite manual tags)
    if fields.get("tags") and isinstance(fields["tags"], list):
        existing_tags = current.get("tags") or []
        if _is_empty(existing_tags):
            updates["tags"] = fields["tags"]

    # score columns always overwrite (scores are always enrichment-derived)
    for dim in SCORE_DIMS:
        if fields.get(dim) is not None:
            updates[dim] = int(fields[dim])

    if not updates:
        return []

    filled = [k for k in updates if k not in SCORE_DIMS + ["enrichment_notes"]]
    updates["enriched_fields"] = filled
    # compute total_score + tier
    scores = [int(fields.get(d, 0) or 0) for d in SCORE_DIMS]
    total = sum(scores)
    updates["total_score"] = total

    _, thresholds = _load_scoring_rubric()
    t1, t2, t3, t4 = thresholds.get("tier1", 17), thresholds.get("tier2", 13), thresholds.get("tier3", 9), thresholds.get("tier4", 5)
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
    updates["tier"] = tier

    # handle array columns
    arr_cols = {"portfolio", "enriched_fields", "tags"}
    set_parts = []
    vals = []
    for k, v in updates.items():
        if k in arr_cols:
            set_parts.append(f"{k} = %s::text[]")
            vals.append(v)
        else:
            set_parts.append(f"{k} = %s")
            vals.append(v)

    set_parts.append("updated_at = NOW()")
    vals.append(investor_id)

    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE dilutive_investors SET {', '.join(set_parts)} WHERE investor_id = %s",
                vals,
            )
            conn.commit()
    finally:
        conn.close()

    return filled


# ── Run trace helpers ─────────────────────────────────────────────────────────

def _ensure_run_table(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS dilutive_enrichment_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            investor_id UUID,
            firm TEXT,
            status TEXT DEFAULT 'running',
            steps JSONB DEFAULT '[]',
            credits_used NUMERIC DEFAULT 0,
            started_at TIMESTAMPTZ DEFAULT NOW(),
            finished_at TIMESTAMPTZ
        )
    """)


def _create_run(investor_id: str, firm: str) -> str:
    conn = _conn()
    try:
        with conn.cursor() as cur:
            _ensure_run_table(cur)
            cur.execute(
                "INSERT INTO dilutive_enrichment_runs (investor_id, firm) VALUES (%s, %s) RETURNING id",
                [investor_id, firm],
            )
            row = cur.fetchone()
            run_id = str(row[0] if isinstance(row, (list, tuple)) else row["id"])
            conn.commit()
        return run_id
    finally:
        conn.close()


def _append_step(run_id: str, step_type: str, content: str, **extra):
    if not run_id:
        return
    step = {"type": step_type, "ts": datetime.now(timezone.utc).isoformat(), "content": content, **extra}
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE dilutive_enrichment_runs SET steps = steps || %s::jsonb WHERE id = %s",
                [json.dumps([step]), run_id],
            )
            conn.commit()
    except Exception as e:
        logger.warning("Failed to append step: %s", e)
    finally:
        conn.close()


def _finish_run(run_id: str, status: str, credits_used: float = 0):
    if not run_id:
        return
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE dilutive_enrichment_runs SET status=%s, finished_at=NOW(), credits_used=%s WHERE id=%s",
                [status, credits_used, run_id],
            )
            conn.commit()
    except Exception as e:
        logger.warning("Failed to finish run: %s", e)
    finally:
        conn.close()


# ── GooseWorks / Fundable HTTP calls ─────────────────────────────────────────

def _gw_call(api: str, path: str, method: str = "GET", query: dict = None, body: dict = None) -> dict:
    """Call any API via GooseWorks orthogonal proxy. Returns parsed JSON dict."""
    key = _gw_api_key()
    if not key:
        return {"error": "GooseWorks API key not found"}

    payload = {"api": api, "path": path, "method": method}
    if query:
        payload["query"] = query
    if body:
        payload["body"] = body

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{_GW_BASE}/run",
        data=data,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8")[:400]
        return {"error": f"HTTP {e.code}: {body_text}"}
    except Exception as e:
        return {"error": str(e)}


def _apollo_org(domain: str) -> dict:
    """Apollo organization enrich by domain (free). Returns org dict or {}."""
    key = _gw_api_key()
    if not key:
        return {}
    url = f"https://api.gooseworks.ai/v1/proxy/apollo/organizations/enrich?domain={domain}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {key}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
            return data.get("organization") or {}
    except Exception:
        return {}


# ── Tool definitions for Claude ───────────────────────────────────────────────

def _make_tools(rubric: dict) -> list:
    rubric_summary = "\n".join(
        f"- {dim} (0–{info.get('max',4)}): {info.get('label','')}\n"
        + "\n".join(f"    {lvl}: {desc}" for lvl, desc in (info.get("levels") or {}).items())
        for dim, info in rubric.items()
    ) if rubric else "(use standard 0–4 scale per dimension)"

    return [
        {
            "name": "fundable_search",
            "description": (
                "Search Fundable for an investor by name or domain to get their Fundable ID. "
                "Cost: $0.011 per call. Returns id, name, domain, description, website, linkedin."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Investor/firm name for fuzzy search"},
                    "domain": {"type": "string", "description": "Firm domain for exact match (e.g. 'a16z.com')"},
                },
            },
        },
        {
            "name": "fundable_detail",
            "description": (
                "Get full Fundable investor profile by ID. "
                "Cost: $0.066 per call. Returns HQ, location, description, top_industries, "
                "top_locations, num_employees, investment_stage, website, linkedin, deal counts, most_recent_deal_date."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Fundable investor ID from fundable_search"},
                },
                "required": ["id"],
            },
        },
        {
            "name": "apollo_org",
            "description": (
                "Enrich a firm by domain using Apollo (FREE). "
                "Returns: city, state, country, founded_year, employee_count, linkedin_url, "
                "short_description, industry, keywords, website_url. Use this after Fundable. "
                "Map founded_year → fund_launch_year, keywords → tags, linkedin_url → linkedin."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "domain": {"type": "string", "description": "Firm domain (e.g. 'a16z.com')"},
                },
                "required": ["domain"],
            },
        },
        {
            "name": "web_search",
            "description": (
                "Search the web for investor information not available from structured APIs. "
                "Use for: fund size, check size range, active investment thesis, recent announcements, "
                "notable portfolio companies in the company's sector."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                },
                "required": ["query"],
            },
        },
        {
            "name": "save_enrichment",
            "description": (
                "Save enriched investor data and scores to the database. "
                "Call once you have gathered all available data. "
                f"Score each dimension 0–4 based on this rubric:\n{rubric_summary}"
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "investor_id": {"type": "string", "description": "UUID of the investor record"},
                    "firm_type": {"type": "string", "description": "VC, Angel, Family Office, Corporate VC, Accelerator, etc."},
                    "hq": {"type": "string", "description": "City, Country (e.g. 'Menlo Park, United States')"},
                    "geo_focus": {"type": "string", "description": "Regions where they invest (e.g. 'US, Europe')"},
                    "investment_stage": {"type": "string", "description": "e.g. 'Pre-seed to Seed', 'Seed–Series A'"},
                    "focus": {"type": "string", "description": "Thesis/sectors e.g. 'Enterprise SaaS, climate, fintech'"},
                    "fund_size": {"type": "string", "description": "Total fund size string e.g. '$200M'"},
                    "fund_launch_year": {"type": "string", "description": "Fund vintage or firm founding year (from Apollo founded_year or web search)"},
                    "website": {"type": "string"},
                    "linkedin": {"type": "string"},
                    "portfolio_url": {"type": "string"},
                    "partners": {"type": "string", "description": "Notable partners comma-separated"},
                    "check_size_min": {"type": "string", "description": "e.g. '$250K'"},
                    "check_size_max": {"type": "string", "description": "e.g. '$2M'"},
                    "description": {"type": "string", "description": "2-3 sentence summary of firm and fit for Founder ERP"},
                    "portfolio": {"type": "array", "items": {"type": "string"}, "description": "Notable portfolio companies (max 10)"},
                    "score_focus": {"type": "integer", "description": "0–4: sector focus fit"},
                    "score_stage": {"type": "integer", "description": "0–4: stage fit"},
                    "score_check": {"type": "integer", "description": "0–4: check size fit"},
                    "score_geo": {"type": "integer", "description": "0–4: geographic focus fit"},
                    "score_portfolio": {"type": "integer", "description": "0–4: portfolio fit"},
                    "enrichment_notes": {"type": "string", "description": "One sentence on what was found and confidence level"},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "Keyword tags from Apollo keywords + inferred from thesis e.g. ['pre-seed', 'climate', 'midwest']"},
                },
                "required": ["investor_id", "score_focus", "score_stage", "score_check", "score_geo", "score_portfolio"],
            },
        },
    ]


# ── Per-investor enrichment ───────────────────────────────────────────────────

def _build_prompt(inv: dict) -> str:
    lines = [
        "Enrich this investor record for an early-stage startup "
        "the company's sector "
        "upcycled grain ingredients). We are at pre-seed/seed stage raising $500K–$3M.",
        "",
        f"**investor_id:** {inv['investor_id']}",
        f"**Firm:** {inv.get('firm') or 'unknown'}",
        f"**Contact:** {inv.get('name') or 'unknown'} ({inv.get('role') or 'unknown'})",
        f"**Website:** {inv.get('website') or 'unknown'}",
        f"**LinkedIn:** {inv.get('linkedin') or 'unknown'}",
        f"**Current HQ:** {inv.get('hq') or 'unknown'}",
        f"**Current focus:** {inv.get('focus') or 'unknown'}",
        f"**Current stage:** {inv.get('investment_stage') or 'unknown'}",
        f"**Notes:** {inv.get('notes') or 'none'}",
        "",
        "**Instructions:**",
        "1. Call `fundable_search` with firm name (and domain if website is known) to get Fundable ID",
        "2. Call `fundable_detail` with the ID to get full structured profile (HQ, industries, stages, deal count, portfolio)",
        "3. Call `apollo_org` with the firm domain (FREE) for city/state/founded_year/keywords",
        "4. If fund_size, check_size, or active thesis are still unknown, call `web_search` (1–2 targeted queries max)",
        "5. Call `save_enrichment` with ALL gathered data + scores for all 5 dimensions",
        "",
        "Field mapping rules:",
        "- Fundable top_industries → focus (comma-separated names)",
        "- Fundable top_locations → geo_focus (comma-separated)",
        "- Fundable location city+country → hq",
        "- Fundable portfolio companies (names or domains) → portfolio array",
        "- Apollo founded_year → fund_launch_year",
        "- Apollo keywords → tags array",
        "- Apollo linkedin_url → linkedin (if not already set from Fundable)",
        "- Fundable deal_count_last_12_months and most_recent_deal_date → include in enrichment_notes",
        "- Write enrichment_notes as: '<N> deals in last 12mo, last deal <date>. Confidence: high/medium/low.'",
        "",
        "Be efficient: 3–5 tool calls total. Only web_search if structured APIs didn't cover fund_size/check_size.",
    ]
    return "\n".join(lines)


def _enrich_investor(inv: dict, rubric: dict, run_id: str = None) -> dict:
    """Agentic loop enriching a single investor."""
    import anthropic

    firm = inv.get("firm") or inv.get("name") or str(inv["investor_id"])
    _append_step(run_id, "info", f"Starting enrichment for {firm}")

    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    tools = _make_tools(rubric)
    messages = [{"role": "user", "content": _build_prompt(inv)}]

    saved = False
    api_calls = 0
    credits_used = 0.0

    for iteration in range(10):
        response = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=MAX_TOKENS,
            tools=tools,
            messages=messages,
        )
        messages.append({"role": "assistant", "content": response.content})

        for block in response.content:
            if hasattr(block, "text") and block.text and block.text.strip():
                _append_step(run_id, "thinking", block.text.strip()[:400])

        if response.stop_reason in ("end_turn", None) or response.stop_reason != "tool_use":
            break

        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue

            name = block.name
            inp = block.input
            api_calls += 1

            if name == "fundable_search":
                _append_step(run_id, "tool_call", f"Fundable search: {inp.get('name') or inp.get('domain')}")
                query = {}
                if inp.get("name"):
                    query["name"] = inp["name"]
                if inp.get("domain"):
                    query["domain"] = inp["domain"]
                result = _gw_call("fundable", "/investor/search", "GET", query=query)
                credits_used += 0.011
                investors = (result.get("data") or {}).get("investors") or []
                summary = f"Found {len(investors)} result(s)" if investors else "No results"
                if investors:
                    summary += f": {investors[0].get('name')} (id={investors[0].get('id')[:8]}...)"
                _append_step(run_id, "tool_result", summary)
                content = json.dumps(result)[:4000]

            elif name == "fundable_detail":
                _append_step(run_id, "tool_call", f"Fundable detail: {inp['id'][:8]}...")
                result = _gw_call("fundable", "/investor", "GET", query={"id": inp["id"]})
                credits_used += 0.066
                inv_data = (result.get("data") or {}).get("investor") or {}
                loc = inv_data.get("location") or {}
                city = (loc.get("city") or {}).get("name", "")
                country = (loc.get("country") or {}).get("name", "")
                top_ind = [i["name"] for i in (inv_data.get("top_industries") or [])[:3]]
                summary = f"{city}, {country} | industries: {', '.join(top_ind)}" if city else f"industries: {', '.join(top_ind)}"
                _append_step(run_id, "tool_result", summary)
                content = json.dumps(result)[:4000]

            elif name == "apollo_org":
                domain = inp.get("domain", "")
                _append_step(run_id, "tool_call", f"Apollo org: {domain}")
                org = _apollo_org(domain)
                summary = f"Apollo: {org.get('city')}, {org.get('country')}, {org.get('employee_count')} employees" if org else "No Apollo data"
                _append_step(run_id, "tool_result", summary)
                content = json.dumps(org)[:3000]

            elif name == "web_search":
                query_text = inp.get("query", "")
                _append_step(run_id, "tool_call", f"Web search: {query_text[:80]}")
                # Use Claude's built-in web_search tool by passing it back as a separate request
                ws_response = client.messages.create(
                    model=ANTHROPIC_MODEL,
                    max_tokens=1024,
                    tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 1}],
                    messages=[{"role": "user", "content": f"Search: {query_text}\n\nReturn a JSON summary with keys: fund_size, check_size_min, check_size_max, investment_thesis, recent_news (all strings or null)"}],
                )
                ws_text = ""
                for b in ws_response.content:
                    if hasattr(b, "text"):
                        ws_text += b.text
                _append_step(run_id, "tool_result", f"Web search complete ({len(ws_text)} chars)")
                content = ws_text[:3000]

            elif name == "save_enrichment":
                inv_id = str(inv["investor_id"])  # always use DB id
                _append_step(run_id, "tool_call", "Saving enrichment + scores")
                fields = {k: v for k, v in inp.items() if k != "investor_id"}
                filled = _save_enrichment(inv_id, fields)
                saved = True
                scores = {d: int(inp.get(d, 0) or 0) for d in SCORE_DIMS}
                total = sum(scores.values())
                _append_step(run_id, "save",
                             f"Saved {len(filled)} fields, total_score={total}",
                             fields=filled, scores=scores)
                content = json.dumps({"ok": True, "fields_saved": filled, "total_score": total})

            else:
                content = json.dumps({"error": f"Unknown tool: {name}"})

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": content,
            })

        if tool_results:
            messages.append({"role": "user", "content": tool_results})

    return {"investor_id": str(inv["investor_id"]), "firm": firm, "saved": saved,
            "api_calls": api_calls, "credits_used": credits_used}


# ── Public entry point ────────────────────────────────────────────────────────

def run_enrichment(investor_ids: Optional[list] = None, max_investors: int = 10, all_investors: bool = False) -> dict:
    """
    Enrich investor records.
    - investor_ids: enrich specific investors
    - all_investors=True: enrich all (re-enriches previously enriched, skips manually-entered fields)
    - default: enrich only unenriched investors up to max_investors
    """
    investors = _load_investors(investor_ids=investor_ids, max_investors=max_investors, all_investors=all_investors)
    if not investors:
        return {"processed": 0, "message": "No investors to enrich"}

    rubric, _ = _load_scoring_rubric()

    results = []
    for inv in investors:
        run_id = _create_run(str(inv["investor_id"]), inv.get("firm") or "")
        logger.info("Enriching: %s [%s]", inv.get("firm"), inv["investor_id"])
        try:
            result = _enrich_investor(inv, rubric, run_id=run_id)
            _append_step(run_id, "done", "Enrichment complete")
            _finish_run(run_id, "completed", credits_used=result.get("credits_used", 0))
            results.append({**result, "status": "ok", "run_id": run_id})
        except Exception as e:
            logger.error("Enrichment failed for %s: %s", inv.get("firm"), e)
            _append_step(run_id, "error", str(e)[:300])
            _finish_run(run_id, "failed")
            results.append({"investor_id": str(inv["investor_id"]), "firm": inv.get("firm"), "status": "error", "error": str(e), "run_id": run_id})

    return {
        "processed": len(results),
        "succeeded": sum(1 for r in results if r["status"] == "ok"),
        "failed": sum(1 for r in results if r["status"] == "error"),
        "results": results,
    }
