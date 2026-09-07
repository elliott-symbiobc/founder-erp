"""
stripe_billing.py — Stripe connection + hosted invoice delivery.

The platform stays the system of record for invoices; Stripe is used as the
delivery and collection channel. Sending an invoice pushes it to Stripe,
finalizes it, and lets Stripe email the customer a hosted invoice with a Pay
button. Payment status comes back via webhook, so an invoice marked paid in
Stripe becomes paid here without anyone re-typing it.

GET    /stripe/status                    — connection state (never returns the key)
POST   /stripe/connect                   — store a secret key, validated against Stripe
DELETE /stripe/connect                   — forget the stored key
POST   /stripe/webhook-secret            — store the signing secret for the webhook

POST   /stripe/invoices/{id}/send         — push → finalize → email via Stripe
POST   /stripe/invoices/{id}/payment-link — push → finalize, return a payable URL, no email
POST   /stripe/invoices/{id}/resend      — re-email an already-sent Stripe invoice
POST   /stripe/invoices/{id}/sync        — pull current Stripe state for one invoice
POST   /stripe/invoices/{id}/void        — void the Stripe invoice (leaves ours alone)
POST   /stripe/webhook                   — Stripe event receiver (no app auth)
"""

import base64
import hashlib
import hmac
import json
import logging
import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

import httpx
import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stripe", tags=["stripe"])

STRIPE_API = "https://api.stripe.com/v1"

DDL = """
CREATE TABLE IF NOT EXISTS stripe_settings (
    id                    INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    key_cipher            TEXT NOT NULL,
    fingerprint           TEXT NOT NULL,
    livemode              BOOLEAN NOT NULL DEFAULT false,
    account_id            TEXT,
    account_name          TEXT,
    webhook_secret_cipher TEXT,
    connected_by          UUID,
    connected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_invoice_id  TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_hosted_url  TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_status      TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at            TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_stripe_invoice
    ON invoices (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;
"""

_schema_ready = False


def _conn():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def _ensure_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(DDL)
        _schema_ready = True
    finally:
        conn.close()


def _require_user(request: Request) -> str:
    uid = request.headers.get("X-User-Id")
    if not uid:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return uid


# ── Key storage ───────────────────────────────────────────────────────────────
#
# The secret key is a live money-moving credential, so it is encrypted at rest
# under the platform secret (same scheme as user_extract_keys) and never
# returned over HTTP — only its fingerprint, which is enough to recognise which
# key is stored without being enough to use it.

def _fernet():
    from cryptography.fernet import Fernet

    secret = os.environ.get("USER_KEY_SECRET")
    if not secret:
        raise HTTPException(
            status_code=500,
            detail="USER_KEY_SECRET is not set; refusing to store the Stripe key unencrypted",
        )
    digest = hashlib.sha256(secret.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _fingerprint(key: str) -> str:
    k = key.strip()
    tail = k[-4:] if len(k) >= 4 else "????"
    return f"…{tail}"


def _load_settings() -> Optional[dict]:
    _ensure_schema()
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM stripe_settings WHERE id = 1")
        return cur.fetchone()
    finally:
        conn.close()


def _secret_key() -> str:
    row = _load_settings()
    if not row:
        raise HTTPException(
            status_code=400,
            detail="Stripe is not connected. Add your secret key in Receivables → Stripe.",
        )
    try:
        return _fernet().decrypt(row["key_cipher"].encode()).decode()
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="The stored Stripe key could not be decrypted (platform secret rotated?). Reconnect Stripe.",
        )


# ── Stripe HTTP helpers ───────────────────────────────────────────────────────

def _flatten(prefix: str, value: Any, out: dict) -> None:
    """Stripe takes form-encoded nested params: metadata[foo]=bar."""
    if isinstance(value, dict):
        for k, v in value.items():
            _flatten(f"{prefix}[{k}]" if prefix else k, v, out)
    elif isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            _flatten(f"{prefix}[{i}]", v, out)
    elif isinstance(value, bool):
        out[prefix] = "true" if value else "false"
    elif value is not None:
        out[prefix] = str(value)


