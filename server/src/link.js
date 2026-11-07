/**
 * Привязка Telegram к аккаунту устройства (Android-приложение).
 * Устройства переходят к Telegram-аккаунту; если у него ещё нет сохранения — переносим сохранение устройства.
 * Если сохранения есть у обоих, облачным остаётся Telegram-сохранение, а приложение покажет выбор.
 */
export async function linkTelegram(pool, code, from) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const lc = (await c.query('DELETE FROM link_codes WHERE code=$1 AND expires_at > now() RETURNING user_id', [code])).rows[0];
    if (!lc) { await c.query('ROLLBACK'); return { ok: false, reason: 'expired' }; }
    const t = (await c.query(
      `INSERT INTO users (tg_id, first_name, username, lang) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tg_id) DO UPDATE SET first_name=EXCLUDED.first_name, username=EXCLUDED.username, last_seen=now()
       RETURNING id`,
      [from.id, from.first_name || null, from.username || null, from.language_code || null]
    )).rows[0].id;
    const d = lc.user_id;
    if (t === d) { await c.query('COMMIT'); return { ok: true, same: true }; }
    await c.query('UPDATE devices SET user_id=$1 WHERE user_id=$2', [t, d]);
    const hasT = (await c.query('SELECT 1 FROM saves WHERE user_id=$1', [t])).rowCount > 0;
    if (!hasT) await c.query('UPDATE saves SET user_id=$1 WHERE user_id=$2', [t, d]);
    await c.query('UPDATE events SET user_id=$1 WHERE user_id=$2', [t, d]);
    await c.query('COMMIT');
    return { ok: true, moved: !hasT };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
