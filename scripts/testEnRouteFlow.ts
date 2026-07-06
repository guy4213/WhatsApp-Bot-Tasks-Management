/**
 * End-to-end test of the WORKER_EN_ROUTE customer notification flow.
 *
 * Modes:
 *   (default)      — full test: setup + fire DEPARTED locally + verify results.
 *   --setup-only   — create fictional Customer/Task/TaskField (CONFIRMED),
 *                    DO NOT trigger. Use this before talking to the deployed
 *                    bot in WhatsApp — the bot itself will handle the trigger.
 *   --cleanup      — delete the fictional Customer/Task/TaskField and their
 *                    notification rows. Safe to run any time.
 *
 * Guy is the only phone involved (both worker and customer), so freeform
 * arrives in his existing chat with the bot.
 */
import dotenv from 'dotenv';
dotenv.config();

// Force-enable the feature for the test (bypass whatever .env says).
process.env.CUSTOMER_NOTIFICATIONS_ENABLED = 'true';

import { pool } from '../src/db/connection';
import { advanceFieldStatus } from '../src/services/inspections';

const GUY_USER_ID  = '940243d2-8888-463c-81fe-2d93ee01d53c';
const GUY_PHONE    = '972534271418'; // E.164 — normalizeIsraeliPhone also accepts 053-4271418
const RADON_TYPE_ID = '3411913e-bae8-4e3e-88a2-21afb732aa1b';

const TEST_CUSTOMER_ID = 'test-cust-en-route';
const TEST_TASK_ID     = 'test-task-en-route';

async function cleanup(): Promise<void> {
  console.log('═══ CLEANUP: removing fictional test rows ═══');
  const del1 = await pool.query(
    `WITH old_ids AS (SELECT id FROM "TaskField" WHERE "taskId" = $1),
          _n AS (
            DELETE FROM "WhatsappCustomerNotification"
             WHERE "taskFieldId" IN (SELECT id FROM old_ids)
          )
     DELETE FROM "TaskField" WHERE "taskId" = $1 RETURNING id`,
    [TEST_TASK_ID],
  );
  console.log(`  ✓ removed ${del1.rowCount ?? 0} TaskField(s) + their notification rows`);
  const del2 = await pool.query(`DELETE FROM "Task" WHERE id = $1 RETURNING id`, [TEST_TASK_ID]);
  console.log(`  ✓ removed ${del2.rowCount ?? 0} Task(s)`);
  const del3 = await pool.query(`DELETE FROM "Customer" WHERE id = $1 RETURNING id`, [TEST_CUSTOMER_ID]);
  console.log(`  ✓ removed ${del3.rowCount ?? 0} Customer(s)`);
}

