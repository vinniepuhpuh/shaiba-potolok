// Дерби, награды и очки онлайн-рейтинга.
// Дерби: в каждом сезоне у клуба случайный принципиальный соперник; на дерби всегда полный зал.
// Очки рейтинга менеджера за сезон: место в регулярке + пройденные раунды плей-офф + победы в дерби.
// Тестовые сезоны в рейтинг не идут, но итоги и награды в них есть.
import { profitOf, incomeOf, ensureFin } from './fin.js';

export const PTS = {
  place: 20, // за 1-е место в регулярке; дальше поровну вниз до 0 у последнего
  round: 10, // за каждый пройденный раунд плей-офф
  derbyWin: 2, // за каждую победу в дерби
};
// вклад сезонов в рейтинг: последний — полностью, дальше меньше; считаются 6 последних
export const DECAY = [1, 0.85, 0.7, 0.55, 0.4, 0.25];

/** Пары дерби: случайно, каждому по сопернику; при нечётном числе последний получает соперника из другой пары. */
export function assignDerby(S, rnd = Math.random) {
  const o = S.online, ids = S.teams.map((t) => t.id);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const d = {};
  for (let i = 0; i + 1 < ids.length; i += 2) { d[ids[i]] = ids[i + 1]; d[ids[i + 1]] = ids[i]; }
  if (ids.length % 2 && ids.length > 1) d[ids[ids.length - 1]] = ids[0];
  o.derby = d;
  return d;
}
export const isDerby = (o, h, a) => !!o.derby && (o.derby[h] === a || o.derby[a] === h);
/** Отмечает матчи дерби в расписании (и новые слоты плей-офф). */
export function markDerby(o) {
  for (const s of o.slots) for (const g of s.games) if (g.derby == null) g.derby = isDerby(o, g.h, g.a);
}

/** Итоги дерби по клубам: игры, победы, шайбы. hide(slot) — не учитывать ещё идущие трансляции. */
export function derbyTable(S, hide = () => false) {
  const o = S.online, t = {};
  for (const tm of S.teams) t[tm.id] = { gp: 0, w: 0, gf: 0, ga: 0 };
  for (const s of o.slots) {
    if (hide(s)) continue;
    for (const g of s.games) {
      if (!g.derby || !g.done || g.skip || !g.res) continue;
      const H = t[g.h], A = t[g.a], r = g.res;
      H.gp++; A.gp++; H.gf += r.gh; H.ga += r.ga; A.gf += r.ga; A.ga += r.gh;
      if (r.gh > r.ga) H.w++; else A.w++;
    }
  }
  return t;
}

const nm = (p) => (p.nat === 'CHN' ? p.f + ' ' + p.l : p.f[0] + '. ' + p.l);
const pubP = (S, p, val, extra = {}) => ({ id: p.id, n: nm(p), pos: p.pos, team: p.team, club: (S.teams[p.team] || {}).name || null, val, ...extra });

