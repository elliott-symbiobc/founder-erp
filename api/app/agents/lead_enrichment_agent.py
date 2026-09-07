"""
lead_enrichment_agent.py — Sales lead enrichment agent.

Uses Claude with GooseWorks CLI tools to enrich sales leads with:
- Decision-maker contacts (Apollo people search by title + domain)
- Email addresses (Hunter email finder by domain + name)
- Company data (Hunter company lookup)

Each run is logged step-by-step to enrichment_runs table for live trace display.
"""

import json
import logging
import os
import re
import subprocess
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Optional

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)

ANTHROPIC_MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 4096


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


def _load_leads(lead_ids=None, max_leads=10):
    conn = _conn()
    try:
        cur = conn.cursor()
        if lead_ids:
            cur.execute(
                "SELECT * FROM sales_leads WHERE id = ANY(%s::uuid[]) AND archived=false ORDER BY "
                "CASE priority WHEN 'IMMEDIATE' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END",
                [lead_ids],
            )
        else:
            cur.execute(
                """SELECT * FROM sales_leads
                   WHERE archived=false
                     AND enrichment_status IN ('pending','failed')
                     AND priority IN ('IMMEDIATE','HIGH','MEDIUM')
                   ORDER BY
                     CASE priority WHEN 'IMMEDIATE' THEN 1 WHEN 'HIGH' THEN 2 ELSE 3 END,
                     company
                   LIMIT %s""",
                [max_leads],
            )
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def _save_enrichment(lead_id: str, contacts: list, company_data: dict = None, notes: str = "", source: str = "apollo"):
    if company_data is None:
        company_data = {}
    # Build field_sources: track which fields came from which API
    sources_update = {}
    if contacts:
        for i in range(len(contacts)):
            sources_update[f"contact_{i}"] = source
    for col in ("website", "industry", "description", "company_linkedin", "employee_count", "founded_year", "technologies"):
        if company_data.get(col) is not None and company_data.get(col) != "" and company_data.get(col) != []:
            sources_update[col] = source

    fields = ["contacts = %s::jsonb"]
    vals = [json.dumps(contacts)]
    for col in ("website", "industry", "description", "company_linkedin"):
        if company_data.get(col):
            fields.append(f"{col} = %s")
            vals.append(company_data[col])
    for col in ("employee_count", "founded_year"):
        if company_data.get(col) is not None:
            fields.append(f"{col} = %s")
            vals.append(int(company_data[col]))
    if company_data.get("technologies"):
        fields.append("technologies = %s::jsonb")
        vals.append(json.dumps(company_data["technologies"]))
    if sources_update:
        # Merge into existing field_sources (don't overwrite manually-set fields we're not touching)
        fields.append("field_sources = COALESCE(field_sources, '{}') || %s::jsonb")
        vals.append(json.dumps(sources_update))
    fields += [
        "enrichment_status = %s",
        "enriched_at = %s",
        "enrichment_notes = %s",
        "updated_at = now()",
    ]
    vals += ["enriched", datetime.now(timezone.utc), notes]
    vals.append(lead_id)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(f"UPDATE sales_leads SET {', '.join(fields)} WHERE id=%s", vals)
        conn.commit()
    finally:
        conn.close()


def _mark_failed(lead_id: str, reason: str):
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE sales_leads SET enrichment_status='failed', enrichment_notes=%s, updated_at=now() WHERE id=%s",
            [reason, lead_id],
        )
        conn.commit()
    finally:
        conn.close()


# ── Run trace helpers ─────────────────────────────────────────────────────────

def _append_step(run_id: str, step_type: str, content: str, **extra):
    """Append a step to the enrichment_runs trace. Fire-and-forget."""
    if not run_id:
        return
    step = {"type": step_type, "ts": datetime.now(timezone.utc).isoformat(), "content": content, **extra}
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE enrichment_runs SET steps = steps || %s::jsonb WHERE id = %s",
            [json.dumps([step]), run_id],
        )
        conn.commit()
    except Exception as e:
        logger.warning("Failed to append step to run %s: %s", run_id, e)
    finally:
        conn.close()


