/**
 * D5-T2 — voice inbound pipeline tests.
 *
 * Coverage:
 *  - transcribeWithWhisper — success path (URL, headers, multipart fields);
 *    non-2xx throws.
 *  - downloadWhatsappAudio — two-step Meta download shape.
 *  - handleVoiceMessage    — happy path persists to WhatsappAuditLog and
 *    returns the transcript; download failure / transcription failure /
 *    missing OPENAI_API_KEY all return null (never throw).
 *  - Integration-lite: the webhook `type==='audio'` branch feeds the transcript
 *    back through the shared text-routing path (or the fallback reply on null).
 */

// Env vars used by voice.ts must be set BEFORE the module is first imported —
// the Meta token and API version are cached at module load time (mirrors
// sender.ts). vitest.setup.ts runs before this file, so these overrides win.
process.env.WHATSAPP_ACCESS_TOKEN = 'wa-token-xyz';
process.env.WHATSAPP_API_VERSION = 'v19.0';

import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── https.request stub — one shared queue of fake responses per test ────────

interface FakeResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: Buffer | string;
}

interface RecordedRequest {
  hostname?: string;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body: Buffer;
}

let responseQueue: FakeResponse[] = [];
let recordedRequests: RecordedRequest[] = [];

vi.mock('https', () => {
  return {
    default: {
      request(
        options: Record<string, unknown>,
        cb: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void,
      ) {
        const chunks: Buffer[] = [];
        const req = new EventEmitter() as EventEmitter & {
          write: (b: Buffer | string) => void;
          end: () => void;
          setTimeout: (ms: number, fn: () => void) => void;
          destroy: (err: Error) => void;
        };
        req.write = (b) => { chunks.push(typeof b === 'string' ? Buffer.from(b) : b); };
        req.setTimeout = () => { /* no-op in tests */ };
        req.destroy = () => { /* no-op */ };
        req.end = () => {
          const bodyBuf = Buffer.concat(chunks);
          recordedRequests.push({
            hostname: options.hostname as string | undefined,
            path: options.path as string | undefined,
            method: options.method as string | undefined,
            headers: options.headers as Record<string, string> | undefined,
            body: bodyBuf,
          });
          setImmediate(() => {
            const next = responseQueue.shift();
            if (!next) throw new Error('https.request stub: response queue empty');
            const res = new EventEmitter() as EventEmitter & {
              statusCode: number;
              headers: Record<string, string>;
            };
            res.statusCode = next.statusCode;
            res.headers = next.headers ?? {};
            cb(res);
            setImmediate(() => {
              const bodyBuf2 = typeof next.body === 'string' ? Buffer.from(next.body) : next.body;
              res.emit('data', bodyBuf2);
              res.emit('end');
            });
          });
        };
        return req;
      },
    },
  };
});

