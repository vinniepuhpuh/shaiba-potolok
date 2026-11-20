// Запуск: TEST_DATABASE_URL=postgres://... npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { buildApp } from '../src/app.js';
import { makePool, migrate } from '../src/db.js';
import { signInitData, verifyInitData, issueToken, readToken } from '../src/auth.js';
import { linkTelegram } from '../src/link.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOnline } from '../src/online.js';

const BOT = '123456:TEST_TOKEN';
const cfg = { botToken: BOT, sessionSecret: 'test-secret', adminKey: 'admin-key', corsOrigins: 'https://game.example', rateLimit: 10000 };
const url = process.env.TEST_DATABASE_URL;
let pool, app;

const initFor = (id, extra = {}) =>
  signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'q', user: JSON.stringify({ id, first_name: 'Тест', username: 'u' + id }), ...extra }, BOT);

before(async () => {
  pool = makePool(url);
  await pool.query('DROP TABLE IF EXISTS online_results, online_games, online_seasons, link_codes, devices, events, saves, users, _migrations CASCADE');
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

test('онлайн: потолок растёт на $1M в сутки, рейтинг с затуханием', async () => {
  const { loadGame } = await import('../src/engine.js');
  const { createSeason } = await import('../src/league.js');
  const { marketTick } = await import('../src/market.js');
  const { ratingFrom } = await import('../src/awards.js');
  const html = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../index.html');
  const G = loadGame(html);
  const S = createSeason(G, { start: '2026-12-01' }, Date.parse('2026-11-30T10:00:00Z'));
  const cap0 = S.cap, t1 = S.online.slots[0].t;
  marketTick(S, t1 - 3600e3);
  assert.equal(S.cap, cap0, 'до начала сезона не растёт');
  marketTick(S, t1 + 3600e3);
  assert.equal(S.cap, cap0, 'в первый день — без роста');
  marketTick(S, t1 + 2 * 864e5);
  assert.equal(S.cap, cap0 + 2000, 'через двое суток +$2M');
  marketTick(S, t1 + 2 * 864e5 + 3600e3);
  assert.equal(S.cap, cap0 + 2000, 'в течение суток один раз');
  marketTick(S, t1 + 60 * 864e5);
  const faDays = Math.round((Date.parse(new Date(S.online.slots.filter((x) => x.kind === 'reg').pop().t + 3 * 3600e3).toISOString().slice(0, 10)) - Date.parse('2026-12-01')) / 864e5);
  assert.equal(S.cap, cap0 + faDays * 1000, 'после закрытия рынка агентов не растёт');
  const rows = [
    { uid: 1, name: 'A', test: false, points: 30, awards: ['champ'] }, { uid: 2, name: 'B', test: false, points: 40, awards: [] },
    { uid: 1, name: 'A', test: false, points: 30, awards: ['genius'] }, { uid: 2, name: 'B', test: true, points: 99, awards: [] },
  ];
  const r = ratingFrom(rows);
  assert.equal(r[0].uid, 1); assert.equal(r[0].pts, 55.5); assert.equal(r[0].champs, 1); assert.equal(r[0].awards, 1);
  assert.equal(r[1].pts, 40, 'тестовый сезон не считается');
});

test('онлайн-сезон: создание, вход, расчёт, трансляция', async () => {
  const html = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../index.html');
  const online = makeOnline(pool, html, { info() {}, error() {} });
  await online.init();
  const oapp = buildApp({ pool, cfg, logger: false, online });
  await oapp.ready();
  try {
    let r = await oapp.inject({ method: 'GET', url: '/api/online' });
    assert.equal(r.statusCode, 404, 'сезона ещё нет');
    r = await oapp.inject({ method: 'POST', url: '/api/admin/online/create', payload: { fastSec: 60 } });
    assert.equal(r.statusCode, 401);
    r = await oapp.inject({ method: 'POST', url: '/api/admin/online/create', headers: { authorization: 'Bearer admin-key' }, payload: { fastSec: 60 } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().slots, 28);
    r = await oapp.inject({ method: 'GET', url: '/api/online' });
    const v = r.json();
    assert.equal(v.teams.length, 8);
    assert.ok(v.canJoin);
    // вход
    const a = (await oapp.inject({ method: 'POST', url: '/api/auth', payload: { initData: initFor(900) } })).json();
    const H = { authorization: 'Bearer ' + a.token };
    r = await oapp.inject({ method: 'POST', url: '/api/online/join', headers: H, payload: { team: 3 } });
    assert.equal(r.json().ok, true);
    r = await oapp.inject({ method: 'POST', url: '/api/online/join', headers: H, payload: { team: 4 } });
    assert.equal(r.statusCode, 409, 'второй клуб нельзя');
    const b = (await oapp.inject({ method: 'POST', url: '/api/auth', payload: { initData: initFor(901) } })).json();
    r = await oapp.inject({ method: 'POST', url: '/api/online/join', headers: { authorization: 'Bearer ' + b.token }, payload: { team: 3 } });
    assert.equal(r.json().error, 'taken');
    r = await oapp.inject({ method: 'GET', url: '/api/online', headers: H });
    assert.equal(r.json().my.team, 3);
    assert.equal(r.json().teams[3].human.name, 'Тест');
    // состав, план, звенья
    r = await oapp.inject({ method: 'GET', url: '/api/online/team/3', headers: H });
    const tv = r.json();
    assert.ok(tv.mine && tv.players.length >= 20 && tv.players[0].pot != null && tv.lines.f.length === 4);
    assert.ok(tv.cap > 0 && tv.pay > 0 && tv.pay <= tv.cap && tv.n >= 20);
    r = await oapp.inject({ method: 'GET', url: '/api/online/team/4', headers: H });
    assert.ok(!r.json().mine && r.json().players[0].pot === undefined, 'чужой потенциал скрыт');
    r = await oapp.inject({ method: 'POST', url: '/api/online/plan', headers: H, payload: { key: 'def', plan: { sty: 'FC', risk: 4, pull: false } } });
    assert.equal(r.json().plans.def.sty, 'FC');
    r = await oapp.inject({ method: 'POST', url: '/api/online/plan', headers: H, payload: { key: 'def', plan: { sty: 'XX' } } });
    assert.equal(r.statusCode, 409);
    r = await oapp.inject({ method: 'POST', url: '/api/online/lines', headers: H, payload: { mode: 'combo' } });
    assert.ok(r.json().ok);
    const Lc = r.json().lines; const sw = Lc.f[0][0]; Lc.f[0][0] = Lc.f[1][0]; Lc.f[1][0] = sw;
    r = await oapp.inject({ method: 'POST', url: '/api/online/lines', headers: H, payload: { lines: Lc } });
    assert.equal(r.json().lines.f[0][0], Lc.f[0][0]);
    const bad = JSON.parse(JSON.stringify(Lc)); bad.f[0][1] = bad.f[0][0];
    r = await oapp.inject({ method: 'POST', url: '/api/online/lines', headers: H, payload: { lines: bad } });
    assert.equal(r.statusCode, 409, 'повтор игрока');
    // рынок
    r = await oapp.inject({ method: 'GET', url: '/api/online/market', headers: H });
    let mk = r.json();
    assert.ok(mk.open.fa && mk.open.trade && mk.fa.length > 10 && mk.my.team === 3);
    const room = mk.my.cap - mk.my.pay;
    const fa = mk.fa.find((p) => p.ask <= room) || mk.fa[mk.fa.length - 1];
    r = await oapp.inject({ method: 'POST', url: '/api/online/bid', headers: H, payload: { id: fa.id, sal: Math.min(room, Math.round(fa.ask * 1.3 / 10) * 10) } });
    assert.ok(r.json().ok, r.body);
    // поиск молодых в академию: раз в 2 игровых дня, 5 кандидатов
    r = await oapp.inject({ method: 'POST', url: '/api/online/search', headers: H });
    assert.ok(r.json().ok, r.body);
    r = await oapp.inject({ method: 'POST', url: '/api/online/search', headers: H });
    assert.equal(r.json().error, 'wait');
    const ac = (await oapp.inject({ method: 'GET', url: '/api/online/academy', headers: H })).json();
    assert.equal(ac.cands.length, 5, 'скауты привезли пятерых кандидатов');
    r = await oapp.inject({ method: 'GET', url: '/api/online/market' });
    assert.equal(r.json().my, null, 'без входа — без личного списка');
    // обмен с компьютером: даром не отдаёт, за сильного отдаёт слабого
    const t3 = (await oapp.inject({ method: 'GET', url: '/api/online/team/3', headers: H })).json();
    const t5 = (await oapp.inject({ method: 'GET', url: '/api/online/team/5', headers: H })).json();
    const best5 = t5.players.filter((p) => p.pos !== 'G').sort((a, b) => b.ovr - a.ovr)[0];
    r = await oapp.inject({ method: 'POST', url: '/api/online/trade/eval', headers: H, payload: { to: 5, give: [], get: [best5.id] } });
    assert.equal(r.json().deal, false);
    const sumSal = (ps) => ps.filter((p) => p.yrs > 0).reduce((x, p) => x + p.sal, 0);
    const room5 = mk.cap - sumSal(t5.players), room3 = mk.cap - sumSal(t3.players);
    let best3 = null, weak5 = null;
    for (const g of t3.players.filter((p) => p.pos !== 'G').sort((a, b) => b.ovr - a.ovr)) {
      const c = t5.players.filter((p) => p.pos !== 'G' && p.ovr <= g.ovr - 8 && g.sal - p.sal <= room5 && p.sal - g.sal <= room3).sort((a, b) => b.sal - a.sal)[0];
      if (c) { best3 = g; weak5 = c; break; }
    }
    assert.ok(best3, 'нашлась пара для обмена');
    r = await oapp.inject({ method: 'POST', url: '/api/online/trade', headers: H, payload: { to: 5, give: [best3.id], get: [weak5.id] } });
    assert.equal(r.json().accepted, true, r.body);
    // обмен с человеком: предложение → принятие
    const H2 = { authorization: 'Bearer ' + b.token };
    r = await oapp.inject({ method: 'POST', url: '/api/online/join', headers: H2, payload: { team: 6 } });
    assert.ok(r.json().ok);
    const t6 = (await oapp.inject({ method: 'GET', url: '/api/online/team/6', headers: H2 })).json();
    const cheap = (ps) => ps.filter((p) => p.pos !== 'G' && p.yrs > 0).sort((x, y) => x.sal - y.sal)[0];
    const a6 = cheap(t6.players), a3 = cheap((await oapp.inject({ method: 'GET', url: '/api/online/team/3', headers: H })).json().players);
    r = await oapp.inject({ method: 'POST', url: '/api/online/trade', headers: H, payload: { to: 6, give: [a3.id], get: [a6.id] } });
    assert.ok(r.json().pending, r.body);
    const tid = r.json().trade.id;
    r = await oapp.inject({ method: 'POST', url: '/api/online/trade/answer', headers: H, payload: { id: tid, action: 'accept' } });
    assert.equal(r.statusCode, 409, 'принимает только получатель');
    r = await oapp.inject({ method: 'POST', url: '/api/online/trade/answer', headers: H2, payload: { id: tid, action: 'accept' } });
    assert.ok(r.json().ok, r.body);
    const t6b = (await oapp.inject({ method: 'GET', url: '/api/online/team/6', headers: H2 })).json();
    assert.ok(t6b.players.some((p) => p.id === a3.id));
    // расторжение
    const cut = t6b.players.filter((p) => p.pos !== 'G').sort((a, b) => b.ovr - a.ovr)[0]; // сильнейший — точно в списке агентов
    r = await oapp.inject({ method: 'POST', url: '/api/online/release', headers: H2, payload: { id: cut.id } });
    assert.ok(r.json().ok && r.json().free && r.json().dead === 0 && r.json().freeRel === 2, r.body);
    mk = (await oapp.inject({ method: 'GET', url: '/api/online/market', headers: H2 })).json();
    assert.equal(mk.my.dead, 0);
    assert.equal(mk.my.freeRel, 2);
    const cutRow = mk.fa.find((p) => p.id === cut.id);
    assert.equal(cutRow && cutRow.rel, 'mine', 'свой расторгнутый помечен');
    // вернуть своего нельзя, другому человеку — только через 24 часа
    r = await oapp.inject({ method: 'POST', url: '/api/online/bid', headers: H2, payload: { id: cut.id, sal: mk.maxSal } });
    assert.equal(r.json().error, 'released_by_you', r.body);
    r = await oapp.inject({ method: 'POST', url: '/api/online/bid', headers: H, payload: { id: cut.id, sal: mk.maxSal } });
    assert.equal(r.json().error, 'released_lock', r.body);
    assert.equal(online.market(a.user.id, Date.now() + 25 * 3600e3).fa.find((p) => p.id === cut.id).rel, null, 'через 24 часа доступен');
    // ещё два бесплатных, четвёртое — половина зарплаты под потолком
    for (let k = 0; k < 3; k++) {
      const t6c = (await oapp.inject({ method: 'GET', url: '/api/online/team/6', headers: H2 })).json();
      const c2 = t6c.players.filter((p) => p.pos !== 'G' && p.yrs > 0).sort((x, y) => x.ovr - y.ovr)[0];
      r = await oapp.inject({ method: 'POST', url: '/api/online/release', headers: H2, payload: { id: c2.id } });
      if (r.statusCode === 409 && r.json().error === 'roster_min') break;
      if (k < 2) assert.ok(r.json().free && r.json().dead === 0, r.body);
      else assert.ok(!r.json().free && r.json().dead > 0 && r.json().freeRel === 0, r.body);
    }
    mk = (await oapp.inject({ method: 'GET', url: '/api/online/market', headers: H2 })).json();
    assert.equal(mk.my.dead, r.statusCode === 200 ? r.json().dead : 0);
    // финансы: касса, цены, арена
    r = await oapp.inject({ method: 'GET', url: '/api/online/fin', headers: H });
    let fv = r.json();
    assert.ok(fv.cash === 8000 && fv.arena === 1 && fv.cap === 15000 && fv.cost > 0 && fv.next, r.body);
    r = await oapp.inject({ method: 'POST', url: '/api/online/prices', headers: H, payload: { tix: { auto: false, price: 120 } } });
    assert.ok(r.json().ok && r.json().tix.price === 120 && !r.json().tix.auto, r.body);
    r = await oapp.inject({ method: 'POST', url: '/api/online/prices', headers: H, payload: { tix: { auto: false, price: 999 } } });
    assert.equal(r.json().error, 'bad_price');
    r = await oapp.inject({ method: 'POST', url: '/api/online/prices', headers: H, payload: { tix: { auto: true } } });
    assert.ok(r.json().tix.auto);
    r = await oapp.inject({ method: 'POST', url: '/api/online/arena', headers: H });
    assert.ok(r.json().ok && r.json().arena === 2 && r.json().cap === 16500, r.body);
    fv = (await oapp.inject({ method: "GET", url: "/api/online/fin", headers: H })).json();
    assert.equal(fv.cash, 8000 - fv.spent);
    r = await oapp.inject({ method: 'GET', url: '/api/online/fin' });
    assert.equal(r.statusCode, 401, 'финансы — только своего клуба');
    // дерби: у каждого есть соперник, пары взаимные, матчи отмечены
    const vd = (await oapp.inject({ method: 'GET', url: '/api/online' })).json();
    for (const t of vd.teams) assert.equal(vd.teams[t.rival].rival, t.id, 'пары дерби взаимные');
    const dg = vd.slots.flatMap((sl) => sl.games).filter((g) => g.derby);
    assert.equal(dg.length, 4 * 4, 'по 4 дерби у каждой из 4 пар');
    // первый игровой слот
    const first = v.slots[0];
    // отметка «на арене»: за минуту до начала
    const myG = first.games.find((g) => g.h === 3 || g.a === 3) || v.slots.flatMap((x) => x.games).find((g) => g.h === 3 || g.a === 3);
    const pr = await online.game(myG.id, v.slots.find((x) => x.games.includes(myG)).t - 30e3, a.user.id);
    assert.ok(pr.mine && pr.present && pr.started === false, JSON.stringify(pr));
    assert.equal(await online.tick(first.t + 30e3), 0, 'первая минута — выход команд');
    const n = await online.tick(first.t + 61e3);
    assert.equal(n, 4, 'четыре матча в слоте');
    const gid = first.games[0].id;
    // идёт трансляция: результата нет, тиков меньше полного
    const live = await online.game(gid, first.t + 120e3);
    assert.ok(live.started && !live.done && live.res === null);
    assert.ok(live.ticks.length > 0 && live.ticks.length < live.total);
    const vl = online.view(null, first.t + 120e3);
    assert.equal(vl.teams.reduce((s, t) => s + t.gp, 0), 0, 'таблица не раскрывает идущие матчи');
    // после окончания
    const fin = await online.game(gid, first.t + 11 * 60e3);
    assert.ok(fin.done && fin.res && fin.box && fin.rost && fin.gk.length === 2);
    assert.equal(fin.ticks.length, fin.total);
    // весь сезон до чемпиона
    await online.tick(first.t + 365 * 864e5);
    const end = online.view(null, first.t + 366 * 864e5);
    assert.ok(end.champ != null, 'есть чемпион');
    assert.equal(end.teams.reduce((s, t) => s + t.gp, 0), 8 * 28);
    // итоги: награды, очки, без id менеджеров в публичном виде
    const R = end.results;
    assert.ok(R && R.awards.sniper && R.awards.scorer && R.awards.goalie, JSON.stringify(R && R.awards));
    // «Финансовый гений» и «Специалист по дерби» — только среди активных менеджеров (тест перематывает год: оба ушли к боту)
    assert.equal(!!R.awards.genius, R.rows.some((x) => x.active));
    assert.equal(R.rows.length, 2);
    assert.ok(R.rows.every((x) => x.uid === undefined) && (!R.awards.genius || R.awards.genius.uid === undefined), 'id менеджеров не раскрываются');
    for (const x of R.rows) assert.equal(x.points, x.pts.place + x.pts.po + x.pts.derby);
    // в каждом клубе деньги за все матчи: ТВ за 28 матчей регулярки и больше
    const f3 = (await oapp.inject({ method: 'GET', url: '/api/online/fin', headers: H })).json();
    assert.ok(f3.inc.tv >= 28 * 400 && f3.inc.tix > 0 && f3.inc.jer > 0 && f3.closed, JSON.stringify(f3.inc));
    const dl = f3.log.filter((l) => l.derby && l.home);
    assert.ok(dl.every((l) => l.att === l.cap), 'на дерби полный зал');
    // рейтинг: тестовый сезон в него не идёт, но в истории менеджера есть
    r = await oapp.inject({ method: 'GET', url: '/api/online/rating', headers: H });
    const rt = r.json();
    assert.equal(rt.top.length, 0, 'тестовый сезон без рейтинга');
    assert.equal(rt.history.length, 1);
    assert.ok(rt.history[0].test);
    // перезапуск сервера поднимает сезон из базы
    const again = makeOnline(pool, html, { info() {}, error() {} });
    await again.init();
    assert.equal(again.view(null, first.t + 366 * 864e5).champ, end.champ);
  } finally { await oapp.close(); }
});

test('пуш-напоминания о матчах', async () => {
  const { createSeason, dueNotifications, preOf } = await import('../src/league.js');
  const { loadGame } = await import('../src/engine.js');
  const html = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../index.html');
  const G = loadGame(html);
  const now = Date.now();
  const S = createSeason(G, { fastSec: 3600 }, now); // слоты раз в час, первый через час
  S.online.humans[0] = { uid: 42, name: 'Тест' };
  const t0 = S.online.slots[0].t + preOf(S.online);
  assert.equal(dueNotifications(S, t0 - 11 * 60e3).length, 0, 'до окна пушей нет');
  const n1 = dueNotifications(S, t0 - 9 * 60e3);
  assert.equal(n1.length, 1, 'один менеджер — один пуш');
  assert.equal(n1[0].uid, 42);
  assert.match(n1[0].text, /Через 10 минут/);
  assert.equal(dueNotifications(S, t0 - 8 * 60e3).length, 0, 'повторно не шлём');
  assert.equal(dueNotifications(S, t0 + 60e3).length, 0, 'после старта слота не шлём');
  // клуб у бота — пушей нет
  S.online.humans[0].bot = true;
  const t1 = S.online.slots[1].t + preOf(S.online);
  assert.equal(dueNotifications(S, t1 - 9 * 60e3).length, 0, 'боту не шлём');
});

test('онлайн: академия, прокачки, торги вслепую', async () => {
  const { createSeason, joinSeason, runDue, preOf } = await import('../src/league.js');
  const { acadSearch, acadTake, acadPromote, buyUpg, bidFA, bidPoach, poachMatch, acadPlayers, inheritAcademy, ensureA } = await import('../src/academy.js');
  const { marketTick } = await import('../src/market.js');
  const { ensureFin } = await import('../src/fin.js');
  const { loadGame } = await import('../src/engine.js');
  const html = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../index.html');
  const G = loadGame(html);
  const now0 = Date.now();
  const S = createSeason(G, { fastSec: 10 }, now0); // игровой день = 40 сек
  const o = S.online;
  joinSeason(S, 3, 42, 'Тест', now0);
  joinSeason(S, 5, 43, 'Второй', now0);
  ensureA(S); ensureFin(S);
  // прокачки: деньги списываются, уровень растёт
  let r = buyUpg(G, S, 42, { kind: 'scout' }, now0);
  assert.equal(r.ok, true); assert.equal(r.lvl, 1);
  r = buyUpg(G, S, 42, { kind: 'acad' }, now0);
  assert.equal(r.lvl, 1);
  // поиск: 5 кандидатов, кулдаун
  assert.equal(acadSearch(G, S, 42, now0).ok, true);
  assert.equal(acadSearch(G, S, 42, now0 + 1000).error, 'wait');
  const cands = S.players.filter((p) => p.team === -4 && p.osTid === 3);
  assert.equal(cands.length, 5);
  assert.ok(cands.every((p) => p.pot > p.ovr && p.age >= 17 && p.age <= 19));
  // набор в академию и в основу
  assert.equal(acadTake(G, S, 42, { id: cands[0].id, to: 'acad' }, now0).ok, true);
  assert.equal(acadTake(G, S, 42, { id: cands[1].id, to: 'main' }, now0).ok, true);
  assert.equal(acadPlayers(S, 3).length, 1);
  assert.equal(acadPlayers(S, 3)[0].team, -5, 'в академии не в составе');
  // академия не под потолком: платёжка клуба не изменилась от игрока академии
  const kid = acadPlayers(S, 3)[0];
  assert.ok(kid.sal === 0 || kid.yrs === 0);
  // рост в академии за 4 слота
  for (let i = 0; i < 4; i++) { const sl = o.slots.find((s) => s.games.some((g) => !g.done)); runDue(G, S, sl.t + preOf(o)); }
  assert.ok(kid.gx > 0 || kid.ovr > kid.ovr0, 'идёт рост');
  // торги за свободного агента: ставки вслепую, выигрывает большая
  const fa = S.players.find((p) => p.team === -1);
  r = bidFA(G, S, 42, { id: fa.id, sal: 1000 }, now0);
  assert.equal(r.leading, true);
  r = bidFA(G, S, 43, { id: fa.id, sal: 1200 }, now0 + 1000);
  assert.equal(r.leading, true, 'перебил — лидирует');
  assert.equal(fa.team, -1, 'мгновенного подписания нет');
  marketTick(S, now0 + 50_000, G);
  assert.equal(fa.team, 5, 'после закрытия торгов агент у победителя');
  assert.equal(fa.sal, 1200);
  // переманивание: владелец повторяет ставку
  kid.acadSince = now0 - 100 * 864e5;
  assert.equal(bidPoach(G, S, 43, { id: kid.id, sal: 800 }, now0).ok, true);
  marketTick(S, now0 + 50_000, G);
  assert.equal(kid.team, -5, 'ещё в академии: стадия ответа владельца');
  r = poachMatch(G, S, 42, { id: kid.id }, now0 + 51_000);
  assert.equal(r.ok, true); assert.equal(kid.team, 3, 'владелец сохранил');
  // переманивание без ответа: игрок уходит, компенсация владельцу
  const kid2 = cands[2];
  acadTake(G, S, 42, { id: kid2.id, to: 'acad' }, now0);
  kid2.acadSince = now0 - 100 * 864e5;
  const cash5 = o.fin[5].cash, cash3 = o.fin[3].cash;
  bidPoach(G, S, 43, { id: kid2.id, sal: 900 }, now0 + 60_000);
  marketTick(S, now0 + 110_000, G); // торги закрыты
  marketTick(S, now0 + 140_000, G); // окно владельца истекло
  assert.equal(kid2.team, 5, 'игрок переманен');
  assert.ok(o.fin[3].cash > cash3, 'владельцу пришла компенсация');
  assert.ok(o.fin[5].cash < cash5, 'переманивший заплатил');
  // наследование: топ-2 академии переходят в новый сезон
  acadTake(G, S, 42, { id: cands[3].id, to: 'acad' }, now0);
  const S2 = createSeason(G, { fastSec: 10 }, now0 + 200 * 864e5);
  const n = inheritAcademy(G, S2, S, now0 + 200 * 864e5);
  assert.ok(n >= 2, `наследники перенесены: ${n}`);
  const inh = S2.players.filter((p) => p.team === -5);
  assert.ok(inh.every((p) => p.age >= 18), 'возраст +1 год');
});
