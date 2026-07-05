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
// D5-T19a: notifyOffice* now return Promise<boolean> (true = actually
// delivered to a manager). Default the mocks to the happy path so existing
// assertions on the success confirmation text keep working; individual
// tests override with mockResolvedValueOnce(false) to exercise the failure copy.
const notifyOfficeMissingInfo = vi.fn().mockResolvedValue(true);
const notifyOfficeProblem = vi.fn().mockResolvedValue(true);
const notifyOfficeMissingEquipment = vi.fn().mockResolvedValue(true);
const dayFieldSummary = vi.fn().mockResolvedValue({ finished: [], waitingForInfoCount: 0 });
const confirmInspection = vi.fn().mockResolvedValue(undefined);
const declineInspection = vi.fn().mockResolvedValue(undefined);
const requestMoreInfo = vi.fn().mockResolvedValue(undefined);
const notifyOfficeDeclined = vi.fn().mockResolvedValue(true);
const notifyOfficeNeedsMoreInfo = vi.fn().mockResolvedValue(true);
vi.mock('../services/inspections', () => ({
  findOpenTaskFieldForWorker: (...a: unknown[]) => findOpenTaskFieldForWorker(...a),
  resolveOpenTaskFieldByHint: (...a: unknown[]) => resolveOpenTaskFieldByHint(...a),
  advanceFieldStatus: (...a: unknown[]) => advanceFieldStatus(...a),
  writeFieldNotes: (...a: unknown[]) => writeFieldNotes(...a),
  writeMissingInfo: (...a: unknown[]) => writeMissingInfo(...a),
  writeProblem: (...a: unknown[]) => writeProblem(...a),
  notifyOfficeMissingInfo: (...a: unknown[]) => notifyOfficeMissingInfo(...a),
  notifyOfficeProblem: (...a: unknown[]) => notifyOfficeProblem(...a),
  notifyOfficeMissingEquipment: (...a: unknown[]) => notifyOfficeMissingEquipment(...a),
  dayFieldSummary: (...a: unknown[]) => dayFieldSummary(...a),
  confirmInspection: (...a: unknown[]) => confirmInspection(...a),
  declineInspection: (...a: unknown[]) => declineInspection(...a),
  requestMoreInfo: (...a: unknown[]) => requestMoreInfo(...a),
  notifyOfficeDeclined: (...a: unknown[]) => notifyOfficeDeclined(...a),
  notifyOfficeNeedsMoreInfo: (...a: unknown[]) => notifyOfficeNeedsMoreInfo(...a),
}));

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
const sendListMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
  sendListMessage:   (...a: unknown[]) => sendListMessage(...a),
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
  // D5-T19a: notifyOffice* return Promise<boolean> — default to the happy
  // path (true) so existing success-copy assertions keep working.
  notifyOfficeMissingInfo.mockReset(); notifyOfficeMissingInfo.mockResolvedValue(true);
  notifyOfficeProblem.mockReset(); notifyOfficeProblem.mockResolvedValue(true);
  notifyOfficeMissingEquipment.mockReset(); notifyOfficeMissingEquipment.mockResolvedValue(true);
  dayFieldSummary.mockReset(); dayFieldSummary.mockResolvedValue({ finished: [], waitingForInfoCount: 0 });
  confirmInspection.mockReset(); confirmInspection.mockResolvedValue(undefined);
  declineInspection.mockReset(); declineInspection.mockResolvedValue(undefined);
  requestMoreInfo.mockReset(); requestMoreInfo.mockResolvedValue(undefined);
  notifyOfficeDeclined.mockReset(); notifyOfficeDeclined.mockResolvedValue(true);
  notifyOfficeNeedsMoreInfo.mockReset(); notifyOfficeNeedsMoreInfo.mockResolvedValue(true);
  sendTextMessage.mockReset(); sendTextMessage.mockResolvedValue(undefined);
  sendListMessage.mockReset(); sendListMessage.mockResolvedValue(undefined);
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
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ ambiguous: true, count: 3, items: [
      { taskFieldId: 'tf-a', customerName: 'א', siteAddress: null, siteCity: null, scheduledStartAt: null },
      { taskFieldId: 'tf-b', customerName: 'ב', siteAddress: null, siteCity: null, scheduledStartAt: null },
      { taskFieldId: 'tf-c', customerName: 'ג', siteAddress: null, siteCity: null, scheduledStartAt: null },
    ] });
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
    // Now sent as a List Message, not numbered text.
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    const listArg = sendListMessage.mock.calls[0][0];
    expect(listArg.body).toContain('בחר סוג בעיה:');
    const rows = listArg.sections[0].rows;
    expect(rows.some((r: { id: string; title: string }) => r.id === 'PROBLEM_TYPE_1')).toBe(true);
    expect(rows.some((r: { id: string; title: string }) => r.title === 'הלקוח לא ענה')).toBe(true);
    expect(rows.some((r: { id: string; title: string }) => r.id === 'PROBLEM_TYPE_7')).toBe(true);
    expect(rows.some((r: { id: string; title: string }) => r.title === 'אחר')).toBe(true);
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

  it('out-of-range numeric problem-type choice → resends the list menu, keep awaiting', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 4);
    sendListMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    // "99" is a digit → passes the numeric-picker escape hatch, reaches the
    // handler, and hits the out-of-range branch. Free text like "טקסט לא תקין"
    // is now intercepted at the top of `continueConversation` and routed to
    // the AI parser instead (v2 UX contract).
    await handleAIMessage(user, '99');

    expect(writeProblem).not.toHaveBeenCalled();
    // Menu is now a List Message — the invalid-input branch re-sends the list.
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    expect(sendListMessage.mock.calls[0][0].body).toContain('בחר סוג בעיה:');
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
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ ambiguous: true, count: 2, items: [
      { taskFieldId: 'tf-a', customerName: 'א', siteAddress: null, siteCity: null, scheduledStartAt: null },
      { taskFieldId: 'tf-b', customerName: 'ב', siteAddress: null, siteCity: null, scheduledStartAt: null },
    ] });
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
    // Problem-type menu is now a List Message.
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    expect(sendListMessage.mock.calls[0][0].body).toContain('בחר סוג בעיה:');
    expect(ctxStore).toMatchObject({ awaiting: 'problem_type_choice', taskFieldId: 'tf-9' });
  });
});

