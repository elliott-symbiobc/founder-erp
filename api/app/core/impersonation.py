"""impersonation.py — read-only "View as" preview for admins.

An admin previewing a partner cohort needs the app to behave exactly as it does
for that partner: same sidebar, same permissions, same 403s, same data. The
cheapest faithful way to do that is to swap the identity for the request, which
is what this middleware does — but only under tight conditions:

  * the real caller must be an admin (their headers were already verified by
    enforce_internal_identity, which runs immediately before this),
  * the target must be an active account with role 'partner', so this can never
    be used to step into another admin or a scientist,
  * the request must be a read. Any write is refused, so a preview can never
    change data while wearing someone else's name.

The original admin is recorded in `X-Impersonated-By` and lands in
activity_log.impersonated_by, so the audit trail says who really made the
request instead of blaming the partner.
"""

import logging
import os
import time

import psycopg2
from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)

READ_METHODS = ("GET", "HEAD", "OPTIONS")

_CACHE_TTL_S = 30
_cache: dict[str, tuple[float, dict | None]] = {}


def _target(user_id: str) -> dict | None:
    """Resolve an impersonation target, or None if it is not a valid one."""
    hit = _cache.get(user_id)
    now = time.monotonic()
    if hit and now - hit[0] < _CACHE_TTL_S:
        return hit[1]

    found: dict | None = None
    try:
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT user_id, email, role FROM users "
                    " WHERE user_id = %s AND is_active AND role = 'partner'",
                    (user_id,),
                )
                row = cur.fetchone()
        finally:
            conn.close()
        if row:
            found = {"user_id": str(row[0]), "email": row[1], "role": row[2]}
    except Exception:
        logger.warning("impersonation: target lookup failed", exc_info=True)
        found = None

    _cache[user_id] = (now, found)
    return found


def invalidate_all() -> None:
    _cache.clear()


def _set_headers(request: Request, updates: dict[str, str]) -> None:
    """Rewrite identity headers in the raw ASGI scope.

    Starlette caches `request.headers` on first access, so the scope is edited
    before anything downstream reads it.
    """
    lowered = {k.lower().encode("latin-1"): v.encode("latin-1") for k, v in updates.items()}
    kept = [(k, v) for (k, v) in request.scope["headers"] if k.lower() not in lowered]
    request.scope["headers"] = kept + list(lowered.items())
    request._headers = None  # type: ignore[attr-defined]


class ImpersonationMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        target_id = request.headers.get("X-View-As")
        if not target_id:
            return await call_next(request)

        real_id = request.headers.get("X-User-Id")
        if request.headers.get("X-User-Role") != "admin" or not real_id:
            # Not an admin (or identity was stripped as unverified) — ignore the
            # header entirely rather than hinting that the mechanism exists.
            return await call_next(request)

        target = _target(target_id)
        if not target:
            return JSONResponse(
                {"detail": "That preview account is not available."}, status_code=404
            )

        if request.method not in READ_METHODS:
            return JSONResponse(
                {"detail": "Preview mode is read-only. Exit preview to make changes."},
                status_code=403,
            )

        _set_headers(request, {
            "X-User-Id": target["user_id"],
            "X-User-Email": target["email"],
            "X-User-Role": target["role"],
            "X-Impersonated-By": real_id,
        })
        return await call_next(request)
