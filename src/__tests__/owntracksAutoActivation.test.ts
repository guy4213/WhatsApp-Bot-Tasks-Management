/**
 * OwnTracks auto-activation (monitoring:2 + deterministic password model C +
 * idempotent inline link + dual-auth migration).
 *
 * Pool + bcrypt are mocked. Covers the units that make the feature correct:
 *  - deriveOwntracksPassword: deterministic, secret-scoped.
 *  - buildOtrc: MOVE mode (monitoring:2); inline base64 round-trips.
 *  - buildInlineConfigLink: deterministic, monitoring:2, null-guards (no broken link).
 *  - countOpenInspectionsForWorkerOnDate: last-task-of-day detection query.
 *  - verifyWorkerCredentials: accepts BOTH the deterministic HMAC (new) and the
 *    legacy bcrypt hash (existing workers) — the no-downtime migration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...a: unknown[]) => poolQuery(...a), connect: vi.fn() },
  supabaseAdmin: {},
}));

const bcryptCompare = vi.fn();
vi.mock('bcryptjs', () => ({
  default: { compare: (...a: unknown[]) => bcryptCompare(...a), hash: vi.fn() },
  compare: (...a: unknown[]) => bcryptCompare(...a),
  hash: vi.fn(),
}));

import {
  deriveOwntracksPassword, buildOtrc, otrcToInlineScheme, otrcToHttpsLink,
  buildInlineConfigLink, hasActiveProvisioning, OWNTRACKS_MONITORING_MOVE,
} from '../services/owntracksProvisioning';
import { countOpenInspectionsForWorkerOnDate } from '../services/inspectionsQueries';
import { verifyWorkerCredentials, invalidateWorkerCredentialCache } from '../services/workerLocation';

const SECRET = 'unit-test-owntracks-secret-0123456789abcdef';
const ORIG_ENV = { ...process.env };

beforeEach(() => {
  poolQuery.mockReset();
  bcryptCompare.mockReset();
  process.env.OWNTRACKS_CONFIG_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = 'https://bot.example.com';
});
afterEach(() => {
  process.env = { ...ORIG_ENV };
  vi.restoreAllMocks();
});

describe('deriveOwntracksPassword (model C)', () => {
  it('is deterministic per (secret, workerKey)', () => {
    expect(deriveOwntracksPassword('danny_a1b2')).toBe(deriveOwntracksPassword('danny_a1b2'));
    expect(deriveOwntracksPassword('danny_a1b2').length).toBeGreaterThan(20);
  });
  it('differs by workerKey and by secret', () => {
    const base = deriveOwntracksPassword('danny_a1b2');
    expect(deriveOwntracksPassword('yossi_c3d4')).not.toBe(base);
    process.env.OWNTRACKS_CONFIG_SECRET = 'a-totally-different-secret-abcdef0123456789';
    expect(deriveOwntracksPassword('danny_a1b2')).not.toBe(base);
  });
  it('throws when OWNTRACKS_CONFIG_SECRET is unset', () => {
    delete process.env.OWNTRACKS_CONFIG_SECRET;
    expect(() => deriveOwntracksPassword('danny_a1b2')).toThrow();
  });
});

describe('buildOtrc + inline encoding', () => {
  const otrc = buildOtrc({ workerKey: 'w', trackerId: 'DA', hostUrl: 'https://h/owntracks', password: 'p' });

  it('produces MOVE mode (monitoring:2) HTTP-private config', () => {
    expect(OWNTRACKS_MONITORING_MOVE).toBe(2);
    expect(otrc.monitoring).toBe(2);
    expect(otrc.mode).toBe(3);
    expect(otrc).toMatchObject({ _type: 'configuration', username: 'w', password: 'p', tid: 'DA', deviceId: 'w', auth: true });
  });
  it('inline scheme base64 round-trips to the same JSON', () => {
    const b64 = otrcToInlineScheme(otrc).replace('owntracks:///config?inline=', '');
    expect(JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))).toEqual(otrc);
  });
  it('https wrapper blob (base64url, query param) round-trips to the same JSON', () => {
    const link = otrcToHttpsLink('https://bot.example.com', otrc);
    expect(link.startsWith('https://bot.example.com/oi?c=')).toBe(true);
    expect(JSON.parse(Buffer.from(link.split('?c=')[1], 'base64url').toString('utf8'))).toEqual(otrc);
  });
});

describe('buildInlineConfigLink', () => {
  const ROW = { workerKey: 'danny_a1b2', trackerId: 'DA' };

  it('builds an HTTPS /oi link whose config has the deterministic password + monitoring:2', async () => {
    poolQuery.mockResolvedValue({ rows: [ROW] });
    const link = await buildInlineConfigLink('user-1');
    expect(link).not.toBeNull();
    expect(link!.startsWith('https://bot.example.com/oi?c=')).toBe(true);
    const otrc = JSON.parse(Buffer.from(link!.split('?c=')[1], 'base64url').toString('utf8'));
    expect(otrc.monitoring).toBe(2);
    expect(otrc.username).toBe('danny_a1b2');
    expect(otrc.password).toBe(deriveOwntracksPassword('danny_a1b2'));
    expect(otrc.url).toBe('https://bot.example.com/owntracks');
  });

  it('is deterministic — two calls yield an identical link', async () => {
    poolQuery.mockResolvedValue({ rows: [ROW] });
    expect(await buildInlineConfigLink('user-1')).toBe(await buildInlineConfigLink('user-1'));
  });

  it('returns null (no broken link) when the worker has no active provisioning', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    expect(await buildInlineConfigLink('user-x')).toBeNull();
  });

  it('returns null when the config secret is unset', async () => {
    delete process.env.OWNTRACKS_CONFIG_SECRET;
    poolQuery.mockResolvedValue({ rows: [ROW] });
    expect(await buildInlineConfigLink('user-1')).toBeNull();
  });

  it('returns null when PUBLIC_BASE_URL (and fallback) is unset', async () => {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.TRACKING_PUBLIC_BASE_URL;
    poolQuery.mockResolvedValue({ rows: [ROW] });
    expect(await buildInlineConfigLink('user-1')).toBeNull();
  });
});

describe('hasActiveProvisioning', () => {
  it('true when a provisioned active row exists', async () => {
    poolQuery.mockResolvedValue({ rows: [{ ok: 1 }] });
    expect(await hasActiveProvisioning('user-1')).toBe(true);
  });
  it('false when no row', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    expect(await hasActiveProvisioning('user-x')).toBe(false);
  });
});

describe('countOpenInspectionsForWorkerOnDate (last-task detection)', () => {
  it('counts OPEN statuses inside the Asia/Jerusalem day', async () => {
    poolQuery.mockResolvedValue({ rows: [{ n: 2 }] });
    expect(await countOpenInspectionsForWorkerOnDate('user-1', '2026-07-13')).toBe(2);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toContain("AT TIME ZONE 'Asia/Jerusalem'");
    expect(sql).toContain("'ASSIGNED','CONFIRMED','EN_ROUTE','ARRIVED','WAITING_FOR_INFO','NEEDS_MORE_INFO'");
    expect(params).toEqual(['user-1', '2026-07-13']);
  });
  it('returns 0 when nothing open', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    expect(await countOpenInspectionsForWorkerOnDate('user-1', '2026-07-13')).toBe(0);
  });
});

describe('verifyWorkerCredentials — dual-auth (no-downtime migration)', () => {
  it('path 1: accepts the deterministic HMAC password WITHOUT bcrypt', async () => {
    const workerKey = 'det_worker_1';
    invalidateWorkerCredentialCache(workerKey);
    poolQuery.mockResolvedValue({ rows: [{ workerUserId: 'u-det', passwordHash: '$2b$10$stalehash' }] });
    const res = await verifyWorkerCredentials(workerKey, deriveOwntracksPassword(workerKey));
    expect(res).toEqual({ workerUserId: 'u-det' });
    expect(bcryptCompare).not.toHaveBeenCalled(); // deterministic path short-circuits
  });

  it('path 2: accepts a legacy password via the stored bcrypt hash', async () => {
    const workerKey = 'legacy_worker_1';
    invalidateWorkerCredentialCache(workerKey);
    poolQuery.mockResolvedValue({ rows: [{ workerUserId: 'u-leg', passwordHash: '$2b$10$legacyhash' }] });
    bcryptCompare.mockResolvedValue(true);
    const res = await verifyWorkerCredentials(workerKey, 'old-random-password');
    expect(res).toEqual({ workerUserId: 'u-leg' });
    expect(bcryptCompare).toHaveBeenCalledWith('old-random-password', '$2b$10$legacyhash');
  });

  it('rejects a wrong password (neither path matches)', async () => {
    const workerKey = 'wrong_worker_1';
    invalidateWorkerCredentialCache(workerKey);
    poolQuery.mockResolvedValue({ rows: [{ workerUserId: 'u-w', passwordHash: '$2b$10$h' }] });
    bcryptCompare.mockResolvedValue(false);
    expect(await verifyWorkerCredentials(workerKey, 'definitely-wrong')).toBeNull();
  });
});