def _finish_run(run_id: str, status: str, credits_used: int = 0):
    if not run_id:
        return
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE enrichment_runs SET status=%s, finished_at=now(), credits_used=%s WHERE id=%s",
            [status, credits_used, run_id],
        )
        conn.commit()
    except Exception as e:
        logger.warning("Failed to finish run %s: %s", run_id, e)
    finally:
        conn.close()


# ── GooseWorks credit balance ────────────────────────────────────────────────

def _gw_balance() -> int:
    """Return current GooseWorks available_credits, or -1 on failure."""
    try:
        key = _gw_api_key()
        req = urllib.request.Request(
            "https://api.gooseworks.ai/v1/credits",
            headers={"Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read())
        return int(data["data"]["available_credits"])
    except Exception:
        return -1


# ── GooseWorks helpers ────────────────────────────────────────────────────────

def _run_gooseworks(command: str) -> str:
    try:
        result = subprocess.run(
            f"npx gooseworks {command}",
            shell=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        output = result.stdout.strip()
        if result.returncode != 0 and result.stderr:
            output += f"\nSTDERR: {result.stderr.strip()}"
        return output or "(no output)"
    except subprocess.TimeoutExpired:
        return "ERROR: command timed out after 60s"
    except Exception as e:
        return f"ERROR: {e}"


def _describe_apollo(path: str, body: dict) -> str:
    if "/mixed_people/api_search" in path:
        titles = body.get("person_titles", [])
        domain = (body.get("organization_domains") or ["?"])[0]
        name = body.get("q_organization_name", "")
        target = name or domain
        return f"Apollo: searching [{', '.join(titles[:3])}] at {target}"
    if "/people/bulk_match" in path:
        n = len(body.get("details", []))
        return f"Apollo: enriching {n} contact{'s' if n != 1 else ''} (email + LinkedIn)"
    return f"Apollo: {path}"


def _summarize_apollo(path: str, output: str) -> str:
    try:
        data = json.loads(output)
        if "/mixed_people/api_search" in path:
            people = data.get("people") or []
            total = data.get("total_entries", len(people))
            if not people:
                return "No contacts found in Apollo"
            names = [f"{p.get('first_name','?')} {p.get('last_name_obfuscated','?')} ({p.get('title','?')})" for p in people[:3]]
            more = f" + {len(people)-3} more" if len(people) > 3 else ""
            return f"Found {len(people)} contacts (of {total} total): {', '.join(names)}{more}"
        if "/people/bulk_match" in path:
            matches = data.get("matches") or []
            with_email = sum(1 for m in matches if (m.get("person") or {}).get("email"))
            return f"Enriched {len(matches)} contacts, {with_email} with email"
    except Exception:
        pass
    if output.startswith("ERROR"):
        return output[:120]
    return f"{len(output)} chars returned"


def _describe_command(cmd: str) -> str:
    """Turn a gooseworks command into a readable one-liner for the trace."""
    cmd = cmd.strip()
    if "/domain-search" in cmd:
        m = re.search(r'"domain":\s*"([^"]+)"', cmd)
        domain = m.group(1) if m else "?"
        m2 = re.search(r'"department":\s*"([^"]+)"', cmd)
        dept = f" [{m2.group(1)}]" if m2 else ""
        return f"Hunter: domain search at {domain}{dept}"
    if "/email-finder" in cmd:
        m = re.search(r'"domain":\s*"([^"]+)"', cmd)
        domain = m.group(1) if m else "?"
        m2 = re.search(r'"first_name":\s*"([^"]+)"', cmd)
        m3 = re.search(r'"last_name":\s*"([^"]+)"', cmd)
        name = f"{m2.group(1) if m2 else ''} {m3.group(1) if m3 else ''}".strip() or "?"
        return f"Hunter: email lookup for {name} at {domain}"
    if "/companies/find" in cmd:
        m = re.search(r'"domain":\s*"([^"]+)"', cmd)
        domain = m.group(1) if m else "?"
        return f"Hunter: company lookup for {domain}"
    parts = cmd.split()
    return " ".join(parts[:6])


def _summarize_result(cmd: str, output: str) -> str:
    """Extract a short human-readable summary from a GooseWorks API response."""
    try:
        lines = output.split("\n")
        json_start = next((i for i, l in enumerate(lines) if l.strip().startswith("{")), None)
        if json_start is None:
            if output.startswith("ERROR"):
                return output[:120]
            return f"{len(output)} chars returned"
        data = json.loads("\n".join(lines[json_start:]))

        if "/mixed_people/search" in cmd:
            people = data.get("people") or []
            if not people:
                return "No contacts found"
            names = [f"{p.get('name','?')} ({p.get('title','?')})" for p in people[:4]]
            more = f" + {len(people)-4} more" if len(people) > 4 else ""
            return f"Found {len(people)} contacts: {', '.join(names)}{more}"

        if "/email-finder" in cmd:
            d = (data.get("data") or data)
            email = d.get("email")
            score = d.get("score") or d.get("confidence")
            if email:
                return f"Email: {email}" + (f" (confidence {score})" if score else "")
            return "No email found"

        if "/companies/find" in cmd:
            d = (data.get("data") or data)
            parts = []
            if d.get("industry"):
                parts.append(d["industry"])
            if d.get("size"):
                parts.append(f"{d['size']} employees")
            if d.get("founded"):
                parts.append(f"founded {d['founded']}")
            techs = d.get("technologies") or []
            if techs:
                parts.append(f"{len(techs)} technologies")
            return ", ".join(parts) if parts else "Company data found"

        return f"{len(output)} chars returned"
    except Exception:
        if output.startswith("ERROR"):
            return output[:120]
        return f"{len(output)} chars returned"


# ── Apollo via GooseWorks HTTP proxy ─────────────────────────────────────────

def _gw_api_key() -> str:
    """Read GooseWorks API key from credentials file."""
    creds_path = os.path.expanduser("~/.gooseworks/credentials.json")
    try:
        with open(creds_path) as f:
            return json.load(f)["api_key"]
    except Exception:
        return os.environ.get("GOOSEWORKS_API_KEY", "")


_GW_APOLLO_BASE = "https://api.gooseworks.ai/v1/proxy/apollo"


def _run_apollo(path: str, body: dict) -> str:
    """POST to Apollo via GooseWorks HTTP proxy. Returns JSON string."""
    api_key = _gw_api_key()
    if not api_key:
        return "ERROR: GooseWorks API key not found"
    url = f"{_GW_APOLLO_BASE}{path}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8")[:300]
        return f"ERROR {e.code}: {body_text}"
    except Exception as e:
        return f"ERROR: {e}"


# ── Tool definitions for Claude ───────────────────────────────────────────────

TOOLS = [
    {
        "name": "apollo_call",
        "description": (
            "Call the Apollo.io API via the GooseWorks proxy. "
            "Use /mixed_people/api_search (POST, FREE) to find contacts at a company by title. "
            "Use /people/bulk_match (POST, costs 1 credit/contact) to enrich Apollo person IDs with full name, email, phone, LinkedIn. "
            "Always search first, then enrich only the best matches."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": (
                        "Apollo API path. Examples: "
                        "\"/mixed_people/api_search\" — search by title + domain (free), "
                        "\"/people/bulk_match\" — enrich person IDs to get emails (1 credit each)"
                    ),
                },
                "body": {
                    "type": "object",
                    "description": (
                        "Request body. For /mixed_people/api_search: "
                        "{\"person_titles\": [...], \"organization_domains\": [\"domain.com\"], \"q_organization_name\": \"Company Name\", \"per_page\": 10}. "
                        "For /people/bulk_match: "
                        "{\"details\": [{\"id\": \"<apollo_person_id>\"}]} — max 10 per call."
                    ),
                },
            },
            "required": ["path", "body"],
        },
    },
    {
        "name": "gooseworks_call",
        "description": (
            "Execute a GooseWorks CLI command to query external APIs for lead enrichment. "
            "Use 'call apollo /mixed_people/search' to find contacts by title+domain. "
            "Use 'call hunter /v2/email-finder' to find emails. "
            "Use 'call hunter /v2/companies/find' to get company data. "
            "Always pass JSON as --body or --query."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": (
                        "The gooseworks command to run (everything after 'gooseworks'). "
                        "Examples: "
                        "\"call apollo /mixed_people/search --body='{\\\"person_titles\\\":[\\\"VP R&D\\\"],\\\"organization_domains\\\":[\\\"gonnella.com\\\"],\\\"per_page\\\":10}'\", "
                        "\"call hunter /v2/email-finder --query='{\\\"domain\\\":\\\"gonnella.com\\\",\\\"first_name\\\":\\\"Bob\\\",\\\"last_name\\\":\\\"Nasshan\\\"}'\", "
                        "\"call hunter /v2/companies/find --query='{\\\"domain\\\":\\\"gonnella.com\\\"}'\""
                    ),
                }
            },
            "required": ["command"],
        },
    },
    {
        "name": "save_enrichment",
        "description": (
            "Save enriched contact and company data back to the lead record. "
            "Call this once you have gathered data for a lead. "
            "Include ALL contacts found — procurement, R&D, owners, CEOs, or any relevant decision-maker. "
            "Also include company-level data found via Apollo org fields or Hunter company lookup."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "lead_id":   {"type": "string",  "description": "UUID of the lead to update"},
                "contacts": {
                    "type": "array",
                    "description": "All contacts found. Include every relevant person.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name":         {"type": "string"},
                            "title":        {"type": "string"},
                            "seniority":    {"type": "string"},
                            "department":   {"type": "string"},
                            "email":        {"type": "string"},
                            "email_status": {"type": "string", "description": "verified / likely / guessed"},
                            "phone":        {"type": "string"},
                            "linkedin":     {"type": "string"},
                        },
                        "required": ["name"],
                    },
                },
                "website":          {"type": "string"},
                "industry":         {"type": "string"},
                "description":      {"type": "string"},
                "employee_count":   {"type": "integer"},
                "founded_year":     {"type": "integer"},
                "company_linkedin": {"type": "string"},
                "technologies":     {"type": "array", "items": {"type": "string"}},
                "notes":            {"type": "string", "description": "Brief enrichment notes"},
                "source":           {"type": "string", "description": "Primary data source used: 'apollo', 'hunter', or 'mixed'"},
            },
            "required": ["lead_id", "contacts"],
        },
    },
]


