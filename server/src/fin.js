// Финансы онлайн-сезона: у каждого клуба своя касса, арена и цены на билеты и джерси.
// Формулы спроса — как в карьере (интерес болельщиков, спрос на билеты, продажи джерси), но считаются
// здесь для каждого клуба отдельно и не трогают финансы карьеры. Деньги — в тысячах $, как в игре.
// Сезон начинается заново: касса и арена со следующим сезоном обнуляются.

const SEAT0 = 15000, SEAT_STEP = 1500, MAX_ARENA = 5;
const PRICE_MIN = 30, PRICE_MAX = 300;
export const FIN = {
  cash0: 8000, // стартовая касса, одинаковая у всех
  tvGame: 400, // телеправа и призовые за каждый матч
  lastMult: 0.8, // на соперника с последнего места приходит меньше зрителей
  derbyMult: 1.8, // спрос на дерби: зал всегда полный, цена может быть выше обычной
  // расширение на +1 500 мест — цена на 14 домашних матчей регулярки (масштабируется по длине сезона).
  // Каждый уровень даёт около +10% к билетам: 2-й окупается, если строить в первой половине регулярки, 5-й — почти никогда без плей-офф.
  arenaCost: [0, 1300, 1600, 1900, 2200],
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const capOf = (f) => SEAT0 + SEAT_STEP * (f.arena - 1);
// домашних матчей регулярки на клуб: каждый матч — домашний ровно для одного клуба
const homeGames = (o) => {
  const games = o.slots.filter((s) => s.kind === 'reg').reduce((s, sl) => s + sl.games.length, 0);
  return Math.max(1, Math.round(games / Math.max(1, Object.keys(o.fin || {}).length || 8)));
};
export const arenaCost = (o, lvl) => Math.round(FIN.arenaCost[lvl - 1] * homeGames(o) / 14 / 10) * 10;

function newFin() {
  return { cash: FIN.cash0, arena: 1, tix: { auto: true, price: 85 }, jer: { auto: true, price: 100 },
    inc: { tix: 0, jer: 0, tv: 0 }, spent: 0, form: [], log: [] };
}
export function ensureFin(S) {
  const o = S.online;
  o.fin = o.fin || {};
  for (const t of S.teams) if (!o.fin[t.id]) o.fin[t.id] = newFin();
  return o.fin;
}

// ---------- спрос (формулы карьеры) ----------
const demand = (cap, price, h, mult) => cap * (0.5 + 0.5 * h) * mult * Math.pow((65 + 45 * h) / price, 1.4);
const attend = (cap, price, h, mult) => Math.min(cap, Math.round(demand(cap, price, h, mult)));
function autoTix(cap, h, mult) {
  let best = 85, bv = 0;
  for (let p = PRICE_MIN; p <= PRICE_MAX; p += 5) { const v = attend(cap, p, h, mult) * p; if (v > bv) { bv = v; best = p; } }
  return best;
}
const jerUnits = (price, h, stars) => (1200 + 800 * h + 300 * stars) * Math.pow((100 + 40 * h) / price, 1.8);
function autoJer(h, stars) {
  let best = 100, bv = -1;
  for (let p = 50; p <= PRICE_MAX; p += 5) { const v = (p - 45) * jerUnits(p, h, stars); if (v > bv) { bv = v; best = p; } }
  return best;
}

// таблица регулярки по очкам: место клуба и последний ли он
function standing(S) {
  const pts = (t) => t.w * 2 + t.ot, gp = (t) => t.w + t.l + t.ot;
  const rows = S.teams.map((t) => ({ id: t.id, pct: gp(t) ? pts(t) / (2 * gp(t)) : 0.5, gp: gp(t), d: t.gf - t.ga }))
    .sort((a, b) => b.pct - a.pct || b.d - a.d);
  return rows;
}
/** Интерес болельщиков: форма (последние 10 матчей), место в таблице, звёзды 84+. */
export function hypeOf(S, tid, rows = standing(S)) {
  const f = S.online.fin[tid], form = f.form.length ? f.form.reduce((s, x) => s + x, 0) / f.form.length : 0.5;
  const n = rows.length, i = rows.findIndex((r) => r.id === tid);
  const rp = rows[0] && rows[0].gp ? (n - 1 - i) / Math.max(1, n - 1) : 0.5;
  const stars = S.players.filter((p) => p.team === tid && p.yrs > 0 && p.ovr >= 84).length;
  return { h: clamp(0.15 + 0.5 * form + 0.4 * rp + 0.06 * stars, 0.1, 1.5), stars };
}
const isLast = (rows, tid) => rows.length > 2 && rows[rows.length - 1].id === tid && rows[rows.length - 1].gp >= 2;

/** Билеты на домашний матч: цена, зрители, выручка (без записи). */
function gate(S, home, away, po, derby, rows) {
  const o = S.online, f = o.fin[home], cap = capOf(f), { h } = hypeOf(S, home, rows);
  const mult = po ? 1.6 : 1;
  // соперник с последнего места: автоцена его не учитывает (билеты продаются заранее) — часть зрителей просто не приходит
  const last = !derby && isLast(rows, away), fans = last ? FIN.lastMult : 1;
  const prem = po ? 1.4 : 1;
  let pr, a;
  if (derby) {
    const top = autoTix(cap, h, mult * FIN.derbyMult);
    pr = f.tix.auto ? top : Math.min(f.tix.price, top); // на дерби зал полный, но дороже спроса не продать
    a = cap;
  } else {
    pr = f.tix.auto ? autoTix(cap, h, mult) : f.tix.price;
    a = attend(cap, pr, h, mult * fans);
  }
  return { a, cap, pr: Math.round(pr * prem), rev: Math.round(a * pr * prem / 1000), last, derby, h };
}
function jersey(S, tid, po) {
  const f = S.online.fin[tid], { h, stars } = hypeOf(S, tid);
  const jp = f.jer.auto ? autoJer(h, stars) : f.jer.price;
  return { jp, rev: Math.round((jp - 45) * jerUnits(jp, h, stars) / 1000 * (po ? 1.3 : 1)) };
}

/** Деньги за сыгранный матч: билеты хозяину, джерси и ТВ обоим. Вызывается до записи результата в таблицу. */
export function finGame(S, g, kind, derby, res) {
  const o = S.online; ensureFin(S);
  const po = kind === 'po', rows = standing(S);
  const gt = gate(S, g.h, g.a, po, derby, rows);
  for (const tid of [g.h, g.a]) {
    const f = o.fin[tid], home = tid === g.h, j = jersey(S, tid, po);
    const tix = home ? gt.rev : 0, tv = FIN.tvGame;
    f.inc.tix += tix; f.inc.jer += j.rev; f.inc.tv += tv; f.cash += tix + j.rev + tv;
    f.log.unshift({ gid: g.id, opp: home ? g.a : g.h, home, po, derby: !!derby, last: home && gt.last,
      ...(home ? { att: gt.a, cap: gt.cap, pr: gt.pr } : {}), tix, jer: j.rev, tv });
    f.log.length = Math.min(f.log.length, 60);
  }
  if (res) {
    const hw = res.gh > res.ga;
    for (const [tid, w] of [[g.h, hw], [g.a, !hw]]) { const f = o.fin[tid]; f.form.push(w ? 1 : 0); if (f.form.length > 10) f.form.shift(); }
  }
  return gt;
}

export const incomeOf = (f) => f.inc.tix + f.inc.jer + f.inc.tv;
export const profitOf = (f) => incomeOf(f) - f.spent;

function humanOf(S, uid, anyway = false) {
  const e = Object.entries(S.online.humans).find(([, h]) => h && h.uid === uid && (anyway || !h.bot));
  return e ? +e[0] : null;
}

/** Экран «Финансы» своего клуба: касса, арена, цены и прогноз на ближайший домашний матч. */
export function finView(S, uid, now, isDerby) {
  const o = S.online, tid = humanOf(S, uid, true); // смотреть свои деньги можно и после передачи клуба компьютеру
  if (tid == null) return { error: 'not_joined' };
  ensureFin(S);
  const f = o.fin[tid], rows = standing(S), { h, stars } = hypeOf(S, tid, rows);
  // ближайший домашний матч, который ещё не сыгран
  let next = null;
  for (const s of o.slots) {
    const g = s.games.find((x) => !x.done && !x.skip && x.h === tid);
    if (g) { const d = isDerby(o, g.h, g.a), gt = gate(S, g.h, g.a, s.kind === 'po', d, rows); next = { gid: g.id, t: s.t, opp: g.a, ...gt }; break; }
  }
  const lvl = f.arena;
  const j = jersey(S, tid, false);
  const cap = capOf(f);
  // место по прибыли среди людей
  const humans = Object.entries(o.humans).filter(([, x]) => x && !x.bot).map(([k]) => +k);
  const rank = humans.map((k) => ({ k, p: profitOf(o.fin[k]) })).sort((a, b) => b.p - a.p).findIndex((x) => x.k === tid) + 1;
  return {
    team: tid, cash: f.cash, arena: lvl, maxArena: MAX_ARENA, cap, nextCap: lvl < MAX_ARENA ? cap + SEAT_STEP : null,
    cost: lvl < MAX_ARENA ? arenaCost(o, lvl + 1) : null, closed: o.champ != null,
    tix: f.tix, jer: f.jer, autoTix: autoTix(cap, h, 1), autoJer: autoJer(h, stars), jerNow: j.jp,
    hype: Math.round(h * 100) / 100, inc: f.inc, income: incomeOf(f), spent: f.spent, profit: profitOf(f),
    rank: rank || null, humans: humans.length, log: f.log.slice(0, 12), next, priceMin: PRICE_MIN, priceMax: PRICE_MAX,
    lastMult: FIN.lastMult,
  };
}

/** Цены: {tix:{auto,price}, jer:{auto,price}} — любой из двух. */
export function setPrices(G, S, uid, body) {
  const tid = humanOf(S, uid); if (tid == null) return { error: 'not_joined' };
  ensureFin(S);
  const f = S.online.fin[tid];
  for (const k of ['tix', 'jer']) {
    const b = body && body[k]; if (!b) continue;
    const auto = !!b.auto, price = Math.round(Number(b.price) / 5) * 5;
    if (!auto && !(price >= (k === 'jer' ? 50 : PRICE_MIN) && price <= PRICE_MAX)) return { error: 'bad_price' };
    f[k] = { auto, price: auto ? f[k].price : price };
  }
  return { ok: true, tix: f.tix, jer: f.jer };
}

/** Расширение арены на +1 500 мест. */
export function buyArena(G, S, uid) {
  const o = S.online, tid = humanOf(S, uid); if (tid == null) return { error: 'not_joined' };
  ensureFin(S);
  if (o.champ != null) return { error: 'season_over' };
  const f = o.fin[tid];
  if (f.arena >= MAX_ARENA) return { error: 'arena_max' };
  const c = arenaCost(o, f.arena + 1);
  if (f.cash < c) return { error: 'no_cash' };
  f.cash -= c; f.spent += c; f.arena++;
  return { ok: true, arena: f.arena, cash: f.cash, cap: capOf(f) };
}
