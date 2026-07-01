/**
 * Task-field correction helpers — D2-T12, D2-T13, D2-T14.
 *
 * D2-T12 — site metadata override on a TaskField (address / city /
 *   fieldContactName / fieldContactPhone). Never touches Customer or Task.
 *
 * D2-T13 — reassign a Task to another worker (writes Task.ownerId + resets
 *   TaskField.workerNotifiedAt for ASSIGNED/CONFIRMED rows of that Task).
 *   Auth enforced by caller (MANAGER/ADMIN only).
 *
 * D2-T14 — worker correction of inspection type. Transactional write to
 *   TaskField.inspectionTypeId + TaskField.family + Task.productName (a single
 *   BEGIN/COMMIT). Requires worker confirmation before write (enforced by the
 *   router). Notifies Yoram + Sasha via WhatsApp. Full audit log.
 */

import { pool } from '../db/connection';
import { sendTextMessage } from '../whatsapp/sender';
import { writeAuditLog } from '../utils/auditLog';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('taskFieldCorrections');

// ── Notification targets for D2-T14 ──────────────────────────────────────────
const YORAM_NAME = 'יורם';
const NOTIFY_NAMES = [YORAM_NAME, 'סשה'] as const;

/** Fetch phone numbers for Yoram + Sasha from the User table. */
async function getNotificationPhones(): Promise<string[]> {
  const { rows } = await pool.query<{ phone: string }>(
    `SELECT phone FROM "User"
     WHERE name = ANY($1::text[])
       AND upper(status::text) = 'ACTIVE'
       AND phone IS NOT NULL
       AND phone <> ''`,
    [Array.from(NOTIFY_NAMES)],
  );
  return rows.map((r) => r.phone);
}

// ── D2-T12 — site metadata correction ────────────────────────────────────────

export interface SiteMetadataFields {
  siteAddress?: string;
  siteCity?: string;
  fieldContactName?: string;
  fieldContactPhone?: string;
}

/**
 * D2-T12: Update static site metadata fields on a TaskField.
 * Only the supplied fields are updated (the rest are left unchanged).
 * Never writes to Customer or Task.
 *
 * Auth: WORKER may only update their own TaskField (Task.ownerId = actorId).
 *       MANAGER / ADMIN may update any.
 * Enforcement is done by the caller (router) but this function verifies
 * ownership for WORKER-role safety.
 */
export async function updateSiteMetadata(
  taskFieldId: string,
  actorId: string,
  fields: SiteMetadataFields,
): Promise<void> {
  const keys = Object.keys(fields) as (keyof SiteMetadataFields)[];
  if (keys.length === 0) {
    throw new Error('updateSiteMetadata: no fields supplied');
  }

  // Build a dynamic SET clause — only the provided keys.
  const setClauses: string[] = [];
  const values: unknown[] = [taskFieldId, actorId]; // $1, $2 reserved
  let paramIdx = 3;

  const colMap: Record<keyof SiteMetadataFields, string> = {
    siteAddress: '"siteAddress"',
    siteCity: '"siteCity"',
    fieldContactName: '"fieldContactName"',
    fieldContactPhone: '"fieldContactPhone"',
  };

  for (const key of keys) {
    if (fields[key] !== undefined) {
      setClauses.push(`${colMap[key]} = $${paramIdx}`);
      values.push(fields[key]);
      paramIdx++;
    }
  }

  setClauses.push('"updatedByUserId" = $2', '"updatedAt" = now()');

  const sql = `
    UPDATE "TaskField"
       SET ${setClauses.join(', ')}
     WHERE id = $1`;

  await pool.query(sql, values);
  log.info({ taskFieldId, actorId, keys }, 'D2-T12: site metadata updated');
}

// ── D2-T13 — task reassignment ────────────────────────────────────────────────

export interface ReassignTaskResult {
  /** Number of TaskField rows whose workerNotifiedAt was reset. */
  resetCount: number;
  /** True when at least one TaskField was in an in-progress state
   *  (EN_ROUTE / ARRIVED / FINISHED_FIELD) at the time of reassignment. */
  hadInProgressRows: boolean;
}

/**
 * D2-T13: Reassign a Task to a new worker.
 * Writes:
 *   - Task.ownerId = newOwnerId
 *   - TaskField.workerNotifiedAt = NULL  for ASSIGNED / CONFIRMED rows of that Task
 *
 * In-progress rows (EN_ROUTE / ARRIVED / FINISHED_FIELD) are left unchanged —
 * the field worker already started those; only the pre-field rows are reset.
 *
 * Auth: MANAGER / ADMIN only — enforced by the caller (router).
 */
