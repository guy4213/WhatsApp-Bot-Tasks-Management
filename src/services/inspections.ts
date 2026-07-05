/**
 * Field inspection write + query helpers (D2-T5 + D2-T6 + D2-T7 + D2-T8).
 *
 * Owns the write path for the worker-side flows that update `TaskField`:
 *  - `writeMissingInfo` — the "missing info for report" flow (spec §8).
 *  - `writeProblem`     — the "report a problem" flow (spec §9).
 *  - `advanceFieldStatus` — the on-demand DEPARTED / ARRIVED / FINISHED
 *    transitions (spec §7). FINISHED is unconditional.
 *  - `writeFieldNotes` — the D2-T6 "finished follow-up" option 2 (free-text
 *    notes captured into `TaskField.fieldNotes`).
 * Plus resolvers `findOpenTaskFieldForWorker` and `resolveOpenTaskFieldByHint`
 * used by every worker flow to decide which of the (typically 0/1/N) open
 * TaskFields the message is about.
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
import { LABELS } from '../ai/inspectionFormatters';
import {
  getFieldSummaryForWorkerOnDate,
  type DayFieldSummary,
} from './inspectionsQueries';
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

/** Preview row for a worker's ambiguous open-TaskField picker. Small subset of
 *  the columns the daily list uses — enough to disambiguate by eye. */
export interface OpenTaskFieldPreview {
  taskFieldId: string;
  customerName: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  scheduledStartAt: Date | null;
}

export type OpenTaskFieldResult =
  | { taskFieldId: string; customerName: string | null; taskTitle: string | null }
  | { ambiguous: true; count: number; items: OpenTaskFieldPreview[] }
  | null;

/**
 * Find the one open TaskField for a worker (used before prompting for a note /
 * showing the problem sub-menu). Returns:
 *  - `null`                                   → no open TaskField at all
 *  - `{ ambiguous, count, items }`            → more than one open TaskField;
 *                                                the caller shows the numbered
 *                                                `items` preview so the worker
 *                                                can pick by number, name, or
 *                                                address.
 *  - `{ taskFieldId, customerName, taskTitle }` → exactly one open TaskField.
 *
 * `Task.ownerId` is the CRM column that identifies the assigned worker (verified
 * against `src/services/tasks.ts` — no `assigneeId` column exists on `Task`).
 */
export async function findOpenTaskFieldForWorker(userId: string): Promise<OpenTaskFieldResult> {
  const result = await pool.query<{
    taskFieldId: string;
    customerName: string | null;
    taskTitle: string | null;
    siteAddress: string | null;
    siteCity: string | null;
    scheduledStartAt: Date | null;
  }>(
    `SELECT tf.id            AS "taskFieldId",
            -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
            COALESCE(
              c.name,
              l."fullName",
              NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
              l.company,
              p.client,
              il."fromName"
            )                    AS "customerName",
            t.title              AS "taskTitle",
            tf."siteAddress"     AS "siteAddress",
            tf."siteCity"        AS "siteCity",
            tf."scheduledStartAt" AS "scheduledStartAt"
       FROM "TaskField" tf
       JOIN "Task"           t  ON t.id  = tf."taskId"
       LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
       LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
       LEFT JOIN "Project"      p  ON p.id  = t."projectId"
       LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
      WHERE t."ownerId"    = $1
        AND tf."fieldStatus" = ANY($2::text[])
      ORDER BY tf."scheduledStartAt" NULLS LAST, tf."assignedAt"`,
    [userId, OPEN_FIELD_STATUSES],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount === 1) {
    return {
      taskFieldId: result.rows[0].taskFieldId,
      customerName: result.rows[0].customerName,
      taskTitle: result.rows[0].taskTitle,
    };
  }
  const items: OpenTaskFieldPreview[] = result.rows.map((r) => ({
    taskFieldId: r.taskFieldId,
    customerName: r.customerName,
    siteAddress: r.siteAddress,
    siteCity: r.siteCity,
    scheduledStartAt: r.scheduledStartAt,
  }));
  return { ambiguous: true, count: items.length, items };
}

