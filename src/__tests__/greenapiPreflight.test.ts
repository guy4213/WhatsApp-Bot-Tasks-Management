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
  // Cross-file env leak protection: the "missing credentials" test deletes
  // these; make sure they don't stay deleted for later test files.
  delete process.env.GREENAPI_ID_INSTANCE;
  delete process.env.GREENAPI_API_TOKEN_INSTANCE;
  delete process.env.GREENAPI_API_URL;
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

  // SOFT WARNING — yellowCard means "reduce volume", not "stop". Sends still
  // deliver during yellowCard; blocking here would silence the bot for the
  // ~24h warning window for no benefit. Ops alert (greenapiHealth) already
  // warned Guy separately.
  it('yellowCard + online → allow=true (soft warning, sends still deliver)', async () => {
    global.fetch = mockFetchOk('yellowCard', 'online') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(true);
    expect(r.reason).toContain('yellowCard');
    expect(r.source).toBe('live');
  });

  it('starting + online → allow=true (transient bootup)', async () => {
    global.fetch = mockFetchOk('starting', 'online') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(true);
    expect(r.reason).toContain('starting');
  });

  // HARD BLOCKERS — sends genuinely cannot deliver.
  it('notAuthorized + online → allow=false (QR expired, sends never leave)', async () => {
    global.fetch = mockFetchOk('notAuthorized', 'online') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('stateInstance=notAuthorized');
  });

  it('blocked + online → allow=false (account banned by WhatsApp)', async () => {
    global.fetch = mockFetchOk('blocked', 'online') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('stateInstance=blocked');
  });

  it('sleepMode + online → allow=false (instance stopped)', async () => {
    global.fetch = mockFetchOk('sleepMode', 'online') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('stateInstance=sleepMode');
  });

  // The ACTUAL 2026-07-19 failure mode — socket detached while WhatsApp
  // account is still "authorized". Green API accepts to the 24h queue but the
  // phone will not deliver until the socket returns.
  it('authorized + offline → allow=false, blocks on statusInstance', async () => {
    global.fetch = mockFetchOk('authorized', 'offline') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('statusInstance=offline');
  });

  it('yellowCard + offline → allow=false (offline dominates yellowCard warning)', async () => {
    global.fetch = mockFetchOk('yellowCard', 'offline') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('statusInstance=offline');
  });

  it('unknown state string → normalized to "unknown" → allow=true (fail-open on schema change)', async () => {
    global.fetch = mockFetchOk('garbage', 'online') as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();
    const r = await checkOutboundHealth();
    expect(r.allow).toBe(true);
    expect(r.reason).toContain('unknown');
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

// Prevents the 429 dogpile on deploy: N concurrent callers on cold cache
// must NOT each fire their own live fetch.
describe('single-flight — cold-cache burst is collapsed to one HTTP round-trip', () => {
  it('50 concurrent callers on cold cache → exactly ONE pair of fetches (getState + getStatus)', async () => {
    // Delay each fetch so all 50 callers arrive while the fetch is pending.
    let resolveState: (v: Response) => void;
    let resolveStatus: (v: Response) => void;
    const stateGate  = new Promise<Response>((r) => { resolveState  = r; });
    const statusGate = new Promise<Response>((r) => { resolveStatus = r; });
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/getStateInstance/'))  return stateGate;
      if (u.includes('/getStatusInstance/')) return statusGate;
      return new Response('{}', { status: 404 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { checkOutboundHealth } = await loadFresh();
    // 50 callers all miss the cache and start awaiting the same in-flight fetch.
    const pending = Array.from({ length: 50 }, () => checkOutboundHealth());

    // At this point exactly 2 fetches have been issued (one per endpoint).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Complete the gates and let all 50 resolve.
    resolveState!(new Response(JSON.stringify({ stateInstance: 'authorized' }), { status: 200 }));
    resolveStatus!(new Response(JSON.stringify({ statusInstance: 'online' }), { status: 200 }));

    const results = await Promise.all(pending);
    expect(results).toHaveLength(50);
    for (const r of results) expect(r.allow).toBe(true);
    // Critical: still just 2 fetches. No dogpile.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('after in-flight resolves, NEXT cold-cache burst triggers a new fetch pair', async () => {
    const fetchMock = mockFetchOk('authorized', 'online');
    global.fetch = fetchMock as unknown as typeof fetch;
    const { checkOutboundHealth, __resetPreflightCacheForTests } = await loadFresh();

    // First burst → 2 fetches, cached.
    await Promise.all([checkOutboundHealth(), checkOutboundHealth()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Clear the cache (simulates TTL expiry) and burst again.
    __resetPreflightCacheForTests();
    await Promise.all([checkOutboundHealth(), checkOutboundHealth(), checkOutboundHealth()]);
    // Second cold-cache burst collapses to one more pair — total 4, not 8.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('in-flight rejection is shared: all waiters get fail-open and next call refetches', async () => {
    let rejectState: (e: Error) => void;
    const stateGate = new Promise<Response>((_, r) => { rejectState = r; });
    let statusOk = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/getStateInstance/'))  return stateGate;
      if (u.includes('/getStatusInstance/')) { statusOk++; return new Response(JSON.stringify({ statusInstance: 'online' }), { status: 200 }); }
      return new Response('{}', { status: 404 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { checkOutboundHealth } = await loadFresh();

    const pending = Array.from({ length: 5 }, () => checkOutboundHealth());
    rejectState!(new Error('boom'));
    const results = await Promise.all(pending);
    // Every waiter got the same fail-open answer.
    for (const r of results) {
      expect(r.allow).toBe(true);
      expect(r.source).toBe('check-failed');
    }
    // Only one fetch pair was ever issued for the whole burst.
    expect(statusOk).toBe(1);
  });
});
