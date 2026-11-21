// Мультисезонное ядро: два сезона живут параллельно, слоты независимы, чемпионы разные,
// матчи и итоги пишутся в свои online_games/online_results, лимит сезонов на игрока,
// движок не держит скрытого состояния между сезонами. Без БД: pool — заглушка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOnline } from '../src/online.js';
import { loadGame } from '../src/engine.js';
import { createSeason, runDue, joinSeason } from '../src/league.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// детерминированный RNG: чемпионы/результаты стабильны между прогонами теста
let _seed = 42;
Math.random = () => {
  _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// заглушка базы: состояния сезонов — объектами (как jsonb у pg), матчи и итоги — в массивах
function stubPool() {
  const seasons = new Map(); // id -> {id, name, state, status}
  let nextId = 1;
  const games = [], results = [];
  const rowOf = (s) => ({ id: s.id, name: s.name, state: s.state, status: s.status });
  const pool = {
    games, results, seasons,
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
        games.push({ season_id: params[0], gid: params[1], slot: params[2], kind: params[3], h: params[5], a: params[6] });
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO online_results')) {
        results.push({ season_id: params[0], uid: params[1], team: params[2], club: params[3], name: params[4], test: params[5], place: params[6], po_rounds: params[7], derby_w: params[8], points: params[9], profit: params[10], awards: JSON.parse(params[11]) });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT uid, name, test, points, awards FROM online_results')) {
        return { rows: results.slice().reverse().map((r) => ({ uid: r.uid, name: r.name, test: r.test, points: r.points, awards: r.awards })) };
      }
      if (sql.startsWith('SELECT r.season_id, s.name AS season')) {
        return { rows: results.filter((r) => r.uid === params[0]).map((r) => ({ season_id: r.season_id, season: seasons.get(r.season_id)?.name || '', club: r.club, place: r.place, po_rounds: r.po_rounds, derby_w: r.derby_w, points: r.points, test: r.test, awards: r.awards })).reverse() };
      }
      throw new Error('stub: неожиданный запрос: ' + sql.slice(0, 60));
    },
  };
  return pool;
}

const T0 = Date.parse('2026-11-21T00:00:00Z');
const pool = stubPool();
const online = makeOnline(pool, path.join(ROOT, 'index.html'), { info() {}, error() {} }, { maxSeasonsPerUser: 2 });

