#!/bin/bash
set -euo pipefail

BACKUP_DIR="/opt/backups"
mkdir -p "${BACKUP_DIR}"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTFILE="${BACKUP_DIR}/openerp_${TIMESTAMP}.sql"

docker compose -f /opt/openerp/docker-compose.yml exec -T postgres \
  pg_dump -U openerp openerp > "${OUTFILE}"

# Keep last 30 days; delete older
find "${BACKUP_DIR}" -name "openerp_*.sql" -mtime +30 -delete

echo "Backup complete: ${OUTFILE} ($(du -sh "${OUTFILE}" | cut -f1))"
