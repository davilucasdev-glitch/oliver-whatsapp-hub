#!/usr/bin/env bash
# Atualiza o Oliver Hub no servidor: baixa o código novo do GitHub, reconstrói e reinicia.
# As migrations do banco rodam sozinhas (serviço "migrate"). Faz um backup antes.
#   bash /opt/oliver-hub/deploy/atualizar.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Backup antes de atualizar"
mkdir -p backups
f="backups/oliver-hub-antes-de-atualizar-$(date +%Y-%m-%d_%H%M).sql.gz"
docker compose exec -T postgres pg_dump -U oliver -d oliver_hub --no-owner | gzip > "$f" && echo "ok: $f"

echo "== Código novo"
git pull --ff-only

echo "== Reconstruindo e reiniciando"
docker compose --profile https up -d --build --remove-orphans
docker image prune -f >/dev/null

for i in $(seq 1 40); do curl -fsS http://127.0.0.1:3001/health >/dev/null 2>&1 && break; sleep 3; done
curl -fsS http://127.0.0.1:3001/health >/dev/null 2>&1 && echo "API no ar." || { echo "A API não respondeu: docker compose logs --tail 80 api"; exit 1; }
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
