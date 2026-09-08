#!/usr/bin/env bash
# Publish a running Founder ERP instance on a domain: install the nginx server
# block, obtain a certificate, reload. Idempotent — safe to re-run.
#
#   ./scripts/setup-host.sh erp.elliottnotrica.com 8110 you@example.com
#
# Requires: the instance already running (docker compose up -d), the domain's
# A record pointing at this host, and certbot with the nginx plugin.
set -euo pipefail

DOMAIN=${1:?usage: setup-host.sh <domain> [port] [email]}
PORT=${2:-8110}
EMAIL=${3:-}

REPO="$(cd "$(dirname "$0")/.." && pwd)"
AVAIL=/etc/nginx/sites-available/founder-erp-${DOMAIN}
ENABLED=/etc/nginx/sites-enabled/founder-erp-${DOMAIN}

# ── 1. the instance must actually be listening ───────────────────────────────
if ! curl -sf -o /dev/null --max-time 10 "http://127.0.0.1:${PORT}/login"; then
    echo "ERROR: nothing serving on 127.0.0.1:${PORT}." >&2
    echo "       Start it first:  docker compose up -d" >&2
    exit 1
fi
echo "instance responding on 127.0.0.1:${PORT}"

# ── 2. DNS must resolve here, or certbot's HTTP-01 challenge cannot pass ─────
HOST_IP=$(curl -s -4 --max-time 10 https://api.ipify.org || true)
DNS_IP=$(dig +short A "$DOMAIN" @1.1.1.1 | tail -1)
if [ -z "$DNS_IP" ]; then
    echo "ERROR: $DOMAIN has no A record. Add one pointing at ${HOST_IP:-this host}." >&2
    exit 1
fi
if [ -n "$HOST_IP" ] && [ "$DNS_IP" != "$HOST_IP" ]; then
    echo "ERROR: $DOMAIN resolves to $DNS_IP, but this host is $HOST_IP." >&2
    echo "       Fix DNS, or wait for propagation, before requesting a certificate." >&2
    exit 1
fi
echo "DNS: $DOMAIN -> $DNS_IP"

# ── 3. install the server block ──────────────────────────────────────────────
sed -e "s|__DOMAIN__|${DOMAIN}|g" -e "s|__PORT__|${PORT}|g" \
    "${REPO}/deploy/nginx/founder-erp.conf.template" > "$AVAIL"
ln -sfn "$AVAIL" "$ENABLED"
nginx -t
systemctl reload nginx
echo "nginx: serving $DOMAIN over http"

# ── 4. certificate ───────────────────────────────────────────────────────────
if [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
    echo "certificate already exists for ${DOMAIN}; leaving it alone"
else
    # Build the account args explicitly: ${EMAIL:-X} substitutes EMAIL itself
    # when it is set, which appends the address a second time as a bare
    # argument and certbot rejects the invocation.
    if [ -n "$EMAIL" ]; then
        acct=(--email "$EMAIL")
    else
        acct=(--register-unsafely-without-email)
    fi
    certbot --nginx -d "$DOMAIN" --redirect --agree-tos --non-interactive "${acct[@]}"
    nginx -t && systemctl reload nginx
fi

echo
echo "Founder ERP is live at https://${DOMAIN}"
echo "Make sure NEXTAUTH_URL in .env matches that exactly, then: docker compose up -d frontend"
