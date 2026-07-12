/**
 * Regression + feature tests for the `sendTemplateMessage` button-param extension.
 *
 * The 14 existing approved templates call `sendTemplateMessage` with body params
 * only. The critical invariant: when `buttonParams` is unset/empty the outgoing
 * HTTP body is byte-for-byte identical to before the extension.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Set WhatsApp creds + capture array BEFORE the sender module loads (hoisted runs
// before imports). Without creds the sender short-circuits and never calls https.
const { capturedBodies } = vi.hoisted(() => {
  // Pin the Meta provider — this suite tests Meta's template payload shape, and
  // PR#2 flipped the default provider to Green API.
  process.env.WHATSAPP_PROVIDER = 'meta';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'PNID';
  process.env.WHATSAPP_ACCESS_TOKEN = 'TOKEN';
  process.env.WHATSAPP_API_VERSION = 'v19.0';
  return { capturedBodies: [] as string[] };
});

// db/connection throws at import when DATABASE_URL is unset — stub it out.
vi.mock('../db/connection', () => ({ pool: { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) } }));

// Capture the JSON body written to https.request; respond 200 so post() resolves.
vi.mock('https', () => {
  const request = (_opts: unknown, cb: (res: unknown) => void) => {
    const res = {
      statusCode: 200,
      on: (event: string, handler: (chunk?: string) => void) => {
        if (event === 'end') setImmediate(() => handler());
      },
    };
    return {
      setTimeout: () => {},
      on: () => {},
      write: (body: string) => { capturedBodies.push(body); },
      end: () => { cb(res); },
    };
  };
  return { default: { request }, request };
});

import { sendTemplateMessage } from '../whatsapp/sender';

function lastPayload(): any {
  return JSON.parse(capturedBodies[capturedBodies.length - 1]);
}

beforeEach(() => { capturedBodies.length = 0; });
afterEach(() => { vi.clearAllMocks(); });

describe('sendTemplateMessage — buttonParams extension', () => {
  it('REGRESSION: buttonParams unset → body-only components (unchanged shape)', async () => {
    await sendTemplateMessage({
      to: '972501234567', name: 'due_reminder', languageCode: 'he',
      bodyParams: ['כותרת', '14:00'],
    });
    const p = lastPayload();
    expect(p.type).toBe('template');
    expect(p.template.name).toBe('due_reminder');
    expect(p.template.language).toEqual({ code: 'he' });
    expect(p.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'כותרת' }, { type: 'text', text: '14:00' }] },
    ]);
    // No button component leaked in.
    expect(p.template.components.some((c: any) => c.type === 'button')).toBe(false);
  });

  it('REGRESSION: no bodyParams and no buttonParams → no components key at all', async () => {
    await sendTemplateMessage({ to: '972501234567', name: 'some_template', languageCode: 'he' });
    const p = lastPayload();
    expect(p.template.components).toBeUndefined();
  });

  it('quick_reply button → appends the correct button component', async () => {
    await sendTemplateMessage({
      to: '972501234567', name: 'due_reminder_v2', languageCode: 'he',
      bodyParams: ['a', 'b'],
      buttonParams: [{ subType: 'quick_reply', index: 0, payload: 'TASK_DETAILS_abc123' }],
    });
    const p = lastPayload();
    expect(p.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      {
        type: 'button', sub_type: 'quick_reply', index: 0,
        parameters: [{ type: 'payload', payload: 'TASK_DETAILS_abc123' }],
      },
    ]);
  });

  it('url button → uses type:text parameter', async () => {
    await sendTemplateMessage({
      to: '972501234567', name: 'tmpl', languageCode: 'he',
      bodyParams: ['x'],
      buttonParams: [{ subType: 'url', index: 1, payload: 'tasks/abc' }],
    });
    const p = lastPayload();
    const btn = p.template.components.find((c: any) => c.type === 'button');
    expect(btn).toEqual({
      type: 'button', sub_type: 'url', index: 1,
      parameters: [{ type: 'text', text: 'tasks/abc' }],
    });
  });

  it('multiple buttons preserve their indices and order', async () => {
    await sendTemplateMessage({
      to: '972501234567', name: 'tmpl', languageCode: 'he',
      bodyParams: ['x'],
      buttonParams: [
        { subType: 'quick_reply', index: 0, payload: 'P0' },
        { subType: 'quick_reply', index: 1, payload: 'P1' },
      ],
    });
    const p = lastPayload();
    const btns = p.template.components.filter((c: any) => c.type === 'button');
    expect(btns).toHaveLength(2);
    expect(btns[0].index).toBe(0);
    expect(btns[0].parameters[0].payload).toBe('P0');
    expect(btns[1].index).toBe(1);
    expect(btns[1].parameters[0].payload).toBe('P1');
  });

  it('buttonParams with no bodyParams → components has only the button', async () => {
    await sendTemplateMessage({
      to: '972501234567', name: 'tmpl', languageCode: 'he',
      buttonParams: [{ subType: 'quick_reply', index: 0, payload: 'P' }],
    });
    const p = lastPayload();
    expect(p.template.components).toEqual([
      { type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: 'P' }] },
    ]);
  });
});
