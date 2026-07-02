/**
 * routerManagerIntents.test.ts
 *
 * Asserts that each of the 7 new manager-facing intents, when dispatched via
 * executeIntent (through handleAIMessage with high-confidence mock), calls the
 * corresponding manager menu handler.
 *
 * Pattern: the test sets up parseIntent to return a specific high-confidence
 * manager intent, then calls handleAIMessage. We assert on:
 *  - The handler function that was called (via mocked service)
 *  - The message sent to the user
 *  - The awaiting context state
 *
 * Auth: manager intents reject non-manager users with "אין הרשאה".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks declared before imports ─────────────────────────────────────────────

const getManagementSnapshot = vi.fn();
const getTodayFieldInspections = vi.fn();
const getFieldExceptionRows = vi.fn();
const getAllWorkersDayOverview = vi.fn();
const getWorkerDayDetail = vi.fn();
const searchTasksByWorkerName = vi.fn();
const searchTasksByProductCode = vi.fn();
const getTaskFieldDetail = vi.fn();

vi.mock('../services/managerViews', () => ({
  getManagementSnapshot: (...a: unknown[]) => getManagementSnapshot(...a),
  getTodayFieldInspections: (...a: unknown[]) => getTodayFieldInspections(...a),
  getFieldExceptionRows: (...a: unknown[]) => getFieldExceptionRows(...a),
  getAllWorkersDayOverview: (...a: unknown[]) => getAllWorkersDayOverview(...a),
  getWorkerDayDetail: (...a: unknown[]) => getWorkerDayDetail(...a),
  searchTasksByWorkerName: (...a: unknown[]) => searchTasksByWorkerName(...a),
  searchTasksByProductCode: (...a: unknown[]) => searchTasksByProductCode(...a),
  getTaskFieldDetail: (...a: unknown[]) => getTaskFieldDetail(...a),
}));

vi.mock('../services/incomingLeads', () => ({
  findUnassignedLeadsForAssignment: vi.fn().mockResolvedValue([]),
  findActiveInspectors: vi.fn().mockResolvedValue([]),
  assignLead: vi.fn().mockResolvedValue(undefined),
  findUnassignedInWindow: vi.fn().mockResolvedValue([]),
  findOvernightUnassignedLeads: vi.fn().mockResolvedValue([]),
  findNewlyAssignedLeads: vi.fn().mockResolvedValue([]),
  findEscalationCandidates: vi.fn().mockResolvedValue([]),
  getYoramLeadCounts: vi.fn().mockResolvedValue({ overnight: 0, unassigned: 0 }),
}));

const msgLogIntents: string[] = [];
const sendTextMessage = vi.fn(async (arg: { to: string; text: string }) => { msgLogIntents.push(arg.text); });
const sendListMessage = vi.fn(async (arg: {
  to: string; body: string;
  sections: Array<{ rows: Array<{ id: string; title: string }> }>;
}) => {
  const allText = [arg.body, ...arg.sections.flatMap((s) => s.rows.map((r) => r.title))].join('\n');
  msgLogIntents.push(allText);
});
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage:   (arg: { to: string; text: string }) => sendTextMessage(arg),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
  sendListMessage:   (arg: { to: string; body: string; sections: Array<{ rows: Array<{ id: string; title: string }> }> }) => sendListMessage(arg),
}));

let ctxStore: Record<string, unknown> | null = null;
const setContext = vi.fn(async (_phone: string, state: unknown) => { ctxStore = state as Record<string, unknown>; });
const getContext = vi.fn(async () => null); // fresh message = no context
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

// parseIntent mock — controlled per-test via mockParseIntent below
const parseIntentMock = vi.fn();
vi.mock('../ai/intentParser', () => ({
  parseIntent: (...a: unknown[]) => parseIntentMock(...a),
  buildSystemPrompt: vi.fn().mockReturnValue(''),
}));

vi.mock('../ai/provider', () => ({
  getProvider: () => ({ name: 'test' }),
}));

vi.mock('../ai/taskResolver', () => ({
  resolveTask: vi.fn().mockResolvedValue({ match: null, ambiguous: false, candidates: [] }),
}));

vi.mock('../services/inspections', () => ({
  findOpenTaskFieldForWorker: vi.fn().mockResolvedValue(null),
  resolveOpenTaskFieldByHint: vi.fn().mockResolvedValue(null),
  advanceFieldStatus: vi.fn().mockResolvedValue(undefined),
  writeFieldNotes: vi.fn().mockResolvedValue(undefined),
  writeMissingInfo: vi.fn().mockResolvedValue(undefined),
  writeProblem: vi.fn().mockResolvedValue(undefined),
  notifyOfficeMissingInfo: vi.fn().mockResolvedValue(undefined),
  notifyOfficeProblem: vi.fn().mockResolvedValue(undefined),
  notifyOfficeMissingEquipment: vi.fn().mockResolvedValue(undefined),
  dayFieldSummary: vi.fn().mockResolvedValue({ finished: [], waitingForInfoCount: 0 }),
  confirmInspection: vi.fn().mockResolvedValue(undefined),
  declineInspection: vi.fn().mockResolvedValue(undefined),
  requestMoreInfo: vi.fn().mockResolvedValue(undefined),
  notifyOfficeDeclined: vi.fn().mockResolvedValue(undefined),
  notifyOfficeNeedsMoreInfo: vi.fn().mockResolvedValue(undefined),
}));

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

vi.mock('../services/tasks', () => ({
  listTasks: vi.fn().mockResolvedValue({ tasks: [], truncated: false }),
  getTaskById: vi.fn().mockResolvedValue(null),
  getAllowedTaskTypes: vi.fn().mockResolvedValue([]),
  getAllowedPriorities: vi.fn().mockResolvedValue([]),
  findUsersByName: vi.fn().mockResolvedValue([]),
  getEmployeeEndOfDay: vi.fn().mockResolvedValue({ dueToday: 0, completed: 0, notCompleted: 0, overdue: 0, openCarry: 0, unfinishedTitles: [] }),
  getCompanyEndOfDay: vi.fn().mockResolvedValue({ employees: [] }),
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

vi.mock('../whatsapp/digestContent', () => ({
  formatDayFieldSummary: vi.fn().mockReturnValue('סיכום יום'),
  formatManagerEndOfDay: vi.fn().mockReturnValue({ text: 'eod' }),
  formatEmployeeEndOfDay: vi.fn().mockReturnValue({ text: 'eod' }),
  formatInspectorDayList: vi.fn().mockReturnValue('רשימת בדיקות'),
}));

vi.mock('../ai/digestCommands', () => ({
  matchDigestCommand: vi.fn().mockReturnValue(null),
  planDigestCommand: vi.fn(),
  DIGEST_PAYLOAD_IDS: { FREE_TEXT: 'FREE_TEXT', EMP_TODAY: 'EMP_TODAY', EMP_EOD: 'EMP_EOD', TEAM_TODAY: 'TEAM_TODAY', TEAM_EOD: 'TEAM_EOD' },
}));

vi.mock('../db/connection', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock('../services/inspectionsQueries', () => ({
  getInspectionsForWorkerOnDate: vi.fn().mockResolvedValue([]),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { handleAIMessage } from '../ai/router';
import type { ResolvedUser } from '../types';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeManager(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-admin',
    name: 'מנהל',
    phone: '97250000001',
    role: 'ADMIN',
    isElevated: true,
    canViewAllRecords: true,
    canManageUsers: true,
    canManagePermissions: true,
    ...overrides,
  };
}

function makeWorker(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-worker',
    name: 'דני',
    phone: '97250000002',
    role: 'TECHNICIAN',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

/** Build a high-confidence AIIntentResult stub */
function makeIntent(
  intent: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    intent,
    confidence: 0.95,
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
    ...extras,
  };
}

