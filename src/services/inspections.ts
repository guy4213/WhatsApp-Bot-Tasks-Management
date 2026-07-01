/**
 * Field inspection write + query helpers (D2-T7 + D2-T8).
 *
 * Owns the write path for the two worker-side flows that update `TaskField`:
 *  - `writeMissingInfo` — the "missing info for report" flow (spec §8).
 *  - `writeProblem`     — the "report a problem" flow (spec §9).
 * Plus a small resolver `findOpenTaskFieldForWorker` used by both flows to
 * decide whether the worker has exactly one open TaskField (single dispatch),
 * zero (nothing to update), or several (disambiguation — handed off to D2-T5).
 *
 * The manager-side alert is sent by `notifyOfficeMissingInfo` /
 * `notifyOfficeProblem` — these broadcast to every active MANAGER/ADMIN via the
 * existing `getManagersForBroadcast()` helper, which is how the rest of the
 * codebase addresses "the office". If no manager is configured, the write still
 * succeeds (`managerNotifiedAt` set by the write helpers); we log a warning.
 *
 * NOTE: read helpers (digest lookups etc.) live in `inspectionsQueries.ts`,
 * owned by D2-T4 in parallel — do NOT merge that surface into this file.
 */
import { pool } from '../db/connection';
import { sendTextMessage } from '../whatsapp/sender';
import { getManagersForBroadcast } from './pendingActions';
import { moduleLogger } from '../utils/logger';
import type { FieldProblemType } from '../types';

const log = moduleLogger('inspections');

/** The `fieldStatus` values that count as "open" for worker-side dispatching.
 * The office-owned terminal states (DECLINED, FINISHED_FIELD, HAS_PROBLEM,
 * CANCELED) are NOT open — a fresh problem/missing-info report against a
 * closed inspection would surprise the worker. */
const OPEN_FIELD_STATUSES = [
  'ASSIGNED',
  'CONFIRMED',
  'EN_ROUTE',
  'ARRIVED',
  'WAITING_FOR_INFO',
  'NEEDS_MORE_INFO',
] as const;

// ── Write helpers ────────────────────────────────────────────────────────────

export interface WriteMissingInfoParams {
  taskFieldId: string;
  note: string;
  updatedBy: string;
}

/**
 * §8 write: set the TaskField into WAITING_FOR_INFO with a note describing
 * what's missing for the office report. `managerNotifiedAt` is stamped here so
 * the write is durable even if the outbound office alert fails.
 */
export async function writeMissingInfo(params: WriteMissingInfoParams): Promise<void> {
  const { taskFieldId, note, updatedBy } = params;
  await pool.query(
    `UPDATE "TaskField"
        SET "fieldStatus"           = 'WAITING_FOR_INFO',
            "missingReportInfo"     = true,
            "missingReportInfoNote" = $2,
            "managerNotifiedAt"     = now(),
            "updatedByUserId"       = $3,
            "updatedAt"             = now()
      WHERE id = $1`,
    [taskFieldId, note, updatedBy],
  );
  log.info({ taskFieldId, updatedBy }, 'writeMissingInfo: WAITING_FOR_INFO written');
}

export interface WriteProblemParams {
  taskFieldId: string;
  problemType: FieldProblemType;
  note: string | null;
  updatedBy: string;
}

/**
 * §9 write: mark a single inline problem on the TaskField. `hasOpenProblem`
 * flips true and `fieldStatus` moves to HAS_PROBLEM. Only ONE problem per
 * inspection is stored inline (spec §9 — multi-problem is deferred via a
 * future `TaskFieldEntry` table).
 */
export async function writeProblem(params: WriteProblemParams): Promise<void> {
  const { taskFieldId, problemType, note, updatedBy } = params;
  await pool.query(
    `UPDATE "TaskField"
        SET "problemType"       = $2,
            "problemNote"       = $3,
            "hasOpenProblem"    = true,
            "fieldStatus"       = 'HAS_PROBLEM',
            "managerNotifiedAt" = now(),
            "updatedByUserId"   = $4,
            "updatedAt"         = now()
      WHERE id = $1`,
    [taskFieldId, problemType, note, updatedBy],
  );
  log.info({ taskFieldId, updatedBy, problemType }, 'writeProblem: HAS_PROBLEM written');
}

// ── Open-TaskField lookup ────────────────────────────────────────────────────

export type OpenTaskFieldResult =
  | { taskFieldId: string; customerName: string | null }
  | { ambiguous: true; count: number }
  | null;

/**
 * Find the one open TaskField for a worker (used before prompting for a note /
 * showing the problem sub-menu). Returns:
 *  - `null`                  → no open TaskField at all
 *  - `{ ambiguous, count }`  → more than one open TaskField → caller must
 *                              disambiguate (D2-T5 will fully implement that)
 *  - `{ taskFieldId, customerName }` → exactly one open TaskField, dispatch it.
 *
 * `Task.ownerId` is the CRM column that identifies the assigned worker (verified
 * against `src/services/tasks.ts` — no `assigneeId` column exists on `Task`).
 */
