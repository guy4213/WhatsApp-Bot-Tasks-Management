/**
 * QA seed — one-off for the 13:38 tracking test.
 *
 *   1. Office Task (dueDate=13:38 today, no TaskField)
 *      → drives the CRM due-date reminder (fires 55–65 min before dueDate).
 *
 *   2. Field Task + TaskField (scheduledStartAt=13:38 today)
 *      → drives the assignment card, the 60-min pre-inspection reminder,
 *        and — when the worker sends "יצאתי" — opens a TrackingSession
 *        with a live `/t/<token>` URL for the customer page.
 *
 * Both rows are prefixed [QA_TEST_1338] so cleanup is `WHERE title LIKE
 * '[QA_TEST_1338]%'` on Task, cascading naturally to TaskField.
 *
 * Worker (Task.ownerId): גיא פרנסס — 940243d2-8888-463c-81fe-2d93ee01d53c
 * Customer contact phone (TaskField.fieldContactPhone): 0534271418
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const OWNER_ID          = '940243d2-8888-463c-81fe-2d93ee01d53c'; // גיא פרנסס
const INSPECTION_CODE   = '73';         // רעש – בדיקת רעש סביבתית
const CONTACT_NAME      = 'לקוח בדיקה 13:38';
const CONTACT_PHONE     = '0534271418';
const TARGET_LOCAL      = '2026-07-09 13:38';           // Asia/Jerusalem wall clock
const SITE_ADDRESS      = 'רוטשילד 100';
const SITE_CITY         = 'תל אביב';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    options: '-c timezone=Asia/Jerusalem',
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. InspectionType lookup (needed for the field task).
    const it = await client.query(
      'SELECT id, family, "labelHe" FROM "InspectionType" WHERE code = $1',
      [INSPECTION_CODE],
    );
    if (it.rowCount === 0) throw new Error(`InspectionType code=${INSPECTION_CODE} not found`);
    const inspectionTypeId: string = it.rows[0].id;
    const family: string = it.rows[0].family;
    console.log(`InspectionType: ${it.rows[0].labelHe} (family=${family})`);

    // 2. Office Task — dueDate 13:38 today. No TaskField.
    const office = await client.query<{ id: string }>(
      `INSERT INTO "Task"
         (id, title, description, "dueDate", priority, type, status, "ownerId", "updatedAt")
       VALUES
         (gen_random_uuid(), $1, $2,
          ($3::timestamp AT TIME ZONE 'Asia/Jerusalem'),
          'MEDIUM', 'step1', 'OPEN', $4, now())
       RETURNING id`,
      [
        '[QA_TEST_1338] משימה משרדית — בדיקת תזכורת CRM',
        'משימת QA לבדיקת תזכורת שעה לפני dueDate (CRM due-date reminder). למחיקה בסיום הבדיקות.',
        TARGET_LOCAL,
        OWNER_ID,
      ],
    );
    console.log(`\n[OFFICE Task] id=${office.rows[0].id}`);

    // 3. Field Task — no dueDate; the schedule lives on the TaskField below.
    const fieldTask = await client.query<{ id: string }>(
      `INSERT INTO "Task"
         (id, title, description, priority, type, status, "ownerId", "productName", "updatedAt")
       VALUES
         (gen_random_uuid(), $1, $2, 'MEDIUM', 'step1', 'OPEN', $3, $4, now())
       RETURNING id`,
      [
        '[QA_TEST_1338] משימת שטח — בדיקת מעקב חי (Wolt-lite)',
        'משימת QA לבדיקת flow "יצאתי" + הודעת "הבודק בדרך" ללקוח + מסך המעקב החי. למחיקה בסיום הבדיקות.',
        OWNER_ID,
        INSPECTION_CODE,
      ],
    );
    const fieldTaskId = fieldTask.rows[0].id;
    console.log(`[FIELD Task]  id=${fieldTaskId}`);

    // 4. TaskField — the schedulable visit at 13:38 (60 min).
    const tf = await client.query<{ id: string; scheduledStartAt: Date }>(
      `INSERT INTO "TaskField" (
         "taskId", "inspectionTypeId", family,
         "appointmentTitle",
         "scheduledStartAt",
         "scheduledEndAt",
         "durationMinutes",
         "siteAddress", "siteCity",
         "fieldContactName", "fieldContactPhone",
         "specialInstructions", "fieldStatus"
       )
       VALUES (
         $1, $2, $3,
         $4,
         ($5::timestamp AT TIME ZONE 'Asia/Jerusalem'),
         (($5::timestamp + interval '60 minutes') AT TIME ZONE 'Asia/Jerusalem'),
         60,
         $6, $7,
         $8, $9,
         $10, 'ASSIGNED'
       )
       RETURNING id, "scheduledStartAt"`,
      [
        fieldTaskId,
        inspectionTypeId,
        family,
        '[QA_TEST_1338] רעש 13:38 — רוטשילד 100 ת"א',
        TARGET_LOCAL,
        SITE_ADDRESS,
        SITE_CITY,
        CONTACT_NAME,
        CONTACT_PHONE,
        '[QA_TEST_1338] משימת QA. איש קשר 0534271418 מדמה את הלקוח לבדיקת מסך המעקב.',
      ],
    );
    console.log(
      `[TaskField]   id=${tf.rows[0].id}  scheduledStartAt=${tf.rows[0].scheduledStartAt.toISOString()}`,
    );

    await client.query('COMMIT');
    console.log('\n✓ Seed committed.');
    console.log('  Cleanup (later):');
    console.log(`    DELETE FROM "TaskField" WHERE "taskId" = '${fieldTaskId}';`);
    console.log(`    DELETE FROM "Task"      WHERE title LIKE '[QA_TEST_1338]%';`);
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
