/**
 * Customer-facing WhatsApp notifications triggered by TaskField state changes.
 * First user: WORKER_EN_ROUTE — the customer is notified via the approved
 * `customer_worker_en_route` UTILITY template when the assigned worker flips
 * `TaskField.fieldStatus` to EN_ROUTE (spec §7 / `advanceFieldStatus` DEPARTED).
 *
 * Design constraints:
 *  - Fire-and-forget from `advanceFieldStatus` — a failed customer notification
 *    must NEVER roll back or delay the worker's status update. Every failure
 *    path is caught, logged, audit-stamped, and (when possible) surfaced back
 *    to the worker as a freeform "please call manually" message.
 *  - Recipient resolution with fallback (per product decision):
 *      phone → TaskField.fieldContactPhone → Customer.phone
 *      name  → TaskField.fieldContactName  → Customer.name
 *  - Inspection label resolution: TaskField.appointmentTitle (when non-empty)
 *    → FAMILY_LABELS[family] mapping → 'בדיקה'. Never the raw מק"ט code.
 *  - Dedup via `WhatsappCustomerNotification` (migration 012) — UNIQUE
 *    (taskFieldId, notificationType). INSERT-first pattern (the row is
 *    written as SENT before the send attempt; updated to FAILED on error).
 *    Guarantees at most one customer notification per TaskField per type,
 *    even if the worker taps "יצאתי" twice or the router replays the intent.
 *  - Gated by `CUSTOMER_NOTIFICATIONS_ENABLED='true'`; off by default so the
 *    feature can be toggled without a redeploy.
 *  - Worker feedback is freeform (in-window — the worker just interacted with
 *    the bot), no template required.
 */
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';
import { notify, type NotifyArgs } from '../whatsapp/templates';
import { sendTextMessage } from '../whatsapp/sender';
import { writeAuditLog } from '../utils/auditLog';
import { getActiveTrackingToken, buildTrackingUrl } from './trackingLink';
import { templateName, DEFAULT_TEMPLATE_NAMES } from '../whatsapp/templateNames';

const log = moduleLogger('customerNotifications');

const COMPANY_NAME = 'גלית - החברה לאיכות הסביבה';

type Family =
  | 'radiation' | 'noise' | 'radon' | 'air' | 'asbestos' | 'water'
  | 'odor' | 'soil' | 'occupational' | 'thermal' | 'green' | 'opinion' | 'general';

/** Family-code → customer-facing Hebrew label. Kept intentionally short —
 *  the `InspectionType.labelHe` (מק"ט description) is too verbose for a
 *  customer-facing message. */
export const FAMILY_LABELS: Record<Family, string> = {
  radiation:    'בדיקת קרינה',
  noise:        'בדיקת רעש',
  radon:        'בדיקת ראדון',
  air:          'בדיקת איכות אוויר',
  asbestos:     'בדיקת אסבסט',
  water:        'בדיקת מים',
  odor:         'בדיקת ריח',
  soil:         'בדיקת קרקע',
  occupational: 'בדיקת גהות',
  thermal:      'בדיקה תרמית',
  green:        'ייעוץ בנייה ירוקה',
  opinion:      'ייעוץ מקצועי',
  general:      'בדיקה',
};

export type CustomerNotificationType = 'WORKER_EN_ROUTE';

export interface NotificationContext {
  recipientName: string | null;
  recipientPhone: string | null;
  workerName: string | null;
  workerPhone: string | null;
  family: Family | null;
  appointmentTitle: string | null;
}

/**
 * Load recipient + worker + inspection metadata for a TaskField, applying the
 * spec fallbacks (fieldContact → Customer). Empty strings are treated as NULL.
 */
export async function loadNotificationContext(
  taskFieldId: string,
): Promise<NotificationContext | null> {
  const { rows } = await pool.query<NotificationContext>(
    `SELECT COALESCE(NULLIF(TRIM(tf."fieldContactName"),  ''), c.name)  AS "recipientName",
            COALESCE(NULLIF(TRIM(tf."fieldContactPhone"), ''), c.phone) AS "recipientPhone",
            u.name                                                     AS "workerName",
            u.phone                                                    AS "workerPhone",
            tf.family::text                                            AS family,
            tf."appointmentTitle"                                      AS "appointmentTitle"
       FROM "TaskField" tf
       JOIN "Task"          t ON t.id = tf."taskId"
       LEFT JOIN "User"     u ON u.id = t."ownerId"
       LEFT JOIN "Customer" c ON c.id = t."customerId"
      WHERE tf.id = $1`,
    [taskFieldId],
  );
  return rows[0] ?? null;
}

