"""
prompt_store.py — Global registry and DB-backed override system for pipeline agent prompts.

Usage in an agent module:
    from app.agents.prompt_store import register_prompt, get_prompt

    # At module level, register the default prompt text:
    register_prompt(
        agent_module="app.agents.composition_agent",
        prompt_key="extraction_prompt",
        default=_DEFAULT_EXTRACTION_PROMPT,
        description="Extract composition values from paper text",
        variables=["substrate_name", "field_ref"],
    )

    # At call time, get the active prompt (DB override wins over default):
    template = get_prompt("app.agents.composition_agent", "extraction_prompt")
    prompt = template.format(substrate_name=substrate_name, field_ref=field_ref)
"""
from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

# Registry: agent_module → prompt_key → {default, description, variables, last_rendered}
PROMPT_REGISTRY: dict[str, dict[str, dict[str, Any]]] = {}


def register_prompt(
    agent_module: str,
    prompt_key: str,
    default: str,
    description: str = "",
    variables: list[str] | None = None,
) -> None:
    """Register a prompt's default text and metadata.

    Call this at module import time so the registry is populated before any
    API call reaches /dev/prompts.
    """
    if agent_module not in PROMPT_REGISTRY:
        PROMPT_REGISTRY[agent_module] = {}
    PROMPT_REGISTRY[agent_module][prompt_key] = {
        "default": default,
        "description": description,
        "variables": variables or [],
    }


def log_rendered_call(agent_module: str, prompt_key: str, rendered_text: str) -> None:
    """Store the last rendered (variable-substituted) prompt in memory.

    Call this immediately after formatting the template and before sending to
    Claude so the prompts tab can show exactly what was passed to the model.
    """
    import datetime
    entry = PROMPT_REGISTRY.get(agent_module, {}).get(prompt_key)
    if entry is not None:
        entry["last_rendered"] = rendered_text
        entry["last_rendered_at"] = datetime.datetime.utcnow().isoformat() + "Z"


def get_prompt(agent_module: str, prompt_key: str) -> str:
    """Return the active prompt text.

    Priority: DB override (is_active=TRUE) > registered default > empty string.
    DB lookup failures are logged and silently fall through to the default.
    """
    try:
        import psycopg2
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            cur = conn.cursor()
            cur.execute(
                """SELECT prompt_text FROM agent_prompt_overrides
                   WHERE agent_module = %s AND prompt_key = %s AND is_active = TRUE
                   LIMIT 1""",
                (agent_module, prompt_key),
            )
            row = cur.fetchone()
            cur.close()
            if row:
                return row[0]
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("prompt_store.get_prompt DB lookup failed (%s/%s): %s", agent_module, prompt_key, exc)

    return PROMPT_REGISTRY.get(agent_module, {}).get(prompt_key, {}).get("default", "")


def save_override(
    agent_module: str,
    prompt_key: str,
    prompt_text: str,
    description: str = "",
    created_by: str | None = None,
) -> None:
    """Upsert a prompt override into the DB."""
    import psycopg2
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO agent_prompt_overrides
                   (agent_module, prompt_key, prompt_text, description, is_active, created_by)
               VALUES (%s, %s, %s, %s, TRUE, %s)
               ON CONFLICT (agent_module, prompt_key)
               DO UPDATE SET
                   prompt_text = EXCLUDED.prompt_text,
                   description = EXCLUDED.description,
                   is_active   = TRUE,
                   updated_at  = NOW(),
                   created_by  = EXCLUDED.created_by""",
            (agent_module, prompt_key, prompt_text, description or None, created_by),
        )
        conn.commit()
        cur.close()
    finally:
        conn.close()


def delete_override(agent_module: str, prompt_key: str) -> bool:
    """Delete a prompt override (reverts to default). Returns True if a row was deleted."""
    import psycopg2
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM agent_prompt_overrides WHERE agent_module = %s AND prompt_key = %s",
            (agent_module, prompt_key),
        )
        deleted = cur.rowcount > 0
        conn.commit()
        cur.close()
        return deleted
    finally:
        conn.close()


def list_all_prompts() -> list[dict]:
    """Return all registered prompts merged with any active DB overrides.

    Each item has: agent_module, prompt_key, description, variables,
    default_text, override_text (None if no override), is_overridden,
    updated_at (from DB row if overridden).
    """
    # Fetch all DB overrides
    db_overrides: dict[tuple[str, str], dict] = {}
    try:
        import psycopg2
        import psycopg2.extras
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(
                "SELECT agent_module, prompt_key, prompt_text, description, updated_at, created_by "
                "FROM agent_prompt_overrides WHERE is_active = TRUE"
            )
            for row in cur.fetchall():
                db_overrides[(row["agent_module"], row["prompt_key"])] = dict(row)
            cur.close()
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("prompt_store.list_all_prompts DB error: %s", exc)

    result = []
    for agent_module, prompts in sorted(PROMPT_REGISTRY.items()):
        for prompt_key, meta in sorted(prompts.items()):
            override_row = db_overrides.get((agent_module, prompt_key))
            item = {
                "agent_module": agent_module,
                "prompt_key": prompt_key,
                "description": meta["description"],
                "variables": meta["variables"],
                "default_text": meta["default"],
                "override_text": override_row["prompt_text"] if override_row else None,
                "is_overridden": override_row is not None,
                "override_description": (override_row or {}).get("description"),
                "updated_at": (override_row or {}).get("updated_at"),
                "created_by": (override_row or {}).get("created_by"),
                "last_rendered_text": meta.get("last_rendered"),
                "last_rendered_at": meta.get("last_rendered_at"),
            }
            result.append(item)
    return result
