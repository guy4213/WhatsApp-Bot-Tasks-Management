/**
 * Read-only verification for the seed created by qa-seed-tracking-flow.ts.
 *
 * Confirms:
 *   - Customer / Task / TaskField exist with the exact fields expected
 *   - scheduledStartAt is in the future
 *   - the worker has an ACTIVE, provisioned OwnTracks device identity (else
 *     the safety-net link in the pre-reminder will be silently omitted)
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const OWNER_ID = '940243d2-8888-463c-81fe-2d93ee01d53c';
const CUSTOMER_ID = 'qa-tracking-flow-guy';
const TASK_ID = 'qa-tracking-flow-guy-task';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    options: '-c timezone=Asia/Jerusalem',
  });
  try {
    const now = await pool.query<{ nowLocal: string; nowUtc: string }>(
      `SELECT to_char(now() AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI:SS') AS "nowLocal",
              to_char(now() AT TIME ZONE 'UTC',            'YYYY-MM-DD HH24:MI:SS') AS "nowUtc"`,
    );
    console.log(`DB now (Asia/Jerusalem): ${now.rows[0].nowLocal}`);
    console.log(`DB now (UTC):            ${now.rows[0].nowUtc}\n`);

    const cust = await pool.query(
      `SELECT id, name, "contactName", phone, city, type, status
         FROM "Customer" WHERE id = $1`,
      [CUSTOMER_ID],
    );
    console.log('Customer row:');
    console.log(cust.rows[0] ?? '  (missing!)');

    const task = await pool.query(
      `SELECT id, title, type, status, "ownerId", "customerId", "productName"
         FROM "Task" WHERE id = $1`,
      [TASK_ID],
    );
    console.log('\nTask row:');
    console.log(task.rows[0] ?? '  (missing!)');

    const tf = await pool.query(
      `SELECT id,
              "appointmentTitle",
              to_char("scheduledStartAt" AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI:SS') AS "startLocal",
              to_char("scheduledEndAt"   AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI:SS') AS "endLocal",
              "durationMinutes",
              family,
              "siteAddress", "siteCity",
              "fieldContactName", "fieldContactPhone",
              "specialInstructions",
              "fieldStatus",
              "preReminderSentAt",
              ("scheduledStartAt" > now())                                         AS "isFuture",
              ("scheduledStartAt" <= now() + interval '60 minutes')                AS "reminderDueNow",
              round(EXTRACT(EPOCH FROM ("scheduledStartAt" - now())) / 60)::int    AS "minutesUntilStart"
         FROM "TaskField"
        WHERE "taskId" = $1`,
      [TASK_ID],
    );
    console.log('\nTaskField row:');
    console.log(tf.rows[0] ?? '  (missing!)');

    const prov = await pool.query(
      `SELECT "workerKey", "trackerId", "isActive",
              "provisionedAt" IS NOT NULL AS "provisioned",
              "revokedAt"
         FROM "WorkerDeviceIdentity"
        WHERE "workerUserId" = $1
        ORDER BY "createdAt" DESC
        LIMIT 1`,
      [OWNER_ID],
    );
    console.log('\nWorkerDeviceIdentity (גיא):');
    if (prov.rows[0]) {
      console.log(prov.rows[0]);
      const p = prov.rows[0] as { isActive: boolean; provisioned: boolean; revokedAt: Date | null };
      const linkable = p.isActive && p.provisioned && !p.revokedAt;
      console.log(`  → OwnTracks inline link will be included in reminder: ${linkable ? 'YES' : 'NO'}`);
    } else {
      console.log('  (no row — worker was never provisioned)');
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
