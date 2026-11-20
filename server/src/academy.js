// Академия и торги вслепую в онлайн-сезоне.
// Академия: скаут привозит 5 кандидатов раз в 2 игровых дня; игроки академии не занимают
// место в составе и под потолком, растут ускоренно. Не перевёл в основу за полсезона —
// игрока могут переманить: торги вслепую, у владельца право повторить лучшую ставку.
// Свободные агенты — тоже торги вслепую: мгновенного подписания больше нет.
// Деньги — в тысячах $, как в игре.

const MIN_ROSTER = 20, MAX_ROSTER = 26;

import { staffDay } from './staff.js';

export const UPG = {
  max: 5,
  cost: { scout: 1500, acad: 2000 }, // за уровень на формат 28 матчей; масштабируется по длине сезона
};
export const ACAD = {
  slots0: 6, slotsPerLvl: 2, // мест в академии: 6 + 2 за уровень
  growK: 1.2, growLvl: 0.15, // рост: ×1.2 от темпа первого звена, +15% за уровень академии
  poachDaysMin: 2, poachShare: 0.5, // окно до переманивания: половина дней регулярки (не меньше 2)
  gemBase: 0.03, gemPerLvl: 0.04, // шанс самородка: 3% + 4% за уровень скаутов
  comp0: 1000, compPerOvr: 200, // компенсация владельцу при переманивании
  candN: 5, searchCdDays: 2, // кандидатов за поиск и пауза между поисками
  aucDays: 1, matchDays: 0.5, // торги — игровой день, у владельца — полдня на повтор ставки
};

/** Длительность игрового дня в мс (в тестовых сезонах fastSec день = 4 слота). */
export const dayMs = (o) => (o.cfg.fastSec ? o.cfg.fastSec * 4000 : 864e5);
const regSlots = (o) => o.slots.filter((s) => s.kind === 'reg').length || 28;
const scaleK = (o) => regSlots(o) / 28; // масштаб цен под длину сезона

export function ensureA(S) {
  const o = S.online;
  o.upg = o.upg || {}; o.auc = o.auc || { fa: {}, po: {} }; o.sr = o.sr || {};
  return o;
}
export const lvl = (S, tid, kind) => (ensureA(S).upg[tid] || {})[kind] || 0;
export const acadCap = (S, tid) => ACAD.slots0 + ACAD.slotsPerLvl * lvl(S, tid, 'acad');
export const acadPlayers = (S, tid) => S.players.filter((p) => p.team === -5 && p.acadTid === tid);
export const potSpread = (S, tid) => Math.max(0, 5 - lvl(S, tid, 'scout'));
/** Окно, после которого игрока академии можно переманить. */
export const poachMs = (o) => Math.max(ACAD.poachDaysMin, Math.round((o.regDays || 7) * ACAD.poachShare)) * dayMs(o);
export const poachable = (S, p, now) => p.team === -5 && p.acadSince != null && now - p.acadSince >= poachMs(S.online);
export const upgCost = (S, kind) => Math.round(UPG.cost[kind] * scaleK(S.online) / 10) * 10;
const humanOf = (S, uid) => {
  const e = Object.entries(S.online.humans).find(([, h]) => h && h.uid === uid && !h.bot);
  return e ? { tid: +e[0], h: e[1] } : null;
};
/** Рынок закрывается с последним матчем регулярки (торги, поиск, переманивание). */
const faEndT = (o) => { const r = o.slots.filter((s) => s.kind === 'reg'); return r.length ? r[r.length - 1].t : Infinity; };
const marketOpen = (o, now) => !o.po && o.champ == null && now < faEndT(o);
const nm = (p) => (p.nat === 'CHN' ? p.f + ' ' + p.l : p.f[0] + '. ' + p.l);
const roster = (S, tid) => S.players.filter((p) => p.team === tid && p.yrs > 0);
const payOf = (G, S, tid) => G.ev('payroll')(tid) + ((S.online.dead || {})[tid] || 0);
function mlog(S, txt, now) { const o = S.online; o.mlog = o.mlog || []; o.mlog.unshift({ t: now, txt }); o.mlog.length = Math.min(o.mlog.length, 60); }
/** Контракт новичка при переводе из академии в основу. */
function rookieDeal(G, p) { return { sal: Math.max(G.ev('minSal')(), G.ev('rs')(G.ev('fair')(p.ovr) * 0.6)), yrs: 3 }; }
/** Диапазон потенциала по уровню скаутов смотрящего. */
export function potRangeOf(S, tid, p) {
  const s = potSpread(S, tid);
  return [Math.max(40, p.pot - s), Math.min(99, p.pot + s)];
}
const pubAcad = (S, viewerTid, p, exact) => ({
  id: p.id, f: p.f, l: p.l, nat: p.nat, pos: p.pos, pos2: p.pos2 || null, sd: p.sd || null, age: p.age, ovr: p.ovr,
  role: p.role || null, pot: exact ? p.pot : null, potR: exact ? null : potRangeOf(S, viewerTid, p),
  since: p.acadSince ?? null,
});