function mockParseIntent(result: Record<string, unknown>): void {
  parseIntentMock.mockResolvedValue(result);
}

function lastMsg(): string {
  return msgLogIntents[msgLogIntents.length - 1] ?? '';
}

const admin = makeManager();
const worker = makeWorker();

beforeEach(() => {
  sendTextMessage.mockClear();
  sendListMessage.mockClear();
  msgLogIntents.length = 0;
  setContext.mockClear();
  clearContext.mockClear();
  getContext.mockClear();
  parseIntentMock.mockClear();
  ctxStore = null;
  getManagementSnapshot.mockReset();
  getTodayFieldInspections.mockReset();
  getFieldExceptionRows.mockReset();
  getAllWorkersDayOverview.mockReset();
  getWorkerDayDetail.mockReset();
  searchTasksByWorkerName.mockReset();
  searchTasksByProductCode.mockReset();
  getTaskFieldDetail.mockReset();
});

afterEach(() => { vi.restoreAllMocks(); });

// ── open_manager_menu ─────────────────────────────────────────────────────────

describe('intent: open_manager_menu', () => {
  it('shows manager menu for an ADMIN user', async () => {
    mockParseIntent(makeIntent('open_manager_menu'));
    await handleAIMessage(admin, 'תפריט');
    expect(lastMsg()).toContain('שלום, מה תרצה לעשות?');
    expect(lastMsg()).toContain('תמונת מצב ניהולית');
  });

  it('rejects a non-manager user with "אין הרשאה"', async () => {
    // Use "תן לי את התפריט" which does NOT match MENU_TRIGGER_RE (anchored to short words)
    // so the intent parse path is reached.
    mockParseIntent(makeIntent('open_manager_menu'));
    await handleAIMessage(worker, 'תן לי את התפריט');
    expect(lastMsg()).toContain('אין הרשאה');
  });
});

