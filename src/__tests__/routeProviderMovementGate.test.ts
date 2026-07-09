/**
 * Integration tests for the movement gate through `routeProvider.ts`.
 *
 * Focus: verify the CALL to ORS/OSRM (or absence of it) as the worker's
 * position evolves. These are the tests the user specifically asked for:
 *   - first request calls ORS
 *   - second request same location does NOT call ORS
 *   - GPS jitter under 75m does NOT call ORS
 *   - movement over 75m calls ORS
 *   - destination changed calls ORS
 *   - max stationary cache age triggers refresh
 *   - fallback to OSRM still works
 *
 * The "stale location does not call ORS" requirement is enforced upstream in
 * `tracking.ts` (which skips `getRouteEstimate` entirely on stale coords) — a
 * routeProvider-level test can't reach that gate because routeProvider has no
 * concept of freshness. It's covered by the existing tracking test suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const orsGet  = vi.fn();
const osrmGet = vi.fn();

vi.mock('../services/orsRoute', () => ({
  getRoadRoute: (...args: unknown[]) => orsGet(...args),
  _clearOrsCache: vi.fn(),
  _isInStickyFallback: vi.fn(),
}));
vi.mock('../services/osrmRoute', () => ({
  getRoadRoute: (...args: unknown[]) => osrmGet(...args),
  _clearRouteCache: vi.fn(),
}));

import { getRouteEstimate } from '../services/routeProvider';
import {
  _clearMovementCache,
  MAX_STATIONARY_ROUTE_CACHE_MS,
} from '../services/routeMovementCache';

const DEST     = { lat: 32.0110, lng: 34.7712 };
const WORKER   = { lat: 32.0853, lng: 34.7818 };
const DEST_ALT = { lat: 33.5000, lng: 35.5000 };

const ORS_ROUTE  = { geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, distanceMeters: 1000, durationSeconds: 100 };
const OSRM_ROUTE = { geometry: { type: 'LineString', coordinates: [[2, 2], [3, 3]] }, distanceMeters: 2000, durationSeconds: 200 };

/** Move a lat/lng by ~N meters north — same helper as the unit-test file. */
function offsetNorth(p: { lat: number; lng: number }, meters: number) {
  return { lat: p.lat + meters / 111_111, lng: p.lng };
}

beforeEach(() => {
  orsGet.mockReset();
  osrmGet.mockReset();
  process.env.TRACKING_ROUTE_PROVIDER = 'openrouteservice';
  _clearMovementCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TRACKING_ROUTE_PROVIDER;
  _clearMovementCache();
});

