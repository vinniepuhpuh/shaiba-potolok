/**
 * Онлайн-лига: создание сезона, расписание, расчёт матчей по времени, плей-офф.
 * Состояние сезона — объект S игры (как в карьере) с полем S.online; движок берётся из кода игры (engine.js).
 */

const H = 3600e3, MIN = 60e3;
const MSK = 3 * H; // Москва UTC+3 круглый год

export const DEFAULT_CFG = {
  name: 'Тестовый сезон',
  test: true, // тестовый сезон: отдельная награда, в рейтинг не идёт
  // индексы клубов в TEAMS игры: Гвардейцы, Туманы, Ханы, Зубры, Медведи, Сталевары, Призраки, Беркуты
  clubs: [8, 0, 12, 6, 4, 19, 24, 22],
  vsEach: 4,
  regTimes: ['19:00', '19:30', '20:00', '20:30'],
  poTimes: ['18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00'],
  seriesWins: 4,
  deadlineGame: 18,
  growK: 2, // рост молодых за сезон относительно сезона карьеры
  liveMin: 10, // длительность трансляции матча, минут
  start: null, // 'YYYY-MM-DD' — первый игровой день (МСК); null — завтра
  fastSec: null, // для тестов: секунд между слотами (вместо расписания по часам)
  inactiveDays: 7,
};

// молодые: потенциал +6…+9 — по прогону 40 сезонов титулы делятся между профилями примерно поровну
const YG = [6, 9];
const PROFILES = ['young', 'mixed', 'vet', 'young', 'mixed', 'vet', 'young', 'mixed'];
export const PROFILE_NAMES = { young: 'Молодая', mixed: 'Смешанная', vet: 'Опытная' };

// ---------- время ----------
function dayStartMsk(dateStr) { // полночь по Москве в мс UTC
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - MSK;
}
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * H + m * MIN; };
function addDays(dateStr, n) {
  const t = new Date(Date.UTC(...dateStr.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) + n * 24 * H);
  return t.toISOString().slice(0, 10);
}
const tomorrowMsk = (now) => new Date(now + MSK + 24 * H).toISOString().slice(0, 10);

// ---------- расписание: круговой турнир ----------
function roundRobin(n) {
  const ids = [...Array(n).keys()], rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const games = [];
    for (let i = 0; i < n / 2; i++) {
      const a = ids[i], b = ids[n - 1 - i];
      games.push(r % 2 ? [a, b] : [b, a]);
    }
    rounds.push(games);
    ids.splice(1, 0, ids.pop());
  }
  return rounds;
}

