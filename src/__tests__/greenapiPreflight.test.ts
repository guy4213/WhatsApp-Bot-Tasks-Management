/**
 * Green API outbound preflight (`checkOutboundHealth`) — decision logic +
 * fail-open + cache TTL.
 *
 * Guards against the 2026-07-19 incident: `/sendMessage` returns 200 even when
 * the phone is offline, so the bot must consult `getStateInstance` +
 * `getStatusInstance` first. `global.fetch` is mocked; the module is loaded
 * dynamically per-test so the module-scoped snapshot cache starts fresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadFresh() {
  vi.resetModules();
  return await import('../services/greenapiPreflight');
}

/** Build a mock fetch that returns the given state + status bodies. */
function mockFetchOk(state: string, status: string) {
  return vi.fn(async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/getStateInstance/')) {
      return new Response(JSON.stringify({ stateInstance: state }), { status: 200 });
    }
    if (u.includes('/getStatusInstance/')) {
      return new Response(JSON.stringify({ statusInstance: status }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
}

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.GREENAPI_ID_INSTANCE        = '1101000001';
  process.env.GREENAPI_API_TOKEN_INSTANCE = 'TOKEN123';
  process.env.GREENAPI_API_URL            = 'https://api.green-api.com';
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('decide()', () => {
  it('authorized + online → allow=true, source=live', async () => {
    global.fetch = mockFetchOk('authorized', 'online') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(true);
    expect(r.source).toBe('live');
    expect(r.reason).toContain('authorized');
  });

  it('yellowCard + online → allow=false, blocks on stateInstance', async () => {
    global.fetch = mockFetchOk('yellowCard', 'online') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('stateInstance=yellowCard');
    expect(r.source).toBe('live');
  });

  it('notAuthorized + online → allow=false', async () => {
    global.fetch = mockFetchOk('notAuthorized', 'online') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('stateInstance=notAuthorized');
  });

  // The 2026-07-19 failure mode.
  it('authorized + offline → allow=false, blocks on statusInstance', async () => {
    global.fetch = mockFetchOk('authorized', 'offline') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('statusInstance=offline');
  });

  it('unknown state string → normalized to "unknown" → blocks', async () => {
    global.fetch = mockFetchOk('garbage', 'online') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('stateInstance=unknown');
  });
});

describe('fail-open — check itself failed (allow=true, source="check-failed")', () => {
  it('fetch throws (network error) → allow=true, marked check-failed', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(true);
    expect(r.source).toBe('check-failed');
    expect(r.reason).toContain('check_failed');
  });

  it('non-2xx (e.g. 500) → treated as check-failed → allow=true', async () => {
    global.fetch = vi.fn(async () => new Response('err', { status: 500 })) as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(true);
    expect(r.source).toBe('check-failed');
  });

  it('missing credentials → check-failed → allow=true', async () => {
    delete process.env.GREENAPI_ID_INSTANCE;
    delete process.env.GREENAPI_API_TOKEN_INSTANCE;
    global.fetch = vi.fn(async () => new Response('should not be called', { status: 200 })) as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(true);
    expect(r.source).toBe('check-failed');
    expect(r.reason).toContain('missing');
  });

  // Critical asymmetry the review flagged: "authorized+offline" is NOT the
  // same as "check failed". The former is a definitive negative signal.
  it('a definitive negative signal is NEVER downgraded to fail-open', async () => {
    global.fetch = mockFetchOk('authorized', 'offline') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(false); // NOT true — the phone is genuinely offline.
    expect(r.source).not.toBe('check-failed');
  });
});

describe('cache TTL', () => {
  it('two consecutive calls → single live fetch pair, second answer from cache', async () => {
    const fetchMock = mockFetchOk('authorized', 'online');
    global.fetch = fetchMock as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();

    const first  = await checkOutboundHealth();
    const second = await checkOutboundHealth();
    expect(first.source).toBe('live');
    expect(second.source).toBe('cache');
    // 2 endpoints × 1 live call = 2 fetches total.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('__resetPreflightCacheForTests clears the cache → next call refetches', async () => {
    const fetchMock = mockFetchOk('authorized', 'online');
    global.fetch = fetchMock as unknown as typeof fetch;
    const { checkOutboundHealth, __resetPreflightCacheForTests } = await loadFresh();

    await checkOutboundHealth();
    __resetPreflightCacheForTests();
    const after = await checkOutboundHealth();
    expect(after.source).toBe('live');
    expect(fetchMock).toHaveBeenCalledTimes(4); // 2 × 2 endpoints
  });
});
