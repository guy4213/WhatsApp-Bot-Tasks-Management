/**
 * D2-T2 + D5-T6 — inspection-card emission for newly-created `TaskField` rows.
 *
 * Runs as a polling job (see `src/scheduler/jobs/assignmentCardNotifier.ts`).
 * For every `TaskField` where `workerNotifiedAt IS NULL`, load the full context
 * (worker + customer + inspection type + equipment checklist + site metadata),
 * render the §6 inspection card, and send it via `sendButtonMessage` with the
 * three deterministic reply-button payload IDs (`INSP_CONFIRM_<uuid>`,
 * `INSP_DECLINE_<uuid>`, `INSP_NEED_INFO_<uuid>`). After a successful send,
 * stamp `workerNotifiedAt` so subsequent polls skip the row.
 *
 * K2: the CRM field-scheduling form creates the `TaskField` row using an
 * existing `Task ID`. `Task.ownerId` identifies the assigned worker (verified
 * against `src/services/tasks.ts:192` and `src/auth/permissions.ts:61`).
 * `scheduledStartAt` is the planned inspection start time (D1-T5).
 *
 * D5-T4 policy: this is one of the two `sendButtonMessage` surfaces (the other
 * is the D2-T9 equipment reminder). Every other menu is numbered text.
 */
import { pool } from '../db/connection';
import { sendButtonMessage } from '../whatsapp/sender';
import { moduleLogger } from '../utils/logger';
import { LABELS, PLACEHOLDERS } from '../ai/inspectionFormatters';

const log = moduleLogger('inspectionAssignment');

// ── Payload IDs (also parsed by the router; kept here as the source of truth) ─
export function inspectionConfirmPayloadId(taskFieldId: string): string {
  return `INSP_CONFIRM_${taskFieldId}`;
}
export function inspectionDeclinePayloadId(taskFieldId: string): string {
  return `INSP_DECLINE_${taskFieldId}`;
}
export function inspectionNeedInfoPayloadId(taskFieldId: string): string {
  return `INSP_NEED_INFO_${taskFieldId}`;
}

// ── Row shape returned by `findUnnotifiedTaskFields` ─────────────────────────

export interface UnnotifiedTaskFieldRow {
  taskFieldId: string;
  workerId: string | null;
  workerPhone: string | null;
  workerName: string | null;
  customerName: string | null;
  taskTitle?: string | null;  // optional: present when a display label hint is needed
  siteAddress: string | null;
  siteCity: string | null;
  fieldContactName: string | null;
  fieldContactPhone: string | null;
  navigationUrl: string | null;
  specialInstructions: string | null;
  scheduledStartAt: Date;
  family: string;
  typeLabelHe: string;
}

/**
 * Load every `TaskField` where `workerNotifiedAt IS NULL`, joined with the
 * assignee (`Task.ownerId → User`), customer, and inspection type. Rows with
 * no assigned worker (`Task.ownerId IS NULL`) are excluded — the CRM form
 * validates that Task.ownerId exists before creation (K2 spec), but the guard
 * keeps the sender safe if a stray row slips through.
 */