export function createSeason(G, cfgIn, now = Date.now()) {
  const cfg = { ...DEFAULT_CFG, ...cfgIn };
  if (!cfg.start) cfg.start = tomorrowMsk(now);
  G.ev('newWorld()');
  const S = G.S;
  const keep = cfg.clubs.map((orig, i) => ({ ...S.teams[orig], id: i, lg: orig }));
  S.teams = keep;
  S.players = [];
  S.picks = [];
  S.user = null;
  const T = G.ev('TMPL'), TNW = G.ev('TNW');
  const prof = G.ev('shuffle')(PROFILES.slice(0, keep.length));
  keep.forEach((t, k) => {
    G.ev('zst')(t);
    t.profile = prof[k];
    const mk = (pos, v, top) => {
      const p = G.ev('newPlayer')(pos, v, undefined, G.ev('pickW')(TNW[t.nat]));
      p.ovr = v;
      const ri = G.ev('ri');
      if (top && pos !== 'G') {
        if (t.profile === 'young') { p.age = ri(19, 22); p.ovr = v - 3; p.pot = p.ovr + ri(YG[0], YG[1]); }
        else if (t.profile === 'vet') { p.age = ri(30, 34); p.ovr = v + 1; p.pot = p.ovr; }
        else { p.age = ri(22, 29); p.pot = p.age <= 24 ? p.ovr + ri(4, 7) : p.ovr + 1; }
      } else {
        p.age = pos === 'G' ? ri(24, 31) : ri(21, 31);
        p.pot = p.age <= 24 ? p.ovr + ri(2, 6) : p.ovr;
      }
      p.team = t.id;
      G.ev('uniqName')(p, t.id);
      G.ev('contract')(p, 1);
      S.players.push(p);
    };
    for (const pos of Object.keys(T)) T[pos].forEach((v, i) => mk(pos, v, pos === 'D' ? i < 4 : i < 3));
    // одинаковая сумма зарплат у всех: свобода под потолком не должна зависеть от профиля
    const pay = G.ev('payroll')(t.id), target = S.cap - 6000, rs = G.ev('rs');
    S.players.filter((p) => p.team === t.id).forEach((p) => { p.sal = Math.max(G.ev('minSal')(), rs(p.sal * target / pay)); });
  });
  G.ev('topUpFA')(30);
  S.players.filter((p) => p.team === -1).forEach((p) => G.ev('setAsk')(p));
  S.players.forEach((p) => { p.ovr0 = p.ovr; p.pot0 = p.pot; p.gx = 0; });
  S.teams.forEach((t) => G.ev('ensureNums')(t.id));
  S.phase = 'regular'; S.day = 0; S.sched = []; S.news = []; S.offers = []; S.box = []; S.chem = {}; S.lines = null;

  // слоты регулярки
  const rr = roundRobin(keep.length), slots = [];
  for (let rep = 0; rep < cfg.vsEach; rep++) {
    for (const r of rr) slots.push({ kind: 'reg', games: r.map(([h, a]) => (rep % 2 ? [a, h] : [h, a])) });
  }
  slots.forEach((s, i) => {
    s.i = i;
    if (cfg.fastSec) s.t = now + (i + 1) * cfg.fastSec * 1000;
    else s.t = dayStartMsk(addDays(cfg.start, Math.floor(i / cfg.regTimes.length))) + hm(cfg.regTimes[i % cfg.regTimes.length]);
    s.games = s.games.map(([h, a], k) => ({ id: `${i}-${k}`, h, a, done: false }));
  });
  S.online = {
    cfg, slots, po: null, champ: null, humans: {}, createdAt: now,
    regDays: Math.ceil(slots.length / cfg.regTimes.length),
    deadlineT: slots[Math.min(cfg.deadlineGame, slots.length) - 1].t,
  };
  return S;
}

// ---------- плей-офф ----------
function buildPlayoffRound(G, S, teamsOrder, round, startT) {
  const o = S.online, cfg = o.cfg, n = teamsOrder.length;
  const series = [];
  for (let i = 0; i < n / 2; i++) series.push({ a: teamsOrder[i], b: teamsOrder[n - 1 - i], wa: 0, wb: 0 });
  const maxG = cfg.seriesWins * 2 - 1;
  const homeA = [0, 1, 4, 6]; // 1,2,5,7 — дома у сеяной выше
  for (let g = 0; g < maxG; g++) {
    const t = cfg.fastSec ? startT + g * cfg.fastSec * 1000 : startT + hm(cfg.poTimes[g]) ;
    o.slots.push({ i: o.slots.length, kind: 'po', round, g, t, games: series.map((s, k) => ({ id: `${o.slots.length}-${k}`, series: k, h: homeA.includes(g) ? s.a : s.b, a: homeA.includes(g) ? s.b : s.a, done: false })) });
  }
  o.po = o.po || { rounds: [] };
  o.po.rounds.push(series);
}

function maybeAdvancePlayoffs(G, S, lastT) {
  const o = S.online;
  if (o.champ != null) return;
  const regLeft = o.slots.some((s) => s.kind === 'reg' && s.games.some((g) => !g.done));
  if (regLeft) return;
  const nextDay = (t) => {
    if (o.cfg.fastSec) return t + o.cfg.fastSec * 1000;
    const d = new Date(t + MSK).toISOString().slice(0, 10);
    return dayStartMsk(addDays(d, 1));
  };
  if (!o.po) {
    const order = S.teams.slice().sort(G.ev('cmpStand')).map((t) => t.id);
    o.seeds = order;
    buildPlayoffRound(G, S, order, 0, nextDay(lastT));
    return;
  }
  const cur = o.po.rounds[o.po.rounds.length - 1];
  const W = o.cfg.seriesWins;
  if (!cur.every((s) => s.wa >= W || s.wb >= W)) return;
  const winners = cur.map((s) => (s.wa >= W ? s.a : s.b));
  if (winners.length === 1) { o.champ = winners[0]; o.endedAt = lastT; return; }
  // пересев: оставшиеся по исходному посеву
  const order = o.seeds.filter((id) => winners.includes(id));
  buildPlayoffRound(G, S, order, o.po.rounds.length, nextDay(lastT));
}

