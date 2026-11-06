#!/usr/bin/env bash
# Обновление сервера до последней версии из main. Его вызывает GitHub Actions по SSH-ключу gm_deploy.
set -euo pipefail
cd /opt/genmanager
git fetch -q origin main
git reset -q --hard origin/main
cd server
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
for i in $(seq 1 30); do
  if docker compose exec -T api wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then echo "deploy ok: $(git rev-parse --short HEAD)"; exit 0; fi
  sleep 2
done
echo "api не ответил после обновления"; docker compose logs --tail 40 api; exit 1
