/**
 * Behavioral tests for `services/geocoder.ts`.
 *
 * The discriminated `hit` / `empty` / `transient` return type is the whole
 * point of this file — the caller must be able to sticky-cache `empty`
 * without also sticky-caching a network blip. These tests protect that
 * distinction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Import AFTER stubbing global fetch so the module sees the mock.
import { geocodeAddress, __resetGeocoderStateForTests } from '../services/geocoder';

beforeEach(() => {
  fetchMock.mockReset();
  __resetGeocoderStateForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
});

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
    json: () => Promise.resolve([]),
  } as unknown as Response;
}

describe('geocodeAddress — hit', () => {
  it('returns lat/lng for the first result', async () => {
    fetchMock.mockResolvedValueOnce(ok([
      { lat: '32.0853', lon: '34.7818', display_name: 'Tel Aviv' },
    ]));
    const res = await geocodeAddress('אלופי צה"ל 48, חולון');
    expect(res).toEqual({ kind: 'hit', lat: 32.0853, lng: 34.7818 });
  });

  it('sends the required User-Agent and Hebrew Accept-Language', async () => {
    fetchMock.mockResolvedValueOnce(ok([{ lat: '32', lon: '34' }]));
    await geocodeAddress('X');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['User-Agent']).toBe('GalitTrackingBot/1.0');
    expect(init.headers['Accept-Language']).toContain('he');
  });

  it('URL-encodes the query into the request URL', async () => {
    fetchMock.mockResolvedValueOnce(ok([{ lat: '32', lon: '34' }]));
    await geocodeAddress('אלופי צה"ל 48, חולון');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\/search/);
    expect(url).toContain('format=json');
    expect(url).toContain('limit=1');
    expect(url).toContain(encodeURIComponent('אלופי צה"ל 48, חולון'));
  });
});

describe('geocodeAddress — empty (sticky, caller CAN cache)', () => {
  it('returns kind=empty on []', async () => {
    fetchMock.mockResolvedValueOnce(ok([]));
    const res = await geocodeAddress('nowhere');
    expect(res).toEqual({ kind: 'empty' });
  });

  it('returns kind=empty on a whitespace-only input WITHOUT calling the network', async () => {
    const res = await geocodeAddress('   \t\n  ');
    expect(res).toEqual({ kind: 'empty' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('geocodeAddress — transient (caller MUST NOT sticky-cache)', () => {
  it('returns kind=transient on HTTP 500', async () => {
    fetchMock.mockResolvedValueOnce(status(500));
    const res = await geocodeAddress('X');
    expect(res).toMatchObject({ kind: 'transient', reason: 'http_500' });
  });

  it('returns kind=transient on HTTP 429 (rate limited — do NOT cache as no_hit)', async () => {
    fetchMock.mockResolvedValueOnce(status(429));
    const res = await geocodeAddress('X');
    expect(res).toMatchObject({ kind: 'transient' });
  });

  it('returns kind=transient on network throw', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const res = await geocodeAddress('X');
    expect(res).toMatchObject({ kind: 'transient', reason: 'network' });
  });

  it('returns kind=transient on AbortError (timeout)', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(err);
    const res = await geocodeAddress('X');
    expect(res).toMatchObject({ kind: 'transient', reason: 'timeout' });
  });

  it('returns kind=transient on malformed JSON hit (missing lat/lon)', async () => {
    fetchMock.mockResolvedValueOnce(ok([{ display_name: 'no coords' }]));
    const res = await geocodeAddress('X');
    expect(res).toMatchObject({ kind: 'transient', reason: 'malformed_hit' });
  });

  it('returns kind=transient on invalid JSON body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('bad json')),
    } as unknown as Response);
    const res = await geocodeAddress('X');
    expect(res).toMatchObject({ kind: 'transient', reason: 'parse_error' });
  });
});
