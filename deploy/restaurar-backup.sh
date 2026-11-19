#!/usr/bin/env bash
# Volta o banco para um backup. APAGA o que está no banco agora.
#   bash /opt/oliver-hub/deploy/restaurar-backup.sh backups/oliver-hub-2026-11-19_0300.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."
arq="${1:-}"
[ -f "$arq" ] || { echo "Uso: $0 backups/oliver-hub-AAAA-MM-DD_HHMM.sql.gz"; ls -1t backups/*.sql.gz 2>/dev/null | head -5; exit 1; }
echo "Isto APAGA o banco atual e coloca no lugar o backup $arq."
read -r -p "Digite RESTAURAR para continuar: " ok
[ "$ok" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }

echo "== Cópia de segurança do estado atual"
docker compose exec -T postgres pg_dump -U oliver -d oliver_hub --no-owner | gzip > "backups/oliver-hub-antes-de-restaurar-$(date +%Y-%m-%d_%H%M).sql.gz"

echo "== Parando API, worker e painel"
docker compose stop api worker web

echo "== Restaurando"
docker compose exec -T postgres psql -U oliver -d oliver_hub -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
gunzip -c "$arq" | docker compose exec -T postgres psql -U oliver -d oliver_hub -v ON_ERROR_STOP=1 -q

echo "== Subindo de novo"
docker compose --profile https up -d
echo "Pronto."
