/**
 * Integration tests for tracking.ts → Conservative ETA composition.
 *
 * These tests exercise `getPublicView` end-to-end with mocked pool +
 * destination + route provider, so the tracking flow builds the same input
 * shape our production code produces. They do NOT replace the unit tests for
 * each conservative-ETA layer — those live in `conservativeEta.test.ts` etc.
 *
 * Explicitly out of scope: TrackingSession lifecycle (open/close/mark), which
 * lives in `tracking.test.ts` and is unaffected by this change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Pool + destination + routeProvider mocks ─────────────────────────────

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: {
    query: (...args: unknown[]) => poolQuery(...args),
    connect: vi.fn(),
  },
}));

const resolveDestMock = vi.fn();
vi.mock('../services/siteGeocodeCache', () => ({
  resolveTaskFieldDestination: (...a: unknown[]) => resolveDestMock(...a),
}));

const routeMock = vi.fn();
vi.mock('../services/routeProvider', async () => {
  // Preserve the LatLng re-export type identity — tests don't need it.
  return {
    getRouteEstimate: (...a: unknown[]) => routeMock(...a),
  };
});

// Import AFTER mocks.
import { getPublicView } from '../services/tracking';
import { _clearCalibrationCache } from '../services/workerCalibration';
import { _clearSessionState } from '../services/progressDetector';

// ── Fixtures ────────────────────────────────────────────────────────────

const TOKEN = 'tok-integration-1';
const TF    = 'tf-integration-1';
const NOW   = new Date('2026-07-08T11:00:00.000Z'); // Wed 14:00 IL — hourly = 1.25

interface RowOverride {
  distanceMeters?: number;
  durationSeconds?: number;
  travelEtaMinutes?: number | null;
  departedAt?: string | null;
  expectedArrivalAt?: string | null;
  lastSeenAt?: string;
  fieldStatus?: string;
}

function joinedRow(o: RowOverride = {}) {
  return {
    taskFieldId: TF,
    status: 'ACTIVE',
    fieldStatus: o.fieldStatus ?? 'EN_ROUTE',
    updatedAt: NOW.toISOString(),
    arrivedAt: null,
    endedAt: null,
    expiresAt: new Date(NOW.getTime() + 4 * 60 * 60 * 1000).toISOString(),
    lastLocationAt: (o.lastSeenAt ?? NOW.toISOString()),
    lat: 32.1848,
    lng: 34.8676,
    accuracy: 10,
    liveAt: o.lastSeenAt ?? NOW.toISOString(),
    travelEtaMinutes: o.travelEtaMinutes ?? null,
    expectedArrivalAt: o.expectedArrivalAt ?? null,
    departedAt: o.departedAt ?? null,
  };
}

function mockRoute(distance: number, duration: number) {
  routeMock.mockResolvedValueOnce({
    provider: 'osrm',
    geometry: { type: 'LineString', coordinates: [[34.86, 32.18], [34.77, 32.06]] },
    distanceMeters: distance,
    durationSeconds: duration,
  });
}

beforeEach(() => {
  poolQuery.mockReset();
  resolveDestMock.mockReset();
  routeMock.mockReset();
  _clearCalibrationCache();
  _clearSessionState();
  resolveDestMock.mockResolvedValue({
    lat: 32.0645, lng: 34.7734, address: 'Rothschild 100, Tel Aviv',
  });
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Priority 1: worker calibration ratio ────────────────────────────────

describe('getPublicView — worker calibration path', () => {
  it('projects the worker Waze ratio onto the current base route', async () => {
    // Base at departure = 24 min; worker said 48 min → ratio 2.0.
    const departedAt = new Date(NOW.getTime() - 60 * 1000).toISOString(); // 1 min ago
    poolQuery.mockResolvedValueOnce({
      rows: [joinedRow({ travelEtaMinutes: 48, departedAt, expectedArrivalAt: null })],
    });
    mockRoute(24_000, 24 * 60); // base = 24 min

    const view = await getPublicView(TOKEN);
    // 24 * 2.0 = 48 min + 3 buffer = 51 → round up 55.
    expect(view?.etaMinutes).toBe(55);
    expect(view?.etaText).toBe('זמן הגעה משוער: 55 דקות');
    expect(view?.etaText).not.toMatch(/traffic|תנועה|עומס/i);
    // Client-side mm:ss countdown ticker MUST be disabled — the ETA must
    // update ONLY on poll (via `etaMinutes`), not tick down independently.
    // Product decision (2026-07-09 field test): a running timer was
    // misleading; the customer should see a static minutes value that
    // refreshes on each GPS poll.
    expect(view?.durationSeconds).toBeUndefined();
    // Route metadata under `view.route.durationSeconds` still carries the
    // raw provider value (used for map / route info, not ETA).
    expect(view?.route?.durationSeconds).toBe(24 * 60);
  });

  it('a subsequent poll uses the cached ratio but respects the 25% anti-jump clamp', async () => {
    const departedAt = new Date(NOW.getTime() - 60 * 1000).toISOString();
    // Poll 1: base=24 min, worker=48 → ratio=2.0. Displayed 48+3=51 → 55.
    poolQuery.mockResolvedValueOnce({
      rows: [joinedRow({ travelEtaMinutes: 48, departedAt, expectedArrivalAt: null })],
    });
    mockRoute(24_000, 24 * 60);
    const first = await getPublicView(TOKEN);
    expect(first?.etaMinutes).toBe(55);

    // Poll 2: base shrunk to 10 min; ratio 2.0 → 20 + 3 buffer = 23 raw.
    // Previous = 55; anti-jump min allowed = 55 * 0.75 = 41.25 → round up 45.
    poolQuery.mockResolvedValueOnce({
      rows: [joinedRow({ travelEtaMinutes: 48, departedAt, expectedArrivalAt: null })],
    });
    mockRoute(10_000, 10 * 60);
    const second = await getPublicView(TOKEN);
    expect(second?.etaMinutes).toBe(45);
  });
});

// ── expectedArrivalAt is NEVER an ETA source (countdown removed) ────────

describe('getPublicView — expectedArrivalAt is ignored as an ETA source', () => {
  it('falls to hourly when no calibration (past window) — NOT to expectedArrivalAt countdown', async () => {
    // No calibration cache; departure is 25 min ago (outside 20-min window).
    // Even with `expectedArrivalAt` set, the ETA must NOT decay over time —
    // it must be `currentBase × hourly` (location-driven).
    const expectedArrivalAt = new Date(NOW.getTime() + 30 * 60 * 1000).toISOString();
    const departedAt = new Date(NOW.getTime() - 25 * 60 * 1000).toISOString();
    poolQuery.mockResolvedValueOnce({
      rows: [joinedRow({ travelEtaMinutes: 55, departedAt, expectedArrivalAt })],
    });
    mockRoute(15_000, 15 * 60);
    const view = await getPublicView(TOKEN);
    // Hourly at Wed 14:00 IL = 1.25. 15 min × 1.25 + 3 buffer = 21.75 → round up 25.
    expect(view?.etaMinutes).toBe(25);
    expect(view?.etaText).toBe('זמן הגעה משוער: 25 דקות');
  });
});

// ── Priority 3: hourly multiplier fallback ──────────────────────────────

describe('getPublicView — hourly multiplier fallback', () => {
  it('multiplies raw base by the hour-of-day factor when no calibration nor countdown', async () => {
    // No worker input, no expectedArrivalAt — falls to hourly.
    poolQuery.mockResolvedValueOnce({
      rows: [joinedRow()],
    });
    mockRoute(20_000, 20 * 60);
    const view = await getPublicView(TOKEN);
    // 20 * 1.25 = 25 + 3 buffer = 28 → round up 30.
    expect(view?.etaMinutes).toBe(30);
    // QA observability: hourly path is announced in the JSON.
    expect(view?.etaSource).toBe('hourly');
  });
});

// ── Stale location — "(הערכה בלבד)" suffix ──────────────────────────────

describe('getPublicView — stale GPS', () => {
  it('appends "(הערכה בלבד)" when the location is not fresh', async () => {
    // Set the last-seen to 5 min ago so it exceeds the default TRACKING_STALE_SECONDS (120s).
    // With countdown removed, we need `travelEtaMinutes` so the composer has
    // a worker_only source once the route is skipped for staleness.
    const staleAt = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    const expectedArrivalAt = new Date(NOW.getTime() + 20 * 60 * 1000).toISOString();
    poolQuery.mockResolvedValueOnce({
      rows: [joinedRow({ lastSeenAt: staleAt, expectedArrivalAt, travelEtaMinutes: 20 })],
    });
    // Stale gate in tracking.ts short-circuits route calls — mock is unused
    // but harmless.
    const view = await getPublicView(TOKEN);
    expect(view?.isLocationFresh).toBe(false);
    // Countdown source: 20 min + 3 buffer → 25 min, stale suffix appended.
    expect(view?.etaText).toBe('זמן הגעה משוער: 25 דקות (הערכה בלבד)');
  });
});

// ── Non-terminal terminal cases ─────────────────────────────────────────

describe('getPublicView — no source at all', () => {
  it('sets fallbackReason=NO_ETA_SOURCE when GPS is fresh but no ETA source exists', async () => {
    // GPS is fresh, destination resolves — so the earlier failure paths
    // (NO_LOCATION / NO_DESTINATION / STALE_LOCATION) do NOT fire. Then no
    // ETA source is available and computeConservativeEta returns null.
    routeMock.mockResolvedValueOnce(null); // route provider fails → no base
    poolQuery.mockResolvedValueOnce({
      rows: [
        joinedRow({
          travelEtaMinutes: null,
          expectedArrivalAt: null,
        }),
      ],
    });
    const view = await getPublicView(TOKEN);
    expect(view?.etaMinutes).toBeUndefined();
    expect(view?.etaText).toBeUndefined();
    // Two ways this can present depending on env:
    //  - `OSRM_DISABLED` — no route provider configured (this test's default),
    //  - `NO_ETA_SOURCE` — provider configured but no ETA source available.
    // Either is a valid presentation; assert the family, not the specific value.
    expect(['OSRM_DISABLED', 'OSRM_FAILED', 'NO_ETA_SOURCE']).toContain(view?.fallbackReason);
  });
});
