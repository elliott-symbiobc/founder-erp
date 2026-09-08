"""
invoices.py — Invoice management endpoints.

GET    /invoices                — list all invoices (with contact/project info)
GET    /invoices/stats          — summary counts by status
GET    /invoices/{id}           — single invoice
GET    /invoices/{id}/pdf       — download invoice as PDF
POST   /invoices                — create invoice (auto-generates invoice_number)
PATCH  /invoices/{id}           — update invoice fields
DELETE /invoices/{id}           — delete invoice

GET    /invoices/catalog        — list catalog items
POST   /invoices/catalog        — create catalog item
PATCH  /invoices/catalog/{id}   — update catalog item
DELETE /invoices/catalog/{id}   — delete catalog item
"""

import io
import json
import logging
import os
import secrets
from pathlib import Path
from typing import Any, List, Optional

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/invoices", tags=["invoices"])

STATUSES = ["draft", "sent", "paid", "overdue", "cancelled"]

DOCUMENT_DIR = Path("/app/uploads/invoices")
DOCUMENT_MAX_SIZE = 20 * 1024 * 1024  # 20 MB

DOCUMENT_DDL = """
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS document_name  TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS document_path  TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS document_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_document_token
    ON invoices (document_token) WHERE document_token IS NOT NULL;
"""

_document_schema_ready = False


def _ensure_document_schema() -> None:
    global _document_schema_ready
    if _document_schema_ready:
        return
    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(DOCUMENT_DDL)
        _document_schema_ready = True
    finally:
        conn.close()


def _conn():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def _require_user(request: Request) -> str:
    uid = request.headers.get("X-User-Id")
    if not uid:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return uid


def _serialize(row: dict) -> dict:
    d = dict(row)
    for k, v in d.items():
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    # line_items comes back as a dict/list already via RealDictCursor + psycopg2 json
    if isinstance(d.get("line_items"), str):
        d["line_items"] = json.loads(d["line_items"])
    if d.get("document_token"):
        d["document_url"] = document_public_url(d["document_token"])
    return d


# ── Stats ──────────────────────────────────────────────────────────────────────

