/**
 * QA seed: creates 1 Task + 3 TaskField rows for the active-inspection-pointer /
 * quoted-reply manual QA (QA_MANUAL_ACTIVE_INSPECTION_QUOTES.md).
 *
 * Worker: גיא פרנסס (id 940243d2-8888-463c-81fe-2d93ee01d53c, phone 053-4271418)
 * Contact on field: "גיא לקוח בדיקה" / 0534271418
 * InspectionType: מק"ט 73 (רעש – בדיקת רעש סביבתית)
 * Times (Asia/Jerusalem):
 *   - Today 20:35
 *   - Today 22:00
 *   - Tomorrow 09:00
 *
 * All rows are prefixed [QA_TEST] to make cleanup trivial.
 * Cleanup script: scripts/qa-cleanup-active-inspection.ts
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const OWNER_ID = '940243d2-8888-463c-81fe-2d93ee01d53c'; // גיא פרנסס
const INSPECTION_CODE = '73';
const CONTACT_NAME = 'גיא לקוח בדיקה';
const CONTACT_PHONE = '0534271418';

const SLOTS: { start: string; label: string }[] = [
  { start: '2026-07-07 20:35', label: 'סבב 1 - היום 20:35' },
  { start: '2026-07-07 22:00', label: 'סבב 2 - היום 22:00' },
  { start: '2026-07-08 09:00', label: 'סבב 3 - מחר 09:00' },
];

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    options: '-c timezone=Asia/Jerusalem',
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const it = await client.query(
      'SELECT id, family, "labelHe" FROM "InspectionType" WHERE code = $1',
      [INSPECTION_CODE],
    );
    if (it.rowCount === 0) throw new Error(`InspectionType code=${INSPECTION_CODE} not found`);
    const inspectionTypeId: string = it.rows[0].id;
    const family: string = it.rows[0].family;
    console.log(`InspectionType: ${it.rows[0].labelHe} (family=${family})`);

    const taskIns = await client.query(
      `INSERT INTO "Task"
         (id, title, description, priority, type, status, "ownerId", "productName", "updatedAt")
       VALUES
         (gen_random_uuid(), $1, $2, 'MEDIUM', 'step1', 'OPEN', $3, $4, now())
       RETURNING id`,
      [
        '[QA_TEST] בדיקת רעש סביבתית - גיא לקוח בדיקה',
        'משימת QA - נוצרה אוטומטית לצורך בדיקות ידניות (מצביע בדיקה פעילה + ציטוטים). מיועדת למחיקה בסיום הבדיקות.',
        OWNER_ID,
        INSPECTION_CODE,
      ],
    );
    const taskId: string = taskIns.rows[0].id;
    console.log(`\nTask created: ${taskId}`);

    for (const s of SLOTS) {
      const ins = await client.query(
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
          taskId,
          inspectionTypeId,
          family,
          `[QA_TEST] ${s.label}`,
          s.start,
          'רחוב הבדיקה 1',
          'תל אביב',
          CONTACT_NAME,
          CONTACT_PHONE,
          '[QA_TEST] משימת QA לבדיקות ידניות - למחיקה בסיום.',
        ],
      );
      console.log(
        `TaskField: ${ins.rows[0].id}  ${s.label}  @ ${ins.rows[0].scheduledStartAt.toISOString()}`,
      );
    }

    await client.query('COMMIT');
    console.log(`\n✓ Created 1 Task + ${SLOTS.length} TaskField rows.`);
    console.log(`  Task ID (for reference): ${taskId}`);
    console.log(`  Cleanup:  npx ts-node scripts/qa-cleanup-active-inspection.ts`);
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
