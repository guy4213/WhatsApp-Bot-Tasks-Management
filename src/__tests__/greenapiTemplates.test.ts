/**
 * templates.notify() under Green API (PR#2).
 *
 * The active provider is authoritative: because greenapiProvider.supportsTemplates
 * is false, EVERY proactive notification must take the free-form fallback-text
 * path and NEVER attempt a Meta template — even with WHATSAPP_TEMPLATES_ENABLED=true
 * and a template name configured. The Meta contrast test proves the gate still
 * lets templates through when Meta is active (rollback safety).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendTextMessage     = vi.fn().mockResolvedValue('id-text');
const sendTemplateMessage = vi.fn().mockResolvedValue('id-tmpl');
const sendButtonMessage   = vi.fn().mockResolvedValue('id-btn');
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage:     (...a: unknown[]) => sendTextMessage(...a),
  sendTemplateMessage: (...a: unknown[]) => sendTemplateMessage(...a),
  sendButtonMessage:   (...a: unknown[]) => sendButtonMessage(...a),
}));

import { notify } from '../whatsapp/templates';
import { DEFAULT_TEMPLATE_NAMES, type NotificationKey } from '../whatsapp/templateNames';

const KEYS = Object.keys(DEFAULT_TEMPLATE_NAMES) as NotificationKey[];

const origProvider = process.env.WHATSAPP_PROVIDER;
const origEnabled  = process.env.WHATSAPP_TEMPLATES_ENABLED;

beforeEach(() => {
  sendTextMessage.mockClear();
  sendTemplateMessage.mockClear();
  sendButtonMessage.mockClear();
  // Templates ENABLED + names configured — so the ONLY thing forcing free-form
  // is the provider, not the env flag.
  process.env.WHATSAPP_PROVIDER = 'greenapi';
  process.env.WHATSAPP_TEMPLATES_ENABLED = 'true';
});
afterEach(() => {
  if (origProvider === undefined) delete process.env.WHATSAPP_PROVIDER; else process.env.WHATSAPP_PROVIDER = origProvider;
  if (origEnabled === undefined) delete process.env.WHATSAPP_TEMPLATES_ENABLED; else process.env.WHATSAPP_TEMPLATES_ENABLED = origEnabled;
});

describe('notify() under Green API — free-form fallback for every notification', () => {
  it(`covers all ${KEYS.length} notification keys`, () => {
    expect(KEYS.length).toBeGreaterThanOrEqual(15); // guard: keep the sweep exhaustive
  });

  for (const key of KEYS) {
    it(`${key}: relays the fallback text verbatim, never a template`, async () => {
      const bodyParams = ['פרמטר-א', 'פרמטר-ב', '10:30'];
      const fallbackText = `התראה ${key}: ${bodyParams.join(' | ')}`;
      const wamid = await notify({ to: '972501234567', key, bodyParams, fallbackText });

      expect(sendTemplateMessage).not.toHaveBeenCalled();
      expect(sendTextMessage).toHaveBeenCalledWith({ to: '972501234567', text: fallbackText });
      expect(wamid).toBe('id-text');
      // The text that goes out is non-empty and carries every parameter.
      const sentText = (sendTextMessage.mock.calls[0][0] as { text: string }).text;
      expect(sentText.trim().length).toBeGreaterThan(0);
      for (const p of bodyParams) expect(sentText).toContain(p);
    });
  }

  it('with quick-reply buttons: uses the interactive fallback, still no template', async () => {
    await notify({
      to: '972501234567',
      key: 'DUEDATE_APPROVAL_REQUEST',
      bodyParams: ['גיא', 'משימה', '2026-07-20', 'uuid'],
      fallbackText: 'בקשת אישור דד-ליין',
      buttons: [{ id: 'אשר uuid', title: 'אשר' }, { id: 'דחה uuid', title: 'דחה' }],
    });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(sendButtonMessage).toHaveBeenCalledTimes(1);
  });
});

describe('notify() under Meta — template gate still open (rollback safety)', () => {
  it('uses the approved template when Meta is active + templates enabled', async () => {
    process.env.WHATSAPP_PROVIDER = 'meta';
    await notify({
      to: '972501234567', key: 'DUE_REMINDER',
      bodyParams: ['בדיקת מעלית', '10:00'], fallbackText: 'תזכורת',
    });
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).not.toHaveBeenCalled();
    const arg = sendTemplateMessage.mock.calls[0][0] as { name: string; bodyParams: string[] };
    expect(arg.name).toBe(DEFAULT_TEMPLATE_NAMES.DUE_REMINDER);
    expect(arg.bodyParams).toEqual(['בדיקת מעלית', '10:00']);
  });
});
