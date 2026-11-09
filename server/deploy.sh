#!/usr/bin/env bash
# Обновление сервера до последней версии из main. Его вызывает GitHub Actions по SSH-ключу gm_deploy.
set -euo pipefail
cd /opt/genmanager
git fetch -q origin main
git reset -q --hard origin/main
cd server
mkdir -p www && cp ../index.html www/index.html.tmp && mv www/index.html.tmp www/index.html
docker compose up -d --build --remove-orphans
# Caddyfile смонтирован файлом: после git reset контейнер видит старую копию, поэтому при изменении пересоздаём caddy
h=$(sha1sum Caddyfile | cut -d' ' -f1)
if [ "$h" != "$(cat .caddy.sha 2>/dev/null)" ]; then docker compose up -d --force-recreate caddy; echo "$h" > .caddy.sha; fi
# Онлайн-движок загружает index.html при старте api: новая сборка игры — перезапуск api
g=$(sha1sum www/index.html | cut -d' ' -f1)
if [ "$g" != "$(cat .game.sha 2>/dev/null)" ]; then docker compose restart api; echo "$g" > .game.sha; fi
docker image prune -f >/dev/null
for i in $(seq 1 30); do
  if docker compose exec -T api wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then echo "deploy ok: $(git rev-parse --short HEAD)"; sleep 5; docker compose logs --tail 60 api | grep -E "webhook|menu button|online:|error" | tail -8 || true; exit 0; fi
  sleep 2
done
echo "api не ответил после обновления"; docker compose logs --tail 40 api; exit 1
