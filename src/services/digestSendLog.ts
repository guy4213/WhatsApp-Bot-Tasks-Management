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
 * Read-only check: has this digest already been successfully sent today?
 * Call BEFORE attempting to send. Absence of a row means "not sent yet" —
 * rows are only ever inserted (via `claimDigestSend`) AFTER a WhatsApp send
 * actually succeeds (see `dispatchOne` / `dispatchSashaLeadsMorning` /
 * `maybeDispatchEquipmentReminder` in digestDispatcher.ts), so this check
 * never returns true for a digest that failed to send.
 */
export async function isDigestAlreadySent(
  userId: string,
  digestType: DigestType,
  localDate: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM "WhatsappDigestSendLog"
     WHERE "userId" = $1 AND "digestType" = $2 AND "localDate" = $3`,
    [userId, digestType, localDate],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Record that a digest was successfully sent. Call ONLY after the WhatsApp
 * send has actually succeeded — never before. Inserts the ledger row; the
 * INSERT wins (returns true) the first time for a given (user, type, day).
 * ON CONFLICT DO NOTHING guards against a race between concurrent instances
 * (belt-and-suspenders on top of the job-level advisory lock in
 * scheduler/index.ts) — a second call for the same key returns false.
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
