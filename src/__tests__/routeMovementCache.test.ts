/**
 * Unit tests for `services/routeMovementCache.ts`.
 *
 * Direct tests on the cache primitives — the movement-gate decision matrix
 * (no-prior / dest-changed / under-threshold / over-threshold / max-age).
 * Integration through `routeProvider` (i.e. that we actually skip the ORS/OSRM
 * call on HIT) is covered by `routeProviderMovementGate.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIN_ROUTE_RECALC_MOVE_METERS,
  MAX_STATIONARY_ROUTE_CACHE_MS,
  checkCache,
  storeCache,
  distanceMeters,
  _clearMovementCache,
  _movementCacheSize,
} from '../services/routeMovementCache';
import type { RouteEstimate } from '../services/routeProvider';

const DEST = { lat: 32.0110, lng: 34.7712 };
const WORKER_BASE = { lat: 32.0853, lng: 34.7818 };

const ROUTE: RouteEstimate = {
  geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
  distanceMeters: 8000,
  durationSeconds: 900,
  provider: 'openrouteservice',
};

/**
 * Offset a lat/lng by an approximate straight-line distance in meters, moving
 * north. 1° latitude ≈ 111,111 m so we can build precise "moved by X meters"
 * scenarios without dragging in a geodesy library.
 */
function offsetNorth(p: { lat: number; lng: number }, meters: number) {
  return { lat: p.lat + meters / 111_111, lng: p.lng };
}

beforeEach(() => {
  _clearMovementCache();
});
afterEach(() => {
  _clearMovementCache();
});

describe('routeMovementCache — thresholds are what we advertise', () => {
  it('MIN_ROUTE_RECALC_MOVE_METERS is 75', () => {
    expect(MIN_ROUTE_RECALC_MOVE_METERS).toBe(75);
  });
  it('MAX_STATIONARY_ROUTE_CACHE_MS is 10 minutes', () => {
    expect(MAX_STATIONARY_ROUTE_CACHE_MS).toBe(10 * 60 * 1000);
  });
});

describe('routeMovementCache — checkCache decision matrix', () => {
  it('MISS_NO_PRIOR when the cache is empty', () => {
    const d = checkCache(WORKER_BASE, DEST, 0);
    expect(d.kind).toBe('MISS_NO_PRIOR');
  });

  it('HIT when worker is stationary (movement = 0m, age = 0s)', () => {
    storeCache(WORKER_BASE, DEST, ROUTE, 1_000);
    const d = checkCache(WORKER_BASE, DEST, 1_000);
    expect(d.kind).toBe('HIT');
    if (d.kind !== 'HIT') return;
    expect(d.estimate).toBe(ROUTE);
    expect(d.movedMeters).toBeLessThan(0.5); // effectively 0
    expect(d.routeAgeSeconds).toBe(0);
  });

  it('HIT under the 75m threshold — GPS jitter', () => {
    storeCache(WORKER_BASE, DEST, ROUTE, 1_000);
    // 50m north of the stored position — a common jitter distance
    const jittered = offsetNorth(WORKER_BASE, 50);
    const d = checkCache(jittered, DEST, 30_000);
    expect(d.kind).toBe('HIT');
    if (d.kind !== 'HIT') return;
    expect(d.movedMeters).toBeGreaterThan(45);
    expect(d.movedMeters).toBeLessThan(55);
    expect(d.routeAgeSeconds).toBe(29);
  });

  it('HIT right below the 75m boundary', () => {
    storeCache(WORKER_BASE, DEST, ROUTE, 0);
    const near = offsetNorth(WORKER_BASE, 74);
    const d = checkCache(near, DEST, 60_000);
    expect(d.kind).toBe('HIT');
  });

  it('MISS_MOVEMENT at exactly 75m — the threshold is inclusive-of-miss', () => {
    storeCache(WORKER_BASE, DEST, ROUTE, 0);
    const at = offsetNorth(WORKER_BASE, 75);
    const d = checkCache(at, DEST, 60_000);
    expect(d.kind).toBe('MISS_MOVEMENT');
  });

  it('MISS_MOVEMENT above 75m', () => {
    storeCache(WORKER_BASE, DEST, ROUTE, 0);
    const far = offsetNorth(WORKER_BASE, 200);
    const d = checkCache(far, DEST, 60_000);
    expect(d.kind).toBe('MISS_MOVEMENT');
    if (d.kind !== 'MISS_MOVEMENT') return;
    expect(d.movedMeters).toBeGreaterThan(150);
  });

  it('MISS_MAX_AGE after 10 minutes even with zero movement', () => {
    storeCache(WORKER_BASE, DEST, ROUTE, 0);
    const d = checkCache(WORKER_BASE, DEST, MAX_STATIONARY_ROUTE_CACHE_MS);
    expect(d.kind).toBe('MISS_MAX_AGE');
  });

  it('HIT one millisecond before the max age boundary', () => {
    storeCache(WORKER_BASE, DEST, ROUTE, 0);
    const d = checkCache(WORKER_BASE, DEST, MAX_STATIONARY_ROUTE_CACHE_MS - 1);
    expect(d.kind).toBe('HIT');
  });

  it('MISS_DEST_CHANGED when the destination differs and a prior entry exists', () => {
    storeCache(WORKER_BASE, DEST, ROUTE, 0);
    const otherDest = { lat: 33.5, lng: 35.5 };
    const d = checkCache(WORKER_BASE, otherDest, 1_000);
    expect(d.kind).toBe('MISS_DEST_CHANGED');
  });
});

describe('routeMovementCache — storeCache overwrites the entry per destination', () => {
  it('a second store for the same dest resets the position + timestamp', () => {
    storeCache(WORKER_BASE, DEST, ROUTE, 0);
    // Worker moved 500m — store again.
    const moved = offsetNorth(WORKER_BASE, 500);
    storeCache(moved, DEST, ROUTE, 5_000);
    // Distance is now measured from `moved`, not `WORKER_BASE`.
    const d = checkCache(moved, DEST, 5_000);
    expect(d.kind).toBe('HIT');
    if (d.kind !== 'HIT') return;
    expect(d.movedMeters).toBeLessThan(1);
    expect(d.routeAgeSeconds).toBe(0);
  });

  it('separate destinations get independent entries', () => {
    const destA = DEST;
    const destB = { lat: 33.5, lng: 35.5 };
    storeCache(WORKER_BASE, destA, ROUTE, 0);
    storeCache(WORKER_BASE, destB, ROUTE, 0);
    expect(_movementCacheSize()).toBe(2);
    expect(checkCache(WORKER_BASE, destA, 0).kind).toBe('HIT');
    expect(checkCache(WORKER_BASE, destB, 0).kind).toBe('HIT');
  });
});

describe('routeMovementCache — distanceMeters sanity', () => {
  it('~0 for identical points', () => {
    expect(distanceMeters(WORKER_BASE, WORKER_BASE)).toBeLessThan(0.001);
  });

  it('~1km for 1000m north offset (haversine accuracy ±1m)', () => {
    const north1km = offsetNorth(WORKER_BASE, 1000);
    const d = distanceMeters(WORKER_BASE, north1km);
    expect(d).toBeGreaterThan(999);
    expect(d).toBeLessThan(1001);
  });
});