async function main() {
  const setupOnly = process.argv.includes('--setup-only');
  const cleanupOnly = process.argv.includes('--cleanup');

  if (cleanupOnly) {
    await cleanup();
    await pool.end();
    return;
  }

  console.log('═══ Step 1: ensure test Customer exists ═══');
  await pool.query(
    `INSERT INTO "Customer" (id, name, "contactName", phone, email, city, type, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (id) DO UPDATE SET
       phone = EXCLUDED.phone,
       "contactName" = EXCLUDED."contactName",
       "updatedAt" = now()`,
    [
      TEST_CUSTOMER_ID,
      '🧪 TEST — לקוח בדיקת בוט (לא לפעולה)',
      '🧪 גיא בדיקה',
      GUY_PHONE,
      'do-not-use-bot-test@example.invalid',
      '🧪 עיר בדיקה',
      'TEST',
    ],
  );
  console.log(`  ✓ Customer ${TEST_CUSTOMER_ID}\n`);

  console.log('═══ Step 2: ensure test Task exists ═══');
  await pool.query(
    `INSERT INTO "Task" (id, title, "ownerId", "customerId", "updatedAt")
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE SET
       "ownerId" = EXCLUDED."ownerId",
       "customerId" = EXCLUDED."customerId",
       "updatedAt" = now()`,
    [TEST_TASK_ID, '🧪 TEST — בדיקת התראת EN_ROUTE (לא לפעולה)', GUY_USER_ID, TEST_CUSTOMER_ID],
  );
  console.log(`  ✓ Task ${TEST_TASK_ID} owned by גיא פרנסס, linked to test Customer\n`);

  console.log('═══ Step 3: clean up any leftover test TaskFields ═══');
  const deletedRows = await pool.query(
    `WITH old_ids AS (
       SELECT id FROM "TaskField" WHERE "taskId" = $1
     ), _n AS (
       DELETE FROM "WhatsappCustomerNotification"
        WHERE "taskFieldId" IN (SELECT id FROM old_ids)
     )
     DELETE FROM "TaskField" WHERE "taskId" = $1 RETURNING id`,
    [TEST_TASK_ID],
  );
  console.log(`  ✓ removed ${deletedRows.rowCount ?? 0} old TaskField(s) + their notification rows\n`);

  console.log('═══ Step 4: create a fresh test TaskField ═══');
  const scheduledStart = new Date(Date.now() + 60 * 60 * 1000);   // now + 1h
  const scheduledEnd   = new Date(Date.now() + 2 * 60 * 60 * 1000); // now + 2h
  const { rows: [tf] } = await pool.query<{ id: string }>(
    `INSERT INTO "TaskField" (
       "taskId", "inspectionTypeId", family,
       "appointmentTitle", "scheduledStartAt", "scheduledEndAt", "durationMinutes",
       "siteAddress", "siteCity",
       "fieldContactName", "fieldContactPhone",
       "fieldStatus"
     ) VALUES (
       $1, $2, 'radon',
       $3, $4, $5, 60,
       $6, $7,
       $8, $9,
       'CONFIRMED'
     ) RETURNING id::text`,
    [
      TEST_TASK_ID, RADON_TYPE_ID,
      '🧪 TEST — בדיקת סקריפט EN_ROUTE', scheduledStart, scheduledEnd,
      '🧪 רחוב פיקטיבי לבדיקה 999', '🧪 עיר בדיקה',
      '🧪 גיא בדיקה', GUY_PHONE,
    ],
  );
  const taskFieldId = tf.id;
  console.log(`  ✓ TaskField ${taskFieldId}`);
  console.log(`     family=radon | fieldContactPhone=${GUY_PHONE} | fieldStatus=CONFIRMED\n`);

  console.log('═══ Step 5: fire advanceFieldStatus({ DEPARTED }) ═══');
  console.log('  → EXPECTED (WhatsApp):');
  console.log(`     Message 1 (customer template): "שלום גיא בדיקה! ... יצא לדרך אליך..."`);
  console.log(`     Message 2 (worker feedback):   "✅ הלקוח גיא בדיקה עודכן בוואטסאפ..."\n`);
  await advanceFieldStatus({
    taskFieldId,
    transition: 'DEPARTED',
    updatedBy: GUY_USER_ID,
  });
  console.log('  ✓ advanceFieldStatus returned. Fire-and-forget notification is running…\n');

  console.log('═══ Step 6: wait 4s for the async send + feedback ═══');
  await new Promise((r) => setTimeout(r, 4000));

  console.log('\n═══ Step 7: results ═══');
  const { rows: notifRows } = await pool.query(
    `SELECT "notificationType", "recipientPhone", status, "errorMessage",
            "sentAt", "workerFeedbackSentAt"
       FROM "WhatsappCustomerNotification"
      WHERE "taskFieldId" = $1
      ORDER BY "sentAt" DESC`,
    [taskFieldId],
  );
  if (notifRows.length === 0) {
    console.log('  ⚠ no WhatsappCustomerNotification row — the service was skipped');
    console.log('     (check CUSTOMER_NOTIFICATIONS_ENABLED / worker phone / DB errors above)');
  } else {
    for (const r of notifRows) {
      console.log(`  type=${r.notificationType}  status=${r.status}  to=${r.recipientPhone}`);
      console.log(`    sentAt=${new Date(r.sentAt).toISOString()}`);
      console.log(`    workerFeedbackSentAt=${r.workerFeedbackSentAt ? new Date(r.workerFeedbackSentAt).toISOString() : '(not sent)'}`);
      if (r.errorMessage) console.log(`    errorMessage=${r.errorMessage}`);
    }
  }

  console.log('\n═══ Step 8: TaskField state after the transition ═══');
  const { rows: [tfNow] } = await pool.query<{
    fieldStatus: string; departedAt: Date | null;
  }>(
    `SELECT "fieldStatus", "departedAt" FROM "TaskField" WHERE id = $1`,
    [taskFieldId],
  );
  console.log(`  fieldStatus=${tfNow.fieldStatus}  (should be EN_ROUTE)`);
  console.log(`  departedAt=${tfNow.departedAt ? new Date(tfNow.departedAt).toISOString() : '(null)'}`);

  await pool.end();
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
