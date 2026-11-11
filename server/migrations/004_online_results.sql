-- Итоги онлайн-сезонов по менеджерам: место, плей-офф, дерби, очки рейтинга, награды
CREATE TABLE IF NOT EXISTS online_results (
  season_id   INT NOT NULL REFERENCES online_seasons(id) ON DELETE CASCADE,
  uid         BIGINT NOT NULL,
  team        INT NOT NULL,
  club        TEXT NOT NULL,
  name        TEXT NOT NULL,
  test        BOOLEAN NOT NULL DEFAULT false,
  place       INT NOT NULL,
  po_rounds   INT NOT NULL DEFAULT 0,
  derby_w     INT NOT NULL DEFAULT 0,
  points      INT NOT NULL DEFAULT 0,
  profit      INT NOT NULL DEFAULT 0,
  awards      JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (season_id, uid)
);
CREATE INDEX IF NOT EXISTS online_results_uid ON online_results (uid, season_id DESC);
