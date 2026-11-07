-- Игроки из Android-приложения: аккаунт создаётся по устройству, Telegram можно привязать позже
ALTER TABLE users ALTER COLUMN tg_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,          -- случайный идентификатор, который создаёт приложение
  secret_hash  TEXT NOT NULL,             -- sha256 секрета устройства
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id);

-- Одноразовые коды привязки Telegram (живут 15 минут)
CREATE TABLE IF NOT EXISTS link_codes (
  code        TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL
);