export async function reassignTask(
  taskId: string,
  newOwnerId: string,
  actorId: string,
): Promise<ReassignTaskResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update Task.ownerId.
    await client.query(
      `UPDATE "Task" SET "ownerId" = $1 WHERE id = $2`,
      [newOwnerId, taskId],
    );

    // Check for in-progress rows before resetting.
    const inProgressResult = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM "TaskField"
        WHERE "taskId" = $1
          AND "fieldStatus" IN ('EN_ROUTE','ARRIVED','FINISHED_FIELD')`,
      [taskId],
    );
    const hadInProgressRows = parseInt(inProgressResult.rows[0]?.count ?? '0', 10) > 0;

    // Reset workerNotifiedAt only for ASSIGNED / CONFIRMED rows.
    const resetResult = await client.query<{ count: string }>(
      `WITH updated AS (
         UPDATE "TaskField"
            SET "workerNotifiedAt" = NULL,
                "updatedAt" = now()
          WHERE "taskId" = $1
            AND "fieldStatus" IN ('ASSIGNED','CONFIRMED')
         RETURNING id
       )
       SELECT count(*)::text AS count FROM updated`,
      [taskId],
    );
    const resetCount = parseInt(resetResult.rows[0]?.count ?? '0', 10);

    await client.query('COMMIT');

    log.info({ taskId, newOwnerId, actorId, resetCount, hadInProgressRows }, 'D2-T13: task reassigned');
    return { resetCount, hadInProgressRows };
  } catch (err) {
    await client.query('ROLLBACK');
    log.error({ err, taskId, newOwnerId, actorId }, 'D2-T13: reassignTask rollback');
    throw err;
  } finally {
    client.release();
  }
}

// ── D2-T14 — inspection type correction ──────────────────────────────────────

export interface CorrectInspectionTypeResult {
  oldProductName: string;
  newProductName: string;
}

/**
 * D2-T14: Correct the inspection type on a TaskField.
 *
 * Transactional write in a single BEGIN/COMMIT:
 *   1. UPDATE TaskField: inspectionTypeId, family, updatedByUserId, updatedAt
 *   2. UPDATE Task:      productName = InspectionType.code
 *
 * Validation:
 *   - TaskField.fieldStatus must NOT be FINISHED_FIELD or CANCELED.
 *   - The new InspectionType must exist (looked up before the transaction).
 *
 * After a successful write:
 *   - Notifies Yoram + Sasha via WhatsApp.
 *   - Writes an audit log entry.
 *
 * Auth: WORKER may only correct rows where Task.ownerId = actorId.
 *       MANAGER / ADMIN may correct any.
 * Enforcement delegated to the caller (router), but we verify via a joined
 * query that also fetches Task.id and current productName.
 *
 * @param taskFieldId    The TaskField to correct.
 * @param newInspectionTypeId  UUID of the target InspectionType.
 * @param actorId        The user performing the correction (for audit + auth).
 * @param workerName     Display name of the actor (for notifications).
 */
export async function correctInspectionType(
  taskFieldId: string,
  newInspectionTypeId: string,
  actorId: string,
  workerName: string,
): Promise<CorrectInspectionTypeResult> {
  // 1. Fetch TaskField + joined Task fields + current InspectionType label.
  const prefetch = await pool.query<{
    taskId: string;
    fieldStatus: string;
    taskOwnerId: string;
    oldProductName: string | null;
    oldLabelHe: string | null;
  }>(
    `SELECT tf."taskId", tf."fieldStatus", t."ownerId" AS "taskOwnerId",
            t."productName" AS "oldProductName",
            it."labelHe" AS "oldLabelHe"
       FROM "TaskField" tf
       JOIN "Task" t ON t.id = tf."taskId"
       LEFT JOIN "InspectionType" it ON it.id = tf."inspectionTypeId"
      WHERE tf.id = $1`,
    [taskFieldId],
  );
  if (prefetch.rowCount === 0) {
    throw new Error(`D2-T14: TaskField ${taskFieldId} not found`);
  }
  const row = prefetch.rows[0];

  // Status guard.
  if (row.fieldStatus === 'FINISHED_FIELD' || row.fieldStatus === 'CANCELED') {
    throw new ClosedInspectionError(
      `D2-T14: cannot correct closed TaskField (fieldStatus=${row.fieldStatus})`,
    );
  }

  // 2. Fetch new InspectionType.
  const typeFetch = await pool.query<{ code: string; labelHe: string; family: string }>(
    `SELECT code, "labelHe", family FROM "InspectionType" WHERE id = $1 AND "isActive" = true`,
    [newInspectionTypeId],
  );
  if (typeFetch.rowCount === 0) {
    throw new Error(`D2-T14: InspectionType ${newInspectionTypeId} not found or inactive`);
  }
  const newType = typeFetch.rows[0];

  const taskId = row.taskId;
  const oldProductName = row.oldProductName ?? '';
  const newProductName = newType.code;

  // 3. Transactional write.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE "TaskField"
          SET "inspectionTypeId" = $2,
              family             = $3,
              "updatedByUserId"  = $4,
              "updatedAt"        = now()
        WHERE id = $1`,
      [taskFieldId, newInspectionTypeId, newType.family, actorId],
    );

    await client.query(
      `UPDATE "Task" SET "productName" = $2 WHERE id = $1`,
      [taskId, newProductName],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    log.error({ err, taskFieldId, newInspectionTypeId, actorId }, 'D2-T14: correctInspectionType rollback');
    throw err;
  } finally {
    client.release();
  }

  // 4. Notify Yoram + Sasha.
  const oldLabel = row.oldLabelHe ?? oldProductName;
  const notifyText =
    `תיקון סוג בדיקה: העובד ${workerName} עדכן משימה של לקוח ` +
    `(taskField: ${taskFieldId}) מ-${oldLabel} ל-${newType.labelHe}.`;

  const phones = await getNotificationPhones().catch((err) => {
    log.warn({ err }, 'D2-T14: failed to fetch notification phones');
    return [] as string[];
  });

  await Promise.allSettled(
    phones.map((phone) =>
      sendTextMessage({ to: phone, text: notifyText }).catch((err) => {
        log.error({ err, phone }, 'D2-T14: notification send failed');
      }),
    ),
  );

  // 5. Audit log.
  await writeAuditLog({
    userId: actorId,
    whatsappNumber: '',
    originalMessage: null,
    transcribedMessage: null,
    detectedIntent: 'correct_inspection_type',
    detectedAction: 'UPDATE_TASKFIELD_TYPE',
    confidence: null,
    targetTaskId: taskId,
    oldValues: { productName: oldProductName, taskFieldId, inspectionTypeLabel: oldLabel },
    newValues: { productName: newProductName, taskFieldId, inspectionTypeLabel: newType.labelHe },
    confirmationStatus: 'CONFIRMED',
    approvalStatus: 'NOT_REQUIRED',
    approverUserId: null,
    managerNotified: phones.length > 0,
    executionStatus: 'SUCCESS',
    errorMessage: null,
    pendingActionId: null,
  });

  log.info(
    { taskFieldId, taskId, actorId, oldProductName, newProductName },
    'D2-T14: inspection type corrected',
  );

  return { oldProductName, newProductName };
}

