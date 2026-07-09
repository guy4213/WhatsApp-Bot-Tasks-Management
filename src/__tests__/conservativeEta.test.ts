/**
 * Behavioral tests for `services/conservativeEta.ts` (pure composer).
 *
 * Test dates are Wed 2026-07-08 at 14:00 IL (= 11:00Z, IDT = UTC+3) so the
 * hourly multiplier is a predictable 1.25 (Sun–Thu 12:00–15:00 slot). When
 * a specific hour matters, we use a different Date.
 */
import { describe, expect, it } from 'vitest';
import { computeConservativeEta } from '../services/conservativeEta';

const NOW = new Date('2026-07-08T11:00:00.000Z'); // Wed 14:00 IL → hourly factor = 1.25

// ── Source selection ─────────────────────────────────────────────────────

describe('computeConservativeEta — source selection', () => {
  it("picks 'calibration' when both calibrationRatio and baseRouteSeconds are present", () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 24 * 60,
      calibrationRatio: 2.0,
      expectedArrivalAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      travelEtaMinutes: 55,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: null,
      now: NOW,
    });
    expect(r.source).toBe('calibration');
  });

  it("does NOT use expectedArrivalAt as a source (countdown was removed 2026-07-09)", () => {
    // Even with a valid `expectedArrivalAt` and a `travelEtaMinutes`, the
    // composer must NOT decay ETA over time. Without a base it falls to
    // 'worker_only' (constant).
    const r = computeConservativeEta({
      baseRouteSeconds: null,
      calibrationRatio: null,
      expectedArrivalAt: new Date(NOW.getTime() + 30 * 60 * 1000),
      travelEtaMinutes: 55,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: null,
      now: NOW,
    });
    expect(r.source).toBe('worker_only');
  });

  it("falls back to 'hourly' when calibration is missing but base is available", () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 24 * 60,
      calibrationRatio: null,
      expectedArrivalAt: null,
      travelEtaMinutes: 55,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: null,
      now: NOW,
    });
    expect(r.source).toBe('hourly');
  });

  it("falls back to 'worker_only' when there is no base at all", () => {
    const r = computeConservativeEta({
      baseRouteSeconds: null,
      calibrationRatio: null,
      expectedArrivalAt: null,
      travelEtaMinutes: 30,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: null,
      now: NOW,
    });
    expect(r.source).toBe('worker_only');
    // 30 min × 60 + buffer 3 min → 33 min → round up 35.
    expect(r.etaMinutes).toBe(35);
  });

  it('returns null etaMinutes+etaText when no source is available', () => {
    const r = computeConservativeEta({
      baseRouteSeconds: null,
      calibrationRatio: null,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'unknown',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: null,
      now: NOW,
    });
    expect(r.source).toBeNull();
    expect(r.etaMinutes).toBeNull();
    expect(r.etaText).toBeNull();
  });

  it('expectedArrivalAt is ignored entirely — hourly wins over any future arrival time', () => {
    // Verify the countdown removal by giving both a FUTURE expectedArrivalAt
    // and a base — hourly must win, not countdown.
    const r = computeConservativeEta({
      baseRouteSeconds: 20 * 60,
      calibrationRatio: null,
      expectedArrivalAt: new Date(NOW.getTime() + 30 * 60 * 1000), // future
      travelEtaMinutes: null,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: null,
      now: NOW,
    });
    expect(r.source).toBe('hourly');
  });
});

// ── Composition layers ───────────────────────────────────────────────────

describe('computeConservativeEta — buffer + floor + rounding', () => {
  it('adds the 3-min last-mile buffer', () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 20 * 60, // 20 min base
      calibrationRatio: 1.0,     // no multiplier
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: null,
      now: NOW,
    });
    // 20 min + 3 min buffer = 23 → round up 25.
    expect(r.etaMinutes).toBe(25);
  });

  it('applies the 3-minute floor even for very short routes', () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 10,
      calibrationRatio: 1.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: null,
      now: NOW,
    });
    // 10s + 180s buffer = 190s ≈ 3.2 min. Floor 3, round up to 5.
    expect(r.etaMinutes).toBe(5);
  });

  it('rounds UP to the next 5-minute boundary (never down)', () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 22 * 60 - 180, // exactly 22 min base after buffer
      calibrationRatio: 1.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: null,
      now: NOW,
    });
    expect(r.etaMinutes).toBe(25);
  });
});

