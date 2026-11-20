// Тренеры, спонсоры и большой сезон: создание лиги 32 клубов, FIT главного тренера,
// полный прогон, итоги спонсоров по конференциям, регрессия сезона 8 клубов. Без БД.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGame } from '../src/engine.js';
import { createSeason, runDue, joinSeason } from '../src/league.js';
import { marketTick } from '../src/market.js';
import { finalize } from '../src/awards.js';
import { scaleOf, physPlus, coachHooks, STAFF } from '../src/staff.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const G = loadGame(path.join(ROOT, 'index.html'));
const CFG_BIG = { big: true, name: 'Тест: большая лига', fastSec: 3, inactiveDays: 9999 };

function playSeason(S, now0) {
  const o = S.online;
  let now = now0, guard = 0;
  while (o.champ == null && guard++ < 900) { now += 1000; runDue(G, S, now); marketTick(S, now, G); }
  return now;
}

test('большой сезон: 32 клуба, 82 раунда по 16 матчей, у каждого 82 (41 дома)', () => {
  const S = createSeason(G, CFG_BIG, Date.now());
  const o = S.online;
  assert.equal(S.teams.length, 32);
  const reg = o.slots.filter((s) => s.kind === 'reg');
  assert.equal(reg.length, 82);
  assert.ok(reg.every((s) => s.games.length === 16));
  const cnt = {}, home = {};
  for (const s of reg) for (const g of s.games) { cnt[g.h] = (cnt[g.h] || 0) + 1; cnt[g.a] = (cnt[g.a] || 0) + 1; home[g.h] = (home[g.h] || 0) + 1; }
  assert.ok(Object.values(cnt).every((n) => n === 82));
  assert.ok(Object.values(home).every((n) => n === 41));
  // штаб и спонсоры
  assert.ok(S.teams.every((t) => o.staff[t.id] && o.staff[t.id].head && o.staff[t.id].phys));
  assert.equal((o.staffFA || []).length, STAFF.marketHead + STAFF.marketPhys);
  assert.ok(S.teams.every((t) => (o.sponOff[t.id] || []).length === 3 && o.spon[t.id] && o.spon[t.id].tier === 'B'));
  const offB = o.sponOff[0].find((x) => x.tier === 'B');
  assert.equal(offB.req, 8); // топ-8 конференции = выход в плей-офф
  assert.match(offB.reqTxt, /конференции/);
});

test('главный тренер усиливает FIT любимого стиля (×1.2), зеркало остаётся 1:1', () => {
  let pair = null;
  for (const yh of ['FC', 'PO', 'TR', 'CA']) for (const ya of ['FC', 'PO', 'TR', 'CA']) if (G.ev(`styM('${yh}','${ya}')`) === 1 && !pair) pair = [yh, ya];
  assert.ok(pair, 'не нашли незеркальный матчап');
  const [YH, YA] = pair;
  G.ev('globalThis.__coaches={};globalThis.__styK={};');
  const base = G.ev(`styMul('${YH}','${YA}',0.8,0.8,0,1)`);
  G.ev(`globalThis.__coaches={0:{lead:'${YH}',good:['XX','YY']}};`);
  const withCoach = G.ev(`styMul('${YH}','${YA}',0.8,0.8,0,1)`);
  assert.ok(withCoach[0] > base[0]);
  const expected = (1 + (0.13 + 0.13 * Math.min(1, 0.8 * 1.2))) * (1 + 0.1 * (Math.min(1, 0.8 * 1.2) - 0.5));
  assert.ok(Math.abs(withCoach[0] - expected) < 1e-9);
  const mirror = G.ev(`styMul('${YH}','${YH}',0.8,0.8,0,1)`);
  assert.ok(mirror[0] === 1 && mirror[1] === 1);
  G.ev('globalThis.__coaches={};');
});

test('полный прогон большого сезона: плей-офф 8+8, форма, спонсоры по конференциям', () => {
  const now0 = Date.now();
  const S = createSeason(G, CFG_BIG, now0);
  const o = S.online;
  joinSeason(S, 5, 'u-test-1', 'Тест Тестов', now0);
  const now = playSeason(S, now0);
  assert.notEqual(o.champ, null);
  assert.equal(o.po.rounds.length, 4);
  assert.equal(o.po.rounds[0].length, 8);
  assert.equal(o.po.rounds[3].length, 1);
  const f = o.po.rounds[3][0], W = o.cfg.seriesWins;
  assert.notEqual(S.teams[f.wa >= W ? f.a : f.b].conf, S.teams[f.wa >= W ? f.b : f.a].conf); // финал — между конференциями
  // шкала физика различается между клубами
  const scales = S.teams.map((t) => scaleOf(S, t.id));
  assert.ok(Math.min(...scales) < 0 && Math.max(...scales) >= STAFF.hotAt, `шкала ${Math.min(...scales)}..${Math.max(...scales)}`);
  const hooks = coachHooks(G, S);
  assert.ok(S.teams.every((t) => hooks[t.id] === physPlus(S, t.id)));
  assert.ok(S.teams.every((t) => o.spon[t.id].paid > 0)); // еженедельные выплаты
  // итоги: требование — топ-8 своей конференции, премия только выполнившим, идемпотентность
  const cash0 = S.teams.map((t) => o.fin[t.id].cash);
  finalize(G, S, now);
  assert.ok(o.results && o.results.rows.length === 1);
  const confPlace = {};
  for (const c of [0, 1]) o.seeds.filter((id) => S.teams[id].conf === c).forEach((id, i) => { confPlace[id] = i + 1; });
  for (const t of S.teams) {
    const r = o.spon[t.id].res;
    assert.ok(r, `нет итога спонсора у клуба ${t.id}`);
    assert.equal(r.met, confPlace[t.id] <= o.spon[t.id].req);
    assert.equal(r.pts, r.met ? o.spon[t.id].pts : 0);
    assert.equal(o.fin[t.id].cash - cash0[t.id], r.met ? o.spon[t.id].bonus : 0);
  }
  const cash1 = S.teams.map((t) => o.fin[t.id].cash);
  finalize(G, S, now);
  assert.ok(S.teams.every((t, i) => o.fin[t.id].cash === cash1[i]));
});

test('регрессия: тестовый сезон 8 клубов доигрывается до конца', () => {
  const now0 = Date.now();
  const S = createSeason(G, { name: 'Тест: малый', fastSec: 3, inactiveDays: 9999 }, now0);
  const o = S.online;
  assert.equal(S.teams.length, 8);
  assert.equal(o.slots.filter((s) => s.kind === 'reg').length, 28);
  joinSeason(S, 2, 'u-test-2', 'Пётр Петров', now0);
  const now = playSeason(S, now0);
  assert.notEqual(o.champ, null);
  assert.equal(o.po.rounds.length, 3);
  finalize(G, S, now);
  assert.equal(o.results.rows.length, 1);
  assert.ok(o.results.rows[0].sponsor);
  const offB = o.sponOff[0].find((x) => x.tier === 'B');
  assert.equal(offB.req, 4); // малая лига: место в общей таблице
  assert.match(offB.reqTxt, /регулярке/);
});
