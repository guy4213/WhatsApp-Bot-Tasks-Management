/**
 * HTTP-contract tests for routes/voiceAssistant.ts — the /voice surface.
 * voiceAccess + voiceTools are mocked (same style as trackingRoute.test.ts);
 * asserted here: token gating, kill switch, ephemeral-mint proxying, and the
 * tool-execution passthrough.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const resolveVoiceToken = vi.fn();
const auditVoiceToolCall = vi.fn();
const createVoiceToken = vi.fn();
vi.mock('../services/voiceAccess', () => ({
  resolveVoiceToken: (...a: unknown[]) => resolveVoiceToken(...a),
  auditVoiceToolCall: (...a: unknown[]) => auditVoiceToolCall(...a),
  createVoiceToken: (...a: unknown[]) => createVoiceToken(...a),
  revokeVoiceTokens: vi.fn(),
}));

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...a: unknown[]) => poolQuery(...a) },
  supabaseAdmin: {},
}));

vi.mock('../services/owntracksProvisioning', () => ({
  getPublicBaseUrl: () => 'https://bot.example.com',
  createProvisioning: vi.fn(),
}));

const executeVoiceTool = vi.fn();
vi.mock('../services/voiceTools', () => ({
  buildOpenAiTools: () => [{ type: 'function', name: 'get_my_inspections', description: 'x', parameters: {} }],
  listToolNames: () => ['get_my_inspections'],
  executeVoiceTool: (...a: unknown[]) => executeVoiceTool(...a),
}));

// Import AFTER the mocks so the plugin picks them up.
import { voiceAssistantRoutes } from '../routes/voiceAssistant';

const workerUser = {
  id: 'w1', name: 'דני', phone: '972501111111', role: 'TECHNICIAN',
  isElevated: false, canViewAllRecords: false, canManageUsers: false,
  canManagePermissions: false,
};

let app: FastifyInstance;

beforeEach(async () => {
  resolveVoiceToken.mockReset();
  executeVoiceTool.mockReset();
  createVoiceToken.mockReset();
  poolQuery.mockReset();
  delete process.env.VOICE_ASSISTANT_ENABLED;
  delete process.env.VOICE_LINK_SECRET;
  process.env.OPENAI_API_KEY = 'sk-test';
  app = Fastify();
  await app.register(voiceAssistantRoutes);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('kill switch', () => {
  it('VOICE_ASSISTANT_ENABLED=false hides every route', async () => {
    process.env.VOICE_ASSISTANT_ENABLED = 'false';
    expect((await app.inject({ method: 'GET', url: '/voice' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/voice/session', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/voice/tool', payload: {} })).statusCode).toBe(404);
  });
});

describe('GET /voice', () => {
  it('serves the Hebrew RTL page with no-store', async () => {
    const res = await app.inject({ method: 'GET', url: '/voice' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('dir="rtl"');
    expect(res.body).toContain('גלי');
    // PWA wiring: manifest link + theme color + apple title
    expect(res.body).toContain('rel="manifest"');
    expect(res.body).toContain('#6aa84f');
    expect(res.body).toContain('apple-mobile-web-app-title');
  });
});

describe('GET /voice/manifest.webmanifest', () => {
  it('returns an installable standalone PWA manifest that keeps the token in start_url', async () => {
    const res = await app.inject({
      method: 'GET', url: '/voice/manifest.webmanifest?u=SECRETTOKEN',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/manifest+json');
    const m = res.json();
    expect(m.short_name).toBe('גלי');
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/voice?u=SECRETTOKEN');
    expect(m.theme_color).toBe('#6aa84f');
    expect(m.icons.length).toBeGreaterThanOrEqual(2);
    expect(m.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
  });

  it('404s under the kill switch', async () => {
    process.env.VOICE_ASSISTANT_ENABLED = 'false';
    const res = await app.inject({ method: 'GET', url: '/voice/manifest.webmanifest' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /voice/session', () => {
  it('401 with a Hebrew message when the token is invalid', async () => {
    resolveVoiceToken.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: 'POST', url: '/voice/session', payload: { token: 'bad' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain('הקישור');
  });

  it('mints an ephemeral secret and returns user + tools', async () => {
    resolveVoiceToken.mockResolvedValueOnce(workerUser);
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: 'ek_test_123', expires_at: 1234567 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.inject({
      method: 'POST', url: '/voice/session', payload: { token: 'good-token' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.client_secret).toBe('ek_test_123');
    expect(body.user.name).toBe('דני');
    expect(body.tools).toContain('get_my_inspections');

    // The mint call carried the Hebrew persona + the user's tools.
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/realtime/client_secrets');
    const sent = JSON.parse(init.body);
    expect(sent.session.type).toBe('realtime');
    expect(sent.session.instructions).toContain('גלי');
    expect(sent.session.instructions).toContain('דני');
    expect(sent.session.tools[0].name).toBe('get_my_inspections');
  });

  it('502 with a Hebrew message when OpenAI minting fails', async () => {
    resolveVoiceToken.mockResolvedValueOnce(workerUser);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401,
      json: async () => ({ error: { message: 'bad key' } }),
    }));
    const res = await app.inject({
      method: 'POST', url: '/voice/session', payload: { token: 'good-token' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBeTruthy();
  });
});

describe('POST /voice/tool', () => {
  it('401 when the token is invalid', async () => {
    resolveVoiceToken.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: 'POST', url: '/voice/tool',
      payload: { token: 'bad', name: 'get_my_inspections', args: {} },
    });
    expect(res.statusCode).toBe(401);
    expect(executeVoiceTool).not.toHaveBeenCalled();
  });

  it('400 when the tool name is missing', async () => {
    resolveVoiceToken.mockResolvedValueOnce(workerUser);
    const res = await app.inject({
      method: 'POST', url: '/voice/tool', payload: { token: 'good', args: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('executes the tool as the resolved user and returns its result verbatim', async () => {
    resolveVoiceToken.mockResolvedValueOnce(workerUser);
    executeVoiceTool.mockResolvedValueOnce({ ok: true, speak: 'יש 3 בדיקות היום.' });
    const res = await app.inject({
      method: 'POST', url: '/voice/tool',
      payload: { token: 'good', name: 'get_my_inspections', args: { when: 'היום' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, speak: 'יש 3 בדיקות היום.' });
    expect(executeVoiceTool).toHaveBeenCalledWith(
      workerUser, 'get_my_inspections', { when: 'היום' },
    );
  });
});

describe('POST /voice/link (server-to-server, CRM button)', () => {
  const SECRET = 'shared-secret-abc';

  it('503 when VOICE_LINK_SECRET is not configured', async () => {
    const res = await app.inject({
      method: 'POST', url: '/voice/link', payload: { userId: 'u1' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('401 when the shared secret header is missing or wrong', async () => {
    process.env.VOICE_LINK_SECRET = SECRET;
    const noHeader = await app.inject({
      method: 'POST', url: '/voice/link', payload: { userId: 'u1' },
    });
    expect(noHeader.statusCode).toBe(401);

    const wrong = await app.inject({
      method: 'POST', url: '/voice/link',
      headers: { 'x-voice-link-secret': 'nope-wrong-length' },
      payload: { userId: 'u1' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(createVoiceToken).not.toHaveBeenCalled();
  });

  it('404 for an unknown user (no token minted)', async () => {
    process.env.VOICE_LINK_SECRET = SECRET;
    poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // User lookup
    const res = await app.inject({
      method: 'POST', url: '/voice/link',
      headers: { 'x-voice-link-secret': SECRET },
      payload: { userId: 'ghost' },
    });
    expect(res.statusCode).toBe(404);
    expect(createVoiceToken).not.toHaveBeenCalled();
  });

  it('mints a link for a valid user and returns a ready /voice URL', async () => {
    process.env.VOICE_LINK_SECRET = SECRET;
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'u1', name: 'אורי', status: 'ACTIVE' }], rowCount: 1 }) // User
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // revoke prior CRM tokens
    createVoiceToken.mockResolvedValueOnce({ token: 'FRESHTOKEN', expiresAt: new Date() });

    const res = await app.inject({
      method: 'POST', url: '/voice/link',
      headers: { 'x-voice-link-secret': SECRET },
      payload: { userId: 'u1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toBe('https://bot.example.com/voice?u=FRESHTOKEN');
    expect(body.name).toBe('אורי');
    expect(createVoiceToken).toHaveBeenCalledWith('u1', { label: 'CRM' });
  });

  it('403 for an inactive user', async () => {
    process.env.VOICE_LINK_SECRET = SECRET;
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', name: 'אורי', status: 'INACTIVE' }], rowCount: 1 });
    const res = await app.inject({
      method: 'POST', url: '/voice/link',
      headers: { 'x-voice-link-secret': SECRET },
      payload: { userId: 'u1' },
    });
    expect(res.statusCode).toBe(403);
    expect(createVoiceToken).not.toHaveBeenCalled();
  });
});