// ── management_snapshot ───────────────────────────────────────────────────────

describe('intent: management_snapshot', () => {
  it('calls getManagementSnapshot and renders the snapshot text', async () => {
    getManagementSnapshot.mockResolvedValue({
      today: { total: 8, finished: 5, inProgress: 2, pending: 1 },
      openExceptions: 3,
      leads: { totalOpen: 6, overnight: 2, escalated: 1 },
    });
    mockParseIntent(makeIntent('management_snapshot'));
    await handleAIMessage(admin, 'מה קורה');
    expect(getManagementSnapshot).toHaveBeenCalled();
    const msg = lastMsg();
    expect(msg).toContain('תמונת מצב');
    expect(msg).toContain('8');   // total
    expect(msg).toContain('3');   // openExceptions
    expect(msg).toContain('6');   // totalOpen leads
  });

  it('clears context after snapshot (one-shot)', async () => {
    getManagementSnapshot.mockResolvedValue({
      today: { total: 0, finished: 0, inProgress: 0, pending: 0 },
      openExceptions: 0,
      leads: { totalOpen: 0, overnight: 0, escalated: 0 },
    });
    mockParseIntent(makeIntent('management_snapshot'));
    await handleAIMessage(admin, 'תמונת מצב');
    expect(clearContext).toHaveBeenCalled();
  });

  it('rejects non-manager with "אין הרשאה"', async () => {
    mockParseIntent(makeIntent('management_snapshot'));
    await handleAIMessage(worker, 'מה קורה');
    expect(lastMsg()).toContain('אין הרשאה');
    expect(getManagementSnapshot).not.toHaveBeenCalled();
  });
});

// ── list_today_field_inspections ───────────────────────────────────────────────

describe('intent: list_today_field_inspections', () => {
  it('calls getTodayFieldInspections and shows numbered list', async () => {
    getTodayFieldInspections.mockResolvedValue([
      { taskFieldId: 'tf1', taskId: 't1', workerName: 'דני', customerName: 'לקוח א', timeHm: '09:00', siteCity: 'רעננה', fieldStatus: 'CONFIRMED', family: 'noise', typeLabelHe: 'רעש' },
      { taskFieldId: 'tf2', taskId: 't2', workerName: 'יוסי', customerName: 'לקוח ב', timeHm: '11:00', siteCity: 'הרצליה', fieldStatus: 'EN_ROUTE', family: 'radiation', typeLabelHe: 'קרינה' },
    ]);
    mockParseIntent(makeIntent('list_today_field_inspections'));
    await handleAIMessage(admin, 'תציג לי את בדיקות השטח להיום');
    expect(getTodayFieldInspections).toHaveBeenCalled();
    const msg = lastMsg();
    expect(msg).toContain('שם עובד: דני');
    expect(msg).toContain('שם עובד: יוסי');
  });

  it('sets awaiting to mgr_today_pick_task with task ids', async () => {
    getTodayFieldInspections.mockResolvedValue([
      { taskFieldId: 'tf1', taskId: 't1', workerName: 'דני', customerName: 'לקוח', timeHm: '09:00', siteCity: 'עיר', fieldStatus: 'CONFIRMED', family: 'noise', typeLabelHe: 'רעש' },
    ]);
    mockParseIntent(makeIntent('list_today_field_inspections'));
    await handleAIMessage(admin, 'רשימת בדיקות היום');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_today_pick_task', mgrTaskFieldIds: ['tf1'] });
  });

  it('sends "no inspections" message when list is empty', async () => {
    getTodayFieldInspections.mockResolvedValue([]);
    mockParseIntent(makeIntent('list_today_field_inspections'));
    await handleAIMessage(admin, 'מה יש היום');
    expect(lastMsg()).toMatch(/אין בדיקות/);
  });

  it('rejects non-manager with "אין הרשאה"', async () => {
    mockParseIntent(makeIntent('list_today_field_inspections'));
    await handleAIMessage(worker, 'בדיקות היום');
    expect(lastMsg()).toContain('אין הרשאה');
    expect(getTodayFieldInspections).not.toHaveBeenCalled();
  });
});

