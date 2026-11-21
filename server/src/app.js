import Fastify from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInitData, issueToken, readToken, issueAdminToken, readAdminToken } from './auth.js';
import { ratingFrom } from './awards.js';
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

export function buildApp({ pool, cfg, logger = true, online = null }) {
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
    const u = (await pool.query('SELECT tg_id, banned, ban_reason, EXISTS (SELECT 1 FROM devices d WHERE d.user_id=u.id) AS dev FROM users u WHERE id=$1', [p.uid])).rows[0];
    if (!u || (u.tg_id == null && !u.dev)) return reply.code(401).send({ error: 'relogin' });
    if (u.banned) return reply.code(403).send({ error: 'banned', reason: u.ban_reason || 'Аккаунт заблокирован.' });
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
       RETURNING id, (xmax = 0) AS created, banned, ban_reason`,
      [u.id, u.first_name || null, u.username || null, u.language_code || null]
    );
    const { id, created, banned, ban_reason } = r.rows[0];
    if (banned) return reply.code(403).send({ error: 'banned', reason: ban_reason || 'Аккаунт заблокирован.' });
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

  // Сводка для владельца игры: принимает и ключ ADMIN_KEY, и админ-сессию из /api/admin/login
  app.get('/api/admin/stats', async (req, reply) => {
    if (!adminOk(req)) return reply.code(401).send({ error: 'unauthorized' });
    const q = async (sql) => (await pool.query(sql)).rows;
    const [tot] = await q(`SELECT count(*)::int AS users,
      count(*) FILTER (WHERE last_seen > now()-interval '1 day')::int AS dau,
      count(*) FILTER (WHERE last_seen > now()-interval '7 days')::int AS wau,
      count(*) FILTER (WHERE created_at > now()-interval '1 day')::int AS new_day,
      count(*) FILTER (WHERE created_at > now()-interval '7 days')::int AS new_week FROM users`);
    const [gy] = await q(`SELECT count(*)::int AS n FROM online_games
      WHERE (t_start AT TIME ZONE 'Europe/Moscow')::date = (now() AT TIME ZONE 'Europe/Moscow')::date - interval '1 day'`);
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
    return { ...tot, gamesYesterday: gy.n, ...sv, events7d: ev, tourFunnel: tour, daily, retention: { d1, d7 }, teams, seasons, tourSkip: skip.n, teamPicked: started.n, at: new Date().toISOString() };
  });

  // Страница статистики (данные она берёт из /api/admin/stats по ключу, который вводится на странице)
  const adminHtml = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin', 'index.html'));
  app.get('/admin', async (req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex').send(adminHtml));
  app.get('/admin/', async (req, reply) => reply.redirect('/admin', 301)); // со слэшем — не попадать в фолбэк игры
  const privacyHtml = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin', 'privacy.html'));
  app.get('/privacy', async (req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(privacyHtml));

  // ---------- онлайн-сезон ----------
  const softUid = (req) => {
    const h = req.headers.authorization || '';
    const p = readToken(h.startsWith('Bearer ') ? h.slice(7) : '', cfg.sessionSecret);
    return p ? p.uid : null;
  };
  // админ: подписанная сессия из /api/admin/login (12 ч) ИЛИ ключ ADMIN_KEY — оба способа
  const adminOk = (req) => {
    const h = req.headers.authorization || '', key = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!key) return false;
    if (readAdminToken(key, cfg.sessionSecret)) return true;
    return !!cfg.adminKey && key.length === cfg.adminKey.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(cfg.adminKey));
  };
  const needAdmin = (req, reply) => { if (!adminOk(req)) { reply.code(401).send({ error: 'unauthorized' }); return false; } return true; };
  const alog = async (req, action, target, payload) => {
    await pool.query('INSERT INTO admin_log (action, target, payload, ip) VALUES ($1,$2,$3,$4)',
      [action, target == null ? null : String(target), JSON.stringify(payload || {}), req.ip]).catch(() => {});
  };
  // вход в админку: ключ -> подписанная сессия (ключ в сессии не храним)
  const loginAllow = rateLimiter(10);
  app.post('/api/admin/login', async (req, reply) => {
    if (!loginAllow(req.ip)) return reply.code(429).send({ error: 'too_many' });
    const key = String(req.body?.key || '');
    if (!cfg.adminKey || key.length !== cfg.adminKey.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(cfg.adminKey)))
      return reply.code(401).send({ error: 'unauthorized' });
    await alog(req, 'login', 'admin', {});
    return { token: issueAdminToken(cfg.sessionSecret) };
  });
  const sidOf = (req) => Number(req.params.sid);
  // список турниров для экрана «Мои турниры»; без авторизации — только открытые лиги
  app.get('/api/seasons', async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    reply.header('Cache-Control', 'no-store');
    return online.seasonsList(softUid(req));
  });
  app.post('/api/seasons/:sid/join', { preHandler: auth }, async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    const team = Number(req.body?.team);
    const u = (await pool.query('SELECT first_name, username FROM users WHERE id=$1', [req.uid])).rows[0] || {};
    const r = await online.join(req.uid, u.first_name || u.username || 'Менеджер', team, sidOf(req));
    if (r.error) return reply.code(409).send(r);
    return r;
  });
  // старые версии приложения ходят без sid: редирект на последний активный открытый сезон
  const legacy = (method) => async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    const sid = await online.latestOpen();
    if (sid == null) return reply.code(404).send({ error: 'no_season' });
    const target = req.url.replace(/^\/api\/online/, `/api/online/${sid}`);
    return method === 'POST' ? reply.redirect(target, 308) : reply.redirect(target);
  };
  app.get('/api/online/:sid', async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    const uid = softUid(req);
    if (uid) await online.touch(uid, sidOf(req));
    const v = await online.view(uid, sidOf(req));
    if (!v) return reply.code(404).send({ error: 'no_season' });
    reply.header('Cache-Control', 'no-store');
    return v;
  });
  app.post('/api/online/:sid/join', { preHandler: auth }, async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    const team = Number(req.body?.team);
    const u = (await pool.query('SELECT first_name, username FROM users WHERE id=$1', [req.uid])).rows[0] || {};
    const r = await online.join(req.uid, u.first_name || u.username || 'Менеджер', team, sidOf(req));
    if (r.error) return reply.code(409).send(r);
    return r;
  });
  app.get('/api/online/:sid/game/:gid', async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    const g = await online.game(String(req.params.gid), sidOf(req), Date.now(), softUid(req));
    if (!g) return reply.code(404).send({ error: 'no_game' });
    reply.header('Cache-Control', 'no-store');
    return g;
  });
  app.get('/api/online/:sid/team/:id', async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    const v = await online.team(Number(req.params.id), softUid(req), sidOf(req));
    if (!v) return reply.code(404).send({ error: 'no_team' });
    reply.header('Cache-Control', 'no-store');
    return v;
  });
  app.post('/api/online/:sid/plan', { preHandler: auth }, async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    const b = req.body || {};
    const r = await online.plan(req.uid, b.key === 'def' ? 'def' : String(Number(b.key)), b.plan ?? null, sidOf(req));
    if (r.error) return reply.code(409).send(r);
    return r;
  });
  app.post('/api/online/:sid/lines', { preHandler: auth }, async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    const r = await online.lines(req.uid, req.body || {}, sidOf(req));
    if (r.error) return reply.code(409).send(r);
    return r;
  });
  app.get('/api/online/:sid/market', async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    reply.header('Cache-Control', 'no-store');
    return online.market(softUid(req), sidOf(req));
  });
  app.get('/api/online/:sid/academy', async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    reply.header('Cache-Control', 'no-store');
    const r = await online.academy(softUid(req), sidOf(req));
    if (r && r.error) return reply.code(409).send(r);
    return r;
  });
  app.get('/api/online/:sid/staff', async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    reply.header('Cache-Control', 'no-store');
    const r = await online.staff(softUid(req), sidOf(req));
    if (r && r.error) return reply.code(409).send(r);
    return r;
  });
  app.get('/api/online/:sid/fin', { preHandler: auth }, async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    reply.header('Cache-Control', 'no-store');
    const r = await online.fin(req.uid, sidOf(req));
    if (r.error) return reply.code(409).send(r);
    return r;
  });
  app.get('/api/online/:sid/rating', async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    reply.header('Cache-Control', 'no-store');
    return online.rating(softUid(req));
  });
  app.post('/api/online/:sid/trade/eval', { preHandler: auth }, async (req, reply) => {
    if (!online) return reply.code(404).send({ error: 'online_disabled' });
    return online.tradeEval(req.uid, req.body || {}, sidOf(req));
  });
  for (const [path, fn] of [['bid', 'bid'], ['poach', 'poachBid'], ['search', 'search'], ['take', 'take'], ['promote', 'promote'], ['upg', 'upg'], ['match', 'match'], ['release', 'release'], ['trade', 'trade'], ['trade/answer', 'answer'], ['prices', 'prices'], ['arena', 'arena'], ['coach/mode', 'coachMode'], ['coach/hire', 'coachHire'], ['sponsor', 'sponsor']]) {
    app.post('/api/online/:sid/' + path, { preHandler: auth }, async (req, reply) => {
      if (!online) return reply.code(404).send({ error: 'online_disabled' });
      const r = await online[fn](req.uid, req.body || {}, sidOf(req));
      if (r && r.error) return reply.code(409).send(r);
      return r;
    });
  }
  // редиректы для старых версий приложения (без sid в пути)
  app.get('/api/online', legacy('GET'));
  app.post('/api/online/join', { preHandler: auth }, legacy('POST'));
  app.get('/api/online/rating', legacy('GET'));
  for (const p of ['game/:gid', 'team/:id', 'market', 'academy', 'staff', 'fin']) app.get('/api/online/' + p, legacy('GET'));
  app.post('/api/admin/online/create', async (req, reply) => {
    if (!adminOk(req)) return reply.code(401).send({ error: 'unauthorized' });
    if (!online) return reply.code(503).send({ error: 'online_disabled' });
    return online.create(req.body || {});
  });
  app.post('/api/admin/online/run', async (req, reply) => {
    if (!adminOk(req)) return reply.code(401).send({ error: 'unauthorized' });
    return { played: await online.tick() };
  });

  // ---------- админ-панель: участники ----------
  const USER_COLS = 'u.id, u.first_name, u.username, u.tg_id, u.banned, u.created_at, u.last_seen';
  const userFilter = (q) => {
    const w = [];
    const p = [];
    if (q) { w.push('(u.first_name ILIKE $1 OR u.username ILIKE $1 OR u.id::text = $1)'); p.push('%' + q + '%'); }
    return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
  };
  app.get('/api/admin/users', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const q = String(req.query.q || '').trim().slice(0, 60) || null;
    const per = Math.min(100, Math.max(5, Number(req.query.per) || 25));
    const page = Math.max(1, Number(req.query.page) || 1);
    const f = userFilter(q);
    const total = (await pool.query(`SELECT count(*)::int AS n FROM users u ${f.where}`, f.params)).rows[0].n;
    const users = (await pool.query(
      `SELECT ${USER_COLS}, (SELECT platform FROM devices d WHERE d.user_id=u.id ORDER BY d.last_seen DESC LIMIT 1) AS platform,
         (SELECT count(*)::int FROM online_results r WHERE r.uid=u.id) AS seasons
       FROM users u ${f.where} ORDER BY u.id DESC LIMIT $${f.params.length + 1} OFFSET $${f.params.length + 2}`,
      [...f.params, per, (page - 1) * per])).rows;
    return { users, total, page, per };
  });
  app.get('/api/admin/users/:id', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const u = (await pool.query(
      `SELECT ${USER_COLS}, (SELECT platform FROM devices d WHERE d.user_id=u.id ORDER BY d.last_seen DESC LIMIT 1) AS platform,
         (SELECT count(*)::int FROM devices d WHERE d.user_id=u.id) AS devices
       FROM users u WHERE u.id=$1`, [id])).rows[0];
    if (!u) return reply.code(404).send({ error: 'no_user' });
    const resRows = (await pool.query(
      `SELECT r.season_id, s.name AS season, r.club, r.name, r.place, r.points, r.test, r.awards, r.profit, r.created_at
       FROM online_results r JOIN online_seasons s ON s.id=r.season_id WHERE r.uid=$1 ORDER BY r.season_id DESC`, [id])).rows;
    const rating = ratingFrom(
      (await pool.query('SELECT uid, name, test, points, awards FROM online_results ORDER BY season_id DESC')).rows)
      .find((x) => x.uid === id) || null;
    const events = (await pool.query('SELECT type, data, ts FROM events WHERE user_id=$1 ORDER BY ts DESC LIMIT 20', [id])).rows;
    const wallet = (await pool.query('SELECT balance FROM wallets WHERE uid=$1', [id])).rows[0] || null;
    const ops = (await pool.query('SELECT delta, comment, created_at FROM wallet_ops WHERE uid=$1 ORDER BY id DESC LIMIT 20', [id])).rows;
    const clubs = online ? await online.userClubs(id) : [];
    return { user: u, rating, results: resRows, events, wallet: wallet ? wallet.balance : 0, walletOps: ops, clubs };
  });
  app.post('/api/admin/users/:id/ban', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const banned = !!req.body?.banned;
    const reason = banned ? String(req.body?.reason || '').slice(0, 300) : null;
    const r = await pool.query('UPDATE users SET banned=$2, ban_reason=$3 WHERE id=$1 RETURNING id', [id, banned, reason]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'no_user' });
    await alog(req, banned ? 'ban' : 'unban', id, { reason });
    return { ok: true, banned };
  });
  app.post('/api/admin/users/:id/rename', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return reply.code(400).send({ error: 'bad_name' });
    const r = await pool.query('UPDATE users SET first_name=$2 WHERE id=$1 RETURNING id', [id, name]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'no_user' });
    await alog(req, 'rename', id, { name });
    return { ok: true, name };
  });
  // удаление аккаунта: клубы активных сезонов уходят боту, привязки и личные данные стираются,
  // строки рейтинга сохраняются для истории под именем «Удалённый аккаунт»
  app.post('/api/admin/users/:id/delete', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const u = (await pool.query('SELECT id FROM users WHERE id=$1', [id])).rows[0];
    if (!u) return reply.code(404).send({ error: 'no_user' });
    const clubs = online ? await online.dropUser(id) : 0;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM devices WHERE user_id=$1', [id]);
      await c.query('DELETE FROM link_codes WHERE user_id=$1', [id]);
      await c.query('DELETE FROM saves WHERE user_id=$1', [id]);
      await c.query('DELETE FROM events WHERE user_id=$1', [id]);
      await c.query('UPDATE wallets SET balance=0 WHERE uid=$1', [id]);
      await c.query("UPDATE online_results SET name='Удалённый аккаунт' WHERE uid=$1", [id]);
      await c.query("UPDATE users SET tg_id=NULL, first_name='Удалённый аккаунт', username=NULL, banned=false, ban_reason=NULL WHERE id=$1", [id]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    await alog(req, 'delete_user', id, { clubs });
    return { ok: true, clubs };
  });
  app.post('/api/admin/users/:id/wallet', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    const id = Number(req.params.id);
    const delta = Math.round(Number(req.body?.delta));
    const comment = String(req.body?.comment || '').trim().slice(0, 200) || null;
    if (!Number.isFinite(delta) || delta === 0) return reply.code(400).send({ error: 'bad_delta' });
    const u = (await pool.query('SELECT id FROM users WHERE id=$1', [id])).rows[0];
    if (!u) return reply.code(404).send({ error: 'no_user' });
    await pool.query('INSERT INTO wallets (uid, balance) VALUES ($1,0) ON CONFLICT (uid) DO NOTHING', [id]);
    const r = await pool.query('UPDATE wallets SET balance=balance+$2, updated_at=now() WHERE uid=$1 AND balance+$2>=0 RETURNING balance', [id, delta]);
    if (!r.rows[0]) return reply.code(409).send({ error: 'negative' });
    await pool.query('INSERT INTO wallet_ops (uid, delta, comment) VALUES ($1,$2,$3)', [id, delta, comment]);
    await alog(req, 'wallet', id, { delta, comment });
    return { ok: true, balance: r.rows[0].balance };
  });

  // ---------- админ-панель: турниры ----------
  app.get('/api/admin/seasons', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    if (!online) return reply.code(503).send({ error: 'online_disabled' });
    return { seasons: await online.adminSeasons() };
  });
  app.post('/api/admin/seasons', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    if (!online) return reply.code(503).send({ error: 'online_disabled' });
    const b = req.body || {};
    const cfgS = {
      template: b.template === 'big' ? 'big' : 'test8',
      name: String(b.name || '').trim().slice(0, 60) || (b.template === 'big' ? 'Большая лига' : 'Тестовый сезон'),
      start: b.start ? String(b.start) : null,
      test: b.test !== false,
    };
    if (b.fastSec) cfgS.fastSec = Math.max(1, Math.min(3600, Number(b.fastSec)));
    if (b.regTimes) cfgS.regTimes = String(b.regTimes).split(',').map((s) => s.trim()).filter((x) => /^\d{1,2}:\d{2}$/.test(x)).slice(0, 8);
    if (b.deadlineGame != null) cfgS.deadlineGame = Math.max(1, Math.min(81, Number(b.deadlineGame)));
    const r = await online.create(cfgS);
    await alog(req, 'season_create', r.id, cfgS);
    return r;
  });
  app.post('/api/admin/seasons/:sid/finish', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    if (!online) return reply.code(503).send({ error: 'online_disabled' });
    const r = await online.finishSeason(Number(req.params.sid));
    if (r.error) return reply.code(404).send(r);
    await alog(req, 'season_finish', req.params.sid, {});
    return r;
  });
  app.post('/api/admin/seasons/:sid/archive', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    if (!online) return reply.code(503).send({ error: 'online_disabled' });
    await online.archiveSeason(Number(req.params.sid));
    await alog(req, 'season_archive', req.params.sid, {});
    return { ok: true };
  });
  app.delete('/api/admin/seasons/:sid', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    if (!online) return reply.code(503).send({ error: 'online_disabled' });
    const r = await online.deleteSeason(Number(req.params.sid));
    if (r.error) return reply.code(409).send(r);
    await alog(req, 'season_delete', req.params.sid, {});
    return r;
  });
  app.post('/api/admin/seasons/:sid/tick', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    if (!online) return reply.code(503).send({ error: 'online_disabled' });
    const played = await online.tick();
    await alog(req, 'season_tick', req.params.sid, { played });
    return { played };
  });
  // снять игрока с клуба (клуб -> бот) или отдать клуб игроку
  app.post('/api/admin/seasons/:sid/human', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    if (!online) return reply.code(503).send({ error: 'online_disabled' });
    const sid = Number(req.params.sid), team = Number(req.body?.team);
    let r;
    if (req.body?.uid == null) {
      r = await online.setHuman(sid, team, null);
    } else {
      const uid = Number(req.body.uid);
      const u = (await pool.query('SELECT first_name, username FROM users WHERE id=$1', [uid])).rows[0];
      if (!u) return reply.code(404).send({ error: 'no_user' });
      r = await online.setHuman(sid, team, uid, u.first_name || u.username || 'Менеджер');
    }
    if (r.error) return reply.code(409).send(r);
    await alog(req, req.body?.uid == null ? 'season_kick' : 'season_give', sid, { team, uid: req.body?.uid ?? null });
    return r;
  });
  app.get('/api/admin/log', async (req, reply) => {
    if (!needAdmin(req, reply)) return;
    return { log: (await pool.query('SELECT id, action, target, payload, ip, created_at FROM admin_log ORDER BY id DESC LIMIT 200')).rows };
  });

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
