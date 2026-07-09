/**
 * Behavioral tests for `services/tracking.ts` — TrackingSession lifecycle and
 * the public/debug read views.
 *
 * The single-active-per-worker invariant is the most important behavior here:
 * `openTrackingSession` MUST close any prior worker session as SUPERSEDED in
 * the SAME transaction as the new INSERT. These tests would fail if:
 *  - the SUPERSEDE step was dropped or made non-atomic.
 *  - `closeSession` was no longer idempotent.
 *  - `getPublicView` leaked internal ids or returned a location for a
 *    terminal / expired session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock pool (both plain query() and transactional connect()) ──────────────

const poolQuery = vi.fn();
const clientQuery = vi.fn();
const clientRelease = vi.fn();
const poolConnect = vi.fn(async () => ({
  query: (...args: unknown[]) => clientQuery(...args),
  release: (...args: unknown[]) => clientRelease(...args),
}));

vi.mock('../db/connection', () => ({
  pool: {
    query:   (...args: unknown[]) => poolQuery(...args),
    // poolConnect is typed no-args (vi.fn(async () => ...)); forward nothing.
    connect: () => poolConnect(),
  },
}));

// Destination resolver is a separate service — mock so getPublicView tests
// don't accidentally reach the pool from siteGeocodeCache.
const resolveDestMock = vi.fn();
vi.mock('../services/siteGeocodeCache', () => ({
  resolveTaskFieldDestination: (...a: unknown[]) => resolveDestMock(...a),
}));

// Route provider is a separate service — mock so getPublicView tests never
// touch the network. Unit tests for `orsRoute.ts` / `osrmRoute.ts` /
// `routeProvider.ts` themselves live in their own files. We keep the shorthand
// name `getRoadRouteMock` for minimal-diff churn — every existing test that
// stubs it continues to work, the mock just returns the same shape wrapped in
// `provider: 'osrm'` for whatever `routeProvider.getRouteEstimate` sees.
const getRoadRouteMock = vi.fn();
vi.mock('../services/routeProvider', () => ({
  getRouteEstimate: async (...a: unknown[]) => {
    const r = await getRoadRouteMock(...a);
    return r ? { ...r, provider: 'osrm' as const } : null;
  },
}));
// Legacy OSRM mock — kept as a no-op so any test that still uses the old
// import path doesn't try to hit the real OSRM server. Not otherwise wired.
vi.mock('../services/osrmRoute', () => ({
  getRoadRoute: vi.fn().mockResolvedValue(null),
}));
// Conservative ETA layers keep in-memory state per session token. Clear
// between tests so a previously-cached calibration / progress sample doesn't
// leak into an assertion in the next test.
import { _clearCalibrationCache } from '../services/workerCalibration';
import { _clearSessionState } from '../services/progressDetector';

// Pin "now" so hourly-load-multiplier and freshness math don't drift. Wed
// 2026-07-08 11:00Z = 14:00 IL → hourlyLoadMultiplier = 1.25. Every test that
// uses `Date.now()` for building relative timestamps still works because
// `Date.now()` also observes this pinned time.
const PINNED_NOW = new Date('2026-07-08T11:00:00.000Z');

beforeEach(() => {
  poolQuery.mockReset();
  clientQuery.mockReset();
  clientRelease.mockReset();
  poolConnect.mockClear();
  resolveDestMock.mockReset();
  // Default: no destination unless a specific test opts in.
  resolveDestMock.mockResolvedValue(null);
  getRoadRouteMock.mockReset();
  // Default: no route unless a specific test opts in.
  getRoadRouteMock.mockResolvedValue(null);
  _clearCalibrationCache();
  _clearSessionState();
  delete process.env.TRACKING_OSRM_ENABLED;
  delete process.env.TRACKING_ROUTE_PROVIDER;
  delete process.env.TRACKING_STALE_SECONDS;
  delete process.env.TRACKING_NEARBY_METERS;
  vi.useFakeTimers({ now: PINNED_NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

import {
  openTrackingSession,
  markArrived,
  closeSession,
  bumpSessionLocation,
  getPublicView,
  listActiveSessions,
} from '../services/tracking';

// ── openTrackingSession ─────────────────────────────────────────────────────

describe('openTrackingSession', () => {
  it('supersedes any prior ACTIVE|ARRIVED session for the worker, then inserts, all in one transaction', async () => {
    clientQuery
      .mockResolvedValueOnce({ rowCount: 0 })                            // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'old-id' }] })  // UPDATE prior
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'new-id' }] })  // INSERT new
      .mockResolvedValueOnce({ rowCount: 0 });                           // COMMIT

    const result = await openTrackingSession({
      taskFieldId: 'tf-1',
      workerUserId: 'user-42',
    });

    expect(poolConnect).toHaveBeenCalledTimes(1);
    // Ordered: BEGIN → supersede update → insert → COMMIT.
    expect(clientQuery.mock.calls[0][0]).toBe('BEGIN');
    expect(clientQuery.mock.calls[1][0]).toMatch(/UPDATE "TrackingSession"/);
    expect(clientQuery.mock.calls[1][0]).toMatch(/status\s*=\s*'SUPERSEDED'/);
    expect(clientQuery.mock.calls[1][0]).toMatch(
      /status IN \('ACTIVE','ARRIVED'\)/,
    );
    expect(clientQuery.mock.calls[1][1]).toEqual(['user-42']);
    expect(clientQuery.mock.calls[2][0]).toMatch(/INSERT INTO "TrackingSession"/);
    // New session goes in as ACTIVE.
    expect(clientQuery.mock.calls[2][0]).toMatch(/'ACTIVE'/);
    expect(clientQuery.mock.calls[3][0]).toBe('COMMIT');

    // Report the count of superseded rows (surfaced in logs / debug output).
    expect(result.supersededCount).toBe(1);
    expect(result.sessionId).toBe('new-id');
    // Token is a base64url string.
    expect(result.publicToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // Client always released — no leaked connections.
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('reports supersededCount=0 when the worker had no prior active session', async () => {
    clientQuery
      .mockResolvedValueOnce({ rowCount: 0 })                            // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })                  // UPDATE (no rows)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'new-id' }] })  // INSERT
      .mockResolvedValueOnce({ rowCount: 0 });                           // COMMIT

    const result = await openTrackingSession({
      taskFieldId: 'tf-1',
      workerUserId: 'user-42',
    });
    expect(result.supersededCount).toBe(0);
  });

  it('rolls back and releases when the INSERT throws', async () => {
    clientQuery
      .mockResolvedValueOnce({ rowCount: 0 })                            // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })                  // UPDATE
      .mockRejectedValueOnce(new Error('unique index violation'))        // INSERT throws
      .mockResolvedValueOnce({ rowCount: 0 });                           // ROLLBACK

    await expect(
      openTrackingSession({ taskFieldId: 'tf-1', workerUserId: 'user-42' }),
    ).rejects.toThrow('unique index violation');

    // ROLLBACK must have been issued after the failing INSERT.
    const commands = clientQuery.mock.calls.map((c) => c[0]);
    expect(commands).toContain('ROLLBACK');
    expect(commands).not.toContain('COMMIT');
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });
});

// ── markArrived / closeSession / bumpSessionLocation ───────────────────────

describe('markArrived', () => {
  it('updates only ACTIVE rows (not ARRIVED, not terminal) for the given TaskField', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await markArrived('tf-1');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE "TrackingSession"/);
    expect(sql).toMatch(/status\s*=\s*'ARRIVED'/);
    expect(sql).toMatch(/"arrivedAt"\s*=\s*now\(\)/);
    expect(sql).toMatch(/status\s*=\s*'ACTIVE'/); // WHERE guard
    expect(params).toEqual(['tf-1']);
  });
});

describe('closeSession', () => {
  it('closes ACTIVE|ARRIVED with the requested reason', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await closeSession('tf-1', 'FINISHED');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE "TrackingSession"/);
    expect(sql).toMatch(/"endedAt"\s*=\s*now\(\)/);
    expect(sql).toMatch(/status IN \('ACTIVE','ARRIVED'\)/);
    expect(params).toEqual(['tf-1', 'FINISHED']);
  });

  it('is idempotent — second call touches zero rows and does not throw', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1 }); // first close
    poolQuery.mockResolvedValueOnce({ rowCount: 0 }); // second close, no rows
    await closeSession('tf-1', 'CANCELED');
    await expect(closeSession('tf-1', 'CANCELED')).resolves.toBeUndefined();
  });
});

describe('bumpSessionLocation', () => {
  it('only touches ACTIVE|ARRIVED rows for the worker', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0 });
    await bumpSessionLocation('user-42');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE "TrackingSession"/);
    expect(sql).toMatch(/"lastLocationAt"\s*=\s*now\(\)/);
    expect(sql).toMatch(/status IN \('ACTIVE','ARRIVED'\)/);
    expect(params).toEqual(['user-42']);
  });
});

// ── getPublicView ──────────────────────────────────────────────────────────

describe('getPublicView', () => {
  it('returns null for an unknown token — route MUST 404 without leaking existence', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const view = await getPublicView('bogus-token');
    expect(view).toBeNull();
  });

  it('returns location + eta for an ACTIVE session', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{
        taskFieldId: 'tf-1',
        status: 'ACTIVE',
        fieldStatus: 'EN_ROUTE',
        updatedAt: '2026-07-08T09:00:00Z',
        arrivedAt: null,
        endedAt: null,
        expiresAt: '2099-01-01T00:00:00Z',
        lastLocationAt: '2026-07-08T09:00:00Z',
        lat: 32.0853,
        lng: 34.7818,
        accuracy: 15,
        liveAt: '2026-07-08T09:00:00Z',
        travelEtaMinutes: 25,
        expectedArrivalAt: '2026-07-08T09:25:00Z',
      }],
    });
    const view = await getPublicView('token-x');
    // Regression: every pre-TRACK-A key is unchanged — use toMatchObject
    // (not toEqual) because the view is now additively extended with the
    // TRACK-A presentation fields (headline, presentationStatus, etc.).
    //
    // NOTE: `expectedArrivalAt` is now rolled forward on every poll (2026-07-09
    // change — see tracking.ts). The static DB value 09:25:00Z is no longer
    // exposed; instead, the view carries `PINNED_NOW + Conservative etaMinutes`.
    // PINNED_NOW = 2026-07-08T11:00:00Z, etaMinutes = 30 → 11:30:00.
    expect(view).toMatchObject({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      lastLocation: { lat: 32.0853, lng: 34.7818, at: '2026-07-08T09:00:00Z', accuracy: 15 },
      expectedArrivalAt: '2026-07-08T11:30:00.000Z',
    });
    // etaMinutes is now derived by Conservative ETA. Fixed 2026-07-08
    // timestamps mean the location is stale relative to real "now", so no
    // route call runs → no base seconds → expectedArrivalAt is in the past →
    // falls through to the worker_only branch (travelEtaMinutes=25). The
    // composer adds the 3-min last-mile buffer and rounds up to the next 5,
    // yielding 30 rather than the raw 25 the old passthrough exposed.
    expect(view?.etaMinutes).toBe(30);
    // New additive fields are present and well-typed.
    expect(typeof view?.headline).toBe('string');
    expect(typeof view?.isLocationFresh).toBe('boolean');
    expect(typeof view?.isRouteAvailable).toBe('boolean');
    // Explicit non-leaks — internal ids MUST NOT appear.
    const asString = JSON.stringify(view);
    expect(asString).not.toMatch(/taskFieldId/);
    expect(asString).not.toMatch(/workerUserId/);
    expect(asString).not.toMatch(/publicToken/);
  });

  it('lazy-expires an ACTIVE row whose expiresAt has passed, dropping the location', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{
        taskFieldId: 'tf-1',
        status: 'ACTIVE',
        fieldStatus: 'EN_ROUTE',
        updatedAt: '2026-07-08T08:00:00Z',
        arrivedAt: null,
        endedAt: null,
        expiresAt: '2000-01-01T00:00:00Z',       // in the past
        lastLocationAt: '2026-07-08T08:00:00Z',
        lat: 32,
        lng: 34,
        accuracy: 15,
        liveAt: '2026-07-08T08:00:00Z',
        travelEtaMinutes: 25,
        expectedArrivalAt: null,
      }],
    });
    const view = await getPublicView('token-x');
    expect(view?.status).toBe('EXPIRED');
    // No lastLocation exposed once expired — customer page should render "old".
    expect(view?.lastLocation).toBeUndefined();
    expect(view?.etaMinutes).toBeUndefined();
  });

  it('drops the location for terminal statuses (FINISHED)', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{
        taskFieldId: 'tf-1',
        status: 'FINISHED',
        fieldStatus: 'FINISHED_FIELD',
        updatedAt: '2026-07-08T09:30:00Z',
        arrivedAt: '2026-07-08T09:00:00Z',
        endedAt: '2026-07-08T09:30:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
        lastLocationAt: '2026-07-08T09:00:00Z',
        lat: 32, lng: 34, accuracy: 15,
        liveAt: '2026-07-08T09:00:00Z',
        travelEtaMinutes: 25,
        expectedArrivalAt: null,
      }],
    });
    const view = await getPublicView('token-x');
    expect(view?.status).toBe('FINISHED');
    expect(view?.lastLocation).toBeUndefined();
  });
});

// ── getPublicView + destination (migration 017) ────────────────────────────

describe('getPublicView — destination', () => {
  function activeRow() {
    return {
      taskFieldId: 'tf-42',
      status: 'ACTIVE',
      fieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      arrivedAt: null,
      endedAt: null,
      expiresAt: '2099-01-01T00:00:00Z',
      lastLocationAt: '2026-07-08T09:00:00Z',
      lat: 32.0853, lng: 34.7818, accuracy: 15,
      liveAt: '2026-07-08T09:00:00Z',
      travelEtaMinutes: 25,
      expectedArrivalAt: '2026-07-08T09:25:00Z',
    };
  }

  it('attaches destination when the resolver returns one for an ACTIVE session', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [activeRow()] });
    resolveDestMock.mockResolvedValueOnce({
      lat: 32.0110, lng: 34.7712, address: 'אלופי צה"ל 48, חולון',
    });
    const view = await getPublicView('token-x');
    expect(view?.destination).toEqual({
      lat: 32.0110, lng: 34.7712, address: 'אלופי צה"ל 48, חולון',
    });
    // Resolver was called with the taskFieldId from the JOIN.
    expect(resolveDestMock).toHaveBeenCalledWith('tf-42');
  });

  it('omits destination when the resolver returns null (transient / missing address)', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [activeRow()] });
    resolveDestMock.mockResolvedValueOnce(null);
    const view = await getPublicView('token-x');
    expect(view?.destination).toBeUndefined();
  });

  it('does NOT call the resolver — nor include destination — for terminal statuses', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{ ...activeRow(), status: 'FINISHED', arrivedAt: '2026-07-08T09:20:00Z', endedAt: '2026-07-08T09:30:00Z' }],
    });
    const view = await getPublicView('token-x');
    expect(view?.status).toBe('FINISHED');
    expect(view?.destination).toBeUndefined();
    expect(resolveDestMock).not.toHaveBeenCalled();
  });

  it('does NOT include destination when the session lazy-expires on read', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{ ...activeRow(), expiresAt: '2000-01-01T00:00:00Z' }],
    });
    // Resolver would be called with an expired effective status because
    // showLocation is gated on the effective status; verify it isn't.
    const view = await getPublicView('token-x');
    expect(view?.status).toBe('EXPIRED');
    expect(view?.destination).toBeUndefined();
    expect(resolveDestMock).not.toHaveBeenCalled();
  });
});

// ── getPublicView — TRACK-A enrichment (ETA / freshness / presentation) ────
//
// Uses relative timestamps (Date.now() +/- offsets) rather than fixed 2026
// dates, since freshness/staleness is computed against wall-clock "now" at
// call time.

function buildActiveRow(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    taskFieldId: 'tf-9',
    status: 'ACTIVE',
    fieldStatus: 'EN_ROUTE',
    updatedAt: new Date(now - 30_000).toISOString(),
    arrivedAt: null,
    endedAt: null,
    expiresAt: new Date(now + 3_600_000).toISOString(),
    lastLocationAt: new Date(now - 5_000).toISOString(),
    lat: 32.0,
    lng: 34.0,
    accuracy: 10,
    liveAt: new Date(now - 5_000).toISOString(), // fresh by default
    travelEtaMinutes: null,
    expectedArrivalAt: null,
    ...overrides,
  };
}

const FAR_DEST = { lat: 32.05, lng: 34.05, address: 'רחוב רחוק 1, עיר' }; // ~6.6km away
const NEAR_DEST = { lat: 32.001, lng: 34.0, address: 'רחוב קרוב 1, עיר' }; // ~111m away

describe('getPublicView — TRACK-A road-route + ETA + presentation', () => {
  it('fresh location + OSRM success → OSRM route, eta from duration, EN_ROUTE', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [buildActiveRow()] });
    resolveDestMock.mockResolvedValueOnce(FAR_DEST);
    getRoadRouteMock.mockResolvedValueOnce({
      geometry: { type: 'LineString', coordinates: [[34, 32], [34.05, 32.05]] },
      distanceMeters: 6000,
      durationSeconds: 600,
    });

    const view = await getPublicView('token-x');

    expect(getRoadRouteMock).toHaveBeenCalledWith({ lat: 32.0, lng: 34.0 }, { lat: 32.05, lng: 34.05 });
    expect(view?.presentationStatus).toBe('EN_ROUTE');
    expect(view?.headline).toBe('הבודק בדרך אליך');
    expect(view?.route).toEqual({
      type: 'OSRM',
      // `provider` is the observational tag added on 2026-07-09 so operators
      // can tell which provider actually served the route (independent of
      // the `type` label, which is a template rendering flag). The mock
      // in this file forwards through `routeProvider` stamping 'osrm'.
      provider: 'osrm',
      geometry: { type: 'LineString', coordinates: [[34, 32], [34.05, 32.05]] },
      distanceMeters: 6000,
      durationSeconds: 600,
    });
    expect(view?.distanceMeters).toBe(6000);
    // Route metadata still carries the raw provider duration.
    expect(view?.route?.durationSeconds).toBe(600);
    expect(view?.isRouteAvailable).toBe(true);
    // Conservative ETA at PINNED_NOW (Wed 14:00 IL, hourly=1.25): no
    // calibration nor countdown source in this fixture → hourly wins.
    // 600s × 1.25 + 180s buffer = 930s = 15.5 min → round up 20.
    expect(view?.etaMinutes).toBe(20);
    expect(view?.etaText).toBe('זמן הגעה משוער: 20 דקות');
    // Top-level `durationSeconds` is deliberately cleared so the tracking
    // page's client-side mm:ss countdown ticker doesn't render. See
    // tracking.ts — the ETA must update ONLY on poll (via etaMinutes),
    // not tick down independently of GPS. Route metadata is preserved.
    expect(view?.durationSeconds).toBeUndefined();
    expect(view?.fallbackReason).toBeUndefined();
    expect(view?.isLocationFresh).toBe(true);
  });

  it('fresh location + OSRM failure → STRAIGHT_LINE, eta falls back to worker_only via travelEtaMinutes', async () => {
    // Countdown removed 2026-07-09: expectedArrivalAt is never used as an
    // ETA source. Instead, the presence of `travelEtaMinutes` triggers the
    // constant worker_only fallback.
    process.env.TRACKING_OSRM_ENABLED = 'true'; // enabled but the call itself fails
    const future = new Date(Date.now() + 15 * 60_000).toISOString();
    poolQuery.mockResolvedValueOnce({
      rows: [buildActiveRow({ expectedArrivalAt: future, travelEtaMinutes: 20 })],
    });
    resolveDestMock.mockResolvedValueOnce(FAR_DEST);
    getRoadRouteMock.mockResolvedValueOnce(null); // OSRM failed

    const view = await getPublicView('token-x');

    expect(view?.route?.type).toBe('STRAIGHT_LINE');
    expect(view?.route?.durationSeconds).toBeUndefined();
    expect(view?.route?.distanceMeters).toBeGreaterThan(0);
    expect(view?.distanceMeters).toBeGreaterThan(0);
    expect(view?.isRouteAvailable).toBe(false);
    expect(view?.fallbackReason).toBe('OSRM_FAILED');
    // 20 min × 60 + 180s buffer = 1380s = 23 → round up 25.
    expect(view?.etaMinutes).toBe(25);
    expect(view?.etaText).toBe('זמן הגעה משוער: 25 דקות');
  });

  it('OSRM disabled (default) + fresh + no expectedArrivalAt → STRAIGHT_LINE, fallbackReason OSRM_DISABLED, eta from travelEtaMinutes', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [buildActiveRow({ travelEtaMinutes: 18 })] });
    resolveDestMock.mockResolvedValueOnce(FAR_DEST);
    // getRoadRouteMock default resolves null (unmocked call would be a bug — OSRM disabled means tracking.ts still calls it since gating is inside osrmRoute, but here we just confirm the fallback wiring).

    const view = await getPublicView('token-x');

    expect(view?.route?.type).toBe('STRAIGHT_LINE');
    expect(view?.fallbackReason).toBe('OSRM_DISABLED');
    // No base route (straight-line only), no expectedArrivalAt → worker_only
    // priority: 18 min × 60 + 180s buffer = 1260s = 21 → round up 25.
    // The "(לפי דיווח הבודק)" annotation no longer appears — Conservative
    // ETA uses the unified "זמן הגעה משוער" phrasing everywhere.
    expect(view?.etaMinutes).toBe(25);
    expect(view?.etaText).toBe('זמן הגעה משוער: 25 דקות');
  });

  it('stale location → STALE_LOCATION, OSRM is never called, etaText is marked as an estimate', async () => {
    const staleLiveAt = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min old
    poolQuery.mockResolvedValueOnce({
      rows: [buildActiveRow({ liveAt: staleLiveAt, lastLocationAt: staleLiveAt, travelEtaMinutes: 12 })],
    });
    resolveDestMock.mockResolvedValueOnce(FAR_DEST);

    const view = await getPublicView('token-x');

    expect(view?.presentationStatus).toBe('STALE_LOCATION');
    expect(view?.headline).toBe('הבודק בדרך אליך');
    expect(view?.isLocationFresh).toBe(false);
    expect(getRoadRouteMock).not.toHaveBeenCalled();
    expect(view?.route?.type).toBe('STRAIGHT_LINE');
    expect(view?.fallbackReason).toBe('STALE_LOCATION');
    // No base (stale → route skipped), no expectedArrivalAt → worker_only
    // priority: 12 min × 60 + 180s buffer = 900s = 15 → round up 15.
    // Stale location appends "(הערכה בלבד)".
    expect(view?.etaMinutes).toBe(15);
    expect(view?.etaText).toBe('זמן הגעה משוער: 15 דקות (הערכה בלבד)');
  });

  it('no worker location yet → WAITING, no route, fallbackReason NO_LOCATION', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [buildActiveRow({ lat: null, lng: null, liveAt: null, lastLocationAt: null })],
    });
    resolveDestMock.mockResolvedValueOnce(FAR_DEST);

    const view = await getPublicView('token-x');

    expect(view?.presentationStatus).toBe('WAITING');
    expect(view?.headline).toBe('הבודק יצא לדרך. מיקום חי יופיע בעוד רגע.');
    expect(view?.workerLocation).toBeUndefined();
    expect(view?.lastLocation).toBeUndefined();
    expect(view?.route).toBeUndefined();
    expect(view?.fallbackReason).toBe('NO_LOCATION');
    expect(view?.isLocationFresh).toBe(false);
    expect(getRoadRouteMock).not.toHaveBeenCalled();
  });

  it('fresh location within TRACKING_NEARBY_METERS of destination → NEARBY', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [buildActiveRow()] });
    resolveDestMock.mockResolvedValueOnce(NEAR_DEST); // ~111m away
    getRoadRouteMock.mockResolvedValueOnce(null); // OSRM disabled/failed — haversine still used for NEARBY

    const view = await getPublicView('token-x');

    expect(view?.distanceMeters).toBeLessThanOrEqual(300);
    expect(view?.presentationStatus).toBe('NEARBY');
    expect(view?.headline).toBe('הבודק קרוב אליך');
  });

  it('missing destination → no route at all, fallbackReason NO_DESTINATION, page-safe (worker location still present)', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [buildActiveRow()] });
    resolveDestMock.mockResolvedValueOnce(null); // resolver couldn't geocode

    const view = await getPublicView('token-x');

    expect(view?.destination).toBeUndefined();
    expect(view?.destinationLocation).toBeUndefined();
    expect(view?.route).toBeUndefined();
    expect(view?.fallbackReason).toBe('NO_DESTINATION');
    expect(view?.isRouteAvailable).toBe(false);
    // Page-safe: worker location is still exposed even without a destination.
    expect(view?.workerLocation).toBeDefined();
    expect(getRoadRouteMock).not.toHaveBeenCalled();
  });

  it('FINISHED → COMPLETED, and NO workerLocation/lastLocation keys even if the worker still has a live ping', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [buildActiveRow({ status: 'FINISHED', endedAt: new Date().toISOString() })],
    });

    const view = await getPublicView('token-x');

    expect(view?.status).toBe('FINISHED');
    expect(view?.presentationStatus).toBe('COMPLETED');
    expect(view?.headline).toBe('הבדיקה הסתיימה. תודה.');
    expect(view?.workerLocation).toBeUndefined();
    expect(view?.lastLocation).toBeUndefined();
    expect(view?.route).toBeUndefined();
    expect(view?.etaMinutes).toBeUndefined();
    expect(resolveDestMock).not.toHaveBeenCalled();
    expect(getRoadRouteMock).not.toHaveBeenCalled();
  });

  it('CANCELED / SUPERSEDED → UNAVAILABLE', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [buildActiveRow({ status: 'CANCELED' })] });
    const view = await getPublicView('token-x');
    expect(view?.presentationStatus).toBe('UNAVAILABLE');
    expect(view?.headline).toBe('המעקב לא זמין כרגע, אך הבודק בדרך.');
  });

  it('ARRIVED → ARRIVED, still exposes worker location, no route/eta computed', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [buildActiveRow({ status: 'ARRIVED', arrivedAt: new Date().toISOString() })],
    });
    resolveDestMock.mockResolvedValueOnce(FAR_DEST);

    const view = await getPublicView('token-x');

    expect(view?.presentationStatus).toBe('ARRIVED');
    expect(view?.headline).toBe('הבודק הגיע לאתר.');
    expect(view?.workerLocation).toBeDefined();
    expect(view?.route).toBeUndefined();
    expect(view?.etaMinutes).toBeUndefined();
    expect(getRoadRouteMock).not.toHaveBeenCalled();
  });

  it('lazy EXPIRED → EXPIRED, no location, no route/eta', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [buildActiveRow({ expiresAt: new Date(Date.now() - 1000).toISOString() })],
    });

    const view = await getPublicView('token-x');

    expect(view?.status).toBe('EXPIRED');
    expect(view?.presentationStatus).toBe('EXPIRED');
    expect(view?.headline).toBe('המעקב אינו פעיל');
    expect(view?.workerLocation).toBeUndefined();
    expect(view?.route).toBeUndefined();
    expect(resolveDestMock).not.toHaveBeenCalled();
    expect(getRoadRouteMock).not.toHaveBeenCalled();
  });

  describe('ETA priority order', () => {
    it('priority 1: worker calibration ratio × current base wins over countdown and worker_only', async () => {
      // Calibration: worker says 10 min via Waze; base at departure = 5 min → ratio = 2.0.
      // At current poll base is still 5 min → calibrated = 10 min + 3 buffer = 13 → round up 15.
      const future = new Date(Date.now() + 20 * 60_000).toISOString();
      const departedAt = new Date(Date.now() - 60_000).toISOString();
      poolQuery.mockResolvedValueOnce({
        rows: [buildActiveRow({
          expectedArrivalAt: future,
          travelEtaMinutes: 10,
          departedAt,
        })],
      });
      resolveDestMock.mockResolvedValueOnce(FAR_DEST);
      getRoadRouteMock.mockResolvedValueOnce({
        geometry: { type: 'LineString', coordinates: [] },
        distanceMeters: 6000,
        durationSeconds: 300, // 5 min base
      });
      const view = await getPublicView('token-x');
      expect(view?.etaMinutes).toBe(15);
      expect(view?.etaText).toBe('זמן הגעה משוער: 15 דקות');
    });

    it('priority 2: no calibration + no route → worker_only wins on travelEtaMinutes (expectedArrivalAt IGNORED)', async () => {
      // Countdown was removed on 2026-07-09 — expectedArrivalAt is no
      // longer a valid ETA source, regardless of how far in the future it
      // lies. Without a base route, we fall straight to worker_only.
      const future = new Date(Date.now() + 20 * 60_000).toISOString();
      poolQuery.mockResolvedValueOnce({
        rows: [buildActiveRow({ expectedArrivalAt: future, travelEtaMinutes: 99 })],
      });
      resolveDestMock.mockResolvedValueOnce(FAR_DEST);
      getRoadRouteMock.mockResolvedValueOnce(null);
      const view = await getPublicView('token-x');
      // worker_only: 99 min × 60 + 180s buffer = 6120s = 102 → round up 105.
      expect(view?.etaMinutes).toBe(105);
      expect(view?.etaText).toBe('זמן הגעה משוער: 105 דקות');
    });

    it('priority 4: no calibration, no OSRM route, past expectedArrivalAt → worker_only wins on travelEtaMinutes', async () => {
      const past = new Date(Date.now() - 60_000).toISOString(); // already in the past — not a valid countdown source
      poolQuery.mockResolvedValueOnce({
        rows: [buildActiveRow({ expectedArrivalAt: past, travelEtaMinutes: 7 })],
      });
      resolveDestMock.mockResolvedValueOnce(FAR_DEST);
      getRoadRouteMock.mockResolvedValueOnce(null);
      const view = await getPublicView('token-x');
      // 7 min × 60 + 180s buffer = 600s = 10 → round up 10 (already at a
      // 5-min boundary). Text is the unified phrasing — "לפי דיווח הבודק"
      // annotation was retired with the old priority chain.
      expect(view?.etaMinutes).toBe(10);
      expect(view?.etaText).toBe('זמן הגעה משוער: 10 דקות');
    });

    it('priority 4: none of the three sources available → no etaMinutes/etaText, fallbackReason NO_ETA_SOURCE', async () => {
      poolQuery.mockResolvedValueOnce({
        rows: [buildActiveRow({ expectedArrivalAt: null, travelEtaMinutes: null })],
      });
      resolveDestMock.mockResolvedValueOnce(FAR_DEST);
      getRoadRouteMock.mockResolvedValueOnce(null);
      const view = await getPublicView('token-x');
      expect(view?.etaMinutes).toBeUndefined();
      expect(view?.etaText).toBeUndefined();
      // OSRM_DISABLED already claimed fallbackReason (route-level failure) —
      // NO_ETA_SOURCE only applies when nothing else claimed it first.
      expect(view?.fallbackReason).toBe('OSRM_DISABLED');
    });
  });
});

// ── listActiveSessions (debug) ─────────────────────────────────────────────

describe('listActiveSessions', () => {
  it('returns only ACTIVE|ARRIVED sessions, newest first', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await listActiveSessions();
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE status IN \('ACTIVE','ARRIVED'\)/);
    expect(sql).toMatch(/ORDER BY "startedAt" DESC/);
  });
});
