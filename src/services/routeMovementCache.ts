/**
 * Movement-gated route cache — sits above `routeProvider.getRouteEstimate` to
 * suppress redundant provider calls (ORS / OSRM) when the worker hasn't moved
 * meaningfully.
 *
 * Why:
 *   ORS's own in-memory cache is keyed on 4-decimal coords (~11m precision).
 *   Real-world GPS jitter frequently exceeds 11m even for a stationary phone,
 *   which busts that cache and causes every tracking poll to hit ORS. The
 *   customer isn't seeing anything different — the route from a spot 20m away
 *   is the same road route — but the ORS quota drains for nothing.
 *
 * Contract:
 *   - Cache key = destination coords rounded to 4 decimals (~11m). A single
 *     worker chasing a different destination gets a separate cache entry.
 *   - HIT when the worker moved LESS THAN `MIN_ROUTE_RECALC_MOVE_METERS` from
 *     the position used to compute the stored route AND the entry is younger
 *     than `MAX_STATIONARY_ROUTE_CACHE_MS`.
 *   - MISS on: no prior entry / destination changed (different key) /
 *     movement ≥ threshold / entry older than max stationary window.
 *   - Only SUCCESSFUL route estimates are stored — null results are never
 *     cached here (orsRoute.ts still has its own short null-cache).
 *   - This module owns no I/O, no env, no DB. Pure decisions + a Map.
 *
 * Both gates are code constants (per the "minimal ENV" decision). Promote to
 * env only if we ever need per-deployment tuning.
 */
import type { LatLng } from './orsRoute';
import type { RouteEstimate } from './routeProvider';

/** Movement threshold below which we reuse the last stored route. */
export const MIN_ROUTE_RECALC_MOVE_METERS = 75;

/** Force a refresh after this long even if the worker hasn't moved — bounds
 *  cache staleness when a phone sits still for a while. */
export const MAX_STATIONARY_ROUTE_CACHE_MS = 10 * 60 * 1000;

interface Entry {
  worker: LatLng;
  estimate: RouteEstimate;
  cachedAt: number;
}

const cache = new Map<string, Entry>();

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Cache key = destination rounded to 4 decimals (matches orsRoute precision). */
function destKey(dest: LatLng): string {
  return `${round4(dest.lat)},${round4(dest.lng)}`;
}

/**
 * Great-circle distance in meters. Local copy so this module has zero coupling
 * to `tracking.ts` internals; the formula is small and universally correct for
 * routing-scale distances.
 */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export type MovementDecision =
  | {
      kind: 'HIT';
      estimate: RouteEstimate;
      movedMeters: number;
      routeAgeSeconds: number;
    }
  | { kind: 'MISS_NO_PRIOR' }
  | { kind: 'MISS_DEST_CHANGED' }
  | { kind: 'MISS_MOVEMENT'; movedMeters: number; routeAgeSeconds: number }
  | { kind: 'MISS_MAX_AGE'; movedMeters: number; routeAgeSeconds: number };

/**
 * Decide whether the caller can reuse the last stored route or must call the
 * provider again. `MISS_DEST_CHANGED` is only reachable through the internal
 * key path — the public API surfaces it when a caller supplies a dest the
 * cache has never seen while ALSO having some prior route (rare in practice
 * for the tracking flow, since one session = one dest).
 */
export function checkCache(
  worker: LatLng,
  dest: LatLng,
  now: number = Date.now(),
): MovementDecision {
  const key = destKey(dest);
  const entry = cache.get(key);
  if (!entry) {
    // No prior — but distinguish "empty cache" from "different dest with
    // entries in other slots" so callers can log accurately.
    return cache.size === 0 ? { kind: 'MISS_NO_PRIOR' } : { kind: 'MISS_DEST_CHANGED' };
  }

  const movedMeters = distanceMeters(entry.worker, worker);
  const ageMs = Math.max(0, now - entry.cachedAt);
  const routeAgeSeconds = Math.floor(ageMs / 1000);

  if (ageMs >= MAX_STATIONARY_ROUTE_CACHE_MS) {
    return { kind: 'MISS_MAX_AGE', movedMeters, routeAgeSeconds };
  }
  if (movedMeters >= MIN_ROUTE_RECALC_MOVE_METERS) {
    return { kind: 'MISS_MOVEMENT', movedMeters, routeAgeSeconds };
  }
  return { kind: 'HIT', estimate: entry.estimate, movedMeters, routeAgeSeconds };
}

/** Store a fresh route so subsequent nearby calls can short-circuit. */
export function storeCache(
  worker: LatLng,
  dest: LatLng,
  estimate: RouteEstimate,
  now: number = Date.now(),
): void {
  cache.set(destKey(dest), { worker, estimate, cachedAt: now });
}

// ── Test-only hooks ──────────────────────────────────────────────────────────

export function _clearMovementCache(): void {
  cache.clear();
}

export function _movementCacheSize(): number {
  return cache.size;
}
