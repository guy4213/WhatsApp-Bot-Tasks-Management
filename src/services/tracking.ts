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
import { resolveTaskFieldDestination } from './siteGeocodeCache';
import { getRouteEstimate, type LatLng } from './routeProvider';
import { resolveCalibration } from './workerCalibration';
import {
  sampleProgress,
  readPreviousDisplayedEta,
  commitDisplayedEta,
} from './progressDetector';
import { computeConservativeEta } from './conservativeEta';

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

/**
 * Wolt-lite presentation status — a customer-friendly collapse of the raw
 * `TrackingSessionStatus` plus GPS freshness/proximity, driving the headline
 * copy and the map/route rendering on the public tracking page.
 */
export type PresentationStatus =
  | 'WAITING'
  | 'EN_ROUTE'
  | 'NEARBY'
  | 'ARRIVED'
  | 'COMPLETED'
  | 'STALE_LOCATION'
  | 'UNAVAILABLE'
  | 'EXPIRED';

export interface PublicTrackingView {
  status: TrackingSessionStatus;
  taskFieldStatus: string;
  updatedAt: string;
  lastLocation?: { lat: number; lng: number; at: string; accuracy?: number | null };
  expectedArrivalAt?: string;
  /**
   * Destination site coords + address label. Only present when the session
   * is ACTIVE|ARRIVED AND we successfully resolved `siteAddress` +
   * `siteCity` via the geocoder (migration 017 cache). Terminal statuses
   * never carry this — same discipline as `lastLocation`.
   */
  destination?: { lat: number; lng: number; address?: string };

  // ── TRACK-A additive enrichment (ETA / freshness / presentation) ────────
  /** Ready-made Hebrew headline for the customer page — see `HEADLINES`. */
  headline: string;
  presentationStatus: PresentationStatus;
  /** Mirror of `lastLocation` under the new naming used by the presentation layer. */
  workerLocation?: { lat: number; lng: number; updatedAt: string };
  /** Mirror of `destination` under the new naming used by the presentation layer. */
  destinationLocation?: { lat: number; lng: number; address?: string };
  /**
   * Road route (OSRM) when available and location is fresh; otherwise a
   * straight-line fallback (haversine) so the page always has *something*
   * to draw. `undefined` when there is no worker location or no destination.
   */
  route?: {
    type: 'OSRM' | 'STRAIGHT_LINE';
    geometry: unknown;
    distanceMeters?: number;
    durationSeconds?: number;
  };
  distanceMeters?: number;
  durationSeconds?: number;
  /**
   * Best-available ETA in minutes, per the priority chain in `getPublicView`
   * (fresh OSRM duration > future `expectedArrivalAt` > `travelEtaMinutes`).
   * NOTE: this supersedes the legacy `TaskField.travelEtaMinutes`-only value
   * previously returned here — an intended improvement, not a regression.
   */
  etaMinutes?: number;
  /** Ready-made Hebrew ETA sentence — "זמן הגעה משוער" wording only, never "waze"/traffic language. */
  etaText?: string;
  /** Worker location time if present, else the session's `updatedAt`. */
  lastUpdatedAt?: string;
  locationFreshnessSeconds?: number;
  isLocationFresh: boolean;
  isRouteAvailable: boolean;
  fallbackReason?:
    | 'STALE_LOCATION'
    | 'OSRM_DISABLED'
    | 'OSRM_FAILED'
    | 'NO_DESTINATION'
    | 'NO_LOCATION'
    | 'NO_ETA_SOURCE';
}

const HEADLINES: Record<PresentationStatus, string> = {
  WAITING: 'הבודק יצא לדרך. מיקום חי יופיע בעוד רגע.',
  EN_ROUTE: 'הבודק בדרך אליך',
  NEARBY: 'הבודק קרוב אליך',
  ARRIVED: 'הבודק הגיע לאתר.',
  COMPLETED: 'הבדיקה הסתיימה. תודה.',
  STALE_LOCATION: 'הבודק בדרך אליך',
  UNAVAILABLE: 'המעקב לא זמין כרגע, אך הבודק בדרך.',
  EXPIRED: 'המעקב אינו פעיל',
};

function staleThresholdSeconds(): number {
  const raw = process.env.TRACKING_STALE_SECONDS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 120;
}

