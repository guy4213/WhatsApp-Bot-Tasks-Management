/**
 * Nominatim (OpenStreetMap) forward-geocoder client.
 *
 * MVP+1 for the customer tracking page — see
 * `docs/CUSTOMER_TRACKING_PAGE_DESTINATION.md`.
 *
 * Result shape is a DISCRIMINATED UNION on purpose:
 *   - `{ kind: 'hit', lat, lng }`      — Nominatim returned coordinates.
 *   - `{ kind: 'empty' }`              — Nominatim returned an empty array.
 *                                        Caller MAY cache this as `no_hit` so
 *                                        we don't hammer Nominatim for the
 *                                        same unresolvable string.
 *   - `{ kind: 'transient', reason }`  — network error, timeout, 5xx, or
 *                                        JSON parse failure. Caller MUST NOT
 *                                        cache — try again on the next call.
 *
 * The function never throws. Any exception is mapped into a `transient`
 * result. This is deliberate: the tracking page must always render, geocoding
 * is a best-effort enrichment.
 *
 * Nominatim ToS compliance:
 *  - Custom `User-Agent` identifies the app (per policy — the default fetch
 *    UA is refused by Nominatim).
 *  - Single-instance token bucket at 1 req/s. Cache-miss traffic is already
 *    naturally < 1 req/s; the bucket is defense-in-depth against future
 *    accidental hammering.
 *  - No batch / bulk usage — one address at a time, only on cache miss.
 *  - The customer page still shows OSM attribution via the tile layer, which
 *    doubles as the geocoding attribution.
 */
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('geocoder');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT    = process.env.GEOCODER_USER_AGENT ?? 'GalitTrackingBot/1.0';
const TIMEOUT_MS    = 3_000;
const MIN_INTERVAL_MS = 1_000;      // Nominatim policy: at most 1 req/s

export type GeocodeResult =
  | { kind: 'hit'; lat: number; lng: number }
  | { kind: 'empty' }
  | { kind: 'transient'; reason: string };

// ── Rate limit ─────────────────────────────────────────────────────────────
// Single-process token bucket. We don't run multi-instance so this is enough.
let lastCallAt = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const delta = now - lastCallAt;
  if (delta < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - delta));
  }
  lastCallAt = Date.now();
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Forward-geocode a free-text query (e.g., "אלופי צה\"ל 48, חולון") into
 * lat/lng via Nominatim. Never throws. See file header for the result shape
 * semantics — the caller must distinguish `empty` (sticky) from `transient`
 * (do NOT cache).
 */
export async function geocodeAddress(query: string): Promise<GeocodeResult> {
  const q = query.trim();
  if (!q) return { kind: 'empty' };

  await throttle();

  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': 'he,en;q=0.7',
      },
    });

    if (res.status >= 500) {
      log.warn({ query: q, status: res.status }, 'Nominatim 5xx');
      return { kind: 'transient', reason: `http_${res.status}` };
    }
    if (!res.ok) {
      // 4xx: treat as transient too. A 429 (rate limit) is the most likely
      // 4xx here; we do NOT want to sticky-cache the address as "no_hit"
      // just because we were throttled.
      log.warn({ query: q, status: res.status }, 'Nominatim 4xx');
      return { kind: 'transient', reason: `http_${res.status}` };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      log.warn({ err, query: q }, 'Nominatim JSON parse failed');
      return { kind: 'transient', reason: 'parse_error' };
    }

    if (!Array.isArray(body) || body.length === 0) {
      log.info({ query: q }, 'Nominatim empty result');
      return { kind: 'empty' };
    }

    const first = body[0] as Record<string, unknown>;
    const lat = parseFloat(String(first.lat));
    const lng = parseFloat(String(first.lon));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      // Malformed hit — same discipline as parse error: transient.
      log.warn({ query: q, first }, 'Nominatim hit missing numeric lat/lon');
      return { kind: 'transient', reason: 'malformed_hit' };
    }
    return { kind: 'hit', lat, lng };
  } catch (err) {
    const reason =
      (err as { name?: string })?.name === 'AbortError' ? 'timeout' : 'network';
    log.warn({ err, query: q, reason }, 'Nominatim fetch failed');
    return { kind: 'transient', reason };
  } finally {
    clearTimeout(timer);
  }
}

// Test-only: reset the internal throttle state so tests do not have to wait.
export function __resetGeocoderStateForTests(): void {
  lastCallAt = 0;
}