# ── Per-lead enrichment ───────────────────────────────────────────────────────

def _build_lead_prompt(lead: dict, icp: dict) -> str:
    target_titles = icp.get("target_titles") or [
        "VP R&D", "VP Innovation", "Director of Innovation",
        "VP Procurement", "Chief Procurement Officer",
        "Head of R&D", "Director of Product Development",
    ]

    website = lead.get("website") or ""
    domain = ""
    if website:
        m = re.search(r"https?://(?:www\.)?([^/]+)", website)
        if m:
            domain = m.group(1)

    existing_contacts = lead.get("contacts") or []
    if isinstance(existing_contacts, str):
        try:
            existing_contacts = json.loads(existing_contacts)
        except Exception:
            existing_contacts = []

    missing = []
    if not existing_contacts:
        missing.append("decision-maker contacts (R&D/Innovation/Procurement)")
    else:
        if any(not c.get("email") for c in existing_contacts):
            missing.append("email addresses for known contacts")

    parts = [
        f"Enrich this bakery company lead for Open ERP, a biotech startup selling fermentation-derived specialty ingredients (enzymatic dough improvers, natural colorants/flavors, upcycled grain ingredients).",
        f"",
        f"**Company:** {lead['company']}",
        f"**Priority:** {lead.get('priority') or 'unset'}",
        f"**Website:** {website or 'unknown'}",
        f"**Domain:** {domain or 'unknown — try to infer it'}",
        f"**Region:** {lead.get('region') or 'unknown'}",
        f"**Revenue:** {lead.get('est_revenue') or 'unknown'}",
    ]

    if existing_contacts:
        parts += ["", "**Already known contacts (enrich missing fields):**"]
        parts += [
            f"  - {c.get('name','?')} ({c.get('title','?')}) — email: {c.get('email') or 'MISSING'}, linkedin: {c.get('linkedin') or 'MISSING'}"
            for c in existing_contacts
        ]

    if missing:
        parts += ["", f"**What we need:** {', '.join(missing)}"]

    parts += [
        f"",
        f"**Target ICP titles:** {', '.join(target_titles)}",
        f"",
        f"**Instructions:**",
        f"1. If domain is unknown, infer it from the company name (e.g. 'Alpha Baking Company' → 'alphabaking.com')",
        f"2. Use `apollo_call` with path=/mixed_people/api_search to find contacts by title at this company (FREE — use organization_domains + q_organization_name filters)",
        f"3. Use `apollo_call` with path=/people/bulk_match to enrich the best Apollo person IDs and get full name, email, phone, LinkedIn (1 credit each — enrich max 5)",
        f"4. Use `gooseworks_call` with Hunter /v2/companies/find to get industry, description, employee count, technologies, founded year, company LinkedIn",
        f"5. If any contact names are known but emails still missing, use `gooseworks_call` with Hunter /v2/email-finder by name + domain",
        f"6. Call save_enrichment with ALL contacts found (name, title, seniority, department, email, email_status, phone, linkedin) AND company data",
        f"7. Be efficient — 4-6 API calls max.",
    ]

    return "\n".join(parts)


