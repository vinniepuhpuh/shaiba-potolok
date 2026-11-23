/**
 * Онлайн-режим: реестр сезонов. Параллельно живёт сколько угодно сезонов, каждый — объект
 * S игры (как в карьере) с полем S.online. Все изменения идут через одну очередь, состояние
 * сохраняется в базу. Движок G общий один: перед расчётом каждого слота runDue сам ставит
 * G.S = S, а setHooks/coachHooks заново выставляют HOOK, __coaches и __styK — скрытого кэша
 * между сезонами нет (зафиксировано тестом server/test/seasons.test.js).
 */
import zlib from 'node:zlib';
import { loadGame } from './engine.js';
import { marketView, releasePlayer, tradeCheck, proposeTrade, answerTrade, marketTick } from './market.js';
import { academyView, acadSearch, acadTake, acadPromote, buyUpg, bidFA, bidPoach, poachMatch, inheritAcademy } from './academy.js';
import { staffView, setMode, hireCoach, chooseSponsor } from './staff.js';
import { ensureFin, finView, setPrices, buyArena } from './fin.js';
import { assignDerby, markDerby, finalize, ratingFrom, isDerby } from './awards.js';
import { createSeason, runDue, publicView, joinSeason, teamView, setPlan, setLines, markPresence, preOf, dueNotifications } from './league.js';

const EVICT_FINISHED_MS = 30 * 60e3; // завершённые сезоны, к которым давно не обращались, выгружаем из памяти

