// Запуск: TEST_DATABASE_URL=postgres://... npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { buildApp } from '../src/app.js';
import { makePool, migrate } from '../src/db.js';
import { signInitData, verifyInitData, issueToken, readToken } from '../src/auth.js';
import { linkTelegram } from '../src/link.js';
import crypto from 'node:crypto';

const BOT = '123456:TEST_TOKEN';
const cfg = { botToken: BOT, sessionSecret: 'test-secret', adminKey: 'admin-key', corsOrigins: 'https://game.example', rateLimit: 10000 };
const url = process.env.TEST_DATABASE_URL;
let pool, app;

const initFor = (id, extra = {}) =>
  signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'q', user: JSON.stringify({ id, first_name: 'Тест', username: 'u' + id }), ...extra }, BOT);

before(async () => {
  pool = makePool(url);
  await pool.query('DROP TABLE IF EXISTS link_codes, devices, events, saves, users, _migrations CASCADE');
  await migrate(pool, { info() {} });
  app = buildApp({ pool, cfg, logger: false });
  await app.ready();
});
after(async () => { await app.close(); await pool.end(); });

test('initData: подпись, подделка, срок', () => {
  const ok = initFor(7);
  assert.equal(verifyInitData(ok, BOT).id, 7);
  assert.equal(verifyInitData(ok.replace('%D0%A2', '%D0%A3'), BOT), null, 'подменённые данные');
  assert.equal(verifyInitData(ok, '999:OTHER'), null, 'чужой бот');
  const old = signInitData({ auth_date: String(Math.floor(Date.now() / 1000) - 90000), user: JSON.stringify({ id: 7 }) }, BOT);
  assert.equal(verifyInitData(old, BOT), null, 'просрочено');
});

test('токен сессии', () => {
  const t = issueToken(5, 's');
  assert.equal(readToken(t, 's').uid, 5);
  assert.equal(readToken(t, 'x'), null);
  assert.equal(readToken(issueToken(5, 's', -10), 's'), null);
});

test('вход, сохранение, конфликт версий', async () => {
  let r = await app.inject({ method: 'POST', url: '/api/auth', payload: { initData: 'bad' } });
  assert.equal(r.statusCode, 401);
  r = await app.inject({ method: 'POST', url: '/api/auth', payload: { initData: initFor(1001) } });
  assert.equal(r.statusCode, 200);
  const a = r.json();
  assert.ok(a.token);
  assert.equal(a.save, null);
  assert.equal(a.user.created, true);
  const H = { authorization: 'Bearer ' + a.token };

  r = await app.inject({ method: 'GET', url: '/api/save', headers: H });
  assert.equal(r.statusCode, 204);

  const state = { v: 6, season: 2027, players: Array.from({ length: 2000 }, (_, i) => ({ id: i, f: 'Иван', l: 'Петров' })) };
  const gz = zlib.gzipSync(JSON.stringify(state));
  const meta = Buffer.from(JSON.stringify({ season: 2027, team: 'ЧЕР', day: 14 })).toString('base64');
  r = await app.inject({ method: 'PUT', url: '/api/save?base=0', headers: { ...H, 'content-type': 'application/octet-stream', 'x-meta': meta }, payload: gz });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ver, 1);

  // второе устройство пишет от старой версии -> конфликт
  r = await app.inject({ method: 'PUT', url: '/api/save?base=0', headers: { ...H, 'content-type': 'application/octet-stream' }, payload: gz });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().ver, 1);
  assert.equal(r.json().meta.team, 'ЧЕР');

  r = await app.inject({ method: 'PUT', url: '/api/save?base=1', headers: { ...H, 'content-type': 'application/octet-stream', 'x-meta': meta }, payload: gz });
  assert.equal(r.json().ver, 2);
  r = await app.inject({ method: 'PUT', url: '/api/save?base=0&force=1', headers: { ...H, 'content-type': 'application/octet-stream', 'x-meta': meta }, payload: gz });
  assert.equal(r.json().ver, 3, 'принудительная перезапись');

  r = await app.inject({ method: 'GET', url: '/api/save', headers: H });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['x-ver'], '3');
  assert.equal(JSON.parse(zlib.gunzipSync(r.rawPayload)).players.length, 2000);

  // повторный вход видит сохранение
  r = await app.inject({ method: 'POST', url: '/api/auth', payload: { initData: initFor(1001) } });
  assert.equal(r.json().save.ver, 3);
  assert.equal(r.json().save.meta.day, 14);
  assert.equal(r.json().user.created, false);

  // чужой игрок не видит сохранение
  r = await app.inject({ method: 'POST', url: '/api/auth', payload: { initData: initFor(2002) } });
  const H2 = { authorization: 'Bearer ' + r.json().token };
  r = await app.inject({ method: 'GET', url: '/api/save', headers: H2 });
  assert.equal(r.statusCode, 204);

  r = await app.inject({ method: 'GET', url: '/api/save' });
  assert.equal(r.statusCode, 401);
});