def _stripe(method: str, path: str, key: str, data: Optional[dict] = None,
            params: Optional[dict] = None) -> dict:
    form: dict = {}
    if data:
        _flatten("", data, form)
    try:
        r = httpx.request(
            method,
            f"{STRIPE_API}{path}",
            headers={"Authorization": f"Bearer {key}"},
            data=form or None,
            params=params,
            timeout=30,
        )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach Stripe: {e}")

    body = r.json() if r.content else {}
    if r.status_code >= 400:
        err = (body.get("error") or {}).get("message") or r.text
        logger.error("Stripe %s %s failed: %s", method, path, err)
        raise HTTPException(status_code=502, detail=f"Stripe: {err}")
    return body


# ── Connection management ─────────────────────────────────────────────────────

class ConnectRequest(BaseModel):
    secret_key: str


@router.get("/status")
def stripe_status(request: Request):
    _require_user(request)
    row = _load_settings()
    if not row:
        return {"connected": False}
    return {
        "connected": True,
        "fingerprint": row["fingerprint"],
        "livemode": row["livemode"],
        "account_id": row["account_id"],
        "account_name": row["account_name"],
        "webhook_configured": bool(row["webhook_secret_cipher"]),
        "webhook_url": f"{os.environ.get('PUBLIC_BASE_URL', 'https://erp.example.com')}/api/stripe/webhook",
        "connected_at": row["connected_at"].isoformat() if row["connected_at"] else None,
    }


@router.post("/connect")
def connect_stripe(body: ConnectRequest, request: Request):
    uid = _require_user(request)
    key = (body.secret_key or "").strip()
    if not key.startswith(("sk_", "rk_")):
        raise HTTPException(
            status_code=400,
            detail="That does not look like a Stripe secret key (expected sk_… or rk_…).",
        )

    # Validate against Stripe before storing — a bad key stored silently
    # becomes a mystery failure at send time.
    account = _stripe("GET", "/account", key)

    _ensure_schema()
    cipher = _fernet().encrypt(key.encode()).decode()
    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO stripe_settings
                    (id, key_cipher, fingerprint, livemode, account_id, account_name, connected_by)
                VALUES (1, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    key_cipher   = EXCLUDED.key_cipher,
                    fingerprint  = EXCLUDED.fingerprint,
                    livemode     = EXCLUDED.livemode,
                    account_id   = EXCLUDED.account_id,
                    account_name = EXCLUDED.account_name,
                    connected_by = EXCLUDED.connected_by,
                    updated_at   = now()
                """,
                (
                    cipher,
                    _fingerprint(key),
                    bool(account.get("charges_enabled")) and key.startswith(("sk_live", "rk_live")),
                    account.get("id"),
                    account.get("business_profile", {}).get("name")
                    or account.get("settings", {}).get("dashboard", {}).get("display_name")
                    or account.get("email"),
                    uid,
                ),
            )
    finally:
        conn.close()

    return stripe_status(request)


@router.delete("/connect")
def disconnect_stripe(request: Request):
    _require_user(request)
    _ensure_schema()
    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute("DELETE FROM stripe_settings WHERE id = 1")
    finally:
        conn.close()
    return {"connected": False}


class WebhookSecretRequest(BaseModel):
    webhook_secret: str


@router.post("/webhook-secret")
def set_webhook_secret(body: WebhookSecretRequest, request: Request):
    _require_user(request)
    secret = (body.webhook_secret or "").strip()
    if not secret.startswith("whsec_"):
        raise HTTPException(status_code=400, detail="Expected a signing secret starting with whsec_")
    if not _load_settings():
        raise HTTPException(status_code=400, detail="Connect Stripe first")
    cipher = _fernet().encrypt(secret.encode()).decode()
    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE stripe_settings SET webhook_secret_cipher = %s, updated_at = now() WHERE id = 1",
                (cipher,),
            )
    finally:
        conn.close()
    return {"webhook_configured": True}


# ── Invoice → Stripe ──────────────────────────────────────────────────────────

def _load_invoice(invoice_id: str) -> dict:
    _ensure_schema()
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT i.*,
                   c.name         AS contact_name,
                   c.email        AS contact_email,
                   c.organization AS contact_organization
            FROM invoices i
            LEFT JOIN contacts c ON c.contact_id = i.contact_id
            WHERE i.invoice_id = %s
            """,
            (invoice_id,),
        )
        row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return row


