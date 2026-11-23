-- Настройки сервера (админка): ключ-значение; сейчас — конвейер открытых лиг
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- Конвейер лиг по умолчанию выключен: включим вручную после выкатки
INSERT INTO settings (key, value) VALUES ('conveyor.enabled', 'false'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('conveyor.template', '"big"'::jsonb) ON CONFLICT (key) DO NOTHING;
