/**
 * Read-only inspector for the [QA_TEST_1338] scenario. Prints the TaskField
 * state + the currently-active TrackingSession by token, so we can see what
 * the customer page is actually looking at.
 *
 * Zero writes. Safe to re-run.
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const TOKEN = 'lCztR96OKzEbSoJbXHiQSH5cfFUSCcmK';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    options: '-c timezone=Asia/Jerusalem',
  });
  try {
    const tf = await pool.query(
      `SELECT id, "fieldStatus", "scheduledStartAt", "departedAt", "arrivedAt",
              "travelEtaMinutes", "expectedArrivalAt",
              "fieldContactPhone", "fieldContactName",
              "siteAddress", "siteCity"
         FROM "TaskField"
        WHERE "appointmentTitle" LIKE '[QA_TEST_1338]%'
        ORDER BY "createdAt" DESC
        LIMIT 3`,
    );
    console.log('── TaskField rows (QA_TEST_1338):');
    console.log(JSON.stringify(tf.rows, null, 2));

    const s = await pool.query(
      `SELECT id, "taskFieldId", status, "startedAt", "arrivedAt", "endedAt",
              "expiresAt", "lastLocationAt", "publicToken"
         FROM "TrackingSession"
        WHERE "publicToken" = $1`,
      [TOKEN],
    );
    console.log(`\n── TrackingSession for token=${TOKEN}:`);
    console.log(JSON.stringify(s.rows, null, 2));

    if (s.rowCount) {
      const wll = await pool.query(
        `SELECT wll.lat, wll.lng, wll.accuracy, wll."lastSeenAt",
                s."workerUserId"
           FROM "TrackingSession" s
      LEFT JOIN "WorkerLiveLocation" wll ON wll."workerUserId" = s."workerUserId"
          WHERE s."publicToken" = $1`,
        [TOKEN],
      );
      console.log('\n── WorkerLiveLocation:');
      console.log(JSON.stringify(wll.rows, null, 2));
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
