/**
 * Behavioral tests for `routes/tracking.ts` — the public + debug HTTP surface.
 *
 * The route is a thin adapter over `services/tracking.ts`, so we mock the
 * service and only assert the HTTP contract: token whitelist, 404 semantics
 * (no leak), cache-control, and the internal-secret guard on the debug route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const getPublicView   = vi.fn();
const listActiveSessions = vi.fn();

vi.mock('../services/tracking', () => ({
  getPublicView:      (...a: unknown[]) => getPublicView(...a),
  listActiveSessions: (...a: unknown[]) => listActiveSessions(...a),
}));

// Import AFTER the mock so the plugin picks up the mocked services.
import { trackingRoutes } from '../routes/tracking';

let app: FastifyInstance;

beforeEach(async () => {
  getPublicView.mockReset();
  listActiveSessions.mockReset();
  app = Fastify();
  await app.register(trackingRoutes);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('GET /tracking/:token', () => {
  it('rejects a malformed token with 404 before hitting the DB', async () => {
    const res = await app.inject({ method: 'GET', url: '/tracking/short' });
    expect(res.statusCode).toBe(404);
    expect(getPublicView).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown token — no distinction from "revoked"', async () => {
    getPublicView.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: 'GET',
      // 32-char valid-shape token
      url: '/tracking/abcdefghijklmnopqrstuvwxyz012345',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found' });
  });

  it('returns the public view with Cache-Control: no-store', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      lastLocation: { lat: 32, lng: 34, at: '2026-07-08T09:00:00Z', accuracy: 15 },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/tracking/abcdefghijklmnopqrstuvwxyz012345',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json().status).toBe('ACTIVE');
  });
});

describe('GET /tracking/debug/sessions', () => {
  it('falls open in dev (no INTERNAL_API_SECRET) and returns the sessions payload', async () => {
    // The plugin reads process.env.INTERNAL_API_SECRET at import time and
    // falls open when it's empty. That IS the dev default (see routes/tasks.ts).
    // In test env INTERNAL_API_SECRET is unset, so we assert the fall-open path.
    listActiveSessions.mockResolvedValueOnce([
      { id: 's1', taskFieldId: 'tf-1', workerUserId: 'u-1', status: 'ACTIVE',
        startedAt: '2026-07-08T09:00:00Z', arrivedAt: null, endedAt: null,
        expiresAt: '2099-01-01T00:00:00Z', lastLocationAt: null,
        publicToken: 'tok1' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/tracking/debug/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].status).toBe('ACTIVE');
  });
});
