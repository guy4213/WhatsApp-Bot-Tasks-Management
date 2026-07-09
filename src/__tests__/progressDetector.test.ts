/**
 * Behavioral tests for `services/progressDetector.ts`.
 *
 * Covers:
 *  - Progress classification against a 2-min window (need an old sample).
 *  - 'unknown' when we don't yet have enough history (first poll, or all
 *    samples within window).
 *  - 'progressing' vs 'slow' vs 'not_progressing' thresholds (500m / 100m).
 *  - Last-displayed-ETA read/commit for the anti-jump layer.
 *  - Null / non-finite distance → 'unknown'.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  sampleProgress,
  readPreviousDisplayedEta,
  commitDisplayedEta,
  _clearSessionState,
  _peekSession,
} from '../services/progressDetector';

const T = 'sess-token-xyz';
const T0 = new Date('2026-07-08T10:00:00.000Z');

function later(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

beforeEach(() => {
  _clearSessionState();
});
afterEach(() => {
  _clearSessionState();
});

describe('sampleProgress — classification', () => {
  it("returns 'unknown' on the first sample (no history)", () => {
    expect(sampleProgress(T, 10_000, T0)).toBe('unknown');
  });

  it("stays 'unknown' while all samples are inside the 2-min window", () => {
    sampleProgress(T, 10_000, T0);
    expect(sampleProgress(T, 9_000, later(60))).toBe('unknown');
    expect(sampleProgress(T, 8_000, later(90))).toBe('unknown');
  });

  it("classifies 'progressing' when the worker closed > 500m in the 2-min window", () => {
    sampleProgress(T, 10_000, T0);
    // 130s later, closed 800m — well over the 500m threshold.
    expect(sampleProgress(T, 9_200, later(130))).toBe('progressing');
  });

  it("classifies 'slow' when delta is between 100m and 500m", () => {
    sampleProgress(T, 10_000, T0);
    expect(sampleProgress(T, 9_700, later(130))).toBe('slow'); // 300m closed
  });

  it("classifies 'not_progressing' when delta is <= 100m", () => {
    sampleProgress(T, 10_000, T0);
    expect(sampleProgress(T, 9_950, later(130))).toBe('not_progressing'); // 50m closed
  });

  it("classifies 'not_progressing' when distance goes up (worker moved away)", () => {
    sampleProgress(T, 10_000, T0);
    expect(sampleProgress(T, 10_200, later(130))).toBe('not_progressing');
  });
});

describe('sampleProgress — null / invalid inputs', () => {
  it("returns 'unknown' when currentDistanceMeters is null", () => {
    sampleProgress(T, 10_000, T0);
    expect(sampleProgress(T, null, later(130))).toBe('unknown');
  });

  it("returns 'unknown' when currentDistanceMeters is NaN", () => {
    sampleProgress(T, 10_000, T0);
    expect(sampleProgress(T, Number.NaN, later(130))).toBe('unknown');
  });
});

describe('sampleProgress — retention & ring', () => {
  it('trims samples older than 4 min so the ring does not grow unbounded', () => {
    for (let i = 0; i < 20; i++) {
      sampleProgress(T, 10_000 - i * 100, later(30 * i));
    }
    const state = _peekSession(T);
    // MAX_SAMPLES=8; every sample here is inside the 4-min prune window at
    // the final sample time, so the cap is what limits us.
    expect(state?.samples.length).toBeLessThanOrEqual(8);
  });
});

describe('displayed-ETA read/commit', () => {
  it('returns null before any commit', () => {
    expect(readPreviousDisplayedEta(T)).toBeNull();
  });

  it('remembers the last committed value', () => {
    commitDisplayedEta(T, 25, T0);
    expect(readPreviousDisplayedEta(T)).toBe(25);
    commitDisplayedEta(T, 20, later(60));
    expect(readPreviousDisplayedEta(T)).toBe(20);
  });

  it('accepts null commit (clears the memory when we stop showing a number)', () => {
    commitDisplayedEta(T, 25, T0);
    commitDisplayedEta(T, null, later(60));
    expect(readPreviousDisplayedEta(T)).toBeNull();
  });

  it('is per-session — different tokens do not cross-contaminate', () => {
    commitDisplayedEta('A', 25, T0);
    commitDisplayedEta('B', 40, T0);
    expect(readPreviousDisplayedEta('A')).toBe(25);
    expect(readPreviousDisplayedEta('B')).toBe(40);
  });
});