vi.mock('../utils/auditLog', () => ({
  writeAuditLog: vi.fn().mockResolvedValue('audit-log-id-1'),
  updateTranscribedMessage: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function enqueueResponse(res: FakeResponse): void {
  responseQueue.push(res);
}

function resetHttp(): void {
  responseQueue = [];
  recordedRequests = [];
}

// Parse a very small subset of multipart/form-data — enough to assert the
// fields Whisper receives.
function parseMultipart(body: Buffer, contentType: string): Record<string, string> {
  const m = contentType.match(/boundary=(.+)$/);
  if (!m) throw new Error(`no boundary in content-type: ${contentType}`);
  const boundary = m[1];
  const text = body.toString('binary');
  const parts = text.split(`--${boundary}`);
  const out: Record<string, string> = {};
  for (const p of parts) {
    const nameMatch = p.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const idx = p.indexOf('\r\n\r\n');
    if (idx < 0) continue;
    const value = p.slice(idx + 4).replace(/\r\n$/, '');
    out[nameMatch[1]] = value;
  }
  return out;
}

// ── transcribeWithWhisper ───────────────────────────────────────────────────

describe('transcribeWithWhisper', () => {
  beforeEach(() => {
    resetHttp();
    process.env.OPENAI_API_KEY = 'sk-test-abc';
  });
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it('POSTs to the Whisper endpoint with the correct headers and multipart fields, and returns the response text', async () => {
    enqueueResponse({ statusCode: 200, body: 'שלום עולם\n' });

    const { transcribeWithWhisper } = await import('../whatsapp/voice');
    const transcript = await transcribeWithWhisper({
      buffer: Buffer.from('fakeaudio'),
      mimeType: 'audio/ogg',
    });

    expect(transcript).toBe('שלום עולם');
    expect(recordedRequests).toHaveLength(1);
    const req = recordedRequests[0];
    expect(req.method).toBe('POST');
    expect(req.hostname).toBe('api.openai.com');
    expect(req.path).toBe('/v1/audio/transcriptions');
    expect(req.headers?.Authorization).toBe('Bearer sk-test-abc');
    expect(req.headers?.['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);

    const fields = parseMultipart(req.body, req.headers?.['Content-Type'] ?? '');
    expect(fields.model).toBe('whisper-1');
    expect(fields.language).toBe('he');
    expect(fields.response_format).toBe('text');
    expect(fields.file).toBe('fakeaudio');
  });

  it('throws with the response body on a non-2xx response', async () => {
    enqueueResponse({ statusCode: 401, body: '{"error":"invalid api key"}' });

    const { transcribeWithWhisper } = await import('../whatsapp/voice');
    await expect(
      transcribeWithWhisper({ buffer: Buffer.from('x'), mimeType: 'audio/ogg' }),
    ).rejects.toThrow(/Whisper API error 401/);
  });

  it('throws when OPENAI_API_KEY is not set', async () => {
    delete process.env.OPENAI_API_KEY;
    const { transcribeWithWhisper } = await import('../whatsapp/voice');
    await expect(
      transcribeWithWhisper({ buffer: Buffer.from('x'), mimeType: 'audio/ogg' }),
    ).rejects.toThrow(/OPENAI_API_KEY is not set/);
  });
});

// ── downloadWhatsappAudio ───────────────────────────────────────────────────

describe('downloadWhatsappAudio', () => {
  beforeEach(() => {
    resetHttp();
  });

  it('follows the Meta two-step download and returns buffer + mime', async () => {
    enqueueResponse({
      statusCode: 200,
      body: JSON.stringify({ url: 'https://lookaside.fbsbx.com/media/abc' }),
    });
    enqueueResponse({
      statusCode: 200,
      headers: { 'content-type': 'audio/ogg; codecs=opus' },
      body: Buffer.from('AUDIOBYTES'),
    });

    const { downloadWhatsappAudio } = await import('../whatsapp/voice');
    const res = await downloadWhatsappAudio('MEDIA_123');

    expect(res.buffer.toString()).toBe('AUDIOBYTES');
    expect(res.mimeType).toMatch(/^audio\/ogg/);
    expect(recordedRequests).toHaveLength(2);
    expect(recordedRequests[0].hostname).toBe('graph.facebook.com');
    expect(recordedRequests[0].path).toContain('/MEDIA_123');
    expect(recordedRequests[0].headers?.Authorization).toBe('Bearer wa-token-xyz');
    expect(recordedRequests[1].hostname).toBe('lookaside.fbsbx.com');
    expect(recordedRequests[1].headers?.Authorization).toBe('Bearer wa-token-xyz');
  });
});

// ── handleVoiceMessage ──────────────────────────────────────────────────────

describe('handleVoiceMessage', () => {
  beforeEach(() => {
    resetHttp();
    process.env.OPENAI_API_KEY = 'sk-test-abc';
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it('downloads, transcribes, persists to audit log, and returns the transcript', async () => {
    enqueueResponse({ statusCode: 200, body: JSON.stringify({ url: 'https://lookaside.fbsbx.com/media/x' }) });
    enqueueResponse({ statusCode: 200, headers: { 'content-type': 'audio/ogg' }, body: Buffer.from('BYTES') });
    enqueueResponse({ statusCode: 200, body: 'איפה אני?' });

    const { handleVoiceMessage } = await import('../whatsapp/voice');
    const auditMod = await import('../utils/auditLog');

    const transcript = await handleVoiceMessage({
      mediaId: 'M1',
      from: '972500000001',
      auditLogId: 'audit-1',
    });

    expect(transcript).toBe('איפה אני?');
    expect(auditMod.updateTranscribedMessage).toHaveBeenCalledWith('audit-1', 'איפה אני?');
  });

  it('returns null and does not touch the network when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    const { handleVoiceMessage } = await import('../whatsapp/voice');
    const auditMod = await import('../utils/auditLog');

    const res = await handleVoiceMessage({ mediaId: 'M1', from: '972500000001', auditLogId: 'a' });
    expect(res).toBeNull();
    expect(recordedRequests).toHaveLength(0);
    expect(auditMod.updateTranscribedMessage).not.toHaveBeenCalled();
  });

  it('returns null when the media download fails', async () => {
    enqueueResponse({ statusCode: 500, body: 'oops' });
    const { handleVoiceMessage } = await import('../whatsapp/voice');
    const auditMod = await import('../utils/auditLog');

    const res = await handleVoiceMessage({ mediaId: 'M1', from: '972500000001', auditLogId: 'a' });
    expect(res).toBeNull();
    expect(auditMod.updateTranscribedMessage).not.toHaveBeenCalled();
  });

  it('returns null when Whisper returns non-2xx', async () => {
    enqueueResponse({ statusCode: 200, body: JSON.stringify({ url: 'https://cdn.example/m' }) });
    enqueueResponse({ statusCode: 200, headers: { 'content-type': 'audio/ogg' }, body: Buffer.from('B') });
    enqueueResponse({ statusCode: 429, body: 'rate limited' });

    const { handleVoiceMessage } = await import('../whatsapp/voice');
    const auditMod = await import('../utils/auditLog');

    const res = await handleVoiceMessage({ mediaId: 'M1', from: '972500000001', auditLogId: 'a' });
    expect(res).toBeNull();
    expect(auditMod.updateTranscribedMessage).not.toHaveBeenCalled();
  });

  it('skips the audit-log update when no auditLogId is provided', async () => {
    enqueueResponse({ statusCode: 200, body: JSON.stringify({ url: 'https://cdn.example/m' }) });
    enqueueResponse({ statusCode: 200, headers: { 'content-type': 'audio/ogg' }, body: Buffer.from('B') });
    enqueueResponse({ statusCode: 200, body: 'ok' });

    const { handleVoiceMessage } = await import('../whatsapp/voice');
    const auditMod = await import('../utils/auditLog');

    const res = await handleVoiceMessage({ mediaId: 'M1', from: '972500000001' });
    expect(res).toBe('ok');
    expect(auditMod.updateTranscribedMessage).not.toHaveBeenCalled();
  });
});

// ── Integration-lite: webhook.processInbound audio branch ───────────────────
// These tests use vi.doMock so the sender + voice modules are stubbed AT the
// dynamic-import point inside processInbound (which imports them lazily via
// `await import(...)`). We assert that the audio branch pipes the transcript
// into handleIncomingMessage (observed via rate-limiter → text response) or
// sends the fallback message on failure.

describe('webhook audio branch → handleVoiceMessage → text-routing / fallback', () => {
  const sendTextMock = vi.fn().mockResolvedValue(undefined);
  const handleVoiceMock = vi.fn();
  const resolveUserMock = vi.fn();

  beforeEach(() => {
    resetHttp();
    sendTextMock.mockClear();
    handleVoiceMock.mockReset();
    resolveUserMock.mockReset();

    vi.doMock('../whatsapp/sender', () => ({
      sendTextMessage: sendTextMock,
    }));
    vi.doMock('../whatsapp/voice', () => ({
      handleVoiceMessage: handleVoiceMock,
    }));
    // handleIncomingMessage resolves the user; short-circuit at that point
    // with a non-ok result so the flow ends predictably.
    vi.doMock('../auth/userResolver', () => ({
      resolveUserByPhone: resolveUserMock.mockResolvedValue({ ok: false, reason: 'UNKNOWN_PHONE' }),
    }));
    vi.doMock('../services/inboundQueue', () => ({
      enqueueInbound: vi.fn(),
      markDone: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
      claimPending: vi.fn().mockResolvedValue([]),
    }));
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../whatsapp/sender');
    vi.doUnmock('../whatsapp/voice');
    vi.doUnmock('../auth/userResolver');
    vi.doUnmock('../services/inboundQueue');
  });

  it('on successful transcription, forwards the transcript through the text-routing path (observed via resolveUserByPhone)', async () => {
    handleVoiceMock.mockResolvedValue('סיימתי בדיקה');

    const { processInbound } = await import('../routes/webhook');
    await processInbound({
      msgId: '__fallback__voice-msg-1',
      fromPhone: '972500000001',
      payload: { id: 'v1', type: 'audio', audio: { id: 'MEDIA_XYZ' } },
    });

    expect(handleVoiceMock).toHaveBeenCalledTimes(1);
    expect(handleVoiceMock.mock.calls[0][0]).toMatchObject({
      mediaId: 'MEDIA_XYZ',
      from: '972500000001',
    });
    // The transcript flowed into handleIncomingMessage → resolveUserByPhone.
    expect(resolveUserMock).toHaveBeenCalledWith('972500000001');
  });

  it('on null transcript, sends the fallback "voice transcription failed" reply and does NOT invoke text-routing', async () => {
    handleVoiceMock.mockResolvedValue(null);

    const { processInbound } = await import('../routes/webhook');
    await processInbound({
      msgId: '__fallback__voice-msg-2',
      fromPhone: '972500000001',
      payload: { id: 'v2', type: 'audio', audio: { id: 'MEDIA_XYZ' } },
    });

    expect(handleVoiceMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '972500000001',
        text: 'לא הצלחתי להבין את ההודעה הקולית, אנא נסה שוב או שלח טקסט',
      }),
    );
    expect(resolveUserMock).not.toHaveBeenCalled();
  });
});