// ---------- рост игроков после матча ----------
function growAfterGame(G, S, tids) {
  const k = S.online.cfg.growK, n = S.online.slots.filter((s) => s.kind === 'reg').length || 28;
  const growRate = G.ev('growRate');
  for (const tid of tids) {
    const L = G.ev('getLines')(tid), w = {};
    L.f.forEach((l, i) => l.forEach((id) => { if (id != null) w[id] = [1.3, 1.1, 0.9, 0.7][i] / 1.1; }));
    L.d.forEach((l, i) => l.forEach((id) => { if (id != null) w[id] = [1.2, 1, 0.8][i] / 1.1; }));
    if (L.g[0] != null) w[L.g[0]] = 1;
    for (const p of S.players) {
      if (p.team !== tid || !(p.id in w)) continue;
      let r = 0;
      if (p.age <= 28 && p.pot > p.ovr) r = (p.pot0 - p.ovr0) * growRate(p.age) * k * w[p.id] / n;
      else if (p.age >= 33) r = -(p.age - 32) * 0.5 / n;
      p.gx = (p.gx || 0) + r;
      while (p.gx >= 1 && p.ovr < p.pot) { p.ovr++; p.gx -= 1; }
      while (p.gx <= -1) { p.ovr--; p.pot = Math.max(p.ovr, Math.min(p.pot, p.ovr)); p.gx += 1; }
    }
  }
}

// ---------- расчёт одного матча ----------
const RISKT = [0, 1, 3, 5.5, 8, 10];
function setHooks(G, S, slotIdx) {
  const o = S.online, HK = G.HOOK;
  HK.lines = {}; HK.tac = {}; HK.sty = {}; HK.pull = {}; HK.human = {};
  HK.injK = Math.min(1, (o.slots.filter((s) => s.kind === 'reg').length || 82) / 82);
  for (const [tid, h] of Object.entries(o.humans)) {
    if (!h || h.bot) continue;
    HK.human[tid] = true;
    const plan = (h.plans && (h.plans[slotIdx] || h.plans.def)) || {};
    if (plan.sty) HK.sty[tid] = plan.sty;
    if (plan.risk) HK.tac[tid] = RISKT[plan.risk];
    if (plan.pull != null) HK.pull[tid] = !!plan.pull;
    if (h.lines) {
      const fixed = G.ev('(L,tid)=>{const act=new Set(healthy(tid).map(p=>p.id)),seen=new Set();const ok=id=>{if(id==null||!act.has(id)||seen.has(id))return null;seen.add(id);return id;};const C={f:L.f.map(l=>l.map(ok)),d:L.d.map(l=>l.map(ok)),g:L.g.map(ok)};fillLines(C,healthy(tid));return C;}')(h.lines, +tid);
      HK.lines[tid] = fixed;
    }
  }
}

function playGame(G, S, g, kind) {
  const r = G.ev(`(()=>{const L=newLive(${g.h},${g.a},'${kind}');prep(L);const log=[];
    while(!L.done){if(L.pause){L.pause=null;prep(L);}stepTick(L);const v=L.vis||{},ic=v.ice||[[],[]];
      log.push([L.per,L.tick,L.sc[0],L.sc[1],v.poss,v.zone,v.shot,v.goal,v.post,ic[0],ic[1],L.pen[0].length,L.pen[1].length]);}
    const X=liveX(L),rost={};for(const p of S.players)if(p.team===L.h||p.team===L.a)rost[p.id]=[p.num||0,p.pos,p.f,p.l,p.nat];
    const res=finishLive(L);const box=S.box[0];box.gkId=[X[0].g,X[1].g];box.rost=rost;box.sty=L.sty;return {res,log,ev:L.ev,box,sty:L.sty,tac:L.tac,so:!!L.so,ot:!!L.ot};})()`);
  return JSON.parse(JSON.stringify(r));
}

