import { pool } from '../db/connection';
import { moduleLogger } from './logger';
import type { AuditLogEntry } from '../types';

const log = moduleLogger('auditLog');

export async function writeAuditLog(entry: AuditLogEntry): Promise<string | null> {
  try {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO "WhatsappAuditLog" (
        "userId", "whatsappNumber", "originalMessage", "transcribedMessage",
        "detectedIntent", "detectedAction", confidence,
        "targetTaskId", "oldValues", "newValues",
        "confirmationStatus", "approvalStatus", "approverUserId",
        "managerNotified", "executionStatus", "errorMessage", "pendingActionId"
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
      )
      RETURNING id`,
      [
        entry.userId,
        entry.whatsappNumber,
        entry.originalMessage,
        entry.transcribedMessage,
        entry.detectedIntent,
        entry.detectedAction,
        entry.confidence,
        entry.targetTaskId,
        entry.oldValues ? JSON.stringify(entry.oldValues) : null,
        entry.newValues ? JSON.stringify(entry.newValues) : null,
        entry.confirmationStatus,
        entry.approvalStatus,
        entry.approverUserId,
        entry.managerNotified,
        entry.executionStatus,
        entry.errorMessage,
        entry.pendingActionId,
      ],
    );
    return res.rows[0]?.id ?? null;
  } catch (err) {
    // Audit log failure must never crash the main flow
    log.error({ err }, 'Failed to write audit log');
    return null;
  }
}

/**
 * Update the transcribedMessage column on an existing audit-log row. Used by
 * the voice (`audio`) inbound path to persist the STT transcript against the
 * initial audit-log entry written when the message arrived. Never throws.
 */
export async function updateTranscribedMessage(
  auditLogId: string,
  transcribedMessage: string,
): Promise<void> {
  try {
    await pool.query(
      `UPDATE "WhatsappAuditLog" SET "transcribedMessage" = $2 WHERE id = $1`,
      [auditLogId, transcribedMessage],
    );
  } catch (err) {
    log.error({ err, auditLogId }, 'Failed to update transcribedMessage');
  }
}