test('события и сводка', async () => {
  let r = await app.inject({ method: 'POST', url: '/api/auth', payload: { initData: initFor(3003) } });
  const H = { authorization: 'Bearer ' + r.json().token };
  r = await app.inject({ method: 'POST', url: '/api/events', headers: H, payload: { events: [{ t: 'open' }, { t: 'tour', d: { i: 1 } }, { t: 'hack', d: {} }] } });
  assert.equal(r.json().n, 2);
  r = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { authorization: 'Bearer nope' } });
  assert.equal(r.statusCode, 401);
  r = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { authorization: 'Bearer admin-key' } });
  const s = r.json();
  assert.equal(s.users, 3);
  assert.equal(s.saves, 1);
  assert.ok(s.events7d.find((e) => e.type === 'tour'));
  assert.equal(s.daily.length, 30);
  assert.ok(s.retention && 'cohort' in s.retention.d1);
  r = await app.inject({ method: 'GET', url: '/admin' });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Генменеджер · статистика/);
  r = await app.inject({ method: 'GET', url: '/privacy' });
  assert.match(r.body, /Политика конфиденциальности/);
});

test('CORS', async () => {
  let r = await app.inject({ method: 'OPTIONS', url: '/api/save', headers: { origin: 'https://game.example' } });
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers['access-control-allow-origin'], 'https://game.example');
  r = await app.inject({ method: 'OPTIONS', url: '/api/save', headers: { origin: 'https://evil.example' } });
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('приложение: вход по устройству и привязка Telegram', async () => {
  const dev = { id: crypto.randomBytes(16).toString('hex'), secret: crypto.randomBytes(32).toString('hex'), platform: 'android' };
  let r = await app.inject({ method: 'POST', url: '/api/auth/device', payload: { id: 'x', secret: 'y' } });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: 'POST', url: '/api/auth/device', payload: dev });
  const a = r.json();
  assert.equal(a.user.created, true);
  assert.equal(a.user.linked, false);
  const H = { authorization: 'Bearer ' + a.token };
  // чужой секрет не подходит
  r = await app.inject({ method: 'POST', url: '/api/auth/device', payload: { ...dev, secret: crypto.randomBytes(32).toString('hex') } });
  assert.equal(r.statusCode, 401);
  // повторный вход тем же устройством — тот же аккаунт
  r = await app.inject({ method: 'POST', url: '/api/auth/device', payload: dev });
  assert.equal(r.json().user.id, a.user.id);
  // сохранение с устройства
  const gz = zlib.gzipSync(JSON.stringify({ v: 6, season: 2026 }));
  r = await app.inject({ method: 'PUT', url: '/api/save?base=0', headers: { ...H, 'content-type': 'application/octet-stream' }, payload: gz });
  assert.equal(r.json().ver, 1);
  // код привязки
  r = await app.inject({ method: 'POST', url: '/api/link/start', headers: H });
  const { code, url } = r.json();
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.match(url, /t\.me\/hmrurubot\?start=link_/);
  // Telegram-игрок без сохранения: сохранение устройства переезжает к нему
  const res = await linkTelegram(pool, code, { id: 777001, first_name: 'Аня' });
  assert.equal(res.ok, true);
  assert.equal(res.moved, true);
  assert.equal((await linkTelegram(pool, code, { id: 777001 })).ok, false, 'код одноразовый');
  // старый токен устройства больше не работает
  r = await app.inject({ method: 'GET', url: '/api/save', headers: H });
  assert.equal(r.statusCode, 401);
  // новый вход устройства — уже Telegram-аккаунт с перенесённым сохранением
  r = await app.inject({ method: 'POST', url: '/api/auth/device', payload: dev });
  const b = r.json();
  assert.notEqual(b.user.id, a.user.id);
  assert.equal(b.user.linked, true);
  assert.equal(b.save.ver, 1);
  // вход через Telegram видит тот же аккаунт
  r = await app.inject({ method: 'POST', url: '/api/auth', payload: { initData: initFor(777001) } });
  assert.equal(r.json().user.id, b.user.id);
  // CORS для приложения
  r = await app.inject({ method: 'OPTIONS', url: '/api/save', headers: { origin: 'https://localhost' } });
  assert.equal(r.headers['access-control-allow-origin'], 'https://localhost');
});
