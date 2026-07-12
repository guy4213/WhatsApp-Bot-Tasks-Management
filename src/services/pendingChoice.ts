/**
 * PendingChoice — number→command translation for Green API numbered menus.
 *
 * Green API cannot render Meta's native interactive buttons / lists, so under
 * Green API those are sent as numbered text and the mapping (number → the exact
 * command id the router expects) is persisted here, keyed by phone. When the
 * user replies with a number, the webhook resolves it back to the command BEFORE
 * enqueue, so the whole downstream (router, dispatchInternal, …) runs unchanged.
 *
 * Semantics:
 *  - One row per phone. The newest numbered prompt upserts over the previous one
 *    (a user answers the LATEST prompt), so at most one mapping is live per user.
 *  - TTL is 60 minutes, enforced at read time.
 *  - A resolve CONSUMES (deletes) the row, and only when it exists, is unexpired,
 *    AND carries the replied key — a non-matching / expired reply leaves the row
 *    intact and returns null (the raw text then flows to the router / AI).
 *
 * This module is inert under Meta (nothing writes or reads the table there).
 */
import { pool } from '../db/connection';

/** How long a numbered prompt stays resolvable (spec: 60 minutes). */
export const PENDING_CHOICE_TTL_MINUTES = 60;

/**
 * Persist the number→command mapping for the latest numbered prompt sent to a
 * phone. Upsert: one row per phone, newest prompt wins, expiry refreshed to
 * now() + 60 min.
 */
export async function savePendingChoice(
  phone: string,
  mapping: Record<string, string>,
): Promise<void> {
  await pool.query(
    `INSERT INTO "PendingChoice" (phone, mapping, "expiresAt", "createdAt")
     VALUES ($1, $2, now() + make_interval(mins => $3), now())
     ON CONFLICT (phone) DO UPDATE
       SET mapping     = EXCLUDED.mapping,
           "expiresAt" = EXCLUDED."expiresAt",
           "createdAt" = now()`,
    [phone, JSON.stringify(mapping), PENDING_CHOICE_TTL_MINUTES],
  );
}

/**
 * Translate a bare numeric reply back to the command it stands for. Only bare
 * numeric replies ("2", " 3 ") are considered — free text short-circuits to null
 * without touching the DB, so a stale mapping is never consumed by a typed
 * message. Atomic consume: the row is deleted (and its command returned) only
 * when it exists, is unexpired, and carries the replied key; otherwise null.
 */
export async function resolvePendingChoice(
  phone: string,
  reply: string,
): Promise<string | null> {
  const key = reply.trim();
  if (!/^\d+$/.test(key)) return null; // only bare-numeric replies map to a choice

  const { rows } = await pool.query<{ resolved: string | null }>(
    `DELETE FROM "PendingChoice"
      WHERE phone = $1
        AND "expiresAt" > now()
        AND jsonb_exists(mapping, $2)
      RETURNING mapping ->> $2 AS resolved`,
    [phone, key],
  );
  return rows[0]?.resolved ?? null;
}