export async function findUnnotifiedTaskFields(limit = 50): Promise<UnnotifiedTaskFieldRow[]> {
  const { rows } = await pool.query<UnnotifiedTaskFieldRow>(
    `SELECT
       tf.id                       AS "taskFieldId",
       u.id                        AS "workerId",
       u.phone                     AS "workerPhone",
       u.name                      AS "workerName",
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
       tf."navigationUrl"          AS "navigationUrl",
       tf."specialInstructions"    AS "specialInstructions",
       tf."scheduledStartAt"       AS "scheduledStartAt",
       tf.family                   AS family,
       it."labelHe"                AS "typeLabelHe"
     FROM "TaskField" tf
     JOIN "Task" t             ON t.id  = tf."taskId"
     JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
     JOIN "User" u             ON u.id  = t."ownerId"
     LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
     LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
     LEFT JOIN "Project"      p  ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
     WHERE tf."workerNotifiedAt" IS NULL
     ORDER BY tf."assignedAt" ASC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Load the equipment checklist labels for a family (deduped by labelHe). */
export async function getEquipmentLabels(family: string): Promise<string[]> {
  const { rows } = await pool.query<{ labelHe: string }>(
    `SELECT "labelHe"
       FROM "InspectionChecklist"
      WHERE family = $1
      ORDER BY "sortOrder" ASC`,
    [family],
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (seen.has(r.labelHe)) continue;
    seen.add(r.labelHe);
    out.push(r.labelHe);
  }
  return out;
}

// ── §6 card body ─────────────────────────────────────────────────────────────

// Alignment helper — right-pad "label:" to 14 chars
const pad = (lbl: string) => `${lbl}:`.padEnd(14);

// Null-safe fallback helper for the assignment card
const orPlaceholder = (v: string | null | undefined, p: string): string =>
  (v != null && v.trim().length > 0) ? v : p;

/**
 * Format the SPEC_FIELD_V2 §6 inspection card body.
 *
 * Customer and address always show with descriptive labels (if null, show
 * explicit Hebrew placeholder so the worker isn't confused by a missing line).
 * Contact and navigation are optional — omitted when null (worker has no
 * expectation that those lines exist on every card).
 *
 * `scheduledStartAt` is rendered as two separate labeled lines per §6 spec.
 */
export function formatInspectionCard(
  row: UnnotifiedTaskFieldRow,
  equipmentLabels: string[],
): string {
  const lines: string[] = [
    'שובצה לך בדיקה חדשה.',
    '',
    `${pad(LABELS.TYPE)}${row.typeLabelHe}`,
    `${pad(LABELS.CUSTOMER)}${orPlaceholder(row.customerName, PLACEHOLDERS.CUSTOMER)}`,
  ];

  const address =
    row.siteAddress && row.siteCity ? `${row.siteAddress}, ${row.siteCity}`
    : row.siteAddress ? row.siteAddress
    : row.siteCity ? row.siteCity
    : null;
  lines.push(`${pad(LABELS.ADDRESS)}${address ?? PLACEHOLDERS.ADDRESS}`);

  const { dateHe, timeHe } = formatJerusalemDateTime(row.scheduledStartAt);
  lines.push(`${pad(LABELS.DATE)}${dateHe}`);
  lines.push(`${pad(LABELS.TIME)}${timeHe}`);

  if (row.fieldContactName || row.fieldContactPhone) {
    const contact = [row.fieldContactName, row.fieldContactPhone].filter(Boolean).join(', ');
    lines.push(`${pad(LABELS.CONTACT)}${contact}`);
  }

  if (equipmentLabels.length > 0) {
    lines.push('', `${LABELS.EQUIPMENT}:`);
    for (const l of equipmentLabels) lines.push(`- ${l}`);
  }

  if (row.navigationUrl) lines.push('', `${LABELS.NAV}: ${row.navigationUrl}`);
  if (row.specialInstructions) lines.push('', row.specialInstructions);

  lines.push(
    '',
    'בחר:',
    '1. מאשר',
    '2. לא יכול להגיע',
    '3. צריך פרטים נוספים',
  );
  return lines.join('\n');
}

function formatJerusalemDateTime(d: Date | string): { dateHe: string; timeHe: string } {
  const date = new Date(d);
  const dateHe = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(date).replace(/\//g, '.');
  const timeHe = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
  return { dateHe, timeHe };
}

// ── Send + stamp ─────────────────────────────────────────────────────────────

/**
 * Send a single assignment card for a `TaskField` row, then stamp
 * `workerNotifiedAt`. The stamp is written ONLY after the send resolves so
 * a send failure lets the next tick retry.
 *
 * Concurrent instances are guarded by the scheduler's advisory lock, so no
 * additional per-row claim is needed.
 */
export async function sendAndStampAssignmentCard(row: UnnotifiedTaskFieldRow): Promise<void> {
  if (!row.workerPhone) {
    log.warn({ taskFieldId: row.taskFieldId, workerId: row.workerId }, 'worker has no phone; skipping card');
    return;
  }
  const equipmentLabels = await getEquipmentLabels(row.family);
  const body = formatInspectionCard(row, equipmentLabels);

  await sendButtonMessage({
    to: row.workerPhone,
    body,
    buttons: [
      { id: inspectionConfirmPayloadId(row.taskFieldId),  title: '1. מאשר' },
      { id: inspectionDeclinePayloadId(row.taskFieldId),  title: '2. לא יכול' },
      { id: inspectionNeedInfoPayloadId(row.taskFieldId), title: '3. פרטים' },
    ],
  });

  const stamped = await pool.query(
    `UPDATE "TaskField"
        SET "workerNotifiedAt" = now(),
            "updatedAt"        = now()
      WHERE id = $1
        AND "workerNotifiedAt" IS NULL`,
    [row.taskFieldId],
  );
  if ((stamped.rowCount ?? 0) === 0) {
    log.warn({ taskFieldId: row.taskFieldId }, 'workerNotifiedAt already stamped by another instance');
  } else {
    log.info({ taskFieldId: row.taskFieldId, workerId: row.workerId }, 'assignment card sent + workerNotifiedAt stamped');
  }
}

/**
 * D5-T6 polling entry. Load unnotified `TaskField` rows and send each one.
 * A per-row failure is logged and does not stop the rest of the batch — the
 * failed row's `workerNotifiedAt` is untouched so the next tick retries.
 */
export async function runInspectionAssignmentPoll(): Promise<void> {
  const rows = await findUnnotifiedTaskFields();
  if (rows.length === 0) return;
  log.info({ count: rows.length }, 'assignment-card polling — unnotified TaskFields');
  for (const row of rows) {
    try {
      await sendAndStampAssignmentCard(row);
    } catch (err) {
      log.error({ err, taskFieldId: row.taskFieldId }, 'assignment-card send failed; will retry next tick');
    }
  }
}