/** Подводит итоги сезона: места, очки рейтинга, награды. Один раз, когда известен чемпион. */
export function finalize(G, S, now = Date.now()) {
  const o = S.online;
  if (o.champ == null || o.results) return o.results || null;
  ensureFin(S);
  const N = S.teams.length;
  const order = (o.seeds && o.seeds.length === N ? o.seeds : S.teams.slice().sort(G.ev('cmpStand')).map((t) => t.id));
  const place = {}; order.forEach((id, i) => { place[id] = i + 1; });
  // пройденные раунды плей-офф
  const rounds = {}; S.teams.forEach((t) => { rounds[t.id] = 0; });
  const W = o.cfg.seriesWins;
  for (const r of (o.po && o.po.rounds) || []) for (const s of r) { const w = s.wa >= W ? s.a : s.wb >= W ? s.b : null; if (w != null) rounds[w]++; }
  const dt = derbyTable(S);
  const placePts = (p) => (N > 1 ? Math.round(PTS.place * (N - p) / (N - 1)) : PTS.place);

  // награды игроков: по всему турниру
  const ps = S.players.filter((p) => p.team >= 0 && p.team < N);
  const sk = ps.filter((p) => p.pos !== 'G' && (p.gp || 0) > 0);
  const sniper = sk.slice().sort((a, b) => b.g - a.g || (b.g + b.a) - (a.g + a.a) || a.gp - b.gp)[0] || null;
  const scorer = sk.slice().sort((a, b) => (b.g + b.a) - (a.g + a.a) || b.g - a.g || a.gp - b.gp)[0] || null;
  const maxGp = Math.max(1, ...ps.map((p) => p.gp || 0));
  const sv = (p) => (p.gsa ? (p.gsa - p.gga) / p.gsa : 0), gaa = (p) => (p.gp ? p.gga / p.gp : 9);
  const goalie = ps.filter((p) => p.pos === 'G' && (p.gp || 0) >= Math.max(3, Math.round(maxGp * 0.4)) && p.gsa > 0)
    .sort((a, b) => sv(b) - sv(a) || gaa(a) - gaa(b))[0] || null;

  // менеджеры: все, кто вёл клуб (в том числе ушедшие к боту из-за неактивности)
  const mgr = Object.entries(o.humans).filter(([, h]) => h && h.uid != null).map(([k, h]) => ({ tid: +k, uid: h.uid, name: h.name || 'Менеджер', bot: !!h.bot }));
  const active = mgr.filter((m) => !m.bot);
  const fin = (tid) => o.fin[tid];
  const genius = active.slice().sort((a, b) => profitOf(fin(b.tid)) - profitOf(fin(a.tid)) || incomeOf(fin(b.tid)) - incomeOf(fin(a.tid)))[0] || null;
  const dspec = active.filter((m) => dt[m.tid].w > 0)
    .sort((a, b) => dt[b.tid].w - dt[a.tid].w || (dt[b.tid].gf - dt[b.tid].ga) - (dt[a.tid].gf - dt[a.tid].ga) || dt[b.tid].gf - dt[a.tid].gf)[0] || null;

  const awards = {
    sniper: sniper && pubP(S, sniper, sniper.g, { gp: sniper.gp }),
    scorer: scorer && pubP(S, scorer, scorer.g + scorer.a, { g: scorer.g, a: scorer.a, gp: scorer.gp }),
    goalie: goalie && pubP(S, goalie, Math.round(sv(goalie) * 1000) / 1000, { gp: goalie.gp, gaa: Math.round(gaa(goalie) * 100) / 100 }),
    genius: genius && { uid: genius.uid, name: genius.name, team: genius.tid, club: S.teams[genius.tid].name, val: profitOf(fin(genius.tid)), income: incomeOf(fin(genius.tid)) },
    derby: dspec && { uid: dspec.uid, name: dspec.name, team: dspec.tid, club: S.teams[dspec.tid].name, val: dt[dspec.tid].w, gf: dt[dspec.tid].gf, ga: dt[dspec.tid].ga },
  };
  const rows = mgr.map((m) => {
    const d = dt[m.tid], pts = { place: placePts(place[m.tid]), po: rounds[m.tid] * PTS.round, derby: d.w * PTS.derbyWin };
    const my = [];
    if (o.champ === m.tid) my.push('champ');
    if (awards.genius && awards.genius.uid === m.uid) my.push('genius');
    if (awards.derby && awards.derby.uid === m.uid) my.push('derby');
    return { uid: m.uid, name: m.name, team: m.tid, club: S.teams[m.tid].name, active: !m.bot, place: place[m.tid], poRounds: rounds[m.tid],
      derbyW: d.w, derbyGp: d.gp, derbyGf: d.gf, derbyGa: d.ga, profit: profitOf(fin(m.tid)), income: incomeOf(fin(m.tid)),
      pts, points: pts.place + pts.po + pts.derby, awards: my };
  });
  o.results = { at: now, test: !!o.cfg.test, awards, rows, champ: o.champ };
  return o.results;
}

/** Рейтинг менеджеров из строк базы (сезоны новые первыми): сумма 6 последних рейтинговых сезонов с затуханием. */
export function ratingFrom(rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.test) continue;
    const u = by.get(r.uid) || { uid: r.uid, name: r.name, n: 0, pts: 0, seasons: 0, champs: 0, awards: 0 };
    if (u.n < DECAY.length) u.pts += r.points * DECAY[u.n];
    u.n++; u.seasons++;
    const aw = r.awards || [];
    if (aw.includes('champ')) u.champs++;
    u.awards += aw.filter((x) => x !== 'champ').length;
    by.set(r.uid, u);
  }
  return [...by.values()].map((u) => ({ ...u, pts: Math.round(u.pts * 10) / 10 })).sort((a, b) => b.pts - a.pts || b.champs - a.champs);
}