// ── list_open_exceptions ──────────────────────────────────────────────────────

describe('intent: list_open_exceptions', () => {
  const exceptionRows = [
    { taskFieldId: 'tf3', taskId: 't3', workerName: 'דני', customerName: 'לקוח',
      siteCity: 'ת"א', fieldStatus: 'HAS_PROBLEM', description: 'לקוח לא ענה' },
  ];

  it('with filter=open calls getFieldExceptionRows("open_exceptions")', async () => {
    getFieldExceptionRows.mockResolvedValue(exceptionRows);
    mockParseIntent(makeIntent('list_open_exceptions', { params: { filter: 'open' } }));
    await handleAIMessage(admin, 'תציג את החריגים');
    expect(getFieldExceptionRows).toHaveBeenCalledWith(expect.any(String), 'open_exceptions');
  });

  it('with filter=has_problem calls getFieldExceptionRows("has_problem")', async () => {
    getFieldExceptionRows.mockResolvedValue(exceptionRows);
    mockParseIntent(makeIntent('list_open_exceptions', { params: { filter: 'has_problem' } }));
    await handleAIMessage(admin, 'משימות עם בעיה');
    expect(getFieldExceptionRows).toHaveBeenCalledWith(expect.any(String), 'has_problem');
  });

  it('with filter=not_confirmed calls getFieldExceptionRows("not_confirmed")', async () => {
    getFieldExceptionRows.mockResolvedValue(exceptionRows);
    mockParseIntent(makeIntent('list_open_exceptions', { params: { filter: 'not_confirmed' } }));
    await handleAIMessage(admin, 'אילו בדיקות לא אושרו');
    expect(getFieldExceptionRows).toHaveBeenCalledWith(expect.any(String), 'not_confirmed');
  });

  it('with filter=waiting_for_info calls getFieldExceptionRows("waiting_for_info")', async () => {
    getFieldExceptionRows.mockResolvedValue(exceptionRows);
    mockParseIntent(makeIntent('list_open_exceptions', { params: { filter: 'waiting_for_info' } }));
    await handleAIMessage(admin, 'ממתינות למידע');
    expect(getFieldExceptionRows).toHaveBeenCalledWith(expect.any(String), 'waiting_for_info');
  });

  it('with filter=not_closed calls getFieldExceptionRows("not_closed")', async () => {
    getFieldExceptionRows.mockResolvedValue(exceptionRows);
    mockParseIntent(makeIntent('list_open_exceptions', { params: { filter: 'not_closed' } }));
    await handleAIMessage(admin, 'מי לא סגר יום');
    expect(getFieldExceptionRows).toHaveBeenCalledWith(expect.any(String), 'not_closed');
  });

  it('sets awaiting to mgr_exceptions_pick_row when rows found', async () => {
    getFieldExceptionRows.mockResolvedValue(exceptionRows);
    mockParseIntent(makeIntent('list_open_exceptions', { params: { filter: 'open' } }));
    await handleAIMessage(admin, 'תציג את החריגים');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_exceptions_pick_row' });
  });

  it('shows exceptions sub-menu when no rows found', async () => {
    getFieldExceptionRows.mockResolvedValue([]);
    mockParseIntent(makeIntent('list_open_exceptions', { params: { filter: 'open' } }));
    await handleAIMessage(admin, 'חריגים');
    expect(lastMsg()).toContain('חריגים ודיווחים');
  });

  it('rejects non-manager with "אין הרשאה"', async () => {
    mockParseIntent(makeIntent('list_open_exceptions', { params: { filter: 'open' } }));
    await handleAIMessage(worker, 'חריגים');
    expect(lastMsg()).toContain('אין הרשאה');
    expect(getFieldExceptionRows).not.toHaveBeenCalled();
  });
});

