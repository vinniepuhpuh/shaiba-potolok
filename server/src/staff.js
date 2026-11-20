// Тренерский штаб и титульный спонсор в онлайн-сезоне.
// Главный тренер: 1 ведущий стиль (FIT ×1.2), 2 хороших (×1.1), остальные без бонуса.
// Тренер по физподготовке: переключатель «основа/академия» и шкала −100…+100 (±8 за игровой день).
//  В плюсе: основе временная сила до +3 и рост до ×1.4; в минусе: основе до −2 и рост до ×0.6,
//  зато академия растёт до ×1.5. Шкала соперникам не видна — только 🔥 у команд «в ударе».
// Рынок тренеров: небольшой пул, замена не больше 2 раз за сезон.
// Спонсор: один из трёх предложений на сезон; еженедельные выплаты, в конце сезона проверка
//  требования: выполнил — премия и очки рейтинга, не выполнил — ничего.
// Деньги — в тысячах $, как в игре.

export const STAFF = {
  swapMax: 2, // замен тренеров за сезон
  scaleStep: 8, scaleMax: 100, // шкала физика за игровой день (~13 дней от нуля до максимума)
  plusMax: 3, minusMax: 2, // временная сила основы
  growMain: 0.4, growAcad: 0.5, // амплитуды влияния на рост
  marketHead: 4, marketPhys: 3, // пул свободных тренеров
  leadFit: 1.2, goodFit: 1.1, // множители FIT главного тренера
  hotAt: 60, // шкала «в ударе» для значка 🔥
  modeCdMs: null, // переключение режима — не чаще раза в игровой день (задаётся от dayMs)
};

const ST4 = ['FC', 'PO', 'TR', 'CA'];
const SPON_NAMES = ['Тайга Сталь', 'Севернефть', 'ВолгаМоторс', 'УралХим', 'Сибирь Телеком', 'ДальЭнерго', 'Байкал Банк', 'КазаньАгро', 'Полюс Золото', 'ТрансРельс', 'АрктикГаз', 'Восток Уголь'];

// Спонсорские архетипы: больше денег — жёстче требование и меньше очков рейтинга.
// req: доля таблицы (в большой лиге — доля своей конференции).
export const SPONSOR_TIERS = [
  { tier: 'A', name: 'Амбициозный партнёр', week: 1000, bonus: 3000, pts: 3, req: 0.12, reqTxt: (n, big) => `место не ниже ${n}-го${big ? ' в конференции' : ' в регулярке'}` },
  { tier: 'B', name: 'Надёжный партнёр', week: 550, bonus: 1500, pts: 6, req: 0.5, reqTxt: (n, big) => big ? `выход в плей-офф (не ниже ${n}-го в конференции)` : `место не ниже ${n}-го в регулярке` },
  { tier: 'C', name: 'Верный партнёр', week: 250, bonus: 500, pts: 10, req: 0.75, reqTxt: (n, big) => `место не ниже ${n}-го${big ? ' в конференции' : ' в регулярке'}` },
];

export function ensureStaff(S) {
  const o = S.online;
  o.staff = o.staff || {}; o.staffFA = o.staffFA || null; o.spon = o.spon || {}; o.sponOff = o.sponOff || {};
  return o;
}
export const staffOf = (S, tid) => ensureStaff(S).staff[tid] || null;
export const scaleOf = (S, tid) => (staffOf(S, tid) || {}).scale || 0;
/** Временная сила основы от физика: +3 максимум, −2 в минусе. */
export const physPlus = (S, tid) => { const s = scaleOf(S, tid); return s >= 0 ? Math.round(s / 100 * STAFF.plusMax) : Math.round(s / 100 * STAFF.minusMax); };
/** Множитель роста основы: ×1.4 при +100, ×0.6 при −100. */
export const growMainK = (S, tid) => 1 + scaleOf(S, tid) / 100 * STAFF.growMain;
/** Множитель роста академии: до ×1.5, когда шкала ушла в минус. */
export const growAcadK = (S, tid) => 1 + Math.max(0, -scaleOf(S, tid)) / 100 * STAFF.growAcad;

const humanOf = (S, uid) => {
  const e = Object.entries(S.online.humans).find(([, h]) => h && h.uid === uid && !h.bot);
  return e ? { tid: +e[0], h: e[1] } : null;
};
function mlog(S, txt, now) { const o = S.online; o.mlog = o.mlog || []; o.mlog.unshift({ t: now, txt }); o.mlog.length = Math.min(o.mlog.length, 60); }

