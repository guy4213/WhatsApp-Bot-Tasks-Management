/**
 * OpenRouteService (ORS) road-routing client.
 *
 * Mirrors the behavior contract of `osrmRoute.ts` so `routeProvider.ts` can
 * swap them behind a feature flag with no caller-visible difference:
 *
 *  - Returns `null` on ANY failure (no API key, timeout, non-2xx, malformed
 *    JSON, quota exhausted, missing route). NEVER throws. The caller decides
 *    the fallback (usually the alternate provider, then straight-line).
 *  - Short in-memory cache (default 60s) keyed on both coordinates rounded to
 *    4 decimal places (~11m precision). A `null` result is cached too so a
 *    single failure isn't hammered on every poll.
 *  - Sticky quota fallback: on HTTP 429 we set a 5-minute window during which
 *    every call short-circuits to `null` immediately without hitting the
 *    network. `routeProvider.ts` uses this to steer to OSRM while the quota
 *    replenishes.
 *  - Server-side ONLY. The API key is read from `ORS_API_KEY` and never
 *    logged, never appears in returned data, never in exception messages.
 *
 * Important vs ORS itself: ORS returns a `duration` field measured on
 * free-flow static road network — it is NOT traffic-aware. Callers must
 * treat it as a `base route duration` and never present it to end users
 * without the Conservative ETA layer on top.
 *
 * Constants live in-file (not env) per the "minimal ENV" decision; if any
 * value needs field tuning later, promote it to env one at a time.
 */
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('orsRoute');

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RoadRoute {
  /** GeoJSON LineString geometry (ORS `/geojson` endpoint). */
  geometry: unknown;
  distanceMeters: number;
  durationSeconds: number;
}

// ── Constants (code defaults, not env) ────────────────────────────────────
const ORS_BASE_URL          = 'https://api.openrouteservice.org';
const ORS_ENDPOINT_PATH     = '/v2/directions/driving-car/geojson';
const ORS_TIMEOUT_MS        = 5_000;
const ORS_CACHE_MS          = 60_000;
const ORS_QUOTA_STICKY_MS   = 300_000; // 5 min after 429

// ── In-memory state ──────────────────────────────────────────────────────
interface CacheEntry {
  value: RoadRoute | null;
  cachedAt: number;
}
const routeCache = new Map<string, CacheEntry>();

/**
 * Timestamp until which we short-circuit to null (429 sticky fallback).
 * 0 = not in sticky window.
 */
let stickyFallbackUntil = 0;

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function cacheKey(worker: LatLng, dest: LatLng): string {
  return [round4(worker.lat), round4(worker.lng), round4(dest.lat), round4(dest.lng)].join(',');
}

// ── Test-only hooks ──────────────────────────────────────────────────────

/** Test-only hook: clear the route cache between test cases. */
export function _clearOrsCache(): void {
  routeCache.clear();
  stickyFallbackUntil = 0;
}

/** Test-only hook: is ORS currently in sticky-quota fallback? */
export function _isInStickyFallback(now = Date.now()): boolean {
  return stickyFallbackUntil > now;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch a driving route from `worker` to `dest` via ORS. Returns `null` on
 * any failure or when the API key is missing — never throws.
 */
export async function getRoadRoute(worker: LatLng, dest: LatLng): Promise<RoadRoute | null> {
  const apiKey = process.env.ORS_API_KEY?.trim();
  if (!apiKey) {
    // Not an error — the deployment simply hasn't opted in. Debug-only log.
    log.debug('ORS_API_KEY not set — skipping ORS');
    return null;
  }

  // 429 sticky window: bail out cheaply without cache lookup either — we don't
  // want a stale cached result to make it look like the provider recovered.
  const nowMs = Date.now();
  if (stickyFallbackUntil > nowMs) {
    return null;
  }

  const key = cacheKey(worker, dest);
  const cached = routeCache.get(key);
  if (cached && nowMs - cached.cachedAt < ORS_CACHE_MS) {
    return cached.value;
  }

  const result = await fetchRoute(worker, dest, apiKey);
  routeCache.set(key, { value: result, cachedAt: nowMs });
  return result;
}

// ── Internals ────────────────────────────────────────────────────────────

async function fetchRoute(worker: LatLng, dest: LatLng, apiKey: string): Promise<RoadRoute | null> {
  const url = `${ORS_BASE_URL}${ORS_ENDPOINT_PATH}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ORS_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        // ORS accepts the raw key in Authorization (no "Bearer " prefix).
        Authorization: apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/geo+json',
      },
      // ORS expects [lng, lat] order.
      body: JSON.stringify({
        coordinates: [
          [worker.lng, worker.lat],
          [dest.lng, dest.lat],
        ],
      }),
    });

    if (res.status === 429) {
      stickyFallbackUntil = Date.now() + ORS_QUOTA_STICKY_MS;
      log.warn({ stickyMs: ORS_QUOTA_STICKY_MS }, 'ORS quota exhausted (429) — sticky fallback engaged');
      return null;
    }

    if (!res.ok) {
      // Deliberately do NOT include response body in the log — some upstream
      // errors could echo request details. Status code is enough to triage.
      log.warn({ status: res.status }, 'ORS non-2xx response');
      return null;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      log.warn({ err }, 'ORS response JSON parse failed');
      return null;
    }

    const parsed = extractRoute(body);
    if (!parsed) {
      log.warn('ORS response had no usable feature/summary');
      return null;
    }
    return parsed;
  } catch (err) {
    // AbortError = timeout. Anything else = network. Never re-raise. NEVER
    // include the api key in the log payload; `err` from `fetch` does not
    // carry it, but if this ever changes, review this block.
    const reason = (err as { name?: string })?.name === 'AbortError' ? 'timeout' : 'network';
    log.warn({ reason }, 'ORS fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractRoute(body: unknown): RoadRoute | null {
  const features = (body as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(features) || features.length === 0) return null;

  const feat = features[0] as {
    geometry?: unknown;
    properties?: { summary?: { distance?: unknown; duration?: unknown } };
  };
  const distance = Number(feat.properties?.summary?.distance);
  const duration = Number(feat.properties?.summary?.duration);
  if (!feat.geometry || !Number.isFinite(distance) || !Number.isFinite(duration)) {
    return null;
  }

  return {
    geometry: feat.geometry,
    distanceMeters: distance,
    durationSeconds: duration,
  };
}