def _cents(amount) -> str:
    """Stripe wants minor units; unit_amount_decimal keeps sub-cent precision."""
    return str((Decimal(str(amount or 0)) * 100).quantize(Decimal("0.0001")).normalize())


def _find_or_create_customer(key: str, inv: dict) -> str:
    if inv.get("stripe_customer_id"):
        return inv["stripe_customer_id"]

    email = (inv.get("contact_email") or "").strip()
    if not email:
        raise HTTPException(
            status_code=400,
            detail="This invoice's contact has no email address — Stripe needs one to deliver the invoice.",
        )

    existing = _stripe("GET", "/customers", key, params={"email": email, "limit": 1})
    if existing.get("data"):
        return existing["data"][0]["id"]

    created = _stripe("POST", "/customers", key, data={
        "email": email,
        "name": inv.get("contact_organization") or inv.get("contact_name") or email,
        "metadata": {"openerp_contact_id": str(inv.get("contact_id") or "")},
    })
    return created["id"]


def _push_line_items(key: str, customer_id: str, stripe_invoice_id: str, inv: dict) -> None:
    currency = (inv.get("currency") or "USD").lower()

    for item in (inv.get("line_items") or []):
        desc = (item.get("description") or "Item").strip() or "Item"
        qty = Decimal(str(item.get("quantity") or 1))
        unit_price = Decimal(str(item.get("unit_price") or 0))
        amount = Decimal(str(item.get("amount") or 0))

        data = {
            "customer": customer_id,
            "invoice": stripe_invoice_id,
            "currency": currency,
        }
        # Stripe quantities are integers. A fractional quantity (2.5 hours) is
        # sent as a single priced line so the customer still sees the maths.
        if qty == qty.to_integral_value() and qty > 0 and (unit_price * qty) == amount:
            data["description"] = desc
            data["quantity"] = int(qty)
            data["unit_amount_decimal"] = _cents(unit_price)
        else:
            qty_label = f"{qty.normalize():f}".rstrip(".")
            data["description"] = f"{desc} ({qty_label} × {unit_price:,.2f})" if qty != 1 else desc
            data["quantity"] = 1
            data["unit_amount_decimal"] = _cents(amount)

        _stripe("POST", "/invoiceitems", key, data=data)

    # Tax is pushed as its own line rather than a Stripe tax rate so the Stripe
    # total always matches the platform total exactly.
    tax_amount = Decimal(str(inv.get("tax_amount") or 0))
    if tax_amount != 0:
        rate = Decimal(str(inv.get("tax_rate") or 0)) * 100
        rate_label = f"{rate.normalize():f}".rstrip(".")
        _stripe("POST", "/invoiceitems", key, data={
            "customer": customer_id,
            "invoice": stripe_invoice_id,
            "currency": currency,
            "description": f"Tax ({rate_label}%)",
            "quantity": 1,
            "unit_amount_decimal": _cents(tax_amount),
        })


