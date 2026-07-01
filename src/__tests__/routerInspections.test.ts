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
const resolveOpenTaskFieldByHint = vi.fn();
const advanceFieldStatus = vi.fn().mockResolvedValue(undefined);
const writeFieldNotes = vi.fn().mockResolvedValue(undefined);
const writeMissingInfo = vi.fn().mockResolvedValue(undefined);
const writeProblem = vi.fn().mockResolvedValue(undefined);
const notifyOfficeMissingInfo = vi.fn().mockResolvedValue(undefined);
const notifyOfficeProblem = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/inspections', () => ({
  findOpenTaskFieldForWorker: (...a: unknown[]) => findOpenTaskFieldForWorker(...a),
  resolveOpenTaskFieldByHint: (...a: unknown[]) => resolveOpenTaskFieldByHint(...a),
  advanceFieldStatus: (...a: unknown[]) => advanceFieldStatus(...a),
  writeFieldNotes: (...a: unknown[]) => writeFieldNotes(...a),
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
  resolveOpenTaskFieldByHint.mockReset();
  advanceFieldStatus.mockReset(); advanceFieldStatus.mockResolvedValue(undefined);
  writeFieldNotes.mockReset(); writeFieldNotes.mockResolvedValue(undefined);
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

// ── D2-T5 status update flow (menu item 3) ───────────────────────────────────

describe('D2-T5 — status update flow via menu item 3', () => {
  it('shows the 3-item status sub-menu, sets awaiting=status_choice', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 3);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const menuText = sendTextMessage.mock.calls[0][0].text;
    expect(menuText).toContain('עדכון סטטוס בדיקה:');
    expect(menuText).toContain('1. יצאתי (בדרך)');
    expect(menuText).toContain('2. הגעתי');
    expect(menuText).toContain('3. סיימתי');
    expect(ctxStore).toMatchObject({ awaiting: 'status_choice', taskFieldId: 'tf-1' });
  });

  it('choice 1 → DEPARTED write + "בדרך" reply, awaiting cleared', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 3);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: 'tf-1',
      transition: 'DEPARTED',
      updatedBy: user.id,
    });
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toContain('בדרך');
    expect(ctxStore).toBeNull();
  });

  it('choice 2 → ARRIVED write + "באתר" reply', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 3);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '2');

    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: 'tf-1',
      transition: 'ARRIVED',
      updatedBy: user.id,
    });
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toContain('באתר');
    expect(ctxStore).toBeNull();
  });

  it('choice 3 → FINISHED write + follow-up menu emitted + awaiting=finished_followup', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 3);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '3');

    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: 'tf-1',
      transition: 'FINISHED',
      updatedBy: user.id,
    });
    const followUpText = sendTextMessage.mock.calls.at(-1)?.[0].text;
    expect(followUpText).toContain('סיימת את הבדיקה. משהו נוסף?');
    expect(followUpText).toContain('1. אין הערות');
    expect(followUpText).toContain('4. חסר מידע לדוח');
    expect(ctxStore).toMatchObject({ awaiting: 'finished_followup', taskFieldId: 'tf-1' });
  });

  it('invalid status choice → resend menu with "בחר מספר תקין:", keep awaiting', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 3);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'טקסט לא תקין');

    expect(advanceFieldStatus).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls[0][0].text).toContain('בחר מספר תקין:');
    expect(sendTextMessage.mock.calls[0][0].text).toContain('עדכון סטטוס בדיקה:');
    expect(ctxStore).toMatchObject({ awaiting: 'status_choice', taskFieldId: 'tf-1' });
  });

  it('no open inspection → "אין לך כרגע בדיקות פתוחות."', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce(null);
    await pressMenu(user, 3);
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'אין לך כרגע בדיקות פתוחות.' });
    expect(advanceFieldStatus).not.toHaveBeenCalled();
  });

  it('ambiguous → captures status_disambig state', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ ambiguous: true, count: 2 });
    await pressMenu(user, 3);
    expect(ctxStore).toMatchObject({ awaiting: 'status_disambig' });
    expect(sendTextMessage.mock.calls[0][0].text).toContain('יש לך 2 בדיקות פתוחות');
  });
});

// ── D2-T6 finished follow-up (4 options) ─────────────────────────────────────

