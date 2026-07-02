/**
 * Read-only aggregation queries powering Yoram's morning + evening exceptions
 * digest (D4-T1, SPEC_FIELD_V2 §13).
 *
 * INTENTIONALLY separate from `src/services/inspectionsQueries.ts` (D2-T4 read
 * module, owned by another agent) and from `src/services/inspections.ts` (D2-T5+
 * write module, owned by a parallel agent). Live here so parallel work doesn't
 * collide. Nothing here writes.
 *
 * Local-day windowing mirrors `getInspectionsForWorkerOnDate` in
 * `inspectionsQueries.ts` — a half-open UTC range derived from a 'YYYY-MM-DD'
 * string via `AT TIME ZONE 'Asia/Jerusalem'`.
 *
 * "Today" definition (2026-07-02 alignment): every daily count and every open
 * exception in Yoram's digest is scoped by `TaskField.scheduledStartAt` — the
 * planned inspection time set at CRM scheduling. `assignedAt` (row creation
 * time) and `finishedAt` (actual completion time) do NOT define the daily
 * operational scope. Rationale: a TaskField created today but scheduled next
 * week is next-week work, not today's; a TaskField created last week but
 * scheduled today IS today's work.
 *
 * Status ownership: the CRM owns `Task.status`. We NEVER read/write it. The live
 * field lifecycle is on `TaskField.fieldStatus` (10 values from migration 009).
 *
 * The Task assignee column is `Task.ownerId` — confirmed against
 * `src/services/tasks.ts:192` and `src/services/inspectionsQueries.ts:70`.
 */
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('exceptionsQueries');

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The 5 field counts rendered in Yoram's digest per SPEC §13.
 *
 * "Today" = scheduledStartAt within the local Asia/Jerusalem day (see file
 * header). All 5 counts share the same day-scoping predicate on
 * `TaskField.scheduledStartAt`.
 *
 *   בוצעו           = finishedFieldToday    (scheduled today AND fieldStatus = FINISHED_FIELD)
 *   לא אושרו        = notConfirmedToday     (scheduled today AND fieldStatus = ASSIGNED)
 *   עם בעיה         = hasProblemToday       (scheduled today AND hasOpenProblem = true)
 *   ממתינות למידע   = waitingForInfoToday   (scheduled today AND fieldStatus = WAITING_FOR_INFO)
 *   לא סגרו יום     = notClosedDayToday     (scheduled today AND fieldStatus NOT IN FINISHED_FIELD/CANCELED/DECLINED)
 */
export interface FieldExceptionCounts {
  finishedFieldToday: number;
  notConfirmedToday: number;
  hasProblemToday: number;
  waitingForInfoToday: number;
  notClosedDayToday: number;
}