/** Считает все слоты, время которых наступило. Возвращает записи сыгранных матчей для базы. */
export function runDue(G, S, now = Date.now()) {
  const o = S.online, out = [];
  if (!o || o.champ != null) return out;
  let guard = 0;
  while (guard++ < 200) {
    const slot = o.slots.find((s) => s.games.some((g) => !g.done));
    if (!slot || slot.t > now) break;
    G.S = S;
    setHooks(G, S, slot.i);
    const played = [];
    for (const g of slot.games) {
      if (g.done) continue;
      if (slot.kind === 'po') {
        const s = o.po.rounds[slot.round][g.series], W = o.cfg.seriesWins;
        if (s.wa >= W || s.wb >= W) { g.done = true; g.skip = true; continue; }
      }
      const r = playGame(G, S, g, slot.kind === 'reg' ? 'reg' : 'po');
      const res = r.res, H = S.teams[g.h], A = S.teams[g.a];
      if (slot.kind === 'reg') {
        H.gf += res.gh; H.ga += res.ga; A.gf += res.ga; A.ga += res.gh;
        if (res.gh > res.ga) { H.w++; res.ot ? A.ot++ : A.l++; } else { A.w++; res.ot ? H.ot++ : H.l++; }
      } else {
        const s = o.po.rounds[slot.round][g.series];
        const hWon = res.gh > res.ga;
        if ((hWon && g.h === s.a) || (!hWon && g.a === s.a)) s.wa++; else s.wb++;
      }
      G.ev('styRec')(g.h, res.yh, res.gh > res.ga);
      G.ev('styRec')(g.a, res.ya, res.ga > res.gh);
      g.done = true;
      g.res = { gh: res.gh, ga: res.ga, ot: !!r.ot, so: !!r.so, yh: res.yh, ya: res.ya };
      played.push(g.h, g.a);
      out.push({ gid: g.id, slot: slot.i, kind: slot.kind, t: slot.t, h: g.h, a: g.a, res: g.res, box: r.box, ev: r.ev, log: r.log, tac: r.tac });
    }
    G.ev('bumpChem(ctx())');
    if (slot.kind === 'reg') growAfterGame(G, S, played); // в плей-офф игроки не растут: весь рост — за регулярку
    G.ev('healDay();aiCover();inv()');
    // неактивные люди: через N дней без заходов клуб переходит боту
    for (const h of Object.values(o.humans)) {
      if (h && !h.bot && now - (h.lastSeen || 0) > o.cfg.inactiveDays * 24 * H) h.bot = true;
    }
    maybeAdvancePlayoffs(G, S, slot.t);
  }
  return out;
}

