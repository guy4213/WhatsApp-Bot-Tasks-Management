/**
 * Behavioral tests for `services/siteGeocodeCache.ts`.
 *
 * The critical behaviors here:
 *   - Cache HIT MUST NOT call the geocoder.
 *   - Nominatim `empty` MUST be persisted as sticky `nominatim:no_hit` and
 *     subsequent calls for the same query MUST NOT re-call the geocoder.
 *   - Nominatim `transient` (network / 5xx / timeout) MUST NOT be persisted
 *     at all — a retry on the next call must actually call the geocoder.
 *   - Address change (normalized query differs) MUST re-geocode even if a
 *     sticky no-hit was previously cached.
 *   - Missing address parts return null without calling the geocoder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery  = vi.fn();
const geocodeMock = vi.fn();

vi.mock('../db/connection', () => ({
  pool: { query: (...a: unknown[]) => poolQuery(...a) },
}));
vi.mock('../services/geocoder', () => ({
  geocodeAddress: (...a: unknown[]) => geocodeMock(...a),
}));

import { resolveTaskFieldDestination } from '../services/siteGeocodeCache';

beforeEach(() => {
  poolQuery.mockReset();
  geocodeMock.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

const TF = 'tf-1';

function selectReturns(row: Record<string, unknown> | undefined) {
  // The FIRST pool.query is always the SELECT — return the row shape here.
  poolQuery.mockResolvedValueOnce({ rows: row ? [row] : [] });
}

describe('resolveTaskFieldDestination — no-op cases', () => {
  it('returns null and does NOT call the geocoder when siteAddress is null', async () => {
    selectReturns({
      siteAddress: null, siteCity: 'חולון',
      siteLat: null, siteLng: null,
      siteGeocodeSource: null, siteGeocodeQuery: null,
    });
    const res = await resolveTaskFieldDestination(TF);
    expect(res).toBeNull();
    expect(geocodeMock).not.toHaveBeenCalled();
    // Only the SELECT — no UPDATE.
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('returns null and does NOT call the geocoder when siteCity is null', async () => {
    selectReturns({
      siteAddress: 'X', siteCity: null,
      siteLat: null, siteLng: null,
      siteGeocodeSource: null, siteGeocodeQuery: null,
    });
    const res = await resolveTaskFieldDestination(TF);
    expect(res).toBeNull();
    expect(geocodeMock).not.toHaveBeenCalled();
  });

  it('returns null when the TaskField is not found', async () => {
    selectReturns(undefined);
    const res = await resolveTaskFieldDestination(TF);
    expect(res).toBeNull();
    expect(geocodeMock).not.toHaveBeenCalled();
  });
});

describe('resolveTaskFieldDestination — cache hit', () => {
  it('returns cached coords without calling the geocoder', async () => {
    selectReturns({
      siteAddress: 'אלופי צה"ל 48', siteCity: 'חולון',
      siteLat: 32.01, siteLng: 34.77,
      siteGeocodeSource: 'nominatim',
      siteGeocodeQuery: 'אלופי צה"ל 48, חולון'.toLowerCase(),
    });
    const res = await resolveTaskFieldDestination(TF);
    expect(res).toEqual({
      lat: 32.01, lng: 34.77,
      address: 'אלופי צה"ל 48, חולון',
    });
    expect(geocodeMock).not.toHaveBeenCalled();
  });

  it('normalized query lets whitespace/case tweaks still hit the cache', async () => {
    selectReturns({
      siteAddress: '  אלופי צה"ל   48  ', siteCity: 'חולון',
      siteLat: 32.01, siteLng: 34.77,
      siteGeocodeSource: 'nominatim',
      // Cache row uses the normalized form.
      siteGeocodeQuery: 'אלופי צה"ל 48, חולון'.toLowerCase(),
    });
    const res = await resolveTaskFieldDestination(TF);
    expect(res).not.toBeNull();
    expect(geocodeMock).not.toHaveBeenCalled();
  });
});

describe('resolveTaskFieldDestination — sticky no_hit', () => {
  it('does NOT re-geocode when the same address previously resolved to empty', async () => {
    selectReturns({
      siteAddress: 'nowhere st', siteCity: 'nowhere',
      siteLat: null, siteLng: null,
      siteGeocodeSource: 'nominatim:no_hit',
      siteGeocodeQuery: 'nowhere st, nowhere',
    });
    const res = await resolveTaskFieldDestination(TF);
    expect(res).toBeNull();
    expect(geocodeMock).not.toHaveBeenCalled();
  });

  it('DOES re-geocode when the address changed even if a prior no_hit existed', async () => {
    selectReturns({
      siteAddress: 'new address', siteCity: 'חולון',
      siteLat: null, siteLng: null,
      siteGeocodeSource: 'nominatim:no_hit',
      siteGeocodeQuery: 'old address, חולון',
    });
    geocodeMock.mockResolvedValueOnce({ kind: 'hit', lat: 32, lng: 34 });
    poolQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE

    const res = await resolveTaskFieldDestination(TF);
    expect(geocodeMock).toHaveBeenCalledOnce();
    expect(res).toEqual({ lat: 32, lng: 34, address: 'new address, חולון' });

    // The UPDATE overwrote the sticky marker with a real hit.
    const [sql, params] = poolQuery.mock.calls[1];
    expect(sql).toMatch(/UPDATE "TaskField"/);
    expect(sql).toMatch(/siteGeocodeSource"\s*=\s*'nominatim'/);
    expect(params).toEqual([TF, 32, 34, 'new address, חולון']);
  });
});

describe('resolveTaskFieldDestination — geocode + persist', () => {
  it('on hit: writes coords + source=nominatim + normalized query', async () => {
    selectReturns({
      siteAddress: 'אלופי צה"ל 48', siteCity: 'חולון',
      siteLat: null, siteLng: null,
      siteGeocodeSource: null, siteGeocodeQuery: null,
    });
    geocodeMock.mockResolvedValueOnce({ kind: 'hit', lat: 32.01, lng: 34.77 });
    poolQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await resolveTaskFieldDestination(TF);
    expect(res).toEqual({ lat: 32.01, lng: 34.77, address: 'אלופי צה"ל 48, חולון' });
    const [sql, params] = poolQuery.mock.calls[1];
    expect(sql).toMatch(/"siteLat"\s*=\s*\$2/);
    expect(sql).toMatch(/"siteGeocodedAt"\s*=\s*now\(\)/);
    expect(sql).toMatch(/"siteGeocodeSource"\s*=\s*'nominatim'/);
    expect(params[3]).toBe('אלופי צה"ל 48, חולון'.toLowerCase());
  });

  it('on empty: persists sticky no_hit with siteLat=NULL', async () => {
    selectReturns({
      siteAddress: 'unresolvable', siteCity: 'city',
      siteLat: null, siteLng: null,
      siteGeocodeSource: null, siteGeocodeQuery: null,
    });
    geocodeMock.mockResolvedValueOnce({ kind: 'empty' });
    poolQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await resolveTaskFieldDestination(TF);
    expect(res).toBeNull();
    const [sql, params] = poolQuery.mock.calls[1];
    expect(sql).toMatch(/"siteLat"\s*=\s*NULL/);
    expect(sql).toMatch(/"siteGeocodeSource"\s*=\s*'nominatim:no_hit'/);
    expect(params[1]).toBe('unresolvable, city');
  });

  it('on transient: DOES NOT write to the DB and returns null (retry on next call)', async () => {
    selectReturns({
      siteAddress: 'X', siteCity: 'Y',
      siteLat: null, siteLng: null,
      siteGeocodeSource: null, siteGeocodeQuery: null,
    });
    geocodeMock.mockResolvedValueOnce({ kind: 'transient', reason: 'timeout' });

    const res = await resolveTaskFieldDestination(TF);
    expect(res).toBeNull();
    // Only the SELECT — critically NO UPDATE. Otherwise a network blip would
    // permanently poison the row until the address changed.
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });
});
