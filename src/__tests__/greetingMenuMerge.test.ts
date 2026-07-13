/**
 * greetAndOpenMenu (PR#2 + prod-bug follow-up) — the greeting+menu merge under a
 * paced provider, across ALL first-message shapes.
 *
 * The production bug this locks down: under Green API (paced) a menu-TRIGGER first
 * message ("שלום"/"היי"/"תפריט") arrived as greeting THEN (15s later) menu, because
 * the menu was opened by the router (handleAIMessage → showMenu), a different code
 * path than the greeting. The fix opens the menu HERE, merged with the greeting in
 * ONE send, sets the same awaiting context, and returns menuServed=true so the
 * caller skips the router's duplicate menu. Meta stays two separate sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendTextMessage = vi.fn().mockResolvedValue('wamid');
vi.mock('../whatsapp/sender', () => ({ sendTextMessage: (...a: unknown[]) => sendTextMessage(...a) }));

const claimDailyGreeting = vi.fn();
vi.mock('../services/greetings', () => ({
  claimDailyGreeting: (...a: unknown[]) => claimDailyGreeting(...a),
  buildGreeting: (name: string) => `שלום, ${name}. במה אפשר לעזור?`,
}));

const renderMenu = vi.fn((_u?: unknown) => '1. אופציה\n2. אופציה');
const isManagerMenuUser = vi.fn((_u?: unknown) => false);
vi.mock('../ai/menu', () => ({
  renderMenu: (u: unknown) => renderMenu(u),
  isManagerMenuUser: (u: unknown) => isManagerMenuUser(u),
  MENU_TRIGGER_RE: /^\s*(שלום|היי|תפריט|menu)\s*$/i,
}));

const getProvider = vi.fn();
vi.mock('../whatsapp/provider', () => ({ getProvider: () => getProvider() }));

const setContext = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/conversationContext', () => ({ setContext: (...a: unknown[]) => setContext(...a) }));

import { greetAndOpenMenu } from '../routes/webhook';

const PHONE = '972501234567';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const USER = { name: 'דני', phone: PHONE, role: 'SALES' } as any;
const GREETING = 'שלום, דני. במה אפשר לעזור?';
const MENU = '1. אופציה\n2. אופציה';

beforeEach(() => {
  sendTextMessage.mockClear();
  renderMenu.mockClear();
  isManagerMenuUser.mockReset().mockReturnValue(false);
  setContext.mockClear();
  claimDailyGreeting.mockReset().mockResolvedValue(true);
  getProvider.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('greetAndOpenMenu — Green API (paced)', () => {
  // THE REGRESSION: trigger first-message must be ONE merged send, not two.
  it('TRIGGER ("שלום"): greeting+menu in ONE send, menu context set, menuServed=true', async () => {
    getProvider.mockReturnValue({ paced: true });
    const r = await greetAndOpenMenu(PHONE, USER, 'שלום');
    expect(sendTextMessage).toHaveBeenCalledTimes(1); // NOT two messages 15s apart
    expect(sendTextMessage.mock.calls[0][0].text).toBe(`${GREETING}\n\n${MENU}`);
    expect(setContext).toHaveBeenCalledWith(PHONE, { awaiting: 'menu' });
    expect(r).toEqual({ menuServed: true }); // caller skips the router's menu
  });

  it('TRIGGER for a MANAGER: awaiting = mgr_menu_root', async () => {
    getProvider.mockReturnValue({ paced: true });
    isManagerMenuUser.mockReturnValue(true);
    const r = await greetAndOpenMenu(PHONE, USER, 'תפריט');
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(setContext).toHaveBeenCalledWith(PHONE, { awaiting: 'mgr_menu_root' });
    expect(r).toEqual({ menuServed: true });
  });

  it('NON-trigger: greeting + informational menu in ONE send, NO context, menuServed=false', async () => {
    getProvider.mockReturnValue({ paced: true });
    const r = await greetAndOpenMenu(PHONE, USER, 'מה הבדיקות שלי היום');
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][0].text).toBe(`${GREETING}\n\n${MENU}`);
    expect(setContext).not.toHaveBeenCalled(); // informational — router answers the request
    expect(r).toEqual({ menuServed: false });
  });

  it('no greeting claimed today → no sends, menuServed=false', async () => {
    claimDailyGreeting.mockResolvedValue(false);
    getProvider.mockReturnValue({ paced: true });
    const r = await greetAndOpenMenu(PHONE, USER, 'שלום');
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(setContext).not.toHaveBeenCalled();
    expect(r).toEqual({ menuServed: false });
  });
});

describe('greetAndOpenMenu — Meta (unpaced): unchanged, rollback-safe', () => {
  it('TRIGGER: greeting only (ONE send), NO context, menuServed=false → router opens the menu', async () => {
    getProvider.mockReturnValue({ paced: false });
    const r = await greetAndOpenMenu(PHONE, USER, 'שלום');
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][0].text).toBe(GREETING);
    expect(setContext).not.toHaveBeenCalled();
    expect(r).toEqual({ menuServed: false });
  });

  it('NON-trigger: greeting THEN menu = TWO separate sends', async () => {
    getProvider.mockReturnValue({ paced: false });
    const r = await greetAndOpenMenu(PHONE, USER, 'מה קורה');
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(sendTextMessage.mock.calls[0][0].text).toBe(GREETING);
    expect(sendTextMessage.mock.calls[1][0].text).toBe(MENU);
    expect(r).toEqual({ menuServed: false });
  });
});