export async function findOpenTaskFieldForWorker(userId: string): Promise<OpenTaskFieldResult> {
  const result = await pool.query<{ taskFieldId: string; customerName: string | null }>(
    `SELECT tf.id            AS "taskFieldId",
            c.name           AS "customerName"
       FROM "TaskField" tf
       JOIN "Task"      t  ON t.id = tf."taskId"
       LEFT JOIN "Customer" c ON c.id = t."customerId"
      WHERE t."ownerId"    = $1
        AND tf."fieldStatus" = ANY($2::text[])
      ORDER BY tf."assignedAt"`,
    [userId, OPEN_FIELD_STATUSES],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount === 1) {
    return {
      taskFieldId: result.rows[0].taskFieldId,
      customerName: result.rows[0].customerName,
    };
  }
  return { ambiguous: true, count: result.rowCount ?? result.rows.length };
}

// ── Office / manager notifications ───────────────────────────────────────────

interface AlertContext {
  workerName: string | null;
  familyLabelHe: string | null;
  customerName: string | null;
  siteCity: string | null;
  missingReportInfoNote: string | null;
  problemType: FieldProblemType | null;
  problemNote: string | null;
}

/** Resolve worker/family/customer/site context for an office alert. */
async function loadAlertContext(taskFieldId: string): Promise<AlertContext | null> {
  const result = await pool.query<{
    workerName: string | null;
    familyLabelHe: string | null;
    customerName: string | null;
    siteCity: string | null;
    missingReportInfoNote: string | null;
    problemType: FieldProblemType | null;
    problemNote: string | null;
  }>(
    `SELECT u.name              AS "workerName",
            it."labelHe"        AS "familyLabelHe",
            c.name              AS "customerName",
            tf."siteCity"       AS "siteCity",
            tf."missingReportInfoNote" AS "missingReportInfoNote",
            tf."problemType"    AS "problemType",
            tf."problemNote"    AS "problemNote"
       FROM "TaskField" tf
       JOIN "Task"      t  ON t.id = tf."taskId"
       JOIN "InspectionType" it ON it.id = tf."inspectionTypeId"
       LEFT JOIN "User"     u  ON u.id = t."ownerId"
       LEFT JOIN "Customer" c  ON c.id = t."customerId"
      WHERE tf.id = $1`,
    [taskFieldId],
  );
  return result.rowCount === 0 ? null : result.rows[0];
}

/** Broadcast a Hebrew alert to every active MANAGER/ADMIN. Warns + returns
 *  false when no recipient is configured — the caller's DB write is already
 *  durable, so no-op is safe. */
async function broadcastToManagers(text: string, taskFieldId: string): Promise<boolean> {
  const managers = await getManagersForBroadcast();
  if (managers.length === 0) {
    log.warn(
      { taskFieldId },
      'office recipient not configured; alert not sent (no active MANAGER/ADMIN with a phone)',
    );
    return false;
  }
  await Promise.allSettled(
    managers.map((m) =>
      sendTextMessage({ to: m.phone, text }).catch((err) => {
        log.error({ err, taskFieldId, managerId: m.id }, 'manager alert send failed');
      }),
    ),
  );
  return true;
}

/** §8 office alert: worker reported a missing detail for the final report. */
export async function notifyOfficeMissingInfo(taskFieldId: string): Promise<void> {
  const ctx = await loadAlertContext(taskFieldId);
  if (!ctx) {
    log.warn({ taskFieldId }, 'notifyOfficeMissingInfo: TaskField not found');
    return;
  }
  const worker   = ctx.workerName    ?? '—';
  const family   = ctx.familyLabelHe ?? '—';
  const customer = ctx.customerName  ?? '—';
  const city     = ctx.siteCity      ? ` (${ctx.siteCity})` : '';
  const note     = ctx.missingReportInfoNote ?? '';
  const text =
    `חסר מידע לדוח\n` +
    `עובד: ${worker} · בדיקה: ${family} · לקוח: ${customer}${city}\n` +
    `${note}\n` +
    `לטיפול המשרד.`;
  await broadcastToManagers(text, taskFieldId);
}

const PROBLEM_TYPE_LABELS_HE: Record<FieldProblemType, string> = {
  CUSTOMER_NOT_ANSWERING: 'הלקוח לא ענה',
  NO_ACCESS:              'אין גישה',
  CUSTOMER_NOT_PRESENT:   'הלקוח לא נמצא',
  MISSING_EQUIPMENT:      'חסר ציוד',
  CANNOT_PERFORM:         'לא ניתן לבצע',
  PROFESSIONAL_ISSUE:     'בעיה מקצועית',
  OTHER:                  'אחר',
};

/** §9 manager alert: worker reported a problem on the inspection. */
export async function notifyOfficeProblem(taskFieldId: string): Promise<void> {
  const ctx = await loadAlertContext(taskFieldId);
  if (!ctx) {
    log.warn({ taskFieldId }, 'notifyOfficeProblem: TaskField not found');
    return;
  }
  const worker   = ctx.workerName    ?? '—';
  const family   = ctx.familyLabelHe ?? '—';
  const customer = ctx.customerName  ?? '—';
  const city     = ctx.siteCity      ? ` (${ctx.siteCity})` : '';
  const typeHe   = ctx.problemType ? PROBLEM_TYPE_LABELS_HE[ctx.problemType] : '—';
  const detail   = ctx.problemNote ? `\n${ctx.problemNote}` : '';
  const text =
    `בעיה מהשטח\n` +
    `עובד: ${worker} · בדיקה: ${family} · לקוח: ${customer}${city}\n` +
    `סוג: ${typeHe}${detail}\n` +
    `לטיפול מנהל.`;
  await broadcastToManagers(text, taskFieldId);
}