describe('D2-T6 — finished follow-up menu', () => {
  async function reachFinishedFollowUp(user: ResolvedUser) {
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 3);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '3');
    sendTextMessage.mockClear();
  }

  it('option 1 (אין הערות) → "רשמנו. כל טוב!" + awaiting cleared, no notes write', async () => {
    const user = makeUser();
    await reachFinishedFollowUp(user);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');
    expect(writeFieldNotes).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'רשמנו. כל טוב!' });
    expect(ctxStore).toBeNull();
  });

  it('option 2 (יש הערות מהשטח) → prompts for notes → reply captured via writeFieldNotes', async () => {
    const user = makeUser();
    await reachFinishedFollowUp(user);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '2');
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'מה ההערות מהשטח?' });
    expect(ctxStore).toMatchObject({ awaiting: 'finished_notes', taskFieldId: 'tf-1' });

    sendTextMessage.mockClear();
    await handleAIMessage(user, 'הלקוח ביקש חזרה בשעה 14:00');
    expect(writeFieldNotes).toHaveBeenCalledWith({
      taskFieldId: 'tf-1',
      notes: 'הלקוח ביקש חזרה בשעה 14:00',
      updatedBy: user.id,
    });
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'נשמר. תודה.' });
    expect(ctxStore).toBeNull();
  });

  it('option 3 (יש בעיה) → hands off to D2-T8 problem_type_choice + sub-menu emitted', async () => {
    const user = makeUser();
    await reachFinishedFollowUp(user);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '3');
    // No fresh open-TaskField lookup — we already have tf-1 from the FINISHED write.
    expect(findOpenTaskFieldForWorker).toHaveBeenCalledTimes(1); // only the initial startStatusUpdateFlow call
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toContain('בחר סוג בעיה:');
    expect(ctxStore).toMatchObject({ awaiting: 'problem_type_choice', taskFieldId: 'tf-1' });
  });

  it('option 4 (חסר מידע לדוח) → hands off to D2-T7 missing_info_note', async () => {
    const user = makeUser();
    await reachFinishedFollowUp(user);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '4');
    expect(findOpenTaskFieldForWorker).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'מה חסר לדוח?' });
    expect(ctxStore).toMatchObject({ awaiting: 'missing_info_note', taskFieldId: 'tf-1' });
  });

  it('invalid follow-up choice → resend menu with "בחר מספר תקין:"', async () => {
    const user = makeUser();
    await reachFinishedFollowUp(user);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'משהו');
    expect(writeFieldNotes).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls[0][0].text).toContain('בחר מספר תקין:');
    expect(sendTextMessage.mock.calls[0][0].text).toContain('סיימת את הבדיקה. משהו נוסף?');
    expect(ctxStore).toMatchObject({ awaiting: 'finished_followup', taskFieldId: 'tf-1' });
  });
});

// ── D5-T3 set_field_status intent dispatch ──────────────────────────────────

describe('D5-T3 set_field_status intent → direct advanceFieldStatus', () => {
  function seedSetFieldStatusIntent(transition: string, taskRef: string | null) {
    ctxStore = {
      awaiting: 'intent_confirm',
      intent: {
        intent: 'set_field_status',
        confidence: 0.99,
        task_reference: taskRef,
        field: null,
        new_value: null,
        params: {},
        missing_fields: [],
        clarification: null,
        requires_confirmation: false,
        requires_manager_approval: false,
        transition,
        problem_type: null,
      },
    };
  }

  it('"יצאתי" (no taskRef) → DEPARTED direct write, no menu', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-9', customerName: null });
    seedSetFieldStatusIntent('DEPARTED', null);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'כן');
    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: 'tf-9',
      transition: 'DEPARTED',
      updatedBy: user.id,
    });
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toContain('בדרך');
  });

  it('"יצאתי ללקוח כהן" (taskRef) resolves via resolveOpenTaskFieldByHint → DEPARTED direct write', async () => {
    const user = makeUser();
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-kohen', customerName: 'משה כהן' });
    seedSetFieldStatusIntent('DEPARTED', 'כהן');
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'כן');
    expect(resolveOpenTaskFieldByHint).toHaveBeenCalledWith(user.id, 'כהן');
    expect(findOpenTaskFieldForWorker).not.toHaveBeenCalled();
    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: 'tf-kohen',
      transition: 'DEPARTED',
      updatedBy: user.id,
    });
  });

  it('FINISHED via intent → advanceFieldStatus + follow-up menu opens', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    seedSetFieldStatusIntent('FINISHED', null);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'כן');
    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: 'tf-1',
      transition: 'FINISHED',
      updatedBy: user.id,
    });
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toContain('סיימת את הבדיקה. משהו נוסף?');
    expect(ctxStore).toMatchObject({ awaiting: 'finished_followup', taskFieldId: 'tf-1' });
  });

  it('WAITING_FOR_INFO with note → routes to D2-T7 missing-info direct write', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    ctxStore = {
      awaiting: 'intent_confirm',
      intent: {
        intent: 'set_field_status',
        confidence: 0.99,
        task_reference: null,
        field: null,
        new_value: null,
        params: { note: 'טופס דגימה' },
        missing_fields: [],
        clarification: null,
        requires_confirmation: false,
        requires_manager_approval: false,
        transition: 'WAITING_FOR_INFO',
        problem_type: null,
      },
    };
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'כן');
    expect(writeMissingInfo).toHaveBeenCalledWith({
      taskFieldId: 'tf-1',
      note: 'טופס דגימה',
      updatedBy: user.id,
    });
    expect(advanceFieldStatus).not.toHaveBeenCalled();
  });

  it('HAS_PROBLEM with problem_type → routes to D2-T8 problem direct write', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    ctxStore = {
      awaiting: 'intent_confirm',
      intent: {
        intent: 'set_field_status',
        confidence: 0.99,
        task_reference: null,
        field: null,
        new_value: null,
        params: {},
        missing_fields: [],
        clarification: null,
        requires_confirmation: false,
        requires_manager_approval: false,
        transition: 'HAS_PROBLEM',
        problem_type: 'NO_ACCESS',
      },
    };
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'כן');
    expect(writeProblem).toHaveBeenCalledWith({
      taskFieldId: 'tf-1',
      problemType: 'NO_ACCESS',
      note: null,
      updatedBy: user.id,
    });
    expect(advanceFieldStatus).not.toHaveBeenCalled();
  });
});

