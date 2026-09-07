"""Developer mode API endpoints: execution traces, source inspection, auto-docs."""
from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import AsyncIterator

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)
router = APIRouter()

# Modules exposed to /dev/docs auto-generation
_DOC_MODULES = [
    # Routers
    ("app.routers.auth",       "Auth & Permissions"),
    ("app.routers.users",      "Users"),
    ("app.routers.substrates", "Substrates"),
    ("app.routers.strains",    "Strains"),
    ("app.routers.runs",       "Fermentation Runs"),
    ("app.routers.queue",      "Literature Queue"),
    ("app.routers.papers",     "Papers"),
    ("app.routers.compounds",  "Compounds"),
    ("app.routers.enzymes",    "Enzymes"),
    ("app.routers.protocols",  "Protocols"),
    ("app.routers.model",      "ML Model"),
    ("app.routers.explore",    "Explore"),
    ("app.routers.fpa",        "FP&A"),
    ("app.routers.notebook",   "Notebook"),
    ("app.routers.notes",      "Notes"),
    ("app.routers.tasks",      "Tasks"),
    ("app.routers.contacts",   "Contacts"),
    ("app.routers.advisors",   "Advisors"),
    ("app.routers.projects",   "Projects"),
    ("app.routers.calendar",   "Calendar"),
    ("app.routers.jobs",       "Jobs"),
    ("app.routers.reports",    "Reports"),
    ("app.routers.dev",        "Dev Tools"),
    # Agents
    ("app.agents.tea_agent",               "TEA Agent"),
    ("app.agents.compound_discovery_agent","Compound Discovery"),
    ("app.agents.regulatory_agent",        "Regulatory Analysis"),
    ("app.agents.rnd_estimator",           "R&D Estimator"),
    ("app.agents.edit_prioritizer",        "Edit Prioritizer"),
    ("app.agents.literature_agent",        "Literature Agent"),
    ("app.agents.extraction_agent",        "Extraction Agent"),
    ("app.agents.paper_summary_agent",     "Paper Summary"),
    ("app.agents.composition_agent",       "Composition Agent"),
    ("app.agents.fuzzy_matcher",           "Fuzzy Matcher"),
    # ML
    ("app.ml.features",        "ML Features"),
    ("app.ml.model",           "ML Model Core"),
    ("app.ml.active_learning", "Active Learning"),
    # Core
    ("app.core.tracer",        "Execution Tracer"),
]

# Assumption sources exposed to /dev/assumptions
_ASSUMPTION_SOURCES = [
    ("app.agents.tea_agent", "LITERATURE_DEFAULTS"),
    ("app.agents.tea_agent", "_MARKET_PRICES"),
    ("app.agents.tea_agent", "PROCESS_ROUTES"),
    ("app.agents.tea_agent", "_ENZYME_CLASS_TO_OUTPUT"),
    ("app.agents.tea_agent", "_DOWNSTREAM_TYPE"),
]


def _get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _safe_path(module_path: str) -> bool:
    """Restrict source inspection to known app modules."""
    allowed_prefixes = (
        "app.agents.", "app.ml.", "app.tasks.", "app.core.", "app.routers.",
    )
    return any(module_path.startswith(p) for p in allowed_prefixes)


# ---------------------------------------------------------------------------
# API usage / cost reporting
# ---------------------------------------------------------------------------

