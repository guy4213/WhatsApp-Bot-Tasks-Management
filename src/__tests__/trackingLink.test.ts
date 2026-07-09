/**
 * Unit tests for `services/trackingLink.ts` — the customer-facing tracking
 * URL helpers used by `customerNotifications.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.hoisted(() => vi.fn());

vi.mock('../db/connection', () => ({
  pool: { query: poolQueryMock },
  supabaseAdmin: {},
}));

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  poolQueryMock.mockReset();
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe('buildTrackingUrl', () => {
  it('returns null when TRACKING_PUBLIC_BASE_URL is unset', async () => {
    delete process.env.TRACKING_PUBLIC_BASE_URL;
    const { buildTrackingUrl } = await import('../services/trackingLink');
    expect(buildTrackingUrl('tok123')).toBeNull();
  });

  it('returns null when TRACKING_PUBLIC_BASE_URL is blank', async () => {
    process.env.TRACKING_PUBLIC_BASE_URL = '   ';
    const { buildTrackingUrl } = await import('../services/trackingLink');
    expect(buildTrackingUrl('tok123')).toBeNull();
  });

  it('builds /t/<token> from the base URL', async () => {
    process.env.TRACKING_PUBLIC_BASE_URL = 'https://bot.example.com';
    const { buildTrackingUrl } = await import('../services/trackingLink');
    expect(buildTrackingUrl('tok123')).toBe('https://bot.example.com/t/tok123');
  });

  it('strips a trailing slash from the base URL', async () => {
    process.env.TRACKING_PUBLIC_BASE_URL = 'https://bot.example.com/';
    const { buildTrackingUrl } = await import('../services/trackingLink');
    expect(buildTrackingUrl('tok123')).toBe('https://bot.example.com/t/tok123');
  });

  it('strips multiple trailing slashes from the base URL', async () => {
    process.env.TRACKING_PUBLIC_BASE_URL = 'https://bot.example.com///';
    const { buildTrackingUrl } = await import('../services/trackingLink');
    expect(buildTrackingUrl('tok123')).toBe('https://bot.example.com/t/tok123');
  });
});

describe('getActiveTrackingToken', () => {
  it('returns the token when an active session is found', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ publicToken: 'tok123' }], rowCount: 1 });
    const { getActiveTrackingToken } = await import('../services/trackingLink');
    const token = await getActiveTrackingToken('tf-1');
    expect(token).toBe('tok123');
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"TrackingSession"');
    expect(sql).toContain('ACTIVE');
    expect(sql).toContain('ARRIVED');
    expect(params).toEqual(['tf-1']);
  });

  it('returns null when there is no active session', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { getActiveTrackingToken } = await import('../services/trackingLink');
    const token = await getActiveTrackingToken('tf-1');
    expect(token).toBeNull();
  });

  it('returns null (never throws) on a DB error', async () => {
    poolQueryMock.mockRejectedValueOnce(new Error('db down'));
    const { getActiveTrackingToken } = await import('../services/trackingLink');
    await expect(getActiveTrackingToken('tf-1')).resolves.toBeNull();
  });
});