def _save_stripe_state(invoice_id: str, si: dict, mark_sent: bool) -> dict:
    """Mirror the Stripe invoice onto our row.

    The identifiers are written on every path, not just the emailing one: the
    UI keys the entire Stripe section off stripe_invoice_id, so a payment link
    saved without it is a link with nowhere to appear. Only sent_at and the
    draft → sent transition are specific to actually emailing.
    """
    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE invoices SET
                    stripe_invoice_id  = COALESCE(%s, stripe_invoice_id),
                    stripe_customer_id = COALESCE(%s, stripe_customer_id),
                    stripe_hosted_url  = COALESCE(%s, stripe_hosted_url),
                    stripe_status      = COALESCE(%s, stripe_status),
                    updated_at         = now()
                    {", sent_at = COALESCE(sent_at, now()),"
                      " status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END"
                     if mark_sent else ""}
                WHERE invoice_id = %s
                RETURNING invoice_id, status, stripe_invoice_id, stripe_status,
                          stripe_hosted_url, sent_at
                """,
                (si.get("id"), si.get("customer"), si.get("hosted_invoice_url"),
                 si.get("status"), invoice_id),
            )
            row = cur.fetchone()
    finally:
        conn.close()
    return dict(row) if row else {}


# ACH costs 0.8% capped at $5 against ~2.9% + 30c on card, so it is offered
# wherever the account supports it. Accounts without ACH enabled reject the
# parameter, and the invoice falls back to the account's own defaults.
PAYMENT_METHOD_TYPES = ["card", "us_bank_account"]


def _push_and_finalize(invoice_id: str, request: Request) -> tuple[str, dict, dict]:
    """Create the Stripe invoice, attach line items and finalize it.

    Finalizing does not email anyone — that is a separate Stripe call — so this
    is shared by the send path and the copy-a-payment-link path.
    """
    _require_user(request)
    key = _secret_key()
    inv = _load_invoice(invoice_id)

    if inv.get("stripe_invoice_id"):
        raise HTTPException(
            status_code=409,
            detail="This invoice is already on Stripe. Use Resend to email it, or copy the existing link.",
        )
    if inv["status"] == "cancelled":
        raise HTTPException(status_code=400, detail="Cannot send a cancelled invoice")
    if not (inv.get("line_items") or []):
        raise HTTPException(status_code=400, detail="Cannot send an invoice with no line items")

    customer_id = _find_or_create_customer(key, inv)

    data: dict = {
        "customer": customer_id,
        "collection_method": "send_invoice",
        "currency": (inv.get("currency") or "USD").lower(),
        "auto_advance": False,
        "payment_settings": {"payment_method_types": PAYMENT_METHOD_TYPES},
        "metadata": {
            "openerp_invoice_id": str(inv["invoice_id"]),
            "openerp_invoice_number": inv["invoice_number"],
        },
        "description": inv.get("notes") or None,
    }

    # If a quotation/SOW PDF is attached, put a link to it on the Stripe invoice
    # so the payer can read the document they are paying against. Stripe cannot
    # host an arbitrary attachment, so a link in the footer is the closest thing.
    from app.routers.invoices import document_public_url

    doc_url = document_public_url(inv.get("document_token"))
    if doc_url:
        data["footer"] = f"{inv.get('document_name') or 'Attached document'}: {doc_url}"

    if inv.get("due_date"):
        due = datetime.combine(inv["due_date"], datetime.min.time(), tzinfo=timezone.utc)
        # Stripe rejects a due date in the past; fall back to net-0 in that case.
        if due > datetime.now(timezone.utc):
            data["due_date"] = int(due.timestamp())
        else:
            data["days_until_due"] = 0
    else:
        data["days_until_due"] = 30

    try:
        draft = _stripe("POST", "/invoices", key, data=data)
    except HTTPException as e:
        # An account without ACH activated rejects us_bank_account outright.
        # Card-only is still a working invoice, so degrade rather than fail.
        if "us_bank_account" not in str(e.detail):
            raise
        logger.info("ACH unavailable on this account; falling back to card only")
        data.pop("payment_settings", None)
        draft = _stripe("POST", "/invoices", key, data=data)

    # Keep our invoice number visible on the Stripe invoice. Stripe rejects a
    # number already used on the account, in which case its own numbering is
    # fine — the metadata still ties the two together.
    try:
        _stripe("POST", f"/invoices/{draft['id']}", key, data={"number": inv["invoice_number"]})
    except HTTPException:
        logger.info("Stripe rejected custom number %s; using Stripe numbering", inv["invoice_number"])

    _push_line_items(key, customer_id, draft["id"], inv)

    finalized = _stripe("POST", f"/invoices/{draft['id']}/finalize", key,
                        data={"auto_advance": False})
    return key, inv, finalized


@router.post("/invoices/{invoice_id}/send")
def send_via_stripe(invoice_id: str, request: Request):
    """Push the invoice to Stripe, finalize it, and have Stripe email the customer."""
    key, inv, finalized = _push_and_finalize(invoice_id, request)

    sent = _stripe("POST", f"/invoices/{finalized['id']}/send", key)

    state = _save_stripe_state(invoice_id, sent or finalized, mark_sent=True)
    return {
        "ok": True,
        "stripe_invoice_id": sent.get("id"),
        "hosted_invoice_url": sent.get("hosted_invoice_url"),
        "stripe_pdf_url": sent.get("invoice_pdf"),
        "emailed_to": inv.get("contact_email"),
        **state,
    }


@router.post("/invoices/{invoice_id}/payment-link")
def create_payment_link(invoice_id: str, request: Request):
    """Finalize the invoice on Stripe and hand back its payable URL, without
    Stripe emailing anybody — for pasting into your own covering email."""
    _key, inv, finalized = _push_and_finalize(invoice_id, request)

    # The invoice is finalized and collectible, so it counts as issued. Leaving
    # it in draft would keep a real receivable out of Total Outstanding, which
    # is the exact under-reporting this module just fixed. sent_at stays null:
    # nothing has been emailed yet.
    state = _save_stripe_state(invoice_id, finalized, mark_sent=False)
    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE invoices SET status = 'sent', updated_at = now() "
                "WHERE invoice_id = %s AND status = 'draft'",
                (invoice_id,),
            )
    finally:
        conn.close()

    return {
        "ok": True,
        "stripe_invoice_id": finalized.get("id"),
        "hosted_invoice_url": finalized.get("hosted_invoice_url"),
        "stripe_pdf_url": finalized.get("invoice_pdf"),
        "payment_method_types": (finalized.get("payment_settings") or {}).get("payment_method_types"),
        **state,
        "status": "sent" if inv["status"] == "draft" else inv["status"],
    }


@router.post("/invoices/{invoice_id}/resend")
def resend_via_stripe(invoice_id: str, request: Request):
    _require_user(request)
    key = _secret_key()
    inv = _load_invoice(invoice_id)
    if not inv.get("stripe_invoice_id"):
        raise HTTPException(status_code=400, detail="This invoice has not been sent to Stripe yet")

    sent = _stripe("POST", f"/invoices/{inv['stripe_invoice_id']}/send", key)
    state = _save_stripe_state(invoice_id, sent, mark_sent=False)
    return {"ok": True, "emailed_to": inv.get("contact_email"), **state}


@router.post("/invoices/{invoice_id}/sync")
def sync_from_stripe(invoice_id: str, request: Request):
    _require_user(request)
    key = _secret_key()
    inv = _load_invoice(invoice_id)
    if not inv.get("stripe_invoice_id"):
        raise HTTPException(status_code=400, detail="This invoice has not been sent to Stripe yet")

    si = _stripe("GET", f"/invoices/{inv['stripe_invoice_id']}", key)
    _apply_stripe_invoice(si)
    return _serialize_state(invoice_id)


@router.post("/invoices/{invoice_id}/void")
def void_on_stripe(invoice_id: str, request: Request):
    _require_user(request)
    key = _secret_key()
    inv = _load_invoice(invoice_id)
    if not inv.get("stripe_invoice_id"):
        raise HTTPException(status_code=400, detail="This invoice has not been sent to Stripe yet")

    si = _stripe("POST", f"/invoices/{inv['stripe_invoice_id']}/void", key)
    _save_stripe_state(invoice_id, si, mark_sent=False)
    return _serialize_state(invoice_id)


def _serialize_state(invoice_id: str) -> dict:
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT invoice_id, status, paid_date, stripe_invoice_id, stripe_status,
                      stripe_hosted_url, sent_at
               FROM invoices WHERE invoice_id = %s""",
            (invoice_id,),
        )
        row = cur.fetchone()
    finally:
        conn.close()
    out = dict(row or {})
    for k, v in out.items():
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
    return out


