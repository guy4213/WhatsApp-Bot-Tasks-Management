/**
 * Green API provider (PR#2) — transport-layer behavior.
 *
 * Covers: chatId + URL construction, idMessage parsing, the numbered-text
 * rendering of buttons/lists with the PendingChoice mapping persisted, the
 * shared retry loop, and the DLQ write on a permanent failure. https and the DB
 * pool are mocked (nothing leaves the process); PendingChoice is mocked so we
 * assert the mapping WITHOUT a DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// Credentials must exist BEFORE the provider module is imported (read at load).
vi.hoisted(() => {
  process.env.GREENAPI_ID_INSTANCE = '1101000001';
  process.env.GREENAPI_API_TOKEN_INSTANCE = 'TOKEN123';
  process.env.GREENAPI_API_URL = 'https://api.green-api.com';
});

// Capture PendingChoice writes (no DB).
const savePendingChoice = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/pendingChoice', () => ({
  savePendingChoice: (...a: unknown[]) => savePendingChoice(...a),
  resolvePendingChoice: vi.fn(),
  PENDING_CHOICE_TTL_MINUTES: 60,
}));

// Capture DLQ writes (no DB).
const poolQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
vi.mock('../db/connection', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));

// Mock the outbound preflight — these tests exercise transport-layer behavior
// (URL building, retries, DLQ) and should not do real health calls to Green API.
// A dedicated test file (greenapiPreflight.test.ts) covers the preflight itself.
vi.mock('../services/greenapiPreflight', () => ({
  checkOutboundHealth: vi.fn().mockResolvedValue({ allow: true, reason: 'test', source: 'cache' }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastOpts: any = null;
let lastBody = '';
const requestMock = vi.fn();
vi.mock('https', () => ({
  default: { request: (...a: unknown[]) => requestMock(...a) },
  request: (...a: unknown[]) => requestMock(...a),
}));

import { greenapiProvider } from '../whatsapp/providers/greenapi';

/** Canned single response with the given status + body. */
function mockHttpResponse(statusCode: number, body: string): void {
  requestMock.mockImplementation((opts: unknown, cb: (res: EventEmitter & { statusCode: number }) => void) => {
    lastOpts = opts;
    const res = Object.assign(new EventEmitter(), { statusCode });
    return Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      write: vi.fn((b: string) => { lastBody = b; }),
      destroy: vi.fn(),
      end: vi.fn(() => { cb(res); res.emit('data', body); res.emit('end'); }),
    });
  });
}

beforeEach(() => {
  requestMock.mockReset();
  savePendingChoice.mockClear();
  poolQuery.mockClear();
  lastOpts = null;
  lastBody = '';
});
afterEach(() => { vi.restoreAllMocks(); });