test('два сезона параллельно: независимые слоты, разные чемпионы, свои online_games и итоги', async () => {
  await online.init();
  const A = await online.create({ name: 'Тест: А', fastSec: 2, inactiveDays: 9999, test: false }, T0);
  const B = await online.create({ name: 'Тест: Б', big: true, fastSec: 2, inactiveDays: 9999, test: false }, T0);
  const C = await online.create({ name: 'Тест: В', fastSec: 2, inactiveDays: 9999, test: false }, T0);
  assert.equal(pool.seasons.size, 3, 'create больше не архивирует прежние сезоны');
  // один uid — один клуб внутри сезона, но можно играть в обоих сезонах
  assert.equal((await online.join('u1', 'Первый', 0, A.id, T0)).ok, true);
  assert.equal((await online.join('u1', 'Первый', 1, A.id, T0)).error, 'already', 'второй клуб в том же сезоне нельзя');
  assert.equal((await online.join('u1', 'Первый', 0, B.id, T0)).ok, true, 'в другом сезоне — можно');
  assert.equal((await online.join('u2', 'Второй', 1, A.id, T0)).ok, true);
  assert.equal((await online.join('u2', 'Второй', 1, B.id, T0)).ok, true);
  // лимит одновременных сезонов
  assert.equal((await online.join('u2', 'Второй', 0, C.id, T0)).error, 'seasons_max', 'уже в двух активных');
  // досрочное завершение А: чемпион — лидер таблицы, u1 освобождает место для третьего сезона
  const finA = await online.finishSeason(A.id, T0 + 1e3);
  assert.equal(finA.ok, true);
  assert.equal(pool.seasons.get(A.id).status, 'finished');
  assert.equal((await online.join('u1', 'Первый', 0, C.id, T0 + 2e3)).ok, true, 'лимит считает только активные сезоны');
  // слоты независимы: первый тик доигрывает ровно один слот каждого активного сезона
  const n1 = await online.tick(T0 + 62e3);
  assert.equal(n1, 4 + 16, '4 матча малый слот + 16 большого, доигранный сезон пропущен');
  assert.equal(pool.games.filter((g) => g.season_id === A.id).length, 0);
  assert.equal(pool.games.filter((g) => g.season_id === B.id).length, 16);
  assert.equal(pool.games.filter((g) => g.season_id === C.id).length, 4);
  const vB = await online.view('u1', B.id, T0 + 400e3);
  const vC = await online.view('u1', C.id, T0 + 400e3);
  assert.equal(vB.teams.reduce((s, t) => s + t.gp, 0), 32, 'у каждого клуба большого сезона сыгран один матч');
  assert.equal(vC.teams.reduce((s, t) => s + t.gp, 0), 8, 'и малого');
  assert.equal(vB.teams.length, 32);
  // досчитываем B и C до конца одним тиком (все слоты давно наступили)
  await online.tick(T0 + 500e3);
  const vB2 = await online.view(null, B.id, T0 + 700e3);
  const vC2 = await online.view(null, C.id, T0 + 700e3);
  assert.notEqual(vB2.champ, null, 'большой сезон доигран');
  assert.notEqual(vC2.champ, null, 'третий сезон доигран');
  assert.notEqual(vB2.champ, vC2.champ, 'чемпионы разных сезонов разные');
  assert.equal(vB2.champ >= 0 && vB2.champ < 32, true);
  assert.equal(vC2.champ >= 0 && vC2.champ < 8, true);
  assert.equal(pool.seasons.get(B.id).status, 'finished');
  assert.equal(pool.seasons.get(C.id).status, 'finished');
  // итоги по своим сезонам
  const resA = pool.results.filter((r) => r.season_id === A.id);
  const resB = pool.results.filter((r) => r.season_id === B.id);
  const resC = pool.results.filter((r) => r.season_id === C.id);
  assert.equal(resA.length, 2);
  assert.equal(resB.length, 2);
  assert.equal(resC.length, 1);
  assert.ok(resA.every((r) => r.place >= 1 && r.place <= 8));
  assert.ok(resB.every((r) => r.place >= 1 && r.place <= 32));
  // рейтинг агрегирует сезоны обоих размеров с затуханием
  const rt = await online.rating('u1');
  assert.equal(rt.history.length, 3, 'u1 играл в трёх сезонах');
  assert.ok(rt.me && rt.me.pts > 0);
  // завершённым сезонам больше не нужен тик
  assert.equal(await online.tick(T0 + 600e3), 0);
});

test('ленивая загрузка завершённых сезонов, архивирование и удаление', async () => {
  const fresh = makeOnline(pool, path.join(ROOT, 'index.html'), { info() {}, error() {} }, { maxSeasonsPerUser: 2 });
  await fresh.init();
  assert.equal(await fresh.latestOpen(T0 + 500e3), null, 'активных сезонов нет');
  const [sidA] = [...pool.seasons.keys()];
  const v = await fresh.view('u1', sidA, T0 + 700e3);
  assert.notEqual(v, null, 'завершённый сезон подгружается для просмотра');
  assert.notEqual(v.results, null, 'с итогами');
  assert.equal(await fresh.view('u1', 999, T0), null, 'несуществующий сезон — null');
  // архив
  await fresh.archiveSeason(sidA);
  assert.equal(pool.seasons.get(sidA).status, 'archived');
  assert.equal(await fresh.view('u1', sidA, T0), null, 'архивный сезон не отдаётся');
  // удалить завершённый нельзя, а пустой не начавшийся — можно
  const [sidB] = [...pool.seasons.keys()].filter((k) => k !== sidA);
  assert.equal((await fresh.deleteSeason(sidB)).error, 'not_empty');
  const D = await fresh.create({ name: 'Тест: удаление', fastSec: 2 }, T0);
  assert.equal((await fresh.deleteSeason(D.id)).ok, true);
  assert.equal(pool.seasons.has(D.id), false);
});