// ── D2-T5: on-demand status transitions (DEPARTED / ARRIVED / FINISHED) ─────
// SPEC §7. These are the three worker-triggered transitions from the "status
// update" menu (item 3) and from the D5-T3 free-text/voice intent
// `set_field_status`. WAITING_FOR_INFO and HAS_PROBLEM are NOT handled here —
// they flow through `writeMissingInfo` (D2-T7) and `writeProblem` (D2-T8),
// which stamp the additional context (note, problemType, etc.). The
// `transition` type is narrowed at the type level so a caller can never pass
// WAITING_FOR_INFO / HAS_PROBLEM here by accident.

export type AdvanceTransition = 'CONFIRM' | 'DEPARTED' | 'ARRIVED' | 'FINISHED';

// ── D2-T3: inspection card button-reply writes (CONFIRM/DECLINE/NEED_INFO) ──
// SPEC §6/§7. Three deterministic transitions triggered by the three buttons
// on the assignment card:
//   1 → CONFIRMED  + confirmedAt
//   2 → DECLINED   + declinedAt + declinedReason (+ office alert)
//   3 → NEEDS_MORE_INFO (+ follow-up note captured in fieldNotes + office alert)
// These are DIFFERENT from the on-demand DEPARTED/ARRIVED/FINISHED transitions
// in `advanceFieldStatus` — different columns are stamped and DECLINED requires
// a captured reason.

export interface ConfirmInspectionParams {
  taskFieldId: string;
  updatedBy: string;
}

/** §6 button 1 → CONFIRMED + confirmedAt. */
export async function confirmInspection(params: ConfirmInspectionParams): Promise<void> {
  const { taskFieldId, updatedBy } = params;
  await pool.query(
    `UPDATE "TaskField"
        SET "fieldStatus"     = 'CONFIRMED',
            "confirmedAt"     = now(),
            "updatedByUserId" = $2,
            "updatedAt"       = now()
      WHERE id = $1`,
    [taskFieldId, updatedBy],
  );
  log.info({ taskFieldId, updatedBy }, 'confirmInspection: CONFIRMED written');
}

export interface DeclineInspectionParams {
  taskFieldId: string;
  reason: string;
  updatedBy: string;
}

/** §6 button 2 → DECLINED + declinedAt + declinedReason. */
export async function declineInspection(params: DeclineInspectionParams): Promise<void> {
  const { taskFieldId, reason, updatedBy } = params;
  await pool.query(
    `UPDATE "TaskField"
        SET "fieldStatus"     = 'DECLINED',
            "declinedAt"      = now(),
            "declinedReason"  = $2,
            "updatedByUserId" = $3,
            "updatedAt"       = now()
      WHERE id = $1`,
    [taskFieldId, reason, updatedBy],
  );
  log.info({ taskFieldId, updatedBy }, 'declineInspection: DECLINED written');
}

export interface RequestMoreInfoParams {
  taskFieldId: string;
  note: string;
  updatedBy: string;
}

/**
 * §6 button 3 → NEEDS_MORE_INFO. The worker's follow-up text is persisted into
 * `fieldNotes` (no dedicated column exists on `TaskField` for assignment-time
 * questions; the field-notes column is the most natural home per the migration
 * comment "field notes + single inline problem"). Later flows that also write
 * `fieldNotes` (D2-T6 finished follow-up) may overwrite it — acceptable, since
 * the office has already been notified via the alert. `managerNotifiedAt` is
 * stamped so the durable write survives an outbound send failure.
 */
export async function requestMoreInfo(params: RequestMoreInfoParams): Promise<void> {
  const { taskFieldId, note, updatedBy } = params;
  await pool.query(
    `UPDATE "TaskField"
        SET "fieldStatus"       = 'NEEDS_MORE_INFO',
            "fieldNotes"        = $2,
            "managerNotifiedAt" = now(),
            "updatedByUserId"   = $3,
            "updatedAt"         = now()
      WHERE id = $1`,
    [taskFieldId, note, updatedBy],
  );
  log.info({ taskFieldId, updatedBy }, 'requestMoreInfo: NEEDS_MORE_INFO written');
}

