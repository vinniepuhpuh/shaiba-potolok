import { linkTelegram } from './link.js';
/** Ответы бота. Сейчас: /start с кнопкой «Играть». Позже здесь будут платежи за звёзды. */
// Из российских дата-центров api.telegram.org часто недоступен, поэтому по умолчанию
// вызовы идут через ретранслятор на Vercel (api/tg.js в репозитории). TG_RELAY=direct — напрямую.
export async function tg(cfg, method, payload) {
  const direct = !cfg.tgRelay || cfg.tgRelay === 'direct';
  const url = direct ? `https://api.telegram.org/bot${cfg.botToken}/${method}` : `${cfg.tgRelay}?m=${encodeURIComponent(method)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(direct ? {} : { 'X-Bot-Token': cfg.botToken }) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}

export async function handleUpdate(u, cfg, log, pool) {
  const m = u && u.message;
  if (!m || !m.text) return;
  const lk = m.text.match(/^\/start\s+link_([A-Z0-9]{6})\b/);
  if (lk && pool && m.from) {
    const r = await linkTelegram(pool, lk[1], m.from);
    await tg(cfg, 'sendMessage', {
      chat_id: m.chat.id,
      text: r.ok
        ? 'Готово! Приложение привязано к вашему Telegram: теперь у вас одно сохранение и в приложении, и в боте.\n\nВернитесь в приложение Генменеджер.'
        : 'Код устарел. Откройте приложение и нажмите «Привязать Telegram» ещё раз.',
    });
    return;
  }
  if (/^\/start\b/.test(m.text)) {
    await tg(cfg, 'sendMessage', {
      chat_id: m.chat.id,
      text: 'Генменеджер — хоккейный симулятор. Соберите клуб, уложитесь в потолок зарплат и выиграйте кубок.\n\nНажмите «Играть», чтобы открыть игру.',
      reply_markup: { inline_keyboard: [[{ text: '🏒 Играть', web_app: { url: cfg.gameUrl } }]] },
    });
  }
}