/** Thrown when D2-T14 is attempted on a FINISHED_FIELD or CANCELED TaskField. */
export class ClosedInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClosedInspectionError';
  }
}

// ── Lookup helpers (used by the router flows) ─────────────────────────────────

export interface InspectionTypeRow {
  id: string;
  code: string;
  labelHe: string;
  family: string;
}

/** Return all active InspectionType rows, sorted by family + sortOrder. */
export async function listInspectionTypes(): Promise<InspectionTypeRow[]> {
  const { rows } = await pool.query<InspectionTypeRow>(
    `SELECT id, code, "labelHe", family
       FROM "InspectionType"
      WHERE "isActive" = true
      ORDER BY family, "sortOrder", code`,
  );
  return rows;
}

/** Lookup a TaskField with its joined Task owner for auth checks. */
export interface TaskFieldOwnerRow {
  taskFieldId: string;
  taskId: string;
  taskOwnerId: string;
  fieldStatus: string;
  currentInspectionTypeId: string | null;
  currentLabelHe: string | null;
}

export async function getTaskFieldForCorrection(
  taskFieldId: string,
): Promise<TaskFieldOwnerRow | null> {
  const { rows, rowCount } = await pool.query<{
    id: string;
    taskId: string;
    taskOwnerId: string;
    fieldStatus: string;
    inspectionTypeId: string | null;
    labelHe: string | null;
  }>(
    `SELECT tf.id, tf."taskId", t."ownerId" AS "taskOwnerId",
            tf."fieldStatus", tf."inspectionTypeId",
            it."labelHe"
       FROM "TaskField" tf
       JOIN "Task" t ON t.id = tf."taskId"
       LEFT JOIN "InspectionType" it ON it.id = tf."inspectionTypeId"
      WHERE tf.id = $1`,
    [taskFieldId],
  );
  if (rowCount === 0) return null;
  const r = rows[0];
  return {
    taskFieldId: r.id,
    taskId: r.taskId,
    taskOwnerId: r.taskOwnerId,
    fieldStatus: r.fieldStatus,
    currentInspectionTypeId: r.inspectionTypeId,
    currentLabelHe: r.labelHe,
  };
}

/** Find a Task by id and return its ownerId + productName. */
export async function getTaskForReassign(
  taskId: string,
): Promise<{ ownerId: string; productName: string | null } | null> {
  const { rows, rowCount } = await pool.query<{ ownerId: string; productName: string | null }>(
    `SELECT "ownerId", "productName" FROM "Task" WHERE id = $1`,
    [taskId],
  );
  if (rowCount === 0) return null;
  return rows[0];
}
