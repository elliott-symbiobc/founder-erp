"""
Shared utility for logging Anthropic and Deepgram API usage to api_usage_log.

Cost constants (per million tokens / per second):
  Anthropic pricing as of 2026-04 (input / output per 1M tokens):
    claude-opus-4*        $15.00 / $75.00
    claude-sonnet-4*       $3.00 / $15.00
    claude-haiku-4*        $0.80 /  $4.00
  Deepgram nova-2: $0.0043 / minute = $0.00007167 / second
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import psycopg2

logger = logging.getLogger(__name__)

# ── Anthropic per-token costs (USD per token, not per million) ──────────────

_ANTHROPIC_COSTS: dict[str, tuple[float, float]] = {
    # model prefix → (input_cost_per_token, output_cost_per_token)
    "claude-opus-4":    (15.00 / 1_000_000, 75.00 / 1_000_000),
    "claude-sonnet-4":  ( 3.00 / 1_000_000, 15.00 / 1_000_000),
    "claude-haiku-4":   ( 0.80 / 1_000_000,  4.00 / 1_000_000),
    # legacy / variant spellings
    "claude-opus-4-6":       (15.00 / 1_000_000, 75.00 / 1_000_000),
    "claude-sonnet-4-6":     ( 3.00 / 1_000_000, 15.00 / 1_000_000),
    "claude-haiku-4-5":      ( 0.80 / 1_000_000,  4.00 / 1_000_000),
    "claude-sonnet-4-20250514": (3.00 / 1_000_000, 15.00 / 1_000_000),
}
_DEFAULT_ANTHROPIC_COST = (3.00 / 1_000_000, 15.00 / 1_000_000)  # sonnet fallback

# Deepgram nova-2: $0.0043 / minute
_DEEPGRAM_COST_PER_SECOND = 0.0043 / 60.0


def _get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _anthropic_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    cost_in, cost_out = _DEFAULT_ANTHROPIC_COST
    for prefix, costs in _ANTHROPIC_COSTS.items():
        if model.startswith(prefix):
            cost_in, cost_out = costs
            break
    return input_tokens * cost_in + output_tokens * cost_out


def log_anthropic_call(
    *,
    operation: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    paper_id: Optional[str] = None,
) -> None:
    """Fire-and-forget: log one Anthropic messages.create() call."""
    cost = _anthropic_cost(model, input_tokens, output_tokens)
    try:
        conn = _get_conn()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO api_usage_log
                    (service, operation, model, input_tokens, output_tokens, cost_usd, paper_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                ("anthropic", operation, model, input_tokens, output_tokens, cost, paper_id or None),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("usage_logger: failed to log anthropic call: %s", exc)


def log_deepgram_session(*, audio_seconds: float, model: str = "nova-2") -> None:
    """Log one completed Deepgram streaming session."""
    cost = audio_seconds * _DEEPGRAM_COST_PER_SECOND
    try:
        conn = _get_conn()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO api_usage_log
                    (service, operation, model, audio_seconds, cost_usd)
                VALUES (%s, %s, %s, %s, %s)
                """,
                ("deepgram", "transcription", model, audio_seconds, cost),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("usage_logger: failed to log deepgram session: %s", exc)