-- Админ-панель: баны, журнал действий, донатные кошельки
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;

-- Audit log: каждое действие админа — время, действие, цель, payload
CREATE TABLE IF NOT EXISTS admin_log (
  id          BIGSERIAL PRIMARY KEY,
  action      TEXT NOT NULL,
  target      TEXT,
  payload     JSONB NOT NULL DEFAULT '{}',
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_log_created_idx ON admin_log (created_at DESC);

-- Донатная валюта: баланс и операции (валюта появится позже — таблицы готовы)
CREATE TABLE IF NOT EXISTS wallets (
  uid         BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance     INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_ops (
  id          BIGSERIAL PRIMARY KEY,
  uid         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta       INTEGER NOT NULL,
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
