/**
 * Read-only query: worker/user's TaskFields inside a half-open local-day range.
 *
 * This is the "my inspections by range" backend that powers the "הבדיקות שלי …"
 * free-text intent (any user, any single-day / week / month / arbitrary range).
 * Reuses the same JOIN spine as `getInspectionsForWorkerOnDate` in
 * `src/services/inspectionsQueries.ts` — TaskField JOIN Task JOIN InspectionType,
 * LEFT JOINs to Customer/Lead/Project/IncomingLead for the 6-source COALESCE'd
 * customer name.
 *
 * Business date convention (CLAUDE.md §6.1): the daily/range window is defined
 * ONLY by `TaskField.scheduledStartAt` converted to the Asia/Jerusalem local
 * day. We never use `Task.createdAt`, `Task.dueDate`, `TaskField.assignedAt`,
 * or `TaskField.finishedAt` for range scoping.
 *
 * Range is half-open: [fromLocalDate, toLocalDate). A single-day query passes
 * the day and the next day.
 */
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('myInspectionsRange');

/**
 * Row shape returned by `getMyInspectionsInRange`. Same fields as
 * `InspectionListItem` (see inspectionsQueries.ts) plus `scheduledStartAt` so
 * callers can render per-row time and per-row date across a multi-day range.
 */
export interface MyInspectionRangeItem {
  taskFieldId: string;
  /** Parent Task.id — required to hand off to the manager task-detail flow. */
  taskId: string;
  customerName: string | null;
  taskTitle: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  /**
   * On-site contact fields + free-text notes on the TaskField — surfaced in
   * the worker's own list so the voice-assistant `trimInspectionRow` mapper
   * can hand back a snippet without the model having to follow up with a
   * separate details fetch for every row. Manager/org-wide list queries
   * intentionally do NOT carry these to keep the list small.
   */
  fieldContactName: string | null;
  fieldContactPhone: string | null;
  fieldNotes: string | null;
  fieldStatus: string;
  family: string;
  typeLabelHe: string;
  /** timestamptz — used to derive per-row DD/MM + HH:MM in Asia/Jerusalem. */
  scheduledStartAt: Date;
}

/**
 * TaskField rows assigned to `userId` (Task.ownerId) whose scheduledStartAt
 * falls inside the half-open Asia/Jerusalem window [fromLocalDate, toLocalDate).
 *
 * Excludes CANCELED / DECLINED (same rule as `getInspectionsForWorkerOnDate`).
 * Ordered by scheduledStartAt ASC.
 *
 * @param userId          Task.ownerId — same column used across the codebase for
 *                        the "assigned worker" concept.
 * @param fromLocalDate   'YYYY-MM-DD' Asia/Jerusalem, INCLUSIVE lower bound.
 * @param toLocalDate     'YYYY-MM-DD' Asia/Jerusalem, EXCLUSIVE upper bound.
 */
export async function getMyInspectionsInRange(
  userId: string,
  fromLocalDate: string,
  toLocalDate: string,
): Promise<MyInspectionRangeItem[]> {
  const { rows } = await pool.query<{
    taskFieldId: string;
    taskId: string;
    customerName: string | null;
    taskTitle: string | null;
    siteAddress: string | null;
    siteCity: string | null;
    fieldContactName: string | null;
    fieldContactPhone: string | null;
    fieldNotes: string | null;
    fieldStatus: string;
    family: string;
    typeLabelHe: string;
    scheduledStartAt: Date;
  }>(
    `SELECT
       tf.id                       AS "taskFieldId",
       tf."taskId"                 AS "taskId",
       -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
       COALESCE(
         c.name,
         l."fullName",
         NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
         l.company,
         p.client,
         il."fromName"
       )                           AS "customerName",
       t.title                     AS "taskTitle",
       tf."siteAddress"            AS "siteAddress",
       tf."siteCity"               AS "siteCity",
       tf."fieldContactName"       AS "fieldContactName",
       tf."fieldContactPhone"      AS "fieldContactPhone",
       tf."fieldNotes"             AS "fieldNotes",
       tf."fieldStatus"            AS "fieldStatus",
       tf.family                   AS family,
       it."labelHe"                AS "typeLabelHe",
       tf."scheduledStartAt"       AS "scheduledStartAt"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     WHERE t."ownerId" = $1
       AND tf."scheduledStartAt" >= ($2::date) AT TIME ZONE 'Asia/Jerusalem'
       AND tf."scheduledStartAt" <  ($3::date) AT TIME ZONE 'Asia/Jerusalem'
       AND tf."fieldStatus" NOT IN ('CANCELED','DECLINED')
     ORDER BY tf."scheduledStartAt" ASC`,
    [userId, fromLocalDate, toLocalDate],
  );
  log.info(
    { userId, fromLocalDate, toLocalDate, count: rows.length },
    'Loaded my inspections in range',
  );
  return rows;
}

/**
 * All TaskFields assigned to `userId` (Task.ownerId) with NO date filter —
 * used for the "כל הזמנים" / "הכל" / dateScope='all' free-text intent. Excludes
 * CANCELED / DECLINED (same rule as `getMyInspectionsInRange`).
 * Ordered by scheduledStartAt DESC (newest first) so the most relevant rows
 * lead the list. Soft cap at 200 rows so a worker with a very long history
 * doesn't exceed WhatsApp's chunked-body budget.
 */
export async function getAllMyInspections(
  userId: string,
  limit = 200,
): Promise<MyInspectionRangeItem[]> {
  const { rows } = await pool.query<{
    taskFieldId: string;
    taskId: string;
    customerName: string | null;
    taskTitle: string | null;
    siteAddress: string | null;
    siteCity: string | null;
    fieldContactName: string | null;
    fieldContactPhone: string | null;
    fieldNotes: string | null;
    fieldStatus: string;
    family: string;
    typeLabelHe: string;
    scheduledStartAt: Date;
  }>(
    `SELECT
       tf.id                       AS "taskFieldId",
       tf."taskId"                 AS "taskId",
       COALESCE(
         c.name,
         l."fullName",
         NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
         l.company,
         p.client,
         il."fromName"
       )                           AS "customerName",
       t.title                     AS "taskTitle",
       tf."siteAddress"            AS "siteAddress",
       tf."siteCity"               AS "siteCity",
       tf."fieldContactName"       AS "fieldContactName",
       tf."fieldContactPhone"      AS "fieldContactPhone",
       tf."fieldNotes"             AS "fieldNotes",
       tf."fieldStatus"            AS "fieldStatus",
       tf.family                   AS family,
       it."labelHe"                AS "typeLabelHe",
       tf."scheduledStartAt"       AS "scheduledStartAt"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     WHERE t."ownerId" = $1
       AND tf."fieldStatus" NOT IN ('CANCELED','DECLINED')
     ORDER BY tf."scheduledStartAt" DESC NULLS LAST
     LIMIT $2`,
    [userId, limit],
  );
  log.info({ userId, count: rows.length }, 'Loaded ALL my inspections');
  return rows;
}
