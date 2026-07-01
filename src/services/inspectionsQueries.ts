/**
 * Read-only queries against the field-inspection layer (migration 009).
 *
 * This module is INTENTIONALLY separate from `src/services/inspections.ts`
 * (owned by D2-T7/T8, write path) — reads live here so parallel agents don't
 * collide. Nothing here writes to `TaskField` / `InspectionType` / `Customer`.
 *
 * Every query joins `TaskField` → `Task` → `InspectionType`, and LEFT JOINs
 * `Customer` via the CRM's `Task.customerId` FK (see `src/services/tasks.ts`
 * lines 192-201 for the same shape). If a task has no customer, `customerName`
 * degrades to null and the formatter shows a placeholder.
 *
 * Status ownership: the CRM owns `Task.status`. We NEVER read/write it here.
 * The live field lifecycle lives on `TaskField.fieldStatus`.
 */
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('inspectionsQueries');

export interface InspectionListItem {
  taskFieldId: string;
  customerName: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  fieldStatus: string;
  family: string;
  typeLabelHe: string;
}

/**
 * Load every field inspection assigned to `userId` whose `assignedAt` falls
 * inside the given local calendar day, EXCLUDING statuses that are no longer
 * actionable (CANCELED / DECLINED). Ordered by assignment time.
 *
 * `localDate` is a 'YYYY-MM-DD' in the USER'S timezone; we convert it to a
 * half-open UTC range via `AT TIME ZONE`, which is cleaner (index-friendly)
 * than casting `assignedAt` to a date in a specific tz for every row.
 *
 * @param userId    the assignee — matches `Task.ownerId` (the CRM's assignment
 *                  column; confirmed against `src/services/tasks.ts:192` and
 *                  `src/auth/permissions.ts:61`).
 * @param localDate 'YYYY-MM-DD' as observed in the user's timezone.
 */
export async function getInspectionsForWorkerOnDate(
  userId: string,
  localDate: string,
): Promise<InspectionListItem[]> {
  const { rows } = await pool.query<{
    taskFieldId: string;
    customerName: string | null;
    siteAddress: string | null;
    siteCity: string | null;
    fieldStatus: string;
    family: string;
    typeLabelHe: string;
  }>(
    `SELECT
       tf.id                       AS "taskFieldId",
       c.name                      AS "customerName",
       tf."siteAddress"            AS "siteAddress",
       tf."siteCity"               AS "siteCity",
       tf."fieldStatus"            AS "fieldStatus",
       tf.family                   AS family,
       it."labelHe"                AS "typeLabelHe"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
     LEFT JOIN "Customer" c    ON c.id  = t."customerId"
     WHERE t."ownerId" = $1
       AND tf."assignedAt" >= ($2::date) AT TIME ZONE 'Asia/Jerusalem'
       AND tf."assignedAt" <  (($2::date) + INTERVAL '1 day') AT TIME ZONE 'Asia/Jerusalem'
       AND tf."fieldStatus" NOT IN ('CANCELED','DECLINED')
     ORDER BY tf."assignedAt" ASC`,
    [userId, localDate],
  );
  log.info({ userId, localDate, count: rows.length }, 'Loaded worker inspections for date');
  return rows;
}
