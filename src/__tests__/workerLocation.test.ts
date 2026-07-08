/**
 * Behavioral tests for `services/workerLocation.ts` — the OwnTracks identity
 * lookup + live-location upsert used by the OwnTracks ingestion route.
 *
 * These tests would fail if:
 *  - `resolveWorkerFromKey` ever returned an inactive mapping.
 *  - `upsertLiveLocation` was rewritten as a plain INSERT (would violate the
 *    single-row-per-worker invariant on the second ping).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

beforeEach(() => {
  poolQuery.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

import { resolveWorkerFromKey, upsertLiveLocation } from '../services/workerLocation';

describe('resolveWorkerFromKey', () => {
  it('returns the workerUserId for an active mapping', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ workerUserId: 'user-42' }] });
    const id = await resolveWorkerFromKey('danny');
    expect(id).toBe('user-42');
    const [sql, params] = poolQuery.mock.calls[0];
    // Must filter by isActive=true — an inactive/retired device MUST NOT resolve.
    expect(sql).toMatch(/"isActive"\s*=\s*true/);
    expect(sql).toMatch(/"workerKey"\s*=\s*\$1/);
    expect(params).toEqual(['danny']);
  });

  it('returns null when no active mapping exists', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const id = await resolveWorkerFromKey('unknown');
    expect(id).toBeNull();
  });
});

describe('upsertLiveLocation', () => {
  it('emits an INSERT ... ON CONFLICT ("workerUserId") DO UPDATE with all fields', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const recordedAt = new Date('2026-07-08T09:00:00Z');
    await upsertLiveLocation({
      workerUserId: 'user-42',
      workerKey: 'danny',
      deviceId: 'iphone-13',
      lat: 32.0853,
      lng: 34.7818,
      accuracy: 12,
      speed: 8.4,
      battery: 0.71,
      trigger: 'u',
      recordedAt,
      raw: { _type: 'location' },
    });
    const [sql, params] = poolQuery.mock.calls[0];
    // Upsert (not plain insert) — critical: overwrites the previous fix.
    expect(sql).toMatch(/INSERT INTO "WorkerLiveLocation"/);
    expect(sql).toMatch(/ON CONFLICT \("workerUserId"\) DO UPDATE/);
    // Server-time stamped, not client-time — protects from clock skew.
    expect(sql).toMatch(/"lastSeenAt"\s*=\s*now\(\)/);
    // Params in the same order as the columns list.
    expect(params[0]).toBe('user-42');
    expect(params[1]).toBe('danny');
    expect(params[2]).toBe('iphone-13');
    expect(params[3]).toBe(32.0853);
    expect(params[4]).toBe(34.7818);
    expect(params[9]).toBe(recordedAt);
    // raw serialized as JSON string, not passed as an object.
    expect(params[10]).toBe(JSON.stringify({ _type: 'location' }));
  });

  it('nulls out optional fields when omitted', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await upsertLiveLocation({
      workerUserId: 'user-42',
      workerKey: 'danny',
      lat: 32,
      lng: 34,
    });
    const [, params] = poolQuery.mock.calls[0];
    expect(params[2]).toBeNull(); // deviceId
    expect(params[5]).toBeNull(); // accuracy
    expect(params[6]).toBeNull(); // speed
    expect(params[7]).toBeNull(); // battery
    expect(params[8]).toBeNull(); // trigger
    expect(params[9]).toBeNull(); // recordedAt
    expect(params[10]).toBeNull(); // raw
  });
});
