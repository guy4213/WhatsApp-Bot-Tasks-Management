/**
 * One-off cleanup — clear the WhatsappCustomerNotification dedup row for
 * TaskField 2640132b-f324-4226-9c90-c43a19d3c940 so a subsequent "יצאתי"
 * on the same TaskField can re-send the WORKER_EN_ROUTE notification
 * (with a fresh tracking link).
 *
 * Scope: exactly one row (taskFieldId + notificationType).
 * Does NOT touch TaskField, TrackingSession, WorkerLiveLocation, or any
 * other table.
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const TF = '2640132b-f324-4226-9c90-c43a19d3c940';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    const before = await pool.query(
      `SELECT id, "notificationType", status, "sentAt"
         FROM "WhatsappCustomerNotification"
        WHERE "taskFieldId" = $1`,
      [TF],
    );
    console.log(`Before (${before.rowCount} row(s)):`);
    console.log(JSON.stringify(before.rows, null, 2));

    const del = await pool.query(
      `DELETE FROM "WhatsappCustomerNotification"
        WHERE "taskFieldId" = $1
          AND "notificationType" = 'WORKER_EN_ROUTE'`,
      [TF],
    );
    console.log(`\nDeleted rows: ${del.rowCount}`);

    const after = await pool.query(
      `SELECT id, "notificationType", status, "sentAt"
         FROM "WhatsappCustomerNotification"
        WHERE "taskFieldId" = $1`,
      [TF],
    );
    console.log(`\nAfter (${after.rowCount} row(s)):`);
    console.log(JSON.stringify(after.rows, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
