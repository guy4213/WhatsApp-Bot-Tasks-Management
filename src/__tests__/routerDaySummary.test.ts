/**
 * D2-T10 — router-level flow tests for the on-demand day summary (menu item 7).
 *
 * Covers:
 *  - Menu item 7 → summary text + 4-option follow-up menu emitted + awaiting
 *    state captured.
 *  - Option 1 (הכל בוצע): acknowledge + clear, NO DB write.
 *  - Option 2 (חסר מידע לדוח): hand off to D2-T7 missing_info_note (or
 *    disambig when multiple TaskFields are open).
 *  - Option 3 (צריך לחזור ללקוח): light flow — prompt for note, broadcast
 *    to managers via getManagersForBroadcast, no DB write.
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
const notifyOfficeMissingInfo = vi.fn().mockResolvedValue(undefined);
const notifyOfficeProblem = vi.fn().mockResolvedValue(undefined);
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
  dayFieldSummary: (...a: unknown[]) => dayFieldSummary(...a),
}));

const getManagersForBroadcast = vi.fn().mockResolvedValue([]);
vi.mock('../services/pendingActions', () => ({
  getManagersForBroadcast: (...a: unknown[]) => getManagersForBroadcast(...a),
  getLatestPendingForUser: vi.fn().mockResolvedValue(null),
  getPendingApprovals: vi.fn().mockResolvedValue([]),
}));

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
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
  notifyOfficeMissingInfo.mockReset(); notifyOfficeMissingInfo.mockResolvedValue(undefined);
  notifyOfficeProblem.mockReset(); notifyOfficeProblem.mockResolvedValue(undefined);
  dayFieldSummary.mockReset();
  getManagersForBroadcast.mockReset(); getManagersForBroadcast.mockResolvedValue([]);
  sendTextMessage.mockReset(); sendTextMessage.mockResolvedValue(undefined);
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

    // 2 messages: the summary body + the follow-up menu
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    const summaryText = sendTextMessage.mock.calls[0][0].text;
    expect(summaryText).toContain('סיכום יום');
    expect(summaryText).toContain('בוצעו: משה כהן (קרינה)');
    expect(summaryText).toContain('ממתינות למידע: 1');

    const menuText = sendTextMessage.mock.calls[1][0].text;
    expect(menuText).toContain('יש מה להשלים?');
    expect(menuText).toContain('1. הכל בוצע');
    expect(menuText).toContain('2. חסר מידע לדוח');
    expect(menuText).toContain('3. צריך לחזור ללקוח');
    expect(menuText).toContain('4. בעיה פתוחה');
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
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ ambiguous: true, count: 3 });
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
  it('prompts for note → broadcasts to managers → clears; NO DB write', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    getManagersForBroadcast.mockResolvedValueOnce([
      { id: 'm-1', phone: '9720500000001' },
      { id: 'm-2', phone: '9720500000002' },
    ]);
    await pressMenu(user, 7);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '3');

    // Prompt
    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toContain('לאיזה לקוח צריך לחזור');
    expect(ctxStore).toMatchObject({ awaiting: 'callback_customer_note' });

    // Reply with note → broadcast + ack
    sendTextMessage.mockClear();
    await handleAIMessage(user, 'משה כהן — לתאם בדיקה חוזרת');

    // No DB writes at any point
    expect(writeMissingInfo).not.toHaveBeenCalled();
    expect(writeProblem).not.toHaveBeenCalled();
    expect(writeFieldNotes).not.toHaveBeenCalled();
    expect(advanceFieldStatus).not.toHaveBeenCalled();

    // Broadcast to BOTH managers
    const managerSends = sendTextMessage.mock.calls.filter(
      (c) => c[0].to === '9720500000001' || c[0].to === '9720500000002',
    );
    expect(managerSends).toHaveLength(2);
    for (const call of managerSends) {
      expect(call[0].text).toContain('בקשת חזרה ללקוח');
      expect(call[0].text).toContain(user.name);
      expect(call[0].text).toContain('משה כהן — לתאם בדיקה חוזרת');
    }
    // Worker ack
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'עדכנתי. המשרד קיבל התראה.' });
    expect(ctxStore).toBeNull();
  });

  it('no managers configured → still ACKs + clears (no crash)', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    getManagersForBroadcast.mockResolvedValueOnce([]);
    await pressMenu(user, 7);

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '3');
    sendTextMessage.mockClear();
    await handleAIMessage(user, 'לחזור ללקוח X');

    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'עדכנתי. המשרד קיבל התראה.' });
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
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '4');

    expect(sendTextMessage.mock.calls.at(-1)?.[0].text).toContain('בחר סוג בעיה:');
    expect(ctxStore).toMatchObject({ awaiting: 'problem_type_choice', taskFieldId: 'tf-1' });
  });

  it('multi-open → routes to problem_disambig', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    findOpenTaskFieldForWorker.mockResolvedValueOnce({ ambiguous: true, count: 2 });
    await pressMenu(user, 7);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '4');

    expect(ctxStore).toMatchObject({ awaiting: 'problem_disambig' });
    expect(sendTextMessage.mock.calls[0][0].text).toContain('יש לך 2 בדיקות פתוחות');
  });
});

// ── Invalid choice ──────────────────────────────────────────────────────────

describe('D2-T10 — invalid follow-up choice', () => {
  it('resends menu with "בחר מספר תקין:" prefix, keeps awaiting', async () => {
    const user = makeUser();
    dayFieldSummary.mockResolvedValueOnce({ finished: [], waitingForInfoCount: 0 });
    await pressMenu(user, 7);
    sendTextMessage.mockClear();

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'טקסט לא תקין');

    expect(writeFieldNotes).not.toHaveBeenCalled();
    expect(writeMissingInfo).not.toHaveBeenCalled();
    expect(writeProblem).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls[0][0].text).toContain('בחר מספר תקין:');
    expect(sendTextMessage.mock.calls[0][0].text).toContain('יש מה להשלים?');
    expect(ctxStore).toMatchObject({ awaiting: 'day_summary_choice' });
  });
});
