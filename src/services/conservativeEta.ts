/**
 * Conservative ETA composer — the pure function that produces the number
 * (and Hebrew text) shown on the customer tracking page.
 *
 * The name is deliberate: NOT "traffic ETA". ORS / OSRM give a free-flow
 * static duration; there is no live traffic model behind any of this. Every
 * layer here is either a worker-provided signal (Waze reading captured at
 * "יצאתי"), a straightforward countdown, or a hand-tuned conservative
 * fallback. Callers, comments, logs — none of them may say "traffic".
 *
 * Priority stack (first available wins):
 *   1. Worker calibration ratio × currentBase   ← reflects live Waze at "יצאתי"
 *   2. Countdown from `expectedArrivalAt`       ← countdown from worker's declaration
 *   3. Hourly load multiplier × currentBase     ← rush-hour aware fallback
 *   4. Worker's raw `travelEtaMinutes`          ← if no GPS/base at all
 *
 * After picking the raw seconds, the following layers ALWAYS run in order:
 *   A. `progressState` modifier:
 *      - `not_progressing` never decreases the previously-shown ETA.
 *      - `slow`            multiplies by 1.25.
 *   B. `+ LAST_MILE_BUFFER_SECONDS` (parking + finding the door).
 *   C. Floor at `MIN_DISPLAY_MINUTES`.
 *   D. Anti-jump: no more than `MAX_REDUCTION_PCT` % drop from the last shown
 *      ETA (except when raising).
 *   E. Round UP to the next `ROUND_UP_MINUTES` boundary (only ever generous
 *      to the customer).
 *   F. Hebrew text: "זמן הגעה משוער: N דקות" (+ " (הערכה בלבד)" when stale).
 *
 * Returns `{ etaMinutes: null, etaText: null }` when there is no source at
 * all — the caller then sets `fallbackReason = 'NO_ETA_SOURCE'` and shows no
 * ETA line.
 */
import { getHourlyLoadMultiplier } from './hourlyLoadMultiplier';
import type { ProgressState } from './progressDetector';

// ── Constants (code defaults, not env) ────────────────────────────────────
const LAST_MILE_BUFFER_SECONDS  = 180;   // 3 min for parking + entrance
const MIN_DISPLAY_MINUTES       = 3;
const ROUND_UP_MINUTES          = 5;
const MAX_REDUCTION_PCT         = 25;    // never drop the shown ETA more than 25% per poll
const SLOW_PROGRESS_FACTOR      = 1.25;  // "slow" progress bump

/** Which layer supplied the raw seconds — internal, useful for logs/tests. */
export type EtaSource = 'calibration' | 'countdown' | 'hourly' | 'worker_only';

export interface ConservativeEtaInput {
  /** Fresh route duration from ORS/OSRM. `null` when there is no GPS or no route. */
  baseRouteSeconds: number | null;
  /** Ratio from `workerCalibration.ts` — `null` when unavailable. */
  calibrationRatio: number | null;
  /** `TaskField.expectedArrivalAt` — worker's declaration projected forward. */
  expectedArrivalAt: Date | null;
  /** `TaskField.travelEtaMinutes` — worker's raw Waze number (falls back to this only when no GPS at all). */
  travelEtaMinutes: number | null;
  progressState: ProgressState;
  /** `true` when the last GPS ping is within the freshness window. */
  isLocationFresh: boolean;
  /** Last displayed ETA (from `progressDetector.readPreviousDisplayedEta`); `null` on first poll. */
  previousDisplayedEtaMinutes: number | null;
  /** "Now" — injected for testability. */
  now: Date;
}

export interface ConservativeEtaOutput {
  /** ETA to show, in minutes, already rounded up to `ROUND_UP_MINUTES`. `null` = show no number. */
  etaMinutes: number | null;
  /** Ready-to-render Hebrew text. `null` when there is no number to show. */
  etaText: string | null;
  /** Which layer produced the raw seconds. `null` when nothing was available. */
  source: EtaSource | null;
  /** Was the anti-progress freeze engaged? (Test-visible signal.) */
  frozen: boolean;
}

/**
 * Compose the Conservative ETA for one poll. Pure function — safe to unit
 * test with pinned dates.
 */
