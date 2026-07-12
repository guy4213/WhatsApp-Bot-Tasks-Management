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
 * Priority stack (first available wins) — ALL sources except `worker_only`
 * are location-driven. The displayed value must NOT decrement between GPS
 * polls; time-based countdown was removed on 2026-07-09 after the customer
 * complained that the ETA changed without the worker actually driving.
 *
 *   1. Worker calibration ratio × currentBase   ← reflects Waze at "יצאתי"
 *   2. Hourly load multiplier × currentBase     ← no-calibration fallback
 *   3. Worker's raw `travelEtaMinutes`          ← if no GPS/base at all
 *                                                (constant — no decrement)
 *
 * After picking the raw seconds, the following layers ALWAYS run in order:
 *   A. `progressState` modifier: `slow` multiplies by 1.25.
 *   B. Buffer (parking + finding the door) — 3 min mid-route, 1 min once we're
 *      basically there (`isLastMile`).
 *   C. Floor at `MIN_DISPLAY_MINUTES` (1 min in the last mile).
 *   D. Gentle anti-jitter: cap a DROP at `MAX_REDUCTION_PCT` % vs the last
 *      shown ETA — but ONLY outside the last mile, and with NO freeze.
 *   E. Round UP to the next boundary (5 min mid-route, 1 min in the last mile).
 *   F. Hebrew text: "זמן הגעה משוער: N דקות" (+ " (הערכה בלבד)" when stale).
 *
 * ── Why there is no "freeze" any more (changed 2026-07-09, 2nd field test) ──
 * Earlier this composer FROZE the ETA (blocked any decrease) whenever the
 * progress detector said `not_progressing`, and capped drops at only 25%/poll.
 * In the field that made the number "stick" high — not just at the doorstep
 * but across the whole slow approach: city driving covers < the detector's
 * threshold per window, and the movement-gated route cache only recomputes the
 * base every ~75 m, so a creeping worker looked "stuck" and the ETA refused to
 * come down. Since the time-based countdown was already removed, a genuinely
 * stationary worker ALREADY has a flat ETA (the base route doesn't shrink while
 * the movement-gated cache holds it) — so the freeze was redundant AND harmful.
 * It's gone. The ETA now simply follows the real remaining road: it moves only
 * when the worker moves, and it comes down honestly on the approach. A single
 * loose drop-cap (outside the last mile) is kept purely to smooth a one-poll
 * route glitch, never to hold the number back.
 *
 * Returns `{ etaMinutes: null, etaText: null }` when there is no source at
 * all — the caller then sets `fallbackReason = 'NO_ETA_SOURCE'` and shows no
 * ETA line.
 */
import { getHourlyLoadMultiplier } from './hourlyLoadMultiplier';
import type { ProgressState } from './progressDetector';

// ── Constants (code defaults, not env) ────────────────────────────────────
const NORMAL_BUFFER_SECONDS     = 180;   // 3 min for parking + entrance, mid-route
const LAST_MILE_BUFFER_SECONDS  = 60;    // 1 min once we're basically there
const MIN_DISPLAY_MINUTES       = 3;
const LAST_MILE_MIN_MINUTES     = 1;
const ROUND_UP_MINUTES          = 5;
const LAST_MILE_ROUND_MINUTES   = 1;
const MAX_REDUCTION_PCT         = 50;    // loose smoothing only; NOT applied in the last mile
const SLOW_PROGRESS_FACTOR      = 1.25;  // "slow" progress bump
// Base road time (provider's raw duration to destination, pre-ratio) below
// which we treat the worker as "approaching" and let the ETA collapse freely:
// smaller buffer, finer rounding, no drop-cap. Keyed on the pure base so the
// traffic ratio can't keep us out of the last-mile regime near the door.
const LAST_MILE_BASE_SECONDS    = 300;   // < 5 min of road left

