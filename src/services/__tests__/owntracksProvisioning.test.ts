/**
 * Behavioral tests for `services/owntracksProvisioning.ts`.
 *
 * These tests would fail if:
 *  - createProvisioning inserted a duplicate row instead of updating in-place.
 *  - consumeProvisioning returned a payload for an expired token.
 *  - the plaintext password did not match the stored bcrypt hash.
 *  - a second consume attempt on the same token succeeded.
 *  - createProvisioning succeeded for a non-existent userId.
 *
 * Pool is mocked (same pattern as workerLocation.test.ts and the rest of the
 * suite) — no real DB connection needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

// ── Pool mock ─────────────────────────────────────────────────────────────────

// We need per-call control: pool.connect() returns a client with its own
// query/release. The mock simulates the acquire → BEGIN/query.../COMMIT/release
// lifecycle.

type MockClient = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockClient: MockClient = {
  query: mockClientQuery,
  release: mockClientRelease,
};

// pool.query is used only for the initial User lookup (outside the TX).
const poolQuery = vi.fn();
const poolConnect = vi.fn().mockResolvedValue(mockClient);

vi.mock('../../db/connection', () => ({
  pool: {
    query: (...args: unknown[]) => poolQuery(...args),
    connect: () => poolConnect(),
  },
}));

// ── Env setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.PUBLIC_BASE_URL = 'https://bot.example.com';
  poolQuery.mockReset();
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  poolConnect.mockResolvedValue(mockClient);
});

afterEach(() => {
  vi.restoreAllMocks();
});

import {
  createProvisioning,
  consumeProvisioning,
} from '../owntracksProvisioning';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Sequence mockClientQuery responses for BEGIN, selectExisting, insert/update, COMMIT */
function setupCreateTx(opts: {
  userExists?: boolean;
  existingRow?: { id: string; workerKey: string } | null;
}) {
  const { userExists = true, existingRow = null } = opts;

  // pool.query → User lookup
  if (userExists) {
    poolQuery.mockResolvedValueOnce({ rows: [{ name: 'דני כהן' }] });
  } else {
    poolQuery.mockResolvedValueOnce({ rows: [] });
  }

  if (!userExists) return; // no TX calls follow

  // client.query calls in order: BEGIN, SELECT existing, INSERT or UPDATE, COMMIT
  mockClientQuery
    .mockResolvedValueOnce({}) // BEGIN
    .mockResolvedValueOnce({ rows: existingRow ? [existingRow] : [] }) // SELECT
    .mockResolvedValueOnce({}) // INSERT or UPDATE
    .mockResolvedValueOnce({}); // COMMIT
}

function setupConsumeTx(opts: {
  foundRow?: {
    id: string;
    workerKey: string;
    workerUserId: string;
    trackerId: string;
    provisioningExpiresAt: Date;
  } | null;
}) {
  const { foundRow } = opts;

  // client.query calls: BEGIN, SELECT FOR UPDATE, [UPDATE, COMMIT] or ROLLBACK
  mockClientQuery
    .mockResolvedValueOnce({}) // BEGIN
    .mockResolvedValueOnce({ rows: foundRow ? [foundRow] : [] }); // SELECT

  if (foundRow && foundRow.provisioningExpiresAt > new Date()) {
    mockClientQuery
      .mockResolvedValueOnce({}) // UPDATE
      .mockResolvedValueOnce({}); // COMMIT
  } else {
    mockClientQuery.mockResolvedValueOnce({}); // ROLLBACK
  }
}

// ── createProvisioning ────────────────────────────────────────────────────────

describe('createProvisioning', () => {
  it('inserts a new row when no row exists for the user', async () => {
    setupCreateTx({ existingRow: null });

    const result = await createProvisioning('user-new-1');

    expect(result.magicUrl).toMatch(/^https:\/\/bot\.example\.com\/o\//);
    expect(result.workerKey).toMatch(/^[a-z0-9]+_[0-9a-f]{4}$/);
    expect(result.expiresAt).toBeInstanceOf(Date);

    // The TX must contain a BEGIN, SELECT, INSERT, COMMIT
    const calls = mockClientQuery.mock.calls.map((c) => (c[0] as string).trim().toUpperCase());
    expect(calls[0]).toMatch(/^BEGIN/);
    expect(calls[1]).toMatch(/SELECT/);
    // INSERT (not UPDATE) because existingRow was null
    expect(calls[2]).toMatch(/INSERT INTO/);
    expect(calls[3]).toMatch(/^COMMIT/);
  });

  it('updates the existing row in-place when called twice for the same user', async () => {
    const existingRow = { id: 'row-id-1', workerKey: 'daniko_aa11' };
    setupCreateTx({ existingRow });

    const result = await createProvisioning('user-existing-1');

    // workerKey must be the EXISTING one, not a freshly generated slug
    expect(result.workerKey).toBe('daniko_aa11');

    const calls = mockClientQuery.mock.calls.map((c) => (c[0] as string).trim().toUpperCase());
    // Third call (index 2) should be an UPDATE, not INSERT
    expect(calls[2]).toMatch(/^UPDATE/);
    expect(calls[2]).not.toMatch(/INSERT/);
  });

  it('throws when the userId does not exist', async () => {
    setupCreateTx({ userExists: false });

    await expect(createProvisioning('non-existent-user')).rejects.toThrow('User not found: non-existent-user');
  });

  it('returns a magicUrl pointing at /o/:token', async () => {
    setupCreateTx({ existingRow: null });

    const { magicUrl } = await createProvisioning('user-url-check');
    expect(magicUrl).toMatch(/^https:\/\/bot\.example\.com\/o\/[A-Za-z0-9_-]{30,}$/);
  });

  it('sets expiresAt ~48 hours from now', async () => {
    setupCreateTx({ existingRow: null });

    const before = Date.now();
    const { expiresAt } = await createProvisioning('user-expiry');
    const after = Date.now();

    const ms48h = 48 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + ms48h - 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + ms48h + 1000);
  });
});

