/**
 * QA reset — rewind a TaskField (and everything it touched) back to CONFIRMED so
 * the full flow can be re-tested WITHOUT deleting/recreating the TaskField:
 *   pre-reminder → "יצאתי" → customer EN_ROUTE + tracking link → OwnTracks +
 *   ETA prompt → "הגעתי" → "סיימתי".
 *
 * Usage:
 *   npx tsx scripts/RESETTASKFORTEST.ts <taskFieldId> [--start '11:20']
 * דוגמא:
 *   npx tsx scripts/RESETTASKFORTEST.ts d32f7ba4-5b81-4fd5-bb22-fec1a5dc81c8 --start 11:45
 * If --start is omitted, scheduledStartAt is left as-is. Time is Asia/Jerusalem,
 * on today's date.
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  const [, , taskFieldId, ...rest] = process.argv;
  if (!taskFieldId) {
    console.error('Usage: npx tsx scripts/qa-reset-tracking-flow.ts <taskFieldId> [--start HH:MM]');
    process.exit(1);
  }
  const startIdx = rest.indexOf('--start');
  const newStartHHMM = startIdx >= 0 ? rest[startIdx + 1] : null;

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    options: '-c timezone=Asia/Jerusalem',
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Load worker phone (needed for ConversationContext cleanup) + duration.
    const tfRes = await client.query<{ ownerId: string; workerPhone: string | null; durationMinutes: number }>(
      `SELECT t."ownerId" AS "ownerId",
              u.phone     AS "workerPhone",
              tf."durationMinutes" AS "durationMinutes"
         FROM "TaskField" tf
         JOIN "Task" t   ON t.id = tf."taskId"
    LEFT JOIN "User" u   ON u.id = t."ownerId"
        WHERE tf.id = $1`,
      [taskFieldId],
    );
    if (tfRes.rowCount === 0) {
      throw new Error(`TaskField ${taskFieldId} not found`);
    }
    const { workerPhone, durationMinutes } = tfRes.rows[0];

    // 2. Rewind TaskField columns (fieldStatus + every transitional stamp).
    const setStartClause = newStartHHMM
      ? `,
             "scheduledStartAt" = ((to_char(now() AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD') || ' ' || $2)::timestamp AT TIME ZONE 'Asia/Jerusalem'),
             "scheduledEndAt"   = ((to_char(now() AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD') || ' ' || $2)::timestamp AT TIME ZONE 'Asia/Jerusalem') + ($3 || ' minutes')::interval`
      : '';
    const params: unknown[] = [taskFieldId];
    if (newStartHHMM) {
      params.push(newStartHHMM);
      params.push(String(durationMinutes));
    }

    await client.query(
      `UPDATE "TaskField"
          SET "fieldStatus"           = 'CONFIRMED',
              "preReminderSentAt"     = NULL,
              "departedAt"            = NULL,
              "arrivedAt"             = NULL,
              "finishedAt"            = NULL,
              "travelEtaMinutes"      = NULL,
              "expectedArrivalAt"     = NULL,
              "confirmedAt"           = now(),
              "declinedAt"            = NULL,
              "declinedReason"        = NULL,
              "problemType"           = NULL,
              "problemNote"           = NULL,
              "hasOpenProblem"        = false,
              "fieldNotes"            = NULL,
              "missingReportInfo"     = false,
              "missingReportInfoNote" = NULL,
              "managerNotifiedAt"     = NULL,
              "updatedAt"             = now()
              ${setStartClause}
        WHERE id = $1`,
      params,
    );
    console.log(`✓ TaskField ${taskFieldId} rewound to CONFIRMED (all transitional stamps cleared).`);
    if (newStartHHMM) {
      console.log(`  scheduledStartAt reset to today ${newStartHHMM} (Asia/Jerusalem).`);
    }

    // 3. TrackingSession — delete all rows for this TaskField (cleaner than
    //    SUPERSEDED for testing; openTrackingSession also handles SUPERSEDE
    //    automatically on the next "יצאתי", but leftover ARRIVED/FINISHED
    //    rows can confuse the tracking demo page).
    const ts = await client.query(
      `DELETE FROM "TrackingSession" WHERE "taskFieldId" = $1`,
      [taskFieldId],
    );
    console.log(`✓ TrackingSession rows deleted: ${ts.rowCount ?? 0}`);

    // 4. WhatsappCustomerNotification — MUST delete or the second EN_ROUTE
    //    notification is dedup-skipped and the customer never re-gets the link.
    const cn = await client.query(
      `DELETE FROM "WhatsappCustomerNotification" WHERE "taskFieldId" = $1`,
      [taskFieldId],
    );
    console.log(`✓ WhatsappCustomerNotification rows deleted: ${cn.rowCount ?? 0}`);

    // 5. WhatsappMessageRef — quoted-reply refs pointing at old wamids. Safe
    //    to leave (they just won't resolve), but cleanest to drop.
    const mr = await client.query(
      `DELETE FROM "WhatsappMessageRef" WHERE "taskFieldId" = $1`,
      [taskFieldId],
    );
    console.log(`✓ WhatsappMessageRef rows deleted: ${mr.rowCount ?? 0}`);

    // 6. WhatsappConversationContext — clear the worker's activeInspection
    //    pointer and any `awaiting: 'status_eta_prompt'` await from the prior
    //    run. If left, the next "יצאתי" free-text may resolve to the old
    //    (stale) pointer window.
    if (workerPhone) {
      const cc = await client.query(
        `DELETE FROM "WhatsappConversationContext" WHERE phone = $1`,
        [workerPhone.replace(/^0/, '972').replace(/-/g, '')],
      );
      console.log(`✓ WhatsappConversationContext rows deleted for worker phone: ${cc.rowCount ?? 0}`);

      // 7. PendingChoice — stale number→command mappings from the prior send.
      const pc = await client.query(
        `DELETE FROM "PendingChoice" WHERE phone = $1`,
        [workerPhone.replace(/^0/, '972').replace(/-/g, '')],
      );
      console.log(`✓ PendingChoice rows deleted for worker phone: ${pc.rowCount ?? 0}`);
    }

    await client.query('COMMIT');
    console.log('\n✓ Reset complete. The scheduler will re-send the pre-reminder within 2 minutes,');
    console.log('  provided scheduledStartAt is within the next 60 minutes (and > now).');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ERROR:', (e as Error).message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
