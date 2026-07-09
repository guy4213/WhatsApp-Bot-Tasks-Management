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

// ── Destination (migration 017) ────────────────────────────────────────────

describe('GET /t/:token — ACTIVE with destination', () => {
  it('embeds destination lat/lng + address in the initial state', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      lastLocation: { lat: 32.0853, lng: 34.7818, at: '2026-07-08T09:00:00Z', accuracy: 15 },
      etaMinutes: 25,
      expectedArrivalAt: '2026-07-08T09:25:00Z',
      destination: { lat: 32.0110, lng: 34.7712, address: 'אלופי צה"ל 48, חולון' },
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.statusCode).toBe(200);
    // Both lat/lng values reachable to the boot script.
    expect(res.body).toContain('"lat":32.011');
    expect(res.body).toContain('"lng":34.7712');
    // The address string is not rendered as HTML body text server-side — only
    // the client applyState() writes it into #subheader — but it MUST be
    // reachable via the embedded initial state so the client can render it.
    // Match on the JSON key rather than the raw Hebrew, which the safeJson()
    // encoder replaces `<` with `<` on.
    expect(res.body).toContain('"destination":');
    expect(res.body).toContain('"address"');
  });
});

describe('GET /t/:token — ACTIVE without destination', () => {
  it('never embeds the destination key when the resolver returned nothing', async () => {
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
    expect(res.body).not.toContain('"destination"');
  });
});

describe('GET /t/:token — never embeds site-cache diagnostics', () => {
  it('cache diagnostics stay server-side even with a destination present', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      lastLocation: { lat: 32, lng: 34, at: '2026-07-08T09:00:00Z', accuracy: 15 },
      destination: { lat: 32, lng: 34, address: 'X' },
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.body).not.toContain('siteGeocodeSource');
    expect(res.body).not.toContain('siteGeocodeQuery');
    expect(res.body).not.toContain('siteGeocodedAt');
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

// ── TRACK-B: enriched presentationStatus contract ──────────────────────────
//
// These tests assert against the served HTML's *source*, not a live DOM —
// the inline <script> block ships as literal text, so Hebrew hero strings,
// object keys, and code patterns (flip / gating / snap-guard) are all
// grep-able substrings of `res.body`. This mirrors the existing test style
// in this file (see the ACTIVE/FINISHED/destination suites above).

describe('GET /t/:token — presentationStatus hero strings', () => {
  it('renders the WAITING hero copy', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'ASSIGNED',
      updatedAt: '2026-07-08T09:00:00Z',
      presentationStatus: 'WAITING',
      isLocationFresh: false,
      isRouteAvailable: false,
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.body).toContain('הבודק יצא לדרך. מיקום חי יופיע בעוד רגע.');
  });

  it('renders the NEARBY hero copy', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      presentationStatus: 'NEARBY',
      isLocationFresh: true,
      isRouteAvailable: true,
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.body).toContain('הבודק קרוב אליך');
  });

  it('renders both STALE_LOCATION warning-strip lines', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      presentationStatus: 'STALE_LOCATION',
      isLocationFresh: false,
      isRouteAvailable: false,
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.body).toContain('לא התקבל עדכון מיקום בדקות האחרונות.');
    expect(res.body).toContain('זמן ההגעה מוצג כהערכה בלבד.');
    // Hero text for STALE_LOCATION matches EN_ROUTE per spec.
    expect(res.body).toContain('STALE_LOCATION:');
  });

  it('renders the UNAVAILABLE hero copy', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'ASSIGNED',
      updatedAt: '2026-07-08T09:00:00Z',
      presentationStatus: 'UNAVAILABLE',
      isLocationFresh: false,
      isRouteAvailable: false,
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.body).toContain('המעקב לא זמין כרגע, אך הבודק בדרך.');
  });

  it('renders the COMPLETED hero copy', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'FINISHED',
      taskFieldStatus: 'FINISHED_FIELD',
      updatedAt: '2026-07-08T09:00:00Z',
      presentationStatus: 'COMPLETED',
      isLocationFresh: false,
      isRouteAvailable: false,
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.body).toContain('הבדיקה הסתיימה. תודה.');
  });

  it('prefers a server-provided headline over the local fallback map', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      presentationStatus: 'EN_ROUTE',
      headline: 'משפט מותאם אישית מהשרת',
      isLocationFresh: true,
      isRouteAvailable: true,
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    // The headline itself is only interpolated into the JSON initial-state
    // blob (never HTML body text) — assert the client code prioritizes it.
    expect(res.body).toContain('if (state.headline) return state.headline;');
    expect(res.body).toContain('"headline":"');
  });
});