// ── list_pending_leads ────────────────────────────────────────────────────────

describe('intent: list_pending_leads', () => {
  it('with filter=unassigned calls findUnassignedLeadsForAssignment', async () => {
    const { findUnassignedLeadsForAssignment } = await import('../services/incomingLeads');
    (findUnassignedLeadsForAssignment as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'l1', fromName: 'אבי', subject: 'בדיקת קרינה', body: null,
        fromEmail: null, receivedAt: new Date(), status: null, ownerId: null, taskId: null },
    ]);
    mockParseIntent(makeIntent('list_pending_leads', { params: { filter: 'unassigned' } }));
    await handleAIMessage(admin, 'לידים ממתינים');
    expect(lastMsg()).toContain('אבי');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_leads_pick_row' });
  });

  it('with filter=escalated calls findEscalationCandidates', async () => {
    const { findEscalationCandidates } = await import('../services/incomingLeads');
    (findEscalationCandidates as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'l2', fromName: 'רון', subject: 'בדיקה', body: null,
        fromEmail: null, receivedAt: new Date(), status: null, ownerId: null, taskId: null },
    ]);
    mockParseIntent(makeIntent('list_pending_leads', { params: { filter: 'escalated' } }));
    await handleAIMessage(admin, 'לידים שעברו שעה');
    expect(lastMsg()).toContain('רון');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_leads_pick_row' });
  });

  it('sends "no leads" message when empty', async () => {
    const { findUnassignedLeadsForAssignment } = await import('../services/incomingLeads');
    (findUnassignedLeadsForAssignment as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockParseIntent(makeIntent('list_pending_leads', { params: { filter: 'unassigned' } }));
    await handleAIMessage(admin, 'לידים');
    expect(lastMsg()).toMatch(/אין כרגע לידים/);
  });

  it('rejects non-manager with "אין הרשאה"', async () => {
    mockParseIntent(makeIntent('list_pending_leads', { params: { filter: 'unassigned' } }));
    await handleAIMessage(worker, 'לידים');
    expect(lastMsg()).toContain('אין הרשאה');
  });
});

// ── workers_day_overview ──────────────────────────────────────────────────────

describe('intent: workers_day_overview', () => {
  const mockWorkers = [
    { workerId: 'w1', workerName: 'דני', finished: 3, total: 4, exceptions: 0 },
    { workerId: 'w2', workerName: 'יוסי', finished: 2, total: 3, exceptions: 1 },
  ];

  it('shows all-workers table when no workerName', async () => {
    getAllWorkersDayOverview.mockResolvedValue(mockWorkers);
    mockParseIntent(makeIntent('workers_day_overview', { params: {} }));
    await handleAIMessage(admin, 'סיכום עובדים');
    expect(getAllWorkersDayOverview).toHaveBeenCalled();
    const msg = lastMsg();
    expect(msg).toContain('דני: 3/4');
    expect(msg).toContain('יוסי: 2/3');
  });

  it('shows detail for named worker when workerName is set', async () => {
    getAllWorkersDayOverview.mockResolvedValue(mockWorkers);
    getWorkerDayDetail.mockResolvedValue({
      inspections: [
        { taskFieldId: 'tf1', taskId: 't1', workerName: 'דני', customerName: 'לקוח א',
          timeHm: '09:00', siteCity: 'רעננה', fieldStatus: 'FINISHED_FIELD', family: 'noise', typeLabelHe: 'רעש' },
      ],
      finished: 1, total: 1, openExceptions: 0,
    });
    mockParseIntent(makeIntent('workers_day_overview', { params: { workerName: 'דני' } }));
    await handleAIMessage(admin, 'סיכום של דני');
    expect(getWorkerDayDetail).toHaveBeenCalledWith('w1', expect.any(String));
    expect(lastMsg()).toContain('דני');
    expect(lastMsg()).toContain('1/1 בוצעו');
  });

  it('sends "no workers" message when list is empty', async () => {
    getAllWorkersDayOverview.mockResolvedValue([]);
    mockParseIntent(makeIntent('workers_day_overview', { params: {} }));
    await handleAIMessage(admin, 'עובדים היום');
    expect(lastMsg()).toMatch(/אין עובדים/);
  });

  it('rejects non-manager with "אין הרשאה"', async () => {
    mockParseIntent(makeIntent('workers_day_overview', { params: {} }));
    await handleAIMessage(worker, 'סיכום עובדים');
    expect(lastMsg()).toContain('אין הרשאה');
    expect(getAllWorkersDayOverview).not.toHaveBeenCalled();
  });
});