/** §6 office alert on button 2 (DECLINED). Broadcast to every MANAGER/ADMIN. */
export async function notifyOfficeDeclined(taskFieldId: string, reason: string): Promise<void> {
  const ctx = await loadAlertContext(taskFieldId);
  if (!ctx) {
    log.warn({ taskFieldId }, 'notifyOfficeDeclined: TaskField not found');
    return;
  }
  const worker   = ctx.workerName    ?? '—';
  const family   = ctx.familyLabelHe ?? '—';
  const customer = ctx.customerName  ?? '—';
  const city     = ctx.siteCity      ? ` (${ctx.siteCity})` : '';
  const text =
    `בדיקה סורבה\n` +
    `${LABELS.WORKER}: ${worker} · ${LABELS.TYPE}: ${family} · ${LABELS.CUSTOMER}: ${customer}${city}\n` +
    `סיבה: ${reason}\n` +
    `יש לשבץ מחדש.`;
  await broadcastToManagers(text, taskFieldId);
}

/** §6 office alert on button 3 (NEEDS_MORE_INFO). Broadcast to every MANAGER/ADMIN. */
export async function notifyOfficeNeedsMoreInfo(taskFieldId: string, note: string): Promise<void> {
  const ctx = await loadAlertContext(taskFieldId);
  if (!ctx) {
    log.warn({ taskFieldId }, 'notifyOfficeNeedsMoreInfo: TaskField not found');
    return;
  }
  const worker   = ctx.workerName    ?? '—';
  const family   = ctx.familyLabelHe ?? '—';
  const customer = ctx.customerName  ?? '—';
  const city     = ctx.siteCity      ? ` (${ctx.siteCity})` : '';
  const text =
    `בקשת פרטים נוספים לבדיקה\n` +
    `${LABELS.WORKER}: ${worker} · ${LABELS.TYPE}: ${family} · ${LABELS.CUSTOMER}: ${customer}${city}\n` +
    `${note}\n` +
    `לטיפול המשרד.`;
  await broadcastToManagers(text, taskFieldId);
}

export interface AdvanceFieldStatusParams {
  taskFieldId: string;
  transition: AdvanceTransition;
  updatedBy: string;
}

/**
 * §7 write: advance `TaskField.fieldStatus` and stamp the matching timestamp.
 * FINISHED is UNCONDITIONAL — no guard on the current fieldStatus, per spec.
 * D5-T18: CONFIRM writes CONFIRMED + confirmedAt (mirrors the §6 button flow
 * `confirmInspection` — same column set, different entry point).
 */
export async function advanceFieldStatus(params: AdvanceFieldStatusParams): Promise<void> {
  const { taskFieldId, transition, updatedBy } = params;
  let sql: string;
  switch (transition) {
    case 'CONFIRM':
      sql =
        `UPDATE "TaskField"
            SET "fieldStatus"     = 'CONFIRMED',
                "confirmedAt"     = now(),
                "updatedByUserId" = $2,
                "updatedAt"       = now()
          WHERE id = $1`;
      break;
    case 'DEPARTED':
      sql =
        `UPDATE "TaskField"
            SET "fieldStatus"     = 'EN_ROUTE',
                "departedAt"      = now(),
                "updatedByUserId" = $2,
                "updatedAt"       = now()
          WHERE id = $1`;
      break;
    case 'ARRIVED':
      sql =
        `UPDATE "TaskField"
            SET "fieldStatus"     = 'ARRIVED',
                "arrivedAt"       = now(),
                "updatedByUserId" = $2,
                "updatedAt"       = now()
          WHERE id = $1`;
      break;
    case 'FINISHED':
      // Unconditional — no CHECK-current-status guard leaks in (spec §7).
      sql =
        `UPDATE "TaskField"
            SET "fieldStatus"     = 'FINISHED_FIELD',
                "finishedAt"      = now(),
                "updatedByUserId" = $2,
                "updatedAt"       = now()
          WHERE id = $1`;
      break;
  }
  await pool.query(sql, [taskFieldId, updatedBy]);
  log.info({ taskFieldId, transition, updatedBy }, 'advanceFieldStatus written');
}