// ---------- прокачки ----------
export function buyUpg(G, S, uid, { kind }, now = Date.now()) {
  const o = ensureA(S);
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  if (o.champ != null) return { error: 'season_over' };
  if (!['scout', 'acad'].includes(kind)) return { error: 'bad_kind' };
  o.upg[me.tid] = o.upg[me.tid] || {};
  const cur = o.upg[me.tid][kind] || 0;
  if (cur >= UPG.max) return { error: 'max' };
  const f = o.fin[me.tid], c = upgCost(S, kind);
  if (f.cash < c) return { error: 'no_cash' };
  f.cash -= c; f.spent += c; o.upg[me.tid][kind] = cur + 1;
  mlog(S, `«${S.teams[me.tid].name}» улучшили ${kind === 'scout' ? 'скаутскую службу' : 'академию'} до уровня ${cur + 1}`, now);
  return { ok: true, kind, lvl: cur + 1, cash: f.cash };
}

/** Генерация кандидата в академию: разрыв потенциала умеренный — иначе за сезон все вырастут в звёзд. */
function makeCandidate(G, S, tid, gemC) {
  const t = S.teams[tid], ri = G.ev('ri'), R = Math.random;
  const w = (G.ev('TNW')[t.nat]) || G.ev('OSW');
  const gem = R() < gemC, x = R();
  const age = ri(17, 19);
  const ovr = gem ? ri(55, 62) : x < 0.6 ? ri(48, 55) : x < 0.9 ? ri(54, 60) : ri(59, 63);
  const p = G.ev('newPlayer')(G.ev('pick')(['C', 'LW', 'RW', 'D', 'D', 'C', 'LW', 'RW', 'G']), ovr, age, G.ev('pickW')(w));
  p.ovr = ovr;
  p.pot = Math.min(96, gem ? ovr + ri(10, 16) : ovr + ri(5, 10));
  p.ovr0 = p.ovr; p.pot0 = p.pot; p.gx = 0;
  p.team = -4; p.osTid = tid;
  return p;
}

// ---------- поиск кандидатов (замена «поиска за рубежом») ----------
export function acadSearch(G, S, uid, now = Date.now()) {
  const o = ensureA(S); G.S = S;
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  if (!marketOpen(o, now)) return { error: 'market_closed' };
  const cd = ACAD.searchCdDays * dayMs(o);
  if (now - (o.sr[me.tid] || 0) < cd) return { error: 'wait', next: o.sr[me.tid] + cd };
  S.players = S.players.filter((p) => !(p.team === -4 && p.osTid === me.tid));
  const gemC = ACAD.gemBase + ACAD.gemPerLvl * lvl(S, me.tid, 'scout');
  for (let i = 0; i < ACAD.candN; i++) S.players.push(makeCandidate(G, S, me.tid, gemC));
  o.sr[me.tid] = now;
  return { ok: true, next: now + cd };
}

