"""Execution tracer: records pipeline runs to execution_traces for developer mode."""
from __future__ import annotations

import hashlib
import inspect
import json
import logging
import os
import time
import traceback
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _source_hash(fn) -> str | None:
    try:
        src = inspect.getsource(fn)
        return hashlib.sha1(src.encode()).hexdigest()[:12]
    except Exception:
        return None


class ExecutionTracer:
    """Context manager that records a pipeline run to execution_traces.

    Usage::

        with ExecutionTracer(
            pipeline="tea",
            entity_id=record_id,
            entity_type="record",
            fn=run_tea_for_route,
            inputs={"route_code": route_code},
        ) as tracer:
            tracer.step("Resolving outputs", {"n_outputs": 3})
            result = do_work()
            tracer.set_outputs(result)
    """

    def __init__(
        self,
        pipeline: str,
        entity_id: str | None = None,
        entity_type: str | None = None,
        fn=None,
        inputs: dict | None = None,
        run_id: str | None = None,
        triggered_by: str = "system",
        user_session: str | None = None,
    ):
        self.trace_id = str(uuid.uuid4())
        self.run_id = run_id or str(uuid.uuid4())
        self.pipeline = pipeline
        self.entity_id = entity_id
        self.entity_type = entity_type
        self.fn = fn
        self.inputs = inputs or {}
        self.triggered_by = triggered_by
        self.user_session = user_session

        self.steps: list[dict] = []
        self.outputs: dict | None = None
        self.assumptions: list[dict] = []
        self.citations: list[dict] = []
        self.warnings: list[str] = []
        self.status = "running"
        self.error_message: str | None = None
        self.error_traceback: str | None = None

        self.module_path = fn.__module__ if fn else None
        self.function_name = fn.__qualname__ if fn else None
        self.source_hash = _source_hash(fn) if fn else None
        self.started_at = _now()
        self._step_t0 = time.monotonic()

        # Write initial row so SSE can pick it up immediately
        self._write_initial()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def step(self, label: str, data: dict | None = None):
        """Record a named step with optional payload."""
        elapsed = int((time.monotonic() - self._step_t0) * 1000)
        self.steps.append({"label": label, "elapsed_ms": elapsed, "data": data or {}})
        self._patch_steps()

    def set_outputs(self, outputs: dict):
        self.outputs = outputs

    def set_assumptions(self, assumptions: list[dict]):
        """Each dict: {key, value, source, confidence, note}"""
        self.assumptions = assumptions

    def add_citation(self, key: str, text: str, doi: str | None = None):
        self.citations.append({"key": key, "text": text, "doi": doi})

    def warning(self, msg: str):
        self.warnings.append(msg)
        self.step(f"WARNING: {msg}")

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        completed_at = _now()
        duration_ms = int((time.monotonic() - self._step_t0) * 1000)

        if exc_type is not None:
            self.status = "error"
            self.error_message = str(exc_val)
            self.error_traceback = "".join(
                traceback.format_exception(exc_type, exc_val, exc_tb)
            )
        else:
            self.status = "success"

        try:
            conn = _get_conn()
            cur = conn.cursor()
            cur.execute(
                """
                UPDATE execution_traces SET
                    completed_at   = %s,
                    duration_ms    = %s,
                    status         = %s,
                    steps          = %s::jsonb,
                    outputs        = %s::jsonb,
                    assumptions    = %s::jsonb,
                    citations      = %s::jsonb,
                    error_message  = %s,
                    error_traceback = %s
                WHERE trace_id = %s
                """,
                (
                    completed_at,
                    duration_ms,
                    self.status,
                    json.dumps(self.steps),
                    json.dumps(self.outputs) if self.outputs is not None else None,
                    json.dumps(self.assumptions),
                    json.dumps(self.citations),
                    self.error_message,
                    self.error_traceback,
                    self.trace_id,
                ),
            )
            conn.commit()
            cur.close()
            conn.close()
        except Exception:
            logger.exception("ExecutionTracer: failed to finalise trace %s", self.trace_id)

        return False  # don't suppress exceptions

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _write_initial(self):
        try:
            conn = _get_conn()
            psycopg2.extras.register_uuid()
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO execution_traces
                    (trace_id, run_id, entity_id, entity_type, pipeline,
                     module_path, function_name, started_at, status,
                     inputs, steps, source_hash, triggered_by, user_session)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s::jsonb, %s::jsonb, %s, %s, %s)
                """,
                (
                    self.trace_id,
                    self.run_id,
                    self.entity_id,
                    self.entity_type,
                    self.pipeline,
                    self.module_path,
                    self.function_name,
                    self.started_at,
                    "running",
                    json.dumps(self.inputs),
                    json.dumps([]),
                    self.source_hash,
                    self.triggered_by,
                    self.user_session,
                ),
            )
            conn.commit()
            cur.close()
            conn.close()
        except Exception:
            logger.exception("ExecutionTracer: failed to write initial trace %s", self.trace_id)

    def _patch_steps(self):
        """Update only the steps column (live progress)."""
        try:
            conn = _get_conn()
            cur = conn.cursor()
            cur.execute(
                "UPDATE execution_traces SET steps = %s::jsonb WHERE trace_id = %s",
                (json.dumps(self.steps), self.trace_id),
            )
            conn.commit()
            cur.close()
            conn.close()
        except Exception:
            logger.exception("ExecutionTracer: failed to patch steps for %s", self.trace_id)


@contextmanager
def trace(
    pipeline: str,
    entity_id: str | None = None,
    entity_type: str | None = None,
    fn=None,
    inputs: dict | None = None,
    triggered_by: str = "system",
):
    """Shorthand context manager wrapper around ExecutionTracer."""
    tracer = ExecutionTracer(
        pipeline=pipeline,
        entity_id=entity_id,
        entity_type=entity_type,
        fn=fn,
        inputs=inputs,
        triggered_by=triggered_by,
    )
    try:
        yield tracer
    except Exception:
        raise
    finally:
        pass  # __exit__ handles everything
