/**
 * greetAndOpenMenu (PR#2, refinement 2) — the greeting+menu merge is gated on the
 * provider's `paced` flag:
 *   - paced (Green API)  → greeting + menu coalesced into ONE message
 *   - unpaced (Meta)     → greeting and menu stay TWO separate sends (unchanged)
 * so Meta's working UX is untouched and rollback is clean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendTextMessage = vi.fn().mockResolvedValue('wamid');
vi.mock('../whatsapp/sender', () => ({ sendTextMessage: (...a: unknown[]) => sendTextMessage(...a) }));

const claimDailyGreeting = vi.fn();
vi.mock('../services/greetings', () => ({
  claimDailyGreeting: (...a: unknown[]) => claimDailyGreeting(...a),
  buildGreeting: (name: string) => `שלום, ${name}. במה אפשר לעזור?`,
}));

const renderMenu = vi.fn((_user?: unknown) => '1. אופציה\n2. אופציה');
vi.mock('../ai/menu', () => ({
  renderMenu: (user: unknown) => renderMenu(user),
  MENU_TRIGGER_RE: /^\s*(שלום|תפריט)\s*$/,
}));

const getProvider = vi.fn();
vi.mock('../whatsapp/provider', () => ({ getProvider: () => getProvider() }));

import { greetAndOpenMenu } from '../routes/webhook';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const USER = { name: 'דני' } as any;
const GREETING = 'שלום, דני. במה אפשר לעזור?';
const MENU = '1. אופציה\n2. אופציה';

beforeEach(() => {
  sendTextMessage.mockClear();
  renderMenu.mockClear();
  claimDailyGreeting.mockReset().mockResolvedValue(true);
  getProvider.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('greetAndOpenMenu — merge gated on provider.paced', () => {
  it('paced (Green API): merges greeting + menu into ONE message', async () => {
    getProvider.mockReturnValue({ paced: true });
    await greetAndOpenMenu('972501234567', USER, 'מה קורה');
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][0].text).toBe(`${GREETING}\n\n${MENU}`);
  });

  it('unpaced (Meta): greeting and menu are TWO separate sends (unchanged UX)', async () => {
    getProvider.mockReturnValue({ paced: false });
    await greetAndOpenMenu('972501234567', USER, 'מה קורה');
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(sendTextMessage.mock.calls[0][0].text).toBe(GREETING);
    expect(sendTextMessage.mock.calls[1][0].text).toBe(MENU);
  });

  it('no greeting claimed today → no sends at all', async () => {
    claimDailyGreeting.mockResolvedValue(false);
    getProvider.mockReturnValue({ paced: true });
    await greetAndOpenMenu('972501234567', USER, 'מה קורה');
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('paced + menu-trigger text → greeting only (router opens the menu)', async () => {
    getProvider.mockReturnValue({ paced: true });
    await greetAndOpenMenu('972501234567', USER, 'שלום');
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][0].text).toBe(GREETING);
    expect(renderMenu).not.toHaveBeenCalled();
  });

  it('unpaced + menu-trigger text → greeting only, menu suppressed', async () => {
    getProvider.mockReturnValue({ paced: false });
    await greetAndOpenMenu('972501234567', USER, 'תפריט');
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][0].text).toBe(GREETING);
  });
});