/** Взять кандидата: to='acad' — в академию (бесплатно), to='main' — сразу в основу по контракту новичка. */
export function acadTake(G, S, uid, { id, to }, now = Date.now()) {
  const o = ensureA(S); G.S = S;
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  if (!marketOpen(o, now)) return { error: 'market_closed' };
  const p = S.players.find((x) => x.id === Number(id));
  if (!p || p.team !== -4 || p.osTid !== me.tid) return { error: 'gone' };
  if (to === 'acad') {
    if (acadPlayers(S, me.tid).length >= acadCap(S, me.tid)) return { error: 'acad_full' };
    p.team = -5; p.acadTid = me.tid; p.acadSince = now; delete p.osTid;
    mlog(S, `«${S.teams[me.tid].name}» взяли в академию ${nm(p)} (${p.ovr})`, now);
    return { ok: true, inAcad: true };
  }
  // сразу в основной состав
  if (roster(S, me.tid).length >= MAX_ROSTER) return { error: 'roster_full' };
  const d = rookieDeal(G, p);
  if (payOf(G, S, me.tid) + d.sal > S.cap) return { error: 'cap' };
  p.team = me.tid; p.sal = d.sal; p.yrs = d.yrs; delete p.osTid;
  G.ev('uniqName')(p, me.tid); G.ev('ensureNums')(me.tid); G.ev('inv()');
  mlog(S, `«${S.teams[me.tid].name}» подписали новичка ${nm(p)} (${p.ovr})`, now);
  return { ok: true, inAcad: false, player: p.id };
}

/** Перевод из академии в основной состав. */
export function acadPromote(G, S, uid, { id }, now = Date.now()) {
  const o = ensureA(S); G.S = S;
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  if (o.champ != null) return { error: 'season_over' };
  const p = S.players.find((x) => x.id === Number(id));
  if (!p || p.team !== -5 || p.acadTid !== me.tid) return { error: 'gone' };
  if (roster(S, me.tid).length >= MAX_ROSTER) return { error: 'roster_full' };
  const d = rookieDeal(G, p);
  if (payOf(G, S, me.tid) + d.sal > S.cap) return { error: 'cap' };
  p.team = me.tid; p.sal = d.sal; p.yrs = d.yrs; delete p.acadTid; delete p.acadSince;
  G.ev('uniqName')(p, me.tid); G.ev('ensureNums')(me.tid); G.ev('inv()');
  mlog(S, `«${S.teams[me.tid].name}» перевели в основу ${nm(p)} (${p.ovr})`, now);
  return { ok: true, player: p.id, sal: d.sal };
}

// ---------- торги вслепую ----------
const fitsRoster = (G, S, tid, sal) => roster(S, tid).length < MAX_ROSTER && payOf(G, S, tid) + sal <= S.cap;
export const topBid = (a) => Object.entries(a.bids).sort((x, y) => y[1].sal - x[1].sal || x[1].t - y[1].t)[0] || null;

function placeBid(S, auc, tid, sal, now) {
  auc.bids = auc.bids || {};
  const prev = auc.bids[tid];
  if (prev && sal <= prev.sal) return { error: 'bid_low' }; // повышать можно только вверх
  auc.bids[tid] = { sal, t: now };
  return { ok: true };
}

/** Ставка на свободного агента. Мгновенного подписания нет: игрок уходит лучшему предложению. */
export function bidFA(G, S, uid, { id, sal }, now = Date.now()) {
  const o = ensureA(S); G.S = S;
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  if (!marketOpen(o, now)) return { error: 'market_closed' };
  const p = S.players.find((x) => x.id === Number(id));
  if (!p || p.team !== -1) return { error: 'gone' };
  const r = p.orel;
  if (r && (r.tid === me.tid || now - r.t < 24 * 3600e3)) return { error: r.tid === me.tid ? 'released_by_you' : 'released_lock' };
  sal = Math.round(Number(sal) / 10) * 10;
  if (!(sal >= G.ev('minSal')() && sal <= G.ev('maxSal')())) return { error: 'bad_offer' };
  if (!fitsRoster(G, S, me.tid, sal)) return { error: 'cap' };
  o.auc.fa[p.id] = o.auc.fa[p.id] || { bids: {}, since: now };
  const a = o.auc.fa[p.id];
  const b = placeBid(S, a, me.tid, sal, now);
  if (b.error) return b;
  const top = topBid(a);
  return { ok: true, leading: top && +top[0] === me.tid, ends: a.since + ACAD.aucDays * dayMs(o) };
}

