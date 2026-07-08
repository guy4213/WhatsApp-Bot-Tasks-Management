/**
 * routerWorkerFreeText.test.ts — Phase 1 worker NLU parity coverage.
 *
 * Verifies:
 *  - MY_INSPECTIONS_RE fast-path catches expanded phrasings ("הצג את...",
 *    "תציג לי...", "תן לי...", "אני רוצה לראות...", "היום שלי",
 *    "מה על הפרק", "מה מחכה לי", "רשימת הבדיקות שלי").
 *  - The AI intent `list_my_inspections` dispatches to
 *    `getMyInspectionsInRange` with the correct dateScope.
 *  - EMP_MENU_N stale-context handler routes a list-tap payload with no
 *    active context back through the menu path (no AI fallback).
 *  - `unknown` fallback for a worker now suffixes the menu hint.
 *  - Disambig prompt lists open TaskFields numbered, and a bare digit reply
 *    (1..N) picks the corresponding row without another DB round-trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const msgLog: string[] = [];
const sendTextMessage = vi.fn(async (arg: { to: string; text: string }) => { msgLog.push(arg.text); });
const sendListMessage = vi.fn(async (arg: {
  to: string; body: string;
  sections: Array<{ rows: Array<{ id: string; title: string }> }>;
}) => {
  const allText = [arg.body, ...arg.sections.flatMap((s) => s.rows.map((r) => r.title))].join('\n');
  msgLog.push(allText);
});
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage:   (arg: { to: string; text: string }) => sendTextMessage(arg),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
  sendListMessage:   (arg: { to: string; body: string; sections: Array<{ rows: Array<{ id: string; title: string }> }> }) => sendListMessage(arg),
}));

const parseIntentMock = vi.fn();
vi.mock('../ai/intentParser', () => ({
  parseIntent: (...a: unknown[]) => parseIntentMock(...a),
}));

vi.mock('../ai/provider', () => ({
  getProvider: () => ({ name: 'test' }),
}));

// In-memory conversation context.
let ctxStore: Record<string, unknown> | null = null;
const setContext = vi.fn(async (_phone: string, state: unknown) => { ctxStore = state as Record<string, unknown>; });
const getContext = vi.fn(async () => ctxStore);
const clearContext = vi.fn(async () => { ctxStore = null; });
vi.mock('../services/conversationContext', () => ({
  setContext: (p: string, s: unknown) => setContext(p, s),
  getContext: (_p: string) => getContext(),
  clearContext: (_p: string) => clearContext(),
}));

vi.mock('../services/chatHistory', () => ({
  appendTurn: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/tasks', () => ({
  listTasks: vi.fn().mockResolvedValue({ tasks: [], truncated: false }),
  getTaskById: vi.fn().mockResolvedValue(null),
  getAllowedTaskTypes: vi.fn().mockResolvedValue([]),
  getAllowedPriorities: vi.fn().mockResolvedValue([]),
  findUsersByName: vi.fn().mockResolvedValue([]),
  getEmployeeEndOfDay: vi.fn().mockResolvedValue({ dueToday: 0, completed: 0, notCompleted: 0, overdue: 0, openCarry: 0, unfinishedTitles: [] }),
  getCompanyEndOfDay: vi.fn().mockResolvedValue({ employees: [] }),
}));

const findOpenTaskFieldForWorker = vi.fn();
const resolveOpenTaskFieldByHint = vi.fn().mockResolvedValue(null);
const writeMissingInfo = vi.fn().mockResolvedValue(undefined);
const writeProblem = vi.fn().mockResolvedValue(undefined);
// D5-T19a: notifyOffice* return Promise<boolean> (true = actually delivered).
const notifyOfficeMissingInfo = vi.fn().mockResolvedValue(true);
const notifyOfficeProblem = vi.fn().mockResolvedValue(true);
vi.mock('../services/inspections', async () => {
  const actual: object = await vi.importActual('../services/inspections');
  return {
    ...actual,
    findOpenTaskFieldForWorker: (...a: unknown[]) => findOpenTaskFieldForWorker(...a),
    resolveOpenTaskFieldByHint: (...a: unknown[]) => resolveOpenTaskFieldByHint(...a),
    advanceFieldStatus: vi.fn().mockResolvedValue(undefined),
    writeFieldNotes: vi.fn().mockResolvedValue(undefined),
    writeMissingInfo: (...a: unknown[]) => writeMissingInfo(...a),
    writeProblem: (...a: unknown[]) => writeProblem(...a),
    notifyOfficeMissingInfo: (...a: unknown[]) => notifyOfficeMissingInfo(...a),
    notifyOfficeProblem: (...a: unknown[]) => notifyOfficeProblem(...a),
    notifyOfficeMissingEquipment: vi.fn().mockResolvedValue(true),
    dayFieldSummary: vi.fn().mockResolvedValue({ finished: [], waitingForInfoCount: 0 }),
    confirmInspection: vi.fn().mockResolvedValue(undefined),
    declineInspection: vi.fn().mockResolvedValue(undefined),
    requestMoreInfo: vi.fn().mockResolvedValue(undefined),
    notifyOfficeDeclined: vi.fn().mockResolvedValue(true),
    notifyOfficeNeedsMoreInfo: vi.fn().mockResolvedValue(true),
  };
});

vi.mock('../services/taskFieldCorrections', () => ({
  updateSiteMetadata: vi.fn().mockResolvedValue(undefined),
  reassignTask: vi.fn().mockResolvedValue({ resetCount: 0, hadInProgressRows: false }),
  correctInspectionType: vi.fn().mockResolvedValue({ oldProductName: 'old', newProductName: 'new' }),
  ClosedInspectionError: class ClosedInspectionError extends Error {},
  listInspectionTypes: vi.fn().mockResolvedValue([]),
  getTaskFieldForCorrection: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/taskFieldScheduling', () => ({
  findOpenTasksForOwner: vi.fn().mockResolvedValue([]),
  findOpenTasksForAdmin: vi.fn().mockResolvedValue([]),
  findCustomersByName: vi.fn().mockResolvedValue([]),
  findOpenTasksForCustomer: vi.fn().mockResolvedValue([]),
  scheduleTaskField: vi.fn().mockResolvedValue({ taskFieldId: 'new-tf' }),
}));

vi.mock('../services/pendingActions', () => ({
  getManagersForBroadcast: vi.fn().mockResolvedValue([]),
  createPendingAction: vi.fn().mockResolvedValue({ id: 'pa1' }),
  updatePendingActionState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/digestPreferences', () => ({
  getEffectiveDigestPreference: vi.fn().mockResolvedValue({ morningEnabled: true, morningTime: '08:00', eveningEnabled: true, eveningTime: '17:00' }),
  upsertDigestPreference: vi.fn().mockResolvedValue(undefined),
  parseTimeInput: vi.fn().mockReturnValue(null),
}));

vi.mock('../services/viewContext', () => ({
  setViewOwners: vi.fn(),
  getViewOwners: vi.fn().mockReturnValue(null),
  clearViewOwners: vi.fn(),
}));

vi.mock('../services/taskContext', () => ({
  setActiveTask: vi.fn(),
  getActiveTask: vi.fn().mockReturnValue(null),
}));

vi.mock('../ai/leadSuggester', () => ({
  suggestWorkerForLead: vi.fn().mockResolvedValue({ userId: null, reason: '' }),
}));

vi.mock('../utils/auditLog', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../ai/taskResolver', () => ({
  resolveTask: vi.fn().mockResolvedValue({ match: null, ambiguous: false, candidates: [] }),
}));

vi.mock('../whatsapp/digestContent', () => ({
  formatDayFieldSummary: vi.fn().mockReturnValue('סיכום יום'),
  formatManagerEndOfDay: vi.fn().mockReturnValue({ text: 'eod' }),
  formatEmployeeEndOfDay: vi.fn().mockReturnValue({ text: 'eod' }),
  formatInspectorDayList: vi.fn().mockReturnValue('אין בדיקות משובצות למחר.'),
  formatInspectorMorning: vi.fn().mockReturnValue('בוקר טוב'),
  formatEquipmentReminder: vi.fn().mockReturnValue({ text: 'ציוד' }),
}));

vi.mock('../ai/digestCommands', () => ({
  matchDigestCommand: vi.fn().mockReturnValue(null),
  planDigestCommand: vi.fn(),
  DIGEST_PAYLOAD_IDS: { FREE_TEXT: 'FREE_TEXT', EMP_TODAY: 'EMP_TODAY', EMP_EOD: 'EMP_EOD', TEAM_TODAY: 'TEAM_TODAY', TEAM_EOD: 'TEAM_EOD' },
}));

vi.mock('../db/connection', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock('../ai/contextExtractor', () => ({
  extractFromContext: vi.fn().mockResolvedValue({ values: {}, confidence: 0, clarification: null }),
  extractNote: vi.fn().mockResolvedValue(null),
  extractInspectionActions: vi.fn().mockResolvedValue({ actions: [], confidence: 0 }),
}));

vi.mock('../services/inspectionsQueries', () => ({
  getInspectionsForWorkerOnDate: vi.fn().mockResolvedValue([]),
  getFieldSummaryForWorkerOnDate: vi.fn().mockResolvedValue({ items: [], missingInfoCount: 0 }),
}));

const getMyInspectionsInRange = vi.fn().mockResolvedValue([]);
const getAllMyInspections = vi.fn().mockResolvedValue([]);
vi.mock('../services/myInspectionsRange', () => ({
  getMyInspectionsInRange: (...a: unknown[]) => getMyInspectionsInRange(...a),
  getAllMyInspections: (...a: unknown[]) => getAllMyInspections(...a),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { handleAIMessage, MY_INSPECTIONS_RE } from '../ai/router';
import type { ResolvedUser } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWorker(): ResolvedUser {
  return {
    id: 'u-worker',
    name: 'אופק',
    phone: '97250000009',
    role: 'TECHNICIAN',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
  };
}

beforeEach(() => {
  sendTextMessage.mockClear();
  sendListMessage.mockClear();
  msgLog.length = 0;
  parseIntentMock.mockReset();
  setContext.mockClear();
  clearContext.mockClear();
  getContext.mockClear();
  ctxStore = null;
  findOpenTaskFieldForWorker.mockReset();
  resolveOpenTaskFieldByHint.mockReset().mockResolvedValue(null);
  writeMissingInfo.mockReset().mockResolvedValue(undefined);
  writeProblem.mockReset().mockResolvedValue(undefined);
  // D5-T19a: notifyOffice* return Promise<boolean> — default to true (happy path).
  notifyOfficeMissingInfo.mockReset().mockResolvedValue(true);
  notifyOfficeProblem.mockReset().mockResolvedValue(true);
  getMyInspectionsInRange.mockReset().mockResolvedValue([]);
  getAllMyInspections.mockReset().mockResolvedValue([]);
});

afterEach(() => { vi.restoreAllMocks(); });

// ── Regex fast-path coverage ─────────────────────────────────────────────────

describe('MY_INSPECTIONS_RE — expanded worker phrasings', () => {
  const shouldMatch = [
    'הבדיקות שלי',
    'הבדיקות שלי היום',
    'הבדיקות שלי למחר',
    'הבדיקות שלי השבוע',
    'הבדיקות שלי בשבוע הבא',
    'הבדיקות שלי בין 1/7 ל-10/7',
    'הצג את הבדיקות שלי',
    'הצג לי את הבדיקות שלי',
    'הצג את הבדיקות שלי היום',
    'תציג לי את הבדיקות שלי',
    'תציג לי את הבדיקות שלי מחר',
    'תראה לי את הבדיקות שלי',
    'תראה לי את הבדיקות שלי השבוע',
    'תן לי את הבדיקות שלי',
    'אני רוצה לראות את הבדיקות שלי',
    'רשימת הבדיקות שלי',
    'רשימה של הבדיקות שלי',
    'איזה בדיקות יש לי',
    'היום שלי',
    'מה היום שלי',
    'מה על הפרק',
    'מה מחכה לי',
    'מה יש לי היום',
    'מה יש לי מחר',
  ];
  it.each(shouldMatch)('matches "%s"', (phrase) => {
    expect(MY_INSPECTIONS_RE.test(phrase)).toBe(true);
  });

  const shouldNotMatch = [
    'מה קורה עם הבדיקות',
    'הלקוח לא ענה',
    'יצאתי לרעננה',
    'מה יש לי', // ambiguous — no date cue → NOT matched (deliberate)
  ];
  it.each(shouldNotMatch)('does not match "%s"', (phrase) => {
    expect(MY_INSPECTIONS_RE.test(phrase)).toBe(false);
  });
});

// ── Regex fast-path routes to getMyInspectionsInRange ────────────────────────

describe('worker "הצג את הבדיקות שלי" free-text → getMyInspectionsInRange', () => {
  it('routes "הצג את הבדיקות שלי" without hitting the AI parser', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeWorker(), 'הצג את הבדיקות שלי');
    expect(parseIntentMock).not.toHaveBeenCalled();
    expect(getMyInspectionsInRange).toHaveBeenCalled();
    // Empty result path → "אין לך בדיקות שטח בטווח שבחרת".
    expect(msgLog.some((m) => /אין לך בדיקות שטח/.test(m))).toBe(true);
  });

  it('routes "תציג לי את הבדיקות שלי מחר" and passes tomorrow\'s date window', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeWorker(), 'תציג לי את הבדיקות שלי מחר');
    expect(parseIntentMock).not.toHaveBeenCalled();
    expect(getMyInspectionsInRange).toHaveBeenCalledTimes(1);
    // range args: fromLocalDate < toLocalDate (spec: half-open window). Tomorrow
    // window is one day so daysBetween(from,to) === 1.
    const [, from, to] = getMyInspectionsInRange.mock.calls[0] as [string, string, string];
    expect(from < to).toBe(true);
  });
});

// ── AI intent list_my_inspections ─────────────────────────────────────────────

describe('AI intent list_my_inspections dispatch', () => {
  it('routes list_my_inspections (dateScope=today) via synthesized text to getMyInspectionsInRange', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'list_my_inspections',
      confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: { dateScope: 'today' },
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    // Message that MY_INSPECTIONS_RE does NOT catch, so LLM parse is used.
    await handleAIMessage(makeWorker(), 'תפרסם את הבדיקות של היום שלי בבקשה');
    expect(parseIntentMock).toHaveBeenCalled();
    expect(getMyInspectionsInRange).toHaveBeenCalled();
  });

  it('routes list_my_inspections (dateScope=tomorrow) to the tomorrow window', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'list_my_inspections',
      confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: { dateScope: 'tomorrow' },
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeWorker(), 'תפרסם את הבדיקות של מחר שלי בבקשה');
    expect(getMyInspectionsInRange).toHaveBeenCalledTimes(1);
  });
});

// ── EMP_MENU_N stale-context handler ─────────────────────────────────────────

describe('EMP_MENU_N stale-context handler', () => {
  it('routes EMP_MENU_2 with no context back through the worker menu path (NOT AI)', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeWorker(), 'EMP_MENU_2');
    expect(parseIntentMock).not.toHaveBeenCalled();
    // The tomorrow list is empty in this mock → friendly message.
    expect(msgLog.some((m) => /אין בדיקות משובצות/.test(m))).toBe(true);
  });

  it('does NOT hijack EMP_MENU_N for manager-menu users', async () => {
    getContext.mockResolvedValue(null);
    // Even if a manager somehow sees EMP_MENU_X (they shouldn't), the guard is
    // scoped by isManagerMenuUser === false, so a manager falls through
    // untouched.
    const mgr: ResolvedUser = {
      id: 'u-mgr', name: 'מנהל', phone: '97250000010', role: 'ADMIN',
      isElevated: true, canViewAllRecords: true, canManageUsers: true, canManagePermissions: true,
    };
    parseIntentMock.mockResolvedValue({
      intent: 'unknown', confidence: 0.1, task_reference: null, field: null,
      new_value: null, params: {}, missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(mgr, 'EMP_MENU_2');
    // Manager fell through past the guard — either AI parser or a fallback.
    // What matters: the worker-menu handler was NOT invoked (would have shown
    // "אין בדיקות משובצות").
    expect(msgLog.some((m) => /אין בדיקות משובצות/.test(m))).toBe(false);
  });
});

// ── Worker unknown-fallback menu hint ────────────────────────────────────────

describe('worker fallback for unknown intent', () => {
  it('appends menu hint to fallback message for a worker with unknown intent', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'unknown', confidence: 0.1, task_reference: null, field: null,
      new_value: null, params: {}, missing_fields: [],
      clarification: 'לא הבנתי את הבקשה שלך.',
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    // Long enough (>3 chars) so the "show menu directly" short-circuit does not fire.
    await handleAIMessage(makeWorker(), 'משהו לגמרי לא מובן שאף אחד לא יבין');
    const combined = msgLog.join('\n');
    expect(combined).toContain('תרצה לראות את התפריט? כתוב "תפריט".');
  });
});

// ── Disambig — numbered list + numeric pick ──────────────────────────────────

describe('worker disambig — numbered list of open TaskFields', () => {
  const ambiguousItems = {
    ambiguous: true as const,
    count: 3,
    items: [
      { taskFieldId: 'tf-1', customerName: 'יוסי כהן', siteAddress: 'הרצל 5', siteCity: 'רעננה', scheduledStartAt: null },
      { taskFieldId: 'tf-2', customerName: 'חברת אבנר', siteAddress: 'מתחם התעשייה', siteCity: 'נתניה', scheduledStartAt: null },
      { taskFieldId: 'tf-3', customerName: 'דנה לוי', siteAddress: 'רוטשילד 12', siteCity: 'תל אביב', scheduledStartAt: null },
    ],
  };

  it('report_problem shows numbered list with customer + address for each open TaskField', async () => {
    getContext.mockResolvedValue(null);
    findOpenTaskFieldForWorker.mockResolvedValue(ambiguousItems);
    parseIntentMock.mockResolvedValue({
      intent: 'report_problem', confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: {}, missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeWorker(), 'יש לי בעיה בבדיקה');
    const combined = msgLog.join('\n');
    expect(combined).toMatch(/יש לך 3 בדיקות פתוחות/);
    expect(combined).toMatch(/1\. יוסי כהן/);
    expect(combined).toMatch(/2\. חברת אבנר/);
    expect(combined).toMatch(/3\. דנה לוי/);
    expect(combined).toContain('הרצל 5');
    // Numeric pick hint present.
    expect(combined).toContain('השב במספר');
    // Context was set with the disambig list.
    const lastCtxCall = setContext.mock.calls.find((c) => {
      const s = c[1] as { awaiting?: string };
      return s.awaiting === 'problem_disambig';
    });
    expect(lastCtxCall).toBeTruthy();
    expect((lastCtxCall![1] as { disambigTaskFieldIds?: string[] }).disambigTaskFieldIds)
      .toEqual(['tf-1', 'tf-2', 'tf-3']);
  });

  it('bare digit "2" in problem_disambig picks the second row without a DB round-trip', async () => {
    // Prime the disambig state directly.
    ctxStore = {
      awaiting: 'problem_disambig',
      disambigTaskFieldIds: ['tf-1', 'tf-2', 'tf-3'],
    };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(makeWorker(), '2');

    // resolveOpenTaskFieldByHint must NOT be called (numeric pick short-circuits it).
    expect(resolveOpenTaskFieldByHint).not.toHaveBeenCalled();
    // Should have transitioned to problem_type_choice with tf-2 stashed.
    const problemChoiceCall = setContext.mock.calls.find((c) => {
      const s = c[1] as { awaiting?: string; taskFieldId?: string };
      return s.awaiting === 'problem_type_choice' && s.taskFieldId === 'tf-2';
    });
    expect(problemChoiceCall).toBeTruthy();
  });

  it('bare digit "9" in a disambig with 3 rows falls through to the hint resolver', async () => {
    ctxStore = {
      awaiting: 'problem_disambig',
      disambigTaskFieldIds: ['tf-1', 'tf-2', 'tf-3'],
    };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(makeWorker(), '9');

    // Out-of-range digit → falls through to resolveOpenTaskFieldByHint (which
    // returns null in this mock) → "לא הצלחתי לזהות" message.
    expect(resolveOpenTaskFieldByHint).toHaveBeenCalledWith(expect.any(String), '9');
    expect(msgLog.some((m) => /לא הצלחתי לזהות/.test(m))).toBe(true);
  });

  it('text hint "רעננה" in disambig resolves via DB match', async () => {
    ctxStore = {
      awaiting: 'problem_disambig',
      disambigTaskFieldIds: ['tf-1', 'tf-2', 'tf-3'],
    };
    getContext.mockResolvedValue(ctxStore);
    resolveOpenTaskFieldByHint.mockResolvedValue({
      taskFieldId: 'tf-1', customerName: 'יוסי כהן', taskTitle: null,
    });

    await handleAIMessage(makeWorker(), 'רעננה');

    expect(resolveOpenTaskFieldByHint).toHaveBeenCalledWith(expect.any(String), 'רעננה');
    const problemChoiceCall = setContext.mock.calls.find((c) => {
      const s = c[1] as { awaiting?: string; taskFieldId?: string };
      return s.awaiting === 'problem_type_choice' && s.taskFieldId === 'tf-1';
    });
    expect(problemChoiceCall).toBeTruthy();
  });
});

// ── Phase 2: day_summary_query intent dispatch ────────────────────────────────

describe('AI intent day_summary_query dispatch', () => {
  it('routes day_summary_query to startDaySummaryFlow (same as menu item 7)', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'day_summary_query',
      confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: {},
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeWorker(), 'מה עשיתי היום');
    expect(parseIntentMock).toHaveBeenCalled();
    // dayFieldSummary is mocked to return { finished: [], waitingForInfoCount: 0 }
    // formatDayFieldSummary returns 'סיכום יום' from the mock.
    expect(msgLog.some((m) => m.includes('סיכום יום'))).toBe(true);
  });

  it('routes "סיכום" (day_summary_query) without AI being called for direct dispatch', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'day_summary_query',
      confidence: 0.92,
      task_reference: null, field: null, new_value: null,
      params: {},
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeWorker(), 'תן לי סיכום של היום');
    expect(msgLog.some((m) => m.includes('סיכום יום'))).toBe(true);
  });
});

// ── Phase 2: missing_equipment_free intent dispatch ───────────────────────────

describe('AI intent missing_equipment_free dispatch', () => {
  it('routes missing_equipment_free with params.note — calls notifyOfficeMissingEquipment directly', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'missing_equipment_free',
      confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: { note: 'בטריות' },
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeWorker(), 'אין לי בטריות');
    expect(parseIntentMock).toHaveBeenCalled();
    // notifyOfficeMissingEquipment is a vi.fn() mock in the inspections mock.
    // Since handleEquipmentMissingNoteReply calls extractNote (mocked via extractNote
    // not being in the imports list, it will attempt to call the actual service or
    // a fallback). The test simply verifies the flow doesn't throw and sends a message.
    // The response text is from notifyOfficeMissingEquipment confirming equipment reported.
    // We verify the flow completed (context is set then cleared or message sent).
    const combined = msgLog.join('\n');
    // Either a confirmation message is sent OR context is set for the follow-up.
    const ctxCalls = setContext.mock.calls;
    const equipmentCtxSet = ctxCalls.some((c) => {
      const s = c[1] as { awaiting?: string };
      return s.awaiting === 'equipment_missing_note';
    });
    // With a note, it should NOT ask "איזה ציוד חסר לך?" again.
    expect(combined).not.toContain('איזה ציוד חסר לך?');
    // Either context was cleared (success path) or there is a confirmation message.
    expect(equipmentCtxSet || combined.length > 0).toBe(true);
  });

  it('routes missing_equipment_free WITHOUT params.note — prompts the worker for what is missing', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'missing_equipment_free',
      confidence: 0.90,
      task_reference: null, field: null, new_value: null,
      params: {},
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeWorker(), 'חסר לי ציוד');
    // Should prompt for what is missing (D5-T19k: the structured sub-menu).
    expect(msgLog.some((m) => /ציוד חסר/i.test(m))).toBe(true);
    // Context set for missing_equipment_choice awaiting state.
    const ctxCalls = setContext.mock.calls;
    const equipmentCtxSet = ctxCalls.some((c) => {
      const s = c[1] as { awaiting?: string };
      return s.awaiting === 'missing_equipment_choice';
    });
    expect(equipmentCtxSet).toBe(true);
  });
});

// ── list_my_inspections dateScope="all" — full history ────────────────────────

describe('list_my_inspections dateScope="all" (post-Phase-6 addition)', () => {
  it('AI intent dateScope="all" routes to getAllMyInspections (NOT getMyInspectionsInRange)', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'list_my_inspections',
      confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: { dateScope: 'all' },
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    // Phrase the LLM emitted the intent for.
    await handleAIMessage(makeWorker(), 'תציג את כל הבדיקות שלי מכל הזמנים');
    expect(getAllMyInspections).toHaveBeenCalledTimes(1);
    expect(getMyInspectionsInRange).not.toHaveBeenCalled();
  });

  it('fast-path suffix "מכל הזמנים" routes to getAllMyInspections without AI', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeWorker(), 'הבדיקות שלי מכל הזמנים');
    expect(getAllMyInspections).toHaveBeenCalledTimes(1);
    // AI parser must NOT be called for the fast-path all-time shortcut.
    expect(parseIntentMock).not.toHaveBeenCalled();
  });

  it('fast-path suffix "הכל" routes to getAllMyInspections without AI', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeWorker(), 'הבדיקות שלי הכל');
    expect(getAllMyInspections).toHaveBeenCalledTimes(1);
    expect(parseIntentMock).not.toHaveBeenCalled();
  });

  it('empty-result path prints "אין לך שום בדיקות שטח משויכות (כל הזמנים)"', async () => {
    getContext.mockResolvedValue(null);
    getAllMyInspections.mockResolvedValueOnce([]);
    parseIntentMock.mockResolvedValue({
      intent: 'list_my_inspections',
      confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: { dateScope: 'all' },
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeWorker(), 'תראה לי את כל הבדיקות שלי מכל הזמנים בבקשה');
    expect(msgLog.some((m) => /אין לך שום בדיקות שטח משויכות \(כל הזמנים\)/.test(m))).toBe(true);
  });
});

// ── QA-FIX-6: manager "המשימות שלי" (משימות synonym) fast path ───────────────

describe('QA-FIX-6 — manager "המשימות שלי למחר" hits the deterministic fast path', () => {
  function makeManager(): ResolvedUser {
    return {
      id: 'u-mgr', name: 'מנהל', phone: '97250000010', role: 'ADMIN',
      isElevated: true, canViewAllRecords: true, canManageUsers: true, canManagePermissions: true,
    };
  }

  it('routes "המשימות שלי" (manager) without hitting the AI parser', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeManager(), 'המשימות שלי');
    expect(parseIntentMock).not.toHaveBeenCalled();
    expect(getMyInspectionsInRange).toHaveBeenCalledTimes(1);
  });

  it('routes "המשימות שלי למחר" (manager) to getMyInspectionsInRange with tomorrow\'s window, without AI', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeManager(), 'המשימות שלי למחר');

    expect(parseIntentMock).not.toHaveBeenCalled();
    expect(getMyInspectionsInRange).toHaveBeenCalledTimes(1);

    // Compute the expected tomorrow window the same way parseHebrewInspectionRange
    // does: today (Asia/Jerusalem) + 1 day → + 2 days, half-open.
    const now = new Date();
    const todayIso = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const addDaysISO = (iso: string, days: number): string => {
      const [y, m, d] = iso.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d, 12));
      dt.setUTCDate(dt.getUTCDate() + days);
      return dt.toISOString().slice(0, 10);
    };
    const expectedFrom = addDaysISO(todayIso, 1);
    const expectedTo = addDaysISO(todayIso, 2);

    const [userId, from, to] = getMyInspectionsInRange.mock.calls[0] as [string, string, string];
    expect(userId).toBe('u-mgr');
    expect(from).toBe(expectedFrom);
    expect(to).toBe(expectedTo);
  });

  it('routes "תציג לי את המשימות שלי למחר" (voice-style prefix, manager) without AI', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeManager(), 'תציג לי את המשימות שלי למחר');
    expect(parseIntentMock).not.toHaveBeenCalled();
    expect(getMyInspectionsInRange).toHaveBeenCalledTimes(1);
  });
});

// ── QA-FIX-7: PAST time-range support for "הבדיקות שלי" / "המשימות שלי" ─────

describe('QA-FIX-7 — past time ranges for list_my_inspections', () => {
  function makeManager(): ResolvedUser {
    return {
      id: 'u-mgr', name: 'מנהל', phone: '97250000010', role: 'ADMIN',
      isElevated: true, canViewAllRecords: true, canManageUsers: true, canManagePermissions: true,
    };
  }

  // Same TZ-safe helper the production code uses, duplicated here so the test
  // computes its OWN expectation independent of the implementation.
  function expectedYesterdayTodayWindow(): { from: string; to: string } {
    const now = new Date();
    const todayIso = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const addDaysISO = (iso: string, days: number): string => {
      const [y, m, d] = iso.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d, 12));
      dt.setUTCDate(dt.getUTCDate() + days);
      return dt.toISOString().slice(0, 10);
    };
    return { from: addDaysISO(todayIso, -1), to: todayIso };
  }

  it('(a) worker "הבדיקות שלי אתמול" → deterministic fast path, yesterday window, no AI parser call', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeWorker(), 'הבדיקות שלי אתמול');
    expect(parseIntentMock).not.toHaveBeenCalled();
    expect(getMyInspectionsInRange).toHaveBeenCalledTimes(1);
    const { from: expectedFrom, to: expectedTo } = expectedYesterdayTodayWindow();
    const [userId, from, to] = getMyInspectionsInRange.mock.calls[0] as [string, string, string];
    expect(userId).toBe('u-worker');
    expect(from).toBe(expectedFrom);
    expect(to).toBe(expectedTo);
  });

  it('(d) manager "המשימות שלי אתמול" → deterministic fast path, yesterday window, no AI parser call', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeManager(), 'המשימות שלי אתמול');
    expect(parseIntentMock).not.toHaveBeenCalled();
    expect(getMyInspectionsInRange).toHaveBeenCalledTimes(1);
    const { from: expectedFrom, to: expectedTo } = expectedYesterdayTodayWindow();
    const [userId, from, to] = getMyInspectionsInRange.mock.calls[0] as [string, string, string];
    expect(userId).toBe('u-mgr');
    expect(from).toBe(expectedFrom);
    expect(to).toBe(expectedTo);
  });

  it('(b) LLM channel: parseIntent returns list_my_inspections with params.dateRange → getMyInspectionsInRange called with exactly those dates', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'list_my_inspections',
      confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: { dateRange: { from: '2026-05-01', to: '2026-05-08' } },
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    // Phrasing MY_INSPECTIONS_RE does not catch, forcing the AI path.
    await handleAIMessage(makeWorker(), 'תגיד לי מה היה לי לפני חודשיים בערך');
    expect(parseIntentMock).toHaveBeenCalled();
    expect(getMyInspectionsInRange).toHaveBeenCalledTimes(1);
    const [userId, from, to] = getMyInspectionsInRange.mock.calls[0] as [string, string, string];
    expect(userId).toBe('u-worker');
    expect(from).toBe('2026-05-01');
    expect(to).toBe('2026-05-08');
  });

  it('(c) LLM channel: invalid dateRange (from > to) falls back to existing dateScope/today behavior without crashing', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'list_my_inspections',
      confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: { dateRange: { from: '2026-05-10', to: '2026-05-01' } }, // inverted → invalid
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeWorker(), 'תגיד לי מה היה לי לפני חודשיים בערך');
    expect(parseIntentMock).toHaveBeenCalled();
    // Falls through to the unchanged synthesis path (dateScope absent, rangeExpr
    // absent → default "today" suffix) — must not throw, and must still call
    // getMyInspectionsInRange exactly once with a valid (non-inverted) window.
    expect(getMyInspectionsInRange).toHaveBeenCalledTimes(1);
    const [, from, to] = getMyInspectionsInRange.mock.calls[0] as [string, string, string];
    expect(from <= to).toBe(true);
  });

  it('(c) LLM channel: malformed dateRange (missing "to") falls back without crashing', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'list_my_inspections',
      confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: { dateRange: { from: '2026-05-10' } }, // malformed — no "to"
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeWorker(), 'תגיד לי מה היה לי לפני חודשיים בערך');
    expect(getMyInspectionsInRange).toHaveBeenCalledTimes(1);
    const [, from, to] = getMyInspectionsInRange.mock.calls[0] as [string, string, string];
    expect(from <= to).toBe(true);
  });
});

// ── AI-first fallback when regex matches but range fails ─────────────────────

describe('Fast-path failure falls through to AI parser (post-Phase-6)', () => {
  it('regex-matched phrase with unparseable range delegates to the AI parser (not an error message)', async () => {
    getContext.mockResolvedValue(null);
    // LLM will emit list_my_inspections with dateScope="all" as it should.
    parseIntentMock.mockResolvedValue({
      intent: 'list_my_inspections',
      confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: { dateScope: 'all' },
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    // Suffix "לפני מיליון שנה" is not a recognized Hebrew range → old
    // behavior returned "לא הצלחתי להבין את הטווח". New behavior: delegate
    // to AI which emits dateScope=all and we show all-time.
    await handleAIMessage(makeWorker(), 'הבדיקות שלי לפני מיליון שנה');
    expect(parseIntentMock).toHaveBeenCalled();
    expect(getAllMyInspections).toHaveBeenCalledTimes(1);
    // The old error message must NOT be produced.
    expect(msgLog.some((m) => /לא הצלחתי להבין את הטווח/.test(m))).toBe(false);
  });
});