export function makeOnline(pool, htmlPath, log = console, opts = {}) {
  let G = null, chain = Promise.resolve();
  const seasons = new Map(); // sid -> {sid, S, last}
  const maxPerUser = Math.max(1, Number(opts.maxSeasonsPerUser || 3));
  const q = (fn) => (chain = chain.then(fn, fn).catch((e) => { log.error?.(e); throw e; }));

  async function save(rec) {
    await pool.query('UPDATE online_seasons SET state=$2, updated_at=now(), status=$3 WHERE id=$1',
      [rec.sid, JSON.stringify(rec.S), rec.S.online.champ != null ? 'finished' : 'active']);
  }
  // поля, которых нет в сезонах, сохранённых старой версией сервера
  function migrateState(S) {
    let ch = false;
    const c = S.online.cfg;
    if (c.preSec == null) { c.preSec = 60; ch = true; }
    if (c.presenceK == null) { c.presenceK = 1.02; ch = true; }
    if (c.liveMin > 5) { c.liveMin = 5; ch = true; }
    if (c.template == null) { c.template = c.big ? 'big' : 'test8'; ch = true; }
    if (!S.online.fin) { ensureFin(S); ch = true; }
    if (!S.online.derby) { assignDerby(S); ch = true; }
    if (S.online.slots.some((s) => s.games.some((g) => g.derby == null))) { markDerby(S.online); ch = true; }
    return ch;
  }
  function addSeason(sid, S) {
    const rec = { sid, S, last: Date.now() };
    seasons.set(sid, rec);
    return rec;
  }
  /** Загрузка сезона: из памяти, иначе лениво из базы (для просмотра итогов). */
  async function loadSeason(sid) {
    let rec = seasons.get(sid);
    if (rec) { rec.last = Date.now(); return rec; }
    const r = (await pool.query("SELECT id, state FROM online_seasons WHERE id=$1 AND status != 'archived'", [sid])).rows[0];
    if (!r) return null;
    const S = r.state;
    G.S = S;
    S.teams.forEach((t) => G.ev('ensureNums')(t.id));
    if (migrateState(S)) await pool.query('UPDATE online_seasons SET state=$2 WHERE id=$1', [sid, JSON.stringify(S)]);
    rec = addSeason(sid, S);
    return rec;
  }
  function evict() {
    const now = Date.now();
    for (const [id, rec] of seasons) {
      if (rec.S.online.champ != null && now - rec.last > EVICT_FINISHED_MS) seasons.delete(id);
    }
  }
  async function init() {
    G = loadGame(htmlPath);
    const rows = (await pool.query("SELECT id, state FROM online_seasons WHERE status = 'active' ORDER BY id")).rows;
    for (const r of rows) {
      const S = r.state;
      G.S = S;
      S.teams.forEach((t) => G.ev('ensureNums')(t.id));
      if (migrateState(S)) await pool.query('UPDATE online_seasons SET state=$2 WHERE id=$1', [r.id, JSON.stringify(S)]);
      const rec = addSeason(r.id, S);
      if (S.online.champ != null && !S.online.saved) await saveResults(rec);
    }
    log.info?.(`online: движок ${G.version}, активных сезонов: ${seasons.size}`);
    try { await conveyorCheck(); } catch (e) { log.error?.(e, 'конвейер лиг при старте пропущен'); }
  }
  /** Число активных сезонов, где uid ведёт клуб (не бот). */
  function activeCount(uid, exceptSid = null) {
    let n = 0;
    for (const [id, rec] of seasons) {
      if (id === exceptSid) continue;
      const o = rec.S.online;
      if (o.champ != null) continue;
      for (const h of Object.values(o.humans)) if (h && h.uid === uid && !h.bot) { n++; break; }
    }
    return n;
  }
  // итоги сезона в базу: по строке на менеджера (для рейтинга и профиля)
  async function saveResults(rec) {
    const S = rec.S;
    const R = S.online.results || finalize(G, S);
    if (!R) return;
    for (const r of R.rows) {
      await pool.query(
        `INSERT INTO online_results (season_id, uid, team, club, name, test, place, po_rounds, derby_w, points, profit, awards)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (season_id, uid) DO NOTHING`,
        [rec.sid, r.uid, r.team, r.club, r.name, R.test, r.place, r.poRounds, r.derbyW, r.points, r.profit, JSON.stringify(r.awards)]);
    }
    S.online.saved = true;
    await save(rec);
  }
  /** Считает все наступившие матчи во всех активных сезонах. Ошибка одного сезона не роняет остальные. */
  async function tick(now = Date.now()) {
    return q(async () => {
      let played = 0;
      for (const rec of seasons.values()) {
        const S = rec.S;
        if (S.online.champ != null) continue; // сезон доигран
        try {
          marketTick(S, now, G);
          const games = runDue(G, S, now);
          for (const g of games) {
            await pool.query(
              `INSERT INTO online_games (season_id, gid, slot, kind, t_start, home, away, res, box, ev, log)
               VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0),$6,$7,$8,$9,$10,$11) ON CONFLICT (season_id,gid) DO NOTHING`,
              [rec.sid, g.gid, g.slot, g.kind, g.t, g.h, g.a, g.res, JSON.stringify(g.box || null), JSON.stringify(g.ev || []), zlib.gzipSync(JSON.stringify(g.log))]
            );
          }
          played += games.length;
          if (S.online.champ != null && !S.online.results) finalize(G, S, now);
          await save(rec);
          if (S.online.results && !S.online.saved) await saveResults(rec);
        } catch (e) {
          log.error?.(e, `tick сезона ${rec.sid} пропущен`);
        }
      }
      evict();
      try { await conveyorCheck(now); } catch (e) { log.error?.(e, 'конвейер лиг пропущен'); }
      return played;
    });
  }
  /** Настройки конвейера из таблицы settings (дефолты: выключен, шаблон big). */
  async function conveyorSettings() {
    const rows = (await pool.query('SELECT key, value FROM settings')).rows;
    let enabled = false, template = 'big';
    for (const r of rows) {
      if (r.key === 'conveyor.enabled') enabled = r.value === true || r.value === 'true';
      if (r.key === 'conveyor.template') template = typeof r.value === 'string' ? r.value : 'big';
    }
    return { enabled, template: template === 'test8' ? 'test8' : 'big' };
  }
  /** Следующее имя конвейерной лиги: «Большая лига №N», N = max номер + 1 по именам в базе. */
  async function nextConveyorName() {
    const rows = (await pool.query("SELECT name FROM online_seasons WHERE name LIKE 'Большая лига №%'")).rows;
    let n = 0;
    for (const r of rows) { const m = String(r.name).match(/№(\d+)\s*$/); if (m) n = Math.max(n, +m[1]); }
    return `Большая лига №${n + 1}`;
  }
  /** Донор наследования академии. Конвейерные лиги наследуют из последней конвейерной,
   * ручные — из последнего сезона по id (прежнее поведение). Сюда потом лягут частные турниры. */
  async function inheritDonor(conveyor) {
    if (conveyor) {
      const rows = (await pool.query(
        `SELECT id FROM online_seasons WHERE (state->'online'->'cfg'->>'conveyor') = 'true' ORDER BY id DESC LIMIT 20`)).rows;
      for (const r of rows) { const rec = await loadSeason(r.id); if (rec) return rec.S; }
      return null;
    }
    const last = (await pool.query('SELECT id FROM online_seasons ORDER BY id DESC LIMIT 1')).rows[0];
    if (!last) return null;
    const rec = await loadSeason(last.id);
    return rec ? rec.S : null;
  }
  /** Конвейер открытых лиг: если среди активных нет ни одной открытой — создать следующую (максимум одну).
   * Новая лига не создаётся, если в предыдущей конвейерной не было живых игроков (пустая не плодит пустую). */
  async function conveyorCheck(now = Date.now()) {
    let open = 0;
    for (const rec of seasons.values()) {
      const o = rec.S.online;
      if (o.champ != null) continue;
      const humans = Object.values(o.humans).filter((h) => h && !h.bot).length;
      if (now < o.deadlineT && humans < rec.S.teams.length) open++;
    }
    if (open > 0) return null; // открытая лига есть (правило заодно защищает от дублей: 2+ открытых → не создаём)
    const st = await conveyorSettings();
    if (!st.enabled) return null;
    const last = (await pool.query(
      `SELECT EXISTS (SELECT 1 FROM jsonb_each(state->'online'->'humans') e WHERE (e.value->>'bot') IS DISTINCT FROM 'true') AS had_humans
       FROM online_seasons WHERE (state->'online'->'cfg'->>'conveyor') = 'true' AND status != 'archived'
       ORDER BY id DESC LIMIT 1`)).rows[0];
    if (last && !last.had_humans) return null; // предыдущая конвейерная осталась пустой
    const name = await nextConveyorName();
    return createLocked({ template: st.template, test: false, conveyor: true, name }, now);
  }
  /** Рейтинг менеджеров: топ-50, моё место и мои сезоны. По строкам всех сезонов — не ломать. */
  async function rating(uid) {
    const rows = (await pool.query('SELECT uid, name, test, points, awards FROM online_results ORDER BY season_id DESC')).rows;
    const all = ratingFrom(rows), i = uid == null ? -1 : all.findIndex((u) => u.uid === uid);
    const hist = uid == null ? [] : (await pool.query(
      `SELECT r.season_id, s.name AS season, r.club, r.place, r.po_rounds, r.derby_w, r.points, r.test, r.awards
       FROM online_results r JOIN online_seasons s ON s.id = r.season_id WHERE r.uid = $1 ORDER BY r.season_id DESC LIMIT 20`, [uid])).rows;
    const pub = (u, k) => ({ pos: k + 1, name: u.name, pts: u.pts, seasons: u.seasons, champs: u.champs, awards: u.awards, me: u.uid === uid });
    return { top: all.slice(0, 50).map(pub), me: i >= 0 ? pub(all[i], i) : null, history: hist };
  }
  // тело create(): выполняется только внутри очереди (или init до запуска сервера)
  async function createLocked(cfgIn, now = Date.now()) {
    const cfg = { ...(cfgIn || {}) };
    if (cfg.template === 'big') cfg.big = true;
    if (cfg.template == null) cfg.template = cfg.big ? 'big' : 'test8';
    // наследование академии: конвейерные лиги — из последней конвейерной, ручные — из последней по id
    const prev = await inheritDonor(!!cfg.conveyor);
    const S = createSeason(G, cfg, now);
    const inh = inheritAcademy(G, S, prev, now);
    const r = await pool.query('INSERT INTO online_seasons (name, state) VALUES ($1,$2) RETURNING id', [S.online.cfg.name, JSON.stringify(S)]);
    const rec = addSeason(r.rows[0].id, S);
    return { id: rec.sid, slots: S.online.slots.length, first: S.online.slots[0].t, inherited: inh };
  }
  async function create(cfgIn, now = Date.now()) {
    return q(() => createLocked(cfgIn, now));
  }
  /** Последний активный открытый сезон — для старых клиентов без sid. */
  async function latestOpen(now = Date.now()) {
    let best = null, any = null;
    for (const [id, rec] of seasons) {
      if (rec.S.online.champ != null) continue;
      if (any == null || id > any) any = id;
      if (now < rec.S.online.deadlineT && (best == null || id > best)) best = id;
    }
    return best ?? any;
  }
  /** Список для экрана «Мои турниры». Без авторизации (uid=null) — только открытые лиги. */
  async function seasonsList(uid, now = Date.now()) {
    const rows = (await pool.query(
      `SELECT id, name, status,
         state->'online'->>'champ' AS champ,
         state->'online'->'cfg'->>'test' AS test,
         state->'online'->'cfg'->>'big' AS big,
         (state->'online'->'slots'->0->>'t')::double precision AS start,
         CASE WHEN (state->'online'->>'champ') ~ '^[0-9]+$'
              THEN (state->'teams'->((state->'online'->>'champ')::int))->>'name' END AS champ_name,
         (SELECT place FROM online_results x WHERE x.season_id = online_seasons.id AND x.uid = $1) AS my_place
       FROM online_seasons WHERE status IN ('active','finished') ORDER BY id DESC LIMIT 50`, [uid])).rows;
    const mine = [], open = [], done = [];
    for (const r of rows) {
      const rec = seasons.get(r.id);
      if (rec && r.status === 'active') {
        const S = rec.S, o = S.online;
        const e = uid != null ? Object.entries(o.humans).find(([, h]) => h && h.uid === uid) : null;
        if (e) {
          const tid = +e[0], t = S.teams[tid];
          const stand = S.teams.slice().sort((a, b) => (b.w * 2 + b.ot) - (a.w * 2 + a.ot) || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf);
          const place = stand.findIndex((x) => x.id === tid) + 1;
          let next = null, live = false;
          for (const s of o.slots) {
            const g = s.games.find((x) => !x.done && !x.skip && (x.h === tid || x.a === tid));
            if (g) {
              next = { gid: g.id, t: s.t, home: g.h === tid, opp: S.teams[g.h === tid ? g.a : g.h].name };
              live = now >= s.t && now < s.t + preOf(o) + o.cfg.liveMin * 60e3;
              break;
            }
          }
          mine.push({ sid: r.id, name: o.cfg.name, test: !!o.cfg.test, team: tid, club: t.name, bot: !!e[1].bot,
            place, live, next, canRejoin: !!e[1].bot && now < o.deadlineT });
        }
        // сезон открыт для входа, пока не прошёл дедлайн и остались свободные клубы —
        // даже если я в нём уже играю: «Мои турниры» и «Открытые лиги» не взаимоисключающие
        const humans = Object.values(o.humans).filter((h) => h && !h.bot).length;
        if (now < o.deadlineT && humans < S.teams.length) {
          open.push({ sid: r.id, name: o.cfg.name, test: !!o.cfg.test, big: !!o.cfg.big,
            humans, teams: S.teams.length, start: o.slots[0].t, deadlineT: o.deadlineT });
        }
      } else if (r.champ != null) {
        done.push({ sid: r.id, name: r.name, test: r.test === 'true' || r.test === true, champ: r.champ_name || null, myPlace: r.my_place ?? null });
      }
    }
    if (uid == null) return { open };
    return { mine, open, done: done.slice(0, 10) };
  }
  /** Досрочное завершение: чемпион — лидер текущей таблицы, итоги и награды как обычно. */
  async function finishSeason(sid, now = Date.now()) {
    return q(async () => {
      const rec = await loadSeason(sid);
      if (!rec) return { error: 'no_season' };
      const S = rec.S;
      if (S.online.champ == null) {
        S.online.champ = S.teams.slice().sort(G.ev('cmpStand'))[0].id;
        S.online.endedAt = now;
      }
      finalize(G, S, now);
      await save(rec);
      await saveResults(rec);
      return { ok: true, champ: S.online.champ };
    });
  }
  async function archiveSeason(sid) {
    return q(async () => {
      await pool.query("UPDATE online_seasons SET status='archived' WHERE id=$1", [sid]);
      seasons.delete(sid);
      return { ok: true };
    });
  }
  /** Удалить можно только не начавшийся и пустой сезон. */
  async function deleteSeason(sid) {
    return q(async () => {
      const rec = await loadSeason(sid);
      if (!rec) return { error: 'no_season' };
      const o = rec.S.online;
      const played = o.slots.some((s) => s.games.some((g) => g.done));
      const humans = Object.values(o.humans).some((h) => h && !h.bot);
      if (played || humans) return { error: 'not_empty' };
      await pool.query('DELETE FROM online_games WHERE season_id=$1', [sid]);
      await pool.query('DELETE FROM online_seasons WHERE id=$1', [sid]);
      seasons.delete(sid);
      return { ok: true };
    });
  }
  /** Передать клуб боту (uid=null) или вернуть человеку. */
  async function setHuman(sid, team, uid, name, now = Date.now()) {
    return q(async () => {
      const rec = await loadSeason(sid);
      if (!rec) return { error: 'no_season' };
      const S = rec.S, o = S.online;
      if (!S.teams[team]) return { error: 'no_team' };
      if (uid == null) {
        const h = o.humans[team];
        if (!h || h.bot) return { error: 'already_bot' };
        h.bot = true;
      } else {
        const cur = o.humans[team];
        const same = cur && cur.uid === uid && !cur.bot;
        if (!same && activeCount(uid, sid) >= maxPerUser) return { error: 'seasons_max', max: maxPerUser };
        o.humans[team] = { uid, name: name || 'Менеджер', joinedAt: now, lastSeen: now, plans: {}, lines: null };
      }
      await save(rec);
      return { ok: true };
    });
  }
  /** uid → бот во всех активных сезонах (удаление аккаунта). Возвращает число клубов. */
  async function dropUser(uid) {
    return q(async () => {
      let n = 0;
      for (const rec of seasons.values()) {
        const o = rec.S.online;
        if (o.champ != null) continue;
        let hit = false;
        for (const h of Object.values(o.humans)) {
          if (h && h.uid === uid && !h.bot) { h.bot = true; h.name = 'Удалённый аккаунт'; hit = true; n++; }
        }
        if (hit) await save(rec);
      }
      return n;
    });
  }
  /** Сводка всех сезонов для админки: статус, люди/боты, день, чемпион. */
  async function adminSeasons() {
    const rows = (await pool.query(
      `SELECT id, name, status, updated_at,
         state->'online'->>'champ' AS champ,
         CASE WHEN (state->'online'->>'champ') ~ '^[0-9]+$'
              THEN (state->'teams'->((state->'online'->>'champ')::int))->>'name' END AS champ_name,
         state->'online'->'cfg'->>'test' AS test,
         state->'online'->'cfg'->>'big' AS big,
         (state->'online'->'cfg'->>'conveyor') = 'true' AS conveyor,
         (state->'online'->'slots'->0->>'t')::double precision AS start,
         (SELECT count(*) FROM jsonb_array_elements(state->'teams'))::int AS clubs,
         (SELECT count(*) FROM jsonb_each(state->'online'->'humans') e WHERE (e.value->>'bot') IS DISTINCT FROM 'true')::int AS humans,
         (SELECT count(*) FROM jsonb_each(state->'online'->'humans') e WHERE (e.value->>'bot') = 'true')::int AS bots,
         (SELECT min((s.value->>'i')::int) FROM jsonb_array_elements(state->'online'->'slots') s
           WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(s.value->'games') g WHERE (g.value->>'done') IS DISTINCT FROM 'true')) AS day
       FROM online_seasons ORDER BY id DESC`)).rows;
    return rows.map((r) => {
      const rec = seasons.get(r.id);
      const o = rec ? rec.S.online : null;
      const done = o ? o.slots.filter((s) => s.games.every((g) => g.done)).length : null;
      return {
        sid: r.id, name: r.name, status: o ? (o.champ != null ? 'finished' : 'active') : r.status,
        test: o ? !!o.cfg.test : r.test === 'true', big: o ? !!o.cfg.big : r.big === 'true',
        conveyor: o ? !!o.cfg.conveyor : !!r.conveyor,
        clubs: o ? o.cfg.clubs.length : r.clubs, humans: o ? Object.values(o.humans).filter((h) => h && !h.bot).length : r.humans,
        bots: o ? Object.values(o.humans).filter((h) => h && h.bot).length : r.bots,
        start: o && o.slots[0] ? o.slots[0].t : r.start,
        day: o ? `${done}/${o.slots.length}` : r.day != null ? String(r.day) : '—',
        champ: o ? o.champ : r.champ != null ? Number(r.champ) : null,
        champName: o && o.champ != null ? (rec.S.teams[o.champ] || {}).name || null : r.champ_name || null,
        updated_at: r.updated_at,
      };
    });
  }
  /** Клубы uid в активных сезонах (для карточки участника в админке). */
  async function userClubs(uid) {
    const out = [];
    for (const rec of seasons.values()) {
      const o = rec.S.online;
      for (const [tid, h] of Object.entries(o.humans)) {
        if (h && h.uid === uid) out.push({ sid: rec.sid, name: o.cfg.name, team: +tid, club: rec.S.teams[tid].name, bot: !!h.bot, active: o.champ == null, test: !!o.cfg.test });
      }
    }
    return out.sort((a, b) => b.sid - a.sid);
  }
  async function view(uid, sid, now = Date.now()) {
    const rec = await loadSeason(sid);
    if (!rec) return null;
    rec.last = Date.now();
    G.S = rec.S;
    return { id: rec.sid, ...publicView(G, rec.S, now, uid) };
  }
  async function join(uid, name, team, sid, now = Date.now()) {
    return q(async () => {
      const rec = await loadSeason(sid);
      if (!rec) return { error: 'no_season' };
      const S = rec.S;
      const here = Object.values(S.online.humans).some((h) => h && h.uid === uid && !h.bot);
      if (!here && activeCount(uid, sid) >= maxPerUser) return { error: 'seasons_max', max: maxPerUser };
      const r = joinSeason(S, team, uid, name, now);
      if (r.ok) await save(rec);
      return r;
    });
  }
  async function touch(uid, sid, now = Date.now()) {
    const rec = sid == null ? null : seasons.get(sid);
    if (!rec) return;
    for (const h of Object.values(rec.S.online.humans)) if (h && h.uid === uid) h.lastSeen = now;
  }
  async function game(gid, sid, now = Date.now(), uid = null) {
    const rec0 = await loadSeason(sid);
    if (!rec0) return null;
    // отметка присутствия идёт через очередь: состояние меняется
    const m = await q(async () => {
      const rec = await loadSeason(sid);
      const r = markPresence(rec.S, uid, gid, now);
      if (!r.error && uid && r.canMark && r.present) await save(rec);
      return r;
    });
    if (m.error) return null;
    const rec = rec0;
    const row = (await pool.query('SELECT gid, slot, kind, extract(epoch from t_start)*1000 AS t, home, away, res, box, ev, log FROM online_games WHERE season_id=$1 AND gid=$2', [rec.sid, gid])).rows[0];
    const pres = { present: m.present, mine: m.mine, canMark: m.canMark };
    if (!row) return { gid, t: m.slot.t + preOf(rec.S.online), home: m.g.h, away: m.g.a, kind: m.slot.kind, started: false, ...pres };
    const t = Number(row.t), liveMs = rec.S.online.cfg.liveMin * 60e3;
    if (now < t) return { gid, t, home: row.home, away: row.away, kind: row.kind, started: false, ...pres };
    const ticks = JSON.parse(zlib.gunzipSync(row.log).toString());
    const done = now >= t + liveMs;
    const n = done ? ticks.length : Math.min(ticks.length, Math.floor((now - t) / (liveMs / ticks.length)) + 1);
    const lastTick = ticks[n - 1], secNow = lastTick ? (lastTick[0] >= 4 ? 3600 + (lastTick[1] - 180) * 20 : lastTick[1] * 20) : 0;
    const ev = done ? row.ev : (row.ev || []).filter((e) => (e.per - 1) * 1200 + e.s <= secNow);
    return { gid, t, home: row.home, away: row.away, kind: row.kind, started: true, done, liveMs, total: ticks.length, ticks: ticks.slice(0, n), ev, res: done ? row.res : null, box: done ? row.box : null, rost: row.box && row.box.rost, gk: row.box && row.box.gkId, sty: row.box && row.box.sty, ...pres };
  }
  async function team(tid, uid, sid) {
    const rec = await loadSeason(sid);
    if (!rec) return null;
    rec.last = Date.now();
    return teamView(G, rec.S, tid, uid);
  }
  /** Пуш-напоминания о матчах всех активных сезонов (с id сезона и именем турнира). */
  async function notify(now = Date.now()) {
    return q(async () => {
      const out = [];
      for (const rec of seasons.values()) {
        const S = rec.S;
        if (S.online.champ != null) continue;
        const list = dueNotifications(S, now, S.online.cfg.name);
        if (list.length) {
          out.push(...list.map((n) => ({ ...n, sid: rec.sid })));
          await save(rec);
        }
      }
      return out;
    });
  }
  async function plan(uid, key, p, sid, now = Date.now()) {
    return q(async () => { const rec = await loadSeason(sid); if (!rec) return { error: 'no_season' }; const r = setPlan(rec.S, uid, key, p, now); if (r.ok) await save(rec); return r; });
  }
  async function lines(uid, body, sid, now = Date.now()) {
    return q(async () => { const rec = await loadSeason(sid); if (!rec) return { error: 'no_season' }; const r = setLines(G, rec.S, uid, body, now); if (r.ok) await save(rec); return r; });
  }
  // рынок: все изменения через очередь, после успешного — сохранение
  const mut = (fn) => async (uid, body, sid, now = Date.now()) => q(async () => {
    const rec = await loadSeason(sid);
    if (!rec) return { error: 'no_season' };
    const r = fn(G, rec.S, uid, body || {}, now);
    if (r && r.ok) await save(rec);
    return r;
  });
  async function market(uid, sid, now = Date.now()) {
    const rec = await loadSeason(sid);
    if (!rec) return null;
    rec.last = Date.now();
    return marketView(G, rec.S, uid, now);
  }
  async function tradeEval(uid, b, sid, now = Date.now()) {
    const rec = await loadSeason(sid);
    if (!rec) return { error: 'no_season' };
    rec.last = Date.now();
    const e = Object.entries(rec.S.online.humans).find(([, h]) => h && h.uid === uid && !h.bot);
    if (!e) return { error: 'not_joined' };
    return tradeCheck(G, rec.S, +e[0], Number(b.to), (b.give || []).map(Number), (b.get || []).map(Number), now);
  }
  async function fin(uid, sid, now = Date.now()) {
    const rec = await loadSeason(sid);
    if (!rec) return { error: 'no_season' };
    rec.last = Date.now();
    return finView(rec.S, uid, now, isDerby);
  }
  async function academy(uid, sid, now = Date.now()) {
    const rec = await loadSeason(sid);
    if (!rec) return null;
    rec.last = Date.now();
    return academyView(G, rec.S, uid, now);
  }
  async function staff(uid, sid, now = Date.now()) {
    const rec = await loadSeason(sid);
    if (!rec) return null;
    rec.last = Date.now();
    return staffView(G, rec.S, uid, now);
  }
  return { init, tick, create, view, join, touch, game, team, plan, lines, market, tradeEval, fin, rating, notify, academy, staff,
    seasonsList, latestOpen, finishSeason, archiveSeason, deleteSeason, setHuman, dropUser, adminSeasons, userClubs, conveyorCheck,
    prices: mut(setPrices), arena: mut((G_, S_, uid) => buyArena(G_, S_, uid)),
    bid: mut(bidFA), poachBid: mut(bidPoach), search: mut((G_, S_, uid, b, now) => acadSearch(G_, S_, uid, now)),
    take: mut(acadTake), promote: mut(acadPromote), upg: mut(buyUpg), match: mut(poachMatch), release: mut(releasePlayer),
    coachMode: mut(setMode), coachHire: mut(hireCoach), sponsor: mut(chooseSponsor),
    trade: mut(proposeTrade), answer: mut((G_, S_, uid, b, now) => answerTrade(G_, S_, uid, String(b.id), String(b.action), now)),
    get active() { for (const rec of seasons.values()) if (rec.S.online.champ == null) return true; return false; } };
}