// ── D2-T6: finished follow-up option 2 — free-text notes ────────────────────

export interface WriteFieldNotesParams {
  taskFieldId: string;
  notes: string;
  updatedBy: string;
}

/**
 * §7 finished-follow-up option 2: capture the worker's free-text notes into
 * `TaskField.fieldNotes`. Does NOT touch `fieldStatus` — the inspection is
 * already FINISHED_FIELD from `advanceFieldStatus({ transition:'FINISHED' })`.
 */
export async function writeFieldNotes(params: WriteFieldNotesParams): Promise<void> {
  const { taskFieldId, notes, updatedBy } = params;
  await pool.query(
    `UPDATE "TaskField"
        SET "fieldNotes"      = $2,
            "updatedByUserId" = $3,
            "updatedAt"       = now()
      WHERE id = $1`,
    [taskFieldId, notes, updatedBy],
  );
  log.info({ taskFieldId, updatedBy }, 'writeFieldNotes written');
}

// ── D2-T5: disambiguation by free-text hint (customer name / site address) ──

export type ResolveOpenTaskFieldResult =
  | { taskFieldId: string; customerName: string | null; taskTitle: string | null }
  | { ambiguous: true; count: number }
  | null;

/**
 * Resolve the worker's open TaskField from a free-text hint (customer name OR
 * site address). Used by the disambig awaiting states (`status_disambig`,
 * `missing_info_disambig`, `problem_disambig`) — after the initial menu tap
 * revealed >1 open TaskField, the worker types a hint and we pick one.
 *
 * Matching is ILIKE substring, case-insensitive, on `Customer.name` OR
 * `TaskField.siteAddress`. The parameter is bound once (`$2`) and re-used in
 * both branches of the OR — no string concatenation of user input.
 */
export async function resolveOpenTaskFieldByHint(
  userId: string,
  hint: string,
): Promise<ResolveOpenTaskFieldResult> {
  const trimmed = hint.trim();
  if (!trimmed) return null;
  const result = await pool.query<{ taskFieldId: string; customerName: string | null; taskTitle: string | null }>(
    `SELECT tf.id            AS "taskFieldId",
            -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
            COALESCE(
              c.name,
              l."fullName",
              NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
              l.company,
              p.client,
              il."fromName"
            )                AS "customerName",
            t.title          AS "taskTitle"
       FROM "TaskField" tf
       JOIN "Task"           t  ON t.id  = tf."taskId"
       LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
       LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
       LEFT JOIN "Project"      p  ON p.id  = t."projectId"
       LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
      WHERE t."ownerId"      = $1
        AND tf."fieldStatus" = ANY($3::text[])
        AND (
              c.name           ILIKE '%' || $2 || '%'
           OR tf."siteAddress" ILIKE '%' || $2 || '%'
        )
      ORDER BY tf."assignedAt"`,
    [userId, trimmed, OPEN_FIELD_STATUSES],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount === 1) {
    return {
      taskFieldId: result.rows[0].taskFieldId,
      customerName: result.rows[0].customerName,
      taskTitle: result.rows[0].taskTitle,
    };
  }
  return { ambiguous: true, count: result.rowCount ?? result.rows.length };
}

/**
 * Format the ambiguous-disambig preview list for the worker. Numbered rows of
 * `{customer} — {address}[, {city}][ · {HH:MM}]`. Empty fields collapse
 * gracefully so a row is never just "1. —". Pure — safe to unit-test.
 */
