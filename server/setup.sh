#!/usr/bin/env bash
# Первичная настройка сервера «Генменеджера» на чистой Ubuntu 22.04/24.04.
# Запуск (от root):
#   curl -fsSL https://raw.githubusercontent.com/vinniepuhpuh/shaiba-potolok/main/server/setup.sh -o setup.sh && bash setup.sh [домен]
# Без домена используется бесплатный адрес вида 1-2-3-4.sslip.io.
set -euo pipefail

REPO=https://github.com/vinniepuhpuh/shaiba-potolok.git
DIR=/opt/genmanager
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Запустите от root: sudo bash setup.sh"; exit 1; }

say "Устанавливаю Docker, git и файрвол"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git ufw openssl curl >/dev/null
# Docker: если уже стоит (например, выбран при создании сервера) — не трогаем
if ! docker compose version >/dev/null 2>&1; then apt-get install -y -qq docker.io docker-compose-v2 >/dev/null; fi
mkdir -p /etc/docker
# Зеркало Docker Hub на случай, если прямой доступ медленный или закрыт
[ -f /etc/docker/daemon.json ] || echo '{"registry-mirrors":["https://mirror.gcr.io"]}' > /etc/docker/daemon.json
systemctl enable --now docker >/dev/null
systemctl restart docker

say "Скачиваю код игры"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q; else git clone -q "$REPO" "$DIR"; fi
cd "$DIR/server"

IP=$(curl -fsS4 https://api.ipify.org || curl -fsS4 https://ifconfig.me || hostname -I | awk '{print $1}')
DOMAIN=${1:-}
[ -n "$DOMAIN" ] || DOMAIN="$(echo "$IP" | tr . -).sslip.io"

if [ ! -f .env ]; then
  say "Настройка"
  if [ -z "${BOT_TOKEN:-}" ]; then read -rp "Вставьте токен бота от @BotFather и нажмите Enter: " BOT_TOKEN; fi
  BOT_TOKEN=$(echo "$BOT_TOKEN" | tr -d '[:space:]')
  [[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || { echo "Это не похоже на токен бота"; exit 1; }
  rnd() { openssl rand -hex "$1"; }
  cat > .env <<EOF
DOMAIN=$DOMAIN
BOT_TOKEN=$BOT_TOKEN
DB_PASSWORD=$(rnd 16)
SESSION_SECRET=$(rnd 32)
ADMIN_KEY=$(rnd 16)
BOT_WEBHOOK_PATH=$(rnd 12)
BOT_WEBHOOK_SECRET=$(rnd 16)
CORS_ORIGINS=https://shaiba-potolok.vercel.app
GAME_URL=https://shaiba-potolok.vercel.app
EOF
  chmod 600 .env
else
  DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)
fi

say "Файрвол: открываю только SSH, 80 и 443"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null

say "Ключ для автообновления с GitHub"
KEY=/root/.ssh/gm_deploy
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C gm-deploy -f "$KEY"
chmod +x "$DIR/server/deploy.sh"
LINE="command=\"$DIR/server/deploy.sh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat "$KEY.pub")"
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
grep -qF "$(cat "$KEY.pub")" /root/.ssh/authorized_keys || echo "$LINE" >> /root/.ssh/authorized_keys

say "Запускаю сервер (первый раз 2–5 минут)"
docker compose up -d --build

say "Жду, пока сервер ответит по https://$DOMAIN"
ok=0
for i in $(seq 1 60); do
  if curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done

ADMIN_KEY=$(grep '^ADMIN_KEY=' .env | cut -d= -f2)
echo
if [ $ok = 1 ]; then echo "✅ Сервер работает: https://$DOMAIN/api/health"; else echo "⚠️  Сервер пока не ответил. Проверьте: docker compose -f $DIR/server/docker-compose.yml logs --tail 50"; fi
cat <<EOF

Адрес сервера (пришлите его Claude):  https://$DOMAIN

Для автообновления добавьте в GitHub два секрета
(репозиторий → Settings → Secrets and variables → Actions → New repository secret):
  DEPLOY_HOST = $IP
  DEPLOY_KEY  = весь текст между линиями ниже, включая строки BEGIN и END
--------------------------------------------------------------------------
$(cat "$KEY")
--------------------------------------------------------------------------

Статистика игроков (сохраните ключ, никому его не отправляйте):
  curl -H "Authorization: Bearer $ADMIN_KEY" https://$DOMAIN/api/admin/stats
EOF
