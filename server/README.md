# Сервер «Генменеджера»

Что делает:
- **вход через Telegram**: игра присылает `initData`, сервер проверяет подпись токеном бота;
- **облачное сохранение**: одно на игрока, сжатое (около 40–60 КБ). Если с двух устройств пишут разные версии, игра спрашивает, какую оставить;
- **статистика**: открытия игры, выбор клуба, шаги обучения, итоги сезонов;
- **бот**: на `/start` отвечает кнопкой «Играть».

Устройство: Node.js 22 (Fastify) + PostgreSQL 16 + Caddy (автоматический https), всё в Docker. База копируется каждый день в `server/backups` (хранятся 14 копий).

## Первый запуск на сервере

Нужен VPS с Ubuntu 22.04 или 24.04 в России (Timeweb Cloud, Selectel, Yandex Cloud).

1. Подключитесь к серверу: `ssh root@IP_СЕРВЕРА`.
2. Выполните:
   ```
   curl -fsSL https://raw.githubusercontent.com/vinniepuhpuh/shaiba-potolok/main/server/setup.sh -o setup.sh && bash setup.sh
   ```
   Со своим доменом: `bash setup.sh api.вашдомен.ru`. Домен должен заранее указывать на IP сервера (A-запись).
3. Скрипт спросит токен бота. В конце он покажет адрес сервера и ключ для автообновления.
4. Добавьте в GitHub секреты `DEPLOY_HOST` и `DEPLOY_KEY` (Settings → Secrets and variables → Actions).

После этого каждый push в папку `server/` проверяется тестами и сам выкатывается на сервер (workflow «Обновление сервера»).

## Полезные команды на сервере

```
cd /opt/genmanager/server
docker compose ps                 # что запущено
docker compose logs -f --tail 100 api
docker compose restart api
ls backups/                       # копии базы
```

Восстановить базу из копии:
```
gunzip -c backups/gm-2026-11-06.sql.gz | docker compose exec -T db psql -U gm gm
```

Статистика (ключ `ADMIN_KEY` лежит в `/opt/genmanager/server/.env`):
```
curl -H "Authorization: Bearer ADMIN_KEY" https://АДРЕС/api/admin/stats
```

## API

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/api/health` | проверка |
| POST | `/api/auth` | `{initData}` → `{token, user, save}` |
| GET | `/api/save` | сохранение (gzip), заголовки `X-Ver`, `X-Meta`, `X-Enc` |
| PUT | `/api/save?base=N` | записать; 409, если в облаке уже не версия N; `&force=1` — перезаписать |
| POST | `/api/events` | `{events:[{t,d}]}`, до 50 за раз |
| GET | `/api/admin/stats` | сводка, нужен `ADMIN_KEY` |

## Тесты

```
cd server && npm ci
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/test npm test
```
