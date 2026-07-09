/**
 * POC — OpenRouteService (ORS) Directions API feasibility check.
 *
 * Small standalone script. Verifies that ORS_API_KEY is present, calls the ORS
 * Directions API with a fixed Israeli route (Ra'anana → Tel Aviv), and prints
 * distance / duration / geometry summary. Also queries the public OSRM demo
 * server (default OSRM_BASE_URL) for a same-route comparison — read-only,
 * bypasses the TRACKING_OSRM_ENABLED gate on purpose so the comparison works
 * without touching env used by production.
 *
 * DOES NOT modify or import from any production tracking code path:
 *   - src/services/tracking.ts
 *   - src/services/osrmRoute.ts
 *   - src/routes/trackingPage.template.ts
 *   - src/ai/router.ts
 *   - src/services/customerNotifications.ts
 *
 * The API key is read from the environment ONLY and is never logged, echoed,
 * or included in the response the script prints.
 *
 * Run locally:
 *   ORS_API_KEY=xxx npx tsx scripts/orsRoutePoc.ts
 *   # or put ORS_API_KEY in .env, then:
 *   npx tsx scripts/orsRoutePoc.ts
 *
 * Exit codes: 0 on success (at least ORS OR OSRM returned a valid route),
 * 1 on a fatal error, 2 on missing ORS_API_KEY.
 */
import 'dotenv/config';

const ORS_ENDPOINT =
  'https://api.openrouteservice.org/v2/directions/driving-car/geojson';
const OSRM_BASE_URL =
  process.env.OSRM_BASE_URL?.trim() || 'https://router.project-osrm.org';
const TIMEOUT_MS = 5_000;

// Ra'anana (Ahuza area) → Tel Aviv (Rothschild area). Two well-known Israeli
// city coordinates — a route of ~20 km / ~25 min via Ayalon is a reasonable
// sanity check against both providers.
const ORIGIN = { lat: 32.1848, lng: 34.8676, label: "Ra'anana (Ahuza)" };
const DEST   = { lat: 32.0645, lng: 34.7734, label: 'Tel Aviv (Rothschild)' };

interface RouteResult {
  provider: 'openrouteservice' | 'osrm';
  ok: boolean;
  httpStatus: number | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  durationMinutes: number | null;
  geometrySummary: string | null;
  responseMs: number;
  error: string | null;
}

function baseResult(provider: RouteResult['provider']): RouteResult {
  return {
    provider,
    ok: false,
    httpStatus: null,
    distanceMeters: null,
    durationSeconds: null,
    durationMinutes: null,
    geometrySummary: null,
    responseMs: 0,
    error: null,
  };
}

