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

beforeEach(() => {
  poolQuery.mockReset();
  clientQuery.mockReset();
  clientRelease.mockReset();
  poolConnect.mockClear();
});
afterEach(() => {
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
    expect(view).toEqual({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      lastLocation: { lat: 32.0853, lng: 34.7818, at: '2026-07-08T09:00:00Z', accuracy: 15 },
      etaMinutes: 25,
      expectedArrivalAt: '2026-07-08T09:25:00Z',
    });
    // Explicit non-leaks — internal ids MUST NOT appear.
    const asString = JSON.stringify(view);
    expect(asString).not.toMatch(/taskFieldId/);
    expect(asString).not.toMatch(/workerUserId/);
    expect(asString).not.toMatch(/publicToken/);
  });

  it('lazy-expires an ACTIVE row whose expiresAt has passed, dropping the location', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{
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
