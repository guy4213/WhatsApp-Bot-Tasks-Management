/**
 * D2-T15 — Pre-inspection 60-minute reminder.
 *
 * A worker receives a WhatsApp reminder ~60 min before their scheduled
 * inspection so they can prepare and leave on time.
 *
 * Polling entry: `runPreInspectionReminderPoll` (called by the scheduler job).
 * Query: `findDuePreReminders` — rows where `preReminderSentAt IS NULL` and
 *   `scheduledStartAt` falls in the next 60 minutes.
 * Formatter: `formatPreReminderCard` — produces the reminder body text.
 * Send + stamp: `sendAndStampPreReminder` — mirrors `sendAndStampAssignmentCard`
 *   in `services/inspectionAssignment.ts`: send first, stamp only on success.
 *
 * Button payload IDs (also parsed by the router):
 *   PREREMIND_DEPART_<taskFieldId>    → worker is departing (EN_ROUTE)
 *   PREREMIND_NEED_INFO_<taskFieldId> → worker needs more info
 *   PREREMIND_PROBLEM_<taskFieldId>   → worker has a problem to report
 *
 * D5-T4 policy: `sendButtonMessage` is used here (one of the allowed surfaces).
 */
import { pool } from '../db/connection';
import { sendButtonMessage } from '../whatsapp/sender';
import { moduleLogger } from '../utils/logger';
import { formatShortDateTimeIL } from '../ai/inspectionFormatters';

const log = moduleLogger('preInspectionReminder');

// ── Payload IDs (source of truth; also parsed by router) ─────────────────────

export function preReminderDepartPayloadId(taskFieldId: string): string {
  return `PREREMIND_DEPART_${taskFieldId}`;
}
export function preReminderNeedInfoPayloadId(taskFieldId: string): string {
  return `PREREMIND_NEED_INFO_${taskFieldId}`;
}
export function preReminderProblemPayloadId(taskFieldId: string): string {
  return `PREREMIND_PROBLEM_${taskFieldId}`;
}

// ── Row shape ─────────────────────────────────────────────────────────────────

export interface DuePreReminderRow {
  taskFieldId: string;
  scheduledStartAt: Date;
  siteAddress: string | null;
  siteCity: string | null;
  fieldContactName: string | null;
  fieldContactPhone: string | null;
  family: string;
  typeLabelHe: string;
  workerId: string;
  workerName: string | null;
  workerPhone: string;
  customerName: string | null;
  taskTitle: string | null;
}

/**
 * Return `TaskField` rows that are due for a pre-inspection reminder:
 * - `preReminderSentAt IS NULL` (not yet sent)
 * - `scheduledStartAt` is in the future but within 60 minutes
 * - `fieldStatus` is ASSIGNED, CONFIRMED, or NEEDS_MORE_INFO (worker not yet departed)
 * - `Task.ownerId` is set and the User has a phone
 *
 * Customer name uses the same 6-source COALESCE as `findUnnotifiedTaskFields`
 * (per SCHEMA_CRM.md).
 */
