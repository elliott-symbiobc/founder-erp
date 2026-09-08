"""
marketing.py — Marketing module: Key Language library with Google Doc bidirectional sync.

GET    /marketing/key-language              — list all entries
POST   /marketing/key-language              — create entry
PATCH  /marketing/key-language/{id}         — update entry
DELETE /marketing/key-language/{id}         — delete entry
GET    /marketing/key-language/doc          — get linked Google Doc info
POST   /marketing/key-language/doc/link     — link a Google Doc (by URL or ID)
DELETE /marketing/key-language/doc/unlink   — unlink Google Doc
POST   /marketing/key-language/doc/push     — push library entries → Google Doc
POST   /marketing/key-language/doc/pull     — pull Google Doc → library entries
GET    /marketing/key-language/doc/check    — compare by content, say which side changed

Sync direction is decided by comparing content against a snapshot of the last
sync, not by timestamps: push refuses to overwrite unsynced doc edits and pull
refuses to discard unsynced library edits, each with ?force=true to override.

Assets — the source of truth for outreach material. Files live in an attached
Drive folder; this module records which file fills which role.

GET    /marketing/assets                    — folder contents, roles, usage
GET    /marketing/assets/folder             — the attached Drive folder
PATCH  /marketing/assets/folder             — attach or clear it
PUT    /marketing/assets/{file_id}/description
GET    /marketing/assets/{file_id}/download — stream a file out of Drive
GET    /marketing/roles                     — roles and what fills them
POST   /marketing/roles                     — add a role
PUT    /marketing/roles/{role}              — point a role at a file, or clear it
DELETE /marketing/roles/{role}              — remove a role nothing consumes

Other modules call resolve_role_file(role) rather than referencing a file id,
so replacing a deck updates every consumer at once.
"""

import base64
import hashlib
import logging
import urllib.parse
import unicodedata
import os
import re
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/marketing", tags=["marketing"])

GOOGLE_TOKEN_URL  = "https://oauth2.googleapis.com/token"
DRIVE_FILES_URL   = "https://www.googleapis.com/drive/v3/files"
DRIVE_EXPORT_URL  = "https://www.googleapis.com/drive/v3/files/{id}/export"
DOCS_API_BASE     = "https://docs.googleapis.com/v1/documents"


# ── DB helpers ────────────────────────────────────────────────────────────────

def _conn():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def _require_user(request: Request) -> str:
    uid = request.headers.get("X-User-Id")
    if not uid:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return uid


def _serialize(obj):
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    return obj


def _parse_uuid_array(val) -> list:
    """Convert PostgreSQL UUID[] string like '{uuid1,uuid2}' to a Python list of strings."""
    if val is None:
        return []
    if isinstance(val, (list, tuple)):
        return [str(x) for x in val]
    if isinstance(val, str):
        val = val.strip()
        if val in ("", "{}"):
            return []
        inner = val.lstrip("{").rstrip("}")
        return [x.strip().strip('"') for x in inner.split(",") if x.strip()]
    return []


def _row_dict(row) -> dict:
    return {k: _serialize(v) for k, v in dict(row).items()}


def _campaign_row(row) -> dict:
    """Like _row_dict but ensures list_ids is always a proper list."""
    d = _row_dict(row)
    d["list_ids"] = _parse_uuid_array(d.get("list_ids"))
    return d


def _campaign_post_row(row) -> dict:
    d = _row_dict(row)
    if "list_ids" not in d or d["list_ids"] is None:
        d["list_ids"] = []
    elif isinstance(d["list_ids"], str):
        d["list_ids"] = [x for x in d["list_ids"].strip("{}").split(",") if x]
    return d


def _inline_images(html: str) -> str:
    """Replace img src URLs that point to /brand-assets/.../public with base64 data URIs."""
    def _replace(m: re.Match) -> str:
        url = m.group(1)
        # Only inline brand-asset public URLs served by the API
        if "/brand-assets/" not in url or "/public" not in url:
            return m.group(0)
        # Extract file_id from URL pattern .../brand-assets/{id}/public
        id_match = re.search(r"/brand-assets/([^/]+)/public", url)
        if not id_match:
            return m.group(0)
        file_id = id_match.group(1)
        conn = _conn()
        try:
            cur = conn.cursor()
            cur.execute("SELECT stored_name, mime_type FROM marketing_brand_files WHERE id=%s", [file_id])
            row = cur.fetchone()
        finally:
            conn.close()
        if not row:
            return m.group(0)
        path = os.path.join(BRAND_UPLOAD_DIR, row["stored_name"])
        if not os.path.exists(path):
            return m.group(0)
        try:
            with open(path, "rb") as f:
                data = base64.b64encode(f.read()).decode()
            return f'src="data:{row["mime_type"]};base64,{data}"'
        except Exception:
            return m.group(0)
    return re.sub(r'src="([^"]+)"', _replace, html)


# ── Google token helpers (mirrors drive.py) ───────────────────────────────────

