import Fastify from 'fastify';
import crypto from 'node:crypto';
import { verifyInitData, issueToken, readToken } from './auth.js';
import { handleUpdate } from './bot.js';

const EVENT_TYPES = new Set(['open', 'team', 'tour', 'tour_skip', 'season', 'fired', 'live', 'error']);
const MAX_SAVE = 4 * 1024 * 1024;

/** Простое ограничение частоты запросов по IP (в памяти). */
function rateLimiter(perMin) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60000).unref();
  return (ip) => {
    const n = (hits.get(ip) || 0) + 1;
    hits.set(ip, n);
    return n <= perMin;
  };
}

export function buildApp({ pool, cfg, logger = true }) {
  const app = Fastify({ logger, bodyLimit: MAX_SAVE, trustProxy: true });
  const allow = rateLimiter(cfg.rateLimit || 240);
  const origins = new Set((cfg.corsOrigins || '').split(',').map((s) => s.trim()).filter(Boolean));

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_SAVE }, (req, body, done) => done(null, body));

  // CORS и лимит частоты
  app.addHook('onRequest', async (req, reply) => {
    const o = req.headers.origin;
    if (o && (origins.has(o) || origins.has('*'))) {
      reply.header('Access-Control-Allow-Origin', o);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Meta, X-Enc');
      reply.header('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
      reply.header('Access-Control-Expose-Headers', 'X-Ver, X-Meta, X-Enc, X-Updated');
      reply.header('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return reply.code(204).send();
    if (!req.url.startsWith('/bot/') && !allow(req.ip)) return reply.code(429).send({ error: 'too_many_requests' });
  });

  const auth = async (req, reply) => {
    const h = req.headers.authorization || '';
    const p = readToken(h.startsWith('Bearer ') ? h.slice(7) : '', cfg.sessionSecret);
    if (!p) return reply.code(401).send({ error: 'unauthorized' });
    req.uid = p.uid;
  };

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  // Вход: initData от Telegram -> токен сессии + сведения о сохранении в облаке
  app.post('/api/auth', async (req, reply) => {
    const u = verifyInitData(req.body?.initData, cfg.botToken, cfg.initDataMaxAge);
    if (!u) return reply.code(401).send({ error: 'bad_init_data' });
    const r = await pool.query(
      `INSERT INTO users (tg_id, first_name, username, lang) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tg_id) DO UPDATE SET first_name=EXCLUDED.first_name, username=EXCLUDED.username, lang=EXCLUDED.lang, last_seen=now()
       RETURNING id, (xmax = 0) AS created`,
      [u.id, u.first_name || null, u.username || null, u.language_code || null]
    );
    const { id, created } = r.rows[0];
    const s = await pool.query('SELECT ver, meta, size, updated_at FROM saves WHERE user_id=$1 AND slot=0', [id]);
    const save = s.rows[0] ? { ver: s.rows[0].ver, meta: s.rows[0].meta, size: s.rows[0].size, updatedAt: s.rows[0].updated_at } : null;
    return { token: issueToken(id, cfg.sessionSecret), user: { id, name: u.first_name || '', created }, save };
  });

  // Скачать сохранение
  app.get('/api/save', { preHandler: auth }, async (req, reply) => {
    const r = await pool.query('SELECT ver, enc, data, meta, updated_at FROM saves WHERE user_id=$1 AND slot=0', [req.uid]);
    if (!r.rows[0]) return reply.code(204).send();
    const s = r.rows[0];
    reply.header('X-Ver', String(s.ver));
    reply.header('X-Enc', s.enc);
    reply.header('X-Meta', Buffer.from(JSON.stringify(s.meta)).toString('base64'));
    reply.header('X-Updated', s.updated_at.toISOString());
    reply.header('Cache-Control', 'no-store');
    return reply.type('application/octet-stream').send(s.data);
  });

  // Записать сохранение. ?base=<версия, от которой пишем>. Если в облаке уже другая версия — 409.
  app.put('/api/save', { preHandler: auth }, async (req, reply) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: 'empty' });
    const enc = req.headers['x-enc'] === 'json' ? 'json' : 'gzip';
    let meta = {};
    try { meta = JSON.parse(Buffer.from(String(req.headers['x-meta'] || ''), 'base64').toString() || '{}'); } catch { meta = {}; }
    if (JSON.stringify(meta).length > 2000) meta = {};
    const base = Number(req.query.base || 0);
    const force = req.query.force === '1';
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const cur = await c.query('SELECT ver, meta, updated_at FROM saves WHERE user_id=$1 AND slot=0 FOR UPDATE', [req.uid]);
      const row = cur.rows[0];
      if (row && row.ver !== base && !force) {
        await c.query('ROLLBACK');
        return reply.code(409).send({ error: 'conflict', ver: row.ver, meta: row.meta, updatedAt: row.updated_at });
      }
      const ver = row ? row.ver + 1 : 1;
      await c.query(
        `INSERT INTO saves (user_id, slot, ver, enc, data, meta, size, updated_at) VALUES ($1,0,$2,$3,$4,$5,$6,now())
         ON CONFLICT (user_id, slot) DO UPDATE SET ver=$2, enc=$3, data=$4, meta=$5, size=$6, updated_at=now()`,
        [req.uid, ver, enc, body, meta, body.length]
      );
      await c.query('COMMIT');
      return { ver };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  });

  // События статистики: [{t:'season', d:{...}}], не больше 50 за раз
  app.post('/api/events', { preHandler: auth }, async (req, reply) => {
    const list = Array.isArray(req.body?.events) ? req.body.events.slice(0, 50) : [];
    const rows = list.filter((e) => e && EVENT_TYPES.has(e.t)).map((e) => {
      const d = e.d && typeof e.d === 'object' ? e.d : {};
      return [e.t, JSON.stringify(d).length <= 1000 ? d : {}];
    });
    if (rows.length) {
      const vals = rows.map((_, i) => `($1,$${i * 2 + 2},$${i * 2 + 3})`).join(',');
      await pool.query(`INSERT INTO events (user_id, type, data) VALUES ${vals}`, [req.uid, ...rows.flat()]);
    }
    await pool.query('UPDATE users SET last_seen=now() WHERE id=$1', [req.uid]);
    return { ok: true, n: rows.length };
  });

  // Сводка для владельца игры: /api/admin/stats с заголовком Authorization: Bearer <ADMIN_KEY>
  app.get('/api/admin/stats', async (req, reply) => {
    const h = req.headers.authorization || '';
    const key = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!cfg.adminKey || key.length !== cfg.adminKey.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(cfg.adminKey)))
      return reply.code(401).send({ error: 'unauthorized' });
    const q = async (sql) => (await pool.query(sql)).rows;
    const [tot] = await q(`SELECT count(*)::int AS users,
      count(*) FILTER (WHERE last_seen > now()-interval '1 day')::int AS dau,
      count(*) FILTER (WHERE last_seen > now()-interval '7 days')::int AS wau,
      count(*) FILTER (WHERE created_at > now()-interval '1 day')::int AS new_day FROM users`);
    const [sv] = await q(`SELECT count(*)::int AS saves, coalesce(round(avg(size))::int,0) AS avg_kb FROM saves`);
    sv.avg_kb = Math.round(sv.avg_kb / 1024);
    const ev = await q(`SELECT type, count(*)::int AS n FROM events WHERE ts > now()-interval '7 days' GROUP BY type ORDER BY n DESC`);
    const tour = await q(`SELECT (data->>'i')::int AS step, count(DISTINCT user_id)::int AS users FROM events
      WHERE type='tour' GROUP BY 1 ORDER BY 1`);
    const daily = await q(`SELECT to_char(date_trunc('day', ts),'YYYY-MM-DD') AS day, count(DISTINCT user_id)::int AS users
      FROM events WHERE ts > now()-interval '14 days' GROUP BY 1 ORDER BY 1`);
    return { ...tot, ...sv, events7d: ev, tourFunnel: tour, daily };
  });

  // Вебхук бота: /bot/<BOT_WEBHOOK_PATH>
  if (cfg.botToken && cfg.webhookPath) {
    app.post(`/bot/${cfg.webhookPath}`, async (req, reply) => {
      if (cfg.webhookSecret && req.headers['x-telegram-bot-api-secret-token'] !== cfg.webhookSecret) return reply.code(401).send();
      handleUpdate(req.body, cfg, app.log).catch((e) => app.log.warn({ err: e }, 'bot update failed'));
      return { ok: true };
    });
  }

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'request failed');
    reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ error: err.statusCode === 413 ? 'too_large' : 'server_error' });
  });

  return app;
}
