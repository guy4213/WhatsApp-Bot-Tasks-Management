/**
 * Unit tests for services/voiceAccess.ts — token minting + resolution.
 * The pg pool is mocked; assertions cover input hardening (no DB touch on
 * malformed tokens), hash-at-rest, and the ResolvedUser mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...a: unknown[]) => query(...a) },
  supabaseAdmin: {},
}));

import { createVoiceToken, resolveVoiceToken } from '../services/voiceAccess';

beforeEach(() => {
  query.mockReset();
});

describe('resolveVoiceToken — input hardening', () => {
  it('rejects a short token without touching the DB', async () => {
    expect(await resolveVoiceToken('short')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a token with non-base64url characters without touching the DB', async () => {
    expect(await resolveVoiceToken('aaaaaaaaaaaaaaaa$$!!aaaaaaaa')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an empty token', async () => {
    expect(await resolveVoiceToken('')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('resolveVoiceToken — DB paths', () => {
  const validToken = 'AbCdEfGhIjKlMnOpQrStUvWx';

  it('returns null for an unknown/expired/revoked token', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await resolveVoiceToken(validToken)).toBeNull();
  });

  it('returns null for an inactive user', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        tokenId: 't1', id: 'u1', name: 'דני', phone: '0501111111', role: 'TECHNICIAN',
        status: 'INACTIVE', can_view_all_records: false, can_manage_users: false,
        can_manage_permissions: false,
      }],
      rowCount: 1,
    });
    expect(await resolveVoiceToken(validToken)).toBeNull();
  });

  it('maps a MANAGER row to an elevated ResolvedUser and stamps lastUsedAt', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          tokenId: 't1', id: 'u2', name: 'אורי', phone: '0502222222', role: 'MANAGER',
          status: 'ACTIVE', can_view_all_records: true, can_manage_users: true,
          can_manage_permissions: false,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // lastUsedAt UPDATE

    const user = await resolveVoiceToken(validToken);
    expect(user).not.toBeNull();
    expect(user!.id).toBe('u2');
    expect(user!.isElevated).toBe(true);
    expect(user!.role).toBe('MANAGER');
    // SELECT + best-effort UPDATE
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('createVoiceToken', () => {
  it('stores only a 64-hex hash and returns a base64url token', async () => {
    query.mockResolvedValueOnce({ rows: [{ expiresAt: new Date('2026-10-12') }], rowCount: 1 });
    const { token } = await createVoiceToken('u1', { label: 'בדיקה' });

    expect(token).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    const [, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('u1');
    expect(params[1]).toMatch(/^[0-9a-f]{64}$/);       // sha256 hex — not the raw token
    expect(params[1]).not.toContain(token);
    expect(params[2]).toBe('בדיקה');
  });
});
