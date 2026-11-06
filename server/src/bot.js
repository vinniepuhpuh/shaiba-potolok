/** Ответы бота. Сейчас: /start с кнопкой «Играть». Позже здесь будут платежи за звёзды. */
export async function tg(cfg, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${cfg.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}

export async function handleUpdate(u, cfg, log) {
  const m = u && u.message;
  if (!m || !m.text) return;
  if (/^\/start\b/.test(m.text)) {
    await tg(cfg, 'sendMessage', {
      chat_id: m.chat.id,
      text: 'Генменеджер — хоккейный симулятор. Соберите клуб, уложитесь в потолок зарплат и выиграйте кубок.\n\nНажмите «Играть», чтобы открыть игру.',
      reply_markup: { inline_keyboard: [[{ text: '🏒 Играть', web_app: { url: cfg.gameUrl } }]] },
    });
  }
}
