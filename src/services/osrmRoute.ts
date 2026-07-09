/**
 * OSRM (Open Source Routing Machine) road-routing client.
 *
 * TRACK-A — Wolt-lite live tracking enrichment. This gives the customer
 * tracking page a real ROAD route + duration between the worker's last GPS
 * fix and the destination, instead of a straight line.
 *
 * IMPORTANT (product owner): this is a road-routing ESTIMATE computed from
 * the worker's latest reported GPS point. It is NOT traffic-aware and is NOT
 * a "Waze ETA" — there is no live traffic model behind it, just shortest/
 * fastest static road distance. Any user-facing wording derived from this
 * MUST say "זמן הגעה משוער" (an estimate), never imply real-time traffic
 * awareness.
 *
 * Behavior contract:
 *  - Disabled by default (`TRACKING_OSRM_ENABLED` must be the exact string
 *    'true' to enable). Disabled → immediate `null`, no network call.
 *  - Never throws. ANY failure (disabled, timeout/abort, non-200, malformed
 *    JSON, no routes) resolves to `null`. The caller decides the fallback
 *    (straight-line distance) and the user-facing `fallbackReason`.
 *  - Short in-memory cache (default 20s) keyed on both coordinates rounded
 *    to 4 decimal places (~11m precision) — a worker's GPS jitters slightly
 *    between polls, so this avoids hammering OSRM on every request while
 *    still refreshing frequently enough to feel "live". A `null` result is
 *    also cached briefly so a failing/unreachable OSRM server isn't retried
 *    on every single poll.
 *  - The public demo server (`https://router.project-osrm.org`, the
 *    default `OSRM_BASE_URL`) is documented by OSRM as suitable for
 *    development/evaluation only — NOT for production load. Point
 *    `OSRM_BASE_URL` at a self-hosted instance before relying on this in
 *    production.
 */
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('osrm');

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RoadRoute {
  /** GeoJSON LineString geometry (OSRM `geometries=geojson`). */
  geometry: unknown;
  distanceMeters: number;
  durationSeconds: number;
}

const DEFAULT_BASE_URL = 'https://router.project-osrm.org';
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_MS = 20_000;

function baseUrl(): string {
  return process.env.OSRM_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

function timeoutMs(): number {
  return DEFAULT_TIMEOUT_MS;
}

function cacheMs(): number {
  const raw = process.env.TRACKING_OSRM_CACHE_MS;
  if (!raw) return DEFAULT_CACHE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CACHE_MS;
}

function isEnabled(): boolean {
  return process.env.TRACKING_OSRM_ENABLED === 'true';
}

// ── In-memory TTL cache ─────────────────────────────────────────────────────
// Key: coordinates rounded to 4 decimal places (both points) — jitter-tolerant.
// Value: cached result (route or null-for-failure) + the time it was written.

interface CacheEntry {
  value: RoadRoute | null;
  cachedAt: number;
}

const routeCache = new Map<string, CacheEntry>();

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function cacheKey(worker: LatLng, dest: LatLng): string {
  return [round4(worker.lat), round4(worker.lng), round4(dest.lat), round4(dest.lng)].join(',');
}

/** Test-only hook: clear the route cache between test cases. */
export function _clearRouteCache(): void {
  routeCache.clear();
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch a driving route from `worker` to `dest` via OSRM. Returns `null` on
 * any failure or when routing is disabled — never throws.
 */
export async function getRoadRoute(worker: LatLng, dest: LatLng): Promise<RoadRoute | null> {
  if (!isEnabled()) {
    log.debug({ worker, dest }, 'OSRM routing disabled (TRACKING_OSRM_ENABLED != true)');
    return null;
  }

  const key = cacheKey(worker, dest);
  const cached = routeCache.get(key);
  if (cached && Date.now() - cached.cachedAt < cacheMs()) {
    return cached.value;
  }

  const result = await fetchRoute(worker, dest);
  routeCache.set(key, { value: result, cachedAt: Date.now() });
  return result;
}

async function fetchRoute(worker: LatLng, dest: LatLng): Promise<RoadRoute | null> {
  // OSRM expects lng,lat order (GeoJSON convention), NOT lat,lng.
  const url =
    `${baseUrl()}/route/v1/driving/` +
    `${worker.lng},${worker.lat};${dest.lng},${dest.lat}` +
    `?overview=full&geometries=geojson`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs());

  try {
    const res = await fetch(url, { signal: ctrl.signal });

    if (!res.ok) {
      log.warn({ status: res.status, url }, 'OSRM non-200 response');
      return null;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      log.warn({ err }, 'OSRM response JSON parse failed');
      return null;
    }

    const routes = (body as { routes?: unknown[] } | null)?.routes;
    if (!Array.isArray(routes) || routes.length === 0) {
      log.warn({ body }, 'OSRM response had no routes');
      return null;
    }

    const first = routes[0] as {
      geometry?: unknown;
      distance?: unknown;
      duration?: unknown;
    };
    const distance = Number(first.distance);
    const duration = Number(first.duration);
    if (!first.geometry || !Number.isFinite(distance) || !Number.isFinite(duration)) {
      log.warn({ first }, 'OSRM route missing geometry/distance/duration');
      return null;
    }

    return {
      geometry: first.geometry,
      distanceMeters: distance,
      durationSeconds: duration,
    };
  } catch (err) {
    const reason = (err as { name?: string })?.name === 'AbortError' ? 'timeout' : 'network';
    log.warn({ err, reason, url }, 'OSRM fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