function abortMessage(err: unknown, elapsedMs: number): string {
  const name = (err as { name?: string })?.name;
  if (name === 'AbortError') return `timeout after ${TIMEOUT_MS}ms (elapsed ${elapsedMs}ms)`;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

async function callOrs(apiKey: string): Promise<RouteResult> {
  const result = baseResult('openrouteservice');
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ORS_ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        // ORS supports the raw key in the Authorization header. Do not include
        // "Bearer " — ORS expects the key value directly.
        Authorization: apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/geo+json',
      },
      body: JSON.stringify({
        // ORS expects [lng, lat] order (GeoJSON convention).
        coordinates: [
          [ORIGIN.lng, ORIGIN.lat],
          [DEST.lng, DEST.lat],
        ],
      }),
    });
    result.responseMs = Date.now() - started;
    result.httpStatus = res.status;

    if (!res.ok) {
      let bodySnippet = '';
      try {
        bodySnippet = (await res.text()).slice(0, 200);
      } catch {
        // ignored — the status alone is a good enough signal
      }
      result.error = `HTTP ${res.status}${bodySnippet ? ` — ${bodySnippet}` : ''}`;
      return result;
    }

    const body = (await res.json()) as {
      features?: Array<{
        geometry?: { type?: string; coordinates?: unknown[] };
        properties?: { summary?: { distance?: number; duration?: number } };
      }>;
    };
    const feat = body.features?.[0];
    const summary = feat?.properties?.summary;
    const distance = Number(summary?.distance);
    const duration = Number(summary?.duration);

    if (!Number.isFinite(distance) || !Number.isFinite(duration)) {
      result.error = 'response missing features[0].properties.summary.distance/duration';
      return result;
    }

    const coords = feat?.geometry?.coordinates;
    result.ok = true;
    result.distanceMeters = Math.round(distance);
    result.durationSeconds = Math.round(duration);
    result.durationMinutes = Math.round(duration / 60);
    result.geometrySummary = Array.isArray(coords)
      ? `LineString: ${coords.length} points`
      : 'no geometry';
    return result;
  } catch (err) {
    result.responseMs = Date.now() - started;
    result.error = abortMessage(err, result.responseMs);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function callOsrm(): Promise<RouteResult> {
  const result = baseResult('osrm');
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  // OSRM expects lng,lat order (GeoJSON convention), NOT lat,lng.
  const url =
    `${OSRM_BASE_URL}/route/v1/driving/` +
    `${ORIGIN.lng},${ORIGIN.lat};${DEST.lng},${DEST.lat}` +
    `?overview=full&geometries=geojson`;

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    result.responseMs = Date.now() - started;
    result.httpStatus = res.status;

    if (!res.ok) {
      result.error = `HTTP ${res.status}`;
      return result;
    }
    const body = (await res.json()) as {
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: unknown[] };
      }>;
    };
    const first = body.routes?.[0];
    const distance = Number(first?.distance);
    const duration = Number(first?.duration);
    if (!Number.isFinite(distance) || !Number.isFinite(duration)) {
      result.error = 'response missing routes[0].distance/duration';
      return result;
    }
    const coords = first?.geometry?.coordinates;
    result.ok = true;
    result.distanceMeters = Math.round(distance);
    result.durationSeconds = Math.round(duration);
    result.durationMinutes = Math.round(duration / 60);
    result.geometrySummary = Array.isArray(coords)
      ? `LineString: ${coords.length} points`
      : 'no geometry';
    return result;
  } catch (err) {
    result.responseMs = Date.now() - started;
    result.error = abortMessage(err, result.responseMs);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function printResult(r: RouteResult): void {
  console.log(`  provider:        ${r.provider}`);
  console.log(`  ok:              ${r.ok}`);
  if (r.httpStatus !== null) console.log(`  httpStatus:      ${r.httpStatus}`);
  if (r.ok) {
    const km = (r.distanceMeters ?? 0) / 1000;
    console.log(`  distanceMeters:  ${r.distanceMeters}`);
    console.log(`  distanceKm:      ${km.toFixed(2)}`);
    console.log(`  durationSeconds: ${r.durationSeconds}`);
    console.log(`  durationMinutes: ${r.durationMinutes}`);
    console.log(`  geometry:        ${r.geometrySummary}`);
  } else {
    console.log(`  error:           ${r.error ?? '(no details)'}`);
  }
  console.log(`  responseMs:      ${r.responseMs}`);
}

async function main(): Promise<void> {
  const apiKey = process.env.ORS_API_KEY?.trim();

  console.log('=== OpenRouteService POC ===');
  console.log(
    `Route: ${ORIGIN.label} (${ORIGIN.lat}, ${ORIGIN.lng}) ` +
    `→ ${DEST.label} (${DEST.lat}, ${DEST.lng})`,
  );
  console.log(`Timeout: ${TIMEOUT_MS}ms`);
  console.log(`OSRM base: ${OSRM_BASE_URL}`);
  console.log('');

  if (!apiKey) {
    console.log('ORS_API_KEY is not set.');
    console.log('Set it in .env or pass inline:');
    console.log('  ORS_API_KEY=xxxxx npx tsx scripts/orsRoutePoc.ts');
    console.log('');
    console.log('Skipping ORS call. Running OSRM comparison only:');
    console.log('');
    console.log('--- OSRM ---');
    const osrmOnly = await callOsrm();
    printResult(osrmOnly);
    process.exit(2);
  }
  // Presence acknowledged; the key itself is never printed.
  console.log('ORS_API_KEY: loaded from environment (value redacted)');
  console.log('');

  console.log('--- OpenRouteService ---');
  const ors = await callOrs(apiKey);
  printResult(ors);
  console.log('');

  console.log('--- OSRM (comparison) ---');
  const osrm = await callOsrm();
  printResult(osrm);
  console.log('');

  if (ors.ok && osrm.ok) {
    const dDist = (ors.distanceMeters ?? 0) - (osrm.distanceMeters ?? 0);
    const dDur  = (ors.durationSeconds ?? 0) - (osrm.durationSeconds ?? 0);
    const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
    console.log('--- Diff (ORS - OSRM) ---');
    console.log(`  distanceMeters:  ${sign(dDist)}`);
    console.log(`  durationSeconds: ${sign(dDur)}`);
    console.log(`  durationMinutes: ${sign(Math.round(dDur / 60))}`);
    console.log('');
  }

  const exitOk = ors.ok || osrm.ok;
  process.exit(exitOk ? 0 : 1);
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