// ---------- генерация тренеров ----------
function coachName(G, S, nat) {
  const p = G.ev('newPlayer')('C', 50, G.ev('ri')(40, 58), G.ev('pickW')(G.ev('TNW')[nat] || G.ev('OSW')));
  return { f: p.f, l: p.l, nat: p.nat, age: p.age };
}
function makeHead(G, S, tid, lead) {
  const o = ensureStaff(S), t = S.teams[tid];
  lead = lead || G.ev('pick')(ST4);
  const rest = G.ev('shuffle')(ST4.filter((k) => k !== lead));
  return { id: S.nid++, kind: 'head', ...coachName(G, S, t.nat), lead, good: rest.slice(0, 2) };
}
function makePhys(G, S, tid) {
  const t = S.teams[tid];
  return { id: S.nid++, kind: 'phys', ...coachName(G, S, t.nat) };
}
const cnm = (c) => (c.nat === 'CHN' ? c.f + ' ' + c.l : c.f[0] + '. ' + c.l);

/** Стартовый штаб всех клубов и рынок свободных тренеров. Вызывается при создании сезона. */
export function initStaff(G, S) {
  const o = ensureStaff(S);
  for (const t of S.teams) {
    const bestFit = G.ev('styRank')(t)[0]; // стартовый тренер подходит под состав
    o.staff[t.id] = { head: makeHead(G, S, t.id, bestFit), phys: makePhys(G, S, t.id), mode: 'main', scale: 0, swaps: 0, modeT: 0 };
  }
  o.staffFA = [];
  for (let i = 0; i < STAFF.marketHead; i++) o.staffFA.push(makeHead(G, S, S.teams[i % S.teams.length].id));
  for (let i = 0; i < STAFF.marketPhys; i++) o.staffFA.push(makePhys(G, S, S.teams[i % S.teams.length].id));
}

/** Карта тренеров для движка (FIT стилей) и временная сила — выставляется перед слотом. */
export function coachHooks(G, S) {
  const o = ensureStaff(S), C = {}, P = {};
  for (const t of S.teams) {
    const st = o.staff[t.id];
    if (st && st.head) C[t.id] = { lead: st.head.lead, good: st.head.good };
    if (st && st.phys) P[t.id] = physPlus(S, t.id);
  }
  G.ev(`globalThis.__coaches=${JSON.stringify(C)};`);
  return P; // HOOK.plus
}

// ---------- ежедневный тик: шкала физика + выплаты спонсора ----------
/** Вызывается раз в игровой день (из тика академии). dayN — номер игрового дня с 1. */
export function staffDay(G, S, dayN, now) {
  const o = ensureStaff(S);
  for (const t of S.teams) {
    const st = o.staff[t.id];
    if (st && st.phys) st.scale = Math.max(-STAFF.scaleMax, Math.min(STAFF.scaleMax, (st.scale || 0) + (st.mode === 'acad' ? -STAFF.scaleStep : STAFF.scaleStep)));
  }
  // выплаты спонсора раз в 7 игровых дней
  if (dayN % 7 === 0) {
    for (const t of S.teams) {
      const sp = o.spon[t.id];
      if (!sp || !o.fin || !o.fin[t.id]) continue;
      o.fin[t.id].cash += sp.week; o.fin[t.id].inc.tv += sp.week; sp.paid += sp.week; sp.weeks++;
    }
  }
}

// ---------- действия менеджера ----------
/** Переключатель физика: 'main' | 'acad'. Не чаще раза в игровой день. */
export function setMode(G, S, uid, { mode }, now = Date.now()) {
  const o = ensureStaff(S);
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  if (o.champ != null) return { error: 'season_over' };
  if (!['main', 'acad'].includes(mode)) return { error: 'bad_kind' };
  const st = o.staff[me.tid];
  if (!st || !st.phys) return { error: 'gone' };
  const { dayMs } = _dayMs(S);
  if (now - (st.modeT || 0) < dayMs) return { error: 'wait' };
  if (st.mode === mode) return { ok: true, mode, scale: st.scale };
  st.mode = mode; st.modeT = now;
  mlog(S, `«${S.teams[me.tid].name}» переключили физподготовку на ${mode === 'acad' ? 'академию' : 'основной состав'}`, now);
  return { ok: true, mode, scale: st.scale };
}
const _dayMs = (S) => ({ dayMs: S.online.cfg.fastSec ? S.online.cfg.fastSec * 4000 : 864e5 });

