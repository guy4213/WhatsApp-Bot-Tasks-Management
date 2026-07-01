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
 * string via `AT TIME ZONE 'Asia/Jerusalem'` (index-friendly on the
 * `TaskField.assignedAt` / `finishedAt` timestamp columns).
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
 *   בוצעו           = finishedFieldToday    (fieldStatus = FINISHED_FIELD, finishedAt within local day)
 *   לא אושרו        = notConfirmedToday     (still at ASSIGNED, assignedAt within local day)
 *   עם בעיה         = hasProblemToday       (hasOpenProblem = true, either finished today or still open today)
 *   ממתינות למידע   = waitingForInfoToday   (fieldStatus = WAITING_FOR_INFO, assigned today)
 *   לא סגרו יום     = notClosedDayToday     (assigned today, not in FINISHED_FIELD/CANCELED/DECLINED)
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
    `WITH bounds AS (
       SELECT
         ($1::date)                   AT TIME ZONE 'Asia/Jerusalem' AS day_start,
         (($1::date) + INTERVAL '1 day') AT TIME ZONE 'Asia/Jerusalem' AS day_end
     )
     SELECT
       COUNT(*) FILTER (
         WHERE tf."fieldStatus" = 'FINISHED_FIELD'
           AND tf."finishedAt" IS NOT NULL
           AND tf."finishedAt" >= b.day_start
           AND tf."finishedAt" <  b.day_end
       )                                                                       AS "finishedFieldToday",
       COUNT(*) FILTER (
         WHERE tf."fieldStatus" = 'ASSIGNED'
           AND tf."assignedAt" >= b.day_start
           AND tf."assignedAt" <  b.day_end
       )                                                                       AS "notConfirmedToday",
       COUNT(*) FILTER (
         WHERE tf."hasOpenProblem" = true
           AND (
             (tf."finishedAt" IS NOT NULL
                AND tf."finishedAt" >= b.day_start
                AND tf."finishedAt" <  b.day_end)
             OR (tf."assignedAt" >= b.day_start
                AND tf."assignedAt" <  b.day_end
                AND tf."fieldStatus" NOT IN ('CANCELED','DECLINED'))
           )
       )                                                                       AS "hasProblemToday",
       COUNT(*) FILTER (
         WHERE tf."fieldStatus" = 'WAITING_FOR_INFO'
           AND tf."assignedAt" >= b.day_start
           AND tf."assignedAt" <  b.day_end
       )                                                                       AS "waitingForInfoToday",
       COUNT(*) FILTER (
         WHERE tf."assignedAt" >= b.day_start
           AND tf."assignedAt" <  b.day_end
           AND tf."fieldStatus" NOT IN ('FINISHED_FIELD','CANCELED','DECLINED')
       )                                                                       AS "notClosedDayToday"
     FROM "TaskField" tf, bounds b`,
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
 * Ordered by `managerNotifiedAt ASC NULLS LAST` — oldest-known first, unnotified
 * last (so Yoram catches the fresh unnotified ones at the bottom).
 *
 * `localDate` is currently unused inside the query (open exceptions are
 * unbounded by date — an open problem from yesterday is still open today) but
 * is threaded through to keep the API symmetric with `getFieldExceptionCounts`
 * and to leave room for a future "only show ones the manager hasn't seen today"
 * filter without changing signatures.
 */
export async function getOpenFieldExceptions(
  localDate: string,
): Promise<OpenFieldException[]> {
  void localDate; // reserved for future filtering; see doc comment above

  const { rows } = await pool.query<{
    taskFieldId: string;
    workerName: string | null;
    customerName: string | null;
    siteAddress: string | null;
    kind: 'problem' | 'missing_info';
    note: string | null;
    problemType: string | null;
    managerNotifiedAt: Date | null;
  }>(
    `SELECT
       tf.id                         AS "taskFieldId",
       u.name                        AS "workerName",
       -- Customer name: COALESCE across Customer/Lead/Project/IncomingLead (SCHEMA_CRM.md)
       COALESCE(
         c.name,
         l."fullName",
         NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
         l.company,
         p.client,
         il."fromName"
       )                             AS "customerName",
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
     WHERE (
       tf."hasOpenProblem" = true
       OR (tf."missingReportInfo" = true AND tf."fieldStatus" = 'WAITING_FOR_INFO')
     )
     ORDER BY tf."managerNotifiedAt" ASC NULLS LAST`,
  );

  log.info({ localDate, count: rows.length }, 'Loaded open field exceptions');
  return rows;
}