@router.get("/api-usage")
def get_api_usage(period: int = 30):
    """
    Return API usage and cost summary for the last `period` days.
    Includes per-service totals, daily breakdown, and per-operation breakdown.
    """
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        # Overall totals per service
        cur.execute(
            """
            SELECT
                service,
                COUNT(*)                                    AS call_count,
                COALESCE(SUM(input_tokens), 0)::bigint      AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint     AS total_output_tokens,
                COALESCE(SUM(audio_seconds), 0)             AS total_audio_seconds,
                COALESCE(SUM(cost_usd), 0)                  AS total_cost_usd,
                MAX(called_at)                              AS last_called_at
            FROM api_usage_log
            WHERE called_at >= now() - (%s || ' days')::interval
            GROUP BY service
            ORDER BY total_cost_usd DESC
            """,
            (period,),
        )
        by_service = [dict(r) for r in cur.fetchall()]

        # Per-operation breakdown
        cur.execute(
            """
            SELECT
                service,
                operation,
                model,
                COUNT(*)                                    AS call_count,
                COALESCE(SUM(input_tokens), 0)::bigint      AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint     AS total_output_tokens,
                COALESCE(SUM(audio_seconds), 0)             AS total_audio_seconds,
                COALESCE(SUM(cost_usd), 0)                  AS total_cost_usd
            FROM api_usage_log
            WHERE called_at >= now() - (%s || ' days')::interval
            GROUP BY service, operation, model
            ORDER BY total_cost_usd DESC
            """,
            (period,),
        )
        by_operation = [dict(r) for r in cur.fetchall()]

        # Daily spend for chart (last period days)
        cur.execute(
            """
            SELECT
                DATE(called_at AT TIME ZONE 'UTC')  AS day,
                service,
                COALESCE(SUM(cost_usd), 0)          AS cost_usd
            FROM api_usage_log
            WHERE called_at >= now() - (%s || ' days')::interval
            GROUP BY day, service
            ORDER BY day ASC
            """,
            (period,),
        )
        daily = [dict(r) for r in cur.fetchall()]

        # All-time total cost
        cur.execute("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM api_usage_log")
        all_time_total = float(cur.fetchone()["total"])

        return {
            "period_days": period,
            "by_service": by_service,
            "by_operation": by_operation,
            "daily": daily,
            "all_time_cost_usd": all_time_total,
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# API key status (which env vars are present)
# ---------------------------------------------------------------------------

@router.get("/api-key-status")
def get_api_key_status():
    """Return which API keys are configured (present/absent only — never the values)."""
    keys = {
        "ANTHROPIC_API_KEY": "anthropic",
        "DEEPGRAM_API_KEY":  "deepgram",
        "S2_API_KEY":        "semantic_scholar",
        "ATCC_API_KEY":      "atcc",
    }
    return {
        label: bool(os.environ.get(env_var, "").strip())
        for env_var, label in keys.items()
    }


# ---------------------------------------------------------------------------
# Traces
# ---------------------------------------------------------------------------

@router.get("/traces/{entity_id}")
def list_traces(entity_id: str, pipeline: str | None = None, limit: int = 20):
    """List recent execution traces for a given entity (substrate, strain, etc.)."""
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        if pipeline:
            cur.execute(
                """
                SELECT trace_id, run_id, entity_type, pipeline, function_name,
                       started_at, completed_at, duration_ms, status, error_message,
                       triggered_by
                FROM execution_traces
                WHERE entity_id = %s AND pipeline = %s
                ORDER BY started_at DESC LIMIT %s
                """,
                (entity_id, pipeline, limit),
            )
        else:
            cur.execute(
                """
                SELECT trace_id, run_id, entity_type, pipeline, function_name,
                       started_at, completed_at, duration_ms, status, error_message,
                       triggered_by
                FROM execution_traces
                WHERE entity_id = %s
                ORDER BY started_at DESC LIMIT %s
                """,
                (entity_id, limit),
            )
        rows = cur.fetchall()
        cur.close()
        return {"traces": [dict(r) for r in rows]}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Activity SSE stream — broadcasts new trace rows across all pipelines
# ---------------------------------------------------------------------------

@router.get("/activity")
async def stream_activity(since_minutes: int = 60):
    """SSE stream: broadcasts new execution_traces rows as they appear.
    Polls every 1.5 s; emits each new row as a JSON SSE event.
    Stops after 15 minutes to prevent zombie connections.
    """
    from datetime import timedelta

    async def event_generator() -> AsyncIterator[str]:
        last_seen_at = datetime.now(timezone.utc) - timedelta(minutes=since_minutes)
        max_ticks = 600  # 15 minutes at 1.5s
        tick = 0
        while tick < max_ticks:
            try:
                conn = _get_conn()
                cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
                cur.execute(
                    """
                    SELECT trace_id, run_id, entity_id, entity_type, pipeline,
                           function_name, started_at, completed_at, duration_ms,
                           status, error_message, triggered_by
                    FROM execution_traces
                    WHERE started_at > %s
                    ORDER BY started_at ASC
                    LIMIT 100
                    """,
                    (last_seen_at,),
                )
                rows = cur.fetchall()
                cur.close()
                conn.close()

                for row in rows:
                    row = dict(row)
                    # Serialize datetimes
                    for k, v in row.items():
                        if hasattr(v, "isoformat"):
                            row[k] = v.isoformat()
                    if row["started_at"]:
                        from datetime import datetime as _dt
                        ts = _dt.fromisoformat(row["started_at"])
                        if ts.tzinfo is None:
                            from datetime import timezone as _tz
                            ts = ts.replace(tzinfo=_tz.utc)
                        if ts > last_seen_at:
                            last_seen_at = ts
                    yield f"data: {json.dumps(row)}\n\n"

                # Heartbeat every tick
                yield f"data: {json.dumps({'type': 'heartbeat', 'tick': tick})}\n\n"

            except Exception as exc:
                yield f"data: {json.dumps({'type': 'error', 'msg': str(exc)[:200]})}\n\n"

            await asyncio.sleep(1.5)
            tick += 1

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/traces/detail/{trace_id}")
def get_trace_detail(trace_id: str):
    """Full trace detail including steps, inputs, outputs, assumptions, citations."""
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT * FROM execution_traces WHERE trace_id = %s",
            (trace_id,),
        )
        row = cur.fetchone()
        cur.close()
        if not row:
            raise HTTPException(status_code=404, detail="Trace not found")
        return dict(row)
    finally:
        conn.close()