// ── Anti-jump / freeze ──────────────────────────────────────────────────

describe('computeConservativeEta — anti-jump & freeze', () => {
  it('caps a drop at MAX_REDUCTION_PCT (25%) compared to previous displayed ETA', () => {
    // Base implies a lower raw ETA than the previous shown one.
    const r = computeConservativeEta({
      baseRouteSeconds: 5 * 60, // 5 min base
      calibrationRatio: 1.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: 25,
      now: NOW,
    });
    // Raw = 5 + 3 buffer = 8 min. Previous = 25 → min allowed = 18.75.
    // 8 < 18.75 → clamped to 18.75 → round up to 20.
    expect(r.etaMinutes).toBe(20);
  });

  it('lets the ETA rise freely (only floors decreases)', () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 40 * 60, // much bigger than previous
      calibrationRatio: 1.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: 25,
      now: NOW,
    });
    expect(r.etaMinutes).toBeGreaterThan(25);
    expect(r.frozen).toBe(false);
  });

  it("freezes at the previous ETA when progressState === 'not_progressing'", () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 5 * 60,
      calibrationRatio: 1.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'not_progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: 25,
      now: NOW,
    });
    // Would compute to a tiny value; freeze at previous 25 → rounds to 25.
    expect(r.etaMinutes).toBe(25);
    expect(r.frozen).toBe(true);
  });

  it("allows increase even when not_progressing (the eta CAN go up)", () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 45 * 60,
      calibrationRatio: 1.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'not_progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: 25,
      now: NOW,
    });
    // 45 + 3 = 48 → rounds to 50; previous 25 does not cap raise.
    expect(r.etaMinutes).toBe(50);
    expect(r.frozen).toBe(false);
  });

  it("scales raw seconds by 1.25 when progressState === 'slow'", () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 20 * 60,
      calibrationRatio: 1.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'slow',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: null,
      now: NOW,
    });
    // 20 * 1.25 = 25 + 3 buffer = 28 → round up 30.
    expect(r.etaMinutes).toBe(30);
  });
});

// ── Text output ─────────────────────────────────────────────────────────

describe('computeConservativeEta — text', () => {
  it('produces the Hebrew "זמן הגעה משוער" phrasing when the location is fresh', () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 20 * 60,
      calibrationRatio: 1.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: null,
      now: NOW,
    });
    expect(r.etaText).toBe('זמן הגעה משוער: 25 דקות');
  });

  it('appends "(הערכה בלבד)" when the location is stale', () => {
    // With countdown removed, we need a location-driven source. Use
    // `travelEtaMinutes` (worker_only path) which is constant and doesn't
    // require GPS — a valid stale-location scenario.
    const r = computeConservativeEta({
      baseRouteSeconds: null,
      calibrationRatio: null,
      expectedArrivalAt: null,
      travelEtaMinutes: 20,
      progressState: 'unknown',
      isLocationFresh: false,
      previousDisplayedEtaMinutes: null,
      now: NOW,
    });
    expect(r.etaText).toMatch(/הערכה בלבד/);
  });

  it('NEVER emits the word "traffic" or "עומסי תנועה" in the customer-facing text', () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 20 * 60,
      calibrationRatio: null, // triggers hourly path
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: null,
      now: new Date('2026-07-08T05:00:00.000Z'), // Wed 08:00 IL — peak
    });
    expect(r.etaText).not.toMatch(/traffic|תנועה|עומס/i);
  });
});

// ── Calibration math end-to-end ─────────────────────────────────────────

describe('computeConservativeEta — calibration math', () => {
  it('multiplies current base by ratio (Waze projection onto shrinking distance)', () => {
    // Worker at start: base 24 min, worker said 48 min → ratio = 2.0.
    // Now: 12 min from destination → 12 * 2.0 = 24 + buffer 3 = 27 → round 30.
    const r = computeConservativeEta({
      baseRouteSeconds: 12 * 60,
      calibrationRatio: 2.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: null,
      now: NOW,
    });
    expect(r.source).toBe('calibration');
    expect(r.etaMinutes).toBe(30);
  });
});