describe('greenapiProvider.sendText', () => {
  it('posts to the instance URL with a normalized chatId and returns idMessage', async () => {
    mockHttpResponse(200, JSON.stringify({ idMessage: 'BAE5F1' }));
    const id = await greenapiProvider.sendText({ to: '0501234567', text: 'שלום' });
    expect(id).toBe('BAE5F1');
    expect(lastOpts.hostname).toBe('api.green-api.com');
    expect(lastOpts.path).toBe('/waInstance1101000001/sendMessage/TOKEN123');
    const sent = JSON.parse(lastBody);
    expect(sent.chatId).toBe('972501234567@c.us'); // 05… → 9725…@c.us
    expect(sent.message).toBe('שלום');
  });

  it('returns null (no throw) when the response has no idMessage', async () => {
    mockHttpResponse(200, JSON.stringify({ ok: true }));
    await expect(greenapiProvider.sendText({ to: '972501234567', text: 'hi' })).resolves.toBeNull();
  });

  it('skips an unresolvable recipient — no HTTP call, returns null', async () => {
    mockHttpResponse(200, '{}');
    await expect(greenapiProvider.sendText({ to: 'no-digits-here', text: 'hi' })).resolves.toBeNull();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('retries a transient 5xx and then succeeds', async () => {
    vi.useFakeTimers();
    let call = 0;
    requestMock.mockImplementation((opts: unknown, cb: (res: EventEmitter & { statusCode: number }) => void) => {
      lastOpts = opts;
      const status = call++ === 0 ? 500 : 200;
      const res = Object.assign(new EventEmitter(), { statusCode: status });
      return Object.assign(new EventEmitter(), {
        setTimeout: vi.fn(),
        write: vi.fn((b: string) => { lastBody = b; }),
        destroy: vi.fn(),
        end: vi.fn(() => {
          cb(res);
          res.emit('data', status === 200 ? JSON.stringify({ idMessage: 'RETRIED' }) : 'upstream error');
          res.emit('end');
        }),
      });
    });
    const p = greenapiProvider.sendText({ to: '972501234567', text: 'hi' });
    await vi.advanceTimersByTimeAsync(1000); // first back-off (1s), then attempt 2
    await expect(p).resolves.toBe('RETRIED');
    expect(call).toBe(2);
    vi.useRealTimers();
  });

  it('writes a DLQ row and throws on a permanent (4xx) failure', async () => {
    mockHttpResponse(400, 'invalid chatId');
    await expect(greenapiProvider.sendText({ to: '972501234567', text: 'hi' })).rejects.toThrow();
    const dlq = poolQuery.mock.calls.find((c) => String(c[0]).includes('WhatsappAuditLog'));
    expect(dlq).toBeDefined();
    expect((dlq![1] as unknown[])[0]).toBe('972501234567@c.us'); // DLQ "to" = chatId
  });
});

describe('greenapiProvider.sendButton / sendList → numbered text + PendingChoice', () => {
  it('renders reply buttons as numbered text and persists the number→id mapping', async () => {
    mockHttpResponse(200, JSON.stringify({ idMessage: 'B1' }));
    await greenapiProvider.sendButton({
      to: '972501234567',
      body: 'לאשר את הפעולה?',
      buttons: [{ id: 'כן 9c-uuid', title: 'כן' }, { id: 'לא 9c-uuid', title: 'לא' }],
    });
    expect(JSON.parse(lastBody).message).toBe('לאשר את הפעולה?\n\n1. כן\n2. לא');
    expect(savePendingChoice).toHaveBeenCalledWith('972501234567', { '1': 'כן 9c-uuid', '2': 'לא 9c-uuid' });
  });

  it('flattens list sections into numbered text (title — description) and persists the mapping', async () => {
    mockHttpResponse(200, JSON.stringify({ idMessage: 'L1' }));
    await greenapiProvider.sendList({
      to: '972501234567',
      body: 'מה תרצה לעשות?',
      buttonLabel: 'בחר פעולה',
      sections: [{
        title: 'תפריט',
        rows: [
          { id: 'MGR_MENU_1', title: 'תמונת מצב' },
          { id: 'MGR_MENU_2', title: 'בדיקות שטח', description: 'להיום' },
        ],
      }],
    });
    expect(JSON.parse(lastBody).message).toBe('מה תרצה לעשות?\n\n1. תמונת מצב\n2. בדיקות שטח — להיום');
    expect(savePendingChoice).toHaveBeenCalledWith('972501234567', { '1': 'MGR_MENU_1', '2': 'MGR_MENU_2' });
  });
});

describe('greenapiProvider.sendTemplate (unreachable via notify; defensive)', () => {
  it('degrades to plain text of the body params (never a Meta template call)', async () => {
    mockHttpResponse(200, JSON.stringify({ idMessage: 'T1' }));
    await greenapiProvider.sendTemplate({
      to: '972501234567', name: 'due_reminder', languageCode: 'he', bodyParams: ['בדיקת מעלית', '10:00'],
    });
    expect(JSON.parse(lastBody).message).toBe('בדיקת מעלית — 10:00');
    expect(savePendingChoice).not.toHaveBeenCalled();
  });
});
