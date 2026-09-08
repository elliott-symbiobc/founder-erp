#!/usr/bin/env bash
# Fill every empty REQUIRED secret in .env with a fresh random value.
# Existing values are never overwritten, so this is safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "no .env — run: cp .env.example .env" >&2; exit 1; }

fill() {                     # fill VAR "generator"
    local var=$1 value
    if grep -qE "^${var}=.+$" .env; then
        echo "  ${var}: already set, leaving alone"
        return
    fi
    value=$(eval "$2")
    # portable in-place edit: match VAR= with nothing after it
    sed -i "s|^${var}=.*$|${var}=${value}|" .env
    echo "  ${var}: generated"
}

echo "Generating secrets in .env"
fill POSTGRES_PASSWORD      "openssl rand -hex 24"
fill INTERNAL_API_SECRET    "openssl rand -hex 32"
fill NEXTAUTH_SECRET        "openssl rand -hex 32"
fill USER_KEY_SECRET        "openssl rand -hex 32"
echo
echo "Set NEXTAUTH_URL to the address people will visit, then: docker compose up -d"