@router.get("/traces/stream/{trace_id}")
async def stream_trace(trace_id: str):
    """Server-Sent Events stream for a running trace. Polls until status != 'running'."""

    async def event_generator() -> AsyncIterator[str]:
        last_step_count = 0
        poll_count = 0
        max_polls = 300  # 5 minutes at 1s intervals

        while poll_count < max_polls:
            try:
                conn = _get_conn()
                cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
                cur.execute(
                    """
                    SELECT trace_id, status, steps, outputs, error_message,
                           duration_ms, completed_at
                    FROM execution_traces WHERE trace_id = %s
                    """,
                    (trace_id,),
                )
                row = cur.fetchone()
                cur.close()
                conn.close()

                if not row:
                    yield "data: {\"error\": \"trace not found\"}\n\n"
                    return

                row = dict(row)
                steps = row.get("steps") or []

                # Emit new steps since last poll
                new_steps = steps[last_step_count:]
                if new_steps:
                    last_step_count = len(steps)
                    for step in new_steps:
                        payload = json.dumps({"type": "step", "step": step})
                        yield f"data: {payload}\n\n"

                status = row.get("status", "running")
                if status != "running":
                    final = json.dumps({
                        "type": "done",
                        "status": status,
                        "duration_ms": row.get("duration_ms"),
                        "outputs": row.get("outputs"),
                        "error_message": row.get("error_message"),
                    })
                    yield f"data: {final}\n\n"
                    return

            except Exception as exc:
                yield f"data: {{\"error\": \"{str(exc)[:200]}\"}}\n\n"
                return

            await asyncio.sleep(1)
            poll_count += 1

        yield "data: {\"error\": \"stream timeout\"}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Source inspection
# ---------------------------------------------------------------------------

def _module_to_file_path(module_path: str) -> str | None:
    """Resolve a dotted module path to its absolute file path (must be in /app)."""
    try:
        mod = importlib.import_module(module_path)
        path = inspect.getfile(mod)
        # Must be within /app to prevent writes outside the agents tree
        if path.startswith("/app/"):
            return path
        return None
    except Exception:
        return None


@router.get("/source/{module_path:path}")
def get_source(module_path: str, fn: str | None = None):
    """Return source code for a module or specific function within it."""
    if not _safe_path(module_path):
        raise HTTPException(status_code=403, detail="Module not in allowlist")
    try:
        mod = importlib.import_module(module_path)
    except ImportError as exc:
        raise HTTPException(status_code=404, detail=f"Module not found: {exc}")

    if fn:
        obj = getattr(mod, fn, None)
        if obj is None:
            raise HTTPException(status_code=404, detail=f"Function '{fn}' not in module")
        try:
            source = inspect.getsource(obj)
            sig = str(inspect.signature(obj))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))
        return {
            "module": module_path,
            "function": fn,
            "signature": sig,
            "source": source,
        }

    try:
        source = inspect.getsource(mod)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"module": module_path, "source": source}


