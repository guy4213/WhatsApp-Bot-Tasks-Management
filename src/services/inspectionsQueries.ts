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
  taskTitle?: string | null;  // optional: present when callers need a display label
  siteAddress: string | null;
  siteCity: string | null;
  fieldStatus: string;
  family: string;
  typeLabelHe: string;
}

/**
 * Load every field inspection assigned to `userId` whose `scheduledStartAt` falls
 * inside the given local calendar day, EXCLUDING statuses that are no longer
 * actionable (CANCELED / DECLINED). Ordered by assignment time.
 *
 * `localDate` is a 'YYYY-MM-DD' in the USER'S timezone; we convert it to a
 * half-open UTC range via `AT TIME ZONE`, which is cleaner (index-friendly)
 * than casting `scheduledStartAt` to a date in a specific tz for every row.
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
    taskTitle: string | null;
    siteAddress: string | null;
    siteCity: string | null;
    fieldStatus: string;
    family: string;
    typeLabelHe: string;
  }>(
    `SELECT
       tf.id                       AS "taskFieldId",
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
       tf."fieldStatus"            AS "fieldStatus",
       tf.family                   AS family,
       it."labelHe"                AS "typeLabelHe"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     WHERE t."ownerId" = $1
       AND tf."scheduledStartAt" >= ($2::date) AT TIME ZONE 'Asia/Jerusalem'
       AND tf."scheduledStartAt" <  (($2::date) + INTERVAL '1 day') AT TIME ZONE 'Asia/Jerusalem'
       AND tf."fieldStatus" NOT IN ('CANCELED','DECLINED')
     ORDER BY tf."scheduledStartAt" ASC`,
    [userId, localDate],
  );
  log.info({ userId, localDate, count: rows.length }, 'Loaded worker inspections for date');
  return rows;
}

// ── D2-T10: on-demand day summary (menu item 7) ─────────────────────────────
// SPEC_FIELD_V2 §11. Returns the FINISHED_FIELD rows (customer + type) for the
// worker's local day, plus a count of WAITING_FOR_INFO rows (the two live
// numbers the summary needs). Mirrors `getInspectionsForWorkerOnDate` shape:
// same `AT TIME ZONE 'Asia/Jerusalem'` half-open window on `scheduledStartAt`, same
// JOIN spine, same LEFT JOIN customer for null-tolerance.

export interface DayFieldSummary {
  finished: InspectionListItem[];
  waitingForInfoCount: number;
}

/**
 * Aggregate today's field state for a worker: the list of FINISHED_FIELD rows
 * (so the follow-up menu can name what was done) and the count of
 * WAITING_FOR_INFO rows. Ordered by `scheduledStartAt` so the finished list matches
 * the morning list order.
 */
export async function getFieldSummaryForWorkerOnDate(
  userId: string,
  localDate: string,
): Promise<DayFieldSummary> {
  const { rows } = await pool.query<{
    taskFieldId: string;
    customerName: string | null;
    taskTitle: string | null;
    siteAddress: string | null;
    siteCity: string | null;
    fieldStatus: string;
    family: string;
    typeLabelHe: string;
  }>(
    `SELECT
       tf.id                       AS "taskFieldId",
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
       tf."fieldStatus"            AS "fieldStatus",
       tf.family                   AS family,
       it."labelHe"                AS "typeLabelHe"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     WHERE t."ownerId" = $1
       AND tf."scheduledStartAt" >= ($2::date) AT TIME ZONE 'Asia/Jerusalem'
       AND tf."scheduledStartAt" <  (($2::date) + INTERVAL '1 day') AT TIME ZONE 'Asia/Jerusalem'
       AND tf."fieldStatus" IN ('FINISHED_FIELD','WAITING_FOR_INFO')
     ORDER BY tf."scheduledStartAt" ASC`,
    [userId, localDate],
  );
  const finished: InspectionListItem[] = [];
  let waitingForInfoCount = 0;
  for (const r of rows) {
    if (r.fieldStatus === 'FINISHED_FIELD') finished.push(r);
    else if (r.fieldStatus === 'WAITING_FOR_INFO') waitingForInfoCount++;
  }
  log.info(
    { userId, localDate, finished: finished.length, waitingForInfoCount },
    'Loaded day field summary',
  );
  return { finished, waitingForInfoCount };
}

// ── D2-T9: equipment reminder — checklist rows deduped by family ───────────
// SPEC_FIELD_V2 §10. The morning roll-up needs the required equipment for
// each family the worker is inspecting today. `InspectionChecklist` is seeded
// per family (17 rows across 4 families — see migration 009 lines 146-164),
// so a single `WHERE family = ANY(...)` returns the full deduped set. Empty
// input short-circuits to avoid an unnecessary DB round-trip.

/** One deduped equipment checklist row for the D2-T9 morning roll-up.
 *  `family` is preserved on the row so callers/tests can see which family a
 *  line came from; the formatter groups only by `labelHe`. */
export interface EquipmentChecklistItem {
  family: string;
  code: string;
  labelHe: string;
  isRequired: boolean;
  sortOrder: number;
}

/**
 * Load every `InspectionChecklist` row whose `family` is in the given set.
 * Result order: `family`, then `sortOrder` — so a single-family list is stable
 * across runs and a multi-family list is a concatenation of per-family blocks.
 * De-duplication of equipment items (e.g. `tripod` seeded for both radiation
 * and noise) is the FORMATTER's job — it sees the `labelHe` and dedupes there,
 * preserving family information for logging.
 *
 * Empty input → returns `[]` without touching the DB.
 */
export async function getEquipmentChecklistForFamilies(
  families: string[],
): Promise<EquipmentChecklistItem[]> {
  if (families.length === 0) return [];
  const { rows } = await pool.query<EquipmentChecklistItem>(
    `SELECT
       family                       AS family,
       code                         AS code,
       "labelHe"                    AS "labelHe",
       "isRequired"                 AS "isRequired",
       "sortOrder"                  AS "sortOrder"
     FROM "InspectionChecklist"
     WHERE family = ANY($1::text[])
     ORDER BY family ASC, "sortOrder" ASC`,
    [families],
  );
  log.info({ families, count: rows.length }, 'Loaded equipment checklist for families');
  return rows;
}
