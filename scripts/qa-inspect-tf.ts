/**
 * One-off inspector for a specific TaskField + its tracking sessions.
 * Read-only; prints everything the calibration decision would depend on.
 *
 * Run: TF=<uuid> npx tsx scripts/qa-inspect-tf.ts
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const TF = process.env.TF ?? process.argv[2];

async function main() {
  if (!TF) {
    console.error('Usage: TF=<uuid> npx tsx scripts/qa-inspect-tf.ts');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    options: '-c timezone=Asia/Jerusalem',
  });
  try {
    const tf = await pool.query(
      `SELECT id, "fieldStatus", "scheduledStartAt", "departedAt", "arrivedAt",
              "travelEtaMinutes", "expectedArrivalAt",
              "fieldContactPhone",
              "createdAt", "updatedAt"
         FROM "TaskField"
        WHERE id = $1`,
      [TF],
    );
    console.log('── TaskField:');
    console.log(JSON.stringify(tf.rows, null, 2));

    const s = await pool.query(
      `SELECT id, status, "startedAt", "arrivedAt", "endedAt",
              "expiresAt", "lastLocationAt", "publicToken", "workerUserId"
         FROM "TrackingSession"
        WHERE "taskFieldId" = $1
        ORDER BY "startedAt" DESC`,
      [TF],
    );
    console.log(`\n── TrackingSession(s) for TF (${s.rowCount}):`);
    console.log(JSON.stringify(s.rows, null, 2));

    const nowRow = await pool.query<{ now: string }>(
      `SELECT to_char(now() AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI:SS TZ') AS now`,
    );
    console.log(`\n── Server clock (IL): ${nowRow.rows[0].now}`);

    // Time-window math for the calibration decision.
    if (tf.rowCount) {
      const row = tf.rows[0];
      if (row.departedAt) {
        const dep = new Date(row.departedAt).getTime();
        const now = Date.now();
        const ageMs = now - dep;
        const ageMin = ageMs / 60_000;
        console.log(`\n── Calibration window analysis:`);
        console.log(`   departedAt:        ${new Date(dep).toISOString()}`);
        console.log(`   now:               ${new Date(now).toISOString()}`);
        console.log(`   elapsed:           ${ageMin.toFixed(1)} min`);
        console.log(`   window is 20 min → ${ageMin <= 20 ? 'INSIDE — capture possible' : 'PAST — capture no longer possible on a fresh process'}`);
        console.log(`   travelEtaMinutes:  ${row.travelEtaMinutes ?? 'null'}`);
        console.log(`   expectedArrivalAt: ${row.expectedArrivalAt ?? 'null'}`);
      }
    }

    // GPS ping trail if available (progress detection context).
    if (s.rowCount) {
      const workerUserId = s.rows[0].workerUserId;
      const wll = await pool.query(
        `SELECT lat, lng, accuracy, "lastSeenAt", "workerUserId"
           FROM "WorkerLiveLocation"
          WHERE "workerUserId" = $1`,
        [workerUserId],
      );
      console.log(`\n── WorkerLiveLocation (latest):`);
      console.log(JSON.stringify(wll.rows, null, 2));
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
