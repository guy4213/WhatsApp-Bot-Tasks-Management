/**
 * Route provider orchestrator — picks ORS or OSRM behind the
 * `TRACKING_ROUTE_PROVIDER` flag and falls back transparently.
 *
 * Selection rules:
 *  - `TRACKING_ROUTE_PROVIDER=openrouteservice` → try ORS first, on `null`
 *    fall back to OSRM. Callers see whichever succeeded (or `null` when both
 *    fail).
 *  - `TRACKING_ROUTE_PROVIDER=osrm` (default, or any other value)      → OSRM
 *    only. ORS is never called. Backward-compatible with the pre-ORS world.
 *
 * The underlying gates each provider already respects still apply:
 *  - OSRM only fires when `TRACKING_OSRM_ENABLED === 'true'` (unchanged).
 *  - ORS only fires when `ORS_API_KEY` is set. On HTTP 429 ORS engages a
 *    5-minute sticky-fallback (implemented inside `orsRoute`) — during that
 *    window, `getRoadRouteFromOrs` returns `null` cheaply and we naturally
 *    fall through to OSRM.
 *
 * The `provider` field is INTERNAL — used for logs and tests. Callers should
 * NOT expose it in customer-facing responses; from the tracking page's
 * perspective a road route is a road route.
 *
 * Straight-line fallback is NOT this file's concern — the caller
 * (`tracking.ts`) already handles it when this function returns `null`.
 */
import { getRoadRoute as getRoadRouteFromOsrm } from './osrmRoute';
import { getRoadRoute as getRoadRouteFromOrs } from './orsRoute';
import type { LatLng, RoadRoute } from './orsRoute';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('routeProvider');

export type RouteProvider = 'openrouteservice' | 'osrm';

export interface RouteEstimate extends RoadRoute {
  provider: RouteProvider;
}

/** The provider order for a given env value. Callers rarely need this. */
function primaryProvider(): RouteProvider {
  return process.env.TRACKING_ROUTE_PROVIDER === 'openrouteservice'
    ? 'openrouteservice'
    : 'osrm';
}

/**
 * Fetch a driving route for `worker → dest`, from whichever configured
 * provider is available. Returns `null` when neither provider can serve —
 * caller falls back to straight-line.
 */
export async function getRouteEstimate(
  worker: LatLng,
  dest: LatLng,
): Promise<RouteEstimate | null> {
  const primary = primaryProvider();

  if (primary === 'openrouteservice') {
    const ors = await getRoadRouteFromOrs(worker, dest);
    if (ors) {
      return { ...ors, provider: 'openrouteservice' };
    }
    // ORS failed / quota / no key — fall through to OSRM.
    const osrm = await getRoadRouteFromOsrm(worker, dest);
    if (osrm) {
      log.debug('ORS unavailable, served route via OSRM fallback');
      return { ...osrm, provider: 'osrm' };
    }
    return null;
  }

  // primary === 'osrm' (default). ORS is never contacted.
  const osrm = await getRoadRouteFromOsrm(worker, dest);
  if (osrm) {
    return { ...osrm, provider: 'osrm' };
  }
  return null;
}

// Re-export so callers can keep a single import surface.
export type { LatLng, RoadRoute } from './orsRoute';
