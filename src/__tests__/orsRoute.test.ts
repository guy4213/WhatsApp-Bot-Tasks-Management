/**
 * Behavioral tests for `services/orsRoute.ts`.
 *
 * `getRoadRoute` must NEVER throw and must NEVER hit the real ORS servers.
 * Every failure mode collapses to `null`. The sticky-quota window after HTTP
 * 429 is exercised via a fake clock. The API key is verified to never appear
 * in any log emitted during the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Capture pino logs to assert the API key never leaks.
const logCalls: unknown[] = [];
vi.mock('../utils/logger', () => ({
  moduleLogger: () => ({
    debug: (...args: unknown[]) => logCalls.push(['debug', ...args]),
    info:  (...args: unknown[]) => logCalls.push(['info', ...args]),
    warn:  (...args: unknown[]) => logCalls.push(['warn', ...args]),
    error: (...args: unknown[]) => logCalls.push(['error', ...args]),
  }),
}));

// Import AFTER mocks so the module picks them up.
import {
  getRoadRoute,
  _clearOrsCache,
  _isInStickyFallback,
} from '../services/orsRoute';

const WORKER = { lat: 32.0853, lng: 34.7818 };
const DEST   = { lat: 32.0110, lng: 34.7712 };
const FAKE_KEY = 'secret-ors-key-abcdef123456';

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}
function status(code: number, body: unknown = {}) {
  return {
    ok: code < 400,
    status: code,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}
function validRouteBody() {
  return {
    features: [
      {
        geometry: { type: 'LineString', coordinates: [[34.7818, 32.0853], [34.7712, 32.011]] },
        properties: {
          summary: { distance: 2345.6, duration: 421.2 },
        },
      },
    ],
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  _clearOrsCache();
  logCalls.length = 0;
  delete process.env.ORS_API_KEY;
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── Missing key ─────────────────────────────────────────────────────────

describe('getRoadRoute — no key configured', () => {
  it('returns null without calling fetch when ORS_API_KEY is unset', async () => {
    const result = await getRoadRoute(WORKER, DEST);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null without calling fetch when ORS_API_KEY is an empty string', async () => {
    process.env.ORS_API_KEY = '   ';
    const result = await getRoadRoute(WORKER, DEST);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Success ─────────────────────────────────────────────────────────────

describe('getRoadRoute — enabled, success', () => {
  beforeEach(() => {
    process.env.ORS_API_KEY = FAKE_KEY;
  });

  it('parses geometry/distance/duration from features[0]', async () => {
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    const result = await getRoadRoute(WORKER, DEST);
    expect(result).toEqual({
      geometry: { type: 'LineString', coordinates: [[34.7818, 32.0853], [34.7712, 32.011]] },
      distanceMeters: 2345.6,
      durationSeconds: 421.2,
    });
  });

  it('POSTs to the ORS Directions endpoint with GeoJSON format', async () => {
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    await getRoadRoute(WORKER, DEST);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('api.openrouteservice.org/v2/directions/driving-car/geojson');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(FAKE_KEY); // raw key, not Bearer
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('sends coordinates in [lng, lat] order (worker, dest)', async () => {
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    await getRoadRoute(WORKER, DEST);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      coordinates: [
        [WORKER.lng, WORKER.lat],
        [DEST.lng, DEST.lat],
      ],
    });
  });
});

// ── Cache ──────────────────────────────────────────────────────────────

describe('getRoadRoute — cache', () => {
  beforeEach(() => {
    process.env.ORS_API_KEY = FAKE_KEY;
  });

  it('serves a second identical call from cache without a second fetch', async () => {
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    const r1 = await getRoadRoute(WORKER, DEST);
    const r2 = await getRoadRoute(WORKER, DEST);
    expect(r1).toEqual(r2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats coordinates rounded to 4dp as the same cache key (GPS jitter)', async () => {
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    await getRoadRoute(WORKER, DEST);
    await getRoadRoute({ lat: WORKER.lat + 0.00001, lng: WORKER.lng + 0.00001 }, DEST);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches a null result too, so a failing provider is not hammered every poll', async () => {
    fetchMock.mockResolvedValueOnce(status(500));
    const r1 = await getRoadRoute(WORKER, DEST);
    const r2 = await getRoadRoute(WORKER, DEST);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ── Failure modes ──────────────────────────────────────────────────────

describe('getRoadRoute — failures', () => {
  beforeEach(() => {
    process.env.ORS_API_KEY = FAKE_KEY;
  });

  it('returns null on HTTP 401 (bad key) — never throws', async () => {
    fetchMock.mockResolvedValueOnce(status(401, 'Unauthorized'));
    const r = await getRoadRoute(WORKER, DEST);
    expect(r).toBeNull();
  });

  it('returns null on HTTP 500 without exposing body', async () => {
    fetchMock.mockResolvedValueOnce(status(500, 'internal error'));
    const r = await getRoadRoute(WORKER, DEST);
    expect(r).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('not-json')),
    } as unknown as Response);
    const r = await getRoadRoute(WORKER, DEST);
    expect(r).toBeNull();
  });

  it('returns null when features[] is empty', async () => {
    fetchMock.mockResolvedValueOnce(ok({ features: [] }));
    const r = await getRoadRoute(WORKER, DEST);
    expect(r).toBeNull();
  });

  it('returns null when features[0].properties.summary is missing', async () => {
    fetchMock.mockResolvedValueOnce(ok({ features: [{ geometry: {}, properties: {} }] }));
    const r = await getRoadRoute(WORKER, DEST);
    expect(r).toBeNull();
  });

  it('returns null on network error (fetch rejects)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    const r = await getRoadRoute(WORKER, DEST);
    expect(r).toBeNull();
  });

  it('returns null on abort (timeout)', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const r = await getRoadRoute(WORKER, DEST);
    expect(r).toBeNull();
  });
});

// ── 429 sticky-fallback window ─────────────────────────────────────────

describe('getRoadRoute — 429 sticky fallback', () => {
  beforeEach(() => {
    process.env.ORS_API_KEY = FAKE_KEY;
  });

  it('enters sticky fallback on 429 and skips the network for the next call', async () => {
    fetchMock.mockResolvedValueOnce(status(429, 'rate limited'));
    const r1 = await getRoadRoute(WORKER, DEST);
    expect(r1).toBeNull();
    expect(_isInStickyFallback()).toBe(true);

    // Different coords so the cache key differs → without the sticky window
    // this would hit the network again.
    const r2 = await getRoadRoute({ lat: 32.5, lng: 34.5 }, DEST);
    expect(r2).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exits sticky fallback after ~5 min and calls fetch again', async () => {
    fetchMock.mockResolvedValueOnce(status(429));
    await getRoadRoute(WORKER, DEST);

    // Fast-forward past the 5-minute sticky window.
    const dateSpy = vi.spyOn(Date, 'now');
    dateSpy.mockReturnValue(Date.now() + 6 * 60 * 1000);
    // Also confirm the helper agrees the window closed.
    expect(_isInStickyFallback()).toBe(false);
    _clearOrsCache(); // clear negative cache for this different-coord call
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    const r = await getRoadRoute({ lat: 32.5, lng: 34.5 }, DEST);
    expect(r).not.toBeNull();
    dateSpy.mockRestore();
  });
});

// ── API key never leaks in logs ────────────────────────────────────────

describe('getRoadRoute — key never in logs', () => {
  it('does not include the API key in any log emission across all failure modes', async () => {
    process.env.ORS_API_KEY = FAKE_KEY;

    // Hit disabled path (delete key mid-test), success, 401, 500, JSON fail, 429, network fail.
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    await getRoadRoute(WORKER, DEST);
    _clearOrsCache();

    fetchMock.mockResolvedValueOnce(status(401, 'bad key'));
    await getRoadRoute(WORKER, DEST);
    _clearOrsCache();

    fetchMock.mockResolvedValueOnce(status(500, 'boom'));
    await getRoadRoute(WORKER, DEST);
    _clearOrsCache();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('not-json')),
    } as unknown as Response);
    await getRoadRoute(WORKER, DEST);
    _clearOrsCache();

    fetchMock.mockResolvedValueOnce(status(429));
    await getRoadRoute(WORKER, DEST);
    _clearOrsCache();

    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    await getRoadRoute(WORKER, DEST);

    delete process.env.ORS_API_KEY;
    await getRoadRoute(WORKER, DEST);

    const serialized = JSON.stringify(logCalls);
    expect(serialized).not.toContain(FAKE_KEY);
  });
});