/** Ставка на игрока чужой академии (окно переманивания открылось). */
export function bidPoach(G, S, uid, { id, sal }, now = Date.now()) {
  const o = ensureA(S); G.S = S;
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  if (!marketOpen(o, now)) return { error: 'market_closed' };
  const p = S.players.find((x) => x.id === Number(id));
  if (!p || !poachable(S, p, now)) return { error: 'gone' };
  if (p.acadTid === me.tid) return { error: 'own' };
  sal = Math.round(Number(sal) / 10) * 10;
  if (!(sal >= G.ev('minSal')() && sal <= G.ev('maxSal')())) return { error: 'bad_offer' };
  if (!fitsRoster(G, S, me.tid, sal)) return { error: 'cap' };
  o.auc.po[p.id] = o.auc.po[p.id] || { bids: {}, since: now };
  const a = o.auc.po[p.id];
  if (a.stage === 'match') return { error: 'match_stage' };
  const b = placeBid(S, a, me.tid, sal, now);
  if (b.error) return b;
  const top = topBid(a);
  return { ok: true, leading: top && +top[0] === me.tid, ends: a.since + ACAD.aucDays * dayMs(o) };
}

/** Владелец повторяет лучшую ставку и оставляет игрока. */
export function poachMatch(G, S, uid, { id }, now = Date.now()) {
  const o = ensureA(S); G.S = S;
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  const p = S.players.find((x) => x.id === Number(id));
  if (!p || p.team !== -5 || p.acadTid !== me.tid) return { error: 'gone' };
  const a = o.auc.po[p.id];
  if (!a || a.stage !== 'match' || now > a.matchUntil) return { error: 'no_match' };
  if (!fitsRoster(G, S, me.tid, a.topSal)) return { error: 'cap' };
  signFromAuction(G, S, p, me.tid, a.topSal, now);
  delete o.auc.po[p.id];
  mlog(S, `«${S.teams[me.tid].name}» сохранили ${nm(p)}: повторили ставку $${(a.topSal / 1000).toFixed(1)}M`, now);
  return { ok: true, kept: true, sal: a.topSal };
}

function signFromAuction(G, S, p, tid, sal, now) {
  p.team = tid; p.sal = sal; p.yrs = Math.max(1, p.askY || 2); p.exp = false; p.faY = 0;
  delete p.acadTid; delete p.acadSince; delete p.osTid;
  G.ev('uniqName')(p, tid); G.ev('ensureNums')(tid); G.ev('inv()');
  const h = S.online.humans[tid]; if (h && h.lines) { h.lines = null; h.lmode = null; }
}

/** Компенсация владельцу академии при переманивании. */
function poachComp(p) { return ACAD.comp0 + Math.max(0, p.ovr - 60) * ACAD.compPerOvr; }

// ---------- тик: разрешение торгов и действия ботов ----------
function resolveAuctions(G, S, now) {
  const o = ensureA(S), aucMs = ACAD.aucDays * dayMs(o), matchMs = ACAD.matchDays * dayMs(o);
  // свободные агенты
  for (const [pid, a] of Object.entries(o.auc.fa)) {
    if (now - a.since < aucMs) continue;
    const p = S.players.find((x) => x.id === +pid);
    if (!p || p.team !== -1) { delete o.auc.fa[pid]; continue; }
    let done = false;
    for (const [tid, b] of Object.entries(a.bids).sort((x, y) => y[1].sal - x[1].sal || x[1].t - y[1].t)) {
      if (!fitsRoster(G, S, +tid, b.sal)) continue;
      signFromAuction(G, S, p, +tid, b.sal, now);
      mlog(S, `«${S.teams[+tid].name}» выиграли торги за ${nm(p)}: $${(b.sal / 1000).toFixed(1)}M в год`, now);
      done = true; break;
    }
    if (!done && Object.keys(a.bids).length) mlog(S, `Торги за ${nm(p)} сорвались: победитель не вписался в потолок`, now);
    delete o.auc.fa[pid];
  }
  // академия: ставки закрылись — хозяин решает
  for (const [pid, a] of Object.entries(o.auc.po)) {
    const p = S.players.find((x) => x.id === +pid);
    if (!p || p.team !== -5) { delete o.auc.po[pid]; continue; }
    if (a.stage !== 'match') {
      if (now - a.since < aucMs) continue;
      const top = topBid(a);
      if (!top) { delete o.auc.po[pid]; continue; }
      a.stage = 'match'; a.topTid = +top[0]; a.topSal = top[1].sal; a.matchUntil = now + matchMs;
      mlog(S, `За ${nm(p)} из академии «${S.teams[p.acadTid].name}» торг: лучшая ставка $${(a.topSal / 1000).toFixed(1)}M. У владельца ${matchMs >= 3600e3 ? Math.round(matchMs / 3600e3) + ' ч' : Math.max(1, Math.round(matchMs / 60000)) + ' мин'} на ответ`, now);
      continue;
    }
    if (now <= a.matchUntil) continue;
    // владелец промолчал: игрок уходит к лучшему биддеру, владельцу — компенсация
    const fromTid = p.acadTid;
    let signed = null;
    for (const [tid, b] of Object.entries(a.bids).sort((x, y) => y[1].sal - x[1].sal || x[1].t - y[1].t)) {
      if (+tid === fromTid || !fitsRoster(G, S, +tid, b.sal)) continue;
      signed = { tid: +tid, sal: b.sal }; break;
    }
    const comp = poachComp(p);
    if (signed) {
      signFromAuction(G, S, p, signed.tid, signed.sal, now);
      if (o.fin && o.fin[signed.tid] && o.fin[fromTid]) { o.fin[signed.tid].cash -= comp; o.fin[signed.tid].spent += comp; o.fin[fromTid].cash += comp; }
      mlog(S, `${nm(p)} переманен из академии «${S.teams[fromTid]?.name || '?'}» в «${S.teams[signed.tid].name}» за $${(signed.sal / 1000).toFixed(1)}M`, now);
    }
    delete o.auc.po[pid];
  }
}