// ---------- для API ----------
export function publicView(G, S, now, uid) {
  const o = S.online, cfg = o.cfg;
  const live = (slot) => now < slot.t + cfg.liveMin * MIN; // результаты ещё идущих матчей не раскрываем
  // таблица без результатов идущих матчей
  const tbl = S.teams.map((t) => ({ id: t.id, w: t.w, l: t.l, ot: t.ot, gf: t.gf, ga: t.ga }));
  for (const s of o.slots) {
    if (s.kind !== 'reg' || !live(s)) continue;
    for (const g of s.games) {
      if (!g.done || !g.res) continue;
      const h = tbl[g.h], a = tbl[g.a], r = g.res;
      h.gf -= r.gh; h.ga -= r.ga; a.gf -= r.ga; a.ga -= r.gh;
      if (r.gh > r.ga) { h.w--; r.ot ? a.ot-- : a.l--; } else { a.w--; r.ot ? h.ot-- : h.l--; }
    }
  }
  const strength = G.ev('allR')();
  const teams = S.teams.map((t) => {
    const h = o.humans[t.id];
    const x = tbl[t.id];
    return { id: t.id, city: t.city, name: t.name, ab: t.ab, lg: t.lg, c1: t.c1, c2: t.c2, own: t.own, profile: t.profile,
      str: Math.round(strength[t.id].t * 10) / 10, sty: t.sty || null,
      human: h && !h.bot ? { name: h.name || 'Менеджер' } : null,
      w: x.w, l: x.l, ot: x.ot, gf: x.gf, ga: x.ga, pts: x.w * 2 + x.ot, gp: x.w + x.l + x.ot };
  });
  const slots = o.slots.map((s) => ({
    i: s.i, t: s.t, kind: s.kind, round: s.round, g: s.g,
    games: s.games.filter((g) => !g.skip).map((g) => ({ id: g.id, h: g.h, a: g.a, live: g.done && live(s) && now >= s.t, res: g.done && !live(s) ? g.res : null })),
  }));
  const po = o.po && o.po.rounds.map((r, ri) => r.map((s) => {
    // счёт серии без идущих матчей
    let wa = s.wa, wb = s.wb;
    for (const sl of o.slots) if (sl.kind === 'po' && sl.round === ri && live(sl)) for (const g of sl.games) {
      if (!g.done || g.skip || !g.res || o.po.rounds[ri][g.series] !== s) continue;
      const hWon = g.res.gh > g.res.ga; if ((hWon && g.h === s.a) || (!hWon && g.a === s.a)) wa--; else wb--;
    }
    return { a: s.a, b: s.b, wa, wb };
  }));
  const champSlot = o.champ != null ? o.slots.filter((s) => s.kind === 'po').pop() : null;
  const champ = o.champ != null && champSlot && !live(champSlot) ? o.champ : null;
  let my = null;
  for (const [tid, h] of Object.entries(o.humans)) if (h && h.uid === uid) my = { team: +tid, bot: !!h.bot };
  return { name: cfg.name, test: !!cfg.test, now, deadlineT: o.deadlineT, canJoin: now < o.deadlineT, liveMin: cfg.liveMin, teams, slots, po, champ, my };
}

export function joinSeason(S, team, uid, name, now = Date.now()) {
  const o = S.online;
  if (now >= o.deadlineT) return { error: 'deadline' };
  if (!S.teams[team]) return { error: 'no_team' };
  for (const [tid, h] of Object.entries(o.humans)) if (h && h.uid === uid) {
    if (+tid === team) { h.bot = false; h.lastSeen = now; return { ok: true, team }; }
    return { error: 'already', team: +tid };
  }
  const cur = o.humans[team];
  if (cur && !cur.bot) return { error: 'taken' };
  o.humans[team] = { uid, name: name || 'Менеджер', joinedAt: now, lastSeen: now, plans: {}, lines: null };
  return { ok: true, team };
}

