/**
 * Bot-side dedup ledger for IncomingLead notifications (migration 010).
 * Mirrors the INSERT-first pattern used by WhatsappCompletionNotification and
 * WhatsappDigestSendLog: the presence of a row prevents a second notification
 * for the same (leadId, eventKind) pair.
 *
 * Two event kinds:
 *   ASSIGNED_TO_WORKER — D3-T3: inspector receives one alert when ownerId flips.
 *   ESCALATED_1H       — D3-T4: Sasha receives one escalation for a daytime
 *                        unassigned lead older than 1 hour.
 */
import { pool } from '../db/connection';

export type LeadEventKind = 'ASSIGNED_TO_WORKER' | 'ESCALATED_1H';

/**
 * Read-only check: has this lead notification already been successfully
 * sent? Call BEFORE attempting to send. Absence of a row means "not sent
 * yet" — rows are only ever inserted (via `claimLeadNotification`) AFTER a
 * WhatsApp send actually succeeds, so this never returns true for a
 * notification that failed to send.
 */
export async function isLeadNotificationSent(
  leadId: string,
  eventKind: LeadEventKind,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM "WhatsappLeadNotification"
     WHERE "leadId" = $1 AND "eventKind" = $2`,
    [leadId, eventKind],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Record that a lead notification was successfully sent. Call ONLY after
 * the WhatsApp send has actually succeeded — never before. Returns true
 * when this instance wins the INSERT; false when the row already exists
 * (a race with another instance — belt-and-suspenders on top of the
 * job-level advisory lock in scheduler/index.ts). Never throws on PK
 * conflict.
 */
export async function claimLeadNotification(
  leadId: string,
  eventKind: LeadEventKind,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO "WhatsappLeadNotification" ("leadId", "eventKind")
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING "leadId"`,
    [leadId, eventKind],
  );
  return (result.rowCount ?? 0) > 0;
}
