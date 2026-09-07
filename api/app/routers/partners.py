"""partners.py — external partner organisations and the Learning Center.

Admin (requires `manage_partners`):
  GET/POST    /partners/orgs                          — list / create cohorts
  GET/PATCH   /partners/orgs/{org_id}                 — read / edit a cohort
  DELETE      /partners/orgs/{org_id}                 — deactivate a cohort
  DELETE      /partners/orgs/{org_id}/permanent       — delete cohort + its accounts
  DELETE      /partners/members/{user_id}             — delete one partner account
  GET         /partners/orgs/{org_id}/members         — members of the cohort
  GET         /partners/modules                       — grantable modules (any account)
  GET         /partners/invites                       — every invite, any cohort
  GET/POST    /partners/orgs/{org_id}/invites         — list / issue invites (emails them)
  POST        /partners/invites/{invite_id}/send      — send or re-send one invite email
  DELETE      /partners/invites/{invite_id}           — revoke an invite
  PUT         /partners/orgs/{org_id}/tracks          — assign learning tracks
  GET         /partners/orgs/{org_id}/progress        — cohort progress matrix

Public (no auth — invite token is the credential):
  GET         /partners/invites/token/{token}         — invite preview
  POST        /partners/invites/token/{token}/accept  — set password, create account

Learning Center (requires `learn`):
  GET         /learn/tracks                           — my tracks + progress
  GET         /learn/tracks/{track_id}                — track with its modules
  GET         /learn/modules/{module_id}              — one module (+ my progress)
  POST        /learn/modules/{module_id}/progress     — save progress / complete
  GET         /learn/onboarding                       — next required step

Content authoring (requires `manage_partners`):
  POST/PATCH/DELETE  /learn/tracks[/{track_id}]
  POST/PATCH/DELETE  /learn/modules[/{module_id}]
"""

import logging
import os
import re
import secrets
import unicodedata
from contextlib import contextmanager

import base64
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import bcrypt as bcrypt_lib
import httpx
import psycopg2
import psycopg2.extras
from psycopg2.extras import Json
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.core.impersonation import invalidate_all as impersonation_invalidate
from app.core.partner_guard import invalidate_all
from app.core.partner_modules import MODULE_GROUPS, PARTNER_MODULES
from app.routers.email import GMAIL_BASE, _get_user_google_token
from app.routers.auth import (
    PERMISSION_KEYS,
    effective_permissions,
    get_current_user,
    require_permission,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["partners"])


# ── helpers ───────────────────────────────────────────────────────────────────

@contextmanager
def _db():
    """Cursor that commits on success and always closes the connection.

    psycopg2's own `with connection` block manages the *transaction* and leaves
    the socket open, so using it directly per request would leak a connection
    every call.
    """
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    try:
        with conn.cursor() as cur:
            yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _admin(request: Request) -> dict:
    return require_permission(request, "manage_partners")


def _learner(request: Request) -> dict:
    return require_permission(request, "learn")


