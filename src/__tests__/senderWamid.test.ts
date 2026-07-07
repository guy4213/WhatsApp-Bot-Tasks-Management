/**
 * Phase 2: sender returns the outbound wamid (messages[0].id) on success, or null
 * when the response can't be parsed — without ever failing the send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// Credentials must exist BEFORE sender.ts is imported (it reads them at load).
vi.hoisted(() => {
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'PN';
  process.env.WHATSAPP_ACCESS_TOKEN = 'TOK';
});

const requestMock = vi.fn();
vi.mock('https', () => ({
  default: { request: (...a: unknown[]) => requestMock(...a) },
  request: (...a: unknown[]) => requestMock(...a),
}));

import { sendTextMessage } from '../whatsapp/sender';

/** Make https.request emit a canned response with the given status + body. */
function mockHttpResponse(statusCode: number, body: string): void {
  requestMock.mockImplementation((_opts: unknown, cb: (res: EventEmitter & { statusCode: number }) => void) => {
    const res = Object.assign(new EventEmitter(), { statusCode });
    const req = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(() => {
        cb(res);              // sender registers res.on('data'/'end') inside this cb
        res.emit('data', body);
        res.emit('end');
      }),
    });
    return req;
  });
}

beforeEach(() => { requestMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('sender returns the outbound wamid', () => {
  it('returns messages[0].id on a successful send', async () => {
    mockHttpResponse(200, JSON.stringify({ messages: [{ id: 'wamid.ABC' }] }));
    await expect(sendTextMessage({ to: '972501234567', text: 'hi' })).resolves.toBe('wamid.ABC');
  });

  it('returns null (no throw) when the response body has no id', async () => {
    mockHttpResponse(200, JSON.stringify({ messaging_product: 'whatsapp' }));
    await expect(sendTextMessage({ to: '972501234567', text: 'hi' })).resolves.toBeNull();
  });

  it('returns null (no throw) when the response body is not JSON', async () => {
    mockHttpResponse(200, 'not json');
    await expect(sendTextMessage({ to: '972501234567', text: 'hi' })).resolves.toBeNull();
  });
});
