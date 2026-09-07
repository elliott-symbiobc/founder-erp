"""module_owners.py — Module ownership assignments

GET    /module-owners          — list all module owners (authenticated)
GET    /module-owners/my       — modules owned by current user (authenticated)
PUT    /module-owners/{key}    — assign module owner (admin only)
DELETE /module-owners/{key}    — remove module owner (admin only)
"""

import os
import logging

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.routers.auth import get_current_user, require_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/module-owners", tags=["module-owners"])

MODULES: dict[str, str] = {
    "dashboard": "Dashboard",
    "tasks": "Tasks",
    "calendar": "Calendar",
    "reports": "Reports",
    "notebook": "Notebook",
    "crm": "CRM",
    "projects": "Projects",
    "portals": "Portals",
    "contacts": "Contacts",
    "fpa": "FP&A",
    "funding": "Funding",
    "receivables": "Receivables",
    "payables": "Payables",
    "analyses": "Prelim. TEA",
    "model": "ML Models",
    "literature": "Literature",
    "system-design": "System Design",
    "runs": "Runs",
    "protocols": "Protocol Bank",
    "strains": "Strains",
    "enzymes": "Enzymes",
    "chemicals": "Chemicals",
    "consumables": "Consumables",
    "equipment": "Equipment",
    "inventory": "Inventory",
    "marketing": "Marketing",
}


def get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def ensure_table() -> None:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS module_owners (
                    module_key  TEXT PRIMARY KEY,
                    user_id     TEXT NOT NULL,
                    user_email  TEXT NOT NULL,
                    user_name   TEXT NOT NULL,
                    assigned_at TIMESTAMPTZ DEFAULT NOW()
                )
            """)
        conn.commit()
    finally:
        conn.close()


class SetOwnerRequest(BaseModel):
    user_id: str
    user_email: str
    user_name: str


@router.get("")
def list_owners(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT module_key, user_id, user_email, user_name FROM module_owners"
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    return [
        {
            "module_key": r["module_key"],
            "module_label": MODULES.get(r["module_key"], r["module_key"]),
            "user_id": r["user_id"],
            "user_email": r["user_email"],
            "user_name": r["user_name"],
        }
        for r in rows
    ]


@router.get("/my")
def my_modules(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT module_key FROM module_owners WHERE user_email = %s",
                (user["email"],),
            )
            module_rows = cur.fetchall()

            projects = []
            if user.get("user_id"):
                cur.execute(
                    """
                    SELECT project_id, name
                    FROM projects
                    WHERE assigned_to = %s::uuid AND status != 'archived'
                    ORDER BY name
                    """,
                    (user["user_id"],),
                )
                projects = cur.fetchall()
    finally:
        conn.close()

    result = [
        {
            "module_key": r["module_key"],
            "module_label": MODULES.get(r["module_key"], r["module_key"]),
        }
        for r in module_rows
    ]
    result += [
        {
            "module_key": f"project:{p['project_id']}",
            "module_label": p["name"],
            "project_id": str(p["project_id"]),
            "is_project_lead": True,
        }
        for p in projects
    ]
    return result


@router.put("/{module_key}")
def set_owner(module_key: str, body: SetOwnerRequest, request: Request):
    require_admin(request)
    if module_key not in MODULES:
        raise HTTPException(status_code=404, detail=f"Unknown module: {module_key}")

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO module_owners (module_key, user_id, user_email, user_name)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (module_key) DO UPDATE
                  SET user_id     = EXCLUDED.user_id,
                      user_email  = EXCLUDED.user_email,
                      user_name   = EXCLUDED.user_name,
                      assigned_at = NOW()
                """,
                (module_key, body.user_id, body.user_email, body.user_name),
            )
        conn.commit()
    finally:
        conn.close()

    return {"ok": True, "module_key": module_key}


@router.delete("/{module_key}")
def remove_owner(module_key: str, request: Request):
    require_admin(request)

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM module_owners WHERE module_key = %s", (module_key,)
            )
        conn.commit()
    finally:
        conn.close()

    return {"ok": True}
