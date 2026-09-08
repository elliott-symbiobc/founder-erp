#!/bin/bash
set -euo pipefail

BACKUP_DIR="/opt/backups"
mkdir -p "${BACKUP_DIR}"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTFILE="${BACKUP_DIR}/founder_${TIMESTAMP}.sql"

docker compose -f /opt/founder-erp/docker-compose.yml exec -T postgres \
  pg_dump -U founder_erp founder_erp > "${OUTFILE}"

# Keep last 30 days; delete older
find "${BACKUP_DIR}" -name "founder_*.sql" -mtime +30 -delete

echo "Backup complete: ${OUTFILE} ($(du -sh "${OUTFILE}" | cut -f1))"