def _enrich_lead(lead: dict, icp: dict, run_id: str = None) -> dict:
    """Run the Claude agentic loop for a single lead. Logs steps to run trace."""
    import anthropic

    _append_step(run_id, "info", f"Starting enrichment for {lead['company']}")

    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    messages = [{"role": "user", "content": _build_lead_prompt(lead, icp)}]

    saved_data = {}
    api_calls = 0
    balance_before = _gw_balance()
    max_iterations = 8

    for iteration in range(max_iterations):
        response = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=MAX_TOKENS,
            tools=TOOLS,
            messages=messages,
        )

        messages.append({"role": "assistant", "content": response.content})

        # Log any text Claude emitted
        for block in response.content:
            if hasattr(block, "text") and block.text and block.text.strip():
                _append_step(run_id, "thinking", block.text.strip()[:400])

        if response.stop_reason == "end_turn":
            break

        if response.stop_reason != "tool_use":
            break

        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue

            tool_name  = block.name
            tool_input = block.input

            if tool_name == "apollo_call":
                api_calls += 1
                path  = tool_input.get("path", "")
                body  = tool_input.get("body", {})
                label = _describe_apollo(path, body)
                _append_step(run_id, "tool_call", label, raw_command=f"Apollo POST {path}")
                output  = _run_apollo(path, body)
                summary = _summarize_apollo(path, output)
                _append_step(run_id, "tool_result", summary)
                logger.info("Apollo [%s]: %s → %s", lead["company"], label, summary)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output[:4000],
                })

            elif tool_name == "gooseworks_call":
                api_calls += 1
                cmd = tool_input["command"]
                label = _describe_command(cmd)
                _append_step(run_id, "tool_call", label, raw_command=cmd[:200])

                output = _run_gooseworks(cmd)
                summary = _summarize_result(cmd, output)
                _append_step(run_id, "tool_result", summary)

                logger.info("GooseWorks [%s]: %s → %s", lead["company"], label, summary)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output[:4000],
                })

            elif tool_name == "save_enrichment":
                lead_id     = str(lead["id"])  # always use DB id, never trust Claude's value
                contacts    = tool_input.get("contacts") or []
                notes       = tool_input.get("notes", "")
                company_data = {k: tool_input.get(k) for k in (
                    "website", "industry", "description", "company_linkedin",
                    "employee_count", "founded_year", "technologies",
                ) if tool_input.get(k) is not None}

                source = tool_input.get("source", "apollo")
                _save_enrichment(lead_id, contacts, company_data=company_data, notes=notes, source=source)
                saved_data = {"contacts": contacts, **company_data}

                # Build a readable save summary
                contact_names = [c.get("name", "?") for c in contacts]
                co_fields = [k for k in company_data if company_data[k]]
                save_msg = f"Saved {len(contacts)} contact{'s' if len(contacts)!=1 else ''}"
                if contact_names:
                    save_msg += f": {', '.join(contact_names[:3])}" + (" …" if len(contact_names) > 3 else "")
                if co_fields:
                    save_msg += f" | Company: {', '.join(co_fields)}"

                _append_step(run_id, "save", save_msg,
                             contacts=[{"name": c.get("name"), "title": c.get("title"), "email": c.get("email")} for c in contacts],
                             company_fields=co_fields)

                logger.info("Saved enrichment for %s: %d contacts, %s", lead["company"], len(contacts), co_fields)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps({"ok": True, "contacts_saved": len(contacts), "company_fields": co_fields}),
                })

        if tool_results:
            messages.append({"role": "user", "content": tool_results})

    balance_after = _gw_balance()
    credits_used = max(0, balance_before - balance_after) if balance_before >= 0 and balance_after >= 0 else 0
    return {"lead_id": lead["id"], "company": lead["company"], "saved": saved_data, "api_calls": api_calls, "credits_used": credits_used}


