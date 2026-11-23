CREATE TABLE IF NOT EXISTS career_rewards (
  uid BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cash_billions INTEGER NOT NULL CHECK (cash_billions > 0)
);

CREATE TABLE IF NOT EXISTS assistant_purchases (
  uid BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  PRIMARY KEY (uid, scope)
);
