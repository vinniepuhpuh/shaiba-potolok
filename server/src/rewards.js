import { gunzipSync } from 'node:zlib';

export const CASH_REWARD = 10;
export const ASSISTANT_PRICE = 10;
export const CAREER_ID = /^[a-f0-9-]{36}$/;

export function readCareer(data, enc) {
  try {
    const save = JSON.parse(enc === 'gzip' ? gunzipSync(data, { maxOutputLength: 4 * 1024 * 1024 }) : data);
    return save?.v === 6 && save.user != null ? save : null;
  } catch {
    return null;
  }
}

export async function awardCareerCash(db, uid, career) {
  const cash = career?.fin?.cash;
  if (!Number.isFinite(cash)) return;
  const billions = Math.floor(cash / 1_000_000);
  if (!Number.isSafeInteger(billions) || billions < 1 || billions > 1_000_000) return;
  await db.query('INSERT INTO wallets (uid) VALUES ($1) ON CONFLICT (uid) DO NOTHING', [uid]);
  await db.query('SELECT balance FROM wallets WHERE uid=$1 FOR UPDATE', [uid]);
  const result = await db.query('SELECT cash_billions FROM career_rewards WHERE uid=$1', [uid]);
  const previous = result.rows[0]?.cash_billions || 0;
  if (billions <= previous) return;
  const delta = (billions - previous) * CASH_REWARD;
  await db.query(`INSERT INTO career_rewards (uid,cash_billions) VALUES ($1,$2)
    ON CONFLICT (uid) DO UPDATE SET cash_billions=EXCLUDED.cash_billions`, [uid, billions]);
  await db.query('UPDATE wallets SET balance=balance+$2, updated_at=now() WHERE uid=$1', [uid, delta]);
  await db.query('INSERT INTO wallet_ops (uid,delta,comment) VALUES ($1,$2,$3)', [uid, delta, `Касса клуба: до $${billions} млрд`]);
}

export async function rewardsView(db, uid) {
  const { rows: [row] } = await db.query(`SELECT
    COALESCE((SELECT balance FROM wallets WHERE uid=$1),0) AS balance,
    COALESCE((SELECT cash_billions FROM career_rewards WHERE uid=$1),0) AS "cashBillions",
    ARRAY(SELECT scope FROM assistant_purchases WHERE uid=$1) AS purchases`, [uid]);
  return { ...row, cashReward: CASH_REWARD, assistantPrice: ASSISTANT_PRICE };
}

export async function buyAssistant(db, uid, scope) {
  await db.query('INSERT INTO wallets (uid) VALUES ($1) ON CONFLICT (uid) DO NOTHING', [uid]);
  const { rows: [wallet] } = await db.query('SELECT balance FROM wallets WHERE uid=$1 FOR UPDATE', [uid]);
  const existing = await db.query('SELECT 1 FROM assistant_purchases WHERE uid=$1 AND scope=$2', [uid, scope]);
  if (existing.rowCount) return true;
  if (wallet.balance < ASSISTANT_PRICE) return false;
  await db.query('INSERT INTO assistant_purchases (uid,scope) VALUES ($1,$2)', [uid, scope]);
  await db.query('UPDATE wallets SET balance=balance-$2, updated_at=now() WHERE uid=$1', [uid, ASSISTANT_PRICE]);
  await db.query('INSERT INTO wallet_ops (uid,delta,comment) VALUES ($1,$2,$3)', [uid, -ASSISTANT_PRICE, 'Помощник ГМ']);
  return true;
}
