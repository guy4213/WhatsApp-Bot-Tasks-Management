/**
 * Manager-menu read-only query helpers.
 *
 * All queries here are READ-ONLY — no writes. They power the 6-item unified
 * manager menu that replaced the old legacy CRM manager menu.
 *
 * Conventions:
 * - Every query that filters "today" accepts `localDate: string` ('YYYY-MM-DD')
 *   and uses `AT TIME ZONE 'Asia/Jerusalem'` for a half-open UTC window.
 * - All SQL is parameterized ($1, $2, …). No string concatenation of user input.
 * - Free-text search uses ILIKE '%...%' fuzzy match; product code uses exact match.
 */
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('managerViews');

// ── Snapshot ──────────────────────────────────────────────────────────────────

export interface ManagementSnapshot {
  today: {
    total: number;
    finished: number;
    inProgress: number; // EN_ROUTE or ARRIVED
    pending: number;    // ASSIGNED or CONFIRMED, scheduledStartAt today
  };
  openExceptions: number;
  leads: {
    totalOpen: number;  // all unassigned leads right now
    overnight: number;  // leads received in overnight window
    escalated: number;  // escalation candidates (>1h unassigned, daytime)
  };
}

/**
 * Single-round-trip management snapshot for the top-level "תמונת מצב ניהולית".
 * Combines 3 sub-queries via CTEs to minimize DB round-trips.
 */
