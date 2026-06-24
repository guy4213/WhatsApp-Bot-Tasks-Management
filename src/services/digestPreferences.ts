import { pool } from '../db/connection';
import { writeAuditLog } from '../utils/auditLog';

/**
 * Per-user digest preferences (migration 008).
 *
 * Rows are created LAZILY — only when a user changes a setting via the menu. The
 * dispatcher treats a missing row as "enabled with defaults" (see
 * digestDispatcher.ts), so every active user is effectively ON without seeding.
 * These defaults mirror the column DEFAULTs in 008_digests.sql.
 */
export const DIGEST_DEFAULTS = {
  morningEnabled: true,
  morningTime: '08:00',
  eveningEnabled: true,
  eveningTime: '17:00',
  timezone: 'Asia/Jerusalem',
} as const;

export interface DigestPreference {
  userId: string;
  morningEnabled: boolean;
  morningTime: string;
  eveningEnabled: boolean;
  eveningTime: string;
  timezone: string;
}

/** Fields a caller may change. Any omitted/undefined field is left untouched. */
export interface DigestPreferencePatch {
  morningEnabled?: boolean;
  morningTime?: string;
  eveningEnabled?: boolean;
  eveningTime?: string;
  timezone?: string;
}

interface PrefRow {
  userId: string;
  morningEnabled: boolean;
  morningTime: string;
  eveningEnabled: boolean;
  eveningTime: string;
  timezone: string;
}

/**
 * Read a user's stored preference, or null when no row exists yet. Callers that
 * need the effective settings (defaults applied) should use the COALESCE in the
 * dispatcher query, or fall back to DIGEST_DEFAULTS for display.
 */
export async function getDigestPreference(userId: string): Promise<DigestPreference | null> {
  const result = await pool.query<PrefRow>(
    `SELECT "userId", "morningEnabled", "morningTime",
            "eveningEnabled", "eveningTime", "timezone"
     FROM "UserDigestPreference"
     WHERE "userId" = $1`,
    [userId],
  );
  return result.rowCount === 0 ? null : result.rows[0];
}

/** The user's effective settings — their stored row, or the shared defaults. */
export async function getEffectiveDigestPreference(userId: string): Promise<DigestPreference> {
  const stored = await getDigestPreference(userId);
  return stored ?? { userId, ...DIGEST_DEFAULTS };
}

/**
 * Insert-or-update a user's preference. Only the fields present on `patch` are
 * changed; everything else keeps its existing value (or the column default on a
 * first insert). When `audit` is provided, the change is recorded in
 * "WhatsappAuditLog" (best-effort — audit failures never throw).
 */
export async function upsertDigestPreference(
  userId: string,
  patch: DigestPreferencePatch,
  audit?: { phone: string },
): Promise<DigestPreference> {
  const me = (v: boolean | string | undefined) => (v === undefined ? null : v);

  const result = await pool.query<PrefRow>(
    `INSERT INTO "UserDigestPreference"
       ("userId", "morningEnabled", "morningTime",
        "eveningEnabled", "eveningTime", "timezone", "updatedAt")
     VALUES (
       $1,
       COALESCE($2, true), COALESCE($3, '08:00'),
       COALESCE($4, true), COALESCE($5, '17:00'),
       COALESCE($6, 'Asia/Jerusalem'), now()
     )
     ON CONFLICT ("userId") DO UPDATE SET
       "morningEnabled" = COALESCE($2, "UserDigestPreference"."morningEnabled"),
       "morningTime"    = COALESCE($3, "UserDigestPreference"."morningTime"),
       "eveningEnabled" = COALESCE($4, "UserDigestPreference"."eveningEnabled"),
       "eveningTime"    = COALESCE($5, "UserDigestPreference"."eveningTime"),
       "timezone"       = COALESCE($6, "UserDigestPreference"."timezone"),
       "updatedAt"      = now()
     RETURNING "userId", "morningEnabled", "morningTime",
               "eveningEnabled", "eveningTime", "timezone"`,
    [
      userId,
      me(patch.morningEnabled),
      me(patch.morningTime),
      me(patch.eveningEnabled),
      me(patch.eveningTime),
      me(patch.timezone),
    ],
  );

  const updated = result.rows[0];

  if (audit) {
    await writeAuditLog({
      userId,
      whatsappNumber: audit.phone,
      originalMessage: null,
      transcribedMessage: null,
      detectedIntent: 'digest_pref_change',
      detectedAction: null,
      confidence: null,
      targetTaskId: null,
      oldValues: null,
      newValues: patch as Record<string, unknown>,
      confirmationStatus: null,
      approvalStatus: null,
      approverUserId: null,
      managerNotified: false,
      executionStatus: 'SUCCESS',
      errorMessage: null,
      pendingActionId: null,
    });
  }

  return updated;
}

/**
 * Ensure a preference row exists for a user (created with the column defaults).
 * Returns the user's current effective preference. Mainly useful when you want a
 * concrete row to exist before reads in other systems; normal settings changes go
 * through upsertDigestPreference.
 */
export async function ensureDigestPreference(userId: string): Promise<DigestPreference> {
  const result = await pool.query<PrefRow>(
    `INSERT INTO "UserDigestPreference" ("userId") VALUES ($1)
     ON CONFLICT ("userId") DO NOTHING
     RETURNING "userId", "morningEnabled", "morningTime",
               "eveningEnabled", "eveningTime", "timezone"`,
    [userId],
  );
  if (result.rowCount && result.rowCount > 0) return result.rows[0];
  // Row already existed — read it back.
  return getEffectiveDigestPreference(userId);
}

/**
 * Pure parser for a user-typed time. Accepts:
 *   '8' → '08:00', '8:30' → '08:30', '08:00' → '08:00', '8:5' → '08:05'
 * Rejects out-of-range / non-numeric / empty input, returning null so the caller
 * can re-prompt. Hours 0–23, minutes 0–59.
 */
export function parseTimeInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const m = trimmed.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;

  const hours = parseInt(m[1], 10);
  const minutes = m[2] === undefined ? 0 : parseInt(m[2], 10);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23) return null;
  if (minutes < 0 || minutes > 59) return null;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
