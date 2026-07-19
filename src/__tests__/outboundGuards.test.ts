/**
 * Outbound guards — sender-level kill switch + ops-alert bypass.
 *
 * WHATSAPP_OUTBOUND_SUPPRESSED=true → every send returns null without touching
 * the provider. `sendOpsAlertText` is the ONE bypass (it must reach humans
 * even when the outbound is suppressed, or the mechanism is blind to itself).
 * The provider is mocked; we assert only sender.ts's own gating.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendText     = vi.fn().mockResolvedValue('id-text');
const sendButton   = vi.fn().mockResolvedValue('id-button');
const sendList     = vi.fn().mockResolvedValue('id-list');
const sendTemplate = vi.fn().mockResolvedValue('id-template');

vi.mock('../whatsapp/provider', () => ({
  getProvider: () => ({
    name: 'mock',
    supportsTemplates: true,
    paced: false,
    sendText:     (...a: unknown[]) => sendText(...a),
    sendButton:   (...a: unknown[]) => sendButton(...a),
    sendList:     (...a: unknown[]) => sendList(...a),
    sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  }),
}));

import {
  sendTextMessage,
  sendButtonMessage,
  sendListMessage,
  sendTemplateMessage,
  sendOpsAlertText,
  __resetSuppressThrottleForTests,
} from '../whatsapp/sender';

beforeEach(() => {
  __resetSuppressThrottleForTests();
  sendText.mockReset().mockResolvedValue('id-text');
  sendButton.mockReset().mockResolvedValue('id-button');
  sendList.mockReset().mockResolvedValue('id-list');
  sendTemplate.mockReset().mockResolvedValue('id-template');
  delete process.env.WHATSAPP_OUTBOUND_SUPPRESSED;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('WHATSAPP_OUTBOUND_SUPPRESSED', () => {
  it('off (unset) → sendTextMessage forwards to provider', async () => {
    const id = await sendTextMessage({ to: '972501234567', text: 'hi' });
    expect(id).toBe('id-text');
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('=true → sendTextMessage returns null, provider NOT called', async () => {
    process.env.WHATSAPP_OUTBOUND_SUPPRESSED = 'true';
    const id = await sendTextMessage({ to: '972501234567', text: 'hi' });
    expect(id).toBeNull();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('=true → sendButtonMessage returns null, provider NOT called', async () => {
    process.env.WHATSAPP_OUTBOUND_SUPPRESSED = 'true';
    const id = await sendButtonMessage({
      to: '972501234567',
      body: 'pick one',
      buttons: [{ id: 'A', title: 'A' }],
    });
    expect(id).toBeNull();
    expect(sendButton).not.toHaveBeenCalled();
  });

  it('=true → sendListMessage returns null, provider NOT called', async () => {
    process.env.WHATSAPP_OUTBOUND_SUPPRESSED = 'true';
    const id = await sendListMessage({
      to: '972501234567',
      body: 'choose',
      buttonLabel: 'open',
      sections: [{ rows: [{ id: 'A', title: 'A' }] }],
    });
    expect(id).toBeNull();
    expect(sendList).not.toHaveBeenCalled();
  });

  it('=true → sendTemplateMessage returns null, provider NOT called', async () => {
    process.env.WHATSAPP_OUTBOUND_SUPPRESSED = 'true';
    const id = await sendTemplateMessage({
      to: '972501234567',
      name: 'due_reminder',
      languageCode: 'he',
      bodyParams: ['a', 'b'],
    });
    expect(id).toBeNull();
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('=false / other value → treated as OFF (only exact "true" activates)', async () => {
    for (const val of ['false', '0', '1', 'yes', 'TRUE', '']) {
      process.env.WHATSAPP_OUTBOUND_SUPPRESSED = val;
      await sendTextMessage({ to: '972501234567', text: 'x' });
    }
    expect(sendText).toHaveBeenCalledTimes(6);
  });
});

describe('sendOpsAlertText — bypass of BOTH the kill switch AND the preflight', () => {
  it('=true → sendOpsAlertText still forwards to provider', async () => {
    process.env.WHATSAPP_OUTBOUND_SUPPRESSED = 'true';
    const id = await sendOpsAlertText({ to: '972500000001', text: 'ops alert' });
    expect(id).toBe('id-text');
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('propagates bypassGuards=true to the provider (so preflight also skips)', async () => {
    process.env.WHATSAPP_OUTBOUND_SUPPRESSED = 'true';
    await sendOpsAlertText({ to: '972500000001', text: 'ops alert' });
    const arg = sendText.mock.calls[0][0] as { to: string; text: string; bypassGuards?: boolean };
    expect(arg.bypassGuards).toBe(true);
  });

  it('caller-supplied bypassGuards on plain sendTextMessage ALSO bypasses (documented internal escape)', async () => {
    process.env.WHATSAPP_OUTBOUND_SUPPRESSED = 'true';
    const id = await sendTextMessage({ to: '972500000001', text: 'x', bypassGuards: true });
    expect(id).toBe('id-text');
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});

describe('symmetry with the incident: suppress and preflight are two DIFFERENT guards', () => {
  it('suppress OFF + provider preflight is the provider\'s job — sender does not preflight itself', async () => {
    // sender.ts must not gate on Green API state; that lives in the provider.
    // A provider mock that succeeds proves sender's job is only the kill switch.
    delete process.env.WHATSAPP_OUTBOUND_SUPPRESSED;
    const id = await sendTextMessage({ to: '972501234567', text: 'hi' });
    expect(id).toBe('id-text');
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});
