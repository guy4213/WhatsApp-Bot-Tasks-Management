/**
 * OwnTracks auto-provisioning service (migration 018).
 *
 * Two public functions:
 *   createProvisioning — generate a one-time magic link for a worker.
 *   consumeProvisioning — exchange the token for an .otrc credential payload,
 *                         hashing and persisting the password in the same TX.
 *
 * Password rule: the raw password NEVER lives at rest. It is generated here at
 * consume-time, hashed with bcrypt, hash stored, plaintext returned once.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('owntracks-provisioning');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreateProvisioningResult {
  magicUrl: string;   // full HTTPS: `${PUBLIC_BASE_URL}/o/${token}`
  workerKey: string;
  expiresAt: Date;
}

export interface OtrcPayload {
  workerKey: string;
  password: string;   // plaintext, returned ONCE
  trackerId: string;
  hostUrl: string;    // `${PUBLIC_BASE_URL}/owntracks`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Very small Hebrew → Latin letter map for slug generation. */
const HEBREW_LATIN: Record<string, string> = {
  א: 'a', ב: 'b', ג: 'g', ד: 'd', ה: 'h', ו: 'v', ז: 'z', ח: 'h', ט: 't',
  י: 'y', כ: 'k', ך: 'k', ל: 'l', מ: 'm', ם: 'm', נ: 'n', ן: 'n', ס: 's',
  ע: 'a', פ: 'p', ף: 'p', צ: 'ts', ץ: 'ts', ק: 'k', ר: 'r', ש: 'sh', ת: 't',
};

/**
 * Transliterate a display name (may contain Hebrew) to a lowercase ASCII slug
 * containing only [a-z0-9]. Returns empty string when no mappable chars.
 */
function toSlug(name: string): string {
  let out = '';
  for (const ch of name) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      out += ch.toLowerCase();
    } else if (HEBREW_LATIN[ch]) {
      out += HEBREW_LATIN[ch];
    }
    // spaces, punctuation, other Unicode → drop
  }
  return out;
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Derive a 2-char uppercase tracker id from the transliterated slug.
 * Falls back to 2 random uppercase letters when the slug has < 2 ASCII letters.
 */
function deriveTrackerId(slug: string): string {
  const letters = slug.replace(/[^a-z]/g, '');
  if (letters.length >= 2) return (letters[0] + letters[1]).toUpperCase();
  if (letters.length === 1) return (letters[0] + randomHex(1)[0]).toUpperCase();
  // No ASCII letters at all — two random uppercase letters
  return crypto.randomBytes(1).toString('hex').slice(0, 2).toUpperCase();
}

/**
 * Public HTTPS host of the bot server, used to build both the WhatsApp magic
 * link (`/o/:token`) and the `.otrc` `url` field OwnTracks POSTs to. Same
 * physical host as the customer-facing tracking page → falls back to
 * `TRACKING_PUBLIC_BASE_URL` when `PUBLIC_BASE_URL` isn't set separately, so
 * operators don't have to define the same URL twice. Trailing slashes are
 * stripped so joins like `${base}/o/${token}` never yield `//`.
 *
 * Exported so route handlers (owntracksPoc.ts) can build the same URL without
 * duplicating the env lookup.
 */
export function getPublicBaseUrl(): string {
  const base = (process.env.PUBLIC_BASE_URL ?? process.env.TRACKING_PUBLIC_BASE_URL ?? '').trim();
  if (!base) {
    throw new Error(
      'PUBLIC_BASE_URL env var is not set (and TRACKING_PUBLIC_BASE_URL not present as fallback)',
    );
  }
  return base.replace(/\/+$/, '');
}

// ── createProvisioning ────────────────────────────────────────────────────────

