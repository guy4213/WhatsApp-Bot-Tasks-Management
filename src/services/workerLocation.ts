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
 * Both functions are best-effort in the caller context: the OwnTracks route
 * ALWAYS acks 200 with `[]`, and a failure here must not back up the phone's
 * upload queue. The caller decides whether to log + swallow.
 */
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('worker-location');

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