/** INSERT-first dedup: returns true iff we won the race and should send now. */
async function claimCustomerNotification(
  taskFieldId: string,
  notificationType: CustomerNotificationType,
  recipientPhone: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO "WhatsappCustomerNotification"
       ("taskFieldId", "notificationType", "recipientPhone", status)
     VALUES ($1, $2, $3, 'SENT')
     ON CONFLICT ("taskFieldId", "notificationType") DO NOTHING`,
    [taskFieldId, notificationType, recipientPhone],
  );
  return (rowCount ?? 0) > 0;
}

async function markCustomerNotificationFailed(
  taskFieldId: string,
  notificationType: CustomerNotificationType,
  errorMessage: string,
): Promise<void> {
  await pool.query(
    `UPDATE "WhatsappCustomerNotification"
        SET status = 'FAILED', "errorMessage" = $3
      WHERE "taskFieldId" = $1 AND "notificationType" = $2`,
    [taskFieldId, notificationType, errorMessage.slice(0, 500)],
  );
}

async function stampWorkerFeedback(
  taskFieldId: string,
  notificationType: CustomerNotificationType,
): Promise<void> {
  await pool.query(
    `UPDATE "WhatsappCustomerNotification"
        SET "workerFeedbackSentAt" = now()
      WHERE "taskFieldId" = $1 AND "notificationType" = $2`,
    [taskFieldId, notificationType],
  );
}

function isEnabled(): boolean {
  return process.env.CUSTOMER_NOTIFICATIONS_ENABLED === 'true';
}

/** Pick the customer-facing inspection label — appointmentTitle if the
 *  scheduler filled it in, otherwise the compact family label, otherwise
 *  a generic fallback. Never the raw מק"ט. */
export function resolveInspectionLabel(ctx: NotificationContext): string {
  if (ctx.appointmentTitle && ctx.appointmentTitle.trim().length > 0) {
    return ctx.appointmentTitle.trim();
  }
  if (ctx.family && ctx.family in FAMILY_LABELS) {
    return FAMILY_LABELS[ctx.family];
  }
  return 'בדיקה';
}

function buildFallbackText(
  recipientName: string,
  workerName: string,
  inspectionLabel: string,
  workerPhone: string | null,
  trackingUrl?: string | null,
): string {
  const base =
    `שלום ${recipientName}!\n\n` +
    `${workerName} מ־${COMPANY_NAME} יצא לדרך אליך לביצוע ${inspectionLabel}.\n\n` +
    `לפניות ישירות לבודק: ${workerPhone ?? ''}\n\n` +
    `בהצלחה!`;
  if (trackingUrl) {
    return `${base}\n\nלצפייה במיקום הבודק ובזמן הגעה משוער:\n${trackingUrl}`;
  }
  return base;
}

/**
 * Send the WORKER_EN_ROUTE customer notification + worker feedback follow-up.
 * Never throws — safe to call fire-and-forget from `advanceFieldStatus`.
 */
export async function sendWorkerEnRouteNotification(
  taskFieldId: string,
  workerUserId: string,
): Promise<void> {
  if (!isEnabled()) {
    log.debug({ taskFieldId }, 'CUSTOMER_NOTIFICATIONS_ENABLED!=true — skipped');
    return;
  }

  let ctx: NotificationContext | null;
  try {
    ctx = await loadNotificationContext(taskFieldId);
  } catch (err) {
    log.error({ err, taskFieldId }, 'loadNotificationContext failed');
    return;
  }
  if (!ctx) {
    log.warn({ taskFieldId }, 'TaskField not found for customer notification');
    return;
  }

  const workerName = ctx.workerName ?? 'הבודק';
  const workerPhone = ctx.workerPhone;
  const recipientName = ctx.recipientName ?? 'שלום';
  const recipientPhone = ctx.recipientPhone?.trim() ?? '';
  const inspectionLabel = resolveInspectionLabel(ctx);

  // No customer phone at all — tell the worker to call manually. No template
  // send. Still records a FAILED dedup row so a retry with the same intent
  // doesn't re-nag the worker.
  if (recipientPhone.length === 0) {
    const claimed = await claimCustomerNotification(taskFieldId, 'WORKER_EN_ROUTE', '');
    if (!claimed) return; // already handled
    await markCustomerNotificationFailed(taskFieldId, 'WORKER_EN_ROUTE', 'no customer phone');
    await auditCustomerNotification(taskFieldId, workerUserId, '', 'FAILED', 'no customer phone');
    await sendWorkerFeedback(
      workerPhone,
      `⚠️ אין ללקוח ${recipientName} מספר טלפון במערכת. אנא צור קשר ידני.`,
      taskFieldId,
    );
    log.info({ taskFieldId }, 'Customer EN_ROUTE notification skipped — no phone');
    return;
  }

  const claimed = await claimCustomerNotification(taskFieldId, 'WORKER_EN_ROUTE', recipientPhone);
  if (!claimed) {
    log.info({ taskFieldId }, 'Customer EN_ROUTE notification already sent — skipped');
    return;
  }

  // Best-effort tracking link — never blocks or fails the notification.
  const token = await getActiveTrackingToken(taskFieldId);
  const trackingUrl = token ? buildTrackingUrl(token) : null;
  if (!trackingUrl) {
    log.info({ taskFieldId }, 'tracking link unavailable — sent without link');
  }

  // The still-approved `customer_worker_en_route` template (v1) is body-only:
  // 4 vars, no BUTTONS component. Until an operator explicitly points
  // WHATSAPP_TEMPLATE_CUSTOMER_WORKER_EN_ROUTE at the new `_v2` template
  // (same body + a URL button) once Meta approves it, the OUT-OF-WINDOW
  // template path must never send a buttonParams payload against the v1
  // template — Meta rejects a component-count mismatch. Mirrors the
  // legacy-template guard in `dueDateReminder.ts`.
  const usingLegacyTemplate =
    templateName('CUSTOMER_WORKER_EN_ROUTE') === DEFAULT_TEMPLATE_NAMES.CUSTOMER_WORKER_EN_ROUTE;

  const notifyArgs: NotifyArgs = {
    to: recipientPhone,
    key: 'CUSTOMER_WORKER_EN_ROUTE',
    bodyParams: [recipientName, workerName, inspectionLabel, workerPhone ?? ''],
    fallbackText: buildFallbackText(recipientName, workerName, inspectionLabel, workerPhone, trackingUrl),
  };
  if (trackingUrl && token && !usingLegacyTemplate) {
    notifyArgs.templateButtonParams = [{ subType: 'url', index: 0, payload: token }];
  }

  try {
    await notify(notifyArgs);
    if (trackingUrl) {
      log.info({ taskFieldId }, 'customer tracking link sent');
    }
    await auditCustomerNotification(taskFieldId, workerUserId, recipientPhone, 'SUCCESS');
    await sendWorkerFeedback(
      workerPhone,
      `✅ הלקוח ${recipientName} עודכן בוואטסאפ שאתה בדרך.`,
      taskFieldId,
    );
    log.info({ taskFieldId, recipientPhone }, 'Customer EN_ROUTE notification sent');
  } catch (err) {
    const errorMessage = (err as Error).message ?? 'unknown error';
    await markCustomerNotificationFailed(taskFieldId, 'WORKER_EN_ROUTE', errorMessage);
    await auditCustomerNotification(taskFieldId, workerUserId, recipientPhone, 'FAILED', errorMessage);
    await sendWorkerFeedback(
      workerPhone,
      `⚠️ לא הצלחתי לעדכן את ${recipientName} בוואטסאפ.\nאנא התקשר ישירות: ${recipientPhone}`,
      taskFieldId,
    );
    log.error({ err, taskFieldId }, 'Customer EN_ROUTE notification failed');
  }
}

async function sendWorkerFeedback(
  workerPhone: string | null,
  text: string,
  taskFieldId: string,
): Promise<void> {
  if (!workerPhone || workerPhone.trim().length === 0) {
    log.warn({ taskFieldId }, 'Worker feedback skipped — no worker phone');
    return;
  }
  try {
    await sendTextMessage({ to: workerPhone, text });
    await stampWorkerFeedback(taskFieldId, 'WORKER_EN_ROUTE');
  } catch (err) {
    log.error({ err, taskFieldId }, 'Worker feedback send failed');
  }
}

async function auditCustomerNotification(
  taskFieldId: string,
  workerUserId: string,
  recipientPhone: string,
  executionStatus: 'SUCCESS' | 'FAILED',
  errorMessage?: string,
): Promise<void> {
  await writeAuditLog({
    userId: workerUserId,
    whatsappNumber: recipientPhone,
    originalMessage: null,
    transcribedMessage: null,
    detectedIntent: 'customer_notification_worker_en_route',
    detectedAction: null,
    confidence: null,
    // WhatsappAuditLog.targetTaskId is a FK to "Task"(id) — TaskField ids
    // aren't valid there. The taskFieldId lives in newValues instead, and
    // the primary trail is the WhatsappCustomerNotification row itself.
    targetTaskId: null,
    oldValues: null,
    newValues: { taskFieldId },
    confirmationStatus: null,
    approvalStatus: null,
    approverUserId: null,
    managerNotified: false,
    executionStatus,
    errorMessage: errorMessage ?? null,
    pendingActionId: null,
  });
}
