// Вебхук бота: Telegram присылает сюда обновления, функция пересылает их на сервер игры.
// Адрес сервера зашит в код, поэтому это не открытый прокси.
// GET /api/tghook?ping=1 — проверить, что Vercel достаёт до сервера игры.
const BACKEND = 'https://135-106-181-183.sslip.io';

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    if (!req.query.ping) return res.status(200).send('ok');
    try {
      const r = await fetch(`${BACKEND}/api/health`, { signal: AbortSignal.timeout(8000) });
      return res.status(200).json({ backend: r.status, body: await r.text() });
    } catch (e) {
      return res.status(200).json({ backend: 'unreachable', error: String(e && e.message || e) });
    }
  }
  const p = String(req.query.p || '');
  if (!/^[0-9a-f]{8,64}$/.test(p)) return res.status(400).send('bad path');
  try {
    await fetch(`${BACKEND}/bot/${p}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': String(req.headers['x-telegram-bot-api-secret-token'] || ''),
      },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    // Telegram повторит доставку сам, если мы ответим ошибкой
    return res.status(502).send('backend unreachable');
  }
  return res.status(200).send('ok');
};
