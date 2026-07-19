/**
 * Green API health monitor — transition dedup + alert delivery contract.
 *
 * Recipients (getOpsAlertPhones) and the sender (sendOpsAlertText) are mocked;
 * we assert only handleGreenApiStateChange's own decision logic + message
 * shape. The polling HTTP call is exercised via a mocked global.fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getOpsAlertPhones = vi.fn();
// Ops alerts go through sendOpsAlertText (not sendTextMessage) so the alerts
// bypass WHATSAPP_OUTBOUND_SUPPRESSED and the Green-API preflight.
const sendOpsAlertText  = vi.fn();

vi.mock('../services/specialUsers', () => ({
  getOpsAlertPhones: (...a: unknown[]) => getOpsAlertPhones(...a),
}));
vi.mock('../whatsapp/sender', () => ({
  sendOpsAlertText: (...a: unknown[]) => sendOpsAlertText(...a),
}));

import {
  handleGreenApiStateChange,
  pollGreenApiState,
  __resetHealthStateForTests,
} from '../services/greenapiHealth';

beforeEach(() => {
  __resetHealthStateForTests();
  getOpsAlertPhones.mockReset().mockResolvedValue(['972500000001', '972500000002']);
  sendOpsAlertText.mockReset().mockResolvedValue('wamid-x');
  process.env.GREENAPI_ID_INSTANCE       = '1101000001';
  process.env.GREENAPI_API_TOKEN_INSTANCE = 'tok';
  process.env.GREENAPI_API_URL           = 'https://api.green-api.com';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleGreenApiStateChange — transition dedup', () => {
  it('authorized → notAuthorized: sends outage alert to every ops recipient', async () => {
    await handleGreenApiStateChange('authorized', 'webhook');
    expect(sendOpsAlertText).not.toHaveBeenCalled();

    await handleGreenApiStateChange('notAuthorized', 'webhook');
    expect(sendOpsAlertText).toHaveBeenCalledTimes(2); // 2 recipients
    const args = sendOpsAlertText.mock.calls.map((c) => c[0] as { to: string; text: string });
    expect(args.map((a) => a.to).sort()).toEqual(['972500000001', '972500000002']);
    expect(args[0].text).toContain('מנותק'); // outage header
    expect(args[0].text).toContain('notAuthorized');
    expect(args[0].text).toContain('QR'); // notAuthorized-specific explanation
  });

  it('bad → same bad without cooldown elapsed: no re-alert', async () => {
    await handleGreenApiStateChange('authorized', 'webhook');
    await handleGreenApiStateChange('notAuthorized', 'poll'); // outage — alerts
    sendOpsAlertText.mockClear();

    // Another poll a moment later — same state, cooldown NOT elapsed.
    await handleGreenApiStateChange('notAuthorized', 'poll');
    expect(sendOpsAlertText).not.toHaveBeenCalled();
  });

  it('bad → different bad: re-alerts even without cooldown (state change matters)', async () => {
    await handleGreenApiStateChange('authorized', 'webhook');
    await handleGreenApiStateChange('notAuthorized', 'poll');
    sendOpsAlertText.mockClear();

    await handleGreenApiStateChange('blocked', 'poll');
    expect(sendOpsAlertText).toHaveBeenCalled();
    const first = sendOpsAlertText.mock.calls[0][0] as { text: string };
    expect(first.text).toContain('blocked');
    expect(first.text).toContain('נחסם'); // blocked-specific Hebrew
  });

  it('recovery (bad → authorized) sends a recovery message', async () => {
    await handleGreenApiStateChange('authorized', 'webhook');
    await handleGreenApiStateChange('notAuthorized', 'poll');
    sendOpsAlertText.mockClear();

    await handleGreenApiStateChange('authorized', 'poll');
    expect(sendOpsAlertText).toHaveBeenCalledTimes(2);
    const recovery = sendOpsAlertText.mock.calls[0][0] as { text: string };
    expect(recovery.text).toContain('חזר לפעולה');
    expect(recovery.text).toContain('authorized');
  });

  it('authorized → authorized: nothing sent (steady state)', async () => {
    await handleGreenApiStateChange('authorized', 'poll');
    await handleGreenApiStateChange('authorized', 'poll');
    await handleGreenApiStateChange('authorized', 'poll');
    expect(sendOpsAlertText).not.toHaveBeenCalled();
  });

  it('first-ever observation of a bad state (no prior known state) alerts', async () => {
    // No prior handleGreenApiStateChange call — this is the very first tick.
    await handleGreenApiStateChange('notAuthorized', 'poll');
    expect(sendOpsAlertText).toHaveBeenCalled();
  });

  it('recovery when we never alerted (bootstrap → authorized) does NOT send a spurious "recovered" message', async () => {
    // Wait — actually per implementation, first authorized after null-prev is not
    // considered a recovery (prev is null which is treated as OK). Verify.
    await handleGreenApiStateChange('authorized', 'poll');
    expect(sendOpsAlertText).not.toHaveBeenCalled();
  });

  it('no ops recipients configured → drops the alert silently (warn logged)', async () => {
    getOpsAlertPhones.mockResolvedValueOnce([]);
    await handleGreenApiStateChange('notAuthorized', 'webhook');
    expect(sendOpsAlertText).not.toHaveBeenCalled();
  });

  it('getOpsAlertPhones throwing does NOT crash the caller', async () => {
    getOpsAlertPhones.mockRejectedValueOnce(new Error('db down'));
    await expect(handleGreenApiStateChange('notAuthorized', 'webhook')).resolves.toBeUndefined();
    expect(sendOpsAlertText).not.toHaveBeenCalled();
  });

  // Alert-worthy set is {notAuthorized, blocked, sleepMode}. Everything else
  // is logged only. Rationale: yellowCard is a WhatsApp "slow down" warning,
  // not a disconnection — sends still deliver. Waking Guy up with a "🚨 הבוט
  // מנותק" alert for yellowCard trained him to ignore the channel.
  it('yellowCard is NOT alert-worthy — no WhatsApp alert fires', async () => {
    await handleGreenApiStateChange('yellowCard', 'poll');
    expect(sendOpsAlertText).not.toHaveBeenCalled();
  });

  it('starting is NOT alert-worthy — transient bootup, no alert', async () => {
    await handleGreenApiStateChange('starting', 'poll');
    expect(sendOpsAlertText).not.toHaveBeenCalled();
  });

  it('unknown state (e.g. Green API schema change) is NOT alert-worthy — log only', async () => {
    await handleGreenApiStateChange('something-brand-new', 'webhook');
    expect(sendOpsAlertText).not.toHaveBeenCalled();
  });

  it('yellowCard → authorized does NOT fire a "recovered" alert (no outage was announced)', async () => {
    await handleGreenApiStateChange('yellowCard', 'poll');
    await handleGreenApiStateChange('authorized', 'poll');
    expect(sendOpsAlertText).not.toHaveBeenCalled();
  });

  it('yellowCard → notAuthorized DOES alert (crossed into the real-outage set)', async () => {
    await handleGreenApiStateChange('yellowCard', 'poll');
    expect(sendOpsAlertText).not.toHaveBeenCalled();
    await handleGreenApiStateChange('notAuthorized', 'poll');
    expect(sendOpsAlertText).toHaveBeenCalled();
    const first = sendOpsAlertText.mock.calls[0][0] as { text: string };
    expect(first.text).toContain('מנותק');
    expect(first.text).toContain('notAuthorized');
  });

  it('sleepMode IS alert-worthy — instance stopped, human must restart', async () => {
    await handleGreenApiStateChange('sleepMode', 'poll');
    expect(sendOpsAlertText).toHaveBeenCalled();
    const first = sendOpsAlertText.mock.calls[0][0] as { text: string };
    expect(first.text).toContain('sleepMode');
  });

  it('blocked IS alert-worthy — account banned by WhatsApp', async () => {
    await handleGreenApiStateChange('blocked', 'poll');
    expect(sendOpsAlertText).toHaveBeenCalled();
    const first = sendOpsAlertText.mock.calls[0][0] as { text: string };
    expect(first.text).toContain('blocked');
  });
});

describe('pollGreenApiState — HTTP contract', () => {
  it('parses stateInstance and drives handleGreenApiStateChange', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ stateInstance: 'authorized' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const state = await pollGreenApiState();
    expect(state).toBe('authorized');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/waInstance1101000001/getStateInstance/tok');
  });

  it('non-2xx response → returns unknown; does NOT alert (treated as transient)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const state = await pollGreenApiState();
    expect(state).toBe('unknown');
    expect(sendOpsAlertText).not.toHaveBeenCalled();
  });

  it('network error → returns unknown; does NOT throw, does NOT alert', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const state = await pollGreenApiState();
    expect(state).toBe('unknown');
    expect(sendOpsAlertText).not.toHaveBeenCalled();
  });

  it('missing credentials → returns unknown, skips the HTTP call entirely', async () => {
    delete process.env.GREENAPI_ID_INSTANCE;
    const fetchMock = vi.spyOn(global, 'fetch');
    const state = await pollGreenApiState();
    expect(state).toBe('unknown');
    expect(fetchMock).not.toHaveBeenCalled();
    // No credentials → we skip BEFORE handleGreenApiStateChange, so no alert.
    expect(sendOpsAlertText).not.toHaveBeenCalled();
  });
});
