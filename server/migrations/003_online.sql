-- Онлайн-сезоны: состояние лиги целиком (как сохранение карьеры) + сыгранные матчи с записью трансляции
CREATE TABLE IF NOT EXISTS online_seasons (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',   -- active | finished | archived
  state       JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS online_games (
  season_id   INT NOT NULL REFERENCES online_seasons(id) ON DELETE CASCADE,
  gid         TEXT NOT NULL,
  slot        INT NOT NULL,
  kind        TEXT NOT NULL,
  t_start     TIMESTAMPTZ NOT NULL,
  home        INT NOT NULL,
  away        INT NOT NULL,
  res         JSONB NOT NULL,
  box         JSONB,
  ev          JSONB,
  log         BYTEA,
  PRIMARY KEY (season_id, gid)
);