export function computeConservativeEta(input: ConservativeEtaInput): ConservativeEtaOutput {
  // ── Layer 0: pick the raw seconds ──────────────────────────────────────
  const picked = pickRawSeconds(input);
  if (!picked) {
    return { etaMinutes: null, etaText: null, source: null, frozen: false };
  }
  let seconds = picked.seconds;
  const source = picked.source;

  // ── Layer A: progress modifier (except freeze — that runs after clamps) ─
  if (input.progressState === 'slow') {
    seconds *= SLOW_PROGRESS_FACTOR;
  }

  // ── Layer B: last-mile buffer ──────────────────────────────────────────
  seconds += LAST_MILE_BUFFER_SECONDS;

  // ── Layer C: floor ─────────────────────────────────────────────────────
  const minSeconds = MIN_DISPLAY_MINUTES * 60;
  if (seconds < minSeconds) seconds = minSeconds;

  // ── Layer D+A': anti-jump / freeze based on progressState ──────────────
  let frozen = false;
  const prev = input.previousDisplayedEtaMinutes;
  if (prev != null && Number.isFinite(prev) && prev > 0) {
    const prevSeconds = prev * 60;
    if (input.progressState === 'not_progressing') {
      // Freeze: never let the shown ETA drop while the worker isn't moving.
      if (seconds < prevSeconds) {
        seconds = prevSeconds;
        frozen = true;
      }
    } else {
      // Standard anti-jump: cap drop to MAX_REDUCTION_PCT.
      const minAllowed = prevSeconds * (1 - MAX_REDUCTION_PCT / 100);
      if (seconds < minAllowed) seconds = minAllowed;
    }
  }

  // ── Layer E: round UP to next ROUND_UP_MINUTES ─────────────────────────
  const rawMinutes = seconds / 60;
  const etaMinutes = Math.max(
    MIN_DISPLAY_MINUTES,
    Math.ceil(rawMinutes / ROUND_UP_MINUTES) * ROUND_UP_MINUTES,
  );

  // ── Layer F: text ──────────────────────────────────────────────────────
  const suffix = input.isLocationFresh ? '' : ' (הערכה בלבד)';
  const etaText = `זמן הגעה משוער: ${etaMinutes} דקות${suffix}`;

  return { etaMinutes, etaText, source, frozen };
}

// ── Internals ────────────────────────────────────────────────────────────

function pickRawSeconds(input: ConservativeEtaInput): { seconds: number; source: EtaSource } | null {
  // 1. Calibration × current base — worker's Waze reading applied dynamically
  //    to the current GPS-driven route length.
  if (
    input.calibrationRatio != null &&
    Number.isFinite(input.calibrationRatio) &&
    input.baseRouteSeconds != null &&
    Number.isFinite(input.baseRouteSeconds) &&
    input.baseRouteSeconds > 0
  ) {
    return { seconds: input.baseRouteSeconds * input.calibrationRatio, source: 'calibration' };
  }

  // 2. Countdown from expectedArrivalAt — worker declared "I'll arrive at X",
  //    we count down the remaining time. Handles server restart / multi-instance
  //    gracefully because the timestamp is in the DB.
  if (input.expectedArrivalAt) {
    const remainingMs = input.expectedArrivalAt.getTime() - input.now.getTime();
    if (remainingMs > 0) {
      return { seconds: remainingMs / 1000, source: 'countdown' };
    }
    // Past the arrival deadline — fall through to hourly/worker so we don't
    // show a negative countdown.
  }

  // 3. Hourly load multiplier applied to the current base route. This is the
  //    "no worker calibration" fallback for a customer who opens the page
  //    without the driver having entered a Waze reading (or after cache reset).
  if (
    input.baseRouteSeconds != null &&
    Number.isFinite(input.baseRouteSeconds) &&
    input.baseRouteSeconds > 0
  ) {
    const factor = getHourlyLoadMultiplier(input.now);
    return { seconds: input.baseRouteSeconds * factor, source: 'hourly' };
  }

  // 4. Worker's raw `travelEtaMinutes` — only when there is no base at all
  //    (typically means "no GPS yet"). Better than nothing.
  if (input.travelEtaMinutes != null && input.travelEtaMinutes > 0) {
    return { seconds: input.travelEtaMinutes * 60, source: 'worker_only' };
  }

  return null;
}