// ── search_task ───────────────────────────────────────────────────────────────

describe('intent: search_task', () => {
  it('with searchBy=worker and query calls searchTasksByWorkerName', async () => {
    searchTasksByWorkerName.mockResolvedValue([
      { taskFieldId: 'tf5', taskId: 't5', workerName: 'דני כהן', customerName: 'לקוח',
        timeHm: '10:00', siteCity: 'ת"א', fieldStatus: 'ASSIGNED', family: 'noise', typeLabelHe: 'רעש' },
    ]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'worker', query: 'דני' } }));
    await handleAIMessage(admin, 'בדיקות של דני');
    expect(searchTasksByWorkerName).toHaveBeenCalledWith('דני');
    // worker search: 2-line row — "סוג בדיקה: <label>" on line 1, labeled time/city/status on line 2
    expect(lastMsg()).toContain('סוג בדיקה: רעש');
    expect(lastMsg()).toContain('שעה: 10:00');
    expect(lastMsg()).toContain('עיר: ת"א');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_pick_task', mgrSearchKind: 'worker' });
  });

  it('with searchBy=product and query calls searchTasksByProductCode', async () => {
    searchTasksByProductCode.mockResolvedValue([
      { taskFieldId: 'tf6', taskId: 't6', workerName: 'יוסי', customerName: 'לקוח',
        timeHm: '08:00', siteCity: 'X', fieldStatus: 'CONFIRMED', family: 'radiation', typeLabelHe: 'קרינה' },
    ]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'product', query: '10156' } }));
    await handleAIMessage(admin, 'בדיקות מק"ט 10156');
    expect(searchTasksByProductCode).toHaveBeenCalledWith('10156');
    // Product search now shows worker on its own labeled line
    expect(lastMsg()).toContain('שם עובד: יוסי');
  });

  it('with no params shows search sub-menu', async () => {
    mockParseIntent(makeIntent('search_task', { params: {} }));
    await handleAIMessage(admin, 'חפש');
    expect(lastMsg()).toContain('לפי לקוח');
    expect(lastMsg()).toContain('לפי עובד');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_sub' });
  });

  it('with searchBy only (no query) prompts for the query', async () => {
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'worker' } }));
    await handleAIMessage(admin, 'חפש לפי עובד');
    expect(lastMsg()).toContain('שם עובד');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_await_query', mgrSearchKind: 'worker' });
  });

  it('sends "no results" when search returns empty', async () => {
    searchTasksByWorkerName.mockResolvedValue([]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'worker', query: 'xyz' } }));
    await handleAIMessage(admin, 'בדיקות של xyz');
    expect(lastMsg()).toContain('לא נמצאו תוצאות');
  });

  it('rejects non-manager with "אין הרשאה"', async () => {
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'worker', query: 'דני' } }));
    await handleAIMessage(worker, 'חפש');
    expect(lastMsg()).toContain('אין הרשאה');
    expect(searchTasksByWorkerName).not.toHaveBeenCalled();
  });
});

// ── fallback for manager users ────────────────────────────────────────────────

describe('fallback for manager users', () => {
  it('unknown intent for manager appends "תרצה לראות את התפריט?"', async () => {
    mockParseIntent(makeIntent('unknown', {
      confidence: 0.1,
      clarification: 'לא הבנתי',
    }));
    await handleAIMessage(admin, 'שאלה מוזרה');
    const msg = lastMsg();
    expect(msg).toContain('לא הבנתי');
    expect(msg).toContain('תרצה לראות את התפריט?');
    expect(msg).toContain('כתוב "תפריט"');
  });

  it('unknown intent for worker does NOT append menu hint', async () => {
    mockParseIntent(makeIntent('unknown', {
      confidence: 0.1,
      clarification: 'לא הבנתי',
    }));
    await handleAIMessage(worker, 'שאלה מוזרה');
    const msg = lastMsg();
    expect(msg).toContain('לא הבנתי');
    expect(msg).not.toContain('כתוב "תפריט"');
  });
});