@router.put("/source/{module_path:path}")
def put_source(module_path: str, body: dict):
    """Write updated source code to the agent file on disk.

    The agents directory is volume-mounted so edits persist immediately.
    The API server auto-reloads on file change (uvicorn --reload).
    Worker needs a restart to pick up changes.
    """
    if not _safe_path(module_path):
        raise HTTPException(status_code=403, detail="Module not in allowlist")
    file_path = _module_to_file_path(module_path)
    if not file_path:
        raise HTTPException(status_code=404, detail="Module file not found or outside /app")
    source = body.get("source", "")
    if not source or not source.strip():
        raise HTTPException(status_code=400, detail="source must not be empty")
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(source)
        return {"ok": True, "file": file_path, "bytes": len(source)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Pipeline prompt overrides (agent_prompt_overrides table)
# ---------------------------------------------------------------------------

def _ensure_prompt_registry():
    """Import modules that register prompts so the registry is populated."""
    try:
        importlib.import_module("app.agents.composition_agent")
    except Exception:
        pass
    try:
        importlib.import_module("app.agents.tea_agent")
    except Exception:
        pass


@router.get("/prompts")
def list_prompts():
    """List all registered pipeline prompts with their active overrides."""
    _ensure_prompt_registry()
    try:
        from app.agents.prompt_store import list_all_prompts
        return {"prompts": list_all_prompts()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/prompts/{agent_module:path}/{prompt_key}")
def get_prompt_detail(agent_module: str, prompt_key: str):
    """Get a single prompt — returns both default text and active override if any."""
    _ensure_prompt_registry()
    try:
        from app.agents.prompt_store import PROMPT_REGISTRY, list_all_prompts
        prompts = list_all_prompts()
        for p in prompts:
            if p["agent_module"] == agent_module and p["prompt_key"] == prompt_key:
                return p
        raise HTTPException(status_code=404, detail=f"Prompt '{agent_module}/{prompt_key}' not registered")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.put("/prompts/{agent_module:path}/{prompt_key}")
def save_prompt_override(agent_module: str, prompt_key: str, body: dict):
    """Save a prompt override. Body: {prompt_text, description?}"""
    _ensure_prompt_registry()
    from app.agents.prompt_store import PROMPT_REGISTRY, save_override
    # Only allow registered prompts
    if agent_module not in PROMPT_REGISTRY or prompt_key not in PROMPT_REGISTRY[agent_module]:
        raise HTTPException(status_code=404, detail=f"Prompt '{agent_module}/{prompt_key}' not registered")
    prompt_text = body.get("prompt_text", "").strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail="prompt_text must not be empty")
    description = body.get("description", "")
    try:
        save_override(agent_module, prompt_key, prompt_text, description)
        return {"ok": True, "agent_module": agent_module, "prompt_key": prompt_key}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/prompts/{agent_module:path}/{prompt_key}")
def delete_prompt_override(agent_module: str, prompt_key: str):
    """Delete a prompt override, reverting the agent to its code default."""
    try:
        from app.agents.prompt_store import delete_override
        deleted = delete_override(agent_module, prompt_key)
        return {"ok": True, "deleted": deleted}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Auto-generated docs
# ---------------------------------------------------------------------------

@router.get("/docs")
def get_docs():
    """Auto-generate documentation by introspecting known modules."""
    result = []
    for module_path, display_name in _DOC_MODULES:
        entry: dict = {"module": module_path, "display_name": display_name, "functions": []}
        try:
            mod = importlib.import_module(module_path)
            for name, obj in inspect.getmembers(mod, predicate=inspect.isfunction):
                if name.startswith("_"):
                    continue
                if obj.__module__ != module_path:
                    continue
                try:
                    sig = str(inspect.signature(obj))
                    doc = inspect.getdoc(obj) or ""
                    is_async = inspect.iscoroutinefunction(obj)
                    entry["functions"].append({
                        "name": name,
                        "signature": sig,
                        "docstring": doc,
                        "async": is_async,
                    })
                except Exception:
                    pass
        except Exception as exc:
            entry["error"] = str(exc)
        result.append(entry)
    return {"modules": result}


# ---------------------------------------------------------------------------
# System assumptions
# ---------------------------------------------------------------------------

@router.get("/assumptions")
def get_assumptions():
    """Return all hard-coded system assumptions from known modules."""
    result = {}
    for module_path, attr_name in _ASSUMPTION_SOURCES:
        try:
            mod = importlib.import_module(module_path)
            val = getattr(mod, attr_name, None)
            if val is None:
                continue
            # Convert to JSON-safe form
            try:
                json.dumps(val)
                result[f"{module_path}.{attr_name}"] = val
            except TypeError:
                result[f"{module_path}.{attr_name}"] = str(val)
        except Exception as exc:
            result[f"{module_path}.{attr_name}"] = {"error": str(exc)}
    return {"assumptions": result}


# ---------------------------------------------------------------------------
# Recent traces (no entity filter — for dashboard)
# ---------------------------------------------------------------------------

@router.get("/traces")
def list_recent_traces(
    pipeline: str | None = None,
    status: str | None = None,
    limit: int = 50,
):
    """List most recent execution traces across all entities."""
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        clauses = []
        params: list = []
        if pipeline:
            clauses.append("pipeline = %s")
            params.append(pipeline)
        if status:
            clauses.append("status = %s")
            params.append(status)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        params.append(limit)
        cur.execute(
            f"""
            SELECT trace_id, run_id, entity_id, entity_type, pipeline,
                   function_name, started_at, completed_at, duration_ms,
                   status, error_message, triggered_by
            FROM execution_traces {where}
            ORDER BY started_at DESC LIMIT %s
            """,
            params,
        )
        rows = cur.fetchall()
        cur.close()
        return {"traces": [dict(r) for r in rows]}
    finally:
        conn.close()
