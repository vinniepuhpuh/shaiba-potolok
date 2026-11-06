import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// BIGINT отдаём числом: ID в пределах Number.MAX_SAFE_INTEGER
pg.types.setTypeParser(20, (v) => Number(v));

export function makePool(url) {
  return new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30000 });
}

/** Применяет миграции из папки migrations по порядку, каждую один раз. */
export async function migrate(pool, log = console) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  await pool.query('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT name FROM _migrations')).rows.map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('INSERT INTO _migrations(name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      log.info?.(`migration ${f} applied`);
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}