def _me(request: Request) -> dict:
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def _ser(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


def _row(r) -> dict:
    return {k: _ser(v) for k, v in dict(r).items()}


def _slugify(text: str) -> str:
    s = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s or secrets.token_hex(4)


def _clean_permissions(perms: dict | None) -> dict:
    """Keep only known permission keys, coerced to bool.

    An org's grants are written straight into a partner's effective permission
    set, so an unrecognised key here would be a silent no-op that looks like a
    grant in the admin UI.
    """
    if not perms:
        return {}
    return {k: bool(v) for k, v in perms.items() if k in PERMISSION_KEYS}


# ── invitation email ──────────────────────────────────────────────────────────

def _public_base() -> str:
    return os.environ.get("PUBLIC_BASE_URL", "https://erp.example.com").rstrip("/")


def _invite_link(token: str) -> str:
    return f"{_public_base()}/invite/{token}"


def _invite_message(org: dict, invite: dict, sender_name: str) -> tuple[str, str, str]:
    """Subject, plain body and HTML body for one invitation."""
    link = _invite_link(invite["token"])
    org_name = org["name"]
    greeting = f"Hi {invite['full_name'].split()[0]}," if invite.get("full_name") else "Hi,"

    subject = f"You're invited to join {org_name} on Open ERP"

    plain = f"""{greeting}

{sender_name} has invited you to join {org_name} on the Open ERP platform.

Set your password and get started here:
{link}

This link is personal to {invite['email']} and expires in 30 days.

If you weren't expecting this, you can ignore this email.
"""

    html = f"""<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
            font-size:15px;line-height:1.55;color:#1f2937;max-width:520px">
  <p>{greeting}</p>
  <p><strong>{sender_name}</strong> has invited you to join
     <strong>{org_name}</strong> on the Open ERP platform.</p>
  <p style="margin:28px 0">
    <a href="{link}"
       style="background:#2563eb;color:#ffffff;text-decoration:none;
              padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">
      Set your password
    </a>
  </p>
  <p style="color:#6b7280;font-size:13px">
    Or paste this link into your browser:<br>
    <a href="{link}" style="color:#2563eb">{link}</a>
  </p>
  <p style="color:#6b7280;font-size:13px">
    This link is personal to {invite['email']} and expires in 30 days.
    If you weren't expecting this, you can ignore this email.
  </p>
</div>
"""
    return subject, plain, html


def _send_invite_email(sender_user_id: str, org: dict, invite: dict, sender_name: str) -> None:
    """Send one invitation through the admin's connected Gmail account.

    Raises HTTPException on failure. Callers decide whether that should fail the
    whole request — when creating invites it must not, because the invite rows
    are already valid and their links can still be copied by hand.
    """
    access_token = _get_user_google_token(sender_user_id)
    subject, plain, html = _invite_message(org, invite, sender_name)

    msg = MIMEMultipart("alternative")
    msg["To"] = invite["email"]
    msg["Subject"] = subject
    msg.attach(MIMEText(plain, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    r = httpx.post(
        f"{GMAIL_BASE}/messages/send",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"raw": raw},
        timeout=20,
    )
    if r.status_code not in (200, 201):
        logger.error("Invite email to %s failed: %s", invite["email"], r.text[:300])
        raise HTTPException(status_code=502, detail="Gmail rejected the message.")


def _sender_name(cur, user_id: str) -> str:
    cur.execute("SELECT full_name, name, email FROM users WHERE user_id = %s", (user_id,))
    row = cur.fetchone()
    if not row:
        return "The Open ERP team"
    return row["full_name"] or row["name"] or row["email"]


# ── models ────────────────────────────────────────────────────────────────────

class OrgIn(BaseModel):
    name: str
    institution: str | None = None
    description: str | None = None
    contact_name: str | None = None
    contact_email: str | None = None
    email_domains: list[str] | None = None
    permissions: dict | None = None


class OrgPatch(BaseModel):
    name: str | None = None
    institution: str | None = None
    description: str | None = None
    contact_name: str | None = None
    contact_email: str | None = None
    email_domains: list[str] | None = None
    permissions: dict | None = None
    is_active: bool | None = None


class InviteIn(BaseModel):
    emails: list[str]
    full_name: str | None = None
    # Emailing is the normal path, but an admin can create link-only invites.
    send_email: bool = True


class AcceptIn(BaseModel):
    password: str
    full_name: str | None = None


class TracksIn(BaseModel):
    track_ids: list[str]


class TrackIn(BaseModel):
    title: str
    summary: str | None = None
    kind: str = "course"
    cover_url: str | None = None
    sort_order: int = 0
    is_published: bool = False


class TrackPatch(BaseModel):
    title: str | None = None
    summary: str | None = None
    kind: str | None = None
    cover_url: str | None = None
    sort_order: int | None = None
    is_published: bool | None = None


class ModuleIn(BaseModel):
    track_id: str
    title: str
    summary: str | None = None
    body_md: str | None = None
    video_url: str | None = None
    duration_min: int | None = None
    resources: list[dict] | None = None
    quiz: list[dict] | None = None
    requires_ack: bool = False
    ack_text: str | None = None
    sort_order: int = 0
    is_published: bool = True


class ModulePatch(BaseModel):
    title: str | None = None
    summary: str | None = None
    body_md: str | None = None
    video_url: str | None = None
    duration_min: int | None = None
    resources: list[dict] | None = None
    quiz: list[dict] | None = None
    requires_ack: bool | None = None
    ack_text: str | None = None
    sort_order: int | None = None
    is_published: bool | None = None
    track_id: str | None = None


class ProgressIn(BaseModel):
    video_seconds: int | None = None
    completed: bool | None = None
    acknowledged: bool | None = None
    quiz_answers: list[int] | None = None


# ── partner organisations ─────────────────────────────────────────────────────

@router.get("/partners/modules")
def list_partner_modules(request: Request):
    """The modules a cohort can be granted, and the groups they sort into.

    Served rather than duplicated in the frontend: the same list decides which
    API paths a grant opens (see partner_modules.py), so a second hand-written
    copy in TypeScript is exactly how the sidebar and the guard drifted apart.
    Any signed-in account may read it — it is a menu, not data.
    """
    _me(request)
    return {
        "modules": [m.as_dict() for m in PARTNER_MODULES],
        "groups": MODULE_GROUPS,
    }


@router.get("/partners/orgs")
def list_orgs(request: Request):
    _admin(request)
    with _db() as cur:
        cur.execute("""
            SELECT o.*,
                   (SELECT count(*) FROM users u
                     WHERE u.org_id = o.org_id AND u.is_active) AS member_count,
                   (SELECT count(*) FROM partner_invites i
                     WHERE i.org_id = o.org_id AND i.status = 'pending') AS pending_invites,
                   (SELECT count(*) FROM partner_org_tracks t
                     WHERE t.org_id = o.org_id) AS track_count
              FROM partner_orgs o
             ORDER BY o.is_active DESC, o.name
        """)
        return [_row(r) for r in cur.fetchall()]


@router.post("/partners/orgs", status_code=201)
def create_org(body: OrgIn, request: Request):
    user = _admin(request)
    slug = _slugify(body.name)
    with _db() as cur:
        cur.execute("SELECT 1 FROM partner_orgs WHERE slug = %s", (slug,))
        if cur.fetchone():
            slug = f"{slug}-{secrets.token_hex(2)}"
        cur.execute(
            """INSERT INTO partner_orgs
                 (name, slug, institution, description, contact_name, contact_email,
                  email_domains, permissions, created_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (
                body.name.strip(), slug, body.institution, body.description,
                body.contact_name, body.contact_email,
                [d.lower().lstrip("@").strip() for d in (body.email_domains or [])],
                Json(_clean_permissions(body.permissions)),
                user.get("user_id"),
            ),
        )
        return _row(cur.fetchone())


@router.get("/partners/orgs/{org_id}")
def get_org(org_id: str, request: Request):
    _admin(request)
    with _db() as cur:
        cur.execute("SELECT * FROM partner_orgs WHERE org_id = %s", (org_id,))
        org = cur.fetchone()
        if not org:
            raise HTTPException(status_code=404, detail="Organization not found")
        cur.execute(
            """SELECT t.*, ot.is_required, ot.sort_order AS assigned_order
                 FROM partner_org_tracks ot
                 JOIN learn_tracks t ON t.track_id = ot.track_id
                WHERE ot.org_id = %s
                ORDER BY ot.sort_order, t.title""",
            (org_id,),
        )
        tracks = [_row(r) for r in cur.fetchall()]
    out = _row(org)
    out["tracks"] = tracks
    return out


@router.patch("/partners/orgs/{org_id}")
def update_org(org_id: str, body: OrgPatch, request: Request):
    _admin(request)
    sets, vals = [], []
    for field in ("name", "institution", "description", "contact_name",
                  "contact_email", "is_active"):
        v = getattr(body, field)
        if v is not None:
            sets.append(f"{field} = %s")
            vals.append(v)
    if body.email_domains is not None:
        sets.append("email_domains = %s")
        vals.append([d.lower().lstrip("@").strip() for d in body.email_domains])
    if body.permissions is not None:
        sets.append("permissions = %s")
        vals.append(Json(_clean_permissions(body.permissions)))
    if not sets:
        raise HTTPException(status_code=400, detail="Nothing to update")
    sets.append("updated_at = now()")
    vals.append(org_id)
    with _db() as cur:
        cur.execute(f"UPDATE partner_orgs SET {', '.join(sets)} WHERE org_id = %s RETURNING *", vals)
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Organization not found")
    invalidate_all()
    return _row(row)


@router.delete("/partners/orgs/{org_id}")
def deactivate_org(org_id: str, request: Request):
    """Deactivate rather than delete.

    Members keep their accounts but lose every org-granted permission, and the
    activity log keeps pointing at a real organisation.
    """
    _admin(request)
    with _db() as cur:
        cur.execute(
            "UPDATE partner_orgs SET is_active = false, updated_at = now() WHERE org_id = %s",
            (org_id,),
        )
        cur.execute(
            "UPDATE users SET is_active = false WHERE org_id = %s AND role = 'partner'",
            (org_id,),
        )
        cur.execute(
            "UPDATE partner_invites SET status = 'revoked' WHERE org_id = %s AND status = 'pending'",
            (org_id,),
        )
    invalidate_all()
    return {"ok": True}


@router.delete("/partners/orgs/{org_id}/permanent")
def delete_org(org_id: str, request: Request):
    """Permanently delete an organisation and its partner accounts.

    Deactivation is the reversible option and stays the default; this is for
    cohorts that are genuinely finished. Invites, track assignments and each
    member's learning progress go with it via ON DELETE CASCADE.

    Activity rows are deliberately kept. They carry their own email and path
    columns, so the audit trail of what a cohort did survives the cohort being
    removed — deleting the evidence along with the accounts would defeat the
    point of having it.
    """
    _admin(request)
    with _db() as cur:
        cur.execute("SELECT name FROM partner_orgs WHERE org_id = %s", (org_id,))
        org = cur.fetchone()
        if not org:
            raise HTTPException(status_code=404, detail="Organization not found")

        cur.execute(
            "DELETE FROM users WHERE org_id = %s AND role = 'partner' RETURNING user_id",
            (org_id,),
        )
        removed = len(cur.fetchall())
        cur.execute("DELETE FROM partner_orgs WHERE org_id = %s", (org_id,))

    invalidate_all()
    impersonation_invalidate()
    logger.info("Deleted partner org %s (%s members)", org["name"], removed)
    return {"ok": True, "members_deleted": removed}


@router.delete("/partners/members/{user_id}")
def delete_member(user_id: str, request: Request):
    """Remove one partner account. Refuses to touch anything else."""
    _admin(request)
    with _db() as cur:
        cur.execute("SELECT email, role FROM users WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        if row["role"] != "partner":
            raise HTTPException(
                status_code=400,
                detail="Only partner accounts can be removed here. Use Users for staff.",
            )
        cur.execute("DELETE FROM users WHERE user_id = %s", (user_id,))
        # Free the address so the same person can be re-invited later.
        cur.execute("DELETE FROM partner_invites WHERE lower(email) = lower(%s)", (row["email"],))

    invalidate_all()
    impersonation_invalidate()
    logger.info("Deleted partner member %s", row["email"])
    return {"ok": True}


@router.get("/partners/orgs/{org_id}/members")
def list_members(org_id: str, request: Request):
    _admin(request)
    with _db() as cur:
        cur.execute("""
            SELECT u.user_id, u.email, u.full_name, u.name, u.role, u.is_active,
                   u.last_login, u.created_at, u.permissions,
                   (SELECT count(*) FROM learn_progress p
                     WHERE p.user_id = u.user_id AND p.status = 'completed') AS modules_completed,
                   (SELECT max(created_at) FROM activity_log a
                     WHERE a.user_id = u.user_id) AS last_activity
              FROM users u
             WHERE u.org_id = %s
             ORDER BY u.full_name NULLS LAST, u.email
        """, (org_id,))
        return [_row(r) for r in cur.fetchall()]


# ── invites ───────────────────────────────────────────────────────────────────

@router.get("/partners/invites")
def list_all_invites(request: Request):
    """Every outstanding invite, newest first, with the cohort it belongs to.

    Users lists invited people beside real accounts, because until someone
    accepts there is no row in `users` and they would otherwise be invisible
    everywhere except the cohort that issued them.
    """
    _admin(request)
    with _db() as cur:
        cur.execute("""
            SELECT i.*, o.name AS org_name
              FROM partner_invites i
              JOIN partner_orgs o ON o.org_id = i.org_id
             ORDER BY i.created_at DESC
        """)
        return [_row(r) for r in cur.fetchall()]


@router.get("/partners/orgs/{org_id}/invites")
def list_invites(org_id: str, request: Request):
    _admin(request)
    with _db() as cur:
        cur.execute(
            "SELECT * FROM partner_invites WHERE org_id = %s ORDER BY created_at DESC",
            (org_id,),
        )
        return [_row(r) for r in cur.fetchall()]


@router.post("/partners/orgs/{org_id}/invites", status_code=201)
def create_invites(org_id: str, body: InviteIn, request: Request):
    """Issue one invite per address. Re-inviting an address reissues its token."""
    user = _admin(request)
    with _db() as cur:
        cur.execute(
            "SELECT name, email_domains FROM partner_orgs WHERE org_id = %s", (org_id,)
        )
        org = cur.fetchone()
        if not org:
            raise HTTPException(status_code=404, detail="Organization not found")
        domains = org["email_domains"] or []

        created, rejected = [], []
        for raw in body.emails:
            email = raw.strip().lower()
            if not email or "@" not in email:
                rejected.append({"email": raw, "reason": "not an email address"})
                continue
            if domains and not any(email.endswith("@" + d) or email.endswith("." + d) for d in domains):
                rejected.append({"email": email, "reason": f"must be on {', '.join(domains)}"})
                continue
            cur.execute("SELECT 1 FROM users WHERE email = %s", (email,))
            if cur.fetchone():
                rejected.append({"email": email, "reason": "already has an account"})
                continue
            cur.execute(
                """INSERT INTO partner_invites (org_id, email, full_name, token, invited_by)
                   VALUES (%s,%s,%s,%s,%s)
                   ON CONFLICT (org_id, email) DO UPDATE
                     SET token = EXCLUDED.token, status = 'pending',
                         expires_at = now() + interval '30 days',
                         full_name = COALESCE(EXCLUDED.full_name, partner_invites.full_name)
                   RETURNING *""",
                (org_id, email, body.full_name, secrets.token_urlsafe(32), user.get("user_id")),
            )
            created.append(_row(cur.fetchone()))

        sender = _sender_name(cur, user.get("user_id", "")) if created else ""

        # Send after the rows exist. A delivery failure must never lose an
        # invitation: the row stays valid, the error is recorded against it,
        # and the admin can copy the link or hit Resend.
        sent, failed = 0, []
        if body.send_email:
            for inv in created:
                try:
                    _send_invite_email(user["user_id"], org, inv, sender)
                    cur.execute(
                        """UPDATE partner_invites
                              SET last_sent_at = now(), send_count = send_count + 1,
                                  last_send_error = NULL
                            WHERE invite_id = %s""",
                        (inv["invite_id"],),
                    )
                    inv["last_sent_at"] = "just now"
                    sent += 1
                except Exception as e:
                    # Deliberately broad. The comment above promises a delivery
                    # failure never loses an invitation, and only catching
                    # HTTPException broke that promise: any other error escaped,
                    # rolled the transaction back, and discarded rows that were
                    # already valid.
                    reason = str(getattr(e, "detail", None) or e)[:300]
                    logger.warning("Invite email to %s failed: %s", inv["email"], reason)
                    cur.execute(
                        "UPDATE partner_invites SET last_send_error = %s WHERE invite_id = %s",
                        (reason, inv["invite_id"]),
                    )
                    failed.append({"email": inv["email"], "reason": reason})

    return {"created": created, "rejected": rejected, "sent": sent, "failed_to_send": failed}


@router.post("/partners/invites/{invite_id}/send")
def resend_invite(invite_id: str, request: Request):
    """Send (or re-send) one invitation email."""
    user = _admin(request)
    with _db() as cur:
        cur.execute("""
            SELECT i.*, o.name, o.org_id
              FROM partner_invites i
              JOIN partner_orgs o ON o.org_id = i.org_id
             WHERE i.invite_id = %s
        """, (invite_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Invitation not found")
        if row["status"] != "pending":
            raise HTTPException(status_code=400, detail=f"Invitation is {row['status']}")

        invite = _row(row)
        sender = _sender_name(cur, user.get("user_id", ""))
        try:
            _send_invite_email(user["user_id"], {"name": row["name"]}, invite, sender)
        except HTTPException as e:
            cur.execute(
                "UPDATE partner_invites SET last_send_error = %s WHERE invite_id = %s",
                (str(e.detail), invite_id),
            )
            raise
        cur.execute(
            """UPDATE partner_invites
                  SET last_sent_at = now(), send_count = send_count + 1, last_send_error = NULL
                WHERE invite_id = %s RETURNING last_sent_at, send_count""",
            (invite_id,),
        )
        return {"ok": True, **_row(cur.fetchone())}


@router.delete("/partners/invites/{invite_id}")
def revoke_invite(invite_id: str, request: Request):
    _admin(request)
    with _db() as cur:
        cur.execute(
            "UPDATE partner_invites SET status = 'revoked' WHERE invite_id = %s", (invite_id,)
        )
    return {"ok": True}


@router.get("/partners/invites/token/{token}")
def preview_invite(token: str):
    """Public: what an invitee sees before setting a password."""
    with _db() as cur:
        cur.execute("""
            SELECT i.email, i.full_name, i.status, i.expires_at,
                   o.name AS org_name, o.institution
              FROM partner_invites i
              JOIN partner_orgs o ON o.org_id = i.org_id
             WHERE i.token = %s AND o.is_active
        """, (token,))
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Invitation not found")
    out = _row(row)
    if out["status"] != "pending":
        raise HTTPException(status_code=410, detail=f"Invitation already {out['status']}")
    return out


@router.post("/partners/invites/token/{token}/accept", status_code=201)
def accept_invite(token: str, body: AcceptIn):
    """Public: turn a pending invite into a partner account."""
    if len(body.password) < 10:
        raise HTTPException(status_code=400, detail="Password must be at least 10 characters")

    with _db() as cur:
        cur.execute("""
            SELECT i.invite_id, i.org_id, i.email, i.full_name, i.status, i.expires_at
              FROM partner_invites i
              JOIN partner_orgs o ON o.org_id = i.org_id
             WHERE i.token = %s AND o.is_active
             FOR UPDATE OF i
        """, (token,))
        inv = cur.fetchone()
        if not inv:
            raise HTTPException(status_code=404, detail="Invitation not found")
        if inv["status"] != "pending":
            raise HTTPException(status_code=410, detail=f"Invitation already {inv['status']}")

        cur.execute("SELECT now() > %s AS expired", (inv["expires_at"],))
        if cur.fetchone()["expired"]:
            cur.execute(
                "UPDATE partner_invites SET status = 'expired' WHERE invite_id = %s",
                (inv["invite_id"],),
            )
            raise HTTPException(status_code=410, detail="Invitation has expired")

        hashed = bcrypt_lib.hashpw(body.password.encode(), bcrypt_lib.gensalt()).decode()
        name = (body.full_name or inv["full_name"] or inv["email"].split("@")[0]).strip()
        cur.execute(
            """INSERT INTO users
                 (email, hashed_password, name, full_name, role, user_type, org_id, is_active)
               VALUES (%s,%s,%s,%s,'partner','partner',%s,true)
               RETURNING user_id, email, full_name""",
            (inv["email"], hashed, name, name, inv["org_id"]),
        )
        new_user = cur.fetchone()
        cur.execute(
            """UPDATE partner_invites
                  SET status = 'accepted', accepted_at = now(), accepted_by = %s
                WHERE invite_id = %s""",
            (new_user["user_id"], inv["invite_id"]),
        )
    logger.info("Partner invite accepted: %s", inv["email"])
    return {"user_id": str(new_user["user_id"]), "email": new_user["email"]}


# ── track assignment & cohort progress ────────────────────────────────────────

@router.put("/partners/orgs/{org_id}/tracks")
def set_org_tracks(org_id: str, body: TracksIn, request: Request):
    _admin(request)
    with _db() as cur:
        cur.execute("DELETE FROM partner_org_tracks WHERE org_id = %s", (org_id,))
        for i, tid in enumerate(body.track_ids):
            cur.execute(
                """INSERT INTO partner_org_tracks (org_id, track_id, sort_order)
                   VALUES (%s,%s,%s) ON CONFLICT DO NOTHING""",
                (org_id, tid, i),
            )
    return {"ok": True, "count": len(body.track_ids)}


@router.get("/partners/orgs/{org_id}/progress")
def org_progress(org_id: str, request: Request):
    """Per-member completion across every module assigned to the cohort."""
    _admin(request)
    with _db() as cur:
        cur.execute("""
            SELECT m.module_id, m.title, m.track_id, t.title AS track_title, t.kind
              FROM partner_org_tracks ot
              JOIN learn_tracks t  ON t.track_id = ot.track_id
              JOIN learn_modules m ON m.track_id = t.track_id AND m.is_published
             WHERE ot.org_id = %s
             ORDER BY ot.sort_order, m.sort_order
        """, (org_id,))
        modules = [_row(r) for r in cur.fetchall()]

        cur.execute("""
            SELECT u.user_id, u.email, u.full_name,
                   p.module_id, p.status, p.video_seconds, p.quiz_score,
                   p.completed_at, p.last_seen_at
              FROM users u
              LEFT JOIN learn_progress p ON p.user_id = u.user_id
             WHERE u.org_id = %s AND u.role = 'partner'
        """, (org_id,))
        rows = [_row(r) for r in cur.fetchall()]

    module_ids = {m["module_id"] for m in modules}
    members: dict[str, dict] = {}
    for r in rows:
        m = members.setdefault(r["user_id"], {
            "user_id": r["user_id"], "email": r["email"],
            "full_name": r["full_name"], "progress": {},
        })
        if r["module_id"] and r["module_id"] in module_ids:
            m["progress"][r["module_id"]] = {
                "status": r["status"], "video_seconds": r["video_seconds"],
                "quiz_score": float(r["quiz_score"]) if r["quiz_score"] is not None else None,
                "completed_at": r["completed_at"], "last_seen_at": r["last_seen_at"],
            }

    for m in members.values():
        done = sum(1 for p in m["progress"].values() if p["status"] == "completed")
        m["completed"] = done
        m["total"] = len(modules)
        m["pct"] = round(100 * done / len(modules)) if modules else 0

    return {"modules": modules, "members": sorted(members.values(), key=lambda x: x["email"])}


# ── Learning Center (partner-facing) ──────────────────────────────────────────

def _my_track_ids(cur, user: dict) -> list[str] | None:
    """Track ids visible to this user, or None meaning 'all published tracks'.

    Staff see everything published so they can review the material; a partner
    sees only what their organisation assigned.
    """
    if user.get("role") in ("admin", "user", "viewer"):
        return None
    cur.execute("""
        SELECT ot.track_id
          FROM users u
          JOIN partner_org_tracks ot ON ot.org_id = u.org_id
          JOIN partner_orgs o ON o.org_id = u.org_id AND o.is_active
         WHERE u.user_id = %s
         ORDER BY ot.sort_order
    """, (user["user_id"],))
    return [str(r["track_id"]) for r in cur.fetchall()]


@router.get("/learn/tracks")
def my_tracks(request: Request):
    user = _learner(request)
    with _db() as cur:
        allowed = _my_track_ids(cur, user)
        if allowed is not None and not allowed:
            return []
        where = "t.is_published"
        params: list = []
        if allowed is not None:
            where += " AND t.track_id = ANY(%s::uuid[])"
            params.append(allowed)
        cur.execute(f"""
            SELECT t.*,
                   (SELECT count(*) FROM learn_modules m
                     WHERE m.track_id = t.track_id AND m.is_published) AS module_count,
                   (SELECT count(*) FROM learn_modules m
                     JOIN learn_progress p ON p.module_id = m.module_id
                    WHERE m.track_id = t.track_id AND m.is_published
                      AND p.user_id = %s AND p.status = 'completed') AS completed_count,
                   (SELECT coalesce(sum(m.duration_min), 0) FROM learn_modules m
                     WHERE m.track_id = t.track_id AND m.is_published) AS total_minutes
              FROM learn_tracks t
             WHERE {where}
             ORDER BY (t.kind = 'onboarding') DESC, t.sort_order, t.title
        """, [user["user_id"], *params])
        tracks = [_row(r) for r in cur.fetchall()]
    for t in tracks:
        t["pct"] = round(100 * t["completed_count"] / t["module_count"]) if t["module_count"] else 0
    return tracks


@router.get("/learn/tracks/{track_id}")
def get_track(track_id: str, request: Request):
    user = _learner(request)
    with _db() as cur:
        allowed = _my_track_ids(cur, user)
        if allowed is not None and track_id not in allowed:
            raise HTTPException(status_code=403, detail="Track not assigned to you")
        cur.execute("SELECT * FROM learn_tracks WHERE track_id = %s AND is_published", (track_id,))
        track = cur.fetchone()
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        cur.execute("""
            SELECT m.module_id, m.title, m.summary, m.video_url, m.duration_min,
                   m.requires_ack, m.sort_order,
                   (m.quiz != '[]'::jsonb) AS has_quiz,
                   p.status, p.video_seconds, p.completed_at, p.last_seen_at
              FROM learn_modules m
              LEFT JOIN learn_progress p
                     ON p.module_id = m.module_id AND p.user_id = %s
             WHERE m.track_id = %s AND m.is_published
             ORDER BY m.sort_order, m.title
        """, (user["user_id"], track_id))
        modules = [_row(r) for r in cur.fetchall()]
    out = _row(track)
    out["modules"] = modules
    return out


@router.get("/learn/modules/{module_id}")
def get_module(module_id: str, request: Request):
    """One module. The quiz answer key is stripped before it leaves the API."""
    user = _learner(request)
    with _db() as cur:
        cur.execute("""
            SELECT m.*, t.title AS track_title, t.kind AS track_kind, t.track_id
              FROM learn_modules m
              JOIN learn_tracks t ON t.track_id = m.track_id
             WHERE m.module_id = %s AND m.is_published AND t.is_published
        """, (module_id,))
        mod = cur.fetchone()
        if not mod:
            raise HTTPException(status_code=404, detail="Module not found")
        allowed = _my_track_ids(cur, user)
        if allowed is not None and str(mod["track_id"]) not in allowed:
            raise HTTPException(status_code=403, detail="Module not assigned to you")
        cur.execute(
            "SELECT * FROM learn_progress WHERE user_id = %s AND module_id = %s",
            (user["user_id"], module_id),
        )
        prog = cur.fetchone()
        # Opening a module starts it, so the cohort view shows attempts as well
        # as completions.
        cur.execute("""
            INSERT INTO learn_progress (user_id, module_id)
            VALUES (%s, %s)
            ON CONFLICT (user_id, module_id) DO UPDATE SET last_seen_at = now()
        """, (user["user_id"], module_id))

    out = _row(mod)
    out["quiz"] = [
        {"question": q.get("question"), "options": q.get("options", [])}
        for q in (mod["quiz"] or [])
    ]
    out["progress"] = _row(prog) if prog else None
    return out


@router.post("/learn/modules/{module_id}/progress")
def save_progress(module_id: str, body: ProgressIn, request: Request):
    """Save watch position, grade a quiz, record an acknowledgement, complete."""
    user = _learner(request)
    with _db() as cur:
        cur.execute("""
            SELECT m.quiz, m.requires_ack, m.track_id
              FROM learn_modules m JOIN learn_tracks t ON t.track_id = m.track_id
             WHERE m.module_id = %s AND m.is_published AND t.is_published
        """, (module_id,))
        mod = cur.fetchone()
        if not mod:
            raise HTTPException(status_code=404, detail="Module not found")
        allowed = _my_track_ids(cur, user)
        if allowed is not None and str(mod["track_id"]) not in allowed:
            raise HTTPException(status_code=403, detail="Module not assigned to you")

        quiz = mod["quiz"] or []
        score = None
        if body.quiz_answers is not None and quiz:
            correct = sum(
                1 for i, q in enumerate(quiz)
                if i < len(body.quiz_answers) and body.quiz_answers[i] == q.get("answer_index")
            )
            score = round(100 * correct / len(quiz), 1)

        sets = ["last_seen_at = now()"]
        vals: list = []
        if body.video_seconds is not None:
            # Never rewind the recorded high-water mark.
            sets.append("video_seconds = GREATEST(learn_progress.video_seconds, %s)")
            vals.append(max(0, body.video_seconds))
        if score is not None:
            sets.append("quiz_score = %s")
            vals.append(score)
            sets.append("quiz_answers = %s")
            vals.append(Json(body.quiz_answers))
        if body.acknowledged:
            sets.append("acknowledged_at = COALESCE(learn_progress.acknowledged_at, now())")
        if body.completed:
            if mod["requires_ack"] and not body.acknowledged:
                cur.execute(
                    "SELECT acknowledged_at FROM learn_progress WHERE user_id=%s AND module_id=%s",
                    (user["user_id"], module_id),
                )
                prior = cur.fetchone()
                if not prior or not prior["acknowledged_at"]:
                    raise HTTPException(
                        status_code=400,
                        detail="This module must be acknowledged before it can be completed",
                    )
            sets.append("status = 'completed'")
            sets.append("completed_at = COALESCE(learn_progress.completed_at, now())")

        cur.execute(
            f"""INSERT INTO learn_progress (user_id, module_id) VALUES (%s, %s)
                ON CONFLICT (user_id, module_id) DO UPDATE SET {', '.join(sets)}
                RETURNING *""",
            [user["user_id"], module_id, *vals],
        )
        row = cur.fetchone()
    out = _row(row)
    if score is not None:
        out["quiz_review"] = [
            {"correct_index": q.get("answer_index"), "explanation": q.get("explanation")}
            for q in quiz
        ]
    return out


@router.get("/learn/onboarding")
def onboarding_status(request: Request):
    """Where the user is in the required onboarding flow.

    The frontend uses this to decide whether to push someone into onboarding
    before letting them roam.
    """
    user = _learner(request)
    with _db() as cur:
        allowed = _my_track_ids(cur, user)
        if allowed is not None and not allowed:
            return {"required": False, "complete": True, "modules": [], "next": None}
        where = "t.is_published AND t.kind = 'onboarding' AND m.is_published"
        params: list = [user["user_id"]]
        if allowed is not None:
            where += " AND t.track_id = ANY(%s::uuid[])"
            params.append(allowed)
        cur.execute(f"""
            SELECT m.module_id, m.title, m.duration_min, t.track_id, t.title AS track_title,
                   p.status
              FROM learn_tracks t
              JOIN learn_modules m ON m.track_id = t.track_id
              LEFT JOIN learn_progress p ON p.module_id = m.module_id AND p.user_id = %s
             WHERE {where}
             ORDER BY t.sort_order, m.sort_order
        """, params)
        mods = [_row(r) for r in cur.fetchall()]

    pending = [m for m in mods if m["status"] != "completed"]
    return {
        "required": bool(mods),
        "complete": not pending,
        "total": len(mods),
        "completed": len(mods) - len(pending),
        "modules": mods,
        "next": pending[0] if pending else None,
    }


# ── content authoring ─────────────────────────────────────────────────────────

@router.get("/learn/admin/tracks")
def admin_list_tracks(request: Request):
    """Every track including unpublished drafts, with module counts."""
    _admin(request)
    with _db() as cur:
        cur.execute("""
            SELECT t.*,
                   (SELECT count(*) FROM learn_modules m WHERE m.track_id = t.track_id) AS module_count,
                   (SELECT count(*) FROM partner_org_tracks ot WHERE ot.track_id = t.track_id) AS org_count
              FROM learn_tracks t
             ORDER BY (t.kind = 'onboarding') DESC, t.sort_order, t.title
        """)
        return [_row(r) for r in cur.fetchall()]


@router.get("/learn/admin/tracks/{track_id}")
def admin_get_track(track_id: str, request: Request):
    _admin(request)
    with _db() as cur:
        cur.execute("SELECT * FROM learn_tracks WHERE track_id = %s", (track_id,))
        track = cur.fetchone()
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        cur.execute(
            "SELECT * FROM learn_modules WHERE track_id = %s ORDER BY sort_order, title",
            (track_id,),
        )
        modules = [_row(r) for r in cur.fetchall()]
    out = _row(track)
    out["modules"] = modules
    return out


@router.post("/learn/tracks", status_code=201)
def create_track(body: TrackIn, request: Request):
    user = _admin(request)
    slug = _slugify(body.title)
    with _db() as cur:
        cur.execute("SELECT 1 FROM learn_tracks WHERE slug = %s", (slug,))
        if cur.fetchone():
            slug = f"{slug}-{secrets.token_hex(2)}"
        cur.execute(
            """INSERT INTO learn_tracks
                 (title, slug, summary, kind, cover_url, sort_order, is_published, created_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (body.title.strip(), slug, body.summary, body.kind, body.cover_url,
             body.sort_order, body.is_published, user.get("user_id")),
        )
        return _row(cur.fetchone())


@router.patch("/learn/tracks/{track_id}")
def update_track(track_id: str, body: TrackPatch, request: Request):
    _admin(request)
    sets, vals = [], []
    for f in ("title", "summary", "kind", "cover_url", "sort_order", "is_published"):
        v = getattr(body, f)
        if v is not None:
            sets.append(f"{f} = %s")
            vals.append(v)
    if not sets:
        raise HTTPException(status_code=400, detail="Nothing to update")
    sets.append("updated_at = now()")
    vals.append(track_id)
    with _db() as cur:
        cur.execute(f"UPDATE learn_tracks SET {', '.join(sets)} WHERE track_id = %s RETURNING *", vals)
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Track not found")
        return _row(row)


@router.delete("/learn/tracks/{track_id}")
def delete_track(track_id: str, request: Request):
    _admin(request)
    with _db() as cur:
        cur.execute("DELETE FROM learn_tracks WHERE track_id = %s", (track_id,))
    return {"ok": True}


@router.post("/learn/modules", status_code=201)
def create_module(body: ModuleIn, request: Request):
    _admin(request)
    with _db() as cur:
        cur.execute(
            """INSERT INTO learn_modules
                 (track_id, title, summary, body_md, video_url, duration_min,
                  resources, quiz, requires_ack, ack_text, sort_order, is_published)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (body.track_id, body.title.strip(), body.summary, body.body_md, body.video_url,
             body.duration_min, Json(body.resources or []), Json(body.quiz or []),
             body.requires_ack, body.ack_text, body.sort_order, body.is_published),
        )
        return _row(cur.fetchone())


@router.patch("/learn/modules/{module_id}")
def update_module(module_id: str, body: ModulePatch, request: Request):
    _admin(request)
    sets, vals = [], []
    for f in ("track_id", "title", "summary", "body_md", "video_url", "duration_min",
              "requires_ack", "ack_text", "sort_order", "is_published"):
        v = getattr(body, f)
        if v is not None:
            sets.append(f"{f} = %s")
            vals.append(v)
    for f in ("resources", "quiz"):
        v = getattr(body, f)
        if v is not None:
            sets.append(f"{f} = %s")
            vals.append(Json(v))
    if not sets:
        raise HTTPException(status_code=400, detail="Nothing to update")
    sets.append("updated_at = now()")
    vals.append(module_id)
    with _db() as cur:
        cur.execute(f"UPDATE learn_modules SET {', '.join(sets)} WHERE module_id = %s RETURNING *", vals)
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Module not found")
        return _row(row)


@router.delete("/learn/modules/{module_id}")
def delete_module(module_id: str, request: Request):
    _admin(request)
    with _db() as cur:
        cur.execute("DELETE FROM learn_modules WHERE module_id = %s", (module_id,))
    return {"ok": True}
