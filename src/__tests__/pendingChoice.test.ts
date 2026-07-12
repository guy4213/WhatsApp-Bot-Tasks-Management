/**
 * PendingChoice service (PR#2) — number→command mapping for Green API menus.
 *
 * The pool is mocked, so these assert the SQL contract precisely: a 60-minute
 * upsert, the atomic delete-on-consume, the TTL/key guards, and the free-text
 * short-circuit that never touches the DB. (Migration 019 itself is exercised by
 * integration.test.ts's apply-all-migrations pass under RUN_DB_TESTS=1.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));

import { savePendingChoice, resolvePendingChoice, PENDING_CHOICE_TTL_MINUTES } from '../services/pendingChoice';

beforeEach(() => { poolQuery.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('savePendingChoice', () => {
  it('upserts one row per phone with a 60-minute TTL and the JSON mapping', async () => {
    expect(PENDING_CHOICE_TTL_MINUTES).toBe(60);
    poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await savePendingChoice('972501234567', { '1': 'כן u', '2': 'לא u' });

    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO "PendingChoice"');
    expect(sql).toContain('ON CONFLICT (phone) DO UPDATE');
    expect(sql).toContain('make_interval(mins => $3)');
    expect(params[0]).toBe('972501234567');
    expect(JSON.parse(params[1] as string)).toEqual({ '1': 'כן u', '2': 'לא u' });
    expect(params[2]).toBe(60);
  });
});

describe('resolvePendingChoice', () => {
  it('free text short-circuits to null WITHOUT touching the DB', async () => {
    const out = await resolvePendingChoice('972501234567', 'בעצם לא');
    expect(out).toBeNull();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('a numeric reply atomically consumes the row and returns the mapped command', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ resolved: 'כן 9c-uuid' }], rowCount: 1 });
    const out = await resolvePendingChoice('972501234567', '  2 ');
    expect(out).toBe('כן 9c-uuid');

    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toContain('DELETE FROM "PendingChoice"');   // consume on resolve
    expect(sql).toContain('"expiresAt" > now()');           // 60-min TTL enforced at read
    expect(sql).toContain('jsonb_exists(mapping, $2)');      // only when the key is present
    expect(params).toEqual(['972501234567', '2']);          // key is trimmed
  });

  it('returns null when nothing matched (expired / wrong key / no row)', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const out = await resolvePendingChoice('972501234567', '5');
    expect(out).toBeNull();
  });
});
