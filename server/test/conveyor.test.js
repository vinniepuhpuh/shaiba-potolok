// Конвейер открытых лиг: автосоздание следующей лиги, когда открытых не осталось.
// Без БД: pool-заглушка с настройками, детерминированный RNG (по образцу seasons.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOnline } from '../src/online.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let _seed = 7;
Math.random = () => {
  _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// заглушка базы: сезоны + матчи/итоги + настройки (таблица settings)
function stubPool() {
  const seasons = new Map(); // id -> {id, name, state, status}
  const settings = new Map(); // key -> value (объекты, как jsonb у pg)
  let nextId = 1;
  const games = [], results = [];
  const pool = {
    games, results, seasons, settings,
    async query(sql, params = []) {
      if (sql.startsWith("SELECT id, state FROM online_seasons WHERE status = 'active'")) {
        return { rows: [...seasons.values()].filter((s) => s.status === 'active').map((s) => ({ id: s.id, state: s.state })) };
      }
      if (sql.startsWith("SELECT id, state FROM online_seasons WHERE id=$1")) {
        const s = seasons.get(params[0]);
        return { rows: s && s.status !== 'archived' ? [{ id: s.id, state: s.state }] : [] };
      }
      if (sql.startsWith('SELECT id FROM online_seasons ORDER BY id DESC LIMIT 1')) {
        const ids = [...seasons.keys()];
        return { rows: ids.length ? [{ id: Math.max(...ids) }] : [] };
      }
      if (sql.startsWith("SELECT id FROM online_seasons WHERE (state->'online'->'cfg'->>'conveyor')")) {
        const ids = [...seasons.values()].filter((s) => s.state.online && s.state.online.cfg && s.state.online.cfg.conveyor === true)
          .map((s) => s.id).sort((a, b) => b - a).slice(0, 20).map((id) => ({ id }));
        return { rows: ids };
      }
      if (sql.startsWith('SELECT name FROM online_seasons WHERE name LIKE')) {
        return { rows: [...seasons.values()].filter((s) => s.name.startsWith('Большая лига №')).map((s) => ({ name: s.name })) };
      }
      if (sql.startsWith('SELECT EXISTS (SELECT 1 FROM jsonb_each')) {
        const list = [...seasons.values()].filter((s) => s.status !== 'archived' && s.state.online && s.state.online.cfg && s.state.online.cfg.conveyor === true)
          .sort((a, b) => b.id - a.id).slice(0, 1);
        if (!list.length) return { rows: [] };
        const had = Object.values(list[0].state.online.humans || {}).some((h) => h && h.bot !== true);
        return { rows: [{ had_humans: had }] };
      }
      if (sql.startsWith('SELECT key, value FROM settings')) {
        return { rows: [...settings.entries()].map(([key, value]) => ({ key, value })) };
      }
      if (sql.startsWith('INSERT INTO settings')) {
        settings.set(params[0], typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]);
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO online_seasons')) {
        const id = nextId++;
        seasons.set(id, { id, name: params[0], state: JSON.parse(params[1]), status: 'active' });
        return { rows: [{ id }] };
      }
      if (sql.startsWith('UPDATE online_seasons SET state=$2, updated_at=now(), status=$3')) {
        const s = seasons.get(params[0]); s.state = JSON.parse(params[1]); s.status = params[2];
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE online_seasons SET state=$2 WHERE id=$1')) {
        seasons.get(params[0]).state = JSON.parse(params[1]);
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE online_seasons SET status='archived'")) {
        seasons.get(params[0]).status = 'archived';
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM online_games')) { for (let i = games.length - 1; i >= 0; i--) if (games[i].season_id === params[0]) games.splice(i, 1); return { rows: [] }; }
      if (sql.startsWith('DELETE FROM online_seasons')) { seasons.delete(params[0]); return { rows: [] }; }
      if (sql.startsWith('INSERT INTO online_games')) {
        games.push({ season_id: params[0], gid: params[1] });
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO online_results')) { results.push({ season_id: params[0], uid: params[1] }); return { rows: [] }; }
      throw new Error('stub: неожиданный запрос: ' + sql.slice(0, 70));
    },
  };
  return pool;
}

const T0 = Date.parse('2026-11-23T00:00:00Z');
const html = path.join(ROOT, 'index.html');
const mk = (pool, opts = {}) => makeOnline(pool, html, { info() {}, error() {} }, opts);

test('нет открытых лиг + конвейер включён + в предыдущей были живые → создаётся следующая', async () => {
  const pool = stubPool();
  pool.settings.set('conveyor.enabled', true);
  const online = mk(pool);
  await online.init();
  assert.equal(pool.seasons.size, 1, 'init сразу создал первую лигу конвейера');
  const s1 = pool.seasons.get(1);
  assert.equal(s1.name, 'Большая лига №1');
  assert.equal(s1.state.online.cfg.conveyor, true, 'флаг conveyor в конфиге');
  assert.equal(s1.state.online.cfg.test, false, 'боевой сезон');
  assert.equal(s1.state.online.cfg.template, 'big');
  assert.equal(s1.state.teams.length, 32);
  // повторный тик не плодит дубль: №1 открыта (0 из 32 занято)
  await online.tick(T0 + 5e3);
  assert.equal(pool.seasons.size, 1, 'открытая лига есть — новая не нужна');
  // заполняем №1 людьми до конца → она перестаёт быть открытой → следующий тик создаёт №2
  for (let i = 0; i < 32; i++) assert.equal((await online.join('bot' + i, 'Игрок ' + i, i, s1.id, T0 + 6e3)).ok, true);
  await online.tick(T0 + 7e3);
  assert.equal(pool.seasons.size, 2, 'заполненная лига породила следующую');
  const s2 = pool.seasons.get(2);
  assert.equal(s2.name, 'Большая лига №2');
  assert.equal(s2.state.online.cfg.conveyor, true);
  await online.tick(T0 + 8e3);
  assert.equal(pool.seasons.size, 2, 'и снова повторный тик без дубля');
});

test('открытая лига уже есть → конвейер ничего не создаёт', async () => {
  const pool = stubPool();
  const online = mk(pool);
  await online.init();
  await online.create({ name: 'Ручная лига', fastSec: 2 }, T0); // открытая лига
  pool.settings.set('conveyor.enabled', true);
  await online.tick(T0 + 1e3);
  assert.equal(pool.seasons.size, 1, 'открытая ручная лига закрыла потребность конвейера');
});

test('предыдущая конвейерная лига без живых игроков → следующая не создаётся', async () => {
  const pool = stubPool();
  const online = mk(pool);
  await online.init();
  const A = await online.create({ conveyor: true, name: 'Пустая конвейерная', fastSec: 2 }, T0);
  await online.finishSeason(A.id, T0 + 1e3); // закончилась, никого не было
  pool.settings.set('conveyor.enabled', true);
  await online.tick(T0 + 2e3);
  assert.equal(pool.seasons.size, 1, 'пустая лига не плодит пустую');
});

test('конвейер выключен → лиги не создаются', async () => {
  const pool = stubPool(); // conveyor.enabled не задан — дефолт false
  const online = mk(pool);
  await online.init();
  await online.tick(T0);
  assert.equal(pool.seasons.size, 0);
});

test('init создаёт лигу, если открытых нет, а последняя конвейерная была с живыми', async () => {
  const pool = stubPool();
  const online = mk(pool);
  await online.init();
  const A = await online.create({ conveyor: true, name: 'Большая лига №7', fastSec: 2 }, T0);
  await online.join('u1', 'Первый', 0, A.id, T0);
  await online.finishSeason(A.id, T0 + 1e3);
  pool.settings.set('conveyor.enabled', true);
  // «перезапуск сервера»: свежий реестр, init должен проверить конвейер
  const online2 = mk(pool);
  await online2.init();
  assert.equal(pool.seasons.size, 2, 'init досоздал лигу');
  assert.equal(pool.seasons.get(2).name, 'Большая лига №8', 'нумерация продолжилась от существующих имён');
});

test('наследование академии берётся из последней конвейерной лиги, а не из последней по id', async () => {
  const pool = stubPool();
  const online = mk(pool);
  await online.init();
  // конвейерная А: у клуба 0 (lg=8) один воспитанник
  const A = await online.create({ conveyor: true, name: 'Конвейер А', fastSec: 2, inactiveDays: 9999 }, T0);
  await online.join('u1', 'Первый', 0, A.id, T0);
  assert.equal((await online.search('u1', {}, A.id, T0)).ok, true);
  const acA = await online.academy('u1', A.id, T0);
  assert.equal((await online.take('u1', { id: acA.cands[0].id, to: 'acad' }, A.id, T0)).ok, true);
  // ручной Б (последний по id): у клуба 1 (lg=0) свой воспитанник
  const B = await online.create({ name: 'Ручной Б', fastSec: 2, inactiveDays: 9999 }, T0);
  await online.join('u2', 'Второй', 1, B.id, T0);
  assert.equal((await online.search('u2', {}, B.id, T0)).ok, true);
  const acB = await online.academy('u2', B.id, T0);
  assert.equal((await online.take('u2', { id: acB.cands[0].id, to: 'acad' }, B.id, T0)).ok, true);
  const lgA = pool.seasons.get(A.id).state.teams[0].lg, lgB = pool.seasons.get(B.id).state.teams[1].lg;
  assert.notEqual(lgA, lgB, 'клубы разные — по ним и отличим донора');
  // новая конвейерная C: донор — А (конвейерная), а не Б (последний по id)
  const C = await online.create({ conveyor: true, name: 'Конвейер В', fastSec: 2 }, T0);
  const cState = pool.seasons.get(C.id).state;
  const acad = cState.players.filter((p) => p.team === -5);
  assert.equal(acad.length, 1, 'унаследован ровно один воспитанник (из А, а не А+Б)');
  const tidA = cState.teams.find((t) => t.lg === lgA).id, tidB = cState.teams.find((t) => t.lg === lgB).id;
  assert.equal(acad[0].acadTid, tidA, 'воспитанник перешёл к клубу с lg конвейерной А');
  assert.notEqual(acad[0].acadTid, tidB);
  // ручной сезон по-прежнему наследует от последнего по id (C)
  const D = await online.create({ name: 'Ручной Г', fastSec: 2 }, T0);
  assert.ok(D.inherited >= 1, 'ручной донор — последний по id (конвейерная C)');
});