# ── Public entry point ────────────────────────────────────────────────────────

def run_enrichment(lead_ids: Optional[list] = None, max_leads: int = 10,
                   run_ids: Optional[dict] = None) -> dict:
    """
    Enrich sales leads. run_ids is a {lead_id: run_id} map for trace logging.
    """
    leads = _load_leads(lead_ids=lead_ids, max_leads=max_leads)

    if not leads:
        return {"processed": 0, "message": "No leads to enrich"}

    # Use ICP for the system the first lead belongs to
    first_system_id = str(leads[0]["system_id"]) if leads[0].get("system_id") else None
    icp = _load_icp(first_system_id)

    results = []
    for lead in leads:
        run_id = (run_ids or {}).get(str(lead["id"]))
        logger.info("Enriching lead: %s [%s] run_id=%s", lead["company"], lead.get("priority"), run_id)
        try:
            result = _enrich_lead(lead, icp, run_id=run_id)
            _append_step(run_id, "done", "Enrichment complete")
            _finish_run(run_id, "completed", credits_used=result.get("credits_used", 0))
            results.append({**result, "status": "ok"})
        except Exception as e:
            logger.error("Enrichment failed for %s: %s", lead["company"], e)
            _mark_failed(lead["id"], str(e))
            _append_step(run_id, "error", str(e)[:300])
            _finish_run(run_id, "failed")
            results.append({"lead_id": lead["id"], "company": lead["company"], "status": "error", "error": str(e)})

    return {
        "processed": len(results),
        "succeeded": sum(1 for r in results if r["status"] == "ok"),
        "failed":    sum(1 for r in results if r["status"] == "error"),
        "results":   results,
    }
