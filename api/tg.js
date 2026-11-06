// Ретранслятор Bot API: сервер игры (в России) не достаёт до api.telegram.org,
// поэтому вызовы методов бота идут через эту функцию Vercel.
// POST /api/tg?m=<метод>, заголовок X-Bot-Token, тело — JSON параметров метода.
const ALLOWED = new Set(['sendMessage', 'setWebhook', 'deleteWebhook', 'getWebhookInfo', 'getMe',
  'answerPreCheckoutQuery', 'createInvoiceLink', 'answerCallbackQuery', 'refundStarPayment', 'getStarTransactions']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, description: 'POST only' });
  const m = String(req.query.m || '');
  const token = String(req.headers['x-bot-token'] || '');
  if (!ALLOWED.has(m)) return res.status(400).json({ ok: false, description: 'method not allowed' });
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) return res.status(401).json({ ok: false, description: 'bad token' });
  const only = process.env.ALLOWED_BOT_ID;
  if (only && token.split(':')[0] !== only) return res.status(403).json({ ok: false, description: 'bot not allowed' });
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${m}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({ ok: false, description: 'bad response' }));
    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(502).json({ ok: false, description: 'telegram unreachable' });
  }
};
