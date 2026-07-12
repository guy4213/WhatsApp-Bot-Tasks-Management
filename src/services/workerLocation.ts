/**
 * Worker live-location service (Phase-2 live tracking, migration 016).
 *
 * Two responsibilities:
 *
 *   1. `resolveWorkerFromKey(workerKey)` — translate the OwnTracks Basic-auth
 *      username used by the POC into a bot-known `User.id`. Reads a single
 *      row from `WorkerDeviceIdentity` where `isActive=true`. Returns null
 *      when the key is not seeded / has been retired — the OwnTracks POST
 *      handler MUST treat null as "just diagnostic ping, no live tracking".
 *
 *   2. `upsertLiveLocation(...)` — overwrite the worker's single row in
 *      `WorkerLiveLocation` with the latest fix. UPSERT keyed on
 *      `workerUserId` (PK). This is the fast "latest known location" store —
 *      history stays in `PocLocationPing` (migration 013, append-only).
 *
 *   3. `verifyWorkerCredentials(workerKey, plaintext)` — DB-backed credential
 *      check with an in-process cache (TTL 60 s) to avoid bcrypt on every
 *      OwnTracks ping. Cache misses on DB-miss are NOT persisted.
 *
 *   4. `invalidateWorkerCredentialCache(workerKey)` — evict a single cache
 *      entry after a password rotation.
 *
 * Both location functions are best-effort in the caller context: the OwnTracks
 * route ALWAYS acks 200 with `[]`, and a failure here must not back up the
 * phone's upload queue. The caller decides whether to log + swallow.
 */
import bcrypt from 'bcryptjs';
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('worker-location');

// ---------------------------------------------------------------------------
// Credential cache — keeps bcrypt off the hot OwnTracks ping path.
// ---------------------------------------------------------------------------

interface CachedCredential {
  workerUserId: string;
  passwordHash: string;
  cachedAt: number; // Date.now()
}

const credentialCache = new Map<string, CachedCredential>();
const CREDENTIAL_TTL_MS = 60_000; // 60 seconds

export interface UpsertLiveLocationParams {
  workerUserId: string;
  workerKey: string;
  deviceId?: string | null;
  lat: number;
  lng: number;
  accuracy?: number | null;
  speed?: number | null;
  battery?: number | null;
  trigger?: string | null;
  recordedAt?: Date | null; // OwnTracks `tst` decoded to a Date, if present
  raw?: unknown;
}

/**
 * Map an OwnTracks basic-auth username to the bot-known `User.id`. Returns null
 * when no active mapping exists — the ping is still stored in
 * `PocLocationPing` by the route, but live tracking is skipped.
 */
export async function resolveWorkerFromKey(workerKey: string): Promise<string | null> {
  const { rows } = await pool.query<{ workerUserId: string }>(
    `SELECT "workerUserId"
       FROM "WorkerDeviceIdentity"
      WHERE "workerKey" = $1 AND "isActive" = true
      LIMIT 1`,
    [workerKey],
  );
  return rows[0]?.workerUserId ?? null;
}

/**
 * Overwrite the worker's live-location row. One row per `workerUserId`. Uses
 * PK conflict → UPDATE; the previous fix is discarded (history lives in
 * `PocLocationPing`).
 */
export async function upsertLiveLocation(p: UpsertLiveLocationParams): Promise<void> {
  await pool.query(
    `INSERT INTO "WorkerLiveLocation"
       ("workerUserId", "workerKey", "deviceId", lat, lng, accuracy, speed,
        battery, "trigger", "recordedAt", "lastSeenAt", "updatedAt", raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now(), $11)
     ON CONFLICT ("workerUserId") DO UPDATE
       SET "workerKey"  = EXCLUDED."workerKey",
           "deviceId"   = EXCLUDED."deviceId",
           lat          = EXCLUDED.lat,
           lng          = EXCLUDED.lng,
           accuracy     = EXCLUDED.accuracy,
           speed        = EXCLUDED.speed,
           battery      = EXCLUDED.battery,
           "trigger"    = EXCLUDED."trigger",
           "recordedAt" = EXCLUDED."recordedAt",
           "lastSeenAt" = now(),
           "updatedAt"  = now(),
           raw          = EXCLUDED.raw`,
    [
      p.workerUserId,
      p.workerKey,
      p.deviceId ?? null,
      p.lat,
      p.lng,
      p.accuracy ?? null,
      p.speed ?? null,
      p.battery ?? null,
      p.trigger ?? null,
      p.recordedAt ?? null,
      p.raw === undefined ? null : JSON.stringify(p.raw),
    ],
  );
  log.debug(
    { workerUserId: p.workerUserId, lat: p.lat, lng: p.lng, trigger: p.trigger },
    'WorkerLiveLocation upserted',
  );
}

// ---------------------------------------------------------------------------
// Credential verification (migration 018: passwordHash + revokedAt columns)
// ---------------------------------------------------------------------------

/**
 * Verify OwnTracks basic-auth credentials against the DB-backed hash.
 *
 * The result is cached in-process for up to 60 seconds to keep bcrypt (~100 ms
 * at cost=10) off the hot OwnTracks ping path. DB misses are NOT cached so
 * that a freshly-provisioned device can auth immediately.
 *
 * Returns `{ workerUserId }` on success, `null` on failure.
 * Never logs `plaintext` or the hash.
 */
export async function verifyWorkerCredentials(
  workerKey: string,
  plaintext: string,
): Promise<{ workerUserId: string } | null> {
  const now = Date.now();
  let cached = credentialCache.get(workerKey);

  if (!cached || now - cached.cachedAt >= CREDENTIAL_TTL_MS) {
    // Cache miss or stale — go to DB.
    const { rows } = await pool.query<{ workerUserId: string; passwordHash: string }>(
      `SELECT "workerUserId", "passwordHash"
         FROM "WorkerDeviceIdentity"
        WHERE "workerKey" = $1
          AND "isActive" = true
          AND "revokedAt" IS NULL
          AND "passwordHash" IS NOT NULL
        LIMIT 1`,
      [workerKey],
    );

    if (!rows[0]) {
      // Do NOT cache DB misses — device may be provisioned at any moment.
      log.debug({ workerKey }, 'verifyWorkerCredentials: no active credential row found');
      return null;
    }

    cached = { workerUserId: rows[0].workerUserId, passwordHash: rows[0].passwordHash, cachedAt: now };
    credentialCache.set(workerKey, cached);
  }

  const ok = await bcrypt.compare(plaintext, cached.passwordHash);
  if (ok) {
    log.debug({ workerKey }, 'verifyWorkerCredentials: success');
    return { workerUserId: cached.workerUserId };
  }

  // Wrong password — keep the cache entry (hash is still valid, the caller
  // just sent a bad password). Do not evict.
  log.debug({ workerKey }, 'verifyWorkerCredentials: wrong password');
  return null;
}

/**
 * Evict a single entry from the in-process credential cache. Called by
 * `consumeProvisioning` after a password rotation so that the next ping
 * re-fetches the new hash from the DB.
 */
export function invalidateWorkerCredentialCache(workerKey: string): void {
  credentialCache.delete(workerKey);
}