/** Нанять тренера с рынка: замена того же типа, не больше swapMax за сезон. */
export function hireCoach(G, S, uid, { id }, now = Date.now()) {
  const o = ensureStaff(S);
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  if (o.champ != null) return { error: 'season_over' };
  const st = o.staff[me.tid];
  if ((st.swaps || 0) >= STAFF.swapMax) return { error: 'swap_max' };
  const i = (o.staffFA || []).findIndex((c) => c.id === Number(id));
  if (i < 0) return { error: 'gone' };
  const c = o.staffFA[i];
  o.staffFA.splice(i, 1);
  st[c.kind] = c; st.swaps++;
  mlog(S, `«${S.teams[me.tid].name}» назначили ${c.kind === 'head' ? 'главным тренером' : 'тренером по физподготовке'} ${cnm(c)}`, now);
  return { ok: true, kind: c.kind, swaps: st.swaps };
}

// ---------- спонсоры ----------
/** Три предложения каждому клубу при создании сезона; ботам — сразу «надёжный». */
export function initSponsors(G, S) {
  const o = ensureStaff(S);
  const big = !!o.cfg.big, perConf = big ? S.teams.length / 2 : S.teams.length; // в большой лиге требование — к месту в своей конференции
  const names = G.ev('shuffle')(SPON_NAMES.slice());
  for (const t of S.teams) {
    const h = o.humans && o.humans[t.id];
    const mk = (tt, k) => { const req = Math.max(1, Math.ceil(perConf * tt.req));
      return { id: `${t.id}-${tt.tier}`, tier: tt.tier, co: names[(t.id * 3 + k) % names.length], brand: tt.name,
        week: tt.week, bonus: tt.bonus, pts: tt.pts, req, reqTxt: tt.reqTxt(req, big) }; };
    o.sponOff[t.id] = SPONSOR_TIERS.map(mk);
    if (!h || h.bot) pickSponsor(S, t.id, 'B', true); // ботам — средний вариант (менеджер может заменить)
  }
}
function pickSponsor(S, tid, tier, auto = false) {
  const o = ensureStaff(S), off = (o.sponOff[tid] || []).find((x) => x.tier === tier);
  if (!off) return null;
  o.spon[tid] = { ...off, paid: 0, weeks: 0, auto };
  return o.spon[tid];
}
/** Выбор спонсора менеджером — один раз; автовыбор бота можно заменить. */
export function chooseSponsor(G, S, uid, { id }, now = Date.now()) {
  const o = ensureStaff(S);
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  if (o.spon[me.tid] && !o.spon[me.tid].auto) return { error: 'already' };
  if (o.po || o.champ != null) return { error: 'market_closed' };
  const off = (o.sponOff[me.tid] || []).find((x) => x.id === String(id));
  if (!off) return { error: 'gone' };
  const sp = pickSponsor(S, me.tid, off.tier, false);
  mlog(S, `«${S.teams[me.tid].name}» подписали титульного спонсора: ${sp.co} (${sp.brand.toLowerCase()})`, now);
  return { ok: true, sponsor: sp };
}
/** Итоги по спонсору в конце сезона: требование выполнено → премия и очки. Идемпотентно. */
export function sponsorResults(S, placeOf) {
  const o = ensureStaff(S), out = {};
  for (const t of S.teams) {
    const sp = o.spon[t.id];
    if (!sp) continue;
    if (!sp.res) {
      const met = placeOf(t.id) <= sp.req;
      if (met && o.fin && o.fin[t.id]) { o.fin[t.id].cash += sp.bonus; o.fin[t.id].inc.tv += sp.bonus; }
      sp.res = { tier: sp.tier, co: sp.co, brand: sp.brand, met, pts: met ? sp.pts : 0, paid: sp.paid + (met ? sp.bonus : 0) };
    }
    out[t.id] = sp.res;
  }
  return out;
}

// ---------- вид для клиента ----------
export function staffView(G, S, uid, now = Date.now()) {
  const o = ensureStaff(S);
  const me = humanOf(S, uid); if (!me) return { error: 'not_joined' };
  const st = o.staff[me.tid] || {};
  const pub = (c) => c && { id: c.id, f: c.f, l: c.l, nat: c.nat, age: c.age, kind: c.kind, lead: c.lead || null, good: c.good || null };
  const sp = o.spon[me.tid] || null;
  return {
    team: me.tid,
    head: pub(st.head), phys: pub(st.phys), mode: st.mode || 'main', scale: st.scale || 0,
    plus: physPlus(S, me.tid), growMain: Math.round(growMainK(S, me.tid) * 100) / 100, growAcad: Math.round(growAcadK(S, me.tid) * 100) / 100,
    swaps: st.swaps || 0, swapMax: STAFF.swapMax, scaleStep: STAFF.scaleStep, hotAt: STAFF.hotAt,
    market: (o.staffFA || []).map(pub),
    sponsor: sp, offers: sp && !sp.auto ? [] : (o.sponOff[me.tid] || []),
    sponsorLocked: !!o.po || o.champ != null,
  };
}