def _get_token(user_id: str) -> str:
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT access_token, refresh_token, token_expiry, scopes "
            "FROM google_oauth_tokens WHERE user_id = %s",
            [user_id],
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(
            status_code=403,
            detail={"code": "no_google_token", "message": "Google account not connected. Connect via Contacts → Google."},
        )

    scopes = row["scopes"] or []
    if not any("drive" in s for s in scopes):
        raise HTTPException(
            status_code=403,
            detail={"code": "needs_drive_scope", "message": "Drive access not granted. Re-connect Google account to enable Drive."},
        )

    expiry = row["token_expiry"]
    if expiry and datetime.now(timezone.utc) >= expiry - timedelta(minutes=2):
        r = httpx.post(
            GOOGLE_TOKEN_URL,
            data={
                "client_id":     os.environ.get("GOOGLE_CLIENT_ID", ""),
                "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET", ""),
                "refresh_token": row["refresh_token"],
                "grant_type":    "refresh_token",
            },
            timeout=15,
        )
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to refresh Google token")
        data = r.json()
        new_token  = data["access_token"]
        new_expiry = datetime.now(timezone.utc) + timedelta(seconds=data.get("expires_in", 3600))
        conn2 = _conn()
        try:
            cur2 = conn2.cursor()
            cur2.execute(
                "UPDATE google_oauth_tokens SET access_token=%s, token_expiry=%s, updated_at=NOW() WHERE user_id=%s",
                [new_token, new_expiry, user_id],
            )
            conn2.commit()
        finally:
            conn2.close()
        return new_token

    return row["access_token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── Doc ID parsing ────────────────────────────────────────────────────────────

def _parse_doc_id(url_or_id: str) -> str:
    """Extract Google Doc ID from a URL or return as-is."""
    m = re.search(r"/document/d/([a-zA-Z0-9_-]+)", url_or_id)
    if m:
        return m.group(1)
    stripped = url_or_id.strip()
    if re.match(r"^[a-zA-Z0-9_-]{20,}$", stripped):
        return stripped
    raise HTTPException(status_code=400, detail="Could not parse Google Doc ID from input")


# ── Doc text format ───────────────────────────────────────────────────────────
#
# The Google Doc uses this human-readable plain-text format:
#
#   # Founder ERP Key Language Library
#
#   ---
#
#   ## Category Name
#
#   **Term**
#   Content text here.
#
#   **Another Term**
#   More content.
#
#   ---
#
#   ## Uncategorized
#   ...

def _normalise(text: str) -> str:
    """Compare wording, not whitespace.

    Google Docs normalises line endings and can leave trailing spaces, so a
    byte comparison reports differences nobody made.
    """
    lines = [ln.rstrip() for ln in (text or "").replace("\u000b", "\n").splitlines()]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    out, blank = [], False
    for ln in lines:
        if not ln:
            if blank:
                continue
            blank = True
        else:
            blank = False
        out.append(ln)
    return "\n".join(out)


def _fingerprint(text: str) -> str:
    return hashlib.sha256(_normalise(text).encode("utf-8")).hexdigest()


def _read_doc_text(token: str, doc_id: str) -> str:
    """Flatten a Google Doc to plain text."""
    r = httpx.get(f"{DOCS_API_BASE}/{doc_id}", headers=_auth(token), timeout=20)
    if r.status_code != 200:
        raise HTTPException(
            status_code=502, detail=f"Could not read Google Doc: {r.text[:200]}"
        )
    parts = []
    for element in r.json().get("body", {}).get("content", []):
        for run in element.get("paragraph", {}).get("elements", []):
            parts.append(run.get("textRun", {}).get("content", ""))
    return "".join(parts)


def _diff_entries(doc_entries: list[dict], lib_entries: list[dict]) -> dict:
    """Which entries differ, keyed by category and term."""
    key = lambda e: ((e.get("category") or "").strip(), (e.get("term") or "").strip())
    doc_map = {key(e): (e.get("content") or "").strip() for e in doc_entries}
    lib_map = {key(e): (e.get("content") or "").strip() for e in lib_entries}

    fmt = lambda k: f"{k[0]} / {k[1]}" if k[0] else k[1]
    return {
        "only_in_doc":     sorted(fmt(k) for k in doc_map.keys() - lib_map.keys()),
        "only_in_library": sorted(fmt(k) for k in lib_map.keys() - doc_map.keys()),
        "different":       sorted(fmt(k) for k in doc_map.keys() & lib_map.keys()
                                  if doc_map[k] != lib_map[k]),
    }


def _sync_state(uid: str) -> dict:
    """Compare the doc and the library by content, and attribute any difference.

    status is one of:
      no_doc         nothing linked
      in_sync        both sides hold the same wording
      doc_ahead      only the doc changed since the last sync — safe to pull
      library_ahead  only the library changed — safe to push
      conflict       both changed; whichever way you sync, something is lost
      unknown        never synced with fingerprints, so neither side can be trusted
    """
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT key_language_doc_id, key_language_synced_at,
                      key_language_doc_hash, key_language_lib_hash
               FROM marketing_settings WHERE id=1"""
        )
        row = cur.fetchone()
        if not row or not row["key_language_doc_id"]:
            return {"status": "no_doc", "needs_pull": False}
        cur.execute(
            "SELECT term, content, category, notes FROM key_language "
            "ORDER BY category, sort_order, term"
        )
        lib_entries = [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()

    doc_id = row["key_language_doc_id"]
    token = _get_token(uid)
    doc_text = _read_doc_text(token, doc_id)
    lib_text = _entries_to_text(lib_entries)

    doc_fp, lib_fp = _fingerprint(doc_text), _fingerprint(lib_text)
    doc_entries = _text_to_entries(doc_text)

    base = {
        "doc_entries":     len(doc_entries),
        "library_entries": len(lib_entries),
        # The entry diff is for display. It must not decide status: the parser
        # only sees text inside [Term] blocks, so a line typed anywhere else in
        # the document is invisible to it and a real edit would read as
        # identical. Status comes from the full text instead.
        "diff":            _diff_entries(doc_entries, lib_entries),
        "synced_at":       _serialize(row["key_language_synced_at"]),
    }

    if _normalise(doc_text) == _normalise(lib_text):
        return {**base, "status": "in_sync", "needs_pull": False}

    stored_doc, stored_lib = row["key_language_doc_hash"], row["key_language_lib_hash"]
    if not stored_doc or not stored_lib:
        return {**base, "status": "unknown", "needs_pull": False}

    doc_changed = doc_fp != stored_doc
    lib_changed = lib_fp != stored_lib

    if doc_changed and lib_changed:
        status = "conflict"
    elif doc_changed:
        status = "doc_ahead"
    elif lib_changed:
        status = "library_ahead"
    else:
        # Neither matches the other but both match the snapshot — only reachable
        # if the serialiser changed shape. Treat as needing a human.
        status = "conflict"

    return {**base, "status": status, "needs_pull": status == "doc_ahead"}


def _record_sync(doc_text: str, lib_text: str) -> None:
    """Snapshot both sides so the next comparison can attribute a change."""
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """UPDATE marketing_settings
               SET key_language_synced_at = NOW(),
                   key_language_doc_hash  = %s,
                   key_language_lib_hash  = %s
               WHERE id=1""",
            [_fingerprint(doc_text), _fingerprint(lib_text)],
        )
        conn.commit()
    finally:
        conn.close()


def _entries_to_text(entries: list[dict]) -> str:
    """
    Produce plain text for a Google Doc. Format:

        KEY LANGUAGE LIBRARY — Founder ERP

        ════════════════════════════════
        TAGLINE
        ════════════════════════════════

        [Tagline]
        Content here.

        ════════════════════════════════
        GENERAL DESCRIPTIONS
        ════════════════════════════════

        [Sentence]
        Content here.

        [Short]
        Content here.
    """
    from collections import defaultdict
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for e in entries:
        cat = (e.get("category") or "").strip() or "Uncategorized"
        by_cat[cat].append(e)

    divider = "═" * 40
    lines = ["KEY LANGUAGE LIBRARY — Founder ERP", ""]
    for cat, items in by_cat.items():
        lines += [divider, cat.upper(), divider, ""]
        for item in items:
            term = item["term"].strip()
            content = (item.get("content") or "").strip()
            lines.append(f"[{term}]")
            lines.append(content if content else "(empty)")
            if item.get("notes", "").strip():
                lines.append(f"Notes: {item['notes'].strip()}")
            lines.append("")
        lines.append("")
    return "\n".join(lines)


def _text_to_entries(text: str) -> list[dict]:
    """Parse the Google Doc plain-text format back into entry dicts."""
    entries = []
    current_category = ""
    current_term: Optional[str] = None
    current_content_lines: list[str] = []

    def flush():
        nonlocal current_term, current_content_lines
        if current_term:
            content = "\n".join(current_content_lines).strip()
            if content.lower() == "(empty)":
                content = ""
            entries.append({
                "term":     current_term,
                "content":  content,
                "category": current_category,
                "notes":    "",
            })
        current_term = None
        current_content_lines = []

    divider_pat = re.compile(r"^[═=─-]{10,}$")

    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()

        # Divider line — next non-empty line is the category name
        if divider_pat.match(line.strip()):
            flush()
            i += 1
            # Peek ahead for category name (skip blank lines)
            while i < len(lines) and not lines[i].strip():
                i += 1
            if i < len(lines):
                candidate = lines[i].strip()
                # Only treat as category if followed by another divider
                if i + 1 < len(lines) and divider_pat.match(lines[i + 1].strip()):
                    current_category = candidate.title()
                    i += 2  # skip the closing divider
                    continue
            continue

        # Term label: [Term Name]
        term_match = re.match(r"^\[(.+?)\]\s*$", line)
        if term_match:
            flush()
            current_term = term_match.group(1).strip()
            i += 1
            continue

        # Notes line
        if line.startswith("Notes:") and current_term:
            # Ignore notes on pull (they're informational)
            i += 1
            continue

        # Skip header line and empty lines outside term blocks
        if current_term is not None and line:
            current_content_lines.append(line)

        i += 1

    flush()
    return entries


# ── Key Language CRUD ─────────────────────────────────────────────────────────

DEFAULT_SLOTS = [
    {"category": "Tagline",                "terms": ["Tagline"]},
    {"category": "General Descriptions",   "terms": ["Sentence", "Short", "Long"]},
    {"category": "Technical Descriptions", "terms": ["Sentence", "Short", "Long"]},
    {"category": "Investor Descriptions",  "terms": ["Sentence", "Short", "Long"]},
    {"category": "Bakery Descriptions",    "terms": ["Sentence", "Short", "Long"]},
]


@router.get("/key-language")
def list_key_language(request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, term, content, category, notes, sort_order, created_at, updated_at "
            "FROM key_language ORDER BY category, sort_order, term"
        )
        entries = [_row_dict(r) for r in cur.fetchall()]

        cur.execute(
            "SELECT key_language_doc_id, key_language_doc_url, key_language_synced_at, slots_config "
            "FROM marketing_settings WHERE id=1"
        )
        settings = cur.fetchone()
    finally:
        conn.close()

    settings_dict = _row_dict(settings) if settings else {}
    slots = settings_dict.pop("slots_config", None) or DEFAULT_SLOTS

    return {
        "entries": entries,
        "doc": settings_dict,
        "slots": slots,
    }


class RenameCategoryBody(BaseModel):
    old_name: str
    new_name: str


@router.post("/key-language/category/rename")
def rename_category(body: RenameCategoryBody, request: Request):
    _require_user(request)
    if not body.new_name.strip():
        raise HTTPException(status_code=400, detail="New name cannot be empty")
    conn = _conn()
    try:
        cur = conn.cursor()
        # Update all entries with the old category name
        cur.execute(
            "UPDATE key_language SET category=%s, updated_at=NOW() WHERE category=%s",
            [body.new_name.strip(), body.old_name],
        )
        # Update slots_config JSON
        cur.execute("SELECT slots_config FROM marketing_settings WHERE id=1")
        row = cur.fetchone()
        slots = row["slots_config"] if row and row["slots_config"] else DEFAULT_SLOTS
        updated_slots = [
            {**s, "category": body.new_name.strip()} if s["category"] == body.old_name else s
            for s in slots
        ]
        import json
        cur.execute(
            "UPDATE marketing_settings SET slots_config=%s::jsonb WHERE id=1",
            [json.dumps(updated_slots)],
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "slots": updated_slots}


class CreateEntryBody(BaseModel):
    term: str
    content: str = ""
    category: str = ""
    notes: str = ""
    sort_order: int = 0


@router.post("/key-language")
def create_entry(body: CreateEntryBody, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO key_language (term, content, category, notes, sort_order)
               VALUES (%s, %s, %s, %s, %s) RETURNING *""",
            [body.term, body.content, body.category, body.notes, body.sort_order],
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    return _row_dict(row)


class UpdateEntryBody(BaseModel):
    term: Optional[str] = None
    content: Optional[str] = None
    category: Optional[str] = None
    notes: Optional[str] = None
    sort_order: Optional[int] = None


@router.patch("/key-language/{entry_id}")
def update_entry(entry_id: str, body: UpdateEntryBody, request: Request):
    _require_user(request)
    fields = body.model_dump(exclude_none=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    set_clause = ", ".join(f"{k}=%s" for k in fields)
    values = list(fields.values()) + [entry_id]
    conn = _conn()
    try:
        cur = conn.cursor()
        # Snapshot current content into history before overwriting
        if "content" in fields:
            cur.execute("SELECT content FROM key_language WHERE id=%s", [entry_id])
            old = cur.fetchone()
            if old and old["content"]:
                cur.execute(
                    "INSERT INTO key_language_history (entry_id, content) VALUES (%s, %s)",
                    [entry_id, old["content"]],
                )
        cur.execute(
            f"UPDATE key_language SET {set_clause}, updated_at=NOW() WHERE id=%s RETURNING *",
            values,
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        conn.commit()
    finally:
        conn.close()
    return _row_dict(row)


@router.get("/key-language/{entry_id}/history")
def get_entry_history(entry_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, content, saved_at FROM key_language_history WHERE entry_id=%s ORDER BY saved_at DESC LIMIT 50",
            [entry_id],
        )
        rows = [_row_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()
    return rows


class RestoreBody(BaseModel):
    history_id: str


@router.post("/key-language/{entry_id}/restore")
def restore_entry(entry_id: str, body: RestoreBody, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT content FROM key_language_history WHERE id=%s AND entry_id=%s",
            [body.history_id, entry_id],
        )
        hist = cur.fetchone()
        if not hist:
            raise HTTPException(status_code=404, detail="History record not found")
        # Save current to history first
        cur.execute("SELECT content FROM key_language WHERE id=%s", [entry_id])
        old = cur.fetchone()
        if old and old["content"]:
            cur.execute(
                "INSERT INTO key_language_history (entry_id, content) VALUES (%s, %s)",
                [entry_id, old["content"]],
            )
        cur.execute(
            "UPDATE key_language SET content=%s, updated_at=NOW() WHERE id=%s RETURNING *",
            [hist["content"], entry_id],
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    return _row_dict(row)


@router.delete("/key-language/{entry_id}")
def delete_entry(entry_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM key_language WHERE id=%s", [entry_id])
        if cur.rowcount == 0:
            raise HTTPException(status_code=404)
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


# ── Google Doc link / unlink ──────────────────────────────────────────────────

class LinkDocBody(BaseModel):
    doc_url: str


@router.post("/key-language/doc/link")
def link_doc(body: LinkDocBody, request: Request):
    uid = _require_user(request)
    doc_id = _parse_doc_id(body.doc_url)
    token = _get_token(uid)

    # Verify access by fetching doc metadata
    r = httpx.get(
        f"{DRIVE_FILES_URL}/{doc_id}",
        headers=_auth(token),
        params={"fields": "id,name,webViewLink,mimeType", "supportsAllDrives": "true"},
        timeout=10,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=400, detail="Could not access the Google Doc. Check permissions.")
    meta = r.json()
    if meta.get("mimeType") != "application/vnd.google-apps.document":
        raise HTTPException(status_code=400, detail="The linked file must be a Google Doc (not a Sheet, Folder, etc.)")

    doc_url = meta.get("webViewLink", body.doc_url)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE marketing_settings SET key_language_doc_id=%s, key_language_doc_url=%s WHERE id=1",
            [doc_id, doc_url],
        )
        conn.commit()
    finally:
        conn.close()

    return {"doc_id": doc_id, "doc_url": doc_url, "name": meta.get("name")}


@router.delete("/key-language/doc/unlink")
def unlink_doc(request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE marketing_settings SET key_language_doc_id=NULL, key_language_doc_url=NULL, key_language_synced_at=NULL WHERE id=1"
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


# ── Push: DB → Google Doc ─────────────────────────────────────────────────────

@router.post("/key-language/doc/push")
def push_to_doc(request: Request, force: bool = Query(False)):
    """Write the library into the doc.

    Refuses when the doc has its own unsynced edits, which a push would
    overwrite. force=true proceeds anyway, for when the doc is known to be junk.
    """
    uid = _require_user(request)

    state = _sync_state(uid)
    if not force and state.get("status") in ("doc_ahead", "conflict", "unknown"):
        raise HTTPException(status_code=409, detail={
            "code": "doc_has_changes",
            "status": state["status"],
            "message": (
                "The Google Doc has been edited since the last sync. Pushing would "
                "overwrite those edits."
            ),
            "diff": state.get("diff"),
        })

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT key_language_doc_id FROM marketing_settings WHERE id=1")
        row = cur.fetchone()
        if not row or not row["key_language_doc_id"]:
            raise HTTPException(status_code=400, detail="No Google Doc linked")
        doc_id = row["key_language_doc_id"]

        cur.execute(
            "SELECT term, content, category, notes FROM key_language ORDER BY category, sort_order, term"
        )
        entries = [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()

    token = _get_token(uid)
    new_text = _entries_to_text(entries)

    # Get current document end index
    r = httpx.get(f"{DOCS_API_BASE}/{doc_id}", headers=_auth(token), timeout=15)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Could not read Google Doc: {r.text[:200]}")

    doc = r.json()
    body_content = doc.get("body", {}).get("content", [])
    end_index = 1
    for element in body_content:
        ei = element.get("endIndex")
        if ei:
            end_index = ei

    # Build batchUpdate requests: delete all then insert fresh.
    # end_index == 2 means only the implicit trailing newline exists (empty doc);
    # deleteContentRange requires startIndex < endIndex, so skip it in that case.
    requests = []
    if end_index > 2:
        requests.append({
            "deleteContentRange": {
                "range": {"startIndex": 1, "endIndex": end_index - 1}
            }
        })
    requests.append({
        "insertText": {
            "location": {"index": 1},
            "text": new_text,
        }
    })

    r2 = httpx.post(
        f"{DOCS_API_BASE}/{doc_id}:batchUpdate",
        headers={**_auth(token), "Content-Type": "application/json"},
        json={"requests": requests},
        timeout=30,
    )
    if r2.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Google Docs write failed: {r2.text[:300]}")

    # Snapshot both sides as they now stand: the doc holds exactly what was
    # written, so the next check can tell which side moves next.
    _record_sync(new_text, new_text)

    return {"ok": True, "pushed": len(entries)}


# ── Doc change check ─────────────────────────────────────────────────────────

@router.get("/key-language/doc/check")
def check_doc_sync(request: Request):
    """Compare the doc and the library by content, and say which side changed."""
    uid = _require_user(request)
    try:
        return _sync_state(uid)
    except HTTPException:
        # A check must never block the page it sits on.
        return {"status": "unavailable", "needs_pull": False}


# ── Pull: Google Doc → DB ─────────────────────────────────────────────────────

@router.post("/key-language/doc/pull")
def pull_from_doc(request: Request, force: bool = Query(False)):
    """Replace the library with the doc's contents.

    Refuses when the library has its own unsynced edits, which a pull would
    discard, and when the doc holds fewer entries than the library — the shape
    of an accidentally emptied document.
    """
    uid = _require_user(request)

    state = _sync_state(uid)
    if not force and state.get("status") in ("library_ahead", "conflict", "unknown"):
        raise HTTPException(status_code=409, detail={
            "code": "library_has_changes",
            "status": state["status"],
            "message": (
                "The library has been edited since the last sync. Pulling would "
                "discard those edits."
            ),
            "diff": state.get("diff"),
        })

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT key_language_doc_id FROM marketing_settings WHERE id=1")
        row = cur.fetchone()
        if not row or not row["key_language_doc_id"]:
            raise HTTPException(status_code=400, detail="No Google Doc linked")
        doc_id = row["key_language_doc_id"]
    finally:
        conn.close()

    token = _get_token(uid)

    # Export doc as plain text
    r = httpx.get(
        DRIVE_EXPORT_URL.format(id=doc_id),
        headers=_auth(token),
        params={"mimeType": "text/plain"},
        timeout=30,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Could not export Google Doc: {r.text[:200]}")

    entries = _text_to_entries(r.text)
    if not entries:
        raise HTTPException(status_code=422, detail="No valid entries found in the document. Check the formatting.")

    # A pull that drops entries is usually a half-cleared document rather than a
    # deliberate deletion, and the library is the copy people actually use.
    existing = state.get("library_entries") or 0
    if not force and existing and len(entries) < existing:
        raise HTTPException(status_code=409, detail={
            "code": "pull_would_lose_entries",
            "message": (
                f"The document has {len(entries)} entries but the library has "
                f"{existing}. Pulling would delete the difference."
            ),
            "diff": state.get("diff"),
        })

    # Replace all existing entries with parsed ones
    conn2 = _conn()
    try:
        cur2 = conn2.cursor()
        cur2.execute("DELETE FROM key_language")
        for i, e in enumerate(entries):
            cur2.execute(
                """INSERT INTO key_language (term, content, category, notes, sort_order)
                   VALUES (%s, %s, %s, %s, %s)""",
                [e["term"], e["content"], e["category"], e["notes"], i],
            )
        conn2.commit()
    finally:
        conn2.close()

    # Snapshot both sides. The library now serialises to the same wording the
    # doc holds, so the next check starts from a known-equal baseline.
    _record_sync(r.text, _entries_to_text(entries))

    return {"ok": True, "imported": len(entries)}


# ── Pitch Decks ───────────────────────────────────────────────────────────────

DECK_TYPES = [
    "Investor Deck",
    "Post-NDA Investor Deck",
    "Client Deck — General",
    "Client Deck — Bakery",
    "Partner Deck — Technical",
]


def _parse_drive_file_id(url_or_id: str) -> str:
    """Extract a Drive file ID from various URL formats."""
    stripped = url_or_id.strip()
    # /file/d/{id}/
    m = re.search(r"/file/d/([a-zA-Z0-9_-]+)", stripped)
    if m:
        return m.group(1)
    # /presentation/d/{id}/ or /document/d/{id}/
    m = re.search(r"/(?:presentation|document|spreadsheets)/d/([a-zA-Z0-9_-]+)", stripped)
    if m:
        return m.group(1)
    # ?id={id} or open?id={id}
    m = re.search(r"[?&]id=([a-zA-Z0-9_-]+)", stripped)
    if m:
        return m.group(1)
    # raw ID
    if re.match(r"^[a-zA-Z0-9_-]{20,}$", stripped):
        return stripped
    raise HTTPException(status_code=400, detail="Could not parse Drive file ID from URL")


class ResolveFileBody(BaseModel):
    url: str


@router.get("/website/posts")
def list_posts(request: Request, page: int = 1, per_page: int = 20, status: str = "any"):
    _require_user(request)
    params = {"page": page, "per_page": per_page, "status": status, "_embed": 1}
    posts = _wp_get("/posts", params)
    return [_wp_post_summary(p) for p in posts]


@router.get("/website/posts/{post_id}")
def get_post(post_id: int, request: Request):
    _require_user(request)
    p = _wp_get(f"/posts/{post_id}")
    return {
        **_wp_post_summary(p),
        "content": p.get("content", {}).get("raw", p.get("content", {}).get("rendered", "")),
        "content_rendered": p.get("content", {}).get("rendered", ""),
    }


class PostBody(BaseModel):
    title: str
    content: str = ""
    status: str = "draft"
    excerpt: str = ""
    categories: list[int] = []
    tags: list[int] = []
    date: Optional[str] = None  # ISO 8601, local time (WP treats as site timezone)


@router.post("/website/posts")
def create_post(body: PostBody, request: Request):
    _require_user(request)
    payload: dict = {
        "title": body.title,
        "content": body.content,
        "status": body.status,
        "excerpt": body.excerpt,
        "categories": body.categories,
        "tags": body.tags,
    }
    if body.date:
        payload["date"] = body.date
    p = _wp_post("/posts", payload)
    return _wp_post_summary(p)


class PostPatchBody(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    status: Optional[str] = None
    excerpt: Optional[str] = None
    categories: Optional[list[int]] = None
    tags: Optional[list[int]] = None
    date: Optional[str] = None


@router.patch("/website/posts/{post_id}")
def update_post(post_id: int, body: PostPatchBody, request: Request):
    _require_user(request)
    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    p = _wp_patch(f"/posts/{post_id}", payload)
    return _wp_post_summary(p)


@router.delete("/website/posts/{post_id}")
def delete_post(post_id: int, request: Request):
    _require_user(request)
    _wp_delete(f"/posts/{post_id}?force=true")
    return {"ok": True}


# ── Pages ────────────────────────────────────────────────────────────────────

def _wp_get_page(page_id: int) -> dict:
    """Fetch a WP page, falling back from edit context to view context on error."""
    try:
        return _wp_get(f"/pages/{page_id}", {"context": "edit"})
    except Exception:
        return _wp_get(f"/pages/{page_id}")


@router.get("/website/pages")
def list_pages(request: Request):
    _require_user(request)
    pages = []
    for pg in WP_KNOWN_PAGES:
        try:
            p = _wp_get_page(pg["id"])
            content = p.get("content", {})
            raw = content.get("raw") or content.get("rendered", "")
            pages.append({
                "id": pg["id"],
                "slug": pg["slug"],
                "label": pg["label"],
                "title": p.get("title", {}).get("rendered", pg["label"]),
                "modified": p.get("modified", ""),
                "link": p.get("link", ""),
                "blocks": _extract_acf_blocks(raw),
            })
        except Exception as e:
            pages.append({
                "id": pg["id"],
                "slug": pg["slug"],
                "label": pg["label"],
                "title": pg["label"],
                "modified": "",
                "link": "",
                "blocks": [],
                "error": str(e),
            })
    return pages


@router.get("/website/pages/{page_id}")
def get_page(page_id: int, request: Request):
    _require_user(request)
    p = _wp_get_page(page_id)
    content = p.get("content", {})
    raw = content.get("raw") or content.get("rendered", "")
    return {
        "id": p["id"],
        "slug": p.get("slug", ""),
        "title": p.get("title", {}).get("rendered", ""),
        "modified": p.get("modified", ""),
        "link": p.get("link", ""),
        "raw_content": raw,
        "blocks": _extract_acf_blocks(raw),
    }


class PageBlockPatch(BaseModel):
    block: str
    field: str
    value: str
    block_index: int = 0


@router.patch("/website/pages/{page_id}/block")
def patch_page_block(page_id: int, body: PageBlockPatch, request: Request):
    """Update a single ACF block field in a page's raw content."""
    import json as _json
    _require_user(request)
    p = _wp_get_page(page_id)
    content = p.get("content", {})
    raw = content.get("raw") or content.get("rendered", "")

    pattern = re.compile(
        r'(<!-- wp:acf/' + re.escape(body.block) + r'\s+)(\{.*?\})(\s*/-->)',
        re.DOTALL
    )
    matches = list(pattern.finditer(raw))
    if body.block_index >= len(matches):
        raise HTTPException(status_code=404, detail="Block not found")

    m = matches[body.block_index]
    try:
        data = _json.loads(m.group(2))
    except Exception:
        raise HTTPException(status_code=422, detail="Block data not parseable")

    if "data" not in data:
        data["data"] = {}
    data["data"][body.field] = body.value

    new_comment = m.group(1) + _json.dumps(data) + m.group(3)
    new_raw = raw[:m.start()] + new_comment + raw[m.end():]
    _wp_patch(f"/pages/{page_id}", {"content": new_raw})
    return {"ok": True}


# ── Categories & Tags ────────────────────────────────────────────────────────

@router.get("/website/categories")
def list_categories(request: Request):
    _require_user(request)
    return _wp_get("/categories", {"per_page": 100})


@router.get("/website/tags")
def list_tags(request: Request):
    _require_user(request)
    return _wp_get("/tags", {"per_page": 100})


# ─────────────────────────────────────────────────────────────────────────────
# Brand Asset File Upload / Download
# ─────────────────────────────────────────────────────────────────────────────

import uuid as _uuid_mod
from fastapi import UploadFile, File, Form
from fastapi.responses import FileResponse

BRAND_UPLOAD_DIR = "/app/uploads/brand"
BRAND_CATEGORIES = ["logo", "letter_mark", "brand_guidelines", "tagline", "icons"]

os.makedirs(BRAND_UPLOAD_DIR, exist_ok=True)


@router.get("/brand-assets")
def list_brand_assets(request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT id, category, original_name, mime_type, file_size, created_at "
            "FROM marketing_brand_files ORDER BY category, created_at"
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    grouped: dict = {c: [] for c in BRAND_CATEGORIES}
    for r in rows:
        cat = r["category"]
        if cat not in grouped:
            grouped[cat] = []
        grouped[cat].append({
            "id": str(r["id"]),
            "category": cat,
            "original_name": r["original_name"],
            "mime_type": r["mime_type"] or "",
            "file_size": r["file_size"] or 0,
            "created_at": r["created_at"].isoformat() if r["created_at"] else "",
        })
    return grouped


@router.post("/brand-assets/upload")
async def upload_brand_asset(
    request: Request,
    category: str = Form(...),
    file: UploadFile = File(...),
):
    _require_user(request)
    if category not in BRAND_CATEGORIES:
        raise HTTPException(status_code=400, detail=f"Invalid category: {category}")

    file_id = str(_uuid_mod.uuid4())
    ext = os.path.splitext(file.filename or "")[1]
    stored_name = f"{file_id}{ext}"
    dest = os.path.join(BRAND_UPLOAD_DIR, stored_name)

    content = await file.read()
    with open(dest, "wb") as f:
        f.write(content)

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            """INSERT INTO marketing_brand_files
               (id, category, original_name, stored_name, mime_type, file_size)
               VALUES (%s, %s, %s, %s, %s, %s)
               RETURNING id, category, original_name, mime_type, file_size, created_at""",
            [file_id, category, file.filename, stored_name,
             file.content_type, len(content)],
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()

    return {
        "id": str(row["id"]),
        "category": row["category"],
        "original_name": row["original_name"],
        "mime_type": row["mime_type"] or "",
        "file_size": row["file_size"] or 0,
        "created_at": row["created_at"].isoformat() if row["created_at"] else "",
    }


@router.get("/brand-assets/{file_id}/download")
def download_brand_asset(file_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT original_name, stored_name, mime_type FROM marketing_brand_files WHERE id=%s",
            [file_id],
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404)

    path = os.path.join(BRAND_UPLOAD_DIR, row["stored_name"])
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File not found on disk")

    return FileResponse(
        path=path,
        filename=row["original_name"],
        media_type=row["mime_type"] or "application/octet-stream",
    )


@router.get("/brand-assets/{file_id}/public")
def public_brand_asset(file_id: str):
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT stored_name, mime_type FROM marketing_brand_files WHERE id=%s",
            [file_id],
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404)
    if not (row["mime_type"] or "").startswith("image/"):
        raise HTTPException(status_code=404)

    path = os.path.join(BRAND_UPLOAD_DIR, row["stored_name"])
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File not found on disk")

    return FileResponse(
        path=path,
        media_type=row["mime_type"] or "image/png",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.head("/brand-assets/{file_id}/public")
def public_brand_asset_head(file_id: str):
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT stored_name, mime_type FROM marketing_brand_files WHERE id=%s",
            [file_id],
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404)
    if not (row["mime_type"] or "").startswith("image/"):
        raise HTTPException(status_code=404)

    path = os.path.join(BRAND_UPLOAD_DIR, row["stored_name"])
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File not found on disk")

    return Response(
        status_code=200,
        headers={
            "Content-Type": row["mime_type"] or "image/png",
            "Content-Length": str(os.path.getsize(path)),
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


# ── Campaign Templates ────────────────────────────────────────────────────────

class TemplateCreate(BaseModel):
    name: str
    type: str = "email"
    subject: str = ""
    body: str = ""
    body_html: Optional[str] = None
    sender_name: Optional[str] = None
    sender_email: Optional[str] = None
    reply_to: Optional[str] = None
    business_name: Optional[str] = None
    business_address: Optional[str] = None
    unsubscribe_enabled: bool = True


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    body_html: Optional[str] = None
    sender_name: Optional[str] = None
    sender_email: Optional[str] = None
    reply_to: Optional[str] = None
    business_name: Optional[str] = None
    business_address: Optional[str] = None
    unsubscribe_enabled: Optional[bool] = None


# ─────────────────────────────────────────────────────────────────────────────
# Brand Settings
# ─────────────────────────────────────────────────────────────────────────────

class BrandSettingsUpdate(BaseModel):
    font_family: str | None = None
    font_size: int | None = None
    heading_size: int | None = None
    text_color: str | None = None
    heading_color: str | None = None
    button_color: str | None = None
    button_text_color: str | None = None
    brand_colors: list | None = None
    logo_url: str | None = None
    business_name: str | None = None
    business_address: str | None = None


@router.get("/brand-settings")
def get_brand_settings(request: Request):
    user_id = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM campaign_brand_settings WHERE user_id = %s::uuid", [user_id])
        row = cur.fetchone()
        if not row:
            return {
                "font_family": "Inter, Arial, sans-serif",
                "font_size": 15,
                "heading_size": 28,
                "text_color": "#374151",
                "heading_color": "#111827",
                "button_color": "#2563eb",
                "button_text_color": "#ffffff",
                "brand_colors": [],
                "logo_url": None,
                "business_name": None,
                "business_address": None,
            }
        result = dict(row)
        result.pop("user_id", None)
        result.pop("logo_asset_id", None)
        if result.get("updated_at"):
            result["updated_at"] = result["updated_at"].isoformat()
        if isinstance(result.get("brand_colors"), str):
            import json
            result["brand_colors"] = json.loads(result["brand_colors"])
        return result
    finally:
        conn.close()


@router.patch("/brand-settings")
def update_brand_settings(body: BrandSettingsUpdate, request: Request):
    user_id = _require_user(request)
    import json as _json
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            """INSERT INTO campaign_brand_settings
                 (user_id, font_family, font_size, heading_size, text_color, heading_color,
                  button_color, button_text_color, brand_colors, logo_url, business_name, business_address, updated_at)
               VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, NOW())
               ON CONFLICT (user_id) DO UPDATE SET
                 font_family      = COALESCE(EXCLUDED.font_family,      campaign_brand_settings.font_family),
                 font_size        = COALESCE(EXCLUDED.font_size,        campaign_brand_settings.font_size),
                 heading_size     = COALESCE(EXCLUDED.heading_size,     campaign_brand_settings.heading_size),
                 text_color       = COALESCE(EXCLUDED.text_color,       campaign_brand_settings.text_color),
                 heading_color    = COALESCE(EXCLUDED.heading_color,    campaign_brand_settings.heading_color),
                 button_color     = COALESCE(EXCLUDED.button_color,     campaign_brand_settings.button_color),
                 button_text_color= COALESCE(EXCLUDED.button_text_color,campaign_brand_settings.button_text_color),
                 brand_colors     = COALESCE(EXCLUDED.brand_colors,     campaign_brand_settings.brand_colors),
                 logo_url         = EXCLUDED.logo_url,
                 business_name    = EXCLUDED.business_name,
                 business_address = EXCLUDED.business_address,
                 updated_at       = NOW()
               RETURNING *""",
            [user_id,
             body.font_family or "Inter, Arial, sans-serif",
             body.font_size or 15,
             body.heading_size or 28,
             body.text_color or "#374151",
             body.heading_color or "#111827",
             body.button_color or "#2563eb",
             body.button_text_color or "#ffffff",
             _json.dumps(body.brand_colors or []),
             body.logo_url,
             body.business_name,
             body.business_address],
        )
        conn.commit()
        result = dict(cur.fetchone())
        result.pop("user_id", None)
        result.pop("logo_asset_id", None)
        if result.get("updated_at"):
            result["updated_at"] = result["updated_at"].isoformat()
        if isinstance(result.get("brand_colors"), str):
            result["brand_colors"] = _json.loads(result["brand_colors"])
        return result
    finally:
        conn.close()


@router.get("/campaign-templates")
def list_templates(request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM campaign_templates ORDER BY updated_at DESC")
        return [_row_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/campaign-templates", status_code=201)
def create_template(body: TemplateCreate, request: Request):
    user_id = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO campaign_templates
                 (user_id, name, type, subject, body, body_html, sender_name, sender_email,
                  reply_to, business_name, business_address, unsubscribe_enabled)
               VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *""",
            [user_id, body.name, body.type, body.subject, body.body, body.body_html,
             body.sender_name, body.sender_email, body.reply_to, body.business_name,
             body.business_address, body.unsubscribe_enabled],
        )
        row = _row_dict(cur.fetchone())
        conn.commit()
        return row
    finally:
        conn.close()


@router.patch("/campaign-templates/{template_id}")
def update_template(template_id: str, body: TemplateUpdate, request: Request):
    user_id = _require_user(request)
    updates = {k: v for k, v in body.dict(exclude_unset=True).items()}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    conn = _conn()
    try:
        cur = conn.cursor()
        sets = ", ".join(f"{k} = %s" for k in updates)
        vals = list(updates.values()) + [template_id]
        cur.execute(
            f"UPDATE campaign_templates SET {sets}, updated_at = NOW() "
            f"WHERE template_id = %s::uuid RETURNING *",
            vals,
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        conn.commit()
        return _row_dict(row)
    finally:
        conn.close()


@router.delete("/campaign-templates/{template_id}")
def delete_template(template_id: str, request: Request):
    user_id = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM campaign_templates WHERE template_id = %s::uuid",
            [template_id],
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── Email Campaigns ────────────────────────────────────────────────────────────

GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"


class CampaignCreate(BaseModel):
    title: str
    type: str = "email"
    template_id: Optional[str] = None
    list_id: Optional[str] = None
    sender_name: Optional[str] = None
    sender_email: Optional[str] = None
    reply_to: Optional[str] = None
    business_name: Optional[str] = None
    business_address: Optional[str] = None
    unsubscribe_enabled: bool = True
    subject: str = ""
    body: str = ""
    body_html: Optional[str] = None
    recipient_list: list[str] = []
    list_ids: list[str] = []


class CampaignUpdate(BaseModel):
    title: Optional[str] = None
    type: Optional[str] = None
    template_id: Optional[str] = None
    list_id: Optional[str] = None
    sender_name: Optional[str] = None
    sender_email: Optional[str] = None
    reply_to: Optional[str] = None
    business_name: Optional[str] = None
    business_address: Optional[str] = None
    unsubscribe_enabled: Optional[bool] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    body_html: Optional[str] = None
    recipient_list: Optional[list[str]] = None
    list_ids: Optional[list[str]] = None


class ScheduleRequest(BaseModel):
    scheduled_at: str  # ISO 8601 datetime string


class CampaignPostCreate(BaseModel):
    title: str = ""
    template_id: Optional[str] = None
    subject: str = ""
    body: str = ""
    body_html: Optional[str] = None
    scheduled_at: Optional[str] = None
    list_ids: list[str] = []


class CampaignPostUpdate(BaseModel):
    title: Optional[str] = None
    template_id: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    body_html: Optional[str] = None
    scheduled_at: Optional[str] = None
    status: Optional[str] = None
    list_ids: Optional[list[str]] = None


@router.get("/campaigns/{campaign_id}/list-schedule")
def get_campaign_list_schedule(campaign_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT cls.list_id::text, cls.frequency, l.name, l.description,
                 (SELECT COUNT(*) FROM campaign_list_contacts lc WHERE lc.list_id = cls.list_id)
                 + (SELECT COUNT(*) FROM campaign_list_emails le WHERE le.list_id = cls.list_id) AS contact_count
               FROM campaign_list_schedule cls
               JOIN campaign_lists l ON l.list_id = cls.list_id
               WHERE cls.campaign_id = %s::uuid
               ORDER BY l.name""",
            [campaign_id],
        )
        return [_row_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.put("/campaigns/{campaign_id}/list-schedule")
def set_campaign_list_schedule(campaign_id: str, body: dict, request: Request):
    """Replace campaign list schedule. body = {schedules: [{list_id, frequency}]}"""
    user_id = _require_user(request)
    schedules = body.get("schedules", [])
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM email_campaigns WHERE campaign_id=%s::uuid", [campaign_id])
        if not cur.fetchone():
            raise HTTPException(status_code=404)
        cur.execute("DELETE FROM campaign_list_schedule WHERE campaign_id = %s::uuid", [campaign_id])
        for s in schedules:
            cur.execute(
                "INSERT INTO campaign_list_schedule (campaign_id, list_id, frequency) VALUES (%s::uuid, %s::uuid, %s) ON CONFLICT DO NOTHING",
                [campaign_id, s["list_id"], s.get("frequency", "every")],
            )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.get("/campaigns")
def list_campaigns(request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM email_campaigns ORDER BY created_at DESC")
        return [_campaign_row(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/campaigns", status_code=201)
def create_campaign(body: CampaignCreate, request: Request):
    user_id = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO email_campaigns
                (user_id, title, type, template_id, list_id, sender_name, sender_email,
                 reply_to, business_name, business_address, unsubscribe_enabled,
                 subject, body, body_html, recipient_list, list_ids)
            VALUES (%s::uuid, %s, %s, %s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::uuid[])
            RETURNING *
            """,
            [user_id, body.title, body.type, body.template_id, body.list_id,
             body.sender_name, body.sender_email, body.reply_to, body.business_name,
             body.business_address, body.unsubscribe_enabled, body.subject, body.body,
             body.body_html, body.recipient_list, body.list_ids or []],
        )
        row = _campaign_row(cur.fetchone())
        conn.commit()
        return row
    finally:
        conn.close()


@router.patch("/campaigns/{campaign_id}")
def update_campaign(campaign_id: str, body: CampaignUpdate, request: Request):
    user_id = _require_user(request)
    updates = {k: v for k, v in body.dict(exclude_unset=True).items()}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    conn = _conn()
    try:
        cur = conn.cursor()
        set_parts = []
        set_vals = []
        for k, v in updates.items():
            if k == "list_ids":
                set_parts.append("list_ids = %s::uuid[]")
            elif k in ("template_id", "list_id"):
                set_parts.append(f"{k} = %s::uuid")
            else:
                set_parts.append(f"{k} = %s")
            set_vals.append(v)
        sets = ", ".join(set_parts)
        vals = set_vals + [campaign_id]
        cur.execute(
            f"UPDATE email_campaigns SET {sets}, updated_at = NOW() "
            f"WHERE campaign_id = %s::uuid RETURNING *",
            vals,
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        conn.commit()
        return _campaign_row(row)
    finally:
        conn.close()


@router.delete("/campaigns/{campaign_id}")
def delete_campaign(campaign_id: str, request: Request):
    user_id = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM email_campaigns WHERE campaign_id = %s::uuid",
            [campaign_id],
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def _parse_optional_dt(value: Optional[str]):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid scheduled_at datetime")


def _resolve_campaign_recipients(campaign: dict) -> list[dict]:
    recipients: list[dict] = []
    for email in (campaign.get("recipient_list") or []):
        if "@" in email:
            recipients.append({"email": email, "contact_id": None})

    # Post-level list_ids take priority; fall back to campaign schedule, then single list_id
    list_ids = campaign.get("list_ids") or []
    if not list_ids and campaign.get("list_id"):
        list_ids = [str(campaign["list_id"])]
    if list_ids:
        conn = _conn()
        try:
            cur = conn.cursor()
            for lid in list_ids:
                cur.execute(
                    """SELECT COALESCE(lc.selected_email, c.email) AS email, c.contact_id::text
                       FROM campaign_list_contacts lc
                       JOIN contacts c ON c.contact_id = lc.contact_id
                       WHERE lc.list_id = %s::uuid AND NOT c.archived
                         AND (lc.selected_email IS NOT NULL
                              OR (c.email IS NOT NULL AND c.email != ''))""",
                    [lid],
                )
                for r in cur.fetchall():
                    recipients.append({"email": r["email"], "contact_id": str(r["contact_id"])})
                cur.execute(
                    "SELECT email FROM campaign_list_emails WHERE list_id = %s::uuid",
                    [lid],
                )
                for r in cur.fetchall():
                    recipients.append({"email": r["email"], "contact_id": None})
        finally:
            conn.close()

    seen: set[str] = set()
    deduped = []
    for r in recipients:
        key = r["email"].lower()
        if key not in seen:
            seen.add(key)
            deduped.append(r)
    user_id = campaign.get("user_id")
    if user_id and deduped:
        conn = _conn()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT lower(email) AS email FROM campaign_unsubscribes WHERE user_id=%s::uuid",
                [str(user_id)],
            )
            suppressed = {r["email"] for r in cur.fetchall()}
        finally:
            conn.close()
        deduped = [r for r in deduped if r["email"].lower() not in suppressed]
    return deduped


def _tracking_base(request: Optional[Request], campaign_id: str) -> str:
    if request is not None:
        proto = request.headers.get("x-forwarded-proto", "https")
        host = request.headers.get("x-forwarded-host", request.headers.get("host", ""))
        return f"{proto}://{host}/api/marketing/track/open/{campaign_id}"
    base = (os.environ.get("NEXTAUTH_URL") or "https://erp.example.com").rstrip("/")
    return f"{base}/api/marketing/track/open/{campaign_id}"


def _public_base(request: Optional[Request]) -> str:
    if request is not None:
        proto = request.headers.get("x-forwarded-proto", "https")
        host = request.headers.get("x-forwarded-host", request.headers.get("host", ""))
        return f"{proto}://{host}"
    return (os.environ.get("NEXTAUTH_URL") or "https://erp.example.com").rstrip("/")


def _unsubscribe_url(request: Optional[Request], send_id: str) -> str:
    return f"{_public_base(request)}/api/marketing/unsubscribe/{send_id}"


def _append_compliance_footer(html: str, plain: str, campaign: dict, unsubscribe_url: str) -> tuple[str, str]:
    business = (campaign.get("business_name") or "").strip()
    address = (campaign.get("business_address") or "").strip()
    footer_plain = (
        f"\n\n--\n{business}\n{address}\n"
        f"Unsubscribe: {unsubscribe_url}"
    )
    footer_html = f"""
<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.5;font-family:Arial,sans-serif">
  <div>{escape_html(business)}</div>
  <div>{escape_html(address).replace(chr(10), "<br>")}</div>
  <div style="margin-top:8px"><a href="{escape_html(unsubscribe_url)}" style="color:#2563eb">Unsubscribe</a></div>
</div>
"""
    if "</body>" in html.lower():
        html = re.sub(r"</body>", footer_html + "</body>", html, flags=re.IGNORECASE)
    else:
        html += footer_html
    return html, plain + footer_plain


def escape_html(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _send_post_now(post_id: str, request: Optional[Request] = None) -> dict:
    """Send one scheduled campaign post via Gmail and update post/campaign stats."""
    import base64 as _b64
    import uuid as _uuid
    from email.mime.multipart import MIMEMultipart as _MIMEMulti
    from email.mime.text import MIMEText as _MIMEText

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT p.*, c.user_id, c.recipient_list,
                      p.list_ids AS post_list_ids, c.list_ids AS campaign_list_ids,
                      c.list_id, c.campaign_id,
                      COALESCE(t.sender_name, c.sender_name) AS sender_name,
                      COALESCE(t.sender_email, c.sender_email) AS sender_email,
                      COALESCE(t.reply_to, c.reply_to) AS reply_to,
                      COALESCE(t.business_name, c.business_name) AS business_name,
                      COALESCE(t.business_address, c.business_address) AS business_address,
                      TRUE AS unsubscribe_enabled
               FROM campaign_posts p
               JOIN email_campaigns c ON c.campaign_id = p.campaign_id
               LEFT JOIN campaign_templates t ON t.template_id = COALESCE(p.template_id, c.template_id)
               WHERE p.post_id = %s::uuid""",
            [post_id],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        post = _campaign_post_row(row)
        # Use post-level list_ids if set, otherwise fall back to campaign-level
        post_lists = _parse_uuid_array(post.get("post_list_ids"))
        camp_lists = _parse_uuid_array(post.get("campaign_list_ids"))
        post["list_ids"] = post_lists if post_lists else camp_lists
    finally:
        conn.close()

    if not post.get("subject"):
        raise HTTPException(status_code=400, detail="Subject is required")
    if post.get("unsubscribe_enabled") and not (post.get("business_name") and post.get("business_address")):
        raise HTTPException(status_code=400, detail="Business name and postal address are required for marketing sends")

    user_id = str(post["user_id"])
    campaign_id = str(post["campaign_id"])
    token = _get_token(user_id)
    recipients = _resolve_campaign_recipients(post)
    if not recipients:
        raise HTTPException(status_code=400, detail="No recipients found")

    track_base = _tracking_base(request, campaign_id)
    sent = 0
    failed: list[str] = []

    for recipient in recipients:
        send_id = str(_uuid.uuid4())
        email = recipient["email"]
        contact_id = recipient.get("contact_id")

        msg = _MIMEMulti("alternative")
        msg["To"] = email
        msg["Subject"] = post["subject"]
        if post.get("sender_name") and post.get("sender_email"):
            msg["From"] = f"{post['sender_name']} <{post['sender_email']}>"
        elif post.get("sender_email"):
            msg["From"] = post["sender_email"]
        if post.get("reply_to"):
            msg["Reply-To"] = post["reply_to"]

        plain = post.get("body") or ""
        html = post.get("body_html")
        if not html:
            esc = plain.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")
            html = f"<p>{esc}</p>"
        html = _inline_images(html)
        if post.get("unsubscribe_enabled"):
            unsub_url = _unsubscribe_url(request, send_id)
            msg["List-Unsubscribe"] = f"<{unsub_url}>"
            msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
            html, plain = _append_compliance_footer(html, plain, post, unsub_url)
        msg.attach(_MIMEText(plain, "plain", "utf-8"))
        pixel = (
            f'<img src="{track_base}/{send_id}.gif" '
            f'width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">'
        )
        msg.attach(_MIMEText(html + pixel, "html", "utf-8"))

        raw = _b64.urlsafe_b64encode(msg.as_bytes()).decode()
        r = httpx.post(
            GMAIL_SEND_URL,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"raw": raw},
            timeout=20,
        )
        if r.status_code in (200, 201):
            sent += 1
            gmail_id = r.json().get("id")
            conn = _conn()
            try:
                cur = conn.cursor()
                cur.execute(
                    """INSERT INTO campaign_sends
                           (send_id, campaign_id, post_id, recipient_email, contact_id, gmail_message_id)
                       VALUES (%s::uuid, %s::uuid, %s::uuid, %s, %s, %s)""",
                    [send_id, campaign_id, post_id, email, contact_id, gmail_id],
                )
                conn.commit()
            finally:
                conn.close()
        else:
            failed.append(email)

    final_status = "sent" if sent > 0 else "failed"
    error_msg = f"Failed for: {', '.join(failed)}" if failed else None
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """UPDATE campaign_posts
               SET status=%s, sent_at=NOW(), sent_count=%s, error_message=%s, updated_at=NOW()
               WHERE post_id=%s::uuid""",
            [final_status, sent, error_msg, post_id],
        )
        cur.execute(
            """UPDATE email_campaigns
               SET status = CASE
                       WHEN EXISTS (SELECT 1 FROM campaign_posts WHERE campaign_id=%s::uuid AND status='scheduled') THEN 'scheduled'
                       WHEN EXISTS (SELECT 1 FROM campaign_posts WHERE campaign_id=%s::uuid AND status='failed') THEN 'failed'
                       WHEN EXISTS (SELECT 1 FROM campaign_posts WHERE campaign_id=%s::uuid AND status='sent') THEN 'sent'
                       ELSE status
                   END,
                   sent_at = COALESCE(sent_at, NOW()),
                   sent_count = COALESCE((SELECT SUM(sent_count) FROM campaign_posts WHERE campaign_id=%s::uuid), 0),
                   open_count = COALESCE((SELECT SUM(open_count) FROM campaign_posts WHERE campaign_id=%s::uuid), 0),
                   updated_at = NOW()
               WHERE campaign_id=%s::uuid""",
            [campaign_id, campaign_id, campaign_id, campaign_id, campaign_id, campaign_id],
        )
        conn.commit()
    finally:
        conn.close()

    return {"sent": sent, "failed": len(failed), "status": final_status}


@router.get("/campaigns/{campaign_id}/posts")
def list_campaign_posts(campaign_id: str, request: Request):
    user_id = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT p.*
               FROM campaign_posts p
               JOIN email_campaigns c ON c.campaign_id = p.campaign_id
               WHERE p.campaign_id = %s::uuid
               ORDER BY COALESCE(p.scheduled_at, p.created_at), p.created_at""",
            [campaign_id],
        )
        return [_campaign_post_row(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/campaigns/{campaign_id}/posts", status_code=201)
def create_campaign_post(campaign_id: str, body: CampaignPostCreate, request: Request):
    user_id = _require_user(request)
    scheduled_at = _parse_optional_dt(body.scheduled_at)
    status = "scheduled" if scheduled_at else "draft"
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT 1 FROM email_campaigns WHERE campaign_id=%s::uuid",
            [campaign_id],
        )
        if not cur.fetchone():
            raise HTTPException(status_code=404)
        import json as _json
        list_ids_arr = "{" + ",".join(body.list_ids) + "}" if body.list_ids else "{}"
        cur.execute(
            """INSERT INTO campaign_posts
                   (campaign_id, template_id, title, subject, body, body_html, status, scheduled_at, list_ids)
               VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s::uuid[])
               RETURNING *""",
            [campaign_id, body.template_id, body.title, body.subject, body.body, body.body_html, status, scheduled_at, list_ids_arr],
        )
        row = _campaign_post_row(cur.fetchone())
        if scheduled_at:
            cur.execute("UPDATE email_campaigns SET status='scheduled', updated_at=NOW() WHERE campaign_id=%s::uuid", [campaign_id])
        conn.commit()
        return row
    finally:
        conn.close()


@router.patch("/campaigns/{campaign_id}/posts/{post_id}")
def update_campaign_post(campaign_id: str, post_id: str, body: CampaignPostUpdate, request: Request):
    user_id = _require_user(request)
    updates = {k: v for k, v in body.dict(exclude_unset=True).items()}
    if "scheduled_at" in updates:
        updates["scheduled_at"] = _parse_optional_dt(updates["scheduled_at"])
        if "status" not in updates:
            updates["status"] = "scheduled" if updates["scheduled_at"] else "draft"
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    conn = _conn()
    try:
        cur = conn.cursor()
        set_parts = []
        vals = []
        for k, v in updates.items():
            if k == "template_id":
                set_parts.append("template_id = %s::uuid")
            elif k == "list_ids":
                set_parts.append("list_ids = %s::uuid[]")
                v = "{" + ",".join(v or []) + "}"
            else:
                set_parts.append(f"{k} = %s")
            vals.append(v)
        vals += [post_id, campaign_id]
        cur.execute(
            f"""UPDATE campaign_posts p
                SET {', '.join(set_parts)}, updated_at=NOW()
                WHERE p.post_id=%s::uuid AND p.campaign_id=%s::uuid
                RETURNING p.*""",
            vals,
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        conn.commit()
        return _campaign_post_row(row)
    finally:
        conn.close()


@router.delete("/campaigns/{campaign_id}/posts/{post_id}")
def delete_campaign_post(campaign_id: str, post_id: str, request: Request):
    user_id = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM campaign_posts WHERE post_id=%s::uuid AND campaign_id=%s::uuid",
            [post_id, campaign_id],
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/campaigns/{campaign_id}/posts/{post_id}/send")
def send_campaign_post(campaign_id: str, post_id: str, request: Request):
    _require_user(request)
    return _send_post_now(post_id, request)


@router.post("/campaigns/{campaign_id}/posts/{post_id}/schedule")
def schedule_campaign_post(campaign_id: str, post_id: str, body: ScheduleRequest, request: Request):
    return update_campaign_post(
        campaign_id,
        post_id,
        CampaignPostUpdate(scheduled_at=body.scheduled_at, status="scheduled"),
        request,
    )


@router.post("/campaigns/{campaign_id}/posts/{post_id}/send-test")
def send_test_campaign_post(campaign_id: str, post_id: str, request: Request):
    """Send a post test email to the authenticated user's own Gmail address."""
    import base64 as _b64
    from email.mime.multipart import MIMEMultipart as _MIMEMulti
    from email.mime.text import MIMEText as _MIMEText

    user_id = _require_user(request)
    token = _get_token(user_id)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM campaign_posts WHERE post_id=%s::uuid AND campaign_id=%s::uuid",
            [post_id, campaign_id],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        post = _row_dict(row)
        cur.execute("SELECT google_email FROM google_oauth_tokens WHERE user_id = %s", [user_id])
        tok_row = cur.fetchone()
        if not tok_row:
            raise HTTPException(status_code=400, detail="No Gmail account connected")
        user_email = tok_row["google_email"]
    finally:
        conn.close()

    msg = _MIMEMulti("alternative")
    msg["To"] = user_email
    msg["Subject"] = f"[TEST] {post['subject']}"
    plain = (post.get("body") or "") + "\n\n-- Test send --"
    msg.attach(_MIMEText(plain, "plain", "utf-8"))
    html = _inline_images(post.get("body_html") or f"<p>{plain}</p>")
    msg.attach(_MIMEText(html + '<p style="color:#aaa;font-size:11px;margin-top:24px">-- Test send --</p>', "html", "utf-8"))

    raw = _b64.urlsafe_b64encode(msg.as_bytes()).decode()
    r = httpx.post(
        GMAIL_SEND_URL,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"raw": raw},
        timeout=20,
    )
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail="Gmail send failed")
    return {"sent_to": user_email}


def _unsubscribe_send(send_id: str, reason: str = "unsubscribe") -> dict:
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT s.recipient_email, s.contact_id, s.campaign_id, s.post_id,
                      c.user_id, c.list_id
               FROM campaign_sends s
               JOIN email_campaigns c ON c.campaign_id = s.campaign_id
               WHERE s.send_id=%s::uuid""",
            [send_id],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        cur.execute(
            """INSERT INTO campaign_unsubscribes
                   (user_id, email, contact_id, list_id, campaign_id, post_id, reason)
               VALUES (%s::uuid, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (user_id, lower(email))
               DO UPDATE SET unsubscribed_at=NOW(),
                             contact_id=COALESCE(EXCLUDED.contact_id, campaign_unsubscribes.contact_id),
                             list_id=COALESCE(EXCLUDED.list_id, campaign_unsubscribes.list_id),
                             campaign_id=EXCLUDED.campaign_id,
                             post_id=EXCLUDED.post_id,
                             reason=EXCLUDED.reason
               RETURNING email""",
            [
                row["user_id"], row["recipient_email"], row["contact_id"], row["list_id"],
                row["campaign_id"], row["post_id"], reason,
            ],
        )
        email = cur.fetchone()["email"]
        conn.commit()
        return {"ok": True, "email": email}
    finally:
        conn.close()


@router.get("/unsubscribe/{send_id}")
def unsubscribe_page(send_id: str):
    result = _unsubscribe_send(send_id)
    html = f"""<!doctype html><html><body style="font-family:Arial,sans-serif;padding:40px;color:#111827">
<h1 style="font-size:22px">You are unsubscribed</h1>
<p>{escape_html(result["email"])} will no longer receive marketing emails from this sender.</p>
</body></html>"""
    return Response(content=html, media_type="text/html")


@router.post("/unsubscribe/{send_id}")
def unsubscribe_one_click(send_id: str):
    return _unsubscribe_send(send_id, "one-click")


@router.post("/campaigns/{campaign_id}/schedule")
def schedule_campaign(campaign_id: str, body: ScheduleRequest, request: Request):
    user_id = _require_user(request)
    try:
        scheduled_dt = datetime.fromisoformat(body.scheduled_at.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid scheduled_at datetime")
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE email_campaigns SET status='scheduled', scheduled_at=%s, updated_at=NOW() "
            "WHERE campaign_id=%s::uuid RETURNING *",
            [scheduled_dt, campaign_id],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        conn.commit()
        return _row_dict(row)
    finally:
        conn.close()


@router.post("/campaigns/{campaign_id}/send")
def send_campaign(campaign_id: str, request: Request):
    """Send a campaign immediately via Gmail to all recipients (HTML + open tracking)."""
    import base64 as _b64
    import uuid as _uuid
    from email.mime.multipart import MIMEMultipart as _MIMEMulti
    from email.mime.text import MIMEText as _MIMEText

    user_id = _require_user(request)
    token = _get_token(user_id)

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM email_campaigns WHERE campaign_id = %s::uuid",
            [campaign_id],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        campaign = _row_dict(row)
    finally:
        conn.close()

    if not campaign["subject"]:
        raise HTTPException(status_code=400, detail="Subject is required")

    # Resolve recipients from raw list + contact lists
    recipients: list[dict] = []
    for email in (campaign["recipient_list"] or []):
        if "@" in email:
            recipients.append({"email": email, "contact_id": None})

    list_ids = campaign.get("list_ids") or []
    if list_ids:
        conn = _conn()
        try:
            cur = conn.cursor()
            for lid in list_ids:
                cur.execute(
                    """SELECT COALESCE(lc.selected_email, c.email) AS email, c.contact_id
                       FROM campaign_list_contacts lc
                       JOIN contacts c ON c.contact_id = lc.contact_id
                       WHERE lc.list_id = %s::uuid AND NOT c.archived
                         AND (lc.selected_email IS NOT NULL
                              OR (c.email IS NOT NULL AND c.email != ''))""",
                    [lid],
                )
                for r in cur.fetchall():
                    recipients.append({"email": r["email"], "contact_id": str(r["contact_id"])})
        finally:
            conn.close()

    # Deduplicate by email
    seen: set[str] = set()
    deduped = []
    for r in recipients:
        key = r["email"].lower()
        if key not in seen:
            seen.add(key)
            deduped.append(r)
    recipients = deduped

    if not recipients:
        raise HTTPException(status_code=400, detail="No recipients found")

    # Build tracking base URL from forwarded headers
    proto = request.headers.get("x-forwarded-proto", "https")
    host = request.headers.get("x-forwarded-host", request.headers.get("host", ""))
    track_base = f"{proto}://{host}/api/marketing/track/open/{campaign_id}"

    sent = 0
    failed: list[str] = []

    for recipient in recipients:
        send_id = str(_uuid.uuid4())
        email = recipient["email"]
        contact_id = recipient.get("contact_id")

        msg = _MIMEMulti("alternative")
        msg["To"] = email
        msg["Subject"] = campaign["subject"]

        plain = campaign.get("body") or ""
        msg.attach(_MIMEText(plain, "plain", "utf-8"))

        if campaign.get("body_html"):
            html = _inline_images(campaign["body_html"])
        else:
            esc = plain.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")
            html = f"<p>{esc}</p>"

        pixel = (
            f'<img src="{track_base}/{send_id}.gif" '
            f'width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">'
        )
        msg.attach(_MIMEText(html + pixel, "html", "utf-8"))

        raw = _b64.urlsafe_b64encode(msg.as_bytes()).decode()
        r = httpx.post(
            GMAIL_SEND_URL,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"raw": raw},
            timeout=20,
        )
        if r.status_code in (200, 201):
            sent += 1
            gmail_id = r.json().get("id")
            conn = _conn()
            try:
                cur = conn.cursor()
                cur.execute(
                    """INSERT INTO campaign_sends
                           (send_id, campaign_id, recipient_email, contact_id, gmail_message_id)
                       VALUES (%s::uuid, %s::uuid, %s, %s, %s)""",
                    [send_id, campaign_id, email, contact_id, gmail_id],
                )
                conn.commit()
            finally:
                conn.close()
        else:
            failed.append(email)

    final_status = "sent" if sent > 0 else "failed"
    error_msg = f"Failed for: {', '.join(failed)}" if failed else None

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE email_campaigns SET status=%s, sent_at=NOW(), sent_count=%s, "
            "error_message=%s, updated_at=NOW() WHERE campaign_id=%s::uuid",
            [final_status, sent, error_msg, campaign_id],
        )
        conn.commit()
    finally:
        conn.close()

    return {"sent": sent, "failed": len(failed), "status": final_status}


@router.post("/campaigns/{campaign_id}/send-test")
def send_test_campaign(campaign_id: str, request: Request):
    """Send a test email to the authenticated user's own Gmail address."""
    import base64 as _b64
    from email.mime.multipart import MIMEMultipart as _MIMEMulti
    from email.mime.text import MIMEText as _MIMEText

    user_id = _require_user(request)
    token = _get_token(user_id)

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM email_campaigns WHERE campaign_id = %s::uuid",
            [campaign_id],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        campaign = _row_dict(row)
        cur.execute("SELECT google_email FROM google_oauth_tokens WHERE user_id = %s", [user_id])
        tok_row = cur.fetchone()
        if not tok_row:
            raise HTTPException(status_code=400, detail="No Gmail account connected")
        user_email = tok_row["google_email"]
    finally:
        conn.close()

    msg = _MIMEMulti("alternative")
    msg["To"] = user_email
    msg["Subject"] = f"[TEST] {campaign['subject']}"

    plain = (campaign.get("body") or "") + "\n\n— Test send —"
    msg.attach(_MIMEText(plain, "plain", "utf-8"))

    if campaign.get("body_html"):
        html = _inline_images(campaign["body_html"]) + '<p style="color:#aaa;font-size:11px;margin-top:24px">— Test send —</p>'
    else:
        esc = plain.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")
        html = f"<p>{esc}</p>"
    msg.attach(_MIMEText(html, "html", "utf-8"))

    raw = _b64.urlsafe_b64encode(msg.as_bytes()).decode()
    r = httpx.post(
        GMAIL_SEND_URL,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"raw": raw},
        timeout=20,
    )
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail="Gmail send failed")

    return {"sent_to": user_email}


@router.get("/campaigns/{campaign_id}/stats")
def get_campaign_stats(campaign_id: str, request: Request):
    user_id = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM email_campaigns WHERE campaign_id = %s::uuid",
            [campaign_id],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        campaign = _row_dict(row)

        cur.execute(
            """SELECT s.send_id, s.recipient_email, s.contact_id, s.sent_at,
                      s.open_count, s.first_opened_at, c.name AS contact_name
               FROM campaign_sends s
               LEFT JOIN contacts c ON c.contact_id = s.contact_id
               WHERE s.campaign_id = %s::uuid
               ORDER BY s.sent_at""",
            [campaign_id],
        )
        sends = [_row_dict(r) for r in cur.fetchall()]
        open_rate = round(campaign["open_count"] / campaign["sent_count"] * 100, 1) if campaign["sent_count"] else 0
        return {"campaign": campaign, "sends": sends, "open_rate": open_rate}
    finally:
        conn.close()


# ── Open Tracking ──────────────────────────────────────────────────────────────

_TRACKING_PIXEL = bytes([
    0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00,0x80,0x00,0x00,
    0xff,0xff,0xff,0x00,0x00,0x00,0x21,0xf9,0x04,0x00,0x00,0x00,0x00,0x00,
    0x2c,0x00,0x00,0x00,0x00,0x01,0x00,0x01,0x00,0x00,0x02,0x02,0x44,0x01,0x00,0x3b,
])


@router.get("/track/open/{campaign_id}/{send_id}.gif", include_in_schema=False)
def track_open(campaign_id: str, send_id: str):
    """Record email open and return 1×1 transparent GIF."""
    try:
        conn = _conn()
        try:
            cur = conn.cursor()
            cur.execute(
                "INSERT INTO campaign_events (send_id, event_type) VALUES (%s::uuid, 'open')",
                [send_id],
            )
            cur.execute(
                """UPDATE campaign_sends
                   SET open_count = open_count + 1,
                       first_opened_at = COALESCE(first_opened_at, NOW())
                   WHERE send_id = %s::uuid""",
                [send_id],
            )
            cur.execute(
                """UPDATE campaign_posts
                   SET open_count = (
                       SELECT COUNT(*) FROM campaign_sends
                       WHERE post_id = campaign_posts.post_id AND open_count > 0
                   )
                   WHERE post_id = (SELECT post_id FROM campaign_sends WHERE send_id = %s::uuid)""",
                [send_id],
            )
            cur.execute(
                """UPDATE email_campaigns
                   SET open_count = (
                       SELECT COUNT(*) FROM campaign_sends
                       WHERE campaign_id = %s::uuid AND open_count > 0
                   )
                   WHERE campaign_id = %s::uuid""",
                [campaign_id, campaign_id],
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass
    return Response(
        content=_TRACKING_PIXEL,
        media_type="image/gif",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"},
    )


# ── Campaign Lists ─────────────────────────────────────────────────────────────

class ListCreate(BaseModel):
    name: str
    description: Optional[str] = None


class ListUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


@router.get("/campaign-lists")
def list_campaign_lists(request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT l.*,
                 (COUNT(DISTINCT lc.contact_id) + COUNT(DISTINCT le.id))::int AS contact_count
               FROM campaign_lists l
               LEFT JOIN campaign_list_contacts lc USING (list_id)
               LEFT JOIN campaign_list_emails le USING (list_id)
               GROUP BY l.list_id
               ORDER BY l.created_at DESC"""
        )
        return [_row_dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.post("/campaign-lists", status_code=201)
def create_campaign_list(body: ListCreate, request: Request):
    user_id = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO campaign_lists (user_id, name, description) VALUES (%s::uuid, %s, %s) RETURNING *",
            [user_id, body.name, body.description],
        )
        row = _row_dict(cur.fetchone())
        conn.commit()
        row["contact_count"] = 0
        return row
    finally:
        conn.close()


@router.patch("/campaign-lists/{list_id}")
def update_campaign_list(list_id: str, body: ListUpdate, request: Request):
    user_id = _require_user(request)
    updates = {k: v for k, v in body.dict(exclude_unset=True).items()}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    conn = _conn()
    try:
        cur = conn.cursor()
        sets = ", ".join(f"{k} = %s" for k in updates)
        vals = list(updates.values()) + [list_id]
        cur.execute(
            f"UPDATE campaign_lists SET {sets}, updated_at = NOW() "
            f"WHERE list_id = %s::uuid RETURNING *",
            vals,
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        conn.commit()
        return _row_dict(row)
    finally:
        conn.close()


@router.delete("/campaign-lists/{list_id}")
def delete_campaign_list(list_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM campaign_lists WHERE list_id = %s::uuid",
            [list_id],
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.get("/campaign-lists/{list_id}/contacts")
def get_list_contacts(list_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        # Contacts linked by contact record
        cur.execute(
            """SELECT c.contact_id::text, c.name, c.email, c.organization, c.title, c.tags,
                      lc.added_at, lc.selected_email
               FROM campaign_list_contacts lc
               JOIN contacts c ON c.contact_id = lc.contact_id
               WHERE lc.list_id = %s::uuid AND NOT c.archived
               ORDER BY c.name""",
            [list_id],
        )
        results = []
        for row in cur.fetchall():
            d = _row_dict(row)
            d["send_email"] = d.get("selected_email") or d.get("email")
            results.append(d)
        # Raw email entries (no contact record)
        cur.execute(
            "SELECT id::text AS contact_id, email, added_at FROM campaign_list_emails WHERE list_id = %s::uuid ORDER BY added_at",
            [list_id],
        )
        for row in cur.fetchall():
            d = _row_dict(row)
            d["name"] = d["email"]
            d["organization"] = None
            d["title"] = None
            d["tags"] = []
            d["send_email"] = d["email"]
            results.append(d)
        return results
    finally:
        conn.close()


@router.post("/campaign-lists/{list_id}/import-csv")
async def import_csv_to_list(list_id: str, request: Request, file: UploadFile = File(...)):
    """Parse a CSV file and bulk-add all valid email addresses to the list."""
    _require_user(request)
    import csv, io
    content = await file.read()
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))

    # Find the email column (case-insensitive)
    rows = list(reader)
    if not rows:
        raise HTTPException(status_code=400, detail="CSV is empty")
    headers = list(rows[0].keys())
    email_col = next((h for h in headers if h.strip().lower() == "email"), None)
    if not email_col:
        raise HTTPException(status_code=400, detail=f"No 'Email' column found. Columns: {headers[:8]}")

    emails = []
    for row in rows:
        raw = (row.get(email_col) or "").strip().lower()
        if raw and "@" in raw and "." in raw.split("@")[-1]:
            emails.append(raw)

    if not emails:
        raise HTTPException(status_code=400, detail="No valid email addresses found in CSV")

    conn = _conn()
    try:
        cur = conn.cursor()
        added = 0
        for email in emails:
            # Try to match an existing contact first
            cur.execute(
                "SELECT contact_id::text FROM contacts WHERE LOWER(email) = %s AND NOT archived LIMIT 1",
                [email],
            )
            contact = cur.fetchone()
            if contact:
                cur.execute(
                    """INSERT INTO campaign_list_contacts (list_id, contact_id)
                       VALUES (%s::uuid, %s::uuid) ON CONFLICT DO NOTHING""",
                    [list_id, contact["contact_id"]],
                )
            else:
                cur.execute(
                    "INSERT INTO campaign_list_emails (list_id, email) VALUES (%s::uuid, %s) ON CONFLICT DO NOTHING",
                    [list_id, email],
                )
            added += cur.rowcount
        conn.commit()
        return {"added": added, "total": len(emails), "skipped": len(emails) - added}
    finally:
        conn.close()


@router.post("/campaign-lists/{list_id}/contacts")
def add_contacts_to_list(list_id: str, body: dict, request: Request):
    """Accept {contacts: [{contact_id, email}]} or legacy {contact_ids: [...]}."""
    _require_user(request)
    # Normalise inputs — contact_id may be None for raw email entries
    entries: list[tuple[Optional[str], Optional[str]]] = []
    for c in body.get("contacts", []):
        entries.append((c.get("contact_id"), c.get("email")))
    for cid in body.get("contact_ids", []):
        entries.append((cid, None))
    tag: Optional[str] = body.get("tag")

    conn = _conn()
    try:
        cur = conn.cursor()
        if tag:
            cur.execute(
                "SELECT contact_id FROM contacts WHERE %s = ANY(tags) AND NOT archived",
                [tag],
            )
            for r in cur.fetchall():
                entries.append((str(r["contact_id"]), None))
        added = 0
        for cid, email in entries:
            if cid:
                # Contact record exists — insert into campaign_list_contacts
                cur.execute(
                    """INSERT INTO campaign_list_contacts (list_id, contact_id, selected_email)
                       VALUES (%s::uuid, %s::uuid, %s)
                       ON CONFLICT (list_id, contact_id) DO UPDATE
                       SET selected_email = COALESCE(EXCLUDED.selected_email, campaign_list_contacts.selected_email)""",
                    [list_id, cid, email],
                )
            elif email and "@" in email:
                # Raw email with no contact record
                cur.execute(
                    "INSERT INTO campaign_list_emails (list_id, email) VALUES (%s::uuid, %s) ON CONFLICT DO NOTHING",
                    [list_id, email.strip().lower()],
                )
            added += cur.rowcount
        conn.commit()
        return {"added": added}
    finally:
        conn.close()


@router.delete("/campaign-lists/{list_id}/contacts/{contact_id}")
def remove_contact_from_list(list_id: str, contact_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        # Try contact record first, then raw email entry
        cur.execute(
            "DELETE FROM campaign_list_contacts WHERE list_id = %s::uuid AND contact_id = %s::uuid",
            [list_id, contact_id],
        )
        if cur.rowcount == 0:
            cur.execute(
                "DELETE FROM campaign_list_emails WHERE list_id = %s::uuid AND id = %s::uuid",
                [list_id, contact_id],
            )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.get("/campaign-contacts-search")
def search_contacts_for_campaigns(
    request: Request,
    q: str = Query(""),
    tags: str = Query(""),
):
    """Search contacts for adding to campaign lists. Returns all emails per contact."""
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        conditions = [
            "NOT c.archived",
            "c.email IS NOT NULL AND c.email != ''",
        ]
        params: list = []
        if q:
            like = f"%{q.lower()}%"
            conditions.append(
                "(LOWER(c.name) LIKE %s OR LOWER(COALESCE(c.email,'')) LIKE %s "
                "OR LOWER(COALESCE(c.organization,'')) LIKE %s)"
            )
            params += [like, like, like]
        if tags:
            for tag in [t.strip() for t in tags.split(",") if t.strip()]:
                conditions.append("%s = ANY(c.tags)")
                params.append(tag)
        where = " AND ".join(conditions)
        cur.execute(
            f"SELECT c.contact_id, c.name, c.email, c.organization, c.title, c.tags "
            f"FROM contacts c WHERE {where} ORDER BY c.name LIMIT 100",
            params,
        )
        rows = cur.fetchall()
        results = []
        for row in rows:
            d = _row_dict(row)
            d["emails"] = [{"email": d["email"], "label": "work", "is_primary": True}]
            results.append(d)
        return results
    finally:
        conn.close()


# ── Brand Assets ───────────────────────────────────────────────────────────────

@router.delete("/brand-assets/{file_id}")
def delete_brand_asset(file_id: str, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "DELETE FROM marketing_brand_files WHERE id=%s RETURNING stored_name",
            [file_id],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404)
        conn.commit()
    finally:
        conn.close()

    path = os.path.join(BRAND_UPLOAD_DIR, row["stored_name"])
    try:
        os.remove(path)
    except FileNotFoundError:
        pass

    return {"ok": True}


# ── Assets: a Drive folder as the source of truth ────────────────────────────
#
# The module holds no files. An attached Drive folder is listed live, and the
# database records only what Drive cannot: which file fills which role, and any
# description written for it. Other modules ask for a role and are handed
# whatever file currently fills it.

ASSET_MIMES = {
    "application/pdf":  "PDF",
    "image/png":        "PNG",
    "image/jpeg":       "JPG",
    "image/svg+xml":    "SVG",
    "image/webp":       "WEBP",
    "image/gif":        "GIF",
}

FOLDER_MIME = "application/vnd.google-apps.folder"


def _marketing_folder(cur) -> dict:
    cur.execute(
        "SELECT assets_folder_id, assets_folder_name FROM marketing_settings LIMIT 1"
    )
    row = cur.fetchone()
    return dict(row) if row else {"assets_folder_id": None, "assets_folder_name": None}


def _drive_list(token: str, folder_id: str) -> list[dict]:
    """Files directly inside a folder, newest first."""
    r = httpx.get(
        DRIVE_FILES_URL,
        headers={"Authorization": f"Bearer {token}"},
        params={
            "q": f"'{folder_id}' in parents and trashed = false",
            "fields": "files(id,name,mimeType,size,modifiedTime,webViewLink)",
            "orderBy": "modifiedTime desc",
            "pageSize": 200,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        },
        timeout=20,
    )
    if r.status_code != 200:
        logger.warning("Marketing Drive list failed: %s", r.text[:200])
        raise HTTPException(status_code=502, detail="Could not read the Drive folder")
    return r.json().get("files", [])


class AssetsFolderBody(BaseModel):
    folder_url: Optional[str] = None


def _folder_id_from(value: str) -> str:
    """Accept a Drive URL or a bare id."""
    value = (value or "").strip()
    m = re.search(r"/folders/([A-Za-z0-9_-]+)", value)
    if m:
        return m.group(1)
    m = re.search(r"[?&]id=([A-Za-z0-9_-]+)", value)
    if m:
        return m.group(1)
    return value


@router.get("/assets/folder")
def get_assets_folder(request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        return _marketing_folder(cur)
    finally:
        conn.close()


@router.patch("/assets/folder")
def set_assets_folder(body: AssetsFolderBody, request: Request):
    """Attach (or clear) the Drive folder the assets come from."""
    uid = _require_user(request)
    folder_id = _folder_id_from(body.folder_url or "") or None

    name = None
    if folder_id:
        token = _get_token(uid)
        r = httpx.get(
            f"{DRIVE_FILES_URL}/{folder_id}",
            headers={"Authorization": f"Bearer {token}"},
            params={"fields": "id,name,mimeType", "supportsAllDrives": "true"},
            timeout=15,
        )
        if r.status_code != 200:
            raise HTTPException(
                status_code=400,
                detail="Could not open that folder. Check the link and that your Google account has access.",
            )
        meta = r.json()
        if meta.get("mimeType") != FOLDER_MIME:
            raise HTTPException(status_code=400, detail="That link is a file, not a folder")
        name = meta.get("name")

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """UPDATE marketing_settings
               SET assets_folder_id = %s, assets_folder_name = %s, assets_synced_at = NOW()""",
            [folder_id, name],
        )
        if cur.rowcount == 0:
            cur.execute(
                """INSERT INTO marketing_settings (assets_folder_id, assets_folder_name, assets_synced_at)
                   VALUES (%s, %s, NOW())""",
                [folder_id, name],
            )
        conn.commit()
    finally:
        conn.close()
    return {"assets_folder_id": folder_id, "assets_folder_name": name}


@router.get("/assets")
def list_assets(request: Request):
    """Everything in the folder, with its role, description and where it is used."""
    uid = _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        folder = _marketing_folder(cur)
        cur.execute(
            "SELECT role, label, description, position, file_id, file_name, mime_type, updated_at "
            "FROM marketing_asset_roles ORDER BY position, role"
        )
        roles = [dict(r) for r in cur.fetchall()]
        cur.execute("SELECT file_id, description FROM marketing_asset_meta")
        meta = {r["file_id"]: r["description"] for r in cur.fetchall()}
        usage = _role_usage(cur)
    finally:
        conn.close()

    for r in roles:
        r["updated_at"] = _serialize(r.get("updated_at"))
        r["used_by"] = usage.get(r["role"], [])

    if not folder.get("assets_folder_id"):
        return {"folder": folder, "assets": [], "roles": roles, "needs_folder": True}

    token = _get_token(uid)
    files = _drive_list(token, folder["assets_folder_id"])
    by_file: dict[str, list[str]] = {}
    for r in roles:
        if r["file_id"]:
            by_file.setdefault(r["file_id"], []).append(r["role"])

    assets = []
    for f in files:
        if f.get("mimeType") == FOLDER_MIME:
            continue
        if f.get("mimeType") not in ASSET_MIMES:
            continue                      # decks are PDF; the rest are images
        assets.append({
            "file_id":       f["id"],
            "name":          f.get("name"),
            "mime_type":     f.get("mimeType"),
            "kind":          ASSET_MIMES.get(f.get("mimeType"), "File"),
            "size_bytes":    int(f["size"]) if f.get("size") else None,
            "modified_time": f.get("modifiedTime"),
            "web_view_link": f.get("webViewLink"),
            "description":   meta.get(f["id"]),
            "roles":         by_file.get(f["id"], []),
        })

    return {"folder": folder, "assets": assets, "roles": roles, "needs_folder": False}


def _role_usage(cur) -> dict[str, list[dict]]:
    """Which templates and data rooms consume each role."""
    usage: dict[str, list[dict]] = {}

    # Email templates whose attachment specs name a role.
    try:
        cur.execute(
            """SELECT name, attachments FROM email_templates
               WHERE attachments::text LIKE %s""",
            ['%"role"%'],
        )
        for row in cur.fetchall():
            for spec in (row["attachments"] or []):
                role = spec.get("role") if isinstance(spec, dict) else None
                if role:
                    usage.setdefault(role, []).append(
                        {"kind": "Email template", "name": row["name"]}
                    )
    except Exception as exc:
        logger.warning("Template usage lookup failed: %s", exc)

    # Data-room tiles set to mirror roles. A tile may mirror several, and older
    # tiles carry a single `role` key — the LIKE has to admit both spellings,
    # since '%"role"%' does not match '"roles"'.
    try:
        cur.execute(
            """SELECT b.payload, COALESCE(p.name, pp.name) AS room
               FROM portal_room_blocks b
               JOIN project_portals pp ON pp.portal_id = b.portal_id
               LEFT JOIN projects p ON p.project_id = pp.project_id
               WHERE b.block_type = 'docs'
                 AND (b.payload ? 'role' OR b.payload ? 'roles')""",
        )
        for row in cur.fetchall():
            payload = row["payload"] or {}
            roles = payload.get("roles")
            if not isinstance(roles, list):
                single = payload.get("role")
                roles = [single] if single else []
            for role in roles:
                if role:
                    usage.setdefault(role, []).append(
                        {"kind": "Data room", "name": row["room"] or "Data room"}
                    )
    except Exception as exc:
        logger.warning("Portal usage lookup failed: %s", exc)

    return usage


class AssetDescBody(BaseModel):
    description: Optional[str] = None


@router.put("/assets/{file_id}/description")
def set_asset_description(file_id: str, body: AssetDescBody, request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO marketing_asset_meta (file_id, description)
               VALUES (%s, %s)
               ON CONFLICT (file_id) DO UPDATE
                 SET description = EXCLUDED.description, updated_at = NOW()""",
            [file_id, (body.description or "").strip() or None],
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


class RoleCreateBody(BaseModel):
    label: str
    description: Optional[str] = None


def _slug(text: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", (text or "").lower())).strip("-")


@router.post("/roles", status_code=201)
def create_role(body: RoleCreateBody, request: Request):
    """Add a role. The key is derived from the label and is what consumers use."""
    _require_user(request)
    label = (body.label or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="Give the role a name")
    role = _slug(label)
    if not role:
        raise HTTPException(status_code=400, detail="That name has no usable characters")

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM marketing_asset_roles")
        position = cur.fetchone()["next"]
        cur.execute(
            """INSERT INTO marketing_asset_roles (role, label, description, position)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (role) DO NOTHING
               RETURNING role, label, description, position""",
            [role, label, (body.description or "").strip() or None, position],
        )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=409, detail=f"A role named '{role}' already exists")
    return dict(row)


@router.delete("/roles/{role}")
def delete_role(role: str, request: Request):
    """Remove a role, unless something still asks for it."""
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        used = _role_usage(cur).get(role, [])
        if used:
            where = ", ".join(f"{u['name']} ({u['kind'].lower()})" for u in used)
            raise HTTPException(
                status_code=409,
                detail=f"Still used by {where}. Point those elsewhere first.",
            )
        cur.execute("DELETE FROM marketing_asset_roles WHERE role = %s", [role])
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Unknown role")
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


class RoleAssignBody(BaseModel):
    file_id: Optional[str] = None       # null clears the role


@router.put("/roles/{role}")
def assign_role(role: str, body: RoleAssignBody, request: Request):
    """Point a role at a file, or clear it."""
    uid = _require_user(request)
    name = mime = None

    if body.file_id:
        token = _get_token(uid)
        r = httpx.get(
            f"{DRIVE_FILES_URL}/{body.file_id}",
            headers={"Authorization": f"Bearer {token}"},
            params={"fields": "id,name,mimeType", "supportsAllDrives": "true"},
            timeout=15,
        )
        if r.status_code != 200:
            raise HTTPException(status_code=404, detail="That file is not readable")
        meta = r.json()
        name, mime = meta.get("name"), meta.get("mimeType")

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """UPDATE marketing_asset_roles
               SET file_id = %s, file_name = %s, mime_type = %s,
                   updated_at = NOW(), updated_by = %s
               WHERE role = %s
               RETURNING role, label, file_id, file_name, mime_type, updated_at""",
            [body.file_id, name, mime, uid, role],
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Unknown role")
        conn.commit()
    finally:
        conn.close()
    out = dict(row)
    out["updated_at"] = _serialize(out["updated_at"])
    return out


@router.get("/roles")
def list_roles(request: Request):
    _require_user(request)
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT role, label, description, position, file_id, file_name, mime_type, updated_at "
            "FROM marketing_asset_roles ORDER BY position, role"
        )
        rows = [dict(r) for r in cur.fetchall()]
        usage = _role_usage(cur)
    finally:
        conn.close()
    for r in rows:
        r["updated_at"] = _serialize(r.get("updated_at"))
        r["used_by"] = usage.get(r["role"], [])
    return rows


def resolve_role_file(role: str) -> dict | None:
    """The file currently filling a role. Used by other modules; no request context."""
    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT file_id, file_name, mime_type FROM marketing_asset_roles WHERE role = %s",
            [role],
        )
        row = cur.fetchone()
    finally:
        conn.close()
    if not row or not row["file_id"]:
        return None
    return dict(row)


@router.get("/assets/{file_id}/download")
def download_asset(file_id: str, request: Request):
    """Stream an asset out of Drive so it can be downloaded or previewed."""
    uid = _require_user(request)
    token = _get_token(uid)

    meta = httpx.get(
        f"{DRIVE_FILES_URL}/{file_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "name,mimeType", "supportsAllDrives": "true"},
        timeout=15,
    )
    if meta.status_code != 200:
        raise HTTPException(status_code=404, detail="File not found")
    name = meta.json().get("name", "asset")
    mime = meta.json().get("mimeType", "application/octet-stream")

    r = httpx.get(
        f"{DRIVE_FILES_URL}/{file_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"alt": "media", "supportsAllDrives": "true"},
        timeout=120,
    )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="Could not download from Drive")

    return Response(
        content=r.content,
        media_type=mime,
        # Non-ASCII names must not be put in a latin-1 header raw; see RFC 6266.
        headers={
            "Content-Disposition":
                "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (
                    (unicodedata.normalize("NFKD", name).encode("ascii", "ignore")
                     .decode("ascii").replace('"', "").strip() or "download"),
                    urllib.parse.quote(name, safe=""),
                ),
        },
    )
