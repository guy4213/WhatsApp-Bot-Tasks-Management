/**
 * Run all SQL migrations against Supabase (direct PostgreSQL connection).
 *
 * RECOMMENDED: paste the SQL directly into Supabase Dashboard → SQL Editor → Run.
 *
 * To run programmatically:
 *   1. Copy .env.example → .env and fill in DATABASE_URL
 *   2. npx ts-node src/db/migrate.ts
 *
 * Migration tracking: applied migrations are recorded in `schema_migrations`
 * so re-running is safe — already-applied files are skipped.
 */
import fs from 'fs';
import path from 'path';
import { pool } from './connection';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureTrackingTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getApplied(): Promise<Set<string>> {
  const result = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(result.rows.map((r) => r.name));
}

async function run(): Promise<void> {
  try {
    await pool.query('SELECT 1');
    console.log('[migrate] Connected to Supabase PostgreSQL ✓');
  } catch (err) {
    console.error('[migrate] Cannot connect to DB. Check DATABASE_URL in .env:', err);
    process.exit(1);
  }

  await ensureTrackingTable();
  const applied = await getApplied();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ranCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] Skipping ${file} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[migrate] Running ${file}…`);
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    console.log(`[migrate] Done: ${file}`);
    ranCount++;
  }

  if (ranCount === 0) {
    console.log('[migrate] All migrations already applied — nothing to do.');
  } else {
    console.log(`[migrate] ${ranCount} migration(s) applied successfully.`);
  }

  await pool.end();
}

run().catch((err) => {
  console.error('[migrate] FAILED:', err);
  process.exit(1);
});
