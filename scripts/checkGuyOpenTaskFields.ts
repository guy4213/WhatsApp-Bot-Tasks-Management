import { pool } from '../src/db/connection';

const GUY_USER_ID = '940243d2-8888-463c-81fe-2d93ee01d53c';
const OPEN_STATUSES = ['ASSIGNED','CONFIRMED','EN_ROUTE','ARRIVED','WAITING_FOR_INFO','NEEDS_MORE_INFO'];

async function main() {
  const { rows } = await pool.query<{
    id: string; taskId: string; taskTitle: string | null; customerName: string | null;
    siteAddress: string | null; siteCity: string | null; scheduledStartAt: Date | null;
    fieldStatus: string;
  }>(
    `SELECT tf.id::text        AS id,
            tf."taskId"        AS "taskId",
            t.title            AS "taskTitle",
            c.name             AS "customerName",
            tf."siteAddress"   AS "siteAddress",
            tf."siteCity"      AS "siteCity",
            tf."scheduledStartAt" AS "scheduledStartAt",
            tf."fieldStatus"   AS "fieldStatus"
       FROM "TaskField" tf
       JOIN "Task"     t ON t.id = tf."taskId"
       LEFT JOIN "Customer" c ON c.id = t."customerId"
      WHERE t."ownerId" = $1
        AND tf."fieldStatus" = ANY($2::text[])
      ORDER BY tf."scheduledStartAt" NULLS LAST`,
    [GUY_USER_ID, OPEN_STATUSES],
  );
  console.log(`Guy has ${rows.length} open TaskField(s):`);
  for (const r of rows) {
    console.log(`  ${r.id} | ${r.fieldStatus.padEnd(16)} | ${(r.customerName ?? '(no customer)').padEnd(30)} | ${r.siteCity ?? ''} | task=${r.taskId}`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
