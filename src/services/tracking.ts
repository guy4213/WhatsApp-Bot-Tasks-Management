/**
 * TrackingSession service (Phase-2 live tracking, migration 016).
 *
 * A `TrackingSession` is the customer-facing artifact that connects a
 * TaskField to the worker's live location: opened on "יצאתי" (DEPARTED),
 * marked ARRIVED on "הגעתי", closed on "סיימתי" / cancel / decline.
 *
 * Invariant: at most ONE active session per WORKER at any time. When a worker
 * sends "יצאתי" for a new TaskField while a prior session is still
 * ACTIVE / ARRIVED, `openTrackingSession` closes the prior session as
 * `SUPERSEDED` (endedAt=now()) and opens a fresh session with a new
 * `publicToken`. The "SUPERSEDE + INSERT" is transactional so the partial
 * unique index (`uniq_trackingsession_active_per_worker`) cannot see a
 * conflicting mid-state.
 *
 * The service does NOT touch `TaskField` state — status transitions still go
 * through `advanceFieldStatus()` in `services/inspections.ts`. It also does NOT
 * touch `activeInspection` (worker-facing pointer, `services/conversationContext.ts`).
 * Tracking is a parallel, additive record.
 *
 * All writes go through the shared `pool`. Failures propagate — the caller
 * (router) decides whether tracking failure should block the status write.
 * Current policy: tracking failures are absorbed and logged (fire-and-forget),
 * mirroring `sendWorkerEnRouteNotification`.
 */
import crypto from 'crypto';
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('tracking');

/**
 * Default session lifetime. Matches the `activeInspection` pointer window in
 * `conversationContext.ts` (ACTIVE_WINDOW_MINUTES). If ARRIVED does not fire
 * within this window the session is treated as EXPIRED on read.
 */
const DEFAULT_SESSION_HOURS = 4;

export type TrackingSessionStatus =
  | 'ACTIVE'
  | 'ARRIVED'
  | 'FINISHED'
  | 'CANCELED'
  | 'EXPIRED'
  | 'SUPERSEDED';

export type CloseReason = 'FINISHED' | 'CANCELED' | 'EXPIRED';

export interface OpenSessionParams {
  taskFieldId: string;
  workerUserId: string;
  /** Optional override — otherwise defaults to `startedAt + DEFAULT_SESSION_HOURS`. */
  expiresAt?: Date;
}

export interface OpenSessionResult {
  sessionId: string;
  publicToken: string;
  supersededCount: number; // how many prior worker sessions were closed as SUPERSEDED
}

/** 32-char base64url token, ~192 bits of entropy. Unguessable enough for URL sharing. */
function generatePublicToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Open a TrackingSession for a TaskField. Transactionally supersedes any
 * still-active session belonging to the same worker (regardless of TaskField),
 * then inserts a fresh row.
 *
 * Idempotency: calling twice for the same worker in rapid succession creates
 * TWO rows — the first is SUPERSEDED, the second is ACTIVE. This matches the
 * user rule "always close old, open new on DEPARTED" and avoids resurrecting
 * an old public token.
 */
export async function openTrackingSession(
  p: OpenSessionParams,
): Promise<OpenSessionResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Close ANY still-active session for this worker (usually 0 or 1 rows).
    const superseded = await client.query(
      `UPDATE "TrackingSession"
          SET status      = 'SUPERSEDED',
              "endedAt"   = now(),
              "updatedAt" = now()
        WHERE "workerUserId" = $1
          AND status IN ('ACTIVE','ARRIVED')
      RETURNING id`,
      [p.workerUserId],
    );

    const token = generatePublicToken();
    const expiresAt =
      p.expiresAt ?? new Date(Date.now() + DEFAULT_SESSION_HOURS * 60 * 60 * 1000);

    const insert = await client.query<{ id: string }>(
      `INSERT INTO "TrackingSession"
         ("taskFieldId", "workerUserId", status, "publicToken", "expiresAt")
       VALUES ($1, $2, 'ACTIVE', $3, $4)
       RETURNING id`,
      [p.taskFieldId, p.workerUserId, token, expiresAt.toISOString()],
    );

    await client.query('COMMIT');

    const result: OpenSessionResult = {
      sessionId: insert.rows[0].id,
      publicToken: token,
      supersededCount: superseded.rowCount ?? 0,
    };
    log.info(
      {
        taskFieldId: p.taskFieldId,
        workerUserId: p.workerUserId,
        sessionId: result.sessionId,
        supersededCount: result.supersededCount,
      },
      'TrackingSession opened',
    );
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* best-effort */ });
    log.error(
      { err, taskFieldId: p.taskFieldId, workerUserId: p.workerUserId },
      'openTrackingSession failed',
    );
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark the ACTIVE session for a TaskField as ARRIVED. No-op if there is no
 * active session (e.g., ping arrived after cancel, or the worker never
 * declared "יצאתי").
 */
