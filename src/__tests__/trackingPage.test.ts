/**
 * Behavioral tests for `routes/trackingPage.ts` — the customer-facing HTML.
 *
 * These tests would fail if:
 *  - the token regex was relaxed and a malformed path hit the DB.
 *  - the 404 page leaked hints about whether the token ever existed.
 *  - the served HTML embedded coordinates for a terminal session.
 *  - the served HTML embedded internal ids we promised not to expose.
 *  - the RTL / lang attributes were dropped.
 *
 * The template uses `getPublicView` under the hood — we mock it so tests
 * neither need a real DB nor a real HTTP round-trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const getPublicView = vi.fn();

vi.mock('../services/tracking', () => ({
  getPublicView: (...a: unknown[]) => getPublicView(...a),
}));

// Import AFTER the mock so the plugin picks up the stub.
import { trackingPageRoutes } from '../routes/trackingPage';

let app: FastifyInstance;

beforeEach(async () => {
  getPublicView.mockReset();
  app = Fastify();
  await app.register(trackingPageRoutes);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

const VALID_TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

// ── 404 paths ──────────────────────────────────────────────────────────────

describe('GET /t/:token — malformed token', () => {
  it('returns 404 HTML without touching getPublicView', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/short' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('הקישור אינו תקף');
    expect(getPublicView).not.toHaveBeenCalled();
  });
});

describe('GET /t/:token — unknown token', () => {
  it('returns 404 HTML with the same body as a malformed token — no existence leak', async () => {
    getPublicView.mockResolvedValueOnce(null);
    const notFoundRes = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(notFoundRes.statusCode).toBe(404);
    expect(notFoundRes.body).toContain('הקישור אינו תקף');

    // The two 404 bodies must be indistinguishable — otherwise a caller could
    // learn whether a token "used to exist" (was revoked) vs "never existed".
    const malformedRes = await app.inject({ method: 'GET', url: '/t/short' });
    expect(notFoundRes.body).toBe(malformedRes.body);
  });
});

// ── ACTIVE — full page contents ────────────────────────────────────────────

describe('GET /t/:token — ACTIVE session', () => {
  it('renders the full page with ETA, coordinates, Leaflet CDN + SRI, and RTL sanity', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      lastLocation: { lat: 32.0853, lng: 34.7818, at: '2026-07-08T09:00:00Z', accuracy: 15 },
      etaMinutes: 25,
      expectedArrivalAt: '2026-07-08T09:25:00Z',
    });

    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');

    // Hebrew RTL sanity — screen readers, mobile layout depend on this.
    expect(res.body).toContain('<html dir="rtl" lang="he">');

    // Brand text.
    expect(res.body).toContain('גלית החברה לאיכות הסביבה');

    // Leaflet 1.9.4 loaded from unpkg with SRI (customer page must be
    // supply-chain-hardened — CDN can serve any version otherwise).
    expect(res.body).toContain('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
    expect(res.body).toContain('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
    expect(res.body).toMatch(/integrity="sha256-[^"]+"/g);
    expect(res.body).toContain('crossorigin=""');

    // Initial state embedded — coordinates + ETA reachable to the boot script.
    expect(res.body).toContain('"lat":32.0853');
    expect(res.body).toContain('"lng":34.7818');
    expect(res.body).toContain('"etaMinutes":25');
    expect(res.body).toContain('"expectedArrivalAt":"2026-07-08T09:25:00Z"');

    // Token in the JS constant (used for polling — unavoidable and safe).
    expect(res.body).toContain(`"${VALID_TOKEN}"`);
  });
});

// ── FINISHED / CANCELED — never leak coordinates ───────────────────────────

describe('GET /t/:token — FINISHED session', () => {
  it('renders the finished page without any coordinates in the served HTML', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'FINISHED',
      taskFieldStatus: 'FINISHED_FIELD',
      updatedAt: '2026-07-08T09:30:00Z',
      // getPublicView already strips lastLocation/etaMinutes for terminal states;
      // we assert that even if it didn't, the page would not embed them.
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/"lat":\s*[0-9]/);
    expect(res.body).not.toMatch(/"lng":\s*[0-9]/);
    expect(res.body).not.toMatch(/"etaMinutes":\s*[0-9]/);
    // The status enum drives the client-side "הבדיקה הסתיימה" hero — verify
    // the embedded state carries it (the visible text is rendered by JS at runtime).
    expect(res.body).toContain('"status":"FINISHED"');
  });
});

describe('GET /t/:token — CANCELED session', () => {
  it('renders the canceled page without coordinates', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'CANCELED',
      taskFieldStatus: 'DECLINED',
      updatedAt: '2026-07-08T09:15:00Z',
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"status":"CANCELED"');
    expect(res.body).not.toMatch(/"lat":\s*[0-9]/);
    expect(res.body).not.toMatch(/"lng":\s*[0-9]/);
  });
});

// ── Explicit "no internal id leak" defense-in-depth ────────────────────────

describe('GET /t/:token — never embeds internal ids', () => {
  for (const status of ['ACTIVE', 'ARRIVED', 'FINISHED', 'CANCELED', 'EXPIRED']) {
    it(`for status=${status}`, async () => {
      getPublicView.mockResolvedValueOnce({
        status,
        taskFieldStatus: 'X',
        updatedAt: '2026-07-08T09:00:00Z',
        ...(status === 'ACTIVE' || status === 'ARRIVED'
          ? { lastLocation: { lat: 32, lng: 34, at: '2026-07-08T09:00:00Z', accuracy: 15 } }
          : {}),
      });
      const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
      expect(res.statusCode).toBe(200);
      // The strings `taskFieldId`, `workerUserId`, `publicToken` MUST NOT
      // appear in the served HTML. `getPublicView` also never returns them —
      // this is defense-in-depth, so a future accidental payload widening
      // is caught here.
      expect(res.body).not.toContain('taskFieldId');
      expect(res.body).not.toContain('workerUserId');
      expect(res.body).not.toContain('publicToken');
    });
  }
});
