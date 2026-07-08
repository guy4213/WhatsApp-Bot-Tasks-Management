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

  it('URL-encodes the query into the request URL — with country + addressdetails filters', async () => {
    fetchMock.mockResolvedValueOnce(ok([{ lat: '32', lon: '34' }]));
    await geocodeAddress('אלופי צה"ל 48, חולון');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\/search/);
    expect(url).toContain('format=json');
    expect(url).toContain('limit=1');
    // countrycodes=il — Israel-only search, biggest Hebrew hit-rate boost.
    expect(url).toContain('countrycodes=il');
    // We only need lat/lon — skip Nominatim's extra address breakdown.
    expect(url).toContain('addressdetails=0');
    expect(url).toContain(encodeURIComponent('אלופי צה"ל 48, חולון'));
  });
});

describe('geocodeAddress — empty (sticky, caller CAN cache)', () => {
  it('returns kind=empty on [] when the query has no quote to retry', async () => {
    fetchMock.mockResolvedValueOnce(ok([]));
    const res = await geocodeAddress('nowhere');
    expect(res).toEqual({ kind: 'empty' });
    // No alt-quote variant possible → only ONE fetch call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns kind=empty on a whitespace-only input WITHOUT calling the network', async () => {
    const res = await geocodeAddress('   \t\n  ');
    expect(res).toEqual({ kind: 'empty' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Gershayim variant fallback (the אלופי צה"ל / אלופי צה״ל mismatch) ──────

describe('geocodeAddress — alt-quote fallback', () => {
  it('empty on ASCII " query → retries with Hebrew gershayim ״ and returns the variant hit', async () => {
    fetchMock
      .mockResolvedValueOnce(ok([]))  // primary: "אלופי צה\"ל 48, חולון"
      .mockResolvedValueOnce(ok([{ lat: '32.01', lon: '34.77' }])); // variant: "אלופי צה״ל 48, חולון"

    const res = await geocodeAddress('אלופי צה"ל 48, חולון');
    expect(res).toEqual({ kind: 'hit', lat: 32.01, lng: 34.77 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [urlPrimary] = fetchMock.mock.calls[0];
    const [urlVariant] = fetchMock.mock.calls[1];
    expect(urlPrimary).toContain(encodeURIComponent('אלופי צה"ל 48, חולון'));
    expect(urlVariant).toContain(encodeURIComponent('אלופי צה״ל 48, חולון'));
  });

  it('empty on Hebrew ״ query → retries with ASCII " and returns the variant hit', async () => {
    fetchMock
      .mockResolvedValueOnce(ok([]))                                   // primary: gershayim
      .mockResolvedValueOnce(ok([{ lat: '32.01', lon: '34.77' }]));    // variant: ASCII quote

    const res = await geocodeAddress('אלופי צה״ל 48, חולון');
    expect(res).toEqual({ kind: 'hit', lat: 32.01, lng: 34.77 });
    const [urlVariant] = fetchMock.mock.calls[1];
    expect(urlVariant).toContain(encodeURIComponent('אלופי צה"ל 48, חולון'));
  });

  it('both variants empty → returns empty (caller CAN sticky-cache)', async () => {
    fetchMock
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([]));
    const res = await geocodeAddress('אלופי צה"ל 48, חולון');
    expect(res).toEqual({ kind: 'empty' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('variant is transient → returns transient (caller MUST NOT sticky-cache)', async () => {
    // Primary is empty, so we try the variant; variant hits a 5xx. If we
    // returned `empty` here we would sticky-cache no_hit despite not
    // knowing whether the variant would have hit had Nominatim been up.
    fetchMock
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(status(500));
    const res = await geocodeAddress('אלופי צה"ל 48, חולון');
    expect(res).toMatchObject({ kind: 'transient' });
  });

  it('primary transient → does NOT trigger a variant retry', async () => {
    // Network hiccup on primary — retrying with the variant would just waste
    // another Nominatim call. Return transient immediately; the caller will
    // retry on the next getPublicView tick.
    fetchMock.mockResolvedValueOnce(status(500));
    const res = await geocodeAddress('אלופי צה"ל 48, חולון');
    expect(res).toMatchObject({ kind: 'transient' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
