#!/usr/bin/env python3
"""
Seed the first admin user.

A fresh instance provisions 166 tables and no users, so the login page has
nothing to accept. Run this once against a running instance:

    docker compose exec -T api python3 /app/scripts/create-admin.py \
        --email you@example.com --name "Your Name"

The password is generated and printed unless --password is given. Re-running
with an existing email resets that user's password rather than failing.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import string
import sys

import bcrypt
import psycopg2

ALL_PERMISSIONS = [
    "contacts", "projects", "view_fpa", "edit_fpa", "manage_users", "dev_mode",
    "notes", "invoices", "learn", "manage_partners", "view_activity",
]


def generate_password(n: int = 20) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--name", default="Admin")
    ap.add_argument("--password", default=None)
    args = ap.parse_args()

    password = args.password or generate_password()
    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    perms = {k: True for k in ALL_PERMISSIONS}

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT user_id FROM users WHERE email = %s", (args.email,))
            row = cur.fetchone()
            if row:
                cur.execute(
                    "UPDATE users SET hashed_password=%s, role='admin', is_active=true,"
                    " permissions=%s::jsonb WHERE email=%s",
                    (hashed, json.dumps(perms), args.email),
                )
                action = "password reset for existing user"
            else:
                cur.execute(
                    "INSERT INTO users (email, hashed_password, name, full_name, role,"
                    " is_active, user_type, permissions)"
                    " VALUES (%s,%s,%s,%s,'admin',true,'employee',%s::jsonb)",
                    (args.email, hashed, args.name, args.name, json.dumps(perms)),
                )
                action = "admin created"
        conn.commit()
    finally:
        conn.close()

    print(f"{action}: {args.email}")
    if not args.password:
        print(f"password: {password}")
        print("Sign in, then change it in Settings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