// ── consumeProvisioning ───────────────────────────────────────────────────────

describe('consumeProvisioning', () => {
  it('returns null for an unknown token', async () => {
    setupConsumeTx({ foundRow: null });

    const result = await consumeProvisioning('unknown-token-xyz');
    expect(result).toBeNull();
  });

  it('returns null for an expired token (leaves row intact)', async () => {
    const pastDate = new Date(Date.now() - 1000); // 1 second ago
    setupConsumeTx({
      foundRow: {
        id: 'row-expired',
        workerKey: 'wk_expired',
        workerUserId: 'user-expired',
        trackerId: 'EX',
        provisioningExpiresAt: pastDate,
      },
    });

    const result = await consumeProvisioning('expired-token');
    expect(result).toBeNull();

    // Should have issued ROLLBACK (not COMMIT) after finding the expired row
    const calls = mockClientQuery.mock.calls.map((c) => (c[0] as string).trim().toUpperCase());
    expect(calls.some((c) => c.startsWith('ROLLBACK'))).toBe(true);
    expect(calls.some((c) => c.startsWith('COMMIT'))).toBe(false);
  });

  it('returns the OtrcPayload on happy path and clears the token', async () => {
    const futureDate = new Date(Date.now() + 3600_000);
    setupConsumeTx({
      foundRow: {
        id: 'row-happy',
        workerKey: 'daniko_a3f9',
        workerUserId: 'user-happy',
        trackerId: 'DA',
        provisioningExpiresAt: futureDate,
      },
    });

    const result = await consumeProvisioning('valid-token-happy');

    expect(result).not.toBeNull();
    expect(result!.workerKey).toBe('daniko_a3f9');
    expect(result!.trackerId).toBe('DA');
    expect(result!.hostUrl).toBe('https://bot.example.com/owntracks');
    // plaintext password should be a non-empty string
    expect(typeof result!.password).toBe('string');
    expect(result!.password.length).toBeGreaterThan(10);

    // The UPDATE call must set passwordHash, clear provisioningToken
    const updateCall = mockClientQuery.mock.calls.find(
      (c) => (c[0] as string).trim().toUpperCase().startsWith('UPDATE'),
    );
    expect(updateCall).toBeDefined();
    const updateSql = updateCall![0] as string;
    expect(updateSql).toMatch(/"passwordHash"/);
    expect(updateSql).toMatch(/"provisioningToken"\s*=\s*NULL/);
    expect(updateSql).toMatch(/"provisioningExpiresAt"\s*=\s*NULL/);
    expect(updateSql).toMatch(/"provisionedAt"\s*=\s*now\(\)/);
  });

  it('bcrypt hash verifies with the returned plaintext', async () => {
    const futureDate = new Date(Date.now() + 3600_000);
    // We need to capture what hash was passed to the UPDATE call.
    // Override mockClientQuery so we can intercept the UPDATE params.
    mockClientQuery.mockReset();

    let capturedHash: string | null = null;
    mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith('BEGIN') || upper.startsWith('COMMIT')) return {};
      if (upper.startsWith('SELECT')) return { rows: [{
        id: 'row-bcrypt',
        workerKey: 'wk_bcrypt',
        workerUserId: 'user-bcrypt',
        trackerId: 'BC',
        provisioningExpiresAt: futureDate,
      }] };
      if (upper.startsWith('UPDATE')) {
        capturedHash = (params as string[])[0];
        return {};
      }
      return {};
    });

    const result = await consumeProvisioning('token-bcrypt');

    expect(result).not.toBeNull();
    expect(capturedHash).not.toBeNull();
    // The stored hash must verify against the returned plaintext.
    const verified = await bcrypt.compare(result!.password, capturedHash!);
    expect(verified).toBe(true);
  });

  it('second consume returns null (token already cleared)', async () => {
    // Simulates a second call: the DB row no longer has the token → no row found.
    mockClientQuery.mockReset();
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT — token already NULL
      .mockResolvedValueOnce({}); // ROLLBACK

    const result = await consumeProvisioning('already-consumed-token');
    expect(result).toBeNull();
  });
});
