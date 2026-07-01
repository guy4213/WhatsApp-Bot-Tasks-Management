import { pool } from '../db/connection';

/**
 * Dedup ledger for scheduled digests (migration 008), mirroring the INSERT-first
 * pattern used by "WhatsappReminderLog". The (userId, digestType, localDate) PK
 * guarantees at most one MORNING + one EVENING digest per user per local day, even
 * with overlapping scheduler runs across multiple instances.
 */
/**
 * `EQUIPMENT_MORNING` was added for D2-T9 — the equipment reminder is sent as
 * a SEPARATE dedup row from `MORNING`, so a dispatcher restart in the same
 * 5-min window doesn't cause a duplicate inspector morning digest yet still
 * allows the equipment reminder to fire (or vice-versa). The underlying
 * `WhatsappDigestSendLog.digestType` column is bare `text` (no CHECK) — see
 * `src/db/migrations/008_digests.sql:41` — so no migration is required.
 */
export type DigestType = 'MORNING' | 'EVENING' | 'EQUIPMENT_MORNING' | 'LEADS_MORNING';

/**
 * Atomically claim the right to send a digest. Inserts the ledger row first; the
 * INSERT wins (returns true) only the first time for a given (user, type, day).
 * A later attempt hits the PK conflict, inserts nothing, and returns false — so
 * the caller knows the digest already went out and must NOT send again.
 *
 * @param localDate date in the user's timezone, as 'YYYY-MM-DD'.
 */
export async function claimDigestSend(
  userId: string,
  digestType: DigestType,
  localDate: string,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO "WhatsappDigestSendLog" ("userId", "digestType", "localDate")
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING "userId"`,
    [userId, digestType, localDate],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Mark an already-claimed digest as FAILED (the claim row was inserted as SENT).
 * Leaves the PK row in place so the same digest is not retried the same local day.
 */
export async function markDigestFailed(
  userId: string,
  digestType: DigestType,
  localDate: string,
): Promise<void> {
  await pool.query(
    `UPDATE "WhatsappDigestSendLog"
       SET "status" = 'FAILED'
     WHERE "userId" = $1 AND "digestType" = $2 AND "localDate" = $3`,
    [userId, digestType, localDate],
  );
}
