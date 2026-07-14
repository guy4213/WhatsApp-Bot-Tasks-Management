/**
 * QA seed: creates 1 Customer + 1 Task + 1 TaskField for a fictional radiation
 * inspection at רחוב אחוזה 100, רעננה, scheduled for today 10:30 (Asia/Jerusalem).
 *
 * Purpose: exercise the end-to-end tracking flow — pre-inspection reminder →
 * ETA update → "יצאתי" → customer tracking link → OwnTracks MOVE link → Waze
 * handoff with background updates. All downstream steps happen automatically
 * via the scheduler / router; this script only sets up the DB state.
 *
 * Worker: גיא פרנסס (id 940243d2-8888-463c-81fe-2d93ee01d53c, phone 053-4271418)
 * Customer / field contact: גיא פרנסס, 0534271418
 * InspectionType: family=radiation (code 9 — קרינה אלקטרומגנטית מרשת החשמל)
 * appointmentTitle: "בדיקת קרינה פיקטיבית"
 *
 * All rows are prefixed [QA_TEST] to make cleanup trivial.
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const OWNER_ID = '940243d2-8888-463c-81fe-2d93ee01d53c'; // גיא פרנסס
const INSPECTION_CODE = '9'; // radiation — קרינה אלקטרומגנטית מרשת החשמל
const CUSTOMER_ID = 'qa-tracking-flow-guy';
const TASK_ID = 'qa-tracking-flow-guy-task';

const SCHEDULED_LOCAL = '2026-07-14 11:20'; // Asia/Jerusalem
const DURATION_MIN = 60;

const CONTACT_NAME = 'גיא פרנסס';
const CONTACT_PHONE = '0534271418';
const SITE_ADDRESS = 'רחוב אחוזה 100';
const SITE_CITY = 'רעננה';
const APPOINTMENT_TITLE = 'בדיקת קרינה פיקטיבית';
const SPECIAL_INSTRUCTIONS =
  'משימת בדיקה פיקטיבית לבחינת תזכורת, עדכון זמן הגעה, פתיחת OwnTracks ושליחת קישור מעקב ללקוח.';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    options: '-c timezone=Asia/Jerusalem',
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Look up the radiation InspectionType id.
    const it = await client.query(
      'SELECT id, family, "labelHe" FROM "InspectionType" WHERE code = $1',
      [INSPECTION_CODE],
    );
    if (it.rowCount === 0) {
      throw new Error(`InspectionType code=${INSPECTION_CODE} not found`);
    }
    const inspectionTypeId: string = it.rows[0].id;
    const family: string = it.rows[0].family;
    console.log(`InspectionType: ${it.rows[0].labelHe} (family=${family})`);

    // 2. Upsert the fictional Customer.
    await client.query(
      `INSERT INTO "Customer"
         (id, name, "contactName", phone, email, city, type, status, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'TEST', 'ACTIVE', now())
       ON CONFLICT (id) DO UPDATE SET
         name          = EXCLUDED.name,
         "contactName" = EXCLUDED."contactName",
         phone         = EXCLUDED.phone,
         email         = EXCLUDED.email,
         city          = EXCLUDED.city,
         "updatedAt"   = now()`,
      [
        CUSTOMER_ID,
        `[QA_TEST] ${CONTACT_NAME}`,
        CONTACT_NAME,
        CONTACT_PHONE,
        'qa-tracking-flow@example.invalid',
        SITE_CITY,
      ],
    );
    console.log(`Customer upserted: ${CUSTOMER_ID}`);

    // 3. Remove any prior QA rows for this task id (idempotent re-run).
    //    Order matters: children (TrackingSession, WhatsappCustomerNotification,
    //    WorkerLiveLocation is worker-keyed not tf-keyed) → then TaskField.
    await client.query(
      `DELETE FROM "TrackingSession"
        WHERE "taskFieldId" IN (SELECT id FROM "TaskField" WHERE "taskId" = $1)`,
      [TASK_ID],
    );
    await client.query(
      `DELETE FROM "WhatsappCustomerNotification"
        WHERE "taskFieldId" IN (SELECT id FROM "TaskField" WHERE "taskId" = $1)`,
      [TASK_ID],
    );
    const deletedTf = await client.query(
      `DELETE FROM "TaskField" WHERE "taskId" = $1 RETURNING id`,
      [TASK_ID],
    );
    if (deletedTf.rowCount) {
      console.log(`Removed ${deletedTf.rowCount} prior TaskField row(s) (+ its TrackingSession & CustomerNotification rows).`);
    }

    // 4. Upsert the Task.
    await client.query(
      `INSERT INTO "Task"
         (id, title, description, priority, type, status, "ownerId", "customerId", "productName", "updatedAt")
       VALUES
         ($1, $2, $3, 'MEDIUM', 'step1', 'OPEN', $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE SET
         title         = EXCLUDED.title,
         description   = EXCLUDED.description,
         "ownerId"     = EXCLUDED."ownerId",
         "customerId"  = EXCLUDED."customerId",
         "productName" = EXCLUDED."productName",
         "updatedAt"   = now()`,
      [
        TASK_ID,
        `[QA_TEST] ${APPOINTMENT_TITLE} - ${CONTACT_NAME}`,
        SPECIAL_INSTRUCTIONS,
        OWNER_ID,
        CUSTOMER_ID,
        INSPECTION_CODE,
      ],
    );
    console.log(`Task upserted: ${TASK_ID}`);

    // 5. Insert the fresh TaskField (CONFIRMED so the 60-min pre-reminder fires).
    const tfIns = await client.query<{
      id: string;
      scheduledStartAt: Date;
      scheduledEndAt: Date;
    }>(
      `INSERT INTO "TaskField" (
         "taskId", "inspectionTypeId", family,
         "appointmentTitle",
         "scheduledStartAt",
         "scheduledEndAt",
         "durationMinutes",
         "siteAddress", "siteCity",
         "fieldContactName", "fieldContactPhone",
         "specialInstructions",
         "fieldStatus",
         "assignedAt", "confirmedAt"
       )
       VALUES (
         $1, $2, $3,
         $4,
         ($5::timestamp AT TIME ZONE 'Asia/Jerusalem'),
         (($5::timestamp + ($6::text || ' minutes')::interval) AT TIME ZONE 'Asia/Jerusalem'),
         $6::int,
         $7, $8,
         $9, $10,
         $11,
         'CONFIRMED',
         now(), now()
       )
       RETURNING id, "scheduledStartAt", "scheduledEndAt"`,
      [
        TASK_ID,
        inspectionTypeId,
        family,
        APPOINTMENT_TITLE,
        SCHEDULED_LOCAL,
        String(DURATION_MIN),
        SITE_ADDRESS,
        SITE_CITY,
        CONTACT_NAME,
        CONTACT_PHONE,
        SPECIAL_INSTRUCTIONS,
      ],
    );

    await client.query('COMMIT');

    const tf = tfIns.rows[0];
    console.log('\n✓ Seed complete.');
    console.log('----------------------------------------------------------');
    console.log(`  TaskField id:       ${tf.id}`);
    console.log(`  scheduledStartAt:   ${tf.scheduledStartAt.toISOString()}  (${SCHEDULED_LOCAL} Asia/Jerusalem)`);
    console.log(`  scheduledEndAt:     ${tf.scheduledEndAt.toISOString()}`);
    console.log(`  durationMinutes:    ${DURATION_MIN}`);
    console.log(`  family:             ${family}`);
    console.log(`  appointmentTitle:   ${APPOINTMENT_TITLE}`);
    console.log(`  siteAddress:        ${SITE_ADDRESS}, ${SITE_CITY}`);
    console.log(`  fieldContactName:   ${CONTACT_NAME}`);
    console.log(`  fieldContactPhone:  ${CONTACT_PHONE}`);
    console.log(`  fieldStatus:        CONFIRMED`);
    console.log(`  worker (Task.ownerId): ${OWNER_ID}  (גיא פרנסס)`);
    console.log(`  customerId:         ${CUSTOMER_ID}`);
    console.log(`  taskId:             ${TASK_ID}`);
    console.log('----------------------------------------------------------');
    console.log('  Cleanup: DELETE FROM "TaskField" WHERE "taskId" = \'' + TASK_ID + '\';');
    console.log('           DELETE FROM "Task" WHERE id = \'' + TASK_ID + '\';');
    console.log('           DELETE FROM "Customer" WHERE id = \'' + CUSTOMER_ID + '\';');
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
