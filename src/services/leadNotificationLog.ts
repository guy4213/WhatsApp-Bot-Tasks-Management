/**
 * Bot-side dedup ledger for IncomingLead notifications (migration 010 + 022).
 *
 * INSERT-first atomic claim (added in migration 022):
 *   1. `tryClaimLeadNotification` INSERTs a row with status='PENDING' — atomic
 *      via ON CONFLICT DO NOTHING. Only one caller can win; parallel callers
 *      get `false` and exit before sending anything.
 *   2. Caller sends the WhatsApp message.
 *   3. On success → `markLeadNotificationSent` UPDATEs status='SENT'.
 *   4. On failure → `releaseLeadNotificationClaim` DELETEs the PENDING row so
 *      the next poller tick can retry.
 *
 * This replaces the earlier check-then-act pattern (`isLeadNotificationSent`
 * followed by a post-send `claimLeadNotification`), which had a tiny race
 * window where two threads could both pass the check, both send, and race on
 * the INSERT — resulting in a duplicate WhatsApp message. INSERT-first closes
 * that window: the DB itself decides who won.
 *
 * Stale-PENDING recovery: a process crash between claim and mark-sent leaves
 * a PENDING row that would otherwise block retries forever. `tryClaimLead-
 * Notification` treats PENDING rows older than 5 minutes as reclaimable via
 * an ON CONFLICT ... DO UPDATE ... WHERE guard. The pre-filter in
 * `findNewlyAssignedLeads` mirrors the same 5-minute cutoff so the poller
 * surfaces stuck rows again.
 *
 * Two event kinds:
 *   ASSIGNED_TO_WORKER — D3-T3: inspector receives one alert when a lead is
 *                        claimed (status='ACTIVE' + ownerId set).
 *   ESCALATED_1H       — D3-T4: Sasha receives one escalation for a daytime
 *                        unassigned lead older than 1 hour.
 */
import { pool } from '../db/connection';

export type LeadEventKind = 'ASSIGNED_TO_WORKER' | 'ESCALATED_1H';

/**
 * Read-only check: has this lead notification already been marked SENT?
 * Kept for backward compatibility with older callers and for tests that
 * assert final state. New send paths should use `tryClaimLeadNotification`
 * (INSERT-first) instead of check-then-act.
 */
export async function isLeadNotificationSent(
  leadId: string,
  eventKind: LeadEventKind,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM "WhatsappLeadNotification"
     WHERE "leadId" = $1 AND "eventKind" = $2 AND "status" = 'SENT'`,
    [leadId, eventKind],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Atomically claim the right to send this notification. Returns true when
 * this caller won the race — the caller must then send the WhatsApp message
 * and follow up with `markLeadNotificationSent` (on success) or
 * `releaseLeadNotificationClaim` (on failure). Returns false when another
 * caller already claimed or sent the same notification.
 *
 * Also reclaims stale PENDING rows older than 5 minutes — those are process
 * crashes between claim and mark-sent, and blocking retries forever would be
 * worse than a very rare double-send after a crash.
 */
export async function tryClaimLeadNotification(
  leadId: string,
  eventKind: LeadEventKind,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO "WhatsappLeadNotification" ("leadId", "eventKind", "status")
     VALUES ($1, $2, 'PENDING')
     ON CONFLICT ("leadId", "eventKind") DO UPDATE
       SET "status" = 'PENDING', "notifiedAt" = now()
       WHERE "WhatsappLeadNotification"."status" = 'PENDING'
         AND "WhatsappLeadNotification"."notifiedAt" < now() - interval '5 minutes'
     RETURNING "leadId"`,
    [leadId, eventKind],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Flip a claimed PENDING row to SENT after a successful WhatsApp send. */
export async function markLeadNotificationSent(
  leadId: string,
  eventKind: LeadEventKind,
): Promise<void> {
  await pool.query(
    `UPDATE "WhatsappLeadNotification"
       SET "status" = 'SENT', "notifiedAt" = now()
     WHERE "leadId" = $1 AND "eventKind" = $2 AND "status" = 'PENDING'`,
    [leadId, eventKind],
  );
}

/**
 * Release a claimed PENDING row after a send failure so the next tick can
 * retry. Never deletes SENT rows — those are the terminal success state and
 * must remain to keep dedup working.
 */
export async function releaseLeadNotificationClaim(
  leadId: string,
  eventKind: LeadEventKind,
): Promise<void> {
  await pool.query(
    `DELETE FROM "WhatsappLeadNotification"
     WHERE "leadId" = $1 AND "eventKind" = $2 AND "status" = 'PENDING'`,
    [leadId, eventKind],
  );
}

/**
 * DEPRECATED — post-send INSERT (check-then-act). Kept only so callers we
 * haven't migrated yet keep compiling. New code MUST use the INSERT-first
 * `tryClaimLeadNotification` → send → `markLeadNotificationSent` flow.
 *
 * Behaviour is preserved for backward compat: INSERTs as SENT if no row
 * exists, does nothing on conflict.
 */
export async function claimLeadNotification(
  leadId: string,
  eventKind: LeadEventKind,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO "WhatsappLeadNotification" ("leadId", "eventKind", "status")
     VALUES ($1, $2, 'SENT')
     ON CONFLICT DO NOTHING
     RETURNING "leadId"`,
    [leadId, eventKind],
  );
  return (result.rowCount ?? 0) > 0;
}
