/**
 * AI-native agent loop entry tests.
 *
 * Coverage:
 *  - agentLoopEnabled(): default on; AI_AGENT_LOOP=0 disables
 *  - runAgentLoop: a non-destructive tool call executes and the final text is
 *    sent + recorded
 *  - runAgentLoop: a DESTRUCTIVE tool call is NOT executed — instead the loop
 *    sets awaiting=agent_confirm and asks the user to confirm
 *  - handleAgentConfirm: "כן" executes the pending tool; "לא" cancels; garbage
 *    re-asks
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedUser } from '../types';
import type { LoopRequest, LoopToolCall } from '../ai/provider';

// ── Mocks ─────────────────────────────────────────────────────────────────────
const runLoop = vi.fn();
const emitStructured = vi.fn();
vi.mock('../ai/provider', async (orig) => {
  const actual = await orig<typeof import('../ai/provider')>();
  return {
    ...actual,
    getProvider: () => ({ name: 'test', emitStructured, runLoop }),
  };
});

const sendTextMessage = vi.fn().mockResolvedValue('wamid');
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
}));

const getHistory = vi.fn().mockResolvedValue([]);
const appendTurn = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/chatHistory', () => ({
  getHistory: (...a: unknown[]) => getHistory(...a),
  appendTurn: (...a: unknown[]) => appendTurn(...a),
}));

let storedContext: Record<string, unknown> | null = null;
const setContext = vi.fn(async (_phone: string, state: Record<string, unknown>) => { storedContext = state; });
const getContext = vi.fn(async (_phone: string) => storedContext);
const clearContext = vi.fn(async (_phone: string) => { storedContext = null; });
vi.mock('../services/conversationContext', () => ({
  setContext: (phone: string, state: Record<string, unknown>) => setContext(phone, state),
  getContext: (phone: string) => getContext(phone),
  clearContext: (phone: string) => clearContext(phone),
}));

// Provide a deterministic destructive tool so we can drive the confirm flow.
const deleteHandler = vi.fn().mockResolvedValue('האירוע נמחק מהיומן.');
vi.mock('../ai/agent/tools', () => {
  const del = {
    name: 'calendar_delete_event',
    description: 'delete',
    destructive: true,
    schema: { type: 'object' },
    allow: () => true,
    handler: (...a: unknown[]) => deleteHandler(...a),
  };
  const list = {
    name: 'list_my_inspections',
    description: 'list',
    schema: { type: 'object' },
    allow: () => true,
    handler: async () => 'רשימה',
  };
  const all = [del, list];
  return {
    toolsForUser: () => all,
    findToolForUser: (_u: unknown, name: string) => all.find((t) => t.name === name) ?? null,
    __allToolsForTest: all,
  };
});

import { agentLoopEnabled, runAgentLoop, handleAgentConfirm } from '../ai/agent';

function worker(): ResolvedUser {
  return {
    id: 'u-1', name: 'דני', phone: '972500000001', role: 'TECHNICIAN',
    isElevated: false, canViewAllRecords: false, canManageUsers: false, canManagePermissions: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storedContext = null;
  getHistory.mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AI_AGENT_LOOP;
});

describe('agentLoopEnabled', () => {
  it('is on by default', () => {
    delete process.env.AI_AGENT_LOOP;
    expect(agentLoopEnabled()).toBe(true);
  });
  it('is off when AI_AGENT_LOOP=0', () => {
    process.env.AI_AGENT_LOOP = '0';
    expect(agentLoopEnabled()).toBe(false);
  });
});

describe('runAgentLoop — plain answer', () => {
  it('sends the final model text and records the turn', async () => {
    runLoop.mockResolvedValueOnce({ text: 'יש לך 3 בדיקות היום.', toolCallCount: 1 });
    await runAgentLoop(worker(), 'מה המשימות שלי היום');
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '972500000001', text: 'יש לך 3 בדיקות היום.' }),
    );
    // user turn + assistant turn recorded
    expect(appendTurn).toHaveBeenCalledWith('972500000001', 'user', 'מה המשימות שלי היום');
    expect(appendTurn).toHaveBeenCalledWith('972500000001', 'assistant', 'יש לך 3 בדיקות היום.');
  });
});

describe('runAgentLoop — destructive tool requires confirmation', () => {
  it('does NOT execute the destructive tool; asks the user and sets agent_confirm', async () => {
    // Simulate the model calling calendar_delete_event during the loop.
    runLoop.mockImplementationOnce(async (req: LoopRequest) => {
      const call: LoopToolCall = { id: 'c1', name: 'calendar_delete_event', input: { eventId: 'evt-9' } };
      const toolResult = await req.runTool(call);
      // The interceptor must have returned the confirm sentinel, not executed.
      expect(toolResult).toContain('טרם בוצעה');
      return { text: 'רגע, צריך אישור.', toolCallCount: 1 };
    });

    await runAgentLoop(worker(), 'תמחק את הפגישה עם כהן');

    expect(deleteHandler).not.toHaveBeenCalled();
    expect(storedContext).toMatchObject({
      awaiting: 'agent_confirm',
      pendingAgentTool: { name: 'calendar_delete_event', input: { eventId: 'evt-9' } },
    });
    const sent = sendTextMessage.mock.calls.at(-1)?.[0] as { text: string };
    expect(sent.text).toContain('לאשר');
  });
});

describe('handleAgentConfirm', () => {
  beforeEach(() => {
    storedContext = {
      awaiting: 'agent_confirm',
      pendingAgentTool: { name: 'calendar_delete_event', input: { eventId: 'evt-9' }, summary: 'מחיקת אירוע מהיומן' },
    };
  });

  it('executes the pending tool on "כן" and clears context', async () => {
    const handled = await handleAgentConfirm(worker(), 'כן');
    expect(handled).toBe(true);
    expect(deleteHandler).toHaveBeenCalledOnce();
    expect(clearContext).toHaveBeenCalled();
    const sent = sendTextMessage.mock.calls.at(-1)?.[0] as { text: string };
    expect(sent.text).toContain('נמחק');
  });

  it('cancels on "לא" without executing', async () => {
    const handled = await handleAgentConfirm(worker(), 'לא');
    expect(handled).toBe(true);
    expect(deleteHandler).not.toHaveBeenCalled();
    const sent = sendTextMessage.mock.calls.at(-1)?.[0] as { text: string };
    expect(sent.text).toContain('בוטלה');
  });

  it('re-asks on an unrecognized reply and keeps the pending state', async () => {
    const handled = await handleAgentConfirm(worker(), 'אולי');
    expect(handled).toBe(true);
    expect(deleteHandler).not.toHaveBeenCalled();
    expect(clearContext).not.toHaveBeenCalled();
    const sent = sendTextMessage.mock.calls.at(-1)?.[0] as { text: string };
    expect(sent.text).toContain('כן');
  });

  it('returns false when there is no pending agent_confirm context', async () => {
    storedContext = { awaiting: 'menu' };
    const handled = await handleAgentConfirm(worker(), 'כן');
    expect(handled).toBe(false);
  });
});