# ── Webhook ───────────────────────────────────────────────────────────────────

def _apply_stripe_invoice(si: dict) -> None:
    """Mirror a Stripe invoice's state onto ours, keyed by stripe_invoice_id."""
    stripe_id = si.get("id")
    if not stripe_id:
        return

    stripe_status = si.get("status")
    paid = bool(si.get("paid")) or stripe_status == "paid"

    paid_date = None
    if paid:
        ts = si.get("status_transitions", {}).get("paid_at") or si.get("created")
        if ts:
            paid_date = datetime.fromtimestamp(ts, tz=timezone.utc).date()

    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            if paid:
                cur.execute(
                    """
                    UPDATE invoices SET
                        status        = 'paid',
                        paid_date     = COALESCE(paid_date, %s),
                        stripe_status = %s,
                        stripe_hosted_url = COALESCE(%s, stripe_hosted_url),
                        updated_at    = now()
                    WHERE stripe_invoice_id = %s
                    """,
                    (paid_date, stripe_status, si.get("hosted_invoice_url"), stripe_id),
                )
            elif stripe_status in ("void", "uncollectible"):
                cur.execute(
                    """
                    UPDATE invoices SET
                        status        = 'cancelled',
                        stripe_status = %s,
                        updated_at    = now()
                    WHERE stripe_invoice_id = %s AND status <> 'paid'
                    """,
                    (stripe_status, stripe_id),
                )
            else:
                cur.execute(
                    """
                    UPDATE invoices SET
                        stripe_status = %s,
                        stripe_hosted_url = COALESCE(%s, stripe_hosted_url),
                        updated_at    = now()
                    WHERE stripe_invoice_id = %s
                    """,
                    (stripe_status, si.get("hosted_invoice_url"), stripe_id),
                )
    finally:
        conn.close()


