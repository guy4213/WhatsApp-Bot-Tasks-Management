/**
 * Reset the 5 geocode-cache columns on ONE TaskField so the strengthened
 * geocoder gets a fresh chance. `siteAddress` and `siteCity` are UNTOUCHED.
 *
 * Idempotent + atomic (BEGIN/COMMIT). Prints before + after so the operator
 * can visually confirm what changed.
 *
 * Hard-coded taskFieldId for the current sticky no_hit row we identified via
 * scripts/inspectTrackingSession.ts. If we ever need this for another row,
 * pull the id into a CLI arg — for MVP the single-shot form is cleanest.
 */
import 'dotenv/config';
import { Pool } from 'pg';

const TASK_FIELD_ID = '306d7df0-8a95-4619-b3d3-0e16bf7023bf';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    options: '-c timezone=Asia/Jerusalem',
  });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── Before ──────────────────────────────────────────────────────────
    const before = await client.query(
      `SELECT id, "siteAddress", "siteCity",
              "siteLat", "siteLng",
              "siteGeocodeSource", "siteGeocodeQuery", "siteGeocodedAt"
         FROM "TaskField"
        WHERE id = $1`,
      [TASK_FIELD_ID],
    );
    if (!before.rowCount) {
      throw new Error(`TaskField ${TASK_FIELD_ID} not found — aborting.`);
    }
    console.log('[1/3] Before:');
    console.log(before.rows[0]);

    // ── Reset ───────────────────────────────────────────────────────────
    const upd = await client.query(
      `UPDATE "TaskField"
          SET "siteLat"           = NULL,
              "siteLng"           = NULL,
              "siteGeocodedAt"    = NULL,
              "siteGeocodeSource" = NULL,
              "siteGeocodeQuery"  = NULL
        WHERE id = $1`,
      [TASK_FIELD_ID],
    );
    console.log(`[2/3] UPDATE — ${upd.rowCount} row affected.`);

    // ── After ───────────────────────────────────────────────────────────
    const after = await client.query(
      `SELECT id, "siteAddress", "siteCity",
              "siteLat", "siteLng",
              "siteGeocodeSource", "siteGeocodeQuery", "siteGeocodedAt"
         FROM "TaskField"
        WHERE id = $1`,
      [TASK_FIELD_ID],
    );
    console.log('[3/3] After:');
    console.log(after.rows[0]);

    await client.query('COMMIT');
    console.log('\nCommitted.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* best-effort */ });
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n[FAIL]', err instanceof Error ? err.message : err);
  process.exit(1);
});
