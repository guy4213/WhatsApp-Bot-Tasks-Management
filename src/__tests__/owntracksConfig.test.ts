/**
 * Behavioral tests for the provisioning + short-link routes added to
 * `routes/owntracksPoc.ts` (PROV-T4).
 *
 * Covered:
 *  1. GET /owntracks/config/:token — success → exact .otrc shape
 *  2. GET /owntracks/config/:token — consumeProvisioning returns null → 404
 *  3. GET /owntracks/config/:token — consumeProvisioning throws → 500
 *  4. GET /o/:token — happy path → 302 with correct owntracks:// scheme URL
 *  5. GET /o/:token — PUBLIC_BASE_URL missing → 500
 *  6. GET /o/:token — bad token chars → 404
 *  7. POST /owntracks — DB auth path succeeds
 *  8. POST /owntracks — DB miss → ENV fallback succeeds (see note below)
 *  9. POST /owntracks — both paths fail → 401 with WWW-Authenticate
 * 10. POST /owntracks — legacy ENV user regression (see note below)
 *
 * Note on tests 8 & 10:
 *   `USERS = parseUsers(process.env.POC_OWNTRACKS_USERS)` is evaluated ONCE at
 *   module-load time (top-level const in the route file). The only viable
 *   approach in vitest without touching the source file is to use
 *   `vi.isolateModules()` + `vi.doMock()` + dynamic import inside individual
 *   tests so the module reloads with the env already set. Each such test gets
 *   its own Fastify instance built from the freshly-loaded module. This is
 *   confirmed to work in vitest's default (non-threaded) runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
// All mocks must be hoisted so they are in place before any module under test
// is imported at the top level.

const consumeProvisioningMock = vi.hoisted(() => vi.fn());
const verifyWorkerCredentialsMock = vi.hoisted(() => vi.fn());
const resolveWorkerFromKeyMock = vi.hoisted(() => vi.fn());
const upsertLiveLocationMock = vi.hoisted(() => vi.fn());
const bumpSessionLocationMock = vi.hoisted(() => vi.fn());
const poolQueryMock = vi.hoisted(() => vi.fn());

vi.mock('../services/owntracksProvisioning', () => ({
  consumeProvisioning: (...a: unknown[]) => consumeProvisioningMock(...a),
}));

vi.mock('../services/workerLocation', () => ({
  verifyWorkerCredentials: (...a: unknown[]) => verifyWorkerCredentialsMock(...a),
  resolveWorkerFromKey: (...a: unknown[]) => resolveWorkerFromKeyMock(...a),
  upsertLiveLocation: (...a: unknown[]) => upsertLiveLocationMock(...a),
  invalidateWorkerCredentialCache: vi.fn(),
}));

vi.mock('../services/tracking', () => ({
  bumpSessionLocation: (...a: unknown[]) => bumpSessionLocationMock(...a),
}));

vi.mock('../db/connection', () => ({
  pool: { query: (...a: unknown[]) => poolQueryMock(...a) },
  supabaseAdmin: {},
}));

// Import AFTER hoisted mocks are declared.
import { owntracksPocRoutes } from '../routes/owntracksPoc';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(owntracksPocRoutes);
  return app;
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

const ORIG_ENV = { ...process.env };

// ── Common setup / teardown ───────────────────────────────────────────────────

let app: FastifyInstance;

beforeEach(async () => {
  consumeProvisioningMock.mockReset();
  verifyWorkerCredentialsMock.mockReset();
  resolveWorkerFromKeyMock.mockReset();
  upsertLiveLocationMock.mockReset();
  bumpSessionLocationMock.mockReset();
  poolQueryMock.mockReset();

  // Sensible defaults — individual tests override where needed.
  upsertLiveLocationMock.mockResolvedValue(undefined);
  bumpSessionLocationMock.mockResolvedValue(undefined);

  // Pool stubs: empty prev-ping SELECT, then silently accept the INSERT.
  poolQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });

  app = buildApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
  process.env = { ...ORIG_ENV };
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /owntracks/config/:token — success
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /owntracks/config/:token — success', () => {
  it('returns 200 with the exact .otrc shape', async () => {
    consumeProvisioningMock.mockResolvedValueOnce({
      workerKey: 'w_abc',
      password: 'p123',
      trackerId: 'DA',
      hostUrl: 'https://bot.example.com/owntracks',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/owntracks/config/some-valid-token',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);

    const body = res.json();
    expect(body).toEqual({
      _type: 'configuration',
      mode: 3,
      url: 'https://bot.example.com/owntracks',
      auth: true,
      username: 'w_abc',
      password: 'p123',
      tid: 'DA',
      deviceId: 'w_abc',
      monitoring: 1,
      locatorInterval: 15,
      locatorDisplacement: 50,
      pubExtendedData: true,
    });

    expect(consumeProvisioningMock).toHaveBeenCalledWith('some-valid-token');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /owntracks/config/:token — null → 404
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /owntracks/config/:token — token invalid or expired', () => {
  it('returns 404 when consumeProvisioning returns null', async () => {
    consumeProvisioningMock.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'GET',
      url: '/owntracks/config/expired-or-unknown-token',
    });

    expect(res.statusCode).toBe(404);
    expect(consumeProvisioningMock).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /owntracks/config/:token — service throws → 500
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /owntracks/config/:token — service throws', () => {
  it('returns 500 when consumeProvisioning rejects', async () => {
    consumeProvisioningMock.mockRejectedValueOnce(new Error('DB went away'));

    const res = await app.inject({
      method: 'GET',
      url: '/owntracks/config/some-token',
    });

    expect(res.statusCode).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET /o/:token — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /o/:token — happy path', () => {
  it('returns 302 with the owntracks:// scheme URL and Hebrew fallback HTML', async () => {
    process.env.PUBLIC_BASE_URL = 'https://bot.example.com';

    const res = await app.inject({
      method: 'GET',
      url: '/o/AbC_123-XYZ',
    });

    expect(res.statusCode).toBe(302);

    const expectedLocation =
      'owntracks:///config?url=' +
      encodeURIComponent('https://bot.example.com/owntracks/config/AbC_123-XYZ');
    expect(res.headers['location']).toBe(expectedLocation);

    // Verify the location header encodes correctly.
    expect(expectedLocation).toBe(
      'owntracks:///config?url=https%3A%2F%2Fbot.example.com%2Fowntracks%2Fconfig%2FAbC_123-XYZ',
    );

    // Body should contain Hebrew fallback HTML.
    expect(res.body).toContain('OwnTracks');
    // Hebrew text exists in the HTML body.
    expect(res.body).toContain('לפתיחת ההגדרות');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. GET /o/:token — PUBLIC_BASE_URL missing → 500
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /o/:token — PUBLIC_BASE_URL missing', () => {
  it('returns 500 when PUBLIC_BASE_URL env var is not set', async () => {
    delete process.env.PUBLIC_BASE_URL;

    const res = await app.inject({
      method: 'GET',
      url: '/o/validtoken123',
    });

    expect(res.statusCode).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. GET /o/:token — bad token chars → 404
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /o/:token — bad token chars', () => {
  it('returns 404 for a token containing invalid characters', async () => {
    process.env.PUBLIC_BASE_URL = 'https://bot.example.com';

    // 'bad!token' — '!' is not in [A-Za-z0-9_-]
    // URL-encode the '!' so Fastify can route it as a param value.
    const res = await app.inject({
      method: 'GET',
      url: '/o/bad%21token',
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a token that is too long (> 128 chars)', async () => {
    process.env.PUBLIC_BASE_URL = 'https://bot.example.com';

    const longToken = 'a'.repeat(129);
    const res = await app.inject({
      method: 'GET',
      url: `/o/${longToken}`,
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. POST /owntracks — DB auth path succeeds
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /owntracks — DB auth path succeeds', () => {
  it('accepts a location post when verifyWorkerCredentials returns a hit', async () => {
    // DB auth returns success.
    verifyWorkerCredentialsMock.mockResolvedValueOnce({ workerUserId: 'u1' });
    // resolveWorkerFromKey used in the live-tracking fan-out.
    resolveWorkerFromKeyMock.mockResolvedValueOnce('u1');
    // pool.query: prev-ping SELECT (empty) then INSERT (accepted).
    poolQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await app.inject({
      method: 'POST',
      url: '/owntracks',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth('newuser', 'goodpass'),
      },
      payload: JSON.stringify({
        _type: 'location',
        lat: 32.08,
        lon: 34.78,
        tst: 1700000000,
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(verifyWorkerCredentialsMock).toHaveBeenCalledWith('newuser', 'goodpass');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. POST /owntracks — both auth paths fail → 401
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /owntracks — both auth paths fail', () => {
  it('returns 401 with WWW-Authenticate when DB misses and ENV has no entry', async () => {
    // DB auth returns null (no match).
    verifyWorkerCredentialsMock.mockResolvedValueOnce(null);
    // POC_OWNTRACKS_USERS is not set (or the user is not listed).
    delete process.env.POC_OWNTRACKS_USERS;

    const res = await app.inject({
      method: 'POST',
      url: '/owntracks',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth('ghost', 'wrongpass'),
      },
      payload: JSON.stringify({ _type: 'location', lat: 32.08, lon: 34.78 }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Basic realm/);
  });

  it('returns 401 when no Authorization header at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/owntracks',
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify({ _type: 'location', lat: 32.08, lon: 34.78 }),
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Basic realm/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 & 10. ENV fallback path — requires module to reload with env pre-set
//
// `USERS = parseUsers(process.env.POC_OWNTRACKS_USERS)` executes once at module
// load. To test the legacy ENV path we must:
//   a) set POC_OWNTRACKS_USERS BEFORE the route module loads, and
//   b) register `verifyWorkerCredentials` to return null so the DB path misses.
//
// We achieve this via vi.isolateModules() + vi.doMock() + dynamic import inside
// each test so the route module reloads fresh with the env already in place.
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /owntracks — ENV fallback (module-reload isolation)', () => {
  // Strategy: `vi.resetModules()` clears the module registry so the next
  // dynamic import picks up the current process.env — including
  // POC_OWNTRACKS_USERS — as if the module is loading for the first time.
  // `vi.doMock()` (not `vi.mock()`) registers mock factories that are applied
  // to subsequent dynamic imports without hoisting.

  it('test 8: DB miss → ENV fallback succeeds for a matching legacy user', async () => {
    process.env.POC_OWNTRACKS_USERS = 'legacy:pw';

    const localVerifyMock = vi.fn().mockResolvedValueOnce(null); // DB miss

    vi.doMock('../services/workerLocation', () => ({
      verifyWorkerCredentials: (...a: unknown[]) => localVerifyMock(...a),
      resolveWorkerFromKey: vi.fn().mockResolvedValue(null),
      upsertLiveLocation: vi.fn().mockResolvedValue(undefined),
      invalidateWorkerCredentialCache: vi.fn(),
    }));
    vi.doMock('../services/owntracksProvisioning', () => ({
      consumeProvisioning: vi.fn(),
    }));
    vi.doMock('../services/tracking', () => ({
      bumpSessionLocation: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../db/connection', () => ({
      pool: {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      },
      supabaseAdmin: {},
    }));

    // Reset the module registry so the next import sees the freshly-set env.
    vi.resetModules();

    // Dynamic import picks up the env + doMocks set above.
    const { owntracksPocRoutes: freshRoutes } = await import('../routes/owntracksPoc');

    const localApp = Fastify({ logger: false });
    localApp.register(freshRoutes);
    await localApp.ready();

    const res = await localApp.inject({
      method: 'POST',
      url: '/owntracks',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth('legacy', 'pw'),
      },
      payload: JSON.stringify({ _type: 'location', lat: 32.08, lon: 34.78 }),
    });

    await localApp.close();
    vi.resetModules(); // clean up so next tests re-use the top-level imports

    expect(res.statusCode).toBe(200);
    expect(localVerifyMock).toHaveBeenCalledWith('legacy', 'pw');
  });

  it('test 10: legacy POC user (guy) keeps working via ENV when DB returns null', async () => {
    process.env.POC_OWNTRACKS_USERS = 'guy:secret1';

    const localVerifyMock = vi.fn().mockResolvedValueOnce(null); // guy has no DB passwordHash

    vi.doMock('../services/workerLocation', () => ({
      verifyWorkerCredentials: (...a: unknown[]) => localVerifyMock(...a),
      resolveWorkerFromKey: vi.fn().mockResolvedValue(null),
      upsertLiveLocation: vi.fn().mockResolvedValue(undefined),
      invalidateWorkerCredentialCache: vi.fn(),
    }));
    vi.doMock('../services/owntracksProvisioning', () => ({
      consumeProvisioning: vi.fn(),
    }));
    vi.doMock('../services/tracking', () => ({
      bumpSessionLocation: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../db/connection', () => ({
      pool: {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      },
      supabaseAdmin: {},
    }));

    vi.resetModules();

    const { owntracksPocRoutes: freshRoutes } = await import('../routes/owntracksPoc');

    const localApp = Fastify({ logger: false });
    localApp.register(freshRoutes);
    await localApp.ready();

    const res = await localApp.inject({
      method: 'POST',
      url: '/owntracks',
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth('guy', 'secret1'),
      },
      payload: JSON.stringify({ _type: 'location', lat: 32.08, lon: 34.78 }),
    });

    await localApp.close();
    vi.resetModules(); // clean up

    // The whole regression point: guy authenticates via the ENV allowlist
    // even when the DB path (verifyWorkerCredentials) returns null.
    expect(res.statusCode).toBe(200);
    expect(localVerifyMock).toHaveBeenCalledWith('guy', 'secret1');
  });
});
