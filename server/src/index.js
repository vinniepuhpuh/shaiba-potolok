import { buildApp } from './app.js';
import { makePool, migrate } from './db.js';
import { tg } from './bot.js';

const env = process.env;
const need = (k) => {
  if (!env[k]) { console.error(`Не задана переменная окружения ${k}`); process.exit(1); }
  return env[k];
};

const cfg = {
  botToken: need('BOT_TOKEN'),
  sessionSecret: need('SESSION_SECRET'),
  adminKey: env.ADMIN_KEY || '',
  corsOrigins: env.CORS_ORIGINS || 'https://shaiba-potolok.vercel.app',
  gameUrl: env.GAME_URL || 'https://shaiba-potolok.vercel.app',
  publicUrl: env.PUBLIC_URL || '',
  webhookPath: env.BOT_WEBHOOK_PATH || '',
  webhookSecret: env.BOT_WEBHOOK_SECRET || '',
  initDataMaxAge: Number(env.INIT_DATA_MAX_AGE || 86400),
  rateLimit: Number(env.RATE_LIMIT || 240),
  tgRelay: env.TG_RELAY || 'https://shaiba-potolok.vercel.app/api/tg',
  webhookVia: env.WEBHOOK_VIA || 'https://shaiba-potolok.vercel.app/api/tghook',
};

const pool = makePool(need('DATABASE_URL'));
for (let i = 0; ; i++) {
  try { await pool.query('SELECT 1'); break; } catch (e) {
    if (i >= 30) throw e;
    console.log('жду базу данных…');
    await new Promise((r) => setTimeout(r, 2000));
  }
}
await migrate(pool);

const app = buildApp({ pool, cfg });
await app.listen({ host: '0.0.0.0', port: Number(env.PORT || 3000) });

// Регистрируем вебхук бота, если задан публичный адрес
// По умолчанию Telegram шлёт обновления на Vercel (api/tghook.js), а тот пересылает сюда.
// WEBHOOK_VIA=direct — Telegram шлёт прямо на этот сервер.
if (cfg.webhookPath && (cfg.publicUrl || cfg.webhookVia !== 'direct')) {
  const hookUrl = cfg.webhookVia === 'direct' ? `${cfg.publicUrl}/bot/${cfg.webhookPath}` : `${cfg.webhookVia}?p=${cfg.webhookPath}`;
  tg(cfg, 'setWebhook', {
    url: hookUrl,
    secret_token: cfg.webhookSecret || undefined,
    allowed_updates: ['message', 'pre_checkout_query'],
  }).then(() => app.log.info('webhook set')).catch((e) => app.log.warn(`webhook not set: ${e.message}`));
}

const stop = async () => { await app.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