test('передача клуба боту и обратно во всех активных сезонах (dropUser)', async () => {
  const o2 = makeOnline(pool, path.join(ROOT, 'index.html'), { info() {}, error() {} }, { maxSeasonsPerUser: 3 });
  await o2.init();
  const E = await o2.create({ name: 'Тест: бот', fastSec: 2, inactiveDays: 9999 }, T0);
  const F = await o2.create({ name: 'Тест: бот 2', fastSec: 2, inactiveDays: 9999 }, T0);
  await o2.join('u9', 'Девятый', 2, E.id, T0);
  await o2.join('u9', 'Девятый', 3, F.id, T0);
  assert.equal(await o2.dropUser('u9'), 2, 'клубы ушли боту в обоих сезонах');
  const vE = await o2.view('u9', E.id, T0 + 1e3);
  assert.equal(vE.my.bot, true);
  assert.equal(vE.teams[2].human, null, 'клуб ведёт компьютер');
  // вернуть клуб человеку (админка)
  assert.equal((await o2.setHuman(E.id, 2, 'u9', 'Девятый', T0 + 2e3)).ok, true);
  const vE2 = await o2.view('u9', E.id, T0 + 3e3);
  assert.equal(vE2.my.bot, false);
  assert.equal((await o2.setHuman(E.id, 2, null, null, T0 + 4e3)).ok, true);
  assert.equal((await o2.setHuman(E.id, 2, null, null, T0 + 5e3)).error, 'already_bot');
});

test('движок: между сезонами не протекает состояние тренеров, стилей и планов', () => {
  const G = loadGame(path.join(ROOT, 'index.html'));
  const now = Date.now();
  const S1 = createSeason(G, { name: 'Изоляция 1', fastSec: 60, inactiveDays: 9999 }, now);
  const S2 = createSeason(G, { name: 'Изоляция 2', fastSec: 60, inactiveDays: 9999 }, now);
  joinSeason(S1, 0, 'iso-1', 'Первый', now);
  joinSeason(S2, 1, 'iso-2', 'Второй', now);
  // разные штабы и планы
  for (const t of S1.teams) { S1.online.staff[t.id].head.lead = 'FC'; S1.online.staff[t.id].head.good = ['PO', 'TR']; }
  for (const t of S2.teams) { S2.online.staff[t.id].head.lead = 'CA'; S2.online.staff[t.id].head.good = ['FC', 'PO']; }
  S1.online.humans[0].plans = { def: { sty: 'FC', risk: 3 } };
  const t = S1.online.slots[0].t + 61e3;
  runDue(G, S1, t);
  assert.equal(G.HOOK.sty[0], 'FC', 'планы первого сезона применились');
  assert.equal(G.HOOK.human[0], true);
  runDue(G, S2, t);
  // тренеры второго сезона, а не первого
  const exp = {};
  for (const tm of S2.teams) exp[tm.id] = { lead: 'CA', good: ['FC', 'PO'] };
  assert.deepEqual(JSON.parse(G.ev('JSON.stringify(globalThis.__coaches||{})')), exp);
  // множители стилей серии плей-офф не протекли в регулярку
  assert.deepEqual(JSON.parse(G.ev('JSON.stringify(globalThis.__styK||{})')), {});
  // планы и присутствие первого сезона не протекли
  assert.deepEqual(JSON.parse(JSON.stringify(G.HOOK.sty)), {});
  assert.deepEqual(JSON.parse(JSON.stringify(G.HOOK.tac)), {});
  assert.deepEqual(JSON.parse(JSON.stringify(G.HOOK.boost)), {});
  assert.deepEqual(JSON.parse(JSON.stringify(G.HOOK.human)), { 1: true });
});
