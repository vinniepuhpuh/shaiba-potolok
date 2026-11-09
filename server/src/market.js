// Рынок онлайн-сезона: свободные агенты, личный список из-за рубежа, расторжения и обмены.
// Всё считается на сервере по тем же функциям игры, что и в карьере (G.ev), состояние — в S.online.
import crypto from 'node:crypto';

const MAX_ROSTER = 26, MIN_ROSTER = 20, BOT_PREMIUM = 1.18; // компьютер хочет +15–20% к ценности
const TRADE_TTL = 48 * 3600e3;

function humanOf(S, uid) {
  const e = Object.entries(S.online.humans).find(([, h]) => h && h.uid === uid && !h.bot);
  return e ? { tid: +e[0], h: e[1] } : null;
}
const isHuman = (S, tid) => { const h = S.online.humans[tid]; return !!(h && !h.bot); };

/** Окна рынка: обмены — до дедлайна, агенты и зарубежье — до начала плей-офф. */
export function marketTimes(S) {
  const o = S.online, n = o.cfg.tradeDeadlineGame ?? 20;
  const reg = o.slots.filter((s) => s.kind === 'reg');
  const tradeT = reg[Math.min(n, reg.length) - 1].t, faT = reg[reg.length - 1].t;
  return { tradeT, faT };
}
function ensure(S) {
  const o = S.online;
  o.dead = o.dead || {}; o.trades = o.trades || []; o.os = o.os || {}; o.mlog = o.mlog || [];
  return o;
}
const deadOf = (S, tid) => ensure(S).dead[tid] || 0;
const pay = (G, S, tid) => G.ev('payroll')(tid) + deadOf(S, tid);
const roster = (S, tid) => S.players.filter((p) => p.team === tid && p.yrs > 0);
const goalies = (S, tid) => roster(S, tid).filter((p) => p.pos === 'G').length;
function log(S, txt, now) { const o = ensure(S); o.mlog.unshift({ t: now, txt }); o.mlog.length = Math.min(o.mlog.length, 60); }
const nm = (p) => (p.nat === 'CHN' ? p.f + ' ' + p.l : p.f[0] + '. ' + p.l);

// Шанс согласия свободного агента — формула карьеры, но от его запроса без поправки на престиж клуба
function faChance(G, p, sal, yrs) {
  const t = G.ev('termAdj')(p, yrs), req = G.ev('rs')(p.ask * t.f);
  return { c: Math.max(0, Math.min(1, (sal / req - 0.84 - t.pen) / 0.18)), req, t };
}
const potHint = (p) => (p.age <= 24 && p.pot - p.ovr >= 5 ? (p.pot - p.ovr >= 10 ? 'high' : 'mid') : null);
const pub = (p, extra = {}) => ({
  id: p.id, f: p.f, l: p.l, nat: p.nat, pos: p.pos, pos2: p.pos2 || null, sd: p.sd || null, age: p.age, ovr: p.ovr,
  role: p.role || null, inj: p.inj || 0, potH: potHint(p), ...extra,
});

export function marketView(G, S, uid, now = Date.now()) {
  const o = ensure(S); G.S = S;
  const me = humanOf(S, uid), { tradeT, faT } = marketTimes(S);
  const open = { trade: !o.po && now < tradeT, fa: !o.po && now < faT };
  const fa = S.players.filter((p) => p.team === -1).sort((a, b) => b.ovr - a.ovr).slice(0, 80)
    .map((p) => pub(p, { ask: p.ask, askY: p.askY, pat: me ? ((p.opat || {})[me.tid] ?? 100) : null }));
  let my = null;
  if (me) {
    const os = S.players.filter((p) => p.team === -4 && p.osTid === me.tid).map((p) => pub(p, { osSal: p.osSal, osY: p.osY }));
    const mine = (tr) => tr.from === me.tid || tr.to === me.tid;
    my = {
      team: me.tid, cap: S.cap, pay: pay(G, S, me.tid), dead: deadOf(S, me.tid), n: roster(S, me.tid).length,
      os, osDay: (o.os[me.tid] || {}).day || null, osToday: (o.os[me.tid] || {}).day === mskDay(now),
      trades: o.trades.filter((tr) => mine(tr) && (tr.status === 'open' || now - tr.t < 3 * 864e5)).map((tr) => tradePub(S, tr)),
    };
  }
  return { open, tradeT, faT, cap: S.cap, minSal: G.ev('minSal')(), maxSal: G.ev('maxSal')(), maxRoster: MAX_ROSTER, minRoster: MIN_ROSTER,
    premium: BOT_PREMIUM, fa, my, log: o.mlog.slice(0, 20) };
}
const mskDay = (t) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
function tradePub(S, tr) {
  const P = (id) => { const p = S.players.find((x) => x.id === id); return p ? { id, n: nm(p), pos: p.pos, ovr: p.ovr, age: p.age, sal: p.sal } : { id, n: '—' }; };
  return { id: tr.id, from: tr.from, to: tr.to, give: tr.give.map(P), get: tr.get.map(P), t: tr.t, exp: tr.exp, status: tr.status, why: tr.why || null };
}

