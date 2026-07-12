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

  it('a very short route is the last mile → small number, 1-min buffer + granularity', () => {
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
    // base 10s < 5 min → last mile: 10s + 60s buffer = 70s ≈ 1.2 min,
    // round up to the 1-min boundary → 2.
    expect(r.etaMinutes).toBe(2);
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

// ── Anti-jitter (no freeze) + last-mile collapse ─────────────────────────

describe('computeConservativeEta — anti-jitter (no freeze)', () => {
  it('caps a drop at MAX_REDUCTION_PCT (50%) vs previous, mid-route', () => {
    // 10-min base keeps us OUT of the last mile (base ≥ 5 min) so the
    // drop-cap applies.
    const r = computeConservativeEta({
      baseRouteSeconds: 10 * 60,
      calibrationRatio: 1.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: 40,
      now: NOW,
    });
    // Raw = 10 + 3 buffer = 13 min. Previous = 40 → min allowed = 20.
    // 13 < 20 → clamped to 20 (already a 5-boundary).
    expect(r.etaMinutes).toBe(20);
  });

  it('lets the ETA rise freely (raises are never capped)', () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 40 * 60,
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

  it("does NOT freeze on not_progressing — the ETA still comes down (mid-route)", () => {
    // Regression for the 2026-07-09 fix: a creeping/"stuck-looking" worker must
    // NOT pin the ETA. base 10 min, prev 40, not_progressing.
    const r = computeConservativeEta({
      baseRouteSeconds: 10 * 60,
      calibrationRatio: 1.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'not_progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: 40,
      now: NOW,
    });
    // Raw = 13 min; only the loose 50% drop-cap applies (min allowed = 20).
    // NOT frozen at 40.
    expect(r.etaMinutes).toBe(20);
    expect(r.frozen).toBe(false);
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
    // 45 + 3 = 48 → rounds to 50; previous 25 does not cap a raise.
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

describe('computeConservativeEta — last-mile collapse (the "200m / 15min" fix)', () => {
  it('near the door, the ETA is NOT held up by a high previous value or not_progressing', () => {
    // base 2 min road left → last mile. prev shown 15, and the detector thinks
    // we're "not progressing" (slowing to park). Pre-fix this froze at 15.
    const r = computeConservativeEta({
      baseRouteSeconds: 2 * 60,
      calibrationRatio: 1.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'not_progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: 15,
      now: NOW,
    });
    // last mile: 2 min + 1 min buffer = 3 min, no drop-cap, round to 1 → 3.
    expect(r.etaMinutes).toBe(3);
    expect(r.frozen).toBe(false);
  });

  it('very close: collapses to a small 1-min-granularity number', () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 40, // ~40s of road left
      calibrationRatio: 1.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: 20,
      now: NOW,
    });
    // 40s + 60s buffer = 100s ≈ 1.7 min → round up to 2 (last-mile 1-min steps).
    expect(r.etaMinutes).toBe(2);
  });

  it('the drop-cap does NOT apply in the last mile even against a big previous', () => {
    const r = computeConservativeEta({
      baseRouteSeconds: 90, // 1.5 min road left → last mile
      calibrationRatio: 1.0,
      expectedArrivalAt: null,
      travelEtaMinutes: null,
      progressState: 'progressing',
      isLocationFresh: true,
      previousDisplayedEtaMinutes: 30, // 50% cap would floor at 15 mid-route
      now: NOW,
    });
    // 90s + 60s = 150s = 2.5 min → round up to 3. Not clamped to 15.
    expect(r.etaMinutes).toBe(3);
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