export async function getManagementSnapshot(localDate: string): Promise<ManagementSnapshot> {
  // Query 1: today's field inspection counts
  const { rows: fieldRows } = await pool.query<{
    total: string;
    finished: string;
    inProgress: string;
    pending: string;
  }>(
    `WITH bounds AS (
       SELECT
         ($1::date)                       AT TIME ZONE 'Asia/Jerusalem' AS day_start,
         (($1::date) + INTERVAL '1 day')  AT TIME ZONE 'Asia/Jerusalem' AS day_end
     )
     SELECT
       COUNT(*)                                                                   AS total,
       COUNT(*) FILTER (WHERE tf."fieldStatus" = 'FINISHED_FIELD')               AS finished,
       COUNT(*) FILTER (WHERE tf."fieldStatus" IN ('EN_ROUTE','ARRIVED'))        AS "inProgress",
       COUNT(*) FILTER (
         WHERE tf."fieldStatus" IN ('ASSIGNED','CONFIRMED')
       )                                                                          AS pending
     FROM "TaskField" tf, bounds b
     WHERE tf."scheduledStartAt" >= b.day_start
       AND tf."scheduledStartAt" <  b.day_end`,
    [localDate],
  );

  // Query 2: open exceptions for the local day (scheduledStartAt window).
  // "Today" is scheduledStartAt in Asia/Jerusalem — this is the manager DAILY
  // snapshot, so an open problem from yesterday for yesterday's inspection
  // does not count against today's snapshot. See the file header note.
  const { rows: exRows } = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM "TaskField" tf
     WHERE tf."scheduledStartAt" >= ($1::date)                       AT TIME ZONE 'Asia/Jerusalem'
       AND tf."scheduledStartAt" <  (($1::date) + INTERVAL '1 day') AT TIME ZONE 'Asia/Jerusalem'
       AND (
         tf."hasOpenProblem" = true
         OR (tf."missingReportInfo" = true AND tf."fieldStatus" = 'WAITING_FOR_INFO')
       )`,
    [localDate],
  );

  // Query 3: lead counts
  const { rows: leadRows } = await pool.query<{
    totalOpen: string;
    overnight: string;
    escalated: string;
  }>(
    // `overnight` follows the same product rule as `getYoramLeadCounts.overnight`:
    // "overnight" = received in the overnight window AND still unassigned.
    // Raw arrival counts are hidden from the CEO snapshot for the same reason —
    // a lead that already has an ownerId is not actionable.
    `SELECT
       COUNT(*) FILTER (WHERE "ownerId" IS NULL)                                AS "totalOpen",
       COUNT(*) FILTER (
         WHERE "ownerId" IS NULL
           AND "receivedAt" >= (($1::date - 1)::timestamp + time '17:00:00') AT TIME ZONE 'Asia/Jerusalem'
           AND "receivedAt" <  ($1::date::timestamp + time '09:30:00') AT TIME ZONE 'Asia/Jerusalem'
       )                                                                        AS overnight,
       COUNT(*) FILTER (
         WHERE "ownerId" IS NULL
           AND "receivedAt" <= now() - interval '1 hour'
           AND ("receivedAt" AT TIME ZONE 'Asia/Jerusalem')::time >= '09:30:00'::time
           AND ("receivedAt" AT TIME ZONE 'Asia/Jerusalem')::time <  '22:00:00'::time
           AND NOT EXISTS (
             SELECT 1 FROM "WhatsappLeadNotification" wln
             WHERE wln."leadId" = "IncomingLead".id::text
               AND wln."eventKind" = 'ESCALATED_1H'
           )
       )                                                                        AS escalated
     FROM "IncomingLead"`,
    [localDate],
  );

  const fr = fieldRows[0];
  const er = exRows[0];
  const lr = leadRows[0];

  const snapshot: ManagementSnapshot = {
    today: {
      total: fr ? Number(fr.total) : 0,
      finished: fr ? Number(fr.finished) : 0,
      inProgress: fr ? Number(fr.inProgress) : 0,
      pending: fr ? Number(fr.pending) : 0,
    },
    openExceptions: er ? Number(er.cnt) : 0,
    leads: {
      totalOpen: lr ? Number(lr.totalOpen) : 0,
      overnight: lr ? Number(lr.overnight) : 0,
      escalated: lr ? Number(lr.escalated) : 0,
    },
  };

  log.info({ localDate, snapshot }, 'Management snapshot loaded');
  return snapshot;
}

// ── Today's org-wide field inspections ───────────────────────────────────────

export interface TodayFieldInspectionRow {
  taskFieldId: string;
  taskId: string;
  workerName: string | null;
  customerName: string | null;
  taskTitle: string | null;      // verbatim Task.title — use for display hint, not customer identity
  timeHm: string | null;        // HH:MM in Jerusalem time
  siteCity: string | null;
  fieldStatus: string;
  family: string;
  typeLabelHe: string;
}

/**
 * All TaskField rows whose `scheduledStartAt` falls today (Asia/Jerusalem), org-wide.
 * Ordered by scheduledStartAt ASC so the list reads chronologically.
 */
export async function getTodayFieldInspections(
  localDate: string,
): Promise<TodayFieldInspectionRow[]> {
  const { rows } = await pool.query<{
    taskFieldId: string;
    taskId: string;
    workerName: string | null;
    customerName: string | null;
    taskTitle: string | null;
    timeHm: string | null;
    siteCity: string | null;
    fieldStatus: string;
    family: string;
    typeLabelHe: string;
  }>(
    `SELECT
       tf.id                                                           AS "taskFieldId",
       tf."taskId"                                                     AS "taskId",
       u.name                                                          AS "workerName",
       -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
       COALESCE(
         c.name,
         l."fullName",
         NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
         l.company,
         p.client,
         il."fromName"
       )                                                               AS "customerName",
       t.title                                                         AS "taskTitle",
       to_char(tf."scheduledStartAt" AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI')
                                                                      AS "timeHm",
       tf."siteCity"                                                   AS "siteCity",
       tf."fieldStatus"                                                AS "fieldStatus",
       tf.family                                                       AS family,
       it."labelHe"                                                    AS "typeLabelHe"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     LEFT JOIN "User" u          ON u.id  = t."ownerId"
     WHERE tf."scheduledStartAt" >= ($1::date)                       AT TIME ZONE 'Asia/Jerusalem'
       AND tf."scheduledStartAt" <  (($1::date) + INTERVAL '1 day') AT TIME ZONE 'Asia/Jerusalem'
     ORDER BY tf."scheduledStartAt" ASC`,
    [localDate],
  );

  log.info({ localDate, count: rows.length }, 'Loaded today field inspections (org-wide)');
  return rows;
}

// ── My field inspections today (D2-T16 — manager item 7) ────────────────────

/**
 * TaskField rows today (Asia/Jerusalem) where Task.ownerId = the given user.
 *
 * This is the personal counterpart of getTodayFieldInspections (which is
 * org-wide). It is used by manager menu item 7 ("הבדיקות שלי להיום") so a
 * manager who is also a field worker can see only their own day without
 * wading through the full org-wide list from item 2.
 *
 * SQL shape: identical to getTodayFieldInspections plus `AND t."ownerId" = $2`.
 * The localDate param ($1) drives the Asia/Jerusalem day window; userId ($2)
 * filters to the requesting user. Does NOT use assignedAt or finishedAt.
 */
export async function getMyFieldInspectionsToday(
  userId: string,
  localDate: string,
): Promise<TodayFieldInspectionRow[]> {
  const { rows } = await pool.query<{
    taskFieldId: string;
    taskId: string;
    workerName: string | null;
    customerName: string | null;
    taskTitle: string | null;
    timeHm: string | null;
    siteCity: string | null;
    fieldStatus: string;
    family: string;
    typeLabelHe: string;
  }>(
    `SELECT
       tf.id                                                           AS "taskFieldId",
       tf."taskId"                                                     AS "taskId",
       u.name                                                          AS "workerName",
       -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
       COALESCE(
         c.name,
         l."fullName",
         NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
         l.company,
         p.client,
         il."fromName"
       )                                                               AS "customerName",
       t.title                                                         AS "taskTitle",
       to_char(tf."scheduledStartAt" AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI')
                                                                      AS "timeHm",
       tf."siteCity"                                                   AS "siteCity",
       tf."fieldStatus"                                                AS "fieldStatus",
       tf.family                                                       AS family,
       it."labelHe"                                                    AS "typeLabelHe"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     LEFT JOIN "User" u          ON u.id  = t."ownerId"
     WHERE tf."scheduledStartAt" >= ($1::date)                       AT TIME ZONE 'Asia/Jerusalem'
       AND tf."scheduledStartAt" <  (($1::date) + INTERVAL '1 day') AT TIME ZONE 'Asia/Jerusalem'
       AND t."ownerId" = $2
     ORDER BY tf."scheduledStartAt" ASC`,
    [localDate, userId],
  );

  log.info({ userId, localDate, count: rows.length }, 'Loaded my field inspections today (per-user)');
  return rows;
}

// ── Field exception rows ──────────────────────────────────────────────────────

// All 5 filters are DAILY (manager daily menu context) and scope by
// TaskField.scheduledStartAt in the local Asia/Jerusalem day. See the
// exceptionsQueries.ts file header for the "today" definition.
export type FieldExceptionFilter =
  | 'open_exceptions'   // scheduled today AND (hasOpenProblem OR missingReportInfo+WAITING_FOR_INFO)
  | 'not_confirmed'     // scheduled today AND fieldStatus = ASSIGNED
  | 'has_problem'       // scheduled today AND fieldStatus = HAS_PROBLEM
  | 'waiting_for_info'  // scheduled today AND fieldStatus = WAITING_FOR_INFO
  | 'not_closed';       // scheduled today AND fieldStatus NOT IN FINISHED_FIELD/CANCELED/DECLINED

export interface FieldExceptionRow {
  taskFieldId: string;
  taskId: string;
  workerName: string | null;
  customerName: string | null;
  taskTitle: string | null;
  siteCity: string | null;
  fieldStatus: string;
  description: string | null; // short one-line description for the list
}

/**
 * Numbered list of field exception rows for the §3 sub-menu.
 * `localDate` is used for "today" filters (not_confirmed, not_closed).
 */
export async function getFieldExceptionRows(
  localDate: string,
  filter: FieldExceptionFilter,
): Promise<FieldExceptionRow[]> {
  let whereClause: string;
  const params: unknown[] = [localDate];

  // Every filter is DAILY — always scope by scheduledStartAt (Asia/Jerusalem).
  // Shared prefix; each `case` appends its status predicate on top.
  const scheduledTodayPrefix = `
    tf."scheduledStartAt" >= ($1::date)                       AT TIME ZONE 'Asia/Jerusalem'
    AND tf."scheduledStartAt" <  (($1::date) + INTERVAL '1 day') AT TIME ZONE 'Asia/Jerusalem'`;

  switch (filter) {
    case 'open_exceptions':
      whereClause = `${scheduledTodayPrefix}
        AND (
          tf."hasOpenProblem" = true
          OR (tf."missingReportInfo" = true AND tf."fieldStatus" = 'WAITING_FOR_INFO')
        )`;
      break;
    case 'not_confirmed':
      whereClause = `${scheduledTodayPrefix}
        AND tf."fieldStatus" = 'ASSIGNED'`;
      break;
    case 'has_problem':
      whereClause = `${scheduledTodayPrefix}
        AND tf."fieldStatus" = 'HAS_PROBLEM'`;
      break;
    case 'waiting_for_info':
      whereClause = `${scheduledTodayPrefix}
        AND tf."fieldStatus" = 'WAITING_FOR_INFO'`;
      break;
    case 'not_closed':
      whereClause = `${scheduledTodayPrefix}
        AND tf."fieldStatus" NOT IN ('FINISHED_FIELD','CANCELED','DECLINED')`;
      break;
  }

  const { rows } = await pool.query<{
    taskFieldId: string;
    taskId: string;
    workerName: string | null;
    customerName: string | null;
    taskTitle: string | null;
    siteCity: string | null;
    fieldStatus: string;
    description: string | null;
  }>(
    `SELECT
       tf.id              AS "taskFieldId",
       tf."taskId"        AS "taskId",
       u.name             AS "workerName",
       -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
       COALESCE(
         c.name,
         l."fullName",
         NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
         l.company,
         p.client,
         il."fromName"
       )                  AS "customerName",
       t.title            AS "taskTitle",
       tf."siteCity"      AS "siteCity",
       tf."fieldStatus"   AS "fieldStatus",
       CASE
         WHEN tf."hasOpenProblem" = true
           THEN coalesce(tf."problemNote", tf."problemType", 'בעיה פתוחה')
         WHEN tf."missingReportInfo" = true
           THEN coalesce(tf."missingReportInfoNote", 'חסר מידע לדוח')
         ELSE NULL
       END                AS description
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     LEFT JOIN "User" u          ON u.id  = t."ownerId"
     WHERE ${whereClause}
     ORDER BY tf."scheduledStartAt" ASC`,
    params,
  );

  log.info({ localDate, filter, count: rows.length }, 'Loaded field exception rows');
  return rows;
}

// ── Worker overview ───────────────────────────────────────────────────────────

export interface WorkerDayOverviewRow {
  workerId: string;
  workerName: string;
  finished: number;
  total: number;
  exceptions: number;
}

/**
 * Per-worker day counts for "עובדים וסיכומי יום" option 1.
 * Returns one row per active inspector who has at least one TaskField today.
 */
export async function getAllWorkersDayOverview(
  localDate: string,
): Promise<WorkerDayOverviewRow[]> {
  const { rows } = await pool.query<{
    workerId: string;
    workerName: string;
    finished: string;
    total: string;
    exceptions: string;
  }>(
    `SELECT
       u.id                                                              AS "workerId",
       u.name                                                            AS "workerName",
       COUNT(*) FILTER (WHERE tf."fieldStatus" = 'FINISHED_FIELD')      AS finished,
       COUNT(*)                                                          AS total,
       COUNT(*) FILTER (
         WHERE tf."hasOpenProblem" = true
            OR (tf."missingReportInfo" = true AND tf."fieldStatus" = 'WAITING_FOR_INFO')
       )                                                                 AS exceptions
     FROM "TaskField" tf
     JOIN "Task" t     ON t.id  = tf."taskId"
     JOIN "User" u     ON u.id  = t."ownerId"
     WHERE tf."scheduledStartAt" >= ($1::date)                       AT TIME ZONE 'Asia/Jerusalem'
       AND tf."scheduledStartAt" <  (($1::date) + INTERVAL '1 day') AT TIME ZONE 'Asia/Jerusalem'
     GROUP BY u.id, u.name
     ORDER BY u.name ASC`,
    [localDate],
  );

  log.info({ localDate, count: rows.length }, 'Loaded all workers day overview');
  return rows.map((r) => ({
    workerId: r.workerId,
    workerName: r.workerName,
    finished: Number(r.finished),
    total: Number(r.total),
    exceptions: Number(r.exceptions),
  }));
}

export interface WorkerDayDetail {
  inspections: TodayFieldInspectionRow[];
  finished: number;
  total: number;
  openExceptions: number;
}

/**
 * One worker's day detail for "עובדים וסיכומי יום" option 2 → pick worker.
 */
export async function getWorkerDayDetail(
  workerId: string,
  localDate: string,
): Promise<WorkerDayDetail> {
  const { rows } = await pool.query<{
    taskFieldId: string;
    taskId: string;
    workerName: string | null;
    customerName: string | null;
    taskTitle: string | null;
    timeHm: string | null;
    siteCity: string | null;
    fieldStatus: string;
    family: string;
    typeLabelHe: string;
    hasOpenProblem: boolean;
    missingReportInfo: boolean;
  }>(
    `SELECT
       tf.id                                                             AS "taskFieldId",
       tf."taskId"                                                       AS "taskId",
       u.name                                                            AS "workerName",
       -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
       COALESCE(
         c.name,
         l."fullName",
         NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
         l.company,
         p.client,
         il."fromName"
       )                                                                 AS "customerName",
       t.title                                                           AS "taskTitle",
       to_char(tf."scheduledStartAt" AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI')
                                                                        AS "timeHm",
       tf."siteCity"                                                     AS "siteCity",
       tf."fieldStatus"                                                  AS "fieldStatus",
       tf.family                                                         AS family,
       it."labelHe"                                                      AS "typeLabelHe",
       tf."hasOpenProblem"                                               AS "hasOpenProblem",
       tf."missingReportInfo"                                            AS "missingReportInfo"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     LEFT JOIN "User" u          ON u.id  = t."ownerId"
     WHERE t."ownerId" = $1
       AND tf."scheduledStartAt" >= ($2::date)                       AT TIME ZONE 'Asia/Jerusalem'
       AND tf."scheduledStartAt" <  (($2::date) + INTERVAL '1 day') AT TIME ZONE 'Asia/Jerusalem'
     ORDER BY tf."scheduledStartAt" ASC`,
    [workerId, localDate],
  );

  const inspections: TodayFieldInspectionRow[] = rows.map((r) => ({
    taskFieldId: r.taskFieldId,
    taskId: r.taskId,
    workerName: r.workerName,
    customerName: r.customerName,
    taskTitle: r.taskTitle,
    timeHm: r.timeHm,
    siteCity: r.siteCity,
    fieldStatus: r.fieldStatus,
    family: r.family,
    typeLabelHe: r.typeLabelHe,
  }));

  const finished = rows.filter((r) => r.fieldStatus === 'FINISHED_FIELD').length;
  const openExceptions = rows.filter(
    (r) => r.hasOpenProblem || (r.missingReportInfo && r.fieldStatus === 'WAITING_FOR_INFO'),
  ).length;

  log.info({ workerId, localDate, count: rows.length }, 'Loaded worker day detail');
  return { inspections, finished, total: rows.length, openExceptions };
}

// ── Search helpers ────────────────────────────────────────────────────────────

/**
 * Fuzzy search TaskField rows by worker name (ILIKE '%query%').
 * Returns up to 20 rows ordered by scheduledStartAt DESC.
 */
export async function searchTasksByWorkerName(
  query: string,
): Promise<TodayFieldInspectionRow[]> {
  const { rows } = await pool.query<{
    taskFieldId: string;
    taskId: string;
    workerName: string | null;
    customerName: string | null;
    taskTitle: string | null;
    timeHm: string | null;
    siteCity: string | null;
    fieldStatus: string;
    family: string;
    typeLabelHe: string;
  }>(
    `SELECT
       tf.id                                                             AS "taskFieldId",
       tf."taskId"                                                       AS "taskId",
       u.name                                                            AS "workerName",
       -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
       COALESCE(
         c.name,
         l."fullName",
         NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
         l.company,
         p.client,
         il."fromName"
       )                                                                 AS "customerName",
       t.title                                                           AS "taskTitle",
       to_char(tf."scheduledStartAt" AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI')
                                                                        AS "timeHm",
       tf."siteCity"                                                     AS "siteCity",
       tf."fieldStatus"                                                  AS "fieldStatus",
       tf.family                                                         AS family,
       it."labelHe"                                                      AS "typeLabelHe"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     LEFT JOIN "User" u          ON u.id  = t."ownerId"
     WHERE u.name ILIKE '%' || $1 || '%'
     ORDER BY tf."scheduledStartAt" DESC
     LIMIT 20`,
    [query],
  );

  log.info({ query, count: rows.length }, 'Searched tasks by worker name');
  return rows;
}

/**
 * Search TaskField rows by product code (exact match on Task.productName).
 * Returns up to 20 rows ordered by scheduledStartAt DESC.
 */
export async function searchTasksByProductCode(
  code: string,
): Promise<TodayFieldInspectionRow[]> {
  const { rows } = await pool.query<{
    taskFieldId: string;
    taskId: string;
    workerName: string | null;
    customerName: string | null;
    taskTitle: string | null;
    timeHm: string | null;
    siteCity: string | null;
    fieldStatus: string;
    family: string;
    typeLabelHe: string;
  }>(
    `SELECT
       tf.id                                                             AS "taskFieldId",
       tf."taskId"                                                       AS "taskId",
       u.name                                                            AS "workerName",
       -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
       COALESCE(
         c.name,
         l."fullName",
         NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
         l.company,
         p.client,
         il."fromName"
       )                                                                 AS "customerName",
       t.title                                                           AS "taskTitle",
       to_char(tf."scheduledStartAt" AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI')
                                                                        AS "timeHm",
       tf."siteCity"                                                     AS "siteCity",
       tf."fieldStatus"                                                  AS "fieldStatus",
       tf.family                                                         AS family,
       it."labelHe"                                                      AS "typeLabelHe"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     LEFT JOIN "User" u          ON u.id  = t."ownerId"
     WHERE t."productName" = $1
     ORDER BY tf."scheduledStartAt" DESC
     LIMIT 20`,
    [code],
  );

  log.info({ code, count: rows.length }, 'Searched tasks by product code');
  return rows;
}

// ── TaskField detail ──────────────────────────────────────────────────────────

export interface TaskFieldDetail {
  taskFieldId: string;
  taskId: string;
  workerName: string | null;
  customerName: string | null;
  taskTitle: string | null;      // verbatim Task.title — use for display hint, not customer identity
  siteAddress: string | null;
  siteCity: string | null;
  fieldContactName: string | null;
  fieldContactPhone: string | null;
  fieldStatus: string;
  scheduledStartAt: Date | null;
  family: string;
  typeLabelHe: string;
  specialInstructions: string | null;
  fieldNotes: string | null;
  problemNote: string | null;
  problemType: string | null;
  missingReportInfoNote: string | null;
  hasOpenProblem: boolean;
  missingReportInfo: boolean;
}

// ── Context values for AI extractor ──────────────────────────────────────────

export interface TaskFieldContextSnapshot {
  customerName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  inspectionTypeLabel: string | null;
  workerName: string | null;
}

/**
 * Lightweight snapshot of a TaskField's current values for the AI context extractor.
 * Used by handleMgrTaskActionReply to give the LLM enough context to understand
 * free-text commands that reference existing values (e.g. "החלף את איש הקשר מ-X ל-Y").
 * Single DB round-trip, read-only.
 */
export async function getTaskFieldValuesForContext(
  taskFieldId: string,
): Promise<TaskFieldContextSnapshot | null> {
  const { rows } = await pool.query<TaskFieldContextSnapshot>(
    `SELECT
       COALESCE(
         c.name,
         l."fullName",
         NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
         l.company,
         p.client,
         il."fromName"
       )                         AS "customerName",
       tf."fieldContactName"     AS "contactName",
       tf."fieldContactPhone"    AS "contactPhone",
       tf."siteAddress"          AS "siteAddress",
       tf."siteCity"             AS "siteCity",
       it."labelHe"              AS "inspectionTypeLabel",
       u.name                    AS "workerName"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     LEFT JOIN "User" u          ON u.id  = t."ownerId"
     WHERE tf.id = $1`,
    [taskFieldId],
  );

  if (rows.length === 0) return null;
  log.info({ taskFieldId }, 'Loaded TaskField context snapshot for AI extractor');
  return rows[0];
}

/**
 * Full details for a single TaskField row — used in detail views for inline actions.
 */
export async function getTaskFieldDetail(
  taskFieldId: string,
): Promise<TaskFieldDetail | null> {
  const { rows } = await pool.query<TaskFieldDetail & {
    hasOpenProblem: boolean;
    missingReportInfo: boolean;
    scheduledStartAt: Date | null;
  }>(
    `SELECT
       tf.id                     AS "taskFieldId",
       tf."taskId"               AS "taskId",
       u.name                    AS "workerName",
       -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
       COALESCE(
         c.name,
         l."fullName",
         NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
         l.company,
         p.client,
         il."fromName"
       )                         AS "customerName",
       t.title                   AS "taskTitle",
       tf."siteAddress"          AS "siteAddress",
       tf."siteCity"             AS "siteCity",
       tf."fieldContactName"     AS "fieldContactName",
       tf."fieldContactPhone"    AS "fieldContactPhone",
       tf."fieldStatus"          AS "fieldStatus",
       tf."scheduledStartAt"     AS "scheduledStartAt",
       tf.family                 AS family,
       it."labelHe"              AS "typeLabelHe",
       tf."specialInstructions"  AS "specialInstructions",
       tf."fieldNotes"           AS "fieldNotes",
       tf."problemNote"          AS "problemNote",
       tf."problemType"          AS "problemType",
       tf."missingReportInfoNote" AS "missingReportInfoNote",
       tf."hasOpenProblem"       AS "hasOpenProblem",
       tf."missingReportInfo"    AS "missingReportInfo"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     LEFT JOIN "User" u          ON u.id  = t."ownerId"
     WHERE tf.id = $1`,
    [taskFieldId],
  );

  if (rows.length === 0) return null;
  log.info({ taskFieldId }, 'Loaded TaskField detail');
  return rows[0];
}