export async function markArrived(taskFieldId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE "TrackingSession"
        SET status      = 'ARRIVED',
            "arrivedAt" = now(),
            "updatedAt" = now()
      WHERE "taskFieldId" = $1 AND status = 'ACTIVE'`,
    [taskFieldId],
  );
  log.info({ taskFieldId, updated: rowCount }, 'TrackingSession markArrived');
}

/**
 * Close the ACTIVE|ARRIVED session for a TaskField. Idempotent — a second
 * call is a no-op. Used on "סיימתי" (FINISHED), worker DECLINE, manager
 * cancel, and (lazy) expiry.
 */
export async function closeSession(
  taskFieldId: string,
  reason: CloseReason,
): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE "TrackingSession"
        SET status      = $2,
            "endedAt"   = now(),
            "updatedAt" = now()
      WHERE "taskFieldId" = $1 AND status IN ('ACTIVE','ARRIVED')`,
    [taskFieldId, reason],
  );
  log.info({ taskFieldId, reason, updated: rowCount }, 'TrackingSession closed');
}

/**
 * Called by the OwnTracks route on every ping. Bumps `lastLocationAt` on the
 * worker's currently-active session, if any. Silent no-op when the worker
 * has no active session (most pings).
 */
export async function bumpSessionLocation(workerUserId: string): Promise<void> {
  await pool.query(
    `UPDATE "TrackingSession"
        SET "lastLocationAt" = now(),
            "updatedAt"      = now()
      WHERE "workerUserId" = $1 AND status IN ('ACTIVE','ARRIVED')`,
    [workerUserId],
  );
}

// ── Public view (GET /tracking/:token) ────────────────────────────────────

export interface PublicTrackingView {
  status: TrackingSessionStatus;
  taskFieldStatus: string;
  updatedAt: string;
  lastLocation?: { lat: number; lng: number; at: string; accuracy?: number | null };
  etaMinutes?: number;
  expectedArrivalAt?: string;
}

interface JoinedRow {
  status: TrackingSessionStatus;
  fieldStatus: string;
  updatedAt: string;
  arrivedAt: string | null;
  endedAt: string | null;
  expiresAt: string;
  lastLocationAt: string | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  liveAt: string | null;
  travelEtaMinutes: number | null;
  expectedArrivalAt: string | null;
}

/**
 * Resolve a customer-facing tracking token to a safe public view. Returns
 * `null` when the token is unknown — the route MUST map null to 404 without
 * distinguishing between "never existed" and "revoked" (do not leak).
 *
 * Lazy expiry: if the session is still ACTIVE|ARRIVED but `expiresAt` has
 * passed, we return `EXPIRED` (and drop `lastLocation`) without writing to
 * the DB. A future cron sweep can migrate the row to a terminal state.
 */
export async function getPublicView(token: string): Promise<PublicTrackingView | null> {
  const { rows } = await pool.query<JoinedRow>(
    `SELECT s.status,
            tf."fieldStatus"        AS "fieldStatus",
            s."updatedAt",
            s."arrivedAt",
            s."endedAt",
            s."expiresAt",
            s."lastLocationAt",
            wll.lat,
            wll.lng,
            wll.accuracy,
            wll."lastSeenAt"        AS "liveAt",
            tf."travelEtaMinutes",
            tf."expectedArrivalAt"
       FROM "TrackingSession"   s
       JOIN "TaskField"         tf  ON tf.id            = s."taskFieldId"
  LEFT JOIN "WorkerLiveLocation" wll ON wll."workerUserId" = s."workerUserId"
      WHERE s."publicToken" = $1
      LIMIT 1`,
    [token],
  );
  const row = rows[0];
  if (!row) return null;

  // Lazy expiry on read — do not write, just report.
  const isTerminal = ['FINISHED', 'CANCELED', 'EXPIRED', 'SUPERSEDED'].includes(row.status);
  const now = Date.now();
  const expired = !isTerminal && new Date(row.expiresAt).getTime() < now;
  const effectiveStatus: TrackingSessionStatus = expired ? 'EXPIRED' : row.status;

  const view: PublicTrackingView = {
    status: effectiveStatus,
    taskFieldStatus: row.fieldStatus,
    updatedAt: row.updatedAt,
  };

  const showLocation =
    effectiveStatus === 'ACTIVE' || effectiveStatus === 'ARRIVED';
  if (showLocation && row.lat != null && row.lng != null && row.liveAt) {
    view.lastLocation = {
      lat: row.lat,
      lng: row.lng,
      at: row.liveAt,
      accuracy: row.accuracy,
    };
  }
  if (effectiveStatus === 'ACTIVE' && row.travelEtaMinutes != null) {
    view.etaMinutes = row.travelEtaMinutes;
  }
  if (effectiveStatus === 'ACTIVE' && row.expectedArrivalAt) {
    view.expectedArrivalAt = row.expectedArrivalAt;
  }
  return view;
}

// ── Debug view (GET /tracking/debug/sessions) ─────────────────────────────

export interface DebugSessionRow {
  id: string;
  taskFieldId: string;
  workerUserId: string;
  status: TrackingSessionStatus;
  startedAt: string;
  arrivedAt: string | null;
  endedAt: string | null;
  expiresAt: string;
  lastLocationAt: string | null;
  publicToken: string;
}

/** All non-terminal sessions, most-recent first. Internal only. */
export async function listActiveSessions(): Promise<DebugSessionRow[]> {
  const { rows } = await pool.query<DebugSessionRow>(
    `SELECT id,
            "taskFieldId",
            "workerUserId",
            status,
            "startedAt",
            "arrivedAt",
            "endedAt",
            "expiresAt",
            "lastLocationAt",
            "publicToken"
       FROM "TrackingSession"
      WHERE status IN ('ACTIVE','ARRIVED')
      ORDER BY "startedAt" DESC`,
  );
  return rows;
}
