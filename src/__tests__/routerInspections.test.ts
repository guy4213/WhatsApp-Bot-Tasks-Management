/**
 * D2-T7 + D2-T8 — router-level flow tests.
 *
 * Covers menu-driven and D5-T3-intent-driven flows for missing-info and
 * report-problem. Uses vi.mock to replace the inspections service + sender +
 * conversation context so we can assert Hebrew phrases and DB call shapes
 * without hitting the pool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const findOpenTaskFieldForWorker = vi.fn();
const writeMissingInfo = vi.fn().mockResolvedValue(undefined);
const writeProblem = vi.fn().mockResolvedValue(undefined);
const notifyOfficeMissingInfo = vi.fn().mockResolvedValue(undefined);
const notifyOfficeProblem = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/inspections', () => ({
  findOpenTaskFieldForWorker: (...a: unknown[]) => findOpenTaskFieldForWorker(...a),
  writeMissingInfo: (...a: unknown[]) => writeMissingInfo(...a),
  writeProblem: (...a: unknown[]) => writeProblem(...a),
  notifyOfficeMissingInfo: (...a: unknown[]) => notifyOfficeMissingInfo(...a),
  notifyOfficeProblem: (...a: unknown[]) => notifyOfficeProblem(...a),
}));

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
}));

// Conversation context: simple in-memory state so we can drive multi-turn.
let ctxStore: Record<string, unknown> | null = null;
const setContext = vi.fn(async (_phone: string, state: unknown) => {
  ctxStore = state as Record<string, unknown>;
});
const getContext = vi.fn(async () => ctxStore);
const clearContext = vi.fn(async () => { ctxStore = null; });
vi.mock('../services/conversationContext', () => ({
  setContext: (phone: string, state: unknown) => setContext(phone, state),
  getContext: (_phone: string) => getContext(),
  clearContext: (_phone: string) => clearContext(),
}));

// Chat history — a no-op stub is enough (the AI-intent path calls appendTurn).
vi.mock('../services/chatHistory', () => ({
  appendTurn: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue([]),
}));

// AI provider — return "configured" so the router doesn't short-circuit.
vi.mock('../ai/provider', () => ({
  getProvider: () => ({ name: 'test' }),
}));

// parseIntent is not called on the paths we test (we invoke executeIntent via
// the menu route + a synthetic AI-intent path), so a stub that throws would
// only fail if we lost a path. Keep it lenient.
vi.mock('../ai/intentParser', () => ({
  parseIntent: vi.fn().mockRejectedValue(new Error('unused in these tests')),
}));

// Audit log — no-op.
vi.mock('../utils/auditLog', () => ({
  writeAuditLog: vi.fn().mockResolvedValue('audit-log-id'),
  updateTranscribedMessage: vi.fn().mockResolvedValue(undefined),
}));

// The router pulls in tasks service which pulls in the pool at load time. The
// vitest.setup.ts stubs DB env vars so importing is safe; we only need to
// ensure no query is actually issued. The router's flow paths under test
// don't call any task-service functions.

// ── Helper: reset state between tests ────────────────────────────────────────

import type { ResolvedUser } from '../types';

function makeUser(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-worker',
    name: 'דני',
    phone: '972501234567',
    role: 'SALES',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

beforeEach(() => {
  ctxStore = null;
  findOpenTaskFieldForWorker.mockReset();
  writeMissingInfo.mockReset(); writeMissingInfo.mockResolvedValue(undefined);
  writeProblem.mockReset(); writeProblem.mockResolvedValue(undefined);
  notifyOfficeMissingInfo.mockReset(); notifyOfficeMissingInfo.mockResolvedValue(undefined);
  notifyOfficeProblem.mockReset(); notifyOfficeProblem.mockResolvedValue(undefined);
  sendTextMessage.mockReset(); sendTextMessage.mockResolvedValue(undefined);
  setContext.mockClear();
  clearContext.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── Import router lazily so mocks apply ─────────────────────────────────────

async function loadRouter() {
  return await import('../ai/router');
}

// Drive a menu route (calls the internal handleMenuRoute path via the public
// handleAIMessage → menu path). We simulate by pre-seeding a menu awaiting
// state and sending the number reply — matches the real WhatsApp flow.

async function pressMenu(user: ResolvedUser, n: number) {
  const { handleAIMessage } = await loadRouter();
  // Seed a menu awaiting state so the router treats the number as a menu pick.
  ctxStore = { awaiting: 'menu' };
  await handleAIMessage(user, String(n));
}

// ── Missing-info flow (D2-T7) ────────────────────────────────────────────────

describe('D2-T7 — missing info flow via menu item 6', () => {
  it('prompts for the missing detail, captures the reply, writes + notifies', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: 'משה כהן' });

    await pressMenu(user, 6);

    // Prompt sent, awaiting state set.
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][0].text).toBe('מה חסר לדוח?');
    expect(ctxStore).toMatchObject({ awaiting: 'missing_info_note', taskFieldId: 'tf-1' });

    // Worker replies with the note.
    sendTextMessage.mockClear();
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'חסר מספר היתר בנייה');

    expect(writeMissingInfo).toHaveBeenCalledWith({
      taskFieldId: 'tf-1',
      note: 'חסר מספר היתר בנייה',
      updatedBy: user.id,
    });
    expect(notifyOfficeMissingInfo).toHaveBeenCalledWith('tf-1');
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'עדכנתי. המשרד קיבל התראה.' });
  });

  it('no open inspection → "אין לך כרגע בדיקות פתוחות." + no writes', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce(null);
    await pressMenu(user, 6);
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'אין לך כרגע בדיקות פתוחות.' });
    expect(writeMissingInfo).not.toHaveBeenCalled();
  });

  it('ambiguous (>1 open) → captures disambig state without writing', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ ambiguous: true, count: 3 });
    await pressMenu(user, 6);
    expect(ctxStore).toMatchObject({ awaiting: 'missing_info_disambig' });
    expect(writeMissingInfo).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls[0][0].text).toContain('יש לך 3 בדיקות פתוחות');
  });
});

// ── Report-problem flow (D2-T8) ──────────────────────────────────────────────

describe('D2-T8 — report-problem flow via menu item 4', () => {
  it('shows the 7-item sub-menu, sets awaiting=problem_type_choice', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 4);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const menuText = sendTextMessage.mock.calls[0][0].text;
    expect(menuText).toContain('בחר סוג בעיה:');
    expect(menuText).toContain('1. הלקוח לא ענה');
    expect(menuText).toContain('7. אחר');
    expect(ctxStore).toMatchObject({ awaiting: 'problem_type_choice', taskFieldId: 'tf-1' });
  });

  it.each([
    [1, 'CUSTOMER_NOT_ANSWERING'],
    [2, 'NO_ACCESS'],
    [3, 'CUSTOMER_NOT_PRESENT'],
    [4, 'MISSING_EQUIPMENT'],
    [5, 'CANNOT_PERFORM'],
  ])('choice %d writes problemType=%s directly (note=null) + notifies', async (n, problemType) => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 4);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, String(n));

    expect(writeProblem).toHaveBeenCalledWith({
      taskFieldId: 'tf-1',
      problemType,
      note: null,
      updatedBy: user.id,
    });
    expect(notifyOfficeProblem).toHaveBeenCalledWith('tf-1');
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'עדכנתי. המנהל קיבל התראה.' });
  });

  it.each([
    [6, 'PROFESSIONAL_ISSUE'],
    [7, 'OTHER'],
  ])('choice %d prompts for elaboration, then writes problemType=%s with the note', async (n, problemType) => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 4);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, String(n));
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'פרט בבקשה:' });
    expect(ctxStore).toMatchObject({ awaiting: 'problem_type_note', taskFieldId: 'tf-1', problemType });
    expect(writeProblem).not.toHaveBeenCalled();

    sendTextMessage.mockClear();
    await handleAIMessage(user, 'עבודות בנייה מונעות מדידה');

    expect(writeProblem).toHaveBeenCalledWith({
      taskFieldId: 'tf-1',
      problemType,
      note: 'עבודות בנייה מונעות מדידה',
      updatedBy: user.id,
    });
    expect(notifyOfficeProblem).toHaveBeenCalledWith('tf-1');
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'עדכנתי. המנהל קיבל התראה.' });
  });

  it('invalid problem-type choice → resend menu with a "בחר מספר תקין:" prefix, keep awaiting', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 4);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'טקסט לא תקין');

    expect(writeProblem).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls[0][0].text).toContain('בחר מספר תקין:');
    expect(sendTextMessage.mock.calls[0][0].text).toContain('בחר סוג בעיה:');
    expect(ctxStore).toMatchObject({ awaiting: 'problem_type_choice', taskFieldId: 'tf-1' });
  });

  it('no open inspection → "אין לך כרגע בדיקות פתוחות." + no writes', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce(null);
    await pressMenu(user, 4);
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'אין לך כרגע בדיקות פתוחות.' });
    expect(writeProblem).not.toHaveBeenCalled();
  });

  it('ambiguous (>1 open) → captures disambig state without writing', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ ambiguous: true, count: 2 });
    await pressMenu(user, 4);
    expect(ctxStore).toMatchObject({ awaiting: 'problem_disambig' });
    expect(writeProblem).not.toHaveBeenCalled();
  });
});

// ── D5-T3 direct-write intents ───────────────────────────────────────────────

describe('D5-T3 free-text intent dispatch (skips sub-menus)', () => {
  it('report_problem with problem_type → writeProblem directly (no menu)', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-9', customerName: null });

    // Feed the router an executed intent directly via handleAIMessage's fresh
    // path is hard because parseIntent is mocked to throw. Instead we exercise
    // the executeIntent path through a menu-independent seam: seed a menu ctx
    // with intent_confirm + the intent, then reply "כן" to trigger execute.
    // Simpler: import the router's exported function is not possible. So we
    // build a fake intent and invoke via a small helper: import handleAIMessage
    // and use the fresh path — but the mocked parseIntent throws.
    //
    // The clean approach: the D5-T3 tests are already covered by aiSchema tests
    // + the menu-driven flow tests above prove writeProblem is wired. Here we
    // directly assert the shape by using the same underlying call site via a
    // simulated ctx state: seed a menu ctx (awaiting: 'menu') is not right
    // either. Use the intent_confirm path: pre-seed ctx with the intent + YES.
    ctxStore = {
      awaiting: 'intent_confirm',
      intent: {
        intent: 'report_problem',
        confidence: 0.99,
        task_reference: null,
        field: null,
        new_value: null,
        params: { note: 'לא ניתן לגשת לגג' },
        missing_fields: [],
        clarification: null,
        requires_confirmation: false,
        requires_manager_approval: false,
        transition: null,
        problem_type: 'NO_ACCESS',
      },
    };
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'כן');

    expect(writeProblem).toHaveBeenCalledWith({
      taskFieldId: 'tf-9',
      problemType: 'NO_ACCESS',
      note: 'לא ניתן לגשת לגג',
      updatedBy: user.id,
    });
    expect(notifyOfficeProblem).toHaveBeenCalledWith('tf-9');
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'עדכנתי. המנהל קיבל התראה.' });
  });

  it('report_missing_info with note → writeMissingInfo directly (no prompt)', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-9', customerName: null });

    ctxStore = {
      awaiting: 'intent_confirm',
      intent: {
        intent: 'report_missing_info',
        confidence: 0.99,
        task_reference: null,
        field: null,
        new_value: null,
        params: { note: 'טופס דגימה' },
        missing_fields: [],
        clarification: null,
        requires_confirmation: false,
        requires_manager_approval: false,
        transition: null,
        problem_type: null,
      },
    };
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'כן');

    expect(writeMissingInfo).toHaveBeenCalledWith({
      taskFieldId: 'tf-9',
      note: 'טופס דגימה',
      updatedBy: user.id,
    });
    expect(notifyOfficeMissingInfo).toHaveBeenCalledWith('tf-9');
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'עדכנתי. המשרד קיבל התראה.' });
  });

  it('report_problem WITHOUT problem_type falls through to the 7-item sub-menu', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-9', customerName: null });

    ctxStore = {
      awaiting: 'intent_confirm',
      intent: {
        intent: 'report_problem',
        confidence: 0.99,
        task_reference: null,
        field: null,
        new_value: null,
        params: {},
        missing_fields: [],
        clarification: null,
        requires_confirmation: false,
        requires_manager_approval: false,
        transition: null,
        problem_type: null,
      },
    };
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'כן');

    expect(writeProblem).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toContain('בחר סוג בעיה:');
    expect(ctxStore).toMatchObject({ awaiting: 'problem_type_choice', taskFieldId: 'tf-9' });
  });
});
