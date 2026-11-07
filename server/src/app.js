import Fastify from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // https://localhost — так выглядит адрес игры внутри Android-приложения (Capacitor)
  const origins = new Set([...(cfg.corsOrigins || '').split(','), 'https://localhost'].map((s) => s.trim()).filter(Boolean));

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
    // аккаунт устройства, которое уже привязали к Telegram, больше не используется: пусть войдёт заново
    const u = (await pool.query('SELECT tg_id, EXISTS (SELECT 1 FROM devices d WHERE d.user_id=u.id) AS dev FROM users u WHERE id=$1', [p.uid])).rows[0];
    if (!u || (u.tg_id == null && !u.dev)) return reply.code(401).send({ error: 'relogin' });
    req.uid = p.uid;
  };
  const saveInfo = async (uid) => {
    const s = await pool.query('SELECT ver, meta, size, updated_at FROM saves WHERE user_id=$1 AND slot=0', [uid]);
    return s.rows[0] ? { ver: s.rows[0].ver, meta: s.rows[0].meta, size: s.rows[0].size, updatedAt: s.rows[0].updated_at } : null;
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
    return { token: issueToken(id, cfg.sessionSecret), user: { id, name: u.first_name || '', created, linked: true }, save: await saveInfo(id) };
  });

  // Вход из Android-приложения: устройство присылает свой случайный id и секрет
  app.post('/api/auth/device', async (req, reply) => {
    const id = String(req.body?.id || ''), secret = String(req.body?.secret || '');
    if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{64}$/.test(secret)) return reply.code(400).send({ error: 'bad_device' });
    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    const platform = String(req.body?.platform || '').slice(0, 20) || null;
    const d = (await pool.query('SELECT secret_hash, user_id FROM devices WHERE id=$1', [id])).rows[0];
    let uid, created = false;
    if (d) {
      if (!crypto.timingSafeEqual(Buffer.from(d.secret_hash), Buffer.from(hash))) return reply.code(401).send({ error: 'bad_device' });
      uid = d.user_id;
      await pool.query('UPDATE devices SET last_seen=now() WHERE id=$1', [id]);
      await pool.query('UPDATE users SET last_seen=now() WHERE id=$1', [uid]);
    } else {
      uid = (await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id;
      await pool.query('INSERT INTO devices (id, secret_hash, user_id, platform) VALUES ($1,$2,$3,$4)', [id, hash, uid, platform]);
      created = true;
    }
    const u = (await pool.query('SELECT tg_id, first_name FROM users WHERE id=$1', [uid])).rows[0];
    return { token: issueToken(uid, cfg.sessionSecret), user: { id: uid, name: u.first_name || '', created, linked: u.tg_id != null }, save: await saveInfo(uid) };
  });

  // Код для привязки Telegram: приложение открывает бота с этим кодом
  app.post('/api/link/start', { preHandler: auth }, async (req) => {
    const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (const b of crypto.randomBytes(6)) code += ABC[b % ABC.length];
    await pool.query('DELETE FROM link_codes WHERE user_id=$1 OR expires_at < now()', [req.uid]);
    await pool.query("INSERT INTO link_codes (code, user_id, expires_at) VALUES ($1,$2, now() + interval '15 minutes')", [code, req.uid]);
    const bot = cfg.botUsername || 'hmrurubot';
    return { code, url: `https://t.me/${bot}?start=link_${code}`, tg: `tg://resolve?domain=${bot}&start=link_${code}` };
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
    const daily = await q(`WITH d AS (SELECT generate_series(date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') - interval '29 days', date_trunc('day', now() AT TIME ZONE 'Europe/Moscow'), interval '1 day') AS day)
      SELECT to_char(d.day,'YYYY-MM-DD') AS day,
        (SELECT count(DISTINCT user_id) FROM events e WHERE (e.ts AT TIME ZONE 'Europe/Moscow') >= d.day AND (e.ts AT TIME ZONE 'Europe/Moscow') < d.day + interval '1 day')::int AS users,
        (SELECT count(*) FROM users u WHERE (u.created_at AT TIME ZONE 'Europe/Moscow') >= d.day AND (u.created_at AT TIME ZONE 'Europe/Moscow') < d.day + interval '1 day')::int AS new
      FROM d ORDER BY d.day`);
    const ret = async (from, to, lo, hi) => (await pool.query(`SELECT count(*)::int AS cohort,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.user_id=u.id AND e.ts >= u.created_at + $3::interval AND e.ts < u.created_at + $4::interval))::int AS back
      FROM users u WHERE u.created_at < now() - $1::interval AND u.created_at >= now() - $2::interval`, [from, to, lo, hi])).rows[0];
    const d1 = await ret('2 days', '32 days', '20 hours', '48 hours');
    const d7 = await ret('8 days', '38 days', '6 days', '8 days');
    const teams = await q(`SELECT (data->>'id')::int AS id, count(DISTINCT user_id)::int AS users FROM events
      WHERE type='team' AND data->>'id' ~ '^[0-9]+$' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
    const seasons = await q(`SELECT (meta->>'season')::int - 2025 AS n, count(*)::int AS users FROM saves
      WHERE meta->>'season' ~ '^[0-9]+$' GROUP BY 1 ORDER BY 1`);
    const [skip] = await q(`SELECT count(DISTINCT user_id)::int AS n FROM events WHERE type='tour_skip'`);
    const [started] = await q(`SELECT count(DISTINCT user_id)::int AS n FROM events WHERE type='team'`);
    return { ...tot, ...sv, events7d: ev, tourFunnel: tour, daily, retention: { d1, d7 }, teams, seasons, tourSkip: skip.n, teamPicked: started.n, at: new Date().toISOString() };
  });

  // Страница статистики (данные она берёт из /api/admin/stats по ключу, который вводится на странице)
  const adminHtml = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin', 'index.html'));
  app.get('/admin', async (req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex').send(adminHtml));

  // Вебхук бота: /bot/<BOT_WEBHOOK_PATH>
  if (cfg.botToken && cfg.webhookPath) {
    app.post(`/bot/${cfg.webhookPath}`, async (req, reply) => {
      if (cfg.webhookSecret && req.headers['x-telegram-bot-api-secret-token'] !== cfg.webhookSecret) return reply.code(401).send();
      handleUpdate(req.body, cfg, app.log, pool).catch((e) => app.log.warn({ err: e }, 'bot update failed'));
      return { ok: true };
    });
  }

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'request failed');
    reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ error: err.statusCode === 413 ? 'too_large' : 'server_error' });
  });

  return app;
}
