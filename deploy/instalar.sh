#!/usr/bin/env bash
# Instala o Oliver WhatsApp Hub num servidor Ubuntu 22.04/24.04 novo (VPS), como root:
#
#   curl -fsSL https://raw.githubusercontent.com/... (ou copie este arquivo) > instalar.sh
#   sudo bash instalar.sh
#
# O que faz: instala o Docker, liga o firewall (só SSH, 80 e 443), baixa o código do GitHub
# (repositório privado, com uma "deploy key" só de leitura), cria o .env com senhas aleatórias,
# e sobe tudo com HTTPS automático. Pode rodar de novo sem estragar nada (pula o que já existe).
set -euo pipefail

REPO_SSH="${REPO_SSH:-git@github.com:davilucasdev-glitch/oliver-whatsapp-hub.git}"
DIR="${DIR:-/opt/oliver-hub}"
KEY="/root/.ssh/oliver_hub_deploy"

cor() { printf '\n\033[1;35m== %s\033[0m\n' "$*"; }
erro() { printf '\n\033[1;31mERRO: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || erro "rode como root: sudo bash instalar.sh"
command -v apt-get >/dev/null || erro "este instalador é para Ubuntu/Debian"

cor "1/6 Pacotes e Docker"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl >/dev/null
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null || erro "Docker Compose não ficou disponível"
systemctl enable --now docker >/dev/null

cor "2/6 Firewall (SSH, 80 e 443)"
if [ -f /etc/iptables/rules.v4 ] && grep -q 'REJECT' /etc/iptables/rules.v4; then
  # Ubuntu da Oracle Cloud: já vem com iptables fechado e o ufw não deve ser usado (corta o SSH).
  # Abre 80/443 antes da regra de bloqueio e grava. Na Oracle também é preciso liberar 80 e 443
  # na "Security List" da rede, pelo console (ENTRAR-NO-AR.md explica).
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null ||
      iptables -I INPUT 5 -p tcp --dport "$p" -m state --state NEW -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save >/dev/null 2>&1 || iptables-save >/etc/iptables/rules.v4
  echo "Oracle Cloud detectada: portas 80 e 443 abertas no iptables."
else
  apt-get install -y -qq ufw >/dev/null
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  ufw status | sed -n '1,8p'
fi

cor "3/6 Acesso de leitura ao GitHub (deploy key)"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N '' -C "oliver-hub-servidor" -f "$KEY" >/dev/null
fi
cat > /root/.ssh/config.oliver <<EOF
Host github.com
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
grep -q "config.oliver" /root/.ssh/config 2>/dev/null || { echo "Include /root/.ssh/config.oliver" | cat - /root/.ssh/config 2>/dev/null > /root/.ssh/config.new || true; mv /root/.ssh/config.new /root/.ssh/config; }
chmod 600 /root/.ssh/config /root/.ssh/config.oliver
ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null
if [ ! -d "$DIR/.git" ]; then
  echo
  echo "No GitHub: repositório oliver-whatsapp-hub → Settings → Deploy keys → Add deploy key"
  echo "Título: servidor · NÃO marque 'Allow write access' · cole esta chave:"
  echo
  cat "$KEY.pub"
  echo
  read -r -p "Depois de adicionar, aperte Enter para continuar... " _
  git clone -q "$REPO_SSH" "$DIR" || erro "não consegui baixar o código (a deploy key foi adicionada?)"
fi
cd "$DIR"

cor "4/6 Configuração (.env)"
if [ ! -f .env ]; then
  read -r -p "Endereço do painel (ex.: hub.blackfridaydaoliver.com): " DOMAIN
  [ -n "$DOMAIN" ] || erro "informe o endereço"
  read -r -p "E-mail para o certificado HTTPS: " ACME_EMAIL
  PG=$(openssl rand -hex 24)
  cp .env.example .env
  set_env() { # troca (ou acrescenta) CHAVE=valor no .env
    if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
  }
  set_env NODE_ENV production
  set_env DOMAIN "$DOMAIN"
  set_env ACME_EMAIL "$ACME_EMAIL"
  set_env PUBLIC_BASE_URL "https://$DOMAIN"
  set_env PANEL_URL "https://$DOMAIN"
  set_env COOKIE_SECURE true
  set_env POSTGRES_PASSWORD "$PG"
  set_env DATABASE_URL "postgresql://oliver:$PG@postgres:5432/oliver_hub?schema=public"
  set_env QUEUE_DRIVER bullmq
  set_env REDIS_URL redis://redis:6379
  set_env ENCRYPTION_KEY "$(openssl rand -base64 32)"
  set_env SETUP_TOKEN "$(openssl rand -hex 9)"
  set_env META_VERIFY_TOKEN "$(openssl rand -hex 16)"
  chmod 600 .env
  echo ".env criado com senhas aleatórias (fica só neste servidor)."
else
  echo ".env já existe: mantido."
fi
DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)

cor "5/6 Subindo (a primeira vez leva alguns minutos)"
mkdir -p backups
docker compose --profile https up -d --build

cor "6/6 Conferindo"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3001/health >/dev/null 2>&1; then break; fi
  sleep 3
done
curl -fsS http://127.0.0.1:3001/health >/dev/null 2>&1 && echo "API no ar." || echo "A API ainda não respondeu: veja 'docker compose logs api'."
docker compose ps --format 'table {{.Service}}\t{{.Status}}'

cat <<EOF

Pronto. Painel: https://$DOMAIN
(o certificado HTTPS sai sozinho em 1 a 2 minutos, se o DNS de $DOMAIN já aponta para este servidor)

Primeiro acesso: abra o painel e use o código de instalação:
  SETUP_TOKEN = $(grep -E '^SETUP_TOKEN=' .env | cut -d= -f2-)

Webhook para a Meta:
  URL:   https://$DOMAIN/webhook
  Token: $(grep -E '^META_VERIFY_TOKEN=' .env | cut -d= -f2-)

Falta preencher no .env (nano $DIR/.env) e depois rodar: bash $DIR/deploy/atualizar.sh
  META_APP_SECRET, META_APP_ID, META_ACCESS_TOKEN, META_WABA_ID, META_DEFAULT_PHONE_NUMBER_ID
  BLING_CLIENT_ID, BLING_CLIENT_SECRET
  ANTHROPIC_API_KEY
O que ainda falta, em português: bash $DIR/deploy/conferir.sh
EOF
