-- Игроки (по Telegram ID)
CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  tg_id       BIGINT UNIQUE NOT NULL,
  first_name  TEXT,
  username    TEXT,
  lang        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Облачное сохранение: одно на игрока (слот 0), позже можно добавить слоты
CREATE TABLE IF NOT EXISTS saves (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot        SMALLINT NOT NULL DEFAULT 0,
  ver         INTEGER NOT NULL DEFAULT 1,
  enc         TEXT NOT NULL DEFAULT 'gzip',   -- gzip | json
  data        BYTEA NOT NULL,
  meta        JSONB NOT NULL DEFAULT '{}',    -- сезон, клуб, день — для показа без распаковки
  size        INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, slot)
);

-- События для статистики (старт, обучение, сезоны)
CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}',
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts);
CREATE INDEX IF NOT EXISTS events_type_ts_idx ON events (type, ts);
CREATE INDEX IF NOT EXISTS users_last_seen_idx ON users (last_seen);
