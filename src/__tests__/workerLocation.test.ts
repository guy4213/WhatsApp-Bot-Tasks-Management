/**
 * Behavioral tests for `services/workerLocation.ts` — the OwnTracks identity
 * lookup + live-location upsert used by the OwnTracks ingestion route.
 *
 * These tests would fail if:
 *  - `resolveWorkerFromKey` ever returned an inactive mapping.
 *  - `upsertLiveLocation` was rewritten as a plain INSERT (would violate the
 *    single-row-per-worker invariant on the second ping).
 *  - `verifyWorkerCredentials` cached DB misses or skipped bcrypt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn() },
}));

beforeEach(() => {
  poolQuery.mockReset();
  // Also reset the bcryptjs mock between tests so call-count assertions
  // in the verifyWorkerCredentials suite are not affected by earlier tests.
  (bcrypt.compare as ReturnType<typeof vi.fn>).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

import bcrypt from 'bcryptjs';
import {
  invalidateWorkerCredentialCache,
  resolveWorkerFromKey,
  upsertLiveLocation,
  verifyWorkerCredentials,
} from '../services/workerLocation';

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

describe('verifyWorkerCredentials', () => {
  const bcryptCompare = bcrypt.compare as ReturnType<typeof vi.fn>;

  // Helper: seed a valid DB row response.
  function mockDbRow(workerUserId = 'user-42', passwordHash = '$2b$10$hashedpwd') {
    poolQuery.mockResolvedValueOnce({ rows: [{ workerUserId, passwordHash }] });
  }

  // Each test gets a fresh cache because invalidateWorkerCredentialCache is used
  // to clean up, or we use unique workerKeys to avoid cross-test pollution.

  it('cache miss → hits DB → bcrypt.compare true → returns { workerUserId }', async () => {
    mockDbRow('user-42', '$2b$10$hash1');
    bcryptCompare.mockResolvedValueOnce(true);

    const result = await verifyWorkerCredentials('worker-a', 'secret');

    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"WorkerDeviceIdentity"/);
    expect(sql).toMatch(/"passwordHash" IS NOT NULL/);
    expect(sql).toMatch(/"revokedAt" IS NULL/);
    expect(params).toEqual(['worker-a']);

    expect(bcryptCompare).toHaveBeenCalledWith('secret', '$2b$10$hash1');
    expect(result).toEqual({ workerUserId: 'user-42' });

    // Clean up cache so other tests aren't affected.
    invalidateWorkerCredentialCache('worker-a');
  });

  it('second call within TTL does NOT hit DB again', async () => {
    mockDbRow('user-99', '$2b$10$hash2');
    bcryptCompare.mockResolvedValue(true);

    // First call — populates cache.
    await verifyWorkerCredentials('worker-b', 'pass');
    // Second call — should use cache, no extra DB query.
    const result = await verifyWorkerCredentials('worker-b', 'pass');

    expect(poolQuery).toHaveBeenCalledTimes(1); // Only one DB hit total.
    expect(result).toEqual({ workerUserId: 'user-99' });

    invalidateWorkerCredentialCache('worker-b');
  });

  it('wrong password → returns null, but cache entry still holds (correct password on 3rd call uses cached hash)', async () => {
    mockDbRow('user-55', '$2b$10$hash3');
    // First call: correct password populates cache.
    bcryptCompare.mockResolvedValueOnce(true);
    const first = await verifyWorkerCredentials('worker-c', 'right');
    expect(first).toEqual({ workerUserId: 'user-55' });

    // Second call: wrong password — still one DB hit total, bcrypt returns false.
    bcryptCompare.mockResolvedValueOnce(false);
    const second = await verifyWorkerCredentials('worker-c', 'wrong');
    expect(second).toBeNull();

    // Third call: correct password again — cache entry is still present (only 1 DB hit ever).
    bcryptCompare.mockResolvedValueOnce(true);
    const third = await verifyWorkerCredentials('worker-c', 'right');
    expect(third).toEqual({ workerUserId: 'user-55' });

    expect(poolQuery).toHaveBeenCalledTimes(1); // DB was hit exactly once across all three calls.

    invalidateWorkerCredentialCache('worker-c');
  });

  it('DB miss is NOT cached — second call after row appears hits DB again', async () => {
    // Call 1: no row in DB → null.
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const first = await verifyWorkerCredentials('worker-d', 'pass');
    expect(first).toBeNull();
    expect(poolQuery).toHaveBeenCalledTimes(1);

    // Call 2: row now exists (freshly provisioned) — MUST hit DB again.
    mockDbRow('user-77', '$2b$10$hash4');
    bcryptCompare.mockResolvedValueOnce(true);
    const second = await verifyWorkerCredentials('worker-d', 'pass');
    expect(second).toEqual({ workerUserId: 'user-77' });
    expect(poolQuery).toHaveBeenCalledTimes(2); // Two DB hits — miss was not cached.

    invalidateWorkerCredentialCache('worker-d');
  });

  it('invalidateWorkerCredentialCache removes the entry — next call hits DB again', async () => {
    mockDbRow('user-33', '$2b$10$hash5');
    bcryptCompare.mockResolvedValue(true);

    // Populate cache.
    await verifyWorkerCredentials('worker-e', 'pass');
    expect(poolQuery).toHaveBeenCalledTimes(1);

    // Evict.
    invalidateWorkerCredentialCache('worker-e');

    // Next call must hit DB again.
    mockDbRow('user-33', '$2b$10$hash5');
    await verifyWorkerCredentials('worker-e', 'pass');
    expect(poolQuery).toHaveBeenCalledTimes(2);

    invalidateWorkerCredentialCache('worker-e');
  });

  it('rows with passwordHash IS NULL are filtered — query returns 0 rows → null', async () => {
    // The SQL filters "passwordHash" IS NOT NULL, so we simulate 0 rows returned.
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await verifyWorkerCredentials('worker-f', 'pass');
    expect(result).toBeNull();
    // Verify bcrypt was never called for a row-less result.
    expect(bcryptCompare).not.toHaveBeenCalled();
  });
});
