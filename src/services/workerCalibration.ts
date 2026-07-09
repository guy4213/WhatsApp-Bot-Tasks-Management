/**
 * Worker calibration cache — the primary signal for Conservative ETA.
 *
 * Idea (product-locked): the worker sees a real Waze reading at the moment of
 * "יצאתי". That number reflects LIVE traffic, road works, weather — all the
 * things ORS/OSRM cannot know. We treat it as a per-session calibration:
 *
 *   ratio = workerEtaSeconds / baseRouteSecondsAtDeparture
 *
 * Every subsequent customer poll multiplies the CURRENT base route (which
 * shrinks as the worker drives closer) by this ratio to derive the displayed
 * ETA. The worker's realtime traffic knowledge is projected onto the
 * dynamically-changing distance.
 *
 * Storage: in-memory Map<taskFieldId, entry>. Deliberately not in the DB
 * (per the "no schema changes now" constraint). Trade-offs the user has
 * accepted:
 *  - Process restart clears the cache; callers fall back to a countdown
 *    derived from `TaskField.expectedArrivalAt`, then hourly multiplier.
 *  - Multi-instance: each replica has its own cache; two replicas may
 *    briefly disagree until both fall back to countdown. Non-issue at
 *    current fleet scale.
 *
 * We only capture a NEW calibration when we're within `MAX_DEPARTURE_LAG_MS`
 * of the "יצאתי" moment. That guarantees `currentBaseSeconds` really is the
 * base-at-departure and not the base after the worker has already driven a
 * significant chunk of the route. Outside that window we return `null` and
 * defer to the countdown fallback.
 *
 * A cached ratio is trusted for `TTL_MS` (4h — matches session lifetime), and
 * clamped to a sane range so a mis-typed `travelEtaMinutes` (e.g. 5 instead
 * of 55) can't invert or explode subsequent displayed ETAs.
 *
 * Naming: this is `worker calibration` / `conservative ETA`. Never "traffic
 * factor" — we do not have live traffic.
 */
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('workerCalibration');

// ── Constants (code defaults, not env) ────────────────────────────────────
const TTL_MS                    = 4 * 60 * 60 * 1000;   // 4h — session window
// Widened 2026-07-09 (2nd iteration after field test): 10 min was still often
// too tight because a customer opens the link, browses / reads the WhatsApp
// context, and only THEN triggers the first poll. 20 min covers realistic
// open-times without stretching the base-shrink error too far. Later captures
// than this fall to the hourly path (still location-driven — see
// conservativeEta.pickRawSeconds).
const MAX_DEPARTURE_LAG_MS      = 20 * 60 * 1000;       // 20 min post-DEPARTED
const RATIO_MIN                 = 0.5;
const RATIO_MAX                 = 5.0;

interface CalibrationEntry {
  ratio: number;
  /** `baseRouteSeconds` observed when the ratio was captured. Kept for debug/tests only. */
  baseAtDepartureSeconds: number;
  capturedAt: number; // Date.now()
}

const calibrationCache = new Map<string, CalibrationEntry>();

// ── Test-only hooks ──────────────────────────────────────────────────────

/** Test-only: clear the calibration cache between test cases. */
export function _clearCalibrationCache(): void {
  calibrationCache.clear();
}

/** Test-only: seed a calibration entry directly (bypasses the departure window). */
export function _seedCalibration(taskFieldId: string, ratio: number, baseAtDepartureSeconds = 0, capturedAt = Date.now()): void {
  calibrationCache.set(taskFieldId, { ratio, baseAtDepartureSeconds, capturedAt });
}

/** Test-only: peek at a cached entry without mutating anything. */
export function _peekCalibration(taskFieldId: string): CalibrationEntry | undefined {
  return calibrationCache.get(taskFieldId);
}

// ── Public API ───────────────────────────────────────────────────────────

export interface ResolveCalibrationInput {
  taskFieldId: string;
  travelEtaMinutes: number | null;
  departedAt: Date | null;
  currentBaseSeconds: number | null;
  now: Date;
}

/**
 * Return the calibration ratio for this TaskField, computing and caching it
 * on first observation when the departure is fresh.
 *
 * Returns `null` when a ratio cannot be trusted:
 *  - No `travelEtaMinutes` from the worker.
 *  - We missed the departure window (server restarted / poll arrived late).
 *  - Missing base route or non-positive values.
 *  - Ratio outside the sanity range (`RATIO_MIN`..`RATIO_MAX`).
 *
 * `null` is a normal, expected value — the caller falls back to countdown
 * from `expectedArrivalAt`, then the hourly load multiplier.
 */
export function resolveCalibration(input: ResolveCalibrationInput): number | null {
  const { taskFieldId, travelEtaMinutes, departedAt, currentBaseSeconds, now } = input;

  // Cache hit within TTL wins outright, even after the departure window
  // closes — the ratio is per-session by design.
  const cached = calibrationCache.get(taskFieldId);
  if (cached) {
    if (now.getTime() - cached.capturedAt < TTL_MS) {
      return cached.ratio;
    }
    calibrationCache.delete(taskFieldId);
  }

  // Can we compute a fresh one?
  if (travelEtaMinutes == null || travelEtaMinutes <= 0) return null;
  if (!departedAt) return null;
  if (currentBaseSeconds == null || !Number.isFinite(currentBaseSeconds) || currentBaseSeconds <= 0) return null;

  const lag = now.getTime() - departedAt.getTime();
  if (lag < 0 || lag > MAX_DEPARTURE_LAG_MS) {
    // Outside the safe departure window: what we'd measure now as the base is
    // no longer a proxy for base-at-departure.
    return null;
  }

  const workerEtaSeconds = travelEtaMinutes * 60;
  const rawRatio = workerEtaSeconds / currentBaseSeconds;

  if (!Number.isFinite(rawRatio)) return null;
  if (rawRatio < RATIO_MIN || rawRatio > RATIO_MAX) {
    log.warn(
      { taskFieldId, rawRatio, workerEtaSeconds, currentBaseSeconds },
      'calibration ratio out of sane range — discarding',
    );
    return null;
  }

  calibrationCache.set(taskFieldId, {
    ratio: rawRatio,
    baseAtDepartureSeconds: currentBaseSeconds,
    capturedAt: now.getTime(),
  });
  log.info(
    { taskFieldId, ratio: rawRatio, baseAtDepartureSeconds: currentBaseSeconds, workerEtaSeconds },
    'calibration captured',
  );
  return rawRatio;
}