export function formatOpenTaskFieldPreview(items: OpenTaskFieldPreview[]): string {
  return items
    .map((it, idx) => {
      const parts: string[] = [];
      const name = (it.customerName ?? '').trim();
      parts.push(name.length > 0 ? name : 'לקוח לא ידוע');
      const addrBits: string[] = [];
      if (it.siteAddress && it.siteAddress.trim()) addrBits.push(it.siteAddress.trim());
      if (it.siteCity && it.siteCity.trim()) addrBits.push(it.siteCity.trim());
      if (addrBits.length > 0) parts.push(addrBits.join(', '));
      let row = `${idx + 1}. ${parts.join(' — ')}`;
      if (it.scheduledStartAt) {
        const hhmm = new Intl.DateTimeFormat('he-IL', {
          timeZone: 'Asia/Jerusalem',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(it.scheduledStartAt);
        row += ` · ${hhmm}`;
      }
      return row;
    })
    .join('\n');
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
            -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
            COALESCE(
              c.name,
              l."fullName",
              NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
              l.company,
              p.client,
              il."fromName"
            )                   AS "customerName",
            tf."siteCity"       AS "siteCity",
            tf."missingReportInfoNote" AS "missingReportInfoNote",
            tf."problemType"    AS "problemType",
            tf."problemNote"    AS "problemNote"
       FROM "TaskField" tf
       JOIN "Task"           t  ON t.id  = tf."taskId"
       JOIN "InspectionType" it ON it.id = tf."inspectionTypeId"
       LEFT JOIN "User"          u  ON u.id  = t."ownerId"
       LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
       LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
       LEFT JOIN "Project"      p  ON p.id  = t."projectId"
       LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
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
    `${LABELS.WORKER}: ${worker} · ${LABELS.TYPE}: ${family} · ${LABELS.CUSTOMER}: ${customer}${city}\n` +
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

// ── D2-T10: on-demand day summary (menu item 7) ─────────────────────────────
// SPEC_FIELD_V2 §11. Thin wrapper delegating to the read query in
// `inspectionsQueries.ts`. Kept as a service-layer entry point so the router
// stays consistent with the other worker flows (all writes/reads live behind
// `services/inspections.ts` from the router's perspective).

/**
 * Load today's field summary for a worker — the FINISHED_FIELD row list + the
 * WAITING_FOR_INFO count. No writes; no `FieldWorkerDayClose` row (deferred
 * per spec §14, out of scope for D2-T10).
 */
export async function dayFieldSummary(
  userId: string,
  localDate: string,
): Promise<DayFieldSummary> {
  return getFieldSummaryForWorkerOnDate(userId, localDate);
}

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
    `${LABELS.WORKER}: ${worker} · ${LABELS.TYPE}: ${family} · ${LABELS.CUSTOMER}: ${customer}${city}\n` +
    `סוג בעיה: ${typeHe}${detail}\n` +
    `לטיפול מנהל.`;
  await broadcastToManagers(text, taskFieldId);
}

// ── D2-T9: equipment reminder — missing-equipment alert to managers ─────────
// SPEC_FIELD_V2 §10. The equipment reminder is NOT scoped to a specific
// TaskField (a worker with 2 inspections gets ONE consolidated equipment list
// and one alert covering both), so this alert takes a userId + free-text note
// and looks up the worker name from `User` directly — bypassing the
// `loadAlertContext` TaskField lookup used by §8/§9.

/**
 * Broadcast a Hebrew alert to every active MANAGER/ADMIN: worker reported
 * they are missing equipment for today's inspections. No `TaskField` context
 * is written — the equipment reminder is a per-worker daily roll-up, not a
 * per-inspection event. If no manager is configured we log a warning and
 * no-op (the note is not persisted on the worker's TaskField either, so
 * there's nothing durable to reference — matches the §10 spec).
 */
export async function notifyOfficeMissingEquipment(input: {
  userId: string;
  userName: string | null;
  note: string;
  localDate: string;
}): Promise<void> {
  const { userId, userName, note, localDate } = input;
  const worker = userName ?? '—';
  const text =
    `חסר ציוד לבוקר\n` +
    `${LABELS.WORKER}: ${worker}\n` +
    `${LABELS.DATE}: ${localDate}\n` +
    `${note}\n` +
    `לטיפול המשרד.`;
  const managers = await getManagersForBroadcast();
  if (managers.length === 0) {
    log.warn(
      { userId },
      'notifyOfficeMissingEquipment: no MANAGER/ADMIN with a phone; alert not sent',
    );
    return;
  }
  await Promise.allSettled(
    managers.map((m) =>
      sendTextMessage({ to: m.phone, text }).catch((err) => {
        log.error({ err, userId, managerId: m.id }, 'missing-equipment alert send failed');
      }),
    ),
  );
}
