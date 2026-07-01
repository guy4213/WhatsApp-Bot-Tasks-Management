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
 * Atomically claim the right to send a lead notification. Returns true when
 * this instance wins the INSERT (first send); false when the row already exists
 * (another instance already sent it). Never throws on PK conflict.
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