// ---------- боты: торги и работа с академией раз в игровой день ----------
function botDay(G, S, now) {
  const o = ensureA(S), R = Math.random;
  const fair = G.ev('fair'), vf = G.ev('valueFor');
  for (const t of S.teams) {
    const tid = t.id, h = o.humans[tid];
    if (h && !h.bot) continue; // люди сами
    G.S = S;
    // свободные агенты: ставка на лучшего по ценности, если есть место и деньги
    const fas = S.players.filter((p) => p.team === -1).sort((a, b) => vf(b, tid) - vf(a, tid));
    for (const p of fas.slice(0, 3)) {
      const sal = G.ev('rs')(fair(p.ovr) * (0.9 + R() * 0.25));
      if (!fitsRoster(G, S, tid, sal)) break;
      const a = (o.auc.fa[p.id] = o.auc.fa[p.id] || { bids: {}, since: now });
      const top = topBid(a);
      if (top && +top[0] === tid) continue;
      if (top && top[1].sal >= sal) continue;
      a.bids[tid] = { sal, t: now };
      break;
    }
    // переманивание: шанс 30% за день, берут самого сильного доступного
    if (R() < 0.3) {
      const tgt = S.players.filter((p) => p.acadTid !== tid && poachable(S, p, now) && !(o.auc.po[p.id] || {}).stage).sort((a, b) => b.ovr - a.ovr)[0];
      if (tgt) {
        const sal = G.ev('rs')(fair(tgt.ovr) * (0.75 + R() * 0.2));
        if (fitsRoster(G, S, tid, sal)) {
          const a = (o.auc.po[tgt.id] = o.auc.po[tgt.id] || { bids: {}, since: now });
          const top = topBid(a);
          if (!top || top[1].sal < sal) a.bids[tid] = { sal, t: now };
        }
      }
    }
    // своя академия: поиск, набор, перевод в основу, защита своих
    // бот переключает физика: набрал много воспитанников и форма набрана — работает с академией,
    // академия опустела или шкала просела — возвращается к основе (с шансом, чтобы клубы не шли в ногу)
    const stf = (o.staff || {})[tid];
    if (stf && stf.phys) {
      const kids = acadPlayers(S, tid).length;
      if (stf.mode !== 'acad' && kids >= 4 && (stf.scale || 0) >= 40 && R() < 0.35) stf.mode = 'acad';
      else if (stf.mode === 'acad' && (kids < 2 || (stf.scale || 0) <= -20) && R() < 0.5) stf.mode = 'main';
    }
    if (now - (o.sr[tid] || 0) >= ACAD.searchCdDays * dayMs(o)) {
      S.players = S.players.filter((p) => !(p.team === -4 && p.osTid === tid));
      o.sr[tid] = now;
      for (let i = 0; i < ACAD.candN; i++) S.players.push(makeCandidate(G, S, tid, ACAD.gemBase));
    }
    const mine = acadPlayers(S, tid);
    if (mine.length < acadCap(S, tid)) {
      const cand = S.players.filter((p) => p.team === -4 && p.osTid === tid).sort((a, b) => b.pot - a.pot)[0];
      if (cand) { cand.team = -5; cand.acadTid = tid; cand.acadSince = now; delete cand.osTid; }
    }
    for (const p of mine) {
      const d = rookieDeal(G, p);
      const soonPoach = p.acadSince != null && now - p.acadSince > poachMs(o) - dayMs(o);
      const a = o.auc.po[p.id];
      if (a && a.stage === 'match' && a.topSal <= fair(p.ovr) * 1.2 && fitsRoster(G, S, tid, a.topSal)) {
        signFromAuction(G, S, p, tid, a.topSal, now); delete o.auc.po[p.id]; continue;
      }
      if ((p.ovr >= 66 || soonPoach) && fitsRoster(G, S, tid, d.sal)) {
        p.team = tid; p.sal = d.sal; p.yrs = d.yrs; delete p.acadTid; delete p.acadSince;
        G.ev('uniqName')(p, tid); G.ev('ensureNums')(tid);
      }
    }
  }
}