export async function createProvisioning(workerUserId: string): Promise<CreateProvisioningResult> {
  const publicBaseUrl = getPublicBaseUrl();

  // 1. Look up the user name.
  const userRes = await pool.query<{ name: string }>(
    `SELECT name FROM "User" WHERE id = $1`,
    [workerUserId],
  );
  if (!userRes.rows[0]) throw new Error(`User not found: ${workerUserId}`);
  const userName = userRes.rows[0].name;

  const slug = toSlug(userName);
  const trackerId = deriveTrackerId(slug);

  // 2. Generate provisioning token + expiry.
  const provisioningToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

  // 3. Generate a unique workerKey (loop up to 5 times on collision).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check whether a row already exists for this workerUserId.
    const existingRes = await client.query<{ id: string; workerKey: string }>(
      `SELECT id, "workerKey" FROM "WorkerDeviceIdentity" WHERE "workerUserId" = $1 LIMIT 1`,
      [workerUserId],
    );
    const existing = existingRes.rows[0] ?? null;

    let workerKey: string;

    if (existing) {
      // Re-use the established workerKey — device identity is stable.
      workerKey = existing.workerKey;

      await client.query(
        `UPDATE "WorkerDeviceIdentity"
            SET "trackerId"             = $1,
                "provisioningToken"     = $2,
                "provisioningExpiresAt" = $3,
                "passwordHash"          = NULL,
                "provisionedAt"         = NULL,
                "revokedAt"             = NULL,
                "isActive"              = true,
                "updatedAt"             = now()
          WHERE id = $4`,
        [trackerId, provisioningToken, expiresAt, existing.id],
      );
    } else {
      // Generate a unique workerKey; retry on UNIQUE collision (extremely rare).
      let inserted = false;
      let attempt = 0;
      while (!inserted && attempt < 5) {
        const keyBase = slug.length > 0 ? slug.slice(0, 8) : `w`;
        workerKey = `${keyBase}_${randomHex(2)}`;
        try {
          await client.query(
            `INSERT INTO "WorkerDeviceIdentity"
               ("workerUserId", "workerKey", "trackerId",
                "provisioningToken", "provisioningExpiresAt",
                "isActive", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, true, now(), now())`,
            [workerUserId, workerKey, trackerId, provisioningToken, expiresAt],
          );
          inserted = true;
        } catch (err: unknown) {
          // Only retry on unique violation (code 23505); re-throw anything else.
          if ((err as NodeJS.ErrnoException & { code?: string }).code === '23505') {
            attempt++;
            if (attempt >= 5) throw err;
          } else {
            throw err;
          }
        }
      }
      // workerKey is guaranteed to be assigned when inserted=true
    }

    await client.query('COMMIT');

    log.info({ workerUserId, workerKey: workerKey! }, 'Provisioning token created');
    return {
      magicUrl: `${publicBaseUrl}/o/${provisioningToken}`,
      workerKey: workerKey!,
      expiresAt,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── consumeProvisioning ───────────────────────────────────────────────────────

export async function consumeProvisioning(token: string): Promise<OtrcPayload | null> {
  const publicBaseUrl = getPublicBaseUrl();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query<{
      id: string;
      workerKey: string;
      workerUserId: string;
      trackerId: string;
      provisioningExpiresAt: Date;
    }>(
      `SELECT id, "workerKey", "workerUserId", "trackerId", "provisioningExpiresAt"
         FROM "WorkerDeviceIdentity"
        WHERE "provisioningToken" = $1
          FOR UPDATE`,
      [token],
    );

    if (!res.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    const row = res.rows[0];

    // Expired — leave the row intact; a fresh createProvisioning will reset it.
    if (row.provisioningExpiresAt < new Date()) {
      await client.query('ROLLBACK');
      return null;
    }

    // Generate password in memory; hash it; never persist the plaintext.
    const plaintext = crypto.randomBytes(18).toString('base64url');
    const passwordHash = await bcrypt.hash(plaintext, 10);

    await client.query(
      `UPDATE "WorkerDeviceIdentity"
          SET "passwordHash"          = $1,
              "provisioningToken"     = NULL,
              "provisioningExpiresAt" = NULL,
              "provisionedAt"         = now(),
              "isActive"              = true,
              "revokedAt"             = NULL,
              "updatedAt"             = now()
        WHERE id = $2`,
      [passwordHash, row.id],
    );

    await client.query('COMMIT');

    log.info({ workerUserId: row.workerUserId, workerKey: row.workerKey }, 'Provisioning consumed');

    // Best-effort cache invalidation for the auth credential cache (PROV-T3).
    // Dynamic import so this is a no-op when workerLocation hasn't exported the
    // function yet (parallel task).
    try {
      const mod = await import('./workerLocation');
      if (typeof (mod as unknown as Record<string, unknown>).invalidateWorkerCredentialCache === 'function') {
        (mod as unknown as Record<string, (...a: unknown[]) => unknown>).invalidateWorkerCredentialCache(row.workerKey);
      }
    } catch {
      /* dep not ready yet — safe to ignore */
    }

    return {
      workerKey: row.workerKey,
      password: plaintext,
      trackerId: row.trackerId,
      hostUrl: `${publicBaseUrl}/owntracks`,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
