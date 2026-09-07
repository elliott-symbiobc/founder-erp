"""Per-user extraction keys, encrypted at rest, injected into that user's kernel.

WHY NOT THE PLATFORM KEY

The kernel runs arbitrary code a user typed, so whatever key it holds can be
printed by a cell. Handing every notebook the platform's own credential means
one careless paste in a shared screen exposes the account everything else runs
on, and a leak cannot be attributed to anyone or revoked without breaking every
other integration.

A per-user key inverts both properties. The blast radius is one person's
account, the usage is attributable on the Anthropic side, and revoking is that
user's problem to fix rather than an outage.

WHAT THIS DOES NOT CLAIM

It does not hide the key from the kernel. That is impossible - a cell can read
os.environ, walk the garbage collector, or re-read any file the process can
reach - and pretending otherwise would be worse than saying it plainly. What it
does is ensure the key a cell can read belongs to the person running the cell.

AT REST

Encrypted with Fernet under a platform secret held only by the API process, so a
database dump does not yield working keys. The plaintext exists in two places
only: the API process at kernel start, and the kernel's own environment.

The stored record keeps a fingerprint - last four characters and a hash - so a
user can confirm WHICH key is stored without the platform ever displaying it
back. A read endpoint that returns the secret is a leak with an audit trail.
"""
from __future__ import annotations

import base64
import hashlib
import os

import psycopg2

TABLE = "user_extract_keys"

DDL = f"""
CREATE TABLE IF NOT EXISTS {TABLE} (
    user_id      uuid PRIMARY KEY,
    key_cipher   text NOT NULL,
    fingerprint  text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);
"""


class KeyStoreUnavailable(RuntimeError):
    """Raised when the platform secret is absent, rather than storing plaintext."""


def _fernet():
    from cryptography.fernet import Fernet

    secret = os.environ.get("USER_KEY_SECRET")
    if not secret:
        # Deriving a key from something else on the box would make the
        # ciphertext decryptable by anyone who could read that something,
        # which is the property encryption is here to remove.
        raise KeyStoreUnavailable(
            "USER_KEY_SECRET is not set; refusing to store keys "
            "unencrypted or under a derived secret")
    digest = hashlib.sha256(secret.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def ensure_table() -> None:
    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(DDL)
    finally:
        conn.close()


def fingerprint(key: str) -> str:
    """Enough to recognise a key, not enough to use one."""
    tail = key.strip()[-4:] if len(key.strip()) >= 4 else "????"
    h = hashlib.sha256(key.strip().encode()).hexdigest()[:8]
    return f"...{tail} ({h})"


def put(user_id: str, key: str) -> dict:
    key = (key or "").strip()
    if not key:
        raise ValueError("key is required")
    if not key.startswith("sk-"):
        # A wrong-shaped value stored silently becomes a mystery failure at
        # extraction time, reported as "no composition stated".
        raise ValueError("that does not look like an API key (expected sk-...)")

    ensure_table()
    cipher = _fernet().encrypt(key.encode()).decode()
    fp = fingerprint(key)
    conn = _conn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""INSERT INTO {TABLE} (user_id, key_cipher, fingerprint)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (user_id) DO UPDATE
                    SET key_cipher = EXCLUDED.key_cipher,
                        fingerprint = EXCLUDED.fingerprint,
                        created_at = now()""",
                (user_id, cipher, fp))
    finally:
        conn.close()
    return {"stored": True, "fingerprint": fp}


def get(user_id: str) -> str | None:
    """The plaintext key, for kernel start only. Never returned over HTTP."""
    if not user_id:
        return None
    try:
        conn = _conn()
    except Exception:
        return None
    try:
        with conn, conn.cursor() as cur:
            cur.execute(f"SELECT key_cipher FROM {TABLE} WHERE user_id = %s",
                        (user_id,))
            row = cur.fetchone()
            if not row:
                return None
            try:
                plain = _fernet().decrypt(row[0].encode()).decode()
            except Exception:
                # A key encrypted under a rotated secret is unusable, and
                # reporting it as absent is honest: it cannot be used.
                return None
            cur.execute(
                f"UPDATE {TABLE} SET last_used_at = now() WHERE user_id = %s",
                (user_id,))
            return plain
    except Exception:
        return None
    finally:
        conn.close()


def status(user_id: str) -> dict:
    """Whether a key is stored and which one — never the key itself."""
    if not user_id:
        return {"stored": False, "reason": "not signed in"}
    try:
        ensure_table()
        conn = _conn()
    except Exception as exc:
        return {"stored": False, "reason": f"key store unavailable: {exc}"}
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""SELECT fingerprint, created_at, last_used_at
                    FROM {TABLE} WHERE user_id = %s""", (user_id,))
            row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return {"stored": False}
    return {"stored": True, "fingerprint": row[0],
            "created_at": row[1].isoformat() if row[1] else None,
            "last_used_at": row[2].isoformat() if row[2] else None}


def delete(user_id: str) -> dict:
    try:
        conn = _conn()
    except Exception as exc:
        return {"deleted": False, "reason": str(exc)}
    try:
        with conn, conn.cursor() as cur:
            cur.execute(f"DELETE FROM {TABLE} WHERE user_id = %s", (user_id,))
            n = cur.rowcount
    finally:
        conn.close()
    return {"deleted": bool(n)}