/** Which layer supplied the raw seconds — internal, useful for logs/tests. */
export type EtaSource = 'calibration' | 'hourly' | 'worker_only';

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
  /** DEPRECATED — the freeze was removed 2026-07-09; always `false`. Kept for
   *  output-shape stability so callers/tests don't need a type change. */
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

  // "Approaching" regime — keyed on the pure base route (pre-ratio) so the
  // ETA collapses honestly near the door instead of sticking.
  const base = input.baseRouteSeconds;
  const isLastMile =
    base != null && Number.isFinite(base) && base > 0 && base < LAST_MILE_BASE_SECONDS;

  // ── Layer A: progress modifier ─────────────────────────────────────────
  if (input.progressState === 'slow') {
    seconds *= SLOW_PROGRESS_FACTOR;
  }

  // ── Layer B: buffer (smaller once we're basically there) ───────────────
  seconds += isLastMile ? LAST_MILE_BUFFER_SECONDS : NORMAL_BUFFER_SECONDS;

  // ── Layer C: floor ─────────────────────────────────────────────────────
  const floorMinutes = isLastMile ? LAST_MILE_MIN_MINUTES : MIN_DISPLAY_MINUTES;
  if (seconds < floorMinutes * 60) seconds = floorMinutes * 60;

  // ── Layer D: gentle anti-jitter (NO freeze) ────────────────────────────
  // Cap a single-poll DROP vs the last shown ETA, purely to smooth a one-poll
  // route glitch — NOT to hold the number back. Skipped entirely in the last
  // mile so the ETA can come all the way down as the worker reaches the door.
  // There is deliberately no `not_progressing` freeze (see the header): a
  // stationary worker already has a flat ETA because the base route doesn't
  // shrink, so freezing only ever blocked legitimate decreases.
  if (!isLastMile) {
    const prev = input.previousDisplayedEtaMinutes;
    if (prev != null && Number.isFinite(prev) && prev > 0) {
      const minAllowed = prev * 60 * (1 - MAX_REDUCTION_PCT / 100);
      if (seconds < minAllowed) seconds = minAllowed;
    }
  }

  // ── Layer E: round UP (finer near the door) ────────────────────────────
  const roundMinutes = isLastMile ? LAST_MILE_ROUND_MINUTES : ROUND_UP_MINUTES;
  const etaMinutes = Math.max(
    floorMinutes,
    Math.ceil((seconds / 60) / roundMinutes) * roundMinutes,
  );

  // ── Layer F: text ──────────────────────────────────────────────────────
  const suffix = input.isLocationFresh ? '' : ' (הערכה בלבד)';
  const etaText = `זמן הגעה משוער: ${etaMinutes} דקות${suffix}`;

  // `frozen` is retained in the output shape for stability but is always false
  // now that the freeze is gone — kept so callers/tests don't need a type change.
  return { etaMinutes, etaText, source, frozen: false };
}

// ── Internals ────────────────────────────────────────────────────────────

function pickRawSeconds(input: ConservativeEtaInput): { seconds: number; source: EtaSource } | null {
  // 1. Calibration × current base — worker's Waze reading applied dynamically
  //    to the current GPS-driven route length. Location-driven ✓.
  if (
    input.calibrationRatio != null &&
    Number.isFinite(input.calibrationRatio) &&
    input.baseRouteSeconds != null &&
    Number.isFinite(input.baseRouteSeconds) &&
    input.baseRouteSeconds > 0
  ) {
    return { seconds: input.baseRouteSeconds * input.calibrationRatio, source: 'calibration' };
  }

  // 2. Hourly load multiplier × current base. Also location-driven ✓ — the
  //    value shrinks only when a new GPS poll gives a shorter base route.
  //    Deliberately does NOT depend on `expectedArrivalAt`, so the customer
  //    doesn't see the ETA drop while the worker is standing still.
  if (
    input.baseRouteSeconds != null &&
    Number.isFinite(input.baseRouteSeconds) &&
    input.baseRouteSeconds > 0
  ) {
    const factor = getHourlyLoadMultiplier(input.now);
    return { seconds: input.baseRouteSeconds * factor, source: 'hourly' };
  }

  // 3. Worker's raw `travelEtaMinutes` — only when there is no base at all
  //    (typically means "no GPS yet"). CONSTANT until a poll returns GPS —
  //    never a time-based decrement.
  if (input.travelEtaMinutes != null && input.travelEtaMinutes > 0) {
    return { seconds: input.travelEtaMinutes * 60, source: 'worker_only' };
  }

  return null;
}