export async function findDuePreReminders(limit = 50): Promise<DuePreReminderRow[]> {
  const { rows } = await pool.query<DuePreReminderRow>(
    `SELECT
       tf.id                AS "taskFieldId",
       tf."scheduledStartAt",
       tf."siteAddress",
       tf."siteCity",
       tf."fieldContactName",
       tf."fieldContactPhone",
       tf.family,
       it."labelHe"         AS "typeLabelHe",
       u.id                 AS "workerId",
       u.name               AS "workerName",
       u.phone              AS "workerPhone",
       COALESCE(
         c.name,
         l."fullName",
         NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
         l.company,
         p.client,
         il."fromName"
       )                    AS "customerName",
       t.title              AS "taskTitle"
     FROM "TaskField" tf
     JOIN "Task" t                ON t.id  = tf."taskId"
     JOIN "InspectionType" it     ON it.id = tf."inspectionTypeId"
     LEFT JOIN "Customer" c       ON c.id  = t."customerId"
     LEFT JOIN "Lead" l           ON l.id  = t."leadId"
     LEFT JOIN "Project" p        ON p.id  = t."projectId"
     LEFT JOIN "IncomingLead" il  ON il.id = t."incomingLeadId"
     LEFT JOIN "User" u           ON u.id  = t."ownerId"
     WHERE tf."preReminderSentAt" IS NULL
       AND tf."scheduledStartAt" > now()
       AND tf."scheduledStartAt" <= now() + interval '60 minutes'
       AND tf."fieldStatus" IN ('ASSIGNED', 'CONFIRMED', 'NEEDS_MORE_INFO')
       AND t."ownerId" IS NOT NULL
       AND u.phone IS NOT NULL
       AND u.phone <> ''
     ORDER BY tf."scheduledStartAt" ASC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

// ── Message formatter ─────────────────────────────────────────────────────────

/**
 * Format the pre-inspection 60-minute reminder body.
 *
 * Time is rendered via `formatShortDateTimeIL` (Intl-based, Asia/Jerusalem)
 * — never via raw `.getHours()` to avoid server-TZ bugs.
 */
export function formatPreReminderCard(row: DuePreReminderRow): string {
  const customerName = row.customerName?.trim() || 'לקוח לא ידוע';
  const addressParts = [row.siteAddress, row.siteCity].filter(Boolean);
  const address = addressParts.length > 0 ? addressParts.join(', ') : 'כתובת לא ידועה';

  // formatShortDateTimeIL returns "DD/MM בשעה HH:MM" — extract time portion
  const dateTimeStr = formatShortDateTimeIL(row.scheduledStartAt);
  // Extract just HH:MM from the output (after "בשעה ")
  const timeMatch = dateTimeStr.match(/(\d{2}:\d{2})$/);
  const time = timeMatch ? timeMatch[1] : dateTimeStr;

  const contactParts = [row.fieldContactName, row.fieldContactPhone].filter(Boolean);
  const contact = contactParts.length > 0 ? contactParts.join(', ') : 'לא צוין';

  const lines: string[] = [
    'תזכורת בדיקה קרובה',
    '',
    'בעוד שעה יש לך בדיקה:',
    `סוג בדיקה: ${row.typeLabelHe}`,
    `לקוח: ${customerName}`,
    `כתובת: ${address}`,
    `שעה: ${time}`,
    `איש קשר: ${contact}`,
  ];
  return lines.join('\n');
}

// ── Send + stamp ──────────────────────────────────────────────────────────────

/**
 * Send a single pre-inspection reminder for a `TaskField` row, then stamp
 * `preReminderSentAt`. The stamp is written ONLY after the send resolves so
 * a send failure lets the next tick retry.
 *
 * Throws on send failure — do NOT stamp (retryable on next tick).
 */
export async function sendAndStampPreReminder(row: DuePreReminderRow): Promise<void> {
  const body = formatPreReminderCard(row);

  await sendButtonMessage({
    to: row.workerPhone,
    body,
    buttons: [
      { id: preReminderDepartPayloadId(row.taskFieldId),  title: 'יוצא בזמן' },
      { id: preReminderNeedInfoPayloadId(row.taskFieldId), title: 'צריך פרטים' },
      { id: preReminderProblemPayloadId(row.taskFieldId),  title: 'יש בעיה' },
    ],
  });

  const stamped = await pool.query(
    `UPDATE "TaskField"
        SET "preReminderSentAt" = now(),
            "updatedAt"         = now()
      WHERE id = $1
        AND "preReminderSentAt" IS NULL`,
    [row.taskFieldId],
  );
  if ((stamped.rowCount ?? 0) === 0) {
    log.warn({ taskFieldId: row.taskFieldId }, 'preReminderSentAt already stamped by another instance');
  } else {
    log.info({ taskFieldId: row.taskFieldId, workerId: row.workerId }, 'pre-reminder sent + preReminderSentAt stamped');
  }
}

/**
 * Polling entry. Load rows due for a pre-inspection reminder and send each one.
 * Per-row failures are logged and do not stop the rest of the batch — the
 * failed row's `preReminderSentAt` remains NULL so the next tick retries.
 */
export async function runPreInspectionReminderPoll(): Promise<void> {
  const rows = await findDuePreReminders();
  if (rows.length === 0) return;
  log.info({ count: rows.length }, 'pre-reminder polling — due rows');
  for (const row of rows) {
    try {
      await sendAndStampPreReminder(row);
    } catch (err) {
      log.error({ err, taskFieldId: row.taskFieldId }, 'pre-reminder send failed; will retry next tick');
    }
  }
}