// ---------- клуб для экрана «Состав» ----------
const LMODES = ['best', 'combo', 'keep'];
function linesFor(G, S, tid) {
  const h = S.online.humans[tid];
  G.S = S; G.HOOK.lines = {};
  if (h && !h.bot && h.lines) {
    return G.ev('(L,tid)=>{const act=new Set(healthy(tid).map(p=>p.id)),seen=new Set();const ok=id=>{if(id==null||!act.has(id)||seen.has(id))return null;seen.add(id);return id;};const C={f:L.f.map(l=>l.map(ok)),d:L.d.map(l=>l.map(ok)),g:L.g.map(ok)};fillLines(C,healthy(tid));return C;}')(h.lines, tid);
  }
  return JSON.parse(JSON.stringify(G.ev('autoLines')(tid)));
}
export function teamView(G, S, tid, uid) {
  const o = S.online, t = S.teams[tid];
  if (!t) return null;
  G.S = S;
  const h = o.humans[tid], mine = !!(h && h.uid === uid);
  const L = linesFor(G, S, tid);
  const M = G.ev('idx')();
  const fits = G.ev('fitsAll')(tid, L, M);
  const players = S.players.filter((p) => p.team === tid).map((p) => ({
    id: p.id, f: p.f, l: p.l, nat: p.nat, pos: p.pos, pos2: p.pos2 || null, sd: p.sd || null, age: p.age, ovr: p.ovr, role: p.role || null,
    num: p.num || null, inj: p.inj || 0, sal: p.sal, yrs: p.yrs, gp: p.gp || 0, g: p.g || 0, a: p.a || 0,
    gsa: p.gsa || 0, gga: p.gga || 0, gw: p.gw || 0, gso: p.gso || 0,
    ...(mine ? { pot: p.pot, d: p.ovr - p.ovr0 } : {}),
  }));
  const fit = {}; for (const k in fits) fit[k] = Math.round(fits[k] * 100) / 100;
  const dead = (o.dead && o.dead[tid]) || 0;
  const pay = G.ev('payroll')(tid) + dead, n = S.players.filter((p) => p.team === tid && p.yrs > 0).length;
  return { id: tid, mine, players, lines: L, fit, sty: t.sty || null, cap: S.cap, pay, dead, n,
    plans: mine ? (h.plans || {}) : null, lmode: mine ? (h.lmode || null) : null, manual: mine ? !!h.lines : null };
}
const STYK = ['FC', 'PO', 'TR', 'CA', 'BAL'];
/** План на матч: key — номер слота или 'def' (по умолчанию). plan=null — удалить. */
export function setPlan(S, uid, key, plan, now = Date.now()) {
  const o = S.online, e = Object.entries(o.humans).find(([, h]) => h && h.uid === uid);
  if (!e) return { error: 'not_joined' };
  const h = e[1];
  if (key !== 'def') {
    const sl = o.slots[Number(key)];
    if (!sl) return { error: 'no_slot' };
    if (sl.t <= now) return { error: 'started' };
    if (!sl.games.some((g) => g.h === +e[0] || g.a === +e[0])) return { error: 'not_your_game' };
  }
  h.plans = h.plans || {};
  if (plan == null) { delete h.plans[key]; return { ok: true, plans: h.plans }; }
  const out = {};
  if (plan.sty != null) { if (!STYK.includes(plan.sty)) return { error: 'bad_sty' }; out.sty = plan.sty; }
  if (plan.risk != null) { const r = Number(plan.risk); if (!(r >= 1 && r <= 5)) return { error: 'bad_risk' }; out.risk = Math.round(r); }
  if (plan.pull != null) out.pull = !!plan.pull;
  h.plans[key] = out; h.lastSeen = now;
  return { ok: true, plans: h.plans };
}
/** Звенья: {mode:'best'|'combo'|'keep'} — собрать автоматически; {lines} — вручную; {} — сбросить на авто. */
export function setLines(G, S, uid, body, now = Date.now()) {
  const o = S.online, e = Object.entries(o.humans).find(([, h]) => h && h.uid === uid);
  if (!e) return { error: 'not_joined' };
  const tid = +e[0], h = e[1];
  G.S = S; G.HOOK.lines = {};
  h.lastSeen = now;
  if (body && body.mode) {
    if (!LMODES.includes(body.mode)) return { error: 'bad_mode' };
    const base = h.lines || null;
    const L = JSON.parse(JSON.stringify(G.ev('buildLines')(tid, body.mode, base)));
    delete L.info; h.lines = L; h.lmode = body.mode;
  } else if (body && body.lines) {
    const L = body.lines, mine = new Set(S.players.filter((p) => p.team === tid).map((p) => p.id));
    const shape = Array.isArray(L.f) && L.f.length === 4 && L.f.every((l) => Array.isArray(l) && l.length === 3) &&
      Array.isArray(L.d) && L.d.length === 3 && L.d.every((l) => Array.isArray(l) && l.length === 2) && Array.isArray(L.g) && L.g.length === 2;
    if (!shape) return { error: 'bad_lines' };
    const ids = [...L.f.flat(), ...L.d.flat(), ...L.g].filter((x) => x != null);
    if (ids.some((x) => !mine.has(x)) || new Set(ids).size !== ids.length) return { error: 'bad_lines' };
    h.lines = { f: L.f.map((l) => l.slice()), d: L.d.map((l) => l.slice()), g: L.g.slice() }; h.lmode = null;
  } else { h.lines = null; h.lmode = null; }
  return { ok: true, lines: linesFor(G, S, tid) };
}