describe('movement gate — call / no-call decisions', () => {
  it('first request → calls ORS (MISS_NO_PRIOR)', async () => {
    orsGet.mockResolvedValueOnce(ORS_ROUTE);
    const r = await getRouteEstimate(WORKER, DEST);
    expect(r?.provider).toBe('openrouteservice');
    expect(orsGet).toHaveBeenCalledTimes(1);
    expect(osrmGet).not.toHaveBeenCalled();
  });

  it('second request at the SAME location → does NOT call ORS (cache HIT)', async () => {
    orsGet.mockResolvedValueOnce(ORS_ROUTE);
    await getRouteEstimate(WORKER, DEST);
    const second = await getRouteEstimate(WORKER, DEST);
    expect(orsGet).toHaveBeenCalledTimes(1);
    // The cached estimate must be the same object as the one ORS returned
    // (with the provider tag).
    expect(second?.provider).toBe('openrouteservice');
    expect(second?.distanceMeters).toBe(ORS_ROUTE.distanceMeters);
    expect(second?.durationSeconds).toBe(ORS_ROUTE.durationSeconds);
  });

  it('GPS jitter (< 75m) → does NOT call ORS again', async () => {
    orsGet.mockResolvedValueOnce(ORS_ROUTE);
    await getRouteEstimate(WORKER, DEST);
    // Simulate 6 successive polls all inside the jitter radius. None should
    // trigger a provider call.
    for (const meters of [10, 25, 40, 55, 60, 74]) {
      const jittered = offsetNorth(WORKER, meters);
      await getRouteEstimate(jittered, DEST);
    }
    expect(orsGet).toHaveBeenCalledTimes(1);
  });

  it('movement > 75m → calls ORS again', async () => {
    orsGet.mockResolvedValueOnce(ORS_ROUTE).mockResolvedValueOnce(ORS_ROUTE);
    await getRouteEstimate(WORKER, DEST);
    const moved = offsetNorth(WORKER, 200);
    await getRouteEstimate(moved, DEST);
    expect(orsGet).toHaveBeenCalledTimes(2);
  });

  it('destination changed → calls ORS again (even at same worker position)', async () => {
    orsGet.mockResolvedValueOnce(ORS_ROUTE).mockResolvedValueOnce(ORS_ROUTE);
    await getRouteEstimate(WORKER, DEST);
    await getRouteEstimate(WORKER, DEST_ALT);
    expect(orsGet).toHaveBeenCalledTimes(2);
  });

  it('max stationary cache age exceeded → triggers refresh even without movement', async () => {
    orsGet.mockResolvedValueOnce(ORS_ROUTE).mockResolvedValueOnce(ORS_ROUTE);
    // First call — populate cache at t=0.
    const realNow = Date.now;
    let mockNow = 1_000_000;
    Date.now = () => mockNow;
    try {
      await getRouteEstimate(WORKER, DEST);
      // Fast-forward past MAX_STATIONARY_ROUTE_CACHE_MS.
      mockNow += MAX_STATIONARY_ROUTE_CACHE_MS + 1;
      await getRouteEstimate(WORKER, DEST);
      expect(orsGet).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  it('after 9 minutes 59 seconds without movement → still HIT (no ORS call)', async () => {
    orsGet.mockResolvedValueOnce(ORS_ROUTE);
    const realNow = Date.now;
    let mockNow = 2_000_000;
    Date.now = () => mockNow;
    try {
      await getRouteEstimate(WORKER, DEST);
      mockNow += MAX_STATIONARY_ROUTE_CACHE_MS - 1_000;
      await getRouteEstimate(WORKER, DEST);
      expect(orsGet).toHaveBeenCalledTimes(1);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('movement gate — provider fallback still works', () => {
  it('ORS null → OSRM called, OSRM result cached; next nearby poll skips BOTH', async () => {
    orsGet.mockResolvedValueOnce(null);
    osrmGet.mockResolvedValueOnce(OSRM_ROUTE);
    const first = await getRouteEstimate(WORKER, DEST);
    expect(first?.provider).toBe('osrm');
    expect(orsGet).toHaveBeenCalledTimes(1);
    expect(osrmGet).toHaveBeenCalledTimes(1);

    // Poll again — jittered 30m, still under threshold. Cache HIT should
    // short-circuit BOTH providers.
    const jittered = offsetNorth(WORKER, 30);
    const second = await getRouteEstimate(jittered, DEST);
    expect(second?.provider).toBe('osrm');
    expect(second?.distanceMeters).toBe(OSRM_ROUTE.distanceMeters);
    expect(orsGet).toHaveBeenCalledTimes(1); // unchanged
    expect(osrmGet).toHaveBeenCalledTimes(1); // unchanged
  });

  it('both providers null → nothing cached; next poll retries both', async () => {
    orsGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    osrmGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const first = await getRouteEstimate(WORKER, DEST);
    expect(first).toBeNull();
    // Same location — but nothing was cached, so a retry SHOULD hit the
    // providers again.
    const second = await getRouteEstimate(WORKER, DEST);
    expect(second).toBeNull();
    expect(orsGet).toHaveBeenCalledTimes(2);
    expect(osrmGet).toHaveBeenCalledTimes(2);
  });
});

describe('movement gate — OSRM-only deployment', () => {
  beforeEach(() => {
    process.env.TRACKING_ROUTE_PROVIDER = 'osrm';
  });

  it('honors the movement gate for OSRM too (not ORS-specific)', async () => {
    osrmGet.mockResolvedValueOnce(OSRM_ROUTE);
    await getRouteEstimate(WORKER, DEST);
    // 20 successive polls all within the jitter radius.
    for (let i = 0; i < 20; i++) {
      const jittered = offsetNorth(WORKER, (i % 60) + 5);
      await getRouteEstimate(jittered, DEST);
    }
    expect(osrmGet).toHaveBeenCalledTimes(1);
    expect(orsGet).not.toHaveBeenCalled();
  });
});
