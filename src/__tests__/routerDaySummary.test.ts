/**
 * D2-T10 — router-level flow tests for the on-demand day summary (menu item 7).
 *
 * Covers:
 *  - Menu item 7 → summary text + 4-option follow-up menu emitted + awaiting
 *    state captured.
 *  - Option 1 (הכל בוצע): acknowledge + clear, NO DB write.
 *  - Option 2 (חסר מידע לדוח): hand off to D2-T7 missing_info_note (or
 *    disambig when multiple TaskFields are open).
 *  - Option 3 (צריך לחזור ללקוח): light flow — prompt for note, notify the
 *    office via notifyOfficeCallbackRequest, no DB write. The worker ack
 *    reflects actual delivery (D5-T19a) — honest failure copy when nobody
 *    was actually reached.
 *  - Option 4 (בעיה פתוחה): hand off to D2-T8 problem_type_choice (or
 *    disambig).
 *  - Invalid choice → resend menu with "בחר מספר תקין:" prefix, keep
 *    awaiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const findOpenTaskFieldForWorker = vi.fn();
const resolveOpenTaskFieldByHint = vi.fn();
const advanceFieldStatus = vi.fn().mockResolvedValue(undefined);
const writeFieldNotes = vi.fn().mockResolvedValue(undefined);
const writeMissingInfo = vi.fn().mockResolvedValue(undefined);
const writeProblem = vi.fn().mockResolvedValue(undefined);
// D5-T19a: notifyOffice* return Promise<boolean> (true = actually delivered
// to a manager) — default to the happy path; tests override per-case.
const notifyOfficeMissingInfo = vi.fn().mockResolvedValue(true);
const notifyOfficeProblem = vi.fn().mockResolvedValue(true);
const notifyOfficeCallbackRequest = vi.fn().mockResolvedValue(true);
const dayFieldSummary = vi.fn();
vi.mock('../services/inspections', () => ({
  findOpenTaskFieldForWorker: (...a: unknown[]) => findOpenTaskFieldForWorker(...a),
  resolveOpenTaskFieldByHint: (...a: unknown[]) => resolveOpenTaskFieldByHint(...a),
  advanceFieldStatus: (...a: unknown[]) => advanceFieldStatus(...a),
  writeFieldNotes: (...a: unknown[]) => writeFieldNotes(...a),
  writeMissingInfo: (...a: unknown[]) => writeMissingInfo(...a),
  writeProblem: (...a: unknown[]) => writeProblem(...a),
  notifyOfficeMissingInfo: (...a: unknown[]) => notifyOfficeMissingInfo(...a),
  notifyOfficeProblem: (...a: unknown[]) => notifyOfficeProblem(...a),
  notifyOfficeCallbackRequest: (...a: unknown[]) => notifyOfficeCallbackRequest(...a),
  dayFieldSummary: (...a: unknown[]) => dayFieldSummary(...a),
}));

const getManagersForBroadcast = vi.fn().mockResolvedValue([]);
vi.mock('../services/pendingActions', () => ({
  getManagersForBroadcast: (...a: unknown[]) => getManagersForBroadcast(...a),
  getLatestPendingForUser: vi.fn().mockResolvedValue(null),
  getPendingApprovals: vi.fn().mockResolvedValue([]),
}));

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
const sendListMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
  sendListMessage:   (...a: unknown[]) => sendListMessage(...a),
}));

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

vi.mock('../services/chatHistory', () => ({
  appendTurn: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue([]),
}));

vi.mock('../ai/provider', () => ({
  getProvider: () => ({ name: 'test' }),
}));

vi.mock('../ai/intentParser', () => ({
  parseIntent: vi.fn().mockRejectedValue(new Error('unused in these tests')),
}));

vi.mock('../utils/auditLog', () => ({
  writeAuditLog: vi.fn().mockResolvedValue('audit-log-id'),
  updateTranscribedMessage: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

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
  // D5-T19a: notifyOffice* return Promise<boolean> — default to true (happy path).
  notifyOfficeMissingInfo.mockReset(); notifyOfficeMissingInfo.mockResolvedValue(true);
  notifyOfficeProblem.mockReset(); notifyOfficeProblem.mockResolvedValue(true);
  notifyOfficeCallbackRequest.mockReset(); notifyOfficeCallbackRequest.mockResolvedValue(true);
  dayFieldSummary.mockReset();
  getManagersForBroadcast.mockReset(); getManagersForBroadcast.mockResolvedValue([]);
  sendTextMessage.mockReset(); sendTextMessage.mockResolvedValue(undefined);
  sendListMessage.mockReset(); sendListMessage.mockResolvedValue(undefined);
  setContext.mockClear();
  clearContext.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function loadRouter() {
  return await import('../ai/router');
}

async function pressMenu(user: ResolvedUser, n: number) {
  const { handleAIMessage } = await loadRouter();
  ctxStore = { awaiting: 'menu' };
  await handleAIMessage(user, String(n));
}

// ── Menu item 7 → summary + follow-up ───────────────────────────────────────

describe('D2-T10 — menu item 7 opens day summary + 4-option follow-up', () => {
  it('emits summary text, then 4-option menu; sets awaiting=day_summary_choice', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({
      finished: [
        {
          taskFieldId: 'tf-1', customerName: 'משה כהן', siteAddress: 'א',
          siteCity: 'רעננה', fieldStatus: 'FINISHED_FIELD', family: 'radiation',
          typeLabelHe: 'קרינה',
        },
      ],
      waitingForInfoCount: 1,
    });

    await pressMenu(user, 7);

    // 1 text message (the summary body) + 1 list message (the follow-up menu).
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const summaryText = sendTextMessage.mock.calls[0][0].text;
    expect(summaryText).toContain('סיכום יום');
    expect(summaryText).toContain('בוצעו: משה כהן (קרינה)');
    expect(summaryText).toContain('ממתינות למידע: 1');

    // Follow-up is now a List Message.
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    const listArg = sendListMessage.mock.calls[0][0];
    expect(listArg.body).toContain('יש מה להשלים?');
    const rows = listArg.sections[0].rows;
    expect(rows.some((r: { id: string; title: string }) => r.title === 'הכל בוצע')).toBe(true);
    expect(rows.some((r: { id: string; title: string }) => r.title === 'חסר מידע לדוח')).toBe(true);
    expect(rows.some((r: { id: string; title: string }) => r.title === 'צריך לחזור ללקוח')).toBe(true);
    expect(rows.some((r: { id: string; title: string }) => r.title === 'בעיה פתוחה')).toBe(true);
    expect(ctxStore).toMatchObject({ awaiting: 'day_summary_choice' });
  });

  it('empty day → summary shows "בוצעו: אין", no waiting line', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    await pressMenu(user, 7);
    const summaryText = sendTextMessage.mock.calls[0][0].text;
    expect(summaryText).toContain('בוצעו: אין');
    expect(summaryText).not.toContain('ממתינות למידע');
  });
});

// ── Option 1: הכל בוצע ──────────────────────────────────────────────────────

describe('D2-T10 — option 1 (הכל בוצע)', () => {
  it('acknowledges + clears; NO DB write of any kind (no FieldWorkerDayClose)', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    await pressMenu(user, 7);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    expect(writeFieldNotes).not.toHaveBeenCalled();
    expect(writeMissingInfo).not.toHaveBeenCalled();
    expect(writeProblem).not.toHaveBeenCalled();
    expect(advanceFieldStatus).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'רשמנו. כל טוב!' });
    expect(ctxStore).toBeNull();
  });
});

// ── Option 2: חסר מידע לדוח → D2-T7 hand-off ────────────────────────────────

describe('D2-T10 — option 2 (חסר מידע לדוח) hands off to D2-T7', () => {
  it('unique open TaskField → prompts "מה חסר לדוח?" + awaiting=missing_info_note', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: 'משה' });
    await pressMenu(user, 7);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '2');

    expect(findOpenTaskFieldForWorker).toHaveBeenCalledWith(user.id);
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'מה חסר לדוח?' });
    expect(ctxStore).toMatchObject({ awaiting: 'missing_info_note', taskFieldId: 'tf-1' });
  });

  it('multi-open → routes to missing_info_disambig (D2-T5 disambig flow)', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ ambiguous: true, count: 3, items: [
      { taskFieldId: 'tf-a', customerName: 'א', siteAddress: null, siteCity: null, scheduledStartAt: null },
      { taskFieldId: 'tf-b', customerName: 'ב', siteAddress: null, siteCity: null, scheduledStartAt: null },
      { taskFieldId: 'tf-c', customerName: 'ג', siteAddress: null, siteCity: null, scheduledStartAt: null },
    ] });
    await pressMenu(user, 7);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '2');

    expect(ctxStore).toMatchObject({ awaiting: 'missing_info_disambig' });
    expect(sendTextMessage.mock.calls[0][0].text).toContain('יש לך 3 בדיקות פתוחות');
  });
});

// ── Option 3: צריך לחזור ללקוח → light callback handler ─────────────────────

describe('D2-T10 — option 3 (צריך לחזור ללקוח) light alert-only flow', () => {
  it('prompts for note → notifies office → clears; NO DB write', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    notifyOfficeCallbackRequest.mockResolvedValueOnce(true);
    await pressMenu(user, 7);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '3');

    // Prompt
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toContain('לאיזה לקוח צריך לחזור');
    expect(ctxStore).toMatchObject({ awaiting: 'callback_customer_note' });

    // Reply with note → notify + ack
    sendTextMessage.mockClear();
    await handleAIMessage(user, 'משה כהן — לתאם בדיקה חוזרת');

    // No DB writes at any point
    expect(writeMissingInfo).not.toHaveBeenCalled();
    expect(writeProblem).not.toHaveBeenCalled();
    expect(writeFieldNotes).not.toHaveBeenCalled();
    expect(advanceFieldStatus).not.toHaveBeenCalled();

    // Office alert dispatched with the correct worker + note
    expect(notifyOfficeCallbackRequest).toHaveBeenCalledWith({
      userId: user.id,
      userName: user.name,
      note: 'משה כהן — לתאם בדיקה חוזרת',
    });

    // Worker ack — honest success copy since the alert actually went out
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'עדכנתי. המשרד קיבל התראה.' });
    expect(ctxStore).toBeNull();
  });

  // D5-T19a regression: previously the worker was told "המשרד קיבל התראה"
  // (the manager was notified) even when delivery failed entirely (e.g. no
  // MANAGER/ADMIN configured, or every send rejected). The ack must now be
  // honest about whether the alert actually reached anyone.
  it('notification fails to reach any manager → honest failure copy, still clears (no crash)', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    notifyOfficeCallbackRequest.mockResolvedValueOnce(false);
    await pressMenu(user, 7);

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '3');
    sendTextMessage.mockClear();
    await handleAIMessage(user, 'לחזור ללקוח X');

    expect(sendTextMessage).toHaveBeenCalledWith({
      to: user.phone,
      text: 'עדכנתי במערכת, אך לא הצלחתי להתריע כרגע — כדאי לוודא ידנית מול המשרד.',
    });
    expect(sendTextMessage).not.toHaveBeenCalledWith({ to: user.phone, text: 'עדכנתי. המשרד קיבל התראה.' });
    expect(ctxStore).toBeNull();
  });

  it('empty callback note → re-prompt, keep awaiting', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    await pressMenu(user, 7);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '3');
    sendTextMessage.mockClear();

    await handleAIMessage(user, '   ');
    expect(sendTextMessage.mock.calls[0][0].text).toContain('לאיזה לקוח צריך לחזור');
    expect(ctxStore).toMatchObject({ awaiting: 'callback_customer_note' });
  });
});

// ── Option 4: בעיה פתוחה → D2-T8 hand-off ───────────────────────────────────

describe('D2-T10 — option 4 (בעיה פתוחה) hands off to D2-T8', () => {
  it('unique open TaskField → shows problem sub-menu + awaiting=problem_type_choice', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: null });
    await pressMenu(user, 7);
    sendListMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '4');

    // Problem-type menu is now a List Message.
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    expect(sendListMessage.mock.calls[0][0].body).toContain('בחר סוג בעיה:');
    expect(ctxStore).toMatchObject({ awaiting: 'problem_type_choice', taskFieldId: 'tf-1' });
  });

  it('multi-open → routes to problem_disambig', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ ambiguous: true, count: 2, items: [
      { taskFieldId: 'tf-a', customerName: 'א', siteAddress: null, siteCity: null, scheduledStartAt: null },
      { taskFieldId: 'tf-b', customerName: 'ב', siteAddress: null, siteCity: null, scheduledStartAt: null },
    ] });
    await pressMenu(user, 7);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '4');

    expect(ctxStore).toMatchObject({ awaiting: 'problem_disambig' });
    expect(sendTextMessage.mock.calls[0][0].text).toContain('יש לך 2 בדיקות פתוחות');
  });
});

// ── Invalid choice ──────────────────────────────────────────────────────────

describe('D2-T10 — out-of-range numeric follow-up choice', () => {
  it('resends the list menu, keeps awaiting', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    await pressMenu(user, 7);
    sendListMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    // Digits pass the free-text escape hatch; "9" is out of the 1-4 range and
    // hits the handler's re-prompt path. Non-numeric replies now escape to AI.
    await handleAIMessage(user, '9');

    expect(writeFieldNotes).not.toHaveBeenCalled();
    expect(writeMissingInfo).not.toHaveBeenCalled();
    expect(writeProblem).not.toHaveBeenCalled();
    // Day-summary follow-up menu is now a List Message — re-sends on invalid input.
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    expect(sendListMessage.mock.calls[0][0].body).toContain('יש מה להשלים?');
    expect(ctxStore).toMatchObject({ awaiting: 'day_summary_choice' });
  });
});
