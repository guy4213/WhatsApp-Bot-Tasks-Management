/**
 * Behavioral tests for `services/osrmRoute.ts`.
 *
 * `getRoadRoute` must NEVER throw and must NEVER hit the real OSRM server —
 * every failure mode (disabled, timeout, non-200, malformed JSON, no routes)
 * collapses to `null`. These tests also protect the short-TTL cache: a
 * failing/unreachable OSRM must not be hammered on every poll, and GPS
 * jitter (coordinates rounded to 4dp) must not bust the cache key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Import AFTER stubbing global fetch so the module sees the mock.
import { getRoadRoute, _clearRouteCache } from '../services/osrmRoute';

const WORKER = { lat: 32.0853, lng: 34.7818 };
const DEST = { lat: 32.0110, lng: 34.7712 };

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}
function status(code: number) {
  return {
    ok: code < 400,
    status: code,
    json: () => Promise.resolve({}),
  } as unknown as Response;
}
function validRouteBody() {
  return {
    routes: [
      {
        geometry: { type: 'LineString', coordinates: [[34.7818, 32.0853], [34.7712, 32.011]] },
        distance: 1234.5,
        duration: 210.7,
      },
    ],
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  _clearRouteCache();
  delete process.env.TRACKING_OSRM_ENABLED;
  delete process.env.OSRM_BASE_URL;
  delete process.env.TRACKING_OSRM_CACHE_MS;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('getRoadRoute — disabled by default', () => {
  it('returns null without calling fetch when TRACKING_OSRM_ENABLED is unset', async () => {
    const result = await getRoadRoute(WORKER, DEST);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null without calling fetch when TRACKING_OSRM_ENABLED is any non-"true" value', async () => {
    process.env.TRACKING_OSRM_ENABLED = 'false';
    const result = await getRoadRoute(WORKER, DEST);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getRoadRoute — enabled, success parse', () => {
  beforeEach(() => {
    process.env.TRACKING_OSRM_ENABLED = 'true';
  });

  it('parses geometry/distance/duration from routes[0]', async () => {
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    const result = await getRoadRoute(WORKER, DEST);
    expect(result).toEqual({
      geometry: { type: 'LineString', coordinates: [[34.7818, 32.0853], [34.7712, 32.011]] },
      distanceMeters: 1234.5,
      durationSeconds: 210.7,
    });
  });

  it('requests OSRM with coordinates in lng,lat order (worker;dest)', async () => {
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    await getRoadRoute(WORKER, DEST);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain(`/route/v1/driving/${WORKER.lng},${WORKER.lat};${DEST.lng},${DEST.lat}`);
    expect(url).toContain('overview=full');
    expect(url).toContain('geometries=geojson');
  });

  it('uses OSRM_BASE_URL when set, defaulting to the public demo server otherwise', async () => {
    process.env.OSRM_BASE_URL = 'https://my-osrm.internal';
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    await getRoadRoute(WORKER, DEST);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/my-osrm\.internal\/route/);
  });

  it('returns null on timeout/abort', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(err);
    const result = await getRoadRoute(WORKER, DEST);
    expect(result).toBeNull();
  });

  it('returns null on a network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await getRoadRoute(WORKER, DEST);
    expect(result).toBeNull();
  });

  it('returns null on non-200 responses', async () => {
    fetchMock.mockResolvedValueOnce(status(500));
    const result = await getRoadRoute(WORKER, DEST);
    expect(result).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('bad json')),
    } as unknown as Response);
    const result = await getRoadRoute(WORKER, DEST);
    expect(result).toBeNull();
  });

  it('returns null when the response has no routes', async () => {
    fetchMock.mockResolvedValueOnce(ok({ routes: [] }));
    const result = await getRoadRoute(WORKER, DEST);
    expect(result).toBeNull();
  });

  it('returns null when a route is missing distance/duration/geometry', async () => {
    fetchMock.mockResolvedValueOnce(ok({ routes: [{ geometry: null, distance: 'x', duration: 'y' }] }));
    const result = await getRoadRoute(WORKER, DEST);
    expect(result).toBeNull();
  });

  it('never throws even when fetch itself throws synchronously', async () => {
    fetchMock.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(getRoadRoute(WORKER, DEST)).resolves.toBeNull();
  });
});

describe('getRoadRoute — cache', () => {
  beforeEach(() => {
    process.env.TRACKING_OSRM_ENABLED = 'true';
  });

  it('a second call within the TTL for the same coordinates hits the cache (only 1 fetch)', async () => {
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    const first = await getRoadRoute(WORKER, DEST);
    const second = await getRoadRoute(WORKER, DEST);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('rounds coordinates to 4 decimal places for the cache key — a 0.00001 jitter still hits the cache', async () => {
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    await getRoadRoute(WORKER, DEST);
    const jitteredWorker = { lat: WORKER.lat + 0.00001, lng: WORKER.lng + 0.00001 };
    await getRoadRoute(jitteredWorker, DEST);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a coordinate change beyond 4dp rounding is a cache miss (2 fetches)', async () => {
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    await getRoadRoute(WORKER, DEST);
    const movedWorker = { lat: WORKER.lat + 0.01, lng: WORKER.lng + 0.01 };
    await getRoadRoute(movedWorker, DEST);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches a null (failure) result briefly too — a failing OSRM is not hammered every call', async () => {
    fetchMock.mockResolvedValueOnce(status(500));
    const first = await getRoadRoute(WORKER, DEST);
    const second = await getRoadRoute(WORKER, DEST);
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('_clearRouteCache() forces a fresh fetch', async () => {
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    fetchMock.mockResolvedValueOnce(ok(validRouteBody()));
    await getRoadRoute(WORKER, DEST);
    _clearRouteCache();
    await getRoadRoute(WORKER, DEST);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
