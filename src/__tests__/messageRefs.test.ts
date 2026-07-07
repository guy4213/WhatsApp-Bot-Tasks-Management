import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../db/connection', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { recordOutboundRef, recordTaskFieldRef, resolveQuotedContext } from '../services/messageRefs';

beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [], rowCount: 0 }); });
afterEach(() => { vi.restoreAllMocks(); });

describe('recordOutboundRef', () => {
  it('inserts a row and returns true when a wamid is present', async () => {
    const ok = await recordOutboundRef({
      wamid: 'wamid.X', entityType: 'equipment_reminder', kind: 'equipment_reminder',
      recipientUserId: 'u-1', entityId: '2026-07-08', payload: { workerId: 'u-1' },
    });
    expect(ok).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO "WhatsappMessageRef"/);
    expect(params[0]).toBe('wamid.X');
    expect(params[2]).toBe('equipment_reminder'); // entityType
  });

  it('is a no-op (no query) when the wamid is missing', async () => {
    expect(await recordOutboundRef({ wamid: null, entityType: 'general', kind: 'general' })).toBe(false);
    expect(await recordOutboundRef({ wamid: undefined, entityType: 'general', kind: 'general' })).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('NEVER throws when the DB write fails (best-effort)', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    await expect(
      recordOutboundRef({ wamid: 'wamid.Y', entityType: 'task_field', kind: 'eta_prompt', taskFieldId: 'tf-1' }),
    ).resolves.toBe(false);
  });
});

describe('recordTaskFieldRef', () => {
  it('records a task_field ref with the convenience fields set', async () => {
    await recordTaskFieldRef('wamid.Z', 'tf-9', 'u-2', 'pre_reminder');
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('wamid.Z');        // wamid
    expect(params[1]).toBe('u-2');            // recipientUserId
    expect(params[2]).toBe('task_field');     // entityType
    expect(params[3]).toBe('tf-9');           // entityId
    expect(params[4]).toBe('tf-9');           // taskFieldId
    expect(params[5]).toBe('pre_reminder');   // kind
    expect(params[7]).toBeInstanceOf(Date);   // expiresAt defaulted (30d)
  });
});

describe('resolveQuotedContext', () => {
  it('returns the full context for a task_field ref (with taskFieldId)', async () => {
    query.mockResolvedValueOnce({ rows: [{
      wamid: 'w1', recipientUserId: 'u-1', entityType: 'task_field', entityId: 'tf-B',
      taskFieldId: 'tf-B', kind: 'pre_reminder', payload: null,
      createdAt: new Date(), expiresAt: null,
    }] });
    const ctx = await resolveQuotedContext('w1');
    expect(ctx?.entityType).toBe('task_field');
    expect(ctx?.taskFieldId).toBe('tf-B');
  });

  it('returns a non-task_field context with taskFieldId=null', async () => {
    query.mockResolvedValueOnce({ rows: [{
      wamid: 'w2', recipientUserId: 'u-1', entityType: 'equipment_reminder', entityId: '2026-07-08',
      taskFieldId: null, kind: 'equipment_reminder', payload: { workerId: 'u-1' },
      createdAt: new Date(), expiresAt: null,
    }] });
    const ctx = await resolveQuotedContext('w2');
    expect(ctx?.entityType).toBe('equipment_reminder');
    expect(ctx?.taskFieldId).toBeNull();
    expect(ctx?.payload).toEqual({ workerId: 'u-1' });
  });

  it('returns null for an unknown / expired wamid (query filters it out)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await resolveQuotedContext('missing')).toBeNull();
  });

  it('returns null (no query) when no wamid is given', async () => {
    expect(await resolveQuotedContext(undefined)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('treats a DB error as "no context" (returns null, no throw)', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveQuotedContext('w3')).resolves.toBeNull();
  });
});