function nearbyMeters(): number {
  const raw = process.env.TRACKING_NEARBY_METERS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 300;
}

/** Great-circle distance in meters (haversine) — good enough for a straight-line fallback. */
function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** GeoJSON LineString between two points — note lng,lat coordinate order. */
function straightLineGeometry(a: LatLng, b: LatLng): unknown {
  return {
    type: 'LineString',
    coordinates: [
      [a.lng, a.lat],
      [b.lng, b.lat],
    ],
  };
}

interface JoinedRow {
  taskFieldId: string;
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
  /** `TaskField.departedAt` — anchor for `workerCalibration` freshness window. */
  departedAt: string | null;
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
    `SELECT s."taskFieldId"         AS "taskFieldId",
            s.status,
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
            tf."expectedArrivalAt",
            tf."departedAt"
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
    // Non-optional defaults — overwritten below where applicable.
    headline: '',
    presentationStatus: 'WAITING',
    isLocationFresh: false,
    isRouteAvailable: false,
  };

  const showLocation =
    effectiveStatus === 'ACTIVE' || effectiveStatus === 'ARRIVED';
  const hasLocation = Boolean(showLocation && row.lat != null && row.lng != null && row.liveAt);

  if (hasLocation) {
    view.lastLocation = {
      lat: row.lat as number,
      lng: row.lng as number,
      at: row.liveAt as string,
      accuracy: row.accuracy,
    };
    view.workerLocation = {
      lat: row.lat as number,
      lng: row.lng as number,
      updatedAt: row.liveAt as string,
    };
    const freshnessSeconds = Math.max(0, Math.round((now - new Date(row.liveAt as string).getTime()) / 1000));
    view.locationFreshnessSeconds = freshnessSeconds;
    view.isLocationFresh = freshnessSeconds <= staleThresholdSeconds();
  }

  // Expose the worker's planned arrival stamp for the template — display
  // separate from `etaMinutes`, which is derived by `computeConservativeEta`
  // below.
  if (effectiveStatus === 'ACTIVE' && row.expectedArrivalAt) {
    view.expectedArrivalAt = row.expectedArrivalAt;
  }

  // Destination site (migration 017 + siteGeocodeCache). Only non-terminal
  // sessions get it; terminal statuses match the `lastLocation` discipline
  // and remain destination-less. Resolver is best-effort — a transient
  // geocoder failure returns null and the page falls back to worker-only.
  let hasDestination = false;
  if (showLocation) {
    const dest = await resolveTaskFieldDestination(row.taskFieldId);
    if (dest) {
      hasDestination = true;
      view.destination = { lat: dest.lat, lng: dest.lng, address: dest.address };
      view.destinationLocation = { lat: dest.lat, lng: dest.lng, address: dest.address };
    }
  }

  let fallbackReason: PublicTrackingView['fallbackReason'];

  // Route + distance — ACTIVE only (ARRIVED needs no route; WAITING has no
  // location; terminal statuses show nothing at all).
  if (effectiveStatus === 'ACTIVE') {
    const worker: LatLng | null = hasLocation ? { lat: row.lat as number, lng: row.lng as number } : null;
    const dest: LatLng | null = view.destinationLocation
      ? { lat: view.destinationLocation.lat, lng: view.destinationLocation.lng }
      : null;

    if (!worker) {
      fallbackReason = 'NO_LOCATION';
    } else if (!dest) {
      fallbackReason = 'NO_DESTINATION';
    } else if (!view.isLocationFresh) {
      // Stale: skip the OSRM call entirely — don't burn requests on old coords.
      const distance = haversineMeters(worker, dest);
      view.route = { type: 'STRAIGHT_LINE', geometry: straightLineGeometry(worker, dest), distanceMeters: distance };
      view.distanceMeters = distance;
      fallbackReason = 'STALE_LOCATION';
    } else {
      const distance = haversineMeters(worker, dest);
      // routeProvider picks ORS or OSRM per TRACKING_ROUTE_PROVIDER + handles
      // ORS→OSRM fallback transparently. `route.type = 'OSRM'` stays for the
      // template's road-vs-straight-line branch — the underlying provider is
      // an internal detail.
      const routeEstimate = await getRouteEstimate(worker, dest);
      if (routeEstimate) {
        view.route = {
          type: 'OSRM',
          geometry: routeEstimate.geometry,
          distanceMeters: routeEstimate.distanceMeters,
          durationSeconds: routeEstimate.durationSeconds,
        };
        view.distanceMeters = routeEstimate.distanceMeters;
        view.durationSeconds = routeEstimate.durationSeconds;
        view.isRouteAvailable = true;
      } else {
        view.route = { type: 'STRAIGHT_LINE', geometry: straightLineGeometry(worker, dest), distanceMeters: distance };
        view.distanceMeters = distance;
        const routingConfigured =
          process.env.TRACKING_ROUTE_PROVIDER === 'openrouteservice' ||
          process.env.TRACKING_OSRM_ENABLED === 'true';
        fallbackReason = routingConfigured ? 'OSRM_FAILED' : 'OSRM_DISABLED';
      }
    }
  }

  // presentationStatus — collapse raw session status + freshness/proximity.
  if (effectiveStatus === 'EXPIRED') {
    view.presentationStatus = 'EXPIRED';
  } else if (effectiveStatus === 'FINISHED') {
    view.presentationStatus = 'COMPLETED';
  } else if (effectiveStatus === 'CANCELED' || effectiveStatus === 'SUPERSEDED') {
    view.presentationStatus = 'UNAVAILABLE';
  } else if (effectiveStatus === 'ARRIVED') {
    view.presentationStatus = 'ARRIVED';
  } else {
    // ACTIVE
    if (!hasLocation) {
      view.presentationStatus = 'WAITING';
    } else if (!view.isLocationFresh) {
      view.presentationStatus = 'STALE_LOCATION';
    } else if (hasDestination && view.distanceMeters != null && view.distanceMeters <= nearbyMeters()) {
      view.presentationStatus = 'NEARBY';
    } else {
      view.presentationStatus = 'EN_ROUTE';
    }
  }
  view.headline = HEADLINES[view.presentationStatus];

  // Conservative ETA — replaces the old priority chain.
  //
  // Precedence:
  //  1. Worker calibration (Waze reading × current base route) — best signal.
  //  2. Countdown from `expectedArrivalAt` — survives restart / cache reset.
  //  3. Hourly load multiplier × current base — no-calibration fallback.
  //  4. Raw `travelEtaMinutes` — last resort when there is no base at all.
  //
  // Never presents an ORS/OSRM raw duration without a fallback layer around
  // it. `computeConservativeEta` also handles: last-mile buffer, floor,
  // anti-jump / freeze-on-not-progressing, round-up to 5 min, and the
  // "(הערכה בלבד)" suffix on stale locations.
  if (effectiveStatus === 'ACTIVE') {
    const nowDate = new Date(now);
    const progressState = sampleProgress(token, view.distanceMeters ?? null, nowDate);
    const previousDisplayedEtaMinutes = readPreviousDisplayedEta(token);

    const departedAtDate = row.departedAt ? new Date(row.departedAt) : null;
    const baseRouteSeconds = view.durationSeconds ?? null;
    const calibrationRatio = resolveCalibration({
      taskFieldId: row.taskFieldId,
      travelEtaMinutes: row.travelEtaMinutes,
      departedAt: departedAtDate,
      currentBaseSeconds: baseRouteSeconds,
      now: nowDate,
    });

    const eta = computeConservativeEta({
      baseRouteSeconds,
      calibrationRatio,
      expectedArrivalAt: row.expectedArrivalAt ? new Date(row.expectedArrivalAt) : null,
      travelEtaMinutes: row.travelEtaMinutes,
      progressState,
      isLocationFresh: view.isLocationFresh,
      previousDisplayedEtaMinutes,
      now: nowDate,
    });

    if (eta.etaMinutes != null && eta.etaText != null) {
      view.etaMinutes = eta.etaMinutes;
      view.etaText = eta.etaText;
      commitDisplayedEta(token, eta.etaMinutes, nowDate);
    } else if (!fallbackReason) {
      fallbackReason = 'NO_ETA_SOURCE';
    }
  }

  view.lastUpdatedAt = view.workerLocation?.updatedAt ?? row.updatedAt;
  if (fallbackReason) {
    view.fallbackReason = fallbackReason;
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
