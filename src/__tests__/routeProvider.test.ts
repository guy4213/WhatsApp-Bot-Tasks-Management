/**
 * Behavioral tests for `services/routeProvider.ts`.
 *
 * Verifies:
 *  - `TRACKING_ROUTE_PROVIDER=osrm` (or unset) → only OSRM is contacted.
 *  - `TRACKING_ROUTE_PROVIDER=openrouteservice` → ORS first; on `null`,
 *    OSRM fallback fires.
 *  - Returned `provider` field reflects the actual serving side.
 *  - Both providers null → returns null (caller renders straight-line).
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
  getRoadRoute: (...args: unknown[]) => osmProxy(...args), // typo to satisfy linter — use below
  _clearRouteCache: vi.fn(),
}));
// Re-mock osrmRoute properly (the awkward binding above just satisfies the
// mock ordering; below is the real callable).
function osmProxy(...args: unknown[]) {
  return osrmGet(...args);
}

import { getRouteEstimate } from '../services/routeProvider';
import { _clearMovementCache } from '../services/routeMovementCache';

const WORKER = { lat: 32.0853, lng: 34.7818 };
const DEST   = { lat: 32.0110, lng: 34.7712 };

const ORS_ROUTE  = { geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, distanceMeters: 1000, durationSeconds: 100 };
const OSRM_ROUTE = { geometry: { type: 'LineString', coordinates: [[2, 2], [3, 3]] }, distanceMeters: 2000, durationSeconds: 200 };

beforeEach(() => {
  orsGet.mockReset();
  osrmGet.mockReset();
  delete process.env.TRACKING_ROUTE_PROVIDER;
  // Movement cache persists across tests by design; clear so each test starts
  // with a fresh MISS_NO_PRIOR state and hits its mocked provider.
  _clearMovementCache();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('getRouteEstimate — default (TRACKING_ROUTE_PROVIDER unset)', () => {
  it('calls OSRM only, never ORS', async () => {
    osrmGet.mockResolvedValueOnce(OSRM_ROUTE);
    const r = await getRouteEstimate(WORKER, DEST);
    expect(r).toEqual({ ...OSRM_ROUTE, provider: 'osrm' });
    expect(osrmGet).toHaveBeenCalledTimes(1);
    expect(orsGet).not.toHaveBeenCalled();
  });

  it('returns null when OSRM returns null (no ORS attempt)', async () => {
    osrmGet.mockResolvedValueOnce(null);
    const r = await getRouteEstimate(WORKER, DEST);
    expect(r).toBeNull();
    expect(orsGet).not.toHaveBeenCalled();
  });
});

describe('getRouteEstimate — TRACKING_ROUTE_PROVIDER=osrm', () => {
  beforeEach(() => {
    process.env.TRACKING_ROUTE_PROVIDER = 'osrm';
  });

  it('calls OSRM only, never ORS', async () => {
    osrmGet.mockResolvedValueOnce(OSRM_ROUTE);
    const r = await getRouteEstimate(WORKER, DEST);
    expect(r?.provider).toBe('osrm');
    expect(orsGet).not.toHaveBeenCalled();
  });
});

describe('getRouteEstimate — TRACKING_ROUTE_PROVIDER=openrouteservice', () => {
  beforeEach(() => {
    process.env.TRACKING_ROUTE_PROVIDER = 'openrouteservice';
  });

  it('tries ORS first and returns it when successful', async () => {
    orsGet.mockResolvedValueOnce(ORS_ROUTE);
    const r = await getRouteEstimate(WORKER, DEST);
    expect(r).toEqual({ ...ORS_ROUTE, provider: 'openrouteservice' });
    expect(orsGet).toHaveBeenCalledTimes(1);
    expect(osrmGet).not.toHaveBeenCalled();
  });

  it('falls back to OSRM when ORS returns null', async () => {
    orsGet.mockResolvedValueOnce(null);
    osrmGet.mockResolvedValueOnce(OSRM_ROUTE);
    const r = await getRouteEstimate(WORKER, DEST);
    expect(r).toEqual({ ...OSRM_ROUTE, provider: 'osrm' });
    expect(orsGet).toHaveBeenCalledTimes(1);
    expect(osrmGet).toHaveBeenCalledTimes(1);
  });

  it('returns null when both providers return null', async () => {
    orsGet.mockResolvedValueOnce(null);
    osrmGet.mockResolvedValueOnce(null);
    const r = await getRouteEstimate(WORKER, DEST);
    expect(r).toBeNull();
  });

  it('does not swallow OSRM route when ORS 429 sticks (both null → null)', async () => {
    // Semantics: routeProvider doesn't peek at sticky state — it just calls
    // ORS (which returns null cheaply during sticky) and then OSRM. If OSRM
    // itself returns null, we get null. This is the pipe design.
    orsGet.mockResolvedValueOnce(null);
    osrmGet.mockResolvedValueOnce(null);
    const r = await getRouteEstimate(WORKER, DEST);
    expect(r).toBeNull();
    expect(orsGet).toHaveBeenCalledTimes(1);
    expect(osrmGet).toHaveBeenCalledTimes(1);
  });
});

describe('getRouteEstimate — passthrough shape', () => {
  it('never mutates the underlying provider result', async () => {
    process.env.TRACKING_ROUTE_PROVIDER = 'openrouteservice';
    const original = { ...ORS_ROUTE };
    orsGet.mockResolvedValueOnce(original);
    const r = await getRouteEstimate(WORKER, DEST);
    expect(r).toMatchObject(original);
    // But do not mutate the underlying object.
    expect(original).toEqual(ORS_ROUTE);
  });

  it('exposes only the `provider` tag and route fields — no key or debug data', async () => {
    process.env.TRACKING_ROUTE_PROVIDER = 'openrouteservice';
    orsGet.mockResolvedValueOnce(ORS_ROUTE);
    const r = await getRouteEstimate(WORKER, DEST);
    expect(new Set(Object.keys(r!))).toEqual(
      new Set(['geometry', 'distanceMeters', 'durationSeconds', 'provider']),
    );
  });
});
