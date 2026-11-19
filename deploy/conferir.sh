#!/usr/bin/env bash
# Lista em português o que ainda falta para usar o hub de verdade (.env, Meta, Bling, banco, backup).
#   bash /opt/oliver-hub/deploy/conferir.sh
set -uo pipefail
cd "$(dirname "$0")/.."
docker compose run --rm --no-deps api node dist/scripts/checklist.js
echo
echo "Backups (últimos):"
ls -1t backups/*.sql.gz 2>/dev/null | head -3 || echo "  nenhum backup ainda"
echo
echo "Espaço em disco:"
df -h / | tail -1