// ---------- свободные агенты ----------
export function signFA(G, S, uid, { id, sal, yrs }, now = Date.now()) {
  const o = ensure(S); G.S = S;
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  if (o.po || now >= marketTimes(S).faT) return { error: 'market_closed' };
  const p = S.players.find((x) => x.id === Number(id));
  if (!p || p.team !== -1) return { error: 'gone' };
  sal = Math.round(Number(sal) / 10) * 10; yrs = Math.round(Number(yrs));
  if (!(yrs >= 1 && yrs <= 5)) return { error: 'bad_offer' };
  if (!(sal >= G.ev('minSal')() && sal <= G.ev('maxSal')())) return { error: 'bad_offer' };
  if (roster(S, me.tid).length >= MAX_ROSTER) return { error: 'roster_full' };
  if (pay(G, S, me.tid) + sal > S.cap) return { error: 'cap' };
  p.opat = p.opat || {}; p.otries = p.otries || {};
  const pat = p.opat[me.tid] ?? 100;
  if (pat <= 0) return { error: 'no_talks' };
  const { c, req } = faChance(G, p, sal, yrs);
  if (Math.random() < c) {
    p.team = me.tid; p.sal = sal; p.yrs = yrs; p.exp = false; p.faY = 0;
    G.ev('uniqName')(p, me.tid); G.ev('ensureNums')(me.tid); G.ev('inv()');
    log(S, `«${S.teams[me.tid].name}» подписали ${nm(p)} (${p.ovr})`, now);
    return { ok: true, signed: true, player: p.id };
  }
  const tries = p.otries[me.tid] || 0, gap = Math.max(0, 1 - sal / req);
  const drop = Math.round(Math.max(8, Math.min(60, 8 + gap * 170)) * (1 + 0.3 * tries));
  p.opat[me.tid] = Math.max(0, pat - drop); p.otries[me.tid] = tries + 1;
  return { ok: true, signed: false, pat: p.opat[me.tid], drop };
}

// ---------- личный список из-за рубежа: раз в день по Москве, только для своего клуба ----------
export function scoutOS(G, S, uid, now = Date.now()) {
  const o = ensure(S); G.S = S;
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  if (o.po || now >= marketTimes(S).faT) return { error: 'market_closed' };
  const day = mskDay(now);
  if ((o.os[me.tid] || {}).day === day) return { error: 'os_today' };
  S.players = S.players.filter((p) => !(p.team === -4 && p.osTid === me.tid));
  const ri = G.ev('ri'), R = Math.random, clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  for (let i = 0; i < 3; i++) {
    const age = ri(18, 31), x = R(), ovr = x < 0.7 ? ri(58, 70) : x < 0.95 ? ri(71, 78) : ri(79, 84);
    const p = G.ev('newPlayer')(G.ev('pick')(['C', 'LW', 'RW', 'D', 'D', 'C', 'LW', 'RW', 'G']), ovr, age, G.ev('pickW')(G.ev('OSW')));
    p.ovr = ovr; p.pot = clamp(age <= 23 ? ovr + ri(3, 12) : age <= 26 ? ovr + ri(0, 5) : ovr, ovr, 95);
    p.ovr0 = p.ovr; p.pot0 = p.pot; p.gx = 0;
    p.team = -4; p.osTid = me.tid; p.osSal = G.ev('rs')(G.ev('fair')(ovr) * ri(60, 75) / 100); p.osY = ri(1, 2);
    S.players.push(p);
  }
  o.os[me.tid] = { day };
  return { ok: true };
}
export function signOS(G, S, uid, { id }, now = Date.now()) {
  const o = ensure(S); G.S = S;
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  if (o.po || now >= marketTimes(S).faT) return { error: 'market_closed' };
  const p = S.players.find((x) => x.id === Number(id));
  if (!p || p.team !== -4 || p.osTid !== me.tid) return { error: 'gone' };
  if (roster(S, me.tid).length >= MAX_ROSTER) return { error: 'roster_full' };
  if (pay(G, S, me.tid) + p.osSal > S.cap) return { error: 'cap' };
  p.team = me.tid; p.sal = p.osSal; p.yrs = p.osY; p.faY = 0; delete p.osTid;
  G.ev('uniqName')(p, me.tid); G.ev('ensureNums')(me.tid);
  S.players = S.players.filter((q) => !(q.team === -4 && q.osTid === me.tid)); // остальных кандидатов забирают другие лиги
  G.ev('inv()');
  log(S, `«${S.teams[me.tid].name}» подписали ${nm(p)} из-за рубежа (${p.ovr})`, now);
  return { ok: true, player: p.id };
}

