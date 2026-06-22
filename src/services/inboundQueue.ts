import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('inboundQueue');

export interface InboundMessage {
  msgId: string;
  fromPhone: string;
  payload: Record<string, unknown>;
}

/**
 * Persist an inbound message durably. Returns true if it was newly enqueued,
 * false if this msg_id was already seen (dedup). Throws if the DB is unreachable
 * so the caller can decide whether to fall back to in-memory handling.
 */
export async function enqueueInbound(msg: InboundMessage): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO "WhatsappInboundQueue" ("msgId", "fromPhone", payload)
     VALUES ($1, $2, $3)
     ON CONFLICT ("msgId") DO NOTHING`,
    [msg.msgId, msg.fromPhone, JSON.stringify(msg.payload)],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function markDone(msgId: string): Promise<void> {
  await pool.query(
    `UPDATE "WhatsappInboundQueue"
     SET status = 'done', "processedAt" = now()
     WHERE "msgId" = $1`,
    [msgId],
  );
}

export async function markFailed(msgId: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE "WhatsappInboundQueue"
     SET status = 'failed', attempts = attempts + 1, error = $2, "processedAt" = now()
     WHERE "msgId" = $1`,
    [msgId, error.slice(0, 1000)],
  );
}

/**
 * Atomically claim up to `limit` pending messages for reprocessing.
 * Uses FOR UPDATE SKIP LOCKED so multiple instances don't grab the same rows.
 * Rows older than `minAgeSeconds` are eligible (avoids racing in-flight messages
 * that the POST handler is still processing).
 */
export async function claimPending(limit = 50, minAgeSeconds = 60): Promise<InboundMessage[]> {
  const result = await pool.query<{ msgId: string; fromPhone: string; payload: Record<string, unknown> }>(
    `WITH claimed AS (
       SELECT "msgId"
       FROM "WhatsappInboundQueue"
       WHERE status = 'pending'
         AND "receivedAt" < now() - make_interval(secs => $2)
       ORDER BY "receivedAt" ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE "WhatsappInboundQueue" q
     SET status = 'processing', attempts = attempts + 1
     FROM claimed
     WHERE q."msgId" = claimed."msgId"
     RETURNING q."msgId", q."fromPhone", q.payload`,
    [limit, minAgeSeconds],
  );

  if (result.rows.length > 0) {
    log.info({ count: result.rows.length }, 'Claimed pending inbound messages for recovery');
  }

  return result.rows.map((r) => ({
    msgId: r.msgId,
    fromPhone: r.fromPhone,
    payload: r.payload,
  }));
}
