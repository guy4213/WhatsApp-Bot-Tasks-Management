/**
 * GET /oi/:blob — the WhatsApp-clickable HTTPS wrapper that 302-redirects into
 * the idempotent OwnTracks inline-config scheme.
 *
 * Dedicated file (not owntracksConfig.test.ts) so the router isn't polluted by
 * that file's vi.resetModules() isolation tests. Heavy deps are mocked; the real
 * route + real owntracksProvisioning helpers run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../services/workerLocation', () => ({
  verifyWorkerCredentials: vi.fn(),
  resolveWorkerFromKey: vi.fn(),
  upsertLiveLocation: vi.fn(),
  invalidateWorkerCredentialCache: vi.fn(),
}));
vi.mock('../services/tracking', () => ({ bumpSessionLocation: vi.fn() }));
vi.mock('../db/connection', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  supabaseAdmin: {},
}));

import { owntracksPocRoutes } from '../routes/owntracksPoc';

let app: FastifyInstance;
beforeEach(async () => {
  app = Fastify({ logger: false });
  app.register(owntracksPocRoutes);
  await app.ready();
});
afterEach(async () => { await app.close(); });

describe('GET /oi?c=<blob>', () => {
  // A realistic full .otrc — base64url ~375 chars, exercising the query-param path
  // that avoids Fastify's default maxParamLength (100) 404.
  const otrc = {
    _type: 'configuration', mode: 3, url: 'https://bot.example.com/owntracks', auth: true,
    username: 'danny_a1b2', password: 'x'.repeat(43), tid: 'DA', deviceId: 'danny_a1b2',
    monitoring: 2, locatorInterval: 15, locatorDisplacement: 50, pubExtendedData: true,
  };
  const blob = Buffer.from(JSON.stringify(otrc), 'utf8').toString('base64url');

  it('302-redirects to the owntracks:// inline scheme carrying the decoded config', async () => {
    expect(blob.length).toBeGreaterThan(100); // would 404 as a path param
    const res = await app.inject({ method: 'GET', url: `/oi?c=${blob}` });
    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc.startsWith('owntracks:///config?inline=')).toBe(true);
    // Round-trip: the inline base64 decodes back to the exact config we encoded.
    const inlineB64 = loc.replace('owntracks:///config?inline=', '');
    expect(JSON.parse(Buffer.from(inlineB64, 'base64').toString('utf8'))).toEqual(otrc);
  });

  it('rejects a blob that is not a configuration with 404 (no open redirect)', async () => {
    const bad = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8').toString('base64url');
    const res = await app.inject({ method: 'GET', url: `/oi?c=${bad}` });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed blob (bad chars) with 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/oi?c=not..valid..blob' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a missing c param with 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/oi' });
    expect(res.statusCode).toBe(404);
  });
});
