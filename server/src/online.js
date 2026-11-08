import zlib from 'node:zlib';
import { loadGame } from './engine.js';
import { createSeason, runDue, publicView, joinSeason, teamView, setPlan, setLines } from './league.js';

/** Онлайн-режим: один активный сезон в памяти, все изменения по очереди, состояние сохраняется в базу. */
export function makeOnline(pool, htmlPath, log = console) {
  let G = null, S = null, sid = null, chain = Promise.resolve();
  const q = (fn) => (chain = chain.then(fn, fn).catch((e) => { log.error?.(e); throw e; }));

  async function save() {
    await pool.query('UPDATE online_seasons SET state=$2, updated_at=now(), status=$3 WHERE id=$1',
      [sid, JSON.stringify(S), S.online.champ != null ? 'finished' : 'active']);
  }
  async function init() {
    G = loadGame(htmlPath);
    const r = (await pool.query("SELECT id, state FROM online_seasons WHERE status IN ('active','finished') ORDER BY id DESC LIMIT 1")).rows[0];
    if (r) { sid = r.id; S = r.state; G.S = S; S.teams.forEach((t) => G.ev('ensureNums')(t.id)); }
    log.info?.(`online: движок ${G.version}, сезон ${sid ?? 'нет'}`);
  }
  async function tick(now = Date.now()) {
    return q(async () => {
      if (!S) return 0;
      const games = runDue(G, S, now);
      if (!games.length) return 0;
      for (const g of games) {
        await pool.query(
          `INSERT INTO online_games (season_id, gid, slot, kind, t_start, home, away, res, box, ev, log)
           VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0),$6,$7,$8,$9,$10,$11) ON CONFLICT (season_id,gid) DO NOTHING`,
          [sid, g.gid, g.slot, g.kind, g.t, g.h, g.a, g.res, JSON.stringify(g.box || null), JSON.stringify(g.ev || []), zlib.gzipSync(JSON.stringify(g.log))]
        );
      }
      await save();
      return games.length;
    });
  }
  async function create(cfg, now = Date.now()) {
    return q(async () => {
      await pool.query("UPDATE online_seasons SET status='archived' WHERE status IN ('active','finished')");
      S = createSeason(G, cfg || {}, now);
      const r = await pool.query('INSERT INTO online_seasons (name, state) VALUES ($1,$2) RETURNING id', [S.online.cfg.name, JSON.stringify(S)]);
      sid = r.rows[0].id;
      return { id: sid, slots: S.online.slots.length, first: S.online.slots[0].t };
    });
  }
  function view(uid, now = Date.now()) {
    if (!S) return null;
    G.S = S;
    return { id: sid, ...publicView(G, S, now, uid) };
  }
  async function join(uid, name, team, now = Date.now()) {
    return q(async () => {
      if (!S) return { error: 'no_season' };
      const r = joinSeason(S, team, uid, name, now);
      if (r.ok) await save();
      return r;
    });
  }
  async function touch(uid, now = Date.now()) {
    if (!S) return;
    for (const h of Object.values(S.online.humans)) if (h && h.uid === uid) h.lastSeen = now;
  }
  async function game(gid, now = Date.now()) {
    if (!S) return null;
    const row = (await pool.query('SELECT gid, slot, kind, extract(epoch from t_start)*1000 AS t, home, away, res, box, ev, log FROM online_games WHERE season_id=$1 AND gid=$2', [sid, gid])).rows[0];
    if (!row) return null;
    const t = Number(row.t), liveMs = S.online.cfg.liveMin * 60e3;
    if (now < t) return { gid, t, home: row.home, away: row.away, started: false };
    const ticks = JSON.parse(zlib.gunzipSync(row.log).toString());
    const done = now >= t + liveMs;
    const n = done ? ticks.length : Math.min(ticks.length, Math.floor((now - t) / (liveMs / ticks.length)) + 1);
    const lastTick = ticks[n - 1], secNow = lastTick ? (lastTick[0] >= 4 ? 3600 + (lastTick[1] - 180) * 20 : lastTick[1] * 20) : 0;
    const ev = done ? row.ev : (row.ev || []).filter((e) => (e.per - 1) * 1200 + e.s <= secNow);
    return { gid, t, home: row.home, away: row.away, kind: row.kind, started: true, done, liveMs, total: ticks.length, ticks: ticks.slice(0, n), ev, res: done ? row.res : null, box: done ? row.box : null, rost: row.box && row.box.rost, gk: row.box && row.box.gkId, sty: row.box && row.box.sty };
  }
  function team(tid, uid) { if (!S) return null; return teamView(G, S, tid, uid); }
  async function plan(uid, key, p, now = Date.now()) {
    return q(async () => { if (!S) return { error: 'no_season' }; const r = setPlan(S, uid, key, p, now); if (r.ok) await save(); return r; });
  }
  async function lines(uid, body, now = Date.now()) {
    return q(async () => { if (!S) return { error: 'no_season' }; const r = setLines(G, S, uid, body, now); if (r.ok) await save(); return r; });
  }
  return { init, tick, create, view, join, touch, game, team, plan, lines, get active() { return !!S; } };
}