// ---------- расторжение: половина зарплаты остаётся под потолком до конца сезона ----------
export function releasePlayer(G, S, uid, { id }, now = Date.now()) {
  const o = ensure(S); G.S = S;
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  const p = S.players.find((x) => x.id === Number(id));
  if (!p || p.team !== me.tid) return { error: 'gone' };
  if (roster(S, me.tid).length <= MIN_ROSTER) return { error: 'roster_min' };
  if (p.pos === 'G' && goalies(S, me.tid) <= 2) return { error: 'goalies' };
  const dead = G.ev('rs')(p.sal * 0.5);
  o.dead[me.tid] = deadOf(S, me.tid) + dead;
  G.ev('toFA')(p); G.ev('inv()');
  const h = me.h; if (h.lines) h.lines = null, h.lmode = null; // звенья пересоберутся
  log(S, `«${S.teams[me.tid].name}» расторгли контракт с ${nm(p)}`, now);
  return { ok: true, dead };
}

// ---------- обмены ----------
export function tradeCheck(G, S, from, to, give, get, now = Date.now()) {
  const o = ensure(S); G.S = S;
  const issues = [];
  if (o.po || now >= marketTimes(S).tradeT) issues.push('Обмены закрыты до конца сезона.');
  if (from === to || !S.teams[to]) return { issues: ['Выберите клуб.'] };
  const byId = (id) => S.players.find((x) => x.id === Number(id));
  const G1 = give.map(byId), G2 = get.map(byId);
  if (!give.length && !get.length) return { empty: true, issues: [] };
  if (G1.some((p) => !p || p.team !== from) || G2.some((p) => !p || p.team !== to)) return { issues: ['Состав изменился: соберите обмен заново.'], gone: true };
  const salIn = G1.reduce((s, p) => s + p.sal, 0), salOut = G2.reduce((s, p) => s + p.sal, 0);
  const payA = pay(G, S, from) - salIn + salOut, payB = pay(G, S, to) + salIn - salOut;
  if (payA > S.cap) issues.push('Вы выйдете за потолок зарплат.');
  if (payB > S.cap) issues.push(`У «${S.teams[to].name}» не хватит места под потолком.`);
  const nA = roster(S, from).length - G1.length + G2.length, nB = roster(S, to).length + G1.length - G2.length;
  if (nA > MAX_ROSTER) issues.push(`У вас станет ${nA} игроков, максимум ${MAX_ROSTER}.`);
  if (nA < MIN_ROSTER) issues.push(`У вас останется ${nA} игроков, минимум ${MIN_ROSTER}.`);
  if (nB > MAX_ROSTER) issues.push(`У «${S.teams[to].name}» станет больше ${MAX_ROSTER} игроков.`);
  if (nB < MIN_ROSTER) issues.push(`У «${S.teams[to].name}» останется меньше ${MIN_ROSTER} игроков.`);
  const gA = goalies(S, from) - G1.filter((p) => p.pos === 'G').length + G2.filter((p) => p.pos === 'G').length;
  const gB = goalies(S, to) + G1.filter((p) => p.pos === 'G').length - G2.filter((p) => p.pos === 'G').length;
  if (gA < 2) issues.push('Вам нужны два вратаря.');
  if (gB < 2) issues.push(`«${S.teams[to].name}» нужны два вратаря.`);
  const human = isHuman(S, to);
  let pct = null, deal = !issues.length, margin = null;
  if (!human) {
    const vf = G.ev('valueFor'), vIn = G1.reduce((s, p) => s + vf(p, to), 0), vOut = G2.reduce((s, p) => s + vf(p, to), 0);
    const scale = Math.max(60, vOut); margin = vIn - vOut * BOT_PREMIUM - 10;
    pct = Math.max(0, Math.min(1, 0.5 + margin / (2 * scale)));
    deal = deal && margin >= 0;
  }
  return { issues, human, pct, deal, salIn, salOut, payA, payB };
}
function execTrade(G, S, from, to, give, get, now) {
  const o = ensure(S);
  const byId = (id) => S.players.find((x) => x.id === Number(id));
  const G1 = give.map(byId), G2 = get.map(byId);
  G1.forEach((p) => { p.team = to; G.ev('uniqName')(p, to); });
  G2.forEach((p) => { p.team = from; G.ev('uniqName')(p, from); });
  G.ev('ensureNums')(from); G.ev('ensureNums')(to); G.ev('inv()');
  for (const tid of [from, to]) { const h = o.humans[tid]; if (h && h.lines) { h.lines = null; h.lmode = null; } }
  // открытые предложения с этими игроками больше не действительны
  const moved = new Set([...give, ...get].map(Number));
  for (const tr of o.trades) if (tr.status === 'open' && [...tr.give, ...tr.get].some((id) => moved.has(id))) { tr.status = 'void'; tr.why = 'игроки уже обменяны'; }
  const L = (ps) => ps.map(nm).join(', ') || 'ничего';
  log(S, `Обмен: «${S.teams[from].name}» отдали ${L(G1)} в «${S.teams[to].name}» за ${L(G2)}`, now);
}
export function proposeTrade(G, S, uid, { to, give, get }, now = Date.now()) {
  const o = ensure(S); G.S = S;
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  to = Number(to); give = (give || []).map(Number); get = (get || []).map(Number);
  if (give.length > 6 || get.length > 6) return { error: 'too_many' };
  const e = tradeCheck(G, S, me.tid, to, give, get, now);
  if (e.empty) return { error: 'empty' };
  if (e.issues.length) return { error: 'issues', issues: e.issues };
  if (!e.human) {
    if (!e.deal) return { ok: true, accepted: false, pct: e.pct };
    execTrade(G, S, me.tid, to, give, get, now);
    return { ok: true, accepted: true };
  }
  if (o.trades.filter((tr) => tr.status === 'open' && tr.from === me.tid).length >= 5) return { error: 'too_many_open' };
  const tr = { id: crypto.randomBytes(5).toString('hex'), from: me.tid, to, give, get, t: now, exp: now + TRADE_TTL, status: 'open' };
  o.trades.push(tr);
  return { ok: true, pending: true, trade: tradePub(S, tr) };
}
export function answerTrade(G, S, uid, id, action, now = Date.now()) {
  const o = ensure(S); G.S = S;
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  const tr = o.trades.find((x) => x.id === id);
  if (!tr || tr.status !== 'open') return { error: 'no_trade' };
  if (action === 'cancel') { if (tr.from !== me.tid) return { error: 'no_trade' }; tr.status = 'cancelled'; return { ok: true }; }
  if (tr.to !== me.tid) return { error: 'no_trade' };
  if (action === 'decline') { tr.status = 'declined'; return { ok: true }; }
  if (action !== 'accept') return { error: 'bad_action' };
  if (now > tr.exp) { tr.status = 'expired'; return { error: 'expired' }; }
  const e = tradeCheck(G, S, tr.from, tr.to, tr.give, tr.get, now);
  if (e.issues.length) { if (e.gone) { tr.status = 'void'; tr.why = 'состав изменился'; } return { error: 'issues', issues: e.issues }; }
  execTrade(G, S, tr.from, tr.to, tr.give, tr.get, now);
  tr.status = 'accepted';
  return { ok: true };
}
/** Вызывается при каждом расчёте: просроченные предложения, обмены после дедлайна. */
export function marketTick(S, now = Date.now()) {
  const o = ensure(S), { tradeT } = marketTimes(S);
  for (const tr of o.trades) if (tr.status === 'open' && (now > tr.exp || now >= tradeT || o.po)) tr.status = 'expired';
  if (o.trades.length > 300) o.trades = o.trades.filter((tr) => tr.status === 'open' || now - tr.t < 7 * 864e5);
}
