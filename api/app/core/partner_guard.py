"""partner_guard.py — default-deny API access for external partner accounts.

Until now the platform gated features in the sidebar and enforced almost
nothing at the endpoint: fine when every account belonged to staff, unsafe once
external partner accounts hold real logins, because hiding a nav link does not stop
anyone from calling /api/proxy/contacts directly.

This middleware closes that for the `partner` role only — staff requests are
passed through untouched, so it cannot regress existing behaviour. Students get
an allowlist: a request is permitted only if its first path segment maps to a
permission their partner organisation actually granted. Anything unmapped
(a new router, an admin tool) is denied, so the safe default survives future
code that forgets about partner accounts.
"""

import logging
import os
import time

import psycopg2
from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.partner_modules import build_segment_permission, check_consistency
from app.routers.auth import PERMISSION_KEYS, effective_permissions

logger = logging.getLogger(__name__)

# Segment -> the permission keys that unlock it, derived by inverting
# PERMISSION_SEGMENTS in partner_modules.py. It used to be written out by hand
# beside a module list in the frontend that had to agree with it and never
# checked; deriving it means a permission declares its URL footprint once and
# the two cannot drift.
SEGMENT_PERMISSION: dict[str, tuple[str, ...]] = build_segment_permission()

# Reachable by any signed-in account regardless of grants: identity, the
# Learning Center itself, and a user's own notifications and activity.
ALWAYS_ALLOWED_PREFIXES = (
    "auth",
    "learn",
    "notifications",
    "module-owners",
    "module-docs",
    "settings",
)

# Exact paths allowed even though their segment is otherwise restricted.
ALWAYS_ALLOWED_PATHS = {
    "users/me",
    "activity/me",
    "time-entries/me",
    # The partner's own sidebar is built from this list, so a partner has to be
    # able to read it. It is a menu of module names, not data.
    "partners/modules",
}

for _problem in check_consistency(set(PERMISSION_KEYS)):
    logger.error("partner module config: %s", _problem)

_CACHE_TTL_S = 30
_cache: dict[str, tuple[float, dict]] = {}


def _permissions_for(user_id: str) -> dict:
    """Effective permissions for a partner account, cached briefly.

    Without the cache this would add a query to every request; 30 seconds keeps
    a revoked grant from lingering while still collapsing a page's burst of
    calls into one lookup.
    """
    hit = _cache.get(user_id)
    now = time.monotonic()
    if hit and now - hit[0] < _CACHE_TTL_S:
        return hit[1]

    perms: dict = {}
    try:
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT u.role, u.permissions,
                              CASE WHEN o.is_active THEN o.permissions ELSE '{}'::jsonb END
                         FROM users u
                         LEFT JOIN partner_orgs o ON o.org_id = u.org_id
                        WHERE u.user_id = %s AND u.is_active""",
                    (user_id,),
                )
                row = cur.fetchone()
        finally:
            conn.close()
        if row:
            role, overrides, org_perms = row
            perms = effective_permissions(role, overrides or {}, org_perms or {})
    except Exception:
        # Fail closed: an unreachable database must not hand a partner the
        # benefit of the doubt.
        logger.warning("partner_guard: permission lookup failed", exc_info=True)
        perms = {}

    _cache[user_id] = (now, perms)
    return perms


def invalidate(user_id: str) -> None:
    """Drop one cached permission set."""
    _cache.pop(user_id, None)


def invalidate_all() -> None:
    """Drop every cached permission set.

    Called when an admin edits an organisation's grants so the change takes
    effect on the partners' next request instead of up to 30 seconds later.
    The cache holds one small dict per active partner, so clearing it whole is
    cheaper than working out which members were affected.
    """
    _cache.clear()


# The role was renamed from `student` to `partner` (migration 159). The name
# reaches this middleware inside a NextAuth JWT, which keeps whatever it was
# issued with until the session expires — so a partner who was already signed
# in still presents "student". Guarding only on the new name would let those
# sessions past the default-deny entirely and be treated as staff, so both
# names are recognised. Drop "student" once no session can still carry it.
PARTNER_ROLES = ("partner", "student")


class PartnerGuardMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.headers.get("X-User-Role") not in PARTNER_ROLES:
            return await call_next(request)

        path = request.url.path
        rel = path[len("/api"):] if path.startswith("/api") else path
        rel = rel.strip("/")
        segment = rel.split("/", 1)[0]

        if segment in ALWAYS_ALLOWED_PREFIXES or rel in ALWAYS_ALLOWED_PATHS:
            return await call_next(request)

        user_id = request.headers.get("X-User-Id")
        if not user_id:
            return JSONResponse({"detail": "Not authenticated"}, status_code=401)

        needed = SEGMENT_PERMISSION.get(segment)
        if needed:
            perms = _permissions_for(user_id)
            if any(perms.get(key) for key in needed):
                return await call_next(request)

        logger.info("partner_guard: denied %s %s for %s", request.method, rel, user_id)
        return JSONResponse(
            {"detail": "Your account does not have access to this area."},
            status_code=403,
        )