// ── D2-T5 disambig hint resolution ──────────────────────────────────────────

describe('D2-T5 — free-text hint resolves ambiguous open TaskField', () => {
  it('missing_info_disambig → hint resolves to unique TaskField → prompts "מה חסר לדוח?"', async () => {
    const user = makeUser();
    ctxStore = { awaiting: 'missing_info_disambig' };
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-9', customerName: 'כהן' });
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'כהן');
    expect(resolveOpenTaskFieldByHint).toHaveBeenCalledWith(user.id, 'כהן');
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'מה חסר לדוח?' });
    expect(ctxStore).toMatchObject({ awaiting: 'missing_info_note', taskFieldId: 'tf-9' });
  });

  it('problem_disambig → hint resolves → prompts problem sub-menu', async () => {
    const user = makeUser();
    ctxStore = { awaiting: 'problem_disambig' };
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-9', customerName: null });
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'רעננה');
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toContain('בחר סוג בעיה:');
    expect(ctxStore).toMatchObject({ awaiting: 'problem_type_choice', taskFieldId: 'tf-9' });
  });

  it('status_disambig (no pendingTransition) → hint resolves → shows status sub-menu', async () => {
    const user = makeUser();
    ctxStore = { awaiting: 'status_disambig' };
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-9', customerName: null });
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'רעננה');
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toContain('עדכון סטטוס בדיקה:');
    expect(ctxStore).toMatchObject({ awaiting: 'status_choice', taskFieldId: 'tf-9' });
  });

  it('status_disambig with pendingTransition=DEPARTED → hint resolves → direct DEPARTED write', async () => {
    const user = makeUser();
    ctxStore = { awaiting: 'status_disambig', pendingTransition: 'DEPARTED' };
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-9', customerName: null });
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'כהן');
    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: 'tf-9',
      transition: 'DEPARTED',
      updatedBy: user.id,
    });
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toContain('בדרך');
    expect(ctxStore).toBeNull();
  });

  it('no match → "לא הצלחתי לזהות" + keep awaiting', async () => {
    const user = makeUser();
    ctxStore = { awaiting: 'missing_info_disambig' };
    resolveOpenTaskFieldByHint.mockResolvedValueOnce(null);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'משהו לא תקין');
    expect(sendTextMessage.mock.calls[0][0].text).toContain('לא הצלחתי לזהות');
    expect(ctxStore).toMatchObject({ awaiting: 'missing_info_disambig' });
    expect(writeMissingInfo).not.toHaveBeenCalled();
  });

  it('"ביטול" clears the disambig state', async () => {
    const user = makeUser();
    ctxStore = { awaiting: 'status_disambig' };
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'ביטול');
    expect(resolveOpenTaskFieldByHint).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'בוטל.' });
    expect(ctxStore).toBeNull();
  });
});
