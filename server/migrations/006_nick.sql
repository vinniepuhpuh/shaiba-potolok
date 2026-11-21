-- Игровой никнейм: задаёт сам игрок, не затирается входом через Telegram
ALTER TABLE users ADD COLUMN IF NOT EXISTS nick TEXT;
