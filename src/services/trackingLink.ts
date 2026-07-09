/**
 * Customer-facing tracking link helpers (Phase-2 live tracking, migration 016).
 *
 * Deliberately standalone — does NOT import from `services/tracking.ts` (kept
 * decoupled to avoid cross-agent coupling while both files are being edited in
 * parallel). Reads the `TrackingSession` table directly with its own query.
 *
 * Never throws — callers (`customerNotifications.ts`) treat a tracking link as
 * a best-effort enhancement, never a blocker for the customer notification.
 */
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('tracking-link');

/**
 * Build the public tracking URL for a session token, using
 * `TRACKING_PUBLIC_BASE_URL`. Returns `null` when the env var is unset or
 * blank — callers must treat that as "no link available" rather than an
 * error. Strips a trailing slash from the base so we never emit `//t/...`.
 */
export function buildTrackingUrl(token: string): string | null {
  const base = (process.env.TRACKING_PUBLIC_BASE_URL ?? '').trim();
  if (base.length === 0) return null;
  const stripped = base.replace(/\/+$/, '');
  return `${stripped}/t/${token}`;
}

/**
 * Resolve the currently-active (ACTIVE|ARRIVED, not-yet-expired)
 * TrackingSession token for a TaskField, most-recently-started first.
 * Returns `null` when there is none, or on any DB error — this lookup must
 * never throw and must never block the customer notification it supports.
 */
export async function getActiveTrackingToken(taskFieldId: string): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ publicToken: string }>(
      `SELECT "publicToken"
         FROM "TrackingSession"
        WHERE "taskFieldId" = $1
          AND status IN ('ACTIVE', 'ARRIVED')
          AND "expiresAt" > now()
        ORDER BY "startedAt" DESC
        LIMIT 1`,
      [taskFieldId],
    );
    return rows[0]?.publicToken ?? null;
  } catch (err) {
    log.warn({ err, taskFieldId }, 'getActiveTrackingToken failed — continuing without a link');
    return null;
  }
}
