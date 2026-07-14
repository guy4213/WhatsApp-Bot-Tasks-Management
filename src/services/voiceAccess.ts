/**
 * VOICE-1 — Personal access tokens for the Hebrew voice assistant page.
 *
 * Identity model (mirrors the OwnTracks magic-link idea, but long-lived):
 *   - A manager/script mints a personal link `${PUBLIC_BASE_URL}/voice?u=<token>`
 *     for a specific bot user.
 *   - The RAW token appears only in that URL. The DB stores its SHA-256 hex
 *     digest ("VoiceAccessToken"."tokenHash") — a leaked DB dump cannot be
 *     replayed into a working link.
 *   - Every /voice/session and /voice/tool call resolves the token back to a
 *     full ResolvedUser (same shape the WhatsApp router uses), so the voice
 *     tool layer enforces the exact same role gates as the bot.
 *
 * Tokens are revocable (revokedAt) and expiring (expiresAt, default 90 days).
 */

import crypto from 'crypto';
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';
import type { ResolvedUser } from '../types';

const logger = moduleLogger('voice-access');

const DEFAULT_TTL_DAYS = 90;

export interface CreateVoiceTokenResult {
  /** The raw URL token — shown ONCE; only its hash rests in the DB. */
  token: string;
  expiresAt: Date;
}

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Mint a personal voice-page token for `userId`. Existing tokens stay valid
 * (a user may hold e.g. a phone link and a desktop link); revoke explicitly
 * via `revokeVoiceTokens` when needed.
 */
export async function createVoiceToken(
  userId: string,
  opts: { ttlDays?: number; label?: string | null } = {},
): Promise<CreateVoiceTokenResult> {
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const token = crypto.randomBytes(24).toString('base64url');
  const { rows } = await pool.query<{ expiresAt: Date }>(
    `INSERT INTO "VoiceAccessToken" ("userId", "tokenHash", label, "expiresAt")
     VALUES ($1, $2, $3, now() + make_interval(days => $4))
     RETURNING "expiresAt"`,
    [userId, sha256Hex(token), opts.label ?? null, ttlDays],
  );
  logger.info({ userId, ttlDays }, 'voice access token created');
  return { token, expiresAt: rows[0].expiresAt };
}

/** Revoke every active voice token of a user. Returns the revoked count. */
export async function revokeVoiceTokens(userId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE "VoiceAccessToken"
        SET "revokedAt" = now()
      WHERE "userId" = $1 AND "revokedAt" IS NULL`,
    [userId],
  );
  return rowCount ?? 0;
}

/**
 * Resolve a raw URL token to a full ResolvedUser.
 * Returns null when the token is unknown / expired / revoked, or the user is
 * inactive. Stamps lastUsedAt on success (best-effort).
 */
export async function resolveVoiceToken(rawToken: string): Promise<ResolvedUser | null> {
  if (!rawToken || rawToken.length < 16 || rawToken.length > 128) return null;
  // base64url alphabet only — reject anything else before touching the DB.
  if (!/^[A-Za-z0-9_-]+$/.test(rawToken)) return null;

  const hash = sha256Hex(rawToken);
  const { rows, rowCount } = await pool.query<{
    tokenId: string;
    id: string;
    name: string;
    phone: string;
    role: string;
    status: string;
    can_view_all_records: boolean;
    can_manage_users: boolean;
    can_manage_permissions: boolean;
  }>(
    `SELECT vat.id AS "tokenId",
            u.id, u.name, u.phone, u.role, u.status,
            u."canViewAllRecords"    AS can_view_all_records,
            u."canManageUsers"       AS can_manage_users,
            u."canManagePermissions" AS can_manage_permissions
       FROM "VoiceAccessToken" vat
       JOIN "User" u ON u.id = vat."userId"
      WHERE vat."tokenHash" = $1
        AND vat."revokedAt" IS NULL
        AND vat."expiresAt" > now()
      LIMIT 1`,
    [hash],
  );
  if ((rowCount ?? 0) === 0) return null;

  const row = rows[0];
  if (row.status !== 'active' && row.status !== 'ACTIVE') return null;

  // Best-effort usage stamp — an error here must never fail the request.
  pool
    .query(`UPDATE "VoiceAccessToken" SET "lastUsedAt" = now() WHERE id = $1`, [row.tokenId])
    .catch((err) => logger.warn({ err }, 'lastUsedAt stamp failed'));

  const role = row.role as ResolvedUser['role'];
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    role,
    isElevated: role === 'MANAGER' || role === 'ADMIN',
    canViewAllRecords: row.can_view_all_records,
    canManageUsers: row.can_manage_users,
    canManagePermissions: row.can_manage_permissions,
  };
}

/**
 * Append-only audit of a single tool execution. argsJson is truncated so a
 * runaway payload can never bloat the table. Never throws.
 */
export async function auditVoiceToolCall(input: {
  userId: string;
  toolName: string;
  args: unknown;
  ok: boolean;
  summary: string | null;
  latencyMs: number;
}): Promise<void> {
  try {
    const argsJson = JSON.stringify(input.args ?? {}).slice(0, 4000);
    await pool.query(
      `INSERT INTO "VoiceToolCall" ("userId", "toolName", "argsJson", ok, summary, "latencyMs")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.userId,
        input.toolName,
        argsJson,
        input.ok,
        input.summary ? input.summary.slice(0, 500) : null,
        Math.round(input.latencyMs),
      ],
    );
  } catch (err) {
    logger.warn({ err }, 'voice tool audit write failed');
  }
}
