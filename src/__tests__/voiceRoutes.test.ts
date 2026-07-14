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
vi.mock('../services/voiceAccess', () => ({
  resolveVoiceToken: (...a: unknown[]) => resolveVoiceToken(...a),
  auditVoiceToolCall: (...a: unknown[]) => auditVoiceToolCall(...a),
  createVoiceToken: vi.fn(),
  revokeVoiceTokens: vi.fn(),
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
  delete process.env.VOICE_ASSISTANT_ENABLED;
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