export function acadTick(G, S, now = Date.now()) {
  const o = ensureA(S);
  if (o.champ != null) return;
  resolveAuctions(G, S, now);
  if (now - (o.botT || 0) >= dayMs(o)) {
    o.botT = now; o.dayN = (o.dayN || 0) + 1;
    staffDay(G, S, o.dayN, now); // шкала физика + выплаты спонсора — каждый игровой день, включая плей-офф
    if (!o.po) botDay(G, S, now);
  }
}

// ---------- наследование: 2 лучших воспитанника переходят в новый сезон ----------
export function inheritAcademy(G, S, prev, now = Date.now()) {
  if (!prev || !prev.players) return 0;
  let n = 0;
  for (const t of S.teams) {
    const pt = (prev.teams || []).find((x) => x.lg === t.lg);
    if (!pt) continue;
    const best = prev.players.filter((p) => p.team === -5 && p.acadTid === pt.id).sort((a, b) => b.ovr - a.ovr).slice(0, 2);
    for (const p of best) {
      const q = { ...p, id: S.nid++, age: p.age + 1, team: -5, acadTid: t.id, acadSince: now,
        gp: 0, g: 0, a: 0, pim: 0, ppg: 0, gsa: 0, gga: 0, gw: 0, gso: 0 };
      S.players.push(q); n++;
    }
  }
  return n;
}

// ---------- вид для клиента ----------
export function academyView(G, S, uid, now = Date.now()) {
  const o = ensureA(S); G.S = S;
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  const cands = S.players.filter((p) => p.team === -4 && p.osTid === me.tid).map((p) => pubAcad(S, me.tid, p, false));
  const mine = acadPlayers(S, me.tid).map((p) => {
    const a = o.auc.po[p.id];
    return { ...pubAcad(S, me.tid, p, true), poach: poachable(S, p, now),
      gx: Math.round((p.gx || 0) * 100) / 100,
      match: a && a.stage === 'match' ? { sal: a.topSal, until: a.matchUntil } : null };
  });
  const others = S.players.filter((p) => p.team === -5 && p.acadTid !== me.tid && poachable(S, p, now))
    .map((p) => ({ ...pubAcad(S, me.tid, p, false), club: S.teams[p.acadTid].name,
      bid: (o.auc.po[p.id] || {}).stage === 'match' ? 'match' : null,
      myLead: (() => { const a = o.auc.po[p.id]; if (!a || a.stage === 'match') return null; const t = topBid(a); return t ? +t[0] === me.tid : null; })() }));
  return {
    team: me.tid, upg: o.upg[me.tid] || {}, upgMax: UPG.max,
    cost: { scout: lvl(S, me.tid, 'scout') >= UPG.max ? null : upgCost(S, 'scout'), acad: lvl(S, me.tid, 'acad') >= UPG.max ? null : upgCost(S, 'acad') },
    slots: acadCap(S, me.tid), used: mine.length, spread: potSpread(S, me.tid),
    searchIn: Math.max(0, (o.sr[me.tid] || 0) + ACAD.searchCdDays * dayMs(o) - now),
    poachMs: poachMs(o), cands, mine, others, closed: !!o.po || o.champ != null,
  };
}
