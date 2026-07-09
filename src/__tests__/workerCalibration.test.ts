/**
 * Behavioral tests for `services/workerCalibration.ts`.
 *
 * Verifies the calibration ratio math + cache lifecycle:
 *  - Fresh capture within the 5-min departure window.
 *  - Cache hits ignore the departure window (per-session lock-in).
 *  - Refuses to capture out-of-window (server restarts, late polls).
 *  - Sanity clamps: ratio outside 0.5..5.0 is discarded.
 *  - Missing inputs → null (worker never entered ETA / no base yet).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveCalibration,
  _clearCalibrationCache,
  _seedCalibration,
  _peekCalibration,
} from '../services/workerCalibration';

const TF = 'tf-abc-123';
const T0 = new Date('2026-07-08T10:00:00.000Z');

beforeEach(() => {
  _clearCalibrationCache();
});
afterEach(() => {
  _clearCalibrationCache();
});

describe('resolveCalibration — happy path', () => {
  it('captures ratio = workerEtaSeconds / currentBaseSeconds on first call', () => {
    // Worker says 55 min via Waze; ORS base = 24 min at departure.
    const ratio = resolveCalibration({
      taskFieldId: TF,
      travelEtaMinutes: 55,
      departedAt: new Date(T0.getTime() - 60 * 1000), // 1 min after departure
      currentBaseSeconds: 24 * 60,
      now: T0,
    });
    expect(ratio).toBeCloseTo((55 * 60) / (24 * 60), 5); // ≈ 2.29
    expect(_peekCalibration(TF)?.baseAtDepartureSeconds).toBe(24 * 60);
  });

  it('returns the SAME cached ratio on subsequent calls, even after the departure window closes', () => {
    resolveCalibration({
      taskFieldId: TF,
      travelEtaMinutes: 55,
      departedAt: T0,
      currentBaseSeconds: 24 * 60,
      now: T0,
    });
    // 15 min later, base route shrunk (worker drove) — ratio stays the same.
    const later = resolveCalibration({
      taskFieldId: TF,
      travelEtaMinutes: 55,
      departedAt: T0,
      currentBaseSeconds: 12 * 60,
      now: new Date(T0.getTime() + 15 * 60 * 1000),
    });
    expect(later).toBeCloseTo((55 * 60) / (24 * 60), 5);
  });
});

describe('resolveCalibration — refuses outside the departure window', () => {
  it('returns null when the poll arrives > 10 min after departedAt AND no cache', () => {
    const ratio = resolveCalibration({
      taskFieldId: TF,
      travelEtaMinutes: 55,
      departedAt: new Date(T0.getTime() - 11 * 60 * 1000), // 11 min ago
      currentBaseSeconds: 12 * 60,
      now: T0,
    });
    expect(ratio).toBeNull();
    expect(_peekCalibration(TF)).toBeUndefined();
  });

  it('accepts capture inside the 10-min window (edge: exactly 10 min)', () => {
    const ratio = resolveCalibration({
      taskFieldId: TF,
      travelEtaMinutes: 55,
      departedAt: new Date(T0.getTime() - 10 * 60 * 1000),
      currentBaseSeconds: 24 * 60,
      now: T0,
    });
    expect(ratio).not.toBeNull();
  });

  it('accepts capture at 8 min post-departure (widened window covers typical customer open-times)', () => {
    // The 5-min window before the 2026-07-09 widening was routinely missed —
    // customers opened the tracking link a few minutes after receiving the
    // WhatsApp message. This case documents the fix.
    const ratio = resolveCalibration({
      taskFieldId: TF,
      travelEtaMinutes: 55,
      departedAt: new Date(T0.getTime() - 8 * 60 * 1000),
      currentBaseSeconds: 24 * 60,
      now: T0,
    });
    expect(ratio).not.toBeNull();
  });
});

describe('resolveCalibration — sanity clamps', () => {
  it('discards ratios below 0.5 (worker "typo": entered 5 min for 24-min base)', () => {
    const ratio = resolveCalibration({
      taskFieldId: TF,
      travelEtaMinutes: 5,
      departedAt: T0,
      currentBaseSeconds: 24 * 60,
      now: T0,
    });
    // Raw ratio = 5/24 ≈ 0.208 → below 0.5 clamp.
    expect(ratio).toBeNull();
    expect(_peekCalibration(TF)).toBeUndefined();
  });

  it('discards ratios above 5.0 (worker "typo": entered 200 min for 24-min base)', () => {
    const ratio = resolveCalibration({
      taskFieldId: TF,
      travelEtaMinutes: 200,
      departedAt: T0,
      currentBaseSeconds: 24 * 60,
      now: T0,
    });
    // Raw ratio = 200/24 ≈ 8.33 → above 5.0 clamp.
    expect(ratio).toBeNull();
  });

  it('accepts a ratio at the upper clamp boundary', () => {
    // Base 20 min, worker says 100 min → ratio = 5.0.
    const ratio = resolveCalibration({
      taskFieldId: TF,
      travelEtaMinutes: 100,
      departedAt: T0,
      currentBaseSeconds: 20 * 60,
      now: T0,
    });
    expect(ratio).toBe(5.0);
  });
});

describe('resolveCalibration — missing inputs', () => {
  it('returns null when travelEtaMinutes is null (worker never answered the prompt)', () => {
    expect(
      resolveCalibration({
        taskFieldId: TF,
        travelEtaMinutes: null,
        departedAt: T0,
        currentBaseSeconds: 24 * 60,
        now: T0,
      }),
    ).toBeNull();
  });

  it('returns null when departedAt is null', () => {
    expect(
      resolveCalibration({
        taskFieldId: TF,
        travelEtaMinutes: 55,
        departedAt: null,
        currentBaseSeconds: 24 * 60,
        now: T0,
      }),
    ).toBeNull();
  });

  it('returns null when currentBaseSeconds is null (no route available)', () => {
    expect(
      resolveCalibration({
        taskFieldId: TF,
        travelEtaMinutes: 55,
        departedAt: T0,
        currentBaseSeconds: null,
        now: T0,
      }),
    ).toBeNull();
  });

  it('returns null when currentBaseSeconds is zero (avoids divide-by-zero)', () => {
    expect(
      resolveCalibration({
        taskFieldId: TF,
        travelEtaMinutes: 55,
        departedAt: T0,
        currentBaseSeconds: 0,
        now: T0,
      }),
    ).toBeNull();
  });
});

describe('resolveCalibration — TTL', () => {
  it('drops the cache after 4h and returns null when we can no longer re-capture', () => {
    _seedCalibration(TF, 2.29, 24 * 60, T0.getTime());
    const later = resolveCalibration({
      taskFieldId: TF,
      travelEtaMinutes: 55,
      departedAt: new Date(T0.getTime() - 10 * 60 * 1000), // outside 5-min window
      currentBaseSeconds: 12 * 60,
      now: new Date(T0.getTime() + 5 * 60 * 60 * 1000),   // 5h later — beyond TTL
    });
    expect(later).toBeNull();
    expect(_peekCalibration(TF)).toBeUndefined();
  });
});