def _verify_signature(payload: bytes, sig_header: str, secret: str) -> bool:
    """Stripe's t=…,v1=… scheme, checked in constant time."""
    pairs = [p.split("=", 1) for p in sig_header.split(",") if "=" in p]
    timestamp = next((v for k, v in pairs if k == "t"), None)
    provided = [v for k, v in pairs if k == "v1"]
    if not timestamp or not provided:
        return False
    signed = f"{timestamp}.".encode() + payload
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, p) for p in provided)


HANDLED_EVENTS = {
    "invoice.paid",
    "invoice.payment_succeeded",
    "invoice.payment_failed",
    "invoice.voided",
    "invoice.marked_uncollectible",
    "invoice.sent",
    "invoice.finalized",
}


@router.post("/webhook")
async def stripe_webhook(request: Request):
    """Stripe event receiver. Not app-authenticated — authenticity comes from
    the signature, or failing that from re-reading the event out of Stripe."""
    _ensure_schema()
    payload = await request.body()
    settings = _load_settings()
    if not settings:
        raise HTTPException(status_code=400, detail="Stripe is not connected")

    try:
        event = json.loads(payload)
    except Exception:
        raise HTTPException(status_code=400, detail="Malformed payload")

    verified = False
    if settings.get("webhook_secret_cipher"):
        try:
            secret = _fernet().decrypt(settings["webhook_secret_cipher"].encode()).decode()
        except Exception:
            secret = None
        sig = request.headers.get("Stripe-Signature", "")
        if secret and sig and _verify_signature(payload, sig, secret):
            verified = True
        else:
            raise HTTPException(status_code=400, detail="Invalid signature")
    else:
        # No signing secret configured yet: re-read the event from Stripe so a
        # forged POST cannot move an invoice to paid.
        event_id = event.get("id", "")
        if not event_id.startswith("evt_"):
            raise HTTPException(status_code=400, detail="Unverifiable event")
        event = _stripe("GET", f"/events/{event_id}", _secret_key())
        verified = True

    if not verified:
        raise HTTPException(status_code=400, detail="Unverified event")

    etype = event.get("type")
    if etype in HANDLED_EVENTS:
        obj = event.get("data", {}).get("object", {})
        _apply_stripe_invoice(obj)
        logger.info("Stripe webhook %s applied to invoice %s", etype, obj.get("id"))

    return {"received": True}