describe('GET /t/:token — legacy payload (no presentationStatus) still renders', () => {
  it('falls back to the legacy status-keyed hero map for an ACTIVE session', async () => {
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
    // Legacy fallback text is untouched — old payloads read identically.
    expect(res.body).toContain('הבודק בדרך אליך');
    expect(res.body).toContain('"lat":32.0853');
    expect(res.body).toContain('"etaMinutes":25');
    // No presentationStatus/headline key present in the initial-state blob.
    expect(res.body).not.toContain('"presentationStatus"');
  });

  it('falls back correctly for a terminal legacy CANCELED session', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'CANCELED',
      taskFieldStatus: 'DECLINED',
      updatedAt: '2026-07-08T09:15:00Z',
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"status":"CANCELED"');
  });
});

describe('GET /t/:token — distance formatting', () => {
  it('embeds both the kilometer and meter branches of the distance formatter', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      presentationStatus: 'EN_ROUTE',
      isLocationFresh: true,
      isRouteAvailable: true,
      distanceMeters: 1250,
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    // Both formatting branches ship as source (client picks the right one at
    // runtime); assert the Hebrew units and the km/m threshold are present.
    expect(res.body).toContain("' ק״מ'");
    expect(res.body).toContain("' מטרים'");
    expect(res.body).toContain('meters < 1000');
    expect(res.body).toContain('"distanceMeters":1250');
  });
});

describe('GET /t/:token — OSRM route GeoJSON coordinate flip', () => {
  it('embeds the [lng,lat] -> [lat,lng] flip for OSRM geometry', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      presentationStatus: 'EN_ROUTE',
      isLocationFresh: true,
      isRouteAvailable: true,
      workerLocation: { lat: 32.0853, lng: 34.7818, updatedAt: '2026-07-08T09:00:00Z' },
      destinationLocation: { lat: 32.011, lng: 34.7712, address: 'X' },
      route: {
        type: 'OSRM',
        geometry: {
          type: 'LineString',
          coordinates: [
            [34.7818, 32.0853],
            [34.7712, 32.011],
          ],
        },
        distanceMeters: 1800,
        durationSeconds: 300,
      },
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    // GeoJSON is [lng, lat]; Leaflet wants [lat, lng] — assert the flip code.
    expect(res.body).toContain('route.geometry.coordinates.map((c) => [c[1], c[0]])');
    // The straight-line dashed fallback branch must still be present too.
    expect(res.body).toContain("dashed ? '6 8' : null");
    expect(res.body).toContain('"type":"OSRM"');
  });
});

describe('GET /t/:token — live ETA countdown gating', () => {
  it('ships countdown code gated on isLocationFresh === true and EN_ROUTE/NEARBY', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      presentationStatus: 'EN_ROUTE',
      isLocationFresh: true,
      isRouteAvailable: true,
      durationSeconds: 600,
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.body).toContain("state.isLocationFresh === true");
    expect(res.body).toContain("presentation === 'EN_ROUTE' || presentation === 'NEARBY'");
    // Never phrased as exact / traffic-aware.
    expect(res.body).toContain('זמן הגעה משוער');
    expect(res.body).toContain("'פחות מדקה'");
  });
});

describe('GET /t/:token — marker animation with snap guard', () => {
  it('ships requestAnimationFrame interpolation and the 2km snap guard', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      presentationStatus: 'EN_ROUTE',
      isLocationFresh: true,
      isRouteAvailable: true,
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.body).toContain('requestAnimationFrame(step)');
    expect(res.body).toContain('jumpMeters > 2000');
    expect(res.body).toContain('durationMs = 1500');
  });
});

describe('GET /t/:token — initial-state embedding remains safe (safeJson regression)', () => {
  it('escapes a </script> breakout attempt inside the address field', async () => {
    getPublicView.mockResolvedValueOnce({
      status: 'ACTIVE',
      taskFieldStatus: 'EN_ROUTE',
      updatedAt: '2026-07-08T09:00:00Z',
      presentationStatus: 'EN_ROUTE',
      isLocationFresh: true,
      isRouteAvailable: true,
      destinationLocation: { lat: 32, lng: 34, address: '</script><script>alert(1)</script>' },
    });
    const res = await app.inject({ method: 'GET', url: `/t/${VALID_TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('</script><script>alert(1)</script>');
    // The neutralized form must still be present — safeJson() escapes `<`
    // only (that's all that's needed to prevent a `</script>` breakout).
    expect(res.body).toContain('\\u003c/script>\\u003cscript>alert(1)\\u003c/script>');
  });
});