@router.get("/stats")
def get_stats(request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT
                status,
                COUNT(*) AS count,
                COALESCE(SUM(total), 0) AS total_value
            FROM invoices
            GROUP BY status
        """)
        rows = cur.fetchall()
        # Outstanding is money still owed to us: issued but not yet settled.
        # Paid and cancelled invoices are settled; drafts have not been issued.
        cur.execute("""
            SELECT
                COALESCE(SUM(total) FILTER (WHERE status IN ('sent','overdue')), 0) AS outstanding,
                COALESCE(SUM(total) FILTER (WHERE status = 'overdue'), 0)           AS overdue_value,
                COALESCE(SUM(total) FILTER (WHERE status <> 'cancelled'), 0)        AS grand_total
            FROM invoices
        """)
        gt = cur.fetchone()
    finally:
        conn.close()

    by_status = {s: {"count": 0, "total_value": 0} for s in STATUSES}
    for r in rows:
        s = r["status"]
        by_status[s] = {"count": r["count"], "total_value": float(r["total_value"])}

    return {
        "by_status": by_status,
        "outstanding": float(gt["outstanding"]),
        "overdue_value": float(gt["overdue_value"]),
        # Retained for callers that want everything ever billed, minus cancellations.
        "grand_total": float(gt["grand_total"]),
    }


# ── List ───────────────────────────────────────────────────────────────────────

@router.get("/")
def list_invoices(
    request: Request,
    status: Optional[str] = None,
    contact_id: Optional[str] = None,
    project_id: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        filters = []
        params: List[Any] = []

        if status:
            filters.append("i.status = %s")
            params.append(status)
        if contact_id:
            filters.append("i.contact_id = %s")
            params.append(contact_id)
        if project_id:
            filters.append("i.project_id = %s")
            params.append(project_id)

        where = ("WHERE " + " AND ".join(filters)) if filters else ""

        cur.execute(
            f"""
            SELECT
                i.*,
                c.name  AS contact_name,
                c.organization AS contact_organization,
                p.name  AS project_name
            FROM invoices i
            LEFT JOIN contacts c ON c.contact_id = i.contact_id
            LEFT JOIN projects p ON p.project_id = i.project_id
            {where}
            ORDER BY i.issue_date DESC, i.created_at DESC
            LIMIT %s OFFSET %s
            """,
            params + [limit, offset],
        )
        rows = cur.fetchall()

        cur.execute(
            f"""
            SELECT COUNT(*) AS total FROM invoices i {where}
            """,
            params,
        )
        total = cur.fetchone()["total"]
    finally:
        conn.close()

    return {
        "invoices": [_serialize(r) for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


# ── Catalog list ───────────────────────────────────────────────────────────────
#
# Declared above /{invoice_id}: FastAPI matches in declaration order, so with
# this below the parameterized route "catalog" is read as an invoice id and the
# request dies on a uuid cast. The rest of the catalog routes live at the bottom
# of the file — their paths cannot collide.

@router.get("/catalog")
def list_catalog(request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM invoice_catalog ORDER BY category NULLS LAST, name")
        rows = cur.fetchall()
    finally:
        conn.close()
    return {"items": [_serialize(r) for r in rows]}


# ── Attached document ──────────────────────────────────────────────────────────
#
# Some invoices are really a quotation or SOW that already exists as a PDF, and
# retyping it as line items is wasted work. An uploaded document rides along
# with the invoice: it is downloadable here, and the Stripe invoice footer
# carries a public link to it so the payer can read what they are paying for.
#
# The public link is unguessable-token based rather than authenticated, because
# the recipient is a customer with no platform login. The token is the only
# secret, so it is generated fresh per upload and dropped when the document is
# replaced or deleted.

def _public_base() -> str:
    return os.environ.get("PUBLIC_BASE_URL", "https://erp.example.com").rstrip("/")


def document_public_url(token: Optional[str]) -> Optional[str]:
    return f"{_public_base()}/api/invoices/document/{token}" if token else None


@router.get("/document/{token}")
def get_public_document(token: str):
    """Serve an attached document by token. Deliberately unauthenticated."""
    from fastapi.responses import FileResponse

    _ensure_document_schema()
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT document_name, document_path FROM invoices WHERE document_token = %s",
            [token],
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row or not row["document_path"] or not Path(row["document_path"]).exists():
        raise HTTPException(status_code=404, detail="Document not found")

    return FileResponse(
        row["document_path"],
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{row["document_name"] or "document.pdf"}"',
            "Cache-Control": "private, max-age=300",
        },
    )


@router.post("/{invoice_id}/document")
async def upload_document(invoice_id: str, request: Request, file: UploadFile = File(...)):
    _require_user(request)
    _ensure_document_schema()

    if (file.content_type or "") != "application/pdf":
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    data = await file.read()
    if len(data) > DOCUMENT_MAX_SIZE:
        raise HTTPException(status_code=400, detail="File too large (max 20 MB)")
    if not data[:5].startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="That file is not a PDF")

    DOCUMENT_DIR.mkdir(parents=True, exist_ok=True)
    path = DOCUMENT_DIR / f"{invoice_id}.pdf"
    path.write_bytes(data)

    token = secrets.token_urlsafe(24)
    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """UPDATE invoices
                   SET document_name = %s, document_path = %s, document_token = %s,
                       updated_at = now()
                   WHERE invoice_id = %s
                   RETURNING invoice_id, document_name, document_token""",
                [file.filename or "document.pdf", str(path), token, invoice_id],
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        path.unlink(missing_ok=True)
        raise HTTPException(status_code=404, detail="Invoice not found")

    return {
        "ok": True,
        "document_name": row["document_name"],
        "document_url": document_public_url(row["document_token"]),
        "size": len(data),
    }


@router.delete("/{invoice_id}/document")
def delete_document(invoice_id: str, request: Request):
    _require_user(request)
    _ensure_document_schema()
    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "SELECT document_path FROM invoices WHERE invoice_id = %s", [invoice_id]
            )
            row = cur.fetchone()
            if row and row["document_path"]:
                Path(row["document_path"]).unlink(missing_ok=True)
            cur.execute(
                """UPDATE invoices
                   SET document_name = NULL, document_path = NULL, document_token = NULL,
                       updated_at = now()
                   WHERE invoice_id = %s""",
                [invoice_id],
            )
    finally:
        conn.close()
    return {"ok": True}


# ── Single ─────────────────────────────────────────────────────────────────────

@router.get("/{invoice_id}")
def get_invoice(invoice_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT
                i.*,
                c.name  AS contact_name,
                c.organization AS contact_organization,
                c.email AS contact_email,
                c.phone AS contact_phone,
                p.name  AS project_name
            FROM invoices i
            LEFT JOIN contacts c ON c.contact_id = i.contact_id
            LEFT JOIN projects p ON p.project_id = i.project_id
            WHERE i.invoice_id = %s
            """,
            [invoice_id],
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return _serialize(row)


# ── PDF ────────────────────────────────────────────────────────────────────────

@router.get("/{invoice_id}/pdf")
def download_invoice_pdf(
    invoice_id: str,
    request: Request,
    company_name: str = "Founder ERP",
    company_tagline: str = "",
    company_address: str = "",
    company_email: str = "",
    company_website: str = "erp.example.com",
):
    from fpdf import FPDF
    from fastapi.responses import Response
    from pathlib import Path as FilePath

    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT i.*,
                   c.name  AS contact_name,
                   c.organization AS contact_organization,
                   c.email AS contact_email,
                   c.phone AS contact_phone,
                   p.name  AS project_name
            FROM invoices i
            LEFT JOIN contacts c ON c.contact_id = i.contact_id
            LEFT JOIN projects p ON p.project_id = i.project_id
            WHERE i.invoice_id = %s
            """,
            [invoice_id],
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Invoice not found")

    inv = _serialize(row)

    # ── Build PDF ──────────────────────────────────────────────────────────────

    # Map common Unicode punctuation to latin-1 equivalents so the built-in
    # Helvetica font (latin-1 only) doesn't choke on em-dashes, smart quotes, etc.
    _UNICODE_MAP = {
        "—": "-", "–": "-", "‒": "-", "−": "-",
        "‘": "'", "’": "'", "“": '"', "”": '"',
        "•": "-", "·": "-", "…": "...", " ": " ",
    }

    def _s(text):
        if text is None:
            return ""
        text = str(text)
        for uni, repl in _UNICODE_MAP.items():
            text = text.replace(uni, repl)
        return text.encode("latin-1", "replace").decode("latin-1")

    class InvoicePDF(FPDF):
        def header(self):
            pass  # custom header drawn below

        def cell(self, *args, **kwargs):
            if len(args) >= 3:
                args = (*args[:2], _s(args[2]), *args[3:])
            elif "text" in kwargs:
                kwargs["text"] = _s(kwargs["text"])
            elif "txt" in kwargs:
                kwargs["txt"] = _s(kwargs["txt"])
            return super().cell(*args, **kwargs)

        def multi_cell(self, *args, **kwargs):
            if len(args) >= 3:
                args = (*args[:2], _s(args[2]), *args[3:])
            elif "text" in kwargs:
                kwargs["text"] = _s(kwargs["text"])
            elif "txt" in kwargs:
                kwargs["txt"] = _s(kwargs["txt"])
            return super().multi_cell(*args, **kwargs)

    pdf = InvoicePDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.add_page()

    W = pdf.w - 2 * pdf.l_margin  # usable width

    # ── Header band ────────────────────────────────────────────────────────────
    inv_number = inv.get("invoice_number", "")
    logo_path = FilePath("/app/uploads/logo.png")
    has_logo = logo_path.exists()
    header_h = 32

    pdf.set_fill_color(15, 23, 42)   # slate-900
    pdf.rect(pdf.l_margin, 12, W, header_h, "F")

    # Left side: logo image or company name text
    if has_logo:
        try:
            pdf.image(str(logo_path), x=pdf.l_margin + 5, y=15, h=16, w=0)
        except Exception:
            has_logo = False

    if not has_logo:
        pdf.set_xy(pdf.l_margin + 5, 16)
        pdf.set_font("Helvetica", "B", 16)
        pdf.set_text_color(255, 255, 255)
        pdf.cell(W / 2, 9, company_name, ln=0)

    # Right side: INVOICE label
    pdf.set_xy(pdf.l_margin + W / 2, 15)
    pdf.set_font("Helvetica", "B", 22)
    pdf.set_text_color(148, 163, 184)  # slate-400
    pdf.cell(W / 2, 10, "INVOICE", align="R", ln=0)

    # Sub-line: company tagline/website on left, invoice number on right
    company_sub = company_tagline if company_tagline else (company_website or company_name)
    if company_tagline and company_website:
        company_sub = f"{company_tagline} · {company_website}"
    pdf.set_xy(pdf.l_margin + 5, 28)
    pdf.set_font("Helvetica", "", 7)
    pdf.set_text_color(148, 163, 184)
    pdf.cell(W / 2, 5, company_sub, ln=0)

    pdf.set_xy(pdf.l_margin + W / 2, 28)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(203, 213, 225)
    pdf.cell(W / 2, 5, inv_number, align="R", ln=0)

    pdf.ln(header_h - 4)  # past header band

    # ── Meta block: Bill To (left) + Invoice Details (right) ──────────────────
    pdf.set_text_color(30, 30, 30)
    y_meta = pdf.get_y() + 6

    # LEFT — Bill To
    pdf.set_xy(pdf.l_margin, y_meta)
    pdf.set_font("Helvetica", "B", 7)
    pdf.set_text_color(100, 116, 139)
    pdf.cell(W / 2, 5, "BILL TO")
    pdf.ln(5)
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(15, 23, 42)
    contact_name = inv.get("contact_name") or ""
    contact_org  = inv.get("contact_organization") or ""
    if contact_name:
        pdf.set_x(pdf.l_margin)
        pdf.cell(W / 2, 6, contact_name)
        pdf.ln(6)
    if contact_org and contact_org != contact_name:
        pdf.set_x(pdf.l_margin)
        pdf.set_font("Helvetica", "", 10)
        pdf.set_text_color(71, 85, 105)
        pdf.cell(W / 2, 5, contact_org)
        pdf.ln(5)
    for field in ["contact_email", "contact_phone"]:
        val = inv.get(field)
        if val:
            pdf.set_x(pdf.l_margin)
            pdf.set_font("Helvetica", "", 9)
            pdf.set_text_color(100, 116, 139)
            pdf.cell(W / 2, 4, val)
            pdf.ln(4)

    # RIGHT — Invoice details
    def detail_row(label: str, value: str, y: float):
        pdf.set_xy(pdf.l_margin + W / 2, y)
        pdf.set_font("Helvetica", "", 8)
        pdf.set_text_color(100, 116, 139)
        pdf.cell(W / 4, 5, label, align="R")
        pdf.set_xy(pdf.l_margin + 3 * W / 4, y)
        pdf.set_font("Helvetica", "B", 8)
        pdf.set_text_color(15, 23, 42)
        pdf.cell(W / 4, 5, value, align="R")

    def fmt_date(d):
        if not d:
            return "—"
        try:
            from datetime import datetime
            return datetime.fromisoformat(d[:10]).strftime("%-d %b %Y")
        except Exception:
            return d[:10]

    status_label = inv.get("status", "").capitalize()
    detail_row("Invoice #",   inv_number,                  y_meta)
    detail_row("Issue Date",  fmt_date(inv.get("issue_date")),   y_meta + 6)
    detail_row("Due Date",    fmt_date(inv.get("due_date")),     y_meta + 12)
    detail_row("Status",      status_label,                      y_meta + 18)
    project_name = inv.get("project_name")
    if project_name:
        detail_row("Project", project_name[:28], y_meta + 24)

    pdf.set_y(y_meta + 32)

    # ── Divider ────────────────────────────────────────────────────────────────
    pdf.set_draw_color(226, 232, 240)
    pdf.set_line_width(0.3)
    pdf.line(pdf.l_margin, pdf.get_y(), pdf.l_margin + W, pdf.get_y())
    pdf.ln(6)

    # ── Line items table ───────────────────────────────────────────────────────
    col_w = [W * 0.50, W * 0.12, W * 0.19, W * 0.19]
    headers = ["Description", "Qty", "Unit Price", "Amount"]
    aligns  = ["L", "R", "R", "R"]

    # Table header row
    pdf.set_fill_color(241, 245, 249)
    pdf.set_draw_color(226, 232, 240)
    pdf.set_line_width(0.2)
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_text_color(71, 85, 105)
    for i, h in enumerate(headers):
        pdf.cell(col_w[i], 7, h, border="B", align=aligns[i], fill=True)
    pdf.ln(7)

    line_items = inv.get("line_items") or []
    currency   = inv.get("currency", "USD")

    def fmt_money(amount, cur=currency):
        try:
            val = float(amount)
            symbol = "$" if cur == "USD" else cur + " "
            return f"{symbol}{val:,.2f}"
        except Exception:
            return str(amount)

    pdf.set_font("Helvetica", "", 9)
    for idx, item in enumerate(line_items):
        fill_color = (248, 250, 252) if idx % 2 == 0 else (255, 255, 255)
        pdf.set_fill_color(*fill_color)
        desc = (item.get("description") or "")[:70]
        qty  = item.get("quantity", 1)
        up   = item.get("unit_price", 0)
        amt  = item.get("amount", 0)

        qty_str = str(int(qty)) if float(qty) == int(float(qty)) else f"{float(qty):g}"

        row_h = 6
        pdf.set_text_color(30, 41, 59)
        pdf.cell(col_w[0], row_h, desc,           border=0, align="L", fill=True)
        pdf.set_text_color(71, 85, 105)
        pdf.cell(col_w[1], row_h, qty_str,         border=0, align="R", fill=True)
        pdf.cell(col_w[2], row_h, fmt_money(up),   border=0, align="R", fill=True)
        pdf.set_text_color(15, 23, 42)
        pdf.cell(col_w[3], row_h, fmt_money(amt),  border=0, align="R", fill=True)
        pdf.ln(row_h)

    # ── Totals block ───────────────────────────────────────────────────────────
    pdf.ln(4)
    pdf.set_draw_color(226, 232, 240)
    pdf.line(pdf.l_margin, pdf.get_y(), pdf.l_margin + W, pdf.get_y())
    pdf.ln(4)

    totals_x = pdf.l_margin + W * 0.55
    totals_w_label = W * 0.25
    totals_w_value = W * 0.20

    def total_row(label, value, bold=False, large=False):
        pdf.set_x(totals_x)
        pdf.set_font("Helvetica", "B" if bold else "", 9 if not large else 11)
        pdf.set_text_color(100, 116, 139)
        pdf.cell(totals_w_label, 6, label, align="R")
        pdf.set_font("Helvetica", "B" if bold else "", 9 if not large else 11)
        pdf.set_text_color(15, 23, 42)
        pdf.cell(totals_w_value, 6, value, align="R")
        pdf.ln(6)

    subtotal   = float(inv.get("subtotal") or 0)
    tax_rate   = float(inv.get("tax_rate") or 0)
    tax_amount = float(inv.get("tax_amount") or 0)
    total      = float(inv.get("total") or 0)

    total_row("Subtotal", fmt_money(subtotal))
    if tax_rate > 0:
        tax_pct = f"{tax_rate*100:.4f}".rstrip("0").rstrip(".")
        total_row(f"Tax ({tax_pct}%)", fmt_money(tax_amount))

    pdf.ln(2)
    pdf.set_x(totals_x)
    pdf.set_draw_color(15, 23, 42)
    pdf.set_line_width(0.4)
    pdf.line(totals_x, pdf.get_y(), totals_x + totals_w_label + totals_w_value, pdf.get_y())
    pdf.ln(3)
    total_row("Total", fmt_money(total), bold=True, large=True)

    # ── Notes ──────────────────────────────────────────────────────────────────
    notes = inv.get("notes")
    if notes:
        pdf.ln(8)
        pdf.set_draw_color(226, 232, 240)
        pdf.set_line_width(0.3)
        pdf.line(pdf.l_margin, pdf.get_y(), pdf.l_margin + W, pdf.get_y())
        pdf.ln(5)
        pdf.set_font("Helvetica", "B", 7)
        pdf.set_text_color(100, 116, 139)
        pdf.set_x(pdf.l_margin)
        pdf.cell(W, 5, "NOTES")
        pdf.ln(5)
        pdf.set_font("Helvetica", "", 9)
        pdf.set_text_color(71, 85, 105)
        pdf.set_x(pdf.l_margin)
        pdf.multi_cell(W, 5, notes)

    # ── Footer ─────────────────────────────────────────────────────────────────
    pdf.set_y(-18)
    pdf.set_font("Helvetica", "", 7)
    pdf.set_text_color(148, 163, 184)
    footer_text = f"{company_name}"
    if company_website:
        footer_text += f" · {company_website}"
    pdf.cell(W, 5, footer_text, align="C")

    # ── Output ─────────────────────────────────────────────────────────────────
    pdf_bytes = pdf.output()
    filename  = f"{inv_number}.pdf"

    return Response(
        content=bytes(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Create ─────────────────────────────────────────────────────────────────────

class LineItem(BaseModel):
    description: str
    quantity: float = 1
    unit_price: float
    amount: float


class InvoiceCreate(BaseModel):
    contact_id: Optional[str] = None
    project_id: Optional[str] = None
    status: str = "draft"
    issue_date: Optional[str] = None          # ISO date string
    due_date: Optional[str] = None
    currency: str = "USD"
    line_items: List[LineItem] = []
    tax_rate: float = 0.0
    notes: Optional[str] = None


def _calc_totals(line_items: List[LineItem], tax_rate: float):
    subtotal = sum(item.amount for item in line_items)
    tax_amount = round(subtotal * tax_rate, 2)
    total = round(subtotal + tax_amount, 2)
    return subtotal, tax_amount, total


@router.post("/")
def create_invoice(body: InvoiceCreate, request: Request):
    uid = _require_user(request)
    if body.status not in STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {body.status}")

    subtotal, tax_amount, total = _calc_totals(body.line_items, body.tax_rate)

    conn = _conn()
    try:
        cur = conn.cursor()
        # Generate invoice number: INV-YYYY-NNNN
        cur.execute("SELECT nextval('invoice_number_seq') AS seq")
        seq = cur.fetchone()["seq"]
        from datetime import date
        year = date.today().year
        invoice_number = f"INV-{year}-{seq:04d}"

        cur.execute(
            """
            INSERT INTO invoices
                (invoice_number, contact_id, project_id, status,
                 issue_date, due_date, currency,
                 line_items, subtotal, tax_rate, tax_amount, total,
                 notes, created_by)
            VALUES (%s,%s,%s,%s,
                    %s,%s,%s,
                    %s,%s,%s,%s,%s,
                    %s,%s)
            RETURNING *
            """,
            [
                invoice_number,
                body.contact_id or None,
                body.project_id or None,
                body.status,
                body.issue_date or None,
                body.due_date or None,
                body.currency,
                json.dumps([item.dict() for item in body.line_items]),
                subtotal,
                body.tax_rate,
                tax_amount,
                total,
                body.notes,
                uid,
            ],
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()

    return _serialize(row)


# ── Update ─────────────────────────────────────────────────────────────────────

class InvoiceUpdate(BaseModel):
    contact_id: Optional[str] = None
    project_id: Optional[str] = None
    status: Optional[str] = None
    issue_date: Optional[str] = None
    due_date: Optional[str] = None
    paid_date: Optional[str] = None
    currency: Optional[str] = None
    line_items: Optional[List[LineItem]] = None
    tax_rate: Optional[float] = None
    notes: Optional[str] = None


@router.patch("/{invoice_id}")
def update_invoice(invoice_id: str, body: InvoiceUpdate, request: Request):
    _require_user(request)

    if body.status and body.status not in STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {body.status}")

    conn = _conn()
    try:
        cur = conn.cursor()

        # Fetch current to recalculate totals if line_items or tax_rate change
        cur.execute("SELECT line_items, tax_rate FROM invoices WHERE invoice_id = %s", [invoice_id])
        current = cur.fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="Invoice not found")

        fields, values = [], []

        for f in ["contact_id", "project_id", "status", "issue_date", "due_date",
                  "paid_date", "currency", "notes"]:
            v = getattr(body, f)
            if v is not None:
                fields.append(f"{f} = %s")
                values.append(v)

        # Recalculate totals when line_items or tax_rate changes
        new_items = body.line_items if body.line_items is not None else None
        new_tax = body.tax_rate if body.tax_rate is not None else float(current["tax_rate"])

        if body.line_items is not None:
            fields.append("line_items = %s")
            values.append(json.dumps([item.dict() for item in body.line_items]))
            subtotal, tax_amount, total = _calc_totals(body.line_items, new_tax)
            fields += ["subtotal = %s", "tax_rate = %s", "tax_amount = %s", "total = %s"]
            values += [subtotal, new_tax, tax_amount, total]
        elif body.tax_rate is not None:
            # Re-calc with existing line items and new tax rate
            existing_items = current["line_items"] if current["line_items"] else []
            fake_items = [LineItem(**i) for i in existing_items]
            subtotal, tax_amount, total = _calc_totals(fake_items, new_tax)
            fields += ["tax_rate = %s", "tax_amount = %s", "total = %s"]
            values += [new_tax, tax_amount, total]

        if not fields:
            raise HTTPException(status_code=400, detail="No fields to update")

        fields.append("updated_at = now()")
        values.append(invoice_id)

        cur.execute(
            f"UPDATE invoices SET {', '.join(fields)} WHERE invoice_id = %s RETURNING *",
            values,
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return _serialize(row)


# ── Duplicate ──────────────────────────────────────────────────────────────────

@router.post("/{invoice_id}/duplicate")
def duplicate_invoice(invoice_id: str, request: Request):
    uid = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM invoices WHERE invoice_id = %s", [invoice_id])
        src = cur.fetchone()
        if not src:
            raise HTTPException(status_code=404, detail="Invoice not found")

        cur.execute("SELECT nextval('invoice_number_seq') AS seq")
        seq = cur.fetchone()["seq"]
        from datetime import date
        year = date.today().year
        invoice_number = f"INV-{year}-{seq:04d}"

        cur.execute(
            """
            INSERT INTO invoices
                (invoice_number, contact_id, project_id, status,
                 issue_date, due_date, currency,
                 line_items, subtotal, tax_rate, tax_amount, total,
                 notes, created_by)
            VALUES (%s,%s,%s,'draft',
                    %s,%s,%s,
                    %s,%s,%s,%s,%s,
                    %s,%s)
            RETURNING *
            """,
            [
                invoice_number,
                src["contact_id"],
                src["project_id"],
                date.today().isoformat(),
                src["due_date"].isoformat() if src["due_date"] else None,
                src["currency"],
                json.dumps(src["line_items"]) if isinstance(src["line_items"], list) else src["line_items"],
                src["subtotal"],
                src["tax_rate"],
                src["tax_amount"],
                src["total"],
                src["notes"],
                uid,
            ],
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    return _serialize(row)


# ── Delete ─────────────────────────────────────────────────────────────────────

@router.delete("/{invoice_id}")
def delete_invoice(invoice_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM invoices WHERE invoice_id = %s", [invoice_id])
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


# ── Catalog ────────────────────────────────────────────────────────────────────

class CatalogItemCreate(BaseModel):
    name: str
    description: Optional[str] = None
    unit_price: float
    unit: str = "each"
    category: Optional[str] = None


@router.post("/catalog")
def create_catalog_item(body: CatalogItemCreate, request: Request):
    uid = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO invoice_catalog (name, description, unit_price, unit, category, created_by)
            VALUES (%s, %s, %s, %s, %s, %s) RETURNING *
            """,
            [body.name, body.description, body.unit_price, body.unit, body.category, uid],
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    return _serialize(row)


class CatalogItemUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    unit_price: Optional[float] = None
    unit: Optional[str] = None
    category: Optional[str] = None


@router.patch("/catalog/{item_id}")
def update_catalog_item(item_id: str, body: CatalogItemUpdate, request: Request):
    _require_user(request)
    fields, values = [], []
    for f in ["name", "description", "unit_price", "unit", "category"]:
        v = getattr(body, f)
        if v is not None:
            fields.append(f"{f} = %s")
            values.append(v)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    fields.append("updated_at = now()")
    values.append(item_id)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            f"UPDATE invoice_catalog SET {', '.join(fields)} WHERE item_id = %s RETURNING *",
            values,
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404)
    return _serialize(row)


@router.delete("/catalog/{item_id}")
def delete_catalog_item(item_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM invoice_catalog WHERE item_id = %s", [item_id])
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}