/** One open field exception row for the numbered list in §13. */
export interface OpenFieldException {
  taskFieldId: string;
  workerName: string | null;
  customerName: string | null;
  taskTitle?: string | null;  // optional: present when a display label hint is needed
  siteAddress: string | null;
  kind: 'problem' | 'missing_info';
  note: string | null;         // problemNote for kind='problem'; missingReportInfoNote for kind='missing_info'
  problemType: string | null;  // set only when kind='problem'
  managerNotifiedAt: Date | null;
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * The 5 field counts for the given local calendar day.
 *
 * `localDate` — 'YYYY-MM-DD' in Asia/Jerusalem. Half-open UTC window
 * `[localDate 00:00 IL, localDate+1 00:00 IL)`.
 *
 * All 5 counts are computed in one round-trip via a single aggregation.
 * Parameterized on $1 = localDate; no string concatenation.
 */
export async function getFieldExceptionCounts(
  localDate: string,
): Promise<FieldExceptionCounts> {
  const { rows } = await pool.query<{
    finishedFieldToday: string;
    notConfirmedToday: string;
    hasProblemToday: string;
    waitingForInfoToday: string;
    notClosedDayToday: string;
  }>(
    // All 5 counts share the same "scheduled today (Asia/Jerusalem)" window
    // on TaskField.scheduledStartAt. The WHERE clause pre-filters to today's
    // scheduled TaskFields so every COUNT(*) FILTER only slices among rows we
    // already know are today's work. See file header for rationale.
    `WITH bounds AS (
       SELECT
         ($1::date)                   AT TIME ZONE 'Asia/Jerusalem' AS day_start,
         (($1::date) + INTERVAL '1 day') AT TIME ZONE 'Asia/Jerusalem' AS day_end
     )
     SELECT
       COUNT(*) FILTER (
         WHERE tf."fieldStatus" = 'FINISHED_FIELD'
       )                                                                       AS "finishedFieldToday",
       COUNT(*) FILTER (
         WHERE tf."fieldStatus" = 'ASSIGNED'
       )                                                                       AS "notConfirmedToday",
       COUNT(*) FILTER (
         WHERE tf."hasOpenProblem" = true
       )                                                                       AS "hasProblemToday",
       COUNT(*) FILTER (
         WHERE tf."fieldStatus" = 'WAITING_FOR_INFO'
       )                                                                       AS "waitingForInfoToday",
       COUNT(*) FILTER (
         WHERE tf."fieldStatus" NOT IN ('FINISHED_FIELD','CANCELED','DECLINED')
       )                                                                       AS "notClosedDayToday"
     FROM "TaskField" tf, bounds b
     WHERE tf."scheduledStartAt" >= b.day_start
       AND tf."scheduledStartAt" <  b.day_end`,
    [localDate],
  );

  const r = rows[0];
  const counts: FieldExceptionCounts = {
    finishedFieldToday:   r ? Number(r.finishedFieldToday)   : 0,
    notConfirmedToday:    r ? Number(r.notConfirmedToday)    : 0,
    hasProblemToday:      r ? Number(r.hasProblemToday)      : 0,
    waitingForInfoToday:  r ? Number(r.waitingForInfoToday)  : 0,
    notClosedDayToday:    r ? Number(r.notClosedDayToday)    : 0,
  };
  log.info({ localDate, counts }, 'Loaded field exception counts');
  return counts;
}

/**
 * The numbered list of OPEN field exceptions for §13's "פתוחים:" block.
 *
 * A row is "open" if either:
 *   • `hasOpenProblem = true`                                (kind = 'problem'),  OR
 *   • `missingReportInfo = true` AND `fieldStatus = 'WAITING_FOR_INFO'`
 *                                                            (kind = 'missing_info').
 *
 * Scoped to TaskFields scheduled for `localDate` (Asia/Jerusalem) — this is
 * Yoram's DAILY digest, and the "today" definition is scheduledStartAt (see
 * file header). A problem opened yesterday for yesterday's inspection stays
 * yesterday's problem; today's list shows today's open exceptions only.
 *
 * Ordered by `managerNotifiedAt ASC NULLS LAST` — oldest-known first, unnotified
 * last (so Yoram catches the fresh unnotified ones at the bottom).
 */
export async function getOpenFieldExceptions(
  localDate: string,
): Promise<OpenFieldException[]> {
  const { rows } = await pool.query<{
    taskFieldId: string;
    workerName: string | null;
    customerName: string | null;
    taskTitle: string | null;
    siteAddress: string | null;
    kind: 'problem' | 'missing_info';
    note: string | null;
    problemType: string | null;
    managerNotifiedAt: Date | null;
  }>(
    `SELECT
       tf.id                         AS "taskFieldId",
       u.name                        AS "workerName",
       -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
       COALESCE(
         c.name,
         l."fullName",
         NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
         l.company,
         p.client,
         il."fromName"
       )                             AS "customerName",
       t.title                       AS "taskTitle",
       tf."siteAddress"              AS "siteAddress",
       CASE
         WHEN tf."hasOpenProblem" = true
           THEN 'problem'
         ELSE 'missing_info'
       END                           AS kind,
       CASE
         WHEN tf."hasOpenProblem" = true
           THEN tf."problemNote"
         ELSE tf."missingReportInfoNote"
       END                           AS note,
       CASE
         WHEN tf."hasOpenProblem" = true
           THEN tf."problemType"
         ELSE NULL
       END                           AS "problemType",
       tf."managerNotifiedAt"        AS "managerNotifiedAt"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     LEFT JOIN "User" u          ON u.id  = t."ownerId"
     WHERE tf."scheduledStartAt" >= ($1::date)                       AT TIME ZONE 'Asia/Jerusalem'
       AND tf."scheduledStartAt" <  (($1::date) + INTERVAL '1 day') AT TIME ZONE 'Asia/Jerusalem'
       AND (
         tf."hasOpenProblem" = true
         OR (tf."missingReportInfo" = true AND tf."fieldStatus" = 'WAITING_FOR_INFO')
       )
     ORDER BY tf."managerNotifiedAt" ASC NULLS LAST`,
    [localDate],
  );

  log.info({ localDate, count: rows.length }, 'Loaded open field exceptions');
  return rows;
}
