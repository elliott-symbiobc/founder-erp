import hmac
import logging
import os

import psycopg2
import redis as redis_lib
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.routers import auth

from app.routers import reports
from app.routers import dev
from app.routers import users
from app.routers import fpa
from app.routers import contacts
from app.routers import advisors
from app.routers import projects
from app.routers import notes
from app.routers import tasks
from app.routers import calendar
from app.routers import planner
from app.routers import crm
from app.routers import drive
from app.routers import funding
from app.routers import dilutive
from app.routers import transfers
from app.routers import comms
from app.routers import cap_table
from app.routers import invoices
from app.routers import stripe_billing
from app.routers import portal
from app.routers import settings as settings_router
from app.routers import agent_manager
from app.routers import notifications
from app.routers import email as email_router
from app.routers import messaging
from app.routers import milestones
from app.routers import module_owners
from app.routers import marketing
from app.routers import time_tracking
from app.routers import sms as sms_router
from app.routers import partners
from app.routers import activity as activity_router
from app.core.agent_config import _ensure_tables
from app.core.activity import ActivityLogMiddleware, start_flusher
from app.core.partner_guard import PartnerGuardMiddleware
from app.core.impersonation import ImpersonationMiddleware

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Open ERP API",
    root_path="/api",
)

# ── Identity headers must come from the frontend proxy ────────────────────────
#
# Routers authenticate by reading X-User-Id, which the Next proxy sets from the
# verified NextAuth session. Nothing else proved where that header came from, so
# anything able to reach the API directly could assert any user id. When
# INTERNAL_API_SECRET is configured, identity headers are only honoured
# alongside it and are stripped otherwise, which downgrades a forged request to
# an unauthenticated one rather than letting it through.
_INTERNAL_SECRET = os.environ.get("INTERNAL_API_SECRET", "").strip()

if not _INTERNAL_SECRET:
    logger.warning(
        "INTERNAL_API_SECRET is not set: identity headers (X-User-Id) are "
        "accepted from any caller that can reach this API. Set it in .env and "
        "restart both the api and frontend containers."
    )

# Starlette's Headers mapping is keyed by str; the raw ASGI scope holds bytes.
_IDENTITY_HEADERS = ("x-user-id", "x-user-email", "x-user-role")
_IDENTITY_HEADERS_B = tuple(h.encode("latin-1") for h in _IDENTITY_HEADERS)


# ── Middleware order ─────────────────────────────────────────────────────────
#
# Starlette runs the LAST-registered layer first, so this block reads
# inside-out. Registering in this order gives the execution order:
#
#   CORS -> enforce_internal_identity -> Impersonation -> ActivityLog
#        -> PartnerGuard -> routers
#
# Each position is load-bearing:
#   * Impersonation sits inside enforce_internal_identity, so the admin role it
#     trusts has already been verified, and outside everything else, so the
#     swapped identity is what the rest of the stack sees.
#   * ActivityLog sits outside PartnerGuard so a *denied* partner request is
#     still recorded — attempted access to a module a cohort was never granted
#     is exactly what an audit log should capture.
app.add_middleware(PartnerGuardMiddleware)
app.add_middleware(ActivityLogMiddleware)
app.add_middleware(ImpersonationMiddleware)


@app.middleware("http")
async def enforce_internal_identity(request: Request, call_next):
    if _INTERNAL_SECRET:
        presented = request.headers.get("X-Internal-Secret", "")
        if not hmac.compare_digest(presented, _INTERNAL_SECRET):
            if any(h in request.headers for h in _IDENTITY_HEADERS):
                logger.warning(
                    "Stripped unverified identity headers from %s %s",
                    request.method, request.url.path,
                )
                request.scope["headers"] = [
                    (k, v) for (k, v) in request.scope["headers"]
                    if k.lower() not in _IDENTITY_HEADERS_B
                ]
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://erp.example.com"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def _start_activity_flusher():
    start_flusher()


app.include_router(auth.router)
app.include_router(reports.router)
app.include_router(dev.router, prefix="/dev", tags=["dev"])
app.include_router(users.router)
app.include_router(fpa.router)
app.include_router(contacts.router)
app.include_router(advisors.router)
app.include_router(projects.router)
app.include_router(notes.router)
app.include_router(tasks.router)
app.include_router(calendar.router)
app.include_router(planner.router)
app.include_router(crm.router)
app.include_router(drive.router)
app.include_router(funding.router)
app.include_router(dilutive.router)
app.include_router(transfers.router)
app.include_router(comms.router)
app.include_router(cap_table.router)
app.include_router(invoices.router)
app.include_router(stripe_billing.router)
app.include_router(portal.router)
app.include_router(settings_router.router)
app.include_router(agent_manager.router)
app.include_router(notifications.router)
app.include_router(email_router.router)
app.include_router(messaging.router)
app.include_router(milestones.router)
app.include_router(module_owners.router)
app.include_router(marketing.router)
app.include_router(time_tracking.router)
app.include_router(sms_router.router)
app.include_router(partners.router)
app.include_router(activity_router.router)



def _init_db():
    """Apply sql/schema.sql if the database has not been initialized yet."""
    schema_path = os.path.join(os.path.dirname(__file__), "..", "sql", "schema.sql")
    if not os.path.exists(schema_path):
        logger.warning("schema.sql not found, skipping DB init")
        return
    try:
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        try:
            cur = conn.cursor()
            cur.execute("SELECT to_regclass('public.users')")
            if not cur.fetchone()[0]:
                logger.info("Initializing database schema...")
                with open(schema_path, "r") as f:
                    # pg_dump emits \restrict / \unrestrict psql meta-commands.
                    # psql understands them; the driver does not, so drop them.
                    sql = "\n".join(
                        line for line in f.read().splitlines()
                        if not line.startswith("\\")
                    )
                cur.execute(sql)
                conn.commit()
                logger.info("Database schema applied.")
            cur.close()
        finally:
            conn.close()
    except Exception as e:
        logger.error("DB init failed: %s", e)
        raise


@app.on_event("startup")
async def startup_event():
    logger.info("Open ERP API starting up")
    _init_db()
    _ensure_tables()
    module_owners.ensure_table()
    time_tracking.ensure_table()
    users.ensure_user_type_column()
    email_router.ensure_suggestions_user_column()
    crm.ensure_crm_systems()


@app.get("/health")
def health_check():
    db_status = "connected"
    db_error = None
    redis_status = "connected"
    redis_error = None

    # Check PostgreSQL
    try:
        conn = psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=3)
        conn.close()
    except Exception as e:
        db_status = "error"
        db_error = str(e)

    # Check Redis
    try:
        r = redis_lib.from_url(os.environ["REDIS_URL"], socket_connect_timeout=3)
        r.ping()
    except Exception as e:
        redis_status = "error"
        redis_error = str(e)

    overall = "ok" if db_status == "connected" and redis_status == "connected" else "degraded"

    response = {"status": overall, "db": db_status, "redis": redis_status}
    if db_error:
        response["db_error"] = db_error
    if redis_error:
        response["redis_error"] = redis_error

    return response