// ── D2-T5 status update flow (menu item 3) ───────────────────────────────────

describe('D2-T5 — status update flow via menu item 3', () => {
  it('shows the 3-item status sub-menu as a List Message, sets awaiting=status_choice', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 3);
    // Now sent as a List Message (hamburger), not numbered text.
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    const listArg = sendListMessage.mock.calls[0][0];
    expect(listArg.body).toContain('עדכון סטטוס בדיקה:');
    const rows = listArg.sections[0].rows;
    expect(rows.some((r: { id: string; title: string }) => r.id === 'STATUS_UPD_1' && r.title === 'יצאתי (בדרך)')).toBe(true);
    expect(rows.some((r: { id: string; title: string }) => r.id === 'STATUS_UPD_2' && r.title === 'הגעתי')).toBe(true);
    expect(rows.some((r: { id: string; title: string }) => r.id === 'STATUS_UPD_3' && r.title === 'סיימתי')).toBe(true);
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
    sendListMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '3');

    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: 'tf-1',
      transition: 'FINISHED',
      updatedBy: user.id,
    });
    // Follow-up menu is now a List Message.
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    const listArg = sendListMessage.mock.calls[0][0];
    expect(listArg.body).toContain('סיימת את הבדיקה. משהו נוסף?');
    const rows = listArg.sections[0].rows;
    expect(rows.some((r: { id: string; title: string }) => r.title === 'אין הערות')).toBe(true);
    expect(rows.some((r: { id: string; title: string }) => r.title === 'חסר מידע לדוח')).toBe(true);
    expect(ctxStore).toMatchObject({ awaiting: 'finished_followup', taskFieldId: 'tf-1' });
  });

  it('out-of-range numeric status choice → resend menu with "בחר מספר תקין:", keep awaiting', async () => {
    const user = makeUser();
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 3);
    sendTextMessage.mockClear();

    sendListMessage.mockClear();
    const { handleAIMessage } = await loadRouter();
    // "9" is a digit → passes the escape hatch, hits the out-of-range branch.
    // The list-message handler re-sends the same List Message (no separate
    // "בחר מספר תקין:" text — the UX for a hamburger is to just reprompt).
    await handleAIMessage(user, '9');

    expect(advanceFieldStatus).not.toHaveBeenCalled();
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    expect(sendListMessage.mock.calls[0][0].body).toContain('עדכון סטטוס בדיקה:');
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
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ ambiguous: true, count: 2, items: [
      { taskFieldId: 'tf-a', customerName: 'א', siteAddress: null, siteCity: null, scheduledStartAt: null },
      { taskFieldId: 'tf-b', customerName: 'ב', siteAddress: null, siteCity: null, scheduledStartAt: null },
    ] });
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
    sendListMessage.mockClear();
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '3');
    // No fresh open-TaskField lookup — we already have tf-1 from the FINISHED write.
    expect(findOpenTaskFieldForWorker).toHaveBeenCalledTimes(1); // only the initial startStatusUpdateFlow call
    // Problem-type menu is now a List Message.
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    expect(sendListMessage.mock.calls[0][0].body).toContain('בחר סוג בעיה:');
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

  it('out-of-range numeric follow-up choice → resends the list menu, keep awaiting', async () => {
    const user = makeUser();
    await reachFinishedFollowUp(user);
    sendListMessage.mockClear();
    const { handleAIMessage } = await loadRouter();
    // Digits pass the escape hatch; free-text goes to AI now.
    await handleAIMessage(user, '9');
    expect(writeFieldNotes).not.toHaveBeenCalled();
    // Follow-up menu is now a List Message — the invalid-input branch re-sends the list.
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    expect(sendListMessage.mock.calls[0][0].body).toContain('סיימת את הבדיקה. משהו נוסף?');
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
    // Follow-up menu is now a List Message.
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    expect(sendListMessage.mock.calls[0][0].body).toContain('סיימת את הבדיקה. משהו נוסף?');
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
    // Problem-type menu is now a List Message.
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    expect(sendListMessage.mock.calls[0][0].body).toContain('בחר סוג בעיה:');
    expect(ctxStore).toMatchObject({ awaiting: 'problem_type_choice', taskFieldId: 'tf-9' });
  });

  it('status_disambig (no pendingTransition) → hint resolves → shows status sub-menu as List Message', async () => {
    const user = makeUser();
    ctxStore = { awaiting: 'status_disambig' };
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-9', customerName: null });
    sendListMessage.mockClear();
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'רעננה');
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    expect(sendListMessage.mock.calls.at(-1)?.[0].body).toContain('עדכון סטטוס בדיקה:');
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

// ── D2-T9: equipment reminder button taps + missing-note flow ────────────────

describe('D2-T9 — equipment reminder handling', () => {
  const USER_ID = '11111111-2222-3333-4444-555555555555';
  const LOCAL_DATE = '2026-07-01';

  function equipUser(): ReturnType<typeof makeUser> {
    return makeUser({ id: USER_ID });
  }

  it('"לקחתי הכל" tap → acks with a positive message and clears context', async () => {
    const user = equipUser();
    ctxStore = null;
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, `EQUIP_ALL_${USER_ID}_${LOCAL_DATE}`);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][0].text).toContain('יום עבודה טוב');
    expect(notifyOfficeMissingEquipment).not.toHaveBeenCalled();
    expect(ctxStore).toBeNull();
  });

  it('"חסר לי ציוד" tap → prompts for the missing-equipment note and sets awaiting state', async () => {
    const user = equipUser();
    ctxStore = null;
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, `EQUIP_MISSING_${USER_ID}_${LOCAL_DATE}`);
    expect(sendTextMessage).toHaveBeenCalledWith({
      to: user.phone,
      text: 'איזה ציוד חסר לך?',
    });
    expect(ctxStore).toMatchObject({
      awaiting: 'equipment_missing_note',
      equipmentLocalDate: LOCAL_DATE,
    });
    expect(notifyOfficeMissingEquipment).not.toHaveBeenCalled();
  });

  it('reply to the "חסר לי ציוד" prompt → notifies managers with the note + local date', async () => {
    const user = equipUser();
    ctxStore = {
      awaiting: 'equipment_missing_note',
      equipmentLocalDate: LOCAL_DATE,
    };
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'חסר לי גלאי ראדון');
    expect(notifyOfficeMissingEquipment).toHaveBeenCalledWith({
      userId: user.id,
      userName: user.name,
      note: 'חסר לי גלאי ראדון',
      localDate: LOCAL_DATE,
    });
    // Ack message + clear.
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toContain('המשרד קיבל התראה');
    expect(ctxStore).toBeNull();
  });

  it('empty reply while awaiting equipment note → re-prompts, does NOT notify', async () => {
    const user = equipUser();
    ctxStore = {
      awaiting: 'equipment_missing_note',
      equipmentLocalDate: LOCAL_DATE,
    };
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '   ');
    expect(notifyOfficeMissingEquipment).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toBe('איזה ציוד חסר לך?');
    // Awaiting state preserved.
    expect(ctxStore).toMatchObject({ awaiting: 'equipment_missing_note' });
  });

  it('tap payload whose embedded userId does not match the caller → silently ignored', async () => {
    const user = equipUser();
    const otherUserId = '99999999-8888-7777-6666-555555555555';
    ctxStore = null;
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, `EQUIP_ALL_${otherUserId}_${LOCAL_DATE}`);
    // No prompt, no state change — the router logged a warn and returned.
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(setContext).not.toHaveBeenCalled();
    expect(notifyOfficeMissingEquipment).not.toHaveBeenCalled();
  });

  it('menu item 5 (חסר ציוד) → opens the same missing-equipment prompt', async () => {
    const user = equipUser();
    await pressMenu(user, 5);
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toBe('איזה ציוד חסר לך?');
    expect(ctxStore).toMatchObject({ awaiting: 'equipment_missing_note' });
    // equipmentLocalDate is set to today (Asia/Jerusalem) — assert format only,
    // not the exact date, so the test is timezone / calendar-stable.
    const local = (ctxStore as { equipmentLocalDate?: string }).equipmentLocalDate ?? '';
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── D2-T3: inspection-card button taps ──────────────────────────────────────

describe('D2-T3 — inspection card button replies', () => {
  const TFID = '11111111-1111-1111-1111-111111111111';

  it('INSP_CONFIRM_* → writes CONFIRMED + ack, clears state', async () => {
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(makeUser(), `INSP_CONFIRM_${TFID}`);
    expect(confirmInspection).toHaveBeenCalledWith({ taskFieldId: TFID, updatedBy: 'u-worker' });
    expect(sendTextMessage.mock.calls[0][0].text).toBe('הבדיקה אושרה. תודה.');
    expect(clearContext).toHaveBeenCalled();
  });

  it('INSP_DECLINE_* → prompts for reason, sets awaiting state (does NOT write yet)', async () => {
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(makeUser(), `INSP_DECLINE_${TFID}`);
    expect(declineInspection).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls[0][0].text).toBe('מדוע אינך יכול להגיע? כתוב סיבה קצרה.');
    expect(ctxStore).toMatchObject({ awaiting: 'inspection_decline_reason', taskFieldId: TFID });
  });

  it('DECLINE flow: reason reply → writes DECLINED + declinedReason + office alert', async () => {
    const { handleAIMessage } = await loadRouter();
    // Step 1: tap decline
    await handleAIMessage(makeUser(), `INSP_DECLINE_${TFID}`);
    sendTextMessage.mockClear();
    // Step 2: reply with reason
    await handleAIMessage(makeUser(), 'הרכב במוסך');
    expect(declineInspection).toHaveBeenCalledWith({
      taskFieldId: TFID,
      reason: 'הרכב במוסך',
      updatedBy: 'u-worker',
    });
    expect(notifyOfficeDeclined).toHaveBeenCalledWith(TFID, 'הרכב במוסך');
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toBe('עדכנתי. המשרד קיבל התראה.');
  });

  it('DECLINE flow: empty reason keeps awaiting state, re-prompts', async () => {
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(makeUser(), `INSP_DECLINE_${TFID}`);
    sendTextMessage.mockClear();
    await handleAIMessage(makeUser(), '   ');
    expect(declineInspection).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls[0][0].text).toBe('מדוע אינך יכול להגיע? כתוב סיבה קצרה.');
    expect(ctxStore).toMatchObject({ awaiting: 'inspection_decline_reason', taskFieldId: TFID });
  });

  it('INSP_NEED_INFO_* → prompts for note, sets awaiting state (does NOT write yet)', async () => {
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(makeUser(), `INSP_NEED_INFO_${TFID}`);
    expect(requestMoreInfo).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls[0][0].text).toBe('אילו פרטים חסרים? כתוב מה צריך.');
    expect(ctxStore).toMatchObject({ awaiting: 'inspection_need_info_note', taskFieldId: TFID });
  });

  it('NEED_INFO flow: note reply → writes NEEDS_MORE_INFO + office alert', async () => {
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(makeUser(), `INSP_NEED_INFO_${TFID}`);
    sendTextMessage.mockClear();
    await handleAIMessage(makeUser(), 'צריך אישור כניסה מוקדם יותר');
    expect(requestMoreInfo).toHaveBeenCalledWith({
      taskFieldId: TFID,
      note: 'צריך אישור כניסה מוקדם יותר',
      updatedBy: 'u-worker',
    });
    expect(notifyOfficeNeedsMoreInfo).toHaveBeenCalledWith(TFID, 'צריך אישור כניסה מוקדם יותר');
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toBe('עדכנתי. המשרד קיבל התראה.');
  });

  it('unrecognized INSP_* payloads do not match — fall through to normal routing', async () => {
    const { handleAIMessage } = await loadRouter();
    // Not a real inspection tap — the AI provider stub means we'll go through
    // parseIntent which is a rejected mock; the router catches and replies.
    await handleAIMessage(makeUser(), 'INSP_FOOBAR_notauuid');
    expect(confirmInspection).not.toHaveBeenCalled();
    expect(declineInspection).not.toHaveBeenCalled();
    expect(requestMoreInfo).not.toHaveBeenCalled();
  });
});
