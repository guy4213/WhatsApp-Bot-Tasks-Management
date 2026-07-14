import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

const TF = 'd32f7ba4-5b81-4fd5-bb22-fec1a5dc81c8';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    options: '-c timezone=Asia/Jerusalem',
  });
  try {
    const now = await pool.query<{ nowLocal: string }>(
      `SELECT to_char(now() AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI:SS') AS "nowLocal"`,
    );
    console.log(`DB now (Asia/Jerusalem): ${now.rows[0].nowLocal}\n`);

    const tf = await pool.query(
      `SELECT id,
              "appointmentTitle",
              to_char("scheduledStartAt" AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI:SS') AS "startLocal",
              "fieldStatus",
              "preReminderSentAt",
              "departedAt",
              "arrivedAt",
              "finishedAt",
              ("scheduledStartAt" > now())                                       AS "isFuture",
              ("scheduledStartAt" <= now() + interval '60 minutes')              AS "reminderDueNow",
              round(EXTRACT(EPOCH FROM ("scheduledStartAt" - now())) / 60)::int  AS "minutesUntilStart"
         FROM "TaskField"
        WHERE id = $1`,
      [TF],
    );
    if (tf.rowCount === 0) {
      console.log(`TaskField ${TF} — MISSING`);
      return;
    }
    console.log('TaskField row:');
    console.log(tf.rows[0]);

    console.log('\nfindDuePreReminders gates (all must be true for reminder to fire):');
    const r = tf.rows[0] as Record<string, unknown>;
    console.log(`  preReminderSentAt IS NULL:                  ${r.preReminderSentAt === null}`);
    console.log(`  scheduledStartAt > now():                   ${r.isFuture}`);
    console.log(`  scheduledStartAt <= now() + 60 min:         ${r.reminderDueNow}`);
    console.log(`  fieldStatus IN (ASSIGNED,CONFIRMED,NEEDS_MORE_INFO): ${['ASSIGNED', 'CONFIRMED', 'NEEDS_MORE_INFO'].includes(String(r.fieldStatus))}`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
