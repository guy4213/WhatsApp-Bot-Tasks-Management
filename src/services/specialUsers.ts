/**
 * Special-user routing (Yoram + Sasha) — identified by User.name, not env vars.
 *
 * V2 spec: exactly two users get non-standard digests:
 *   - יורם  → SPEC §13 exceptions digest (field counts + open exceptions + leads counts)
 *   - סשה  → SPEC §12 leads morning digest at 09:30 + 1h escalation alerts
 *
 * Every other user (regardless of role: ADMIN / MANAGER / WORKER / TECHNICIAN)
 * is treated as a field worker per the K1 rule and receives the standard
 * inspector morning + employee evening digests.
 *
 * Names are literal DB matches on `User.name`. If the CRM ever renames one of
 * these users, update the constant here — this is intentional (one line change,
 * no env-var drift, DB is the source of truth for the phone).
 */
import { pool } from '../db/connection';

export const YORAM_NAME = 'יורם';
export const SASHA_NAME = 'סשה';

export function isYoram(userName: string | null | undefined): boolean {
  return userName === YORAM_NAME;
}

export function isSasha(userName: string | null | undefined): boolean {
  return userName === SASHA_NAME;
}

/**
 * Look up Sasha's WhatsApp phone from the `User` table (by name).
 * Returns null if no active Sasha row exists. Never throws.
 * Used by the D3-T4 escalation alert (leadAssignmentNotifier).
 */
export async function getSashaPhone(): Promise<string | null> {
  const { rows } = await pool.query<{ phone: string | null }>(
    `SELECT phone FROM "User"
     WHERE name = $1
       AND upper(status::text) = 'ACTIVE'
       AND phone IS NOT NULL
     LIMIT 1`,
    [SASHA_NAME],
  );
  return rows[0]?.phone ?? null;
}
