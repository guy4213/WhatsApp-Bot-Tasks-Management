/**
 * Session-scoped state for Conservative ETA — progress detection + last
 * displayed ETA (for anti-jump).
 *
 * Progress detection: given the worker's current distance-to-destination on
 * every poll, classify the session as `progressing` / `slow` / `not_progressing`
 * or `unknown` (when we don't yet have enough history). We hold a small
 * per-session ring of distance samples in memory and compare the most recent
 * sample against one at least `PROGRESS_WINDOW_MS` (2 min) old. This avoids
 * relying on the ping table directly — the tracking flow already computes
 * `distanceMeters` on every poll, so we simply piggyback on it.
 *
 * Anti-jump state: to prevent the customer-facing ETA from dropping too much
 * between adjacent polls, we remember the last displayed ETA (in minutes) per
 * session token and expose read/commit helpers for `conservativeEta.ts` to
 * clamp with.
 *
 * Storage is in-memory only (Map keyed by tracking `publicToken`) — same
 * multi-instance / restart trade-off as `workerCalibration.ts`: on restart or
 * unfamiliar replica, we simply lose history and the caller decays into
 * "unknown" until enough samples accumulate.
 */
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('progressDetector');

// ── Constants (code defaults, not env) ────────────────────────────────────
const PROGRESS_WINDOW_MS        = 120_000;   // 2 min
const PROGRESSING_DELTA_METERS  = 500;       // > 500m → progressing
const STALL_DELTA_METERS        = 100;       // < 100m → not_progressing
const SESSION_TTL_MS            = 4 * 60 * 60 * 1000; // 4h — matches session lifetime
const MAX_SAMPLES               = 8;         // ring cap; well over what a 2-min window needs
const SAMPLE_MAX_AGE_MS         = PROGRESS_WINDOW_MS * 2; // prune above this

export type ProgressState = 'progressing' | 'slow' | 'not_progressing' | 'unknown';

interface Sample {
  distanceMeters: number;
  sampledAt: number;
}

interface SessionState {
  samples: Sample[];
  lastDisplayedEtaMinutes: number | null;
  lastTouchedAt: number;
}

const sessions = new Map<string, SessionState>();

// ── Test-only hooks ──────────────────────────────────────────────────────

/** Test-only: clear session state between test cases. */
export function _clearSessionState(): void {
  sessions.clear();
}

/** Test-only: peek at the current state for a session (undefined if unknown). */
export function _peekSession(token: string): SessionState | undefined {
  return sessions.get(token);
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Sample the current distance-to-destination and classify progress.
 *
 * Guarantees:
 *  - Never returns 'progressing' etc. before we have a sample at least
 *    `PROGRESS_WINDOW_MS` old → falls back to 'unknown', which the caller
 *    treats as "no anti-progress action" (a fresh session shouldn't be
 *    penalized for having no history yet).
 *  - Callers pass distance in meters; a `null` or non-finite value skips the
 *    sample entirely (returns 'unknown').
 */
export function sampleProgress(
  sessionToken: string,
  currentDistanceMeters: number | null | undefined,
  now: Date = new Date(),
): ProgressState {
  const nowMs = now.getTime();
  pruneStaleSessions(nowMs);

  if (currentDistanceMeters == null || !Number.isFinite(currentDistanceMeters)) {
    return 'unknown';
  }

  const state = getOrCreateSession(sessionToken, nowMs);

  // Compare BEFORE recording the new sample — otherwise the "old" reference
  // would be the same tick we just added.
  const oldest = findOldestInWindow(state.samples, nowMs);
  let progressState: ProgressState;
  if (!oldest) {
    progressState = 'unknown';
  } else {
    const delta = oldest.distanceMeters - currentDistanceMeters;
    if (delta >= PROGRESSING_DELTA_METERS) {
      progressState = 'progressing';
    } else if (delta <= STALL_DELTA_METERS) {
      progressState = 'not_progressing';
    } else {
      progressState = 'slow';
    }
  }

  state.samples.push({ distanceMeters: currentDistanceMeters, sampledAt: nowMs });
  state.lastTouchedAt = nowMs;

  // Trim ring: keep chronological order, drop old / excess.
  state.samples = state.samples
    .filter((s) => nowMs - s.sampledAt <= SAMPLE_MAX_AGE_MS)
    .slice(-MAX_SAMPLES);

  return progressState;
}

/**
 * Previously-shown ETA for this session (`null` if we haven't shown one yet).
 * `conservativeEta.ts` uses this for the anti-jump clamp.
 */
export function readPreviousDisplayedEta(sessionToken: string): number | null {
  return sessions.get(sessionToken)?.lastDisplayedEtaMinutes ?? null;
}

/**
 * Record the ETA the caller ended up showing to the customer. `null` clears
 * (useful when the session transitions to a state without an ETA number,
 * e.g. STALE_LOCATION with "הערכה בלבד").
 */
export function commitDisplayedEta(
  sessionToken: string,
  minutes: number | null,
  now: Date = new Date(),
): void {
  const nowMs = now.getTime();
  const state = getOrCreateSession(sessionToken, nowMs);
  state.lastDisplayedEtaMinutes = minutes;
  state.lastTouchedAt = nowMs;
}

// ── Internals ────────────────────────────────────────────────────────────

function getOrCreateSession(token: string, nowMs: number): SessionState {
  const existing = sessions.get(token);
  if (existing) return existing;
  const fresh: SessionState = {
    samples: [],
    lastDisplayedEtaMinutes: null,
    lastTouchedAt: nowMs,
  };
  sessions.set(token, fresh);
  return fresh;
}

/**
 * Find the oldest sample that is still at least `PROGRESS_WINDOW_MS` old.
 * If nothing that old is in the ring, return null — the caller returns
 * 'unknown'.
 */
function findOldestInWindow(samples: Sample[], nowMs: number): Sample | null {
  let bestOld: Sample | null = null;
  for (const s of samples) {
    if (nowMs - s.sampledAt >= PROGRESS_WINDOW_MS) {
      if (!bestOld || s.sampledAt < bestOld.sampledAt) bestOld = s;
    }
  }
  return bestOld;
}

/**
 * Best-effort cleanup so long-running processes don't leak sessions for
 * TaskFields that ended without a terminal callback. Runs cheaply on every
 * tick — Map iteration over a handful of entries in practice.
 */
function pruneStaleSessions(nowMs: number): void {
  for (const [token, state] of sessions) {
    if (nowMs - state.lastTouchedAt > SESSION_TTL_MS) {
      sessions.delete(token);
      log.debug({ token }, 'pruned stale progress session');
    }
  }
}
