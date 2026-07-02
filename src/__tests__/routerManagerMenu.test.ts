/**
 * routerManagerMenu.test.ts — router flow tests for the unified 6-item manager menu.
 *
 * Covers:
 *  - Menu trigger opens manager menu for ADMIN/MANAGER/special-name users
 *  - Menu trigger opens employee menu for regular workers
 *  - Item 1: management snapshot one-shot display
 *  - Item 2: today's inspections list → pick → inline action sub-menu
 *  - Item 3: exceptions sub-menu → pick filter → pick row
 *  - Item 4: leads sub-menu including auth check for option 3
 *  - Item 5: workers sub-menu → table view + pick-worker flow
 *  - Item 6: search sub-menu → search by customer/worker/product
 *  - "חזרה" goes back to menu from all sub-menus
 *  - Inline actions prime D2-T12/T13/T14 flows with the pre-picked taskFieldId
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks declared before imports so vi.mock hoisting works ──────────────────

// managerViews: all queries
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

// incomingLeads
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

// sender
// Track all outbound messages in order so lastMsg() works regardless of surface.
const msgLog: string[] = [];
const sendTextMessage  = vi.fn(async (arg: { to: string; text: string }) => { msgLog.push(arg.text); });
const sendListMessage  = vi.fn(async (arg: {
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

// Conversation context — in-memory store
let ctxStore: Record<string, unknown> | null = null;
const setContext = vi.fn(async (_phone: string, state: unknown) => { ctxStore = state as Record<string, unknown>; });
const getContext = vi.fn(async () => ctxStore);
const clearContext = vi.fn(async () => { ctxStore = null; });
vi.mock('../services/conversationContext', () => ({
  setContext: (p: string, s: unknown) => setContext(p, s),
  getContext: (_p: string) => getContext(),
  clearContext: (_p: string) => clearContext(),
}));

// Chat history — no-op
vi.mock('../services/chatHistory', () => ({
  appendTurn: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue([]),
}));

// AI provider
vi.mock('../ai/provider', () => ({
  getProvider: () => ({ name: 'test' }),
}));

// parseIntent — never called for menu flows, but imported
vi.mock('../ai/intentParser', () => ({
  parseIntent: vi.fn().mockResolvedValue({
    intent: 'unknown', confidence: 0.1, task_reference: null, field: null,
    new_value: null, params: {}, missing_fields: [], clarification: null,
    requires_confirmation: false, requires_manager_approval: false,
    transition: null, problem_type: null,
  }),
}));

// AI services used in inspection/site/type correction flows
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

vi.mock('../ai/taskResolver', () => ({
  resolveTask: vi.fn().mockResolvedValue({ match: null, ambiguous: false, candidates: [] }),
}));

vi.mock('../whatsapp/digestContent', () => ({
  formatDayFieldSummary: vi.fn().mockReturnValue('סיכום יום'),
  formatManagerEndOfDay: vi.fn().mockReturnValue({ text: 'eod' }),
  formatEmployeeEndOfDay: vi.fn().mockReturnValue({ text: 'eod' }),
}));

vi.mock('../ai/digestCommands', () => ({
  matchDigestCommand: vi.fn().mockReturnValue(null),
  planDigestCommand: vi.fn(),
  DIGEST_PAYLOAD_IDS: { FREE_TEXT: 'FREE_TEXT', EMP_TODAY: 'EMP_TODAY', EMP_EOD: 'EMP_EOD', TEAM_TODAY: 'TEAM_TODAY', TEAM_EOD: 'TEAM_EOD' },
}));

vi.mock('../db/connection', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { handleAIMessage } from '../ai/router';
import type { ResolvedUser } from '../types';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
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

const admin   = makeUser();
const manager = makeUser({ id: 'u-mgr', role: 'MANAGER', name: 'מנהל שם' });
const yoram   = makeUser({ id: 'u-yoram', role: 'SALES', name: 'יורם', isElevated: false });
const sasha   = makeUser({ id: 'u-sasha', role: 'SALES', name: 'סשה', isElevated: false });
const worker  = makeUser({ id: 'u-worker', role: 'SALES', name: 'דני', isElevated: false });

/** Returns the most recently sent message (text or list message body+rows). */
function lastMsg(): string {
  return msgLog[msgLog.length - 1] ?? '';
}

beforeEach(() => {
  sendTextMessage.mockClear();
  sendListMessage.mockClear();
  msgLog.length = 0;
  setContext.mockClear();
  clearContext.mockClear();
  getContext.mockClear();
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

// ── Menu trigger ──────────────────────────────────────────────────────────────

describe('menu trigger', () => {
  it('admin sees the 6-item manager menu header', async () => {
    await handleAIMessage(admin, 'תפריט');
    expect(lastMsg()).toContain('שלום, מה תרצה לעשות?');
    expect(lastMsg()).toContain('תמונת מצב ניהולית');
    expect(lastMsg()).toContain('בדיקות שטח להיום');
    // awaiting state should be mgr_menu_root
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_menu_root' });
  });

  it('MANAGER role sees manager menu', async () => {
    await handleAIMessage(manager, 'תפריט');
    expect(lastMsg()).toContain('שלום, מה תרצה לעשות?');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_menu_root' });
  });

  it('יורם sees manager menu', async () => {
    await handleAIMessage(yoram, 'תפריט');
    expect(lastMsg()).toContain('שלום, מה תרצה לעשות?');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_menu_root' });
  });

  it('regular worker sees employee menu (not manager menu)', async () => {
    await handleAIMessage(worker, 'תפריט');
    expect(lastMsg()).not.toContain('שלום, מה תרצה לעשות?');
    expect(lastMsg()).toContain('הבדיקות שלי להיום');
    expect(ctxStore).toMatchObject({ awaiting: 'menu' });
  });
});

// ── Item 1: management snapshot ────────────────────────────────────────────────

describe('item 1 — management snapshot', () => {
  beforeEach(() => {
    getManagementSnapshot.mockResolvedValue({
      today: { total: 5, finished: 2, inProgress: 1, pending: 2 },
      openExceptions: 3,
      leads: { totalOpen: 4, overnight: 2, escalated: 1 },
    });
  });

  it('renders snapshot text with all counts', async () => {
    ctxStore = { awaiting: 'mgr_menu_root' };
    getContext.mockResolvedValue(ctxStore);
    await handleAIMessage(admin, '1');
    const msg = lastMsg();
    expect(msg).toContain('תמונת מצב');
    expect(msg).toContain('5');   // total
    expect(msg).toContain('2');   // finished
    expect(msg).toContain('3');   // openExceptions
    expect(msg).toContain('4');   // totalOpen leads
  });

  it('clears context after snapshot (one-shot)', async () => {
    ctxStore = { awaiting: 'mgr_menu_root' };
    getContext.mockResolvedValue(ctxStore);
    await handleAIMessage(admin, '1');
    expect(clearContext).toHaveBeenCalled();
  });

  it('restores mgr_menu_root after snapshot so next bare digit picks correct item (Layer 1 fix)', async () => {
    // Step 1: user types "1" → snapshot is shown, mgr_menu_root is restored.
    ctxStore = { awaiting: 'mgr_menu_root' };
    getContext.mockResolvedValue(ctxStore);
    await handleAIMessage(admin, '1');
    // After snapshot, context must be mgr_menu_root (not null/cleared).
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_menu_root' });

    // Step 2: simulate user types "2" with the restored mgr_menu_root context.
    getTodayFieldInspections.mockResolvedValue([]);
    getContext.mockResolvedValue(ctxStore);
    await handleAIMessage(admin, '2');
    // Should have handled item 2 (today's inspections), NOT gone to AI parser.
    // clearContext was called (item 2 for empty list clears context).
    expect(lastMsg()).toMatch(/אין בדיקות/);
  });
});

// ── Item 2: today's inspections ───────────────────────────────────────────────

describe('item 2 — today\'s field inspections', () => {
  const mockRows = [
    { taskFieldId: 'tf1', taskId: 't1', workerName: 'דני', customerName: 'לקוח א', timeHm: '09:00', siteCity: 'רעננה', fieldStatus: 'CONFIRMED', family: 'noise', typeLabelHe: 'רעש' },
    { taskFieldId: 'tf2', taskId: 't2', workerName: 'יוסי', customerName: 'לקוח ב', timeHm: '11:00', siteCity: 'הרצליה', fieldStatus: 'EN_ROUTE', family: 'radiation', typeLabelHe: 'קרינה' },
  ];

  it('shows numbered list of today inspections', async () => {
    ctxStore = { awaiting: 'mgr_menu_root' };
    getContext.mockResolvedValue(ctxStore);
    getTodayFieldInspections.mockResolvedValue(mockRows);

    await handleAIMessage(admin, '2');
    const msg = lastMsg();
    expect(msg).toContain('שם עובד: דני');
    expect(msg).toContain('שם עובד: יוסי');
    expect(msg).toContain('אושרה'); // Hebrew status for CONFIRMED
  });

  it('sets awaiting to mgr_today_pick_task with taskFieldIds', async () => {
    ctxStore = { awaiting: 'mgr_menu_root' };
    getContext.mockResolvedValue(ctxStore);
    getTodayFieldInspections.mockResolvedValue(mockRows);

    await handleAIMessage(admin, '2');
    expect(ctxStore).toMatchObject({
      awaiting: 'mgr_today_pick_task',
      mgrTaskFieldIds: ['tf1', 'tf2'],
    });
  });

  it('empty list sends "no inspections today" message', async () => {
    ctxStore = { awaiting: 'mgr_menu_root' };
    getContext.mockResolvedValue(ctxStore);
    getTodayFieldInspections.mockResolvedValue([]);

    await handleAIMessage(admin, '2');
    expect(lastMsg()).toMatch(/אין בדיקות/);
  });

  it('picking a task number shows detail + inline action menu', async () => {
    ctxStore = {
      awaiting: 'mgr_today_pick_task',
      mgrTaskFieldIds: ['tf1'],
      mgrTaskIds: ['t1'],
    };
    getContext.mockResolvedValue(ctxStore);
    getTaskFieldDetail.mockResolvedValue({
      taskFieldId: 'tf1', taskId: 't1', workerName: 'דני', customerName: 'לקוח א',
      siteAddress: 'רחוב 1', siteCity: 'רעננה', fieldContactName: null, fieldContactPhone: null,
      fieldStatus: 'CONFIRMED', scheduledStartAt: new Date(), family: 'noise',
      typeLabelHe: 'רעש', specialInstructions: null, problemNote: null,
      problemType: null, missingReportInfoNote: null, hasOpenProblem: false, missingReportInfo: false,
    });

    await handleAIMessage(admin, '1');
    const msg = lastMsg();
    expect(msg).toContain('תיקון פרטי ביקור');
    expect(msg).toContain('תיקון סוג בדיקה');
    expect(msg).toContain('שיוך מחדש');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_today_action', mgrSelectedTaskFieldId: 'tf1' });
  });

  it('"חזרה" from today list returns to menu', async () => {
    ctxStore = { awaiting: 'mgr_today_pick_task', mgrTaskFieldIds: ['tf1'], mgrTaskIds: ['t1'] };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, 'חזרה');
    expect(lastMsg()).toContain('שלום, מה תרצה לעשות?');
  });
});

// ── Item 3: exceptions sub-menu ────────────────────────────────────────────────

describe('item 3 — exceptions sub-menu', () => {
  it('opens exceptions sub-menu with 6 options', async () => {
    ctxStore = { awaiting: 'mgr_menu_root' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '3');
    const msg = lastMsg();
    expect(msg).toContain('חריגים פתוחים');
    expect(msg).toContain('משימות לא אושרו');
    expect(msg).toContain('לא סגרו יום');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_exceptions_sub' });
  });

  it('option 1 loads open_exceptions filter', async () => {
    ctxStore = { awaiting: 'mgr_exceptions_sub' };
    getContext.mockResolvedValue(ctxStore);
    getFieldExceptionRows.mockResolvedValue([
      { taskFieldId: 'tf3', taskId: 't3', workerName: 'דני', customerName: 'לקוח',
        siteCity: 'ת"א', fieldStatus: 'HAS_PROBLEM', description: 'לקוח לא ענה' },
    ]);

    await handleAIMessage(admin, '1');
    expect(getFieldExceptionRows).toHaveBeenCalledWith(expect.any(String), 'open_exceptions');
    expect(lastMsg()).toContain('1. דני');
  });

  it('option 6 returns to menu', async () => {
    ctxStore = { awaiting: 'mgr_exceptions_sub' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '6');
    expect(lastMsg()).toContain('שלום, מה תרצה לעשות?');
  });

  it('"חזרה" from exception row list re-shows exceptions sub-menu', async () => {
    ctxStore = {
      awaiting: 'mgr_exceptions_pick_row',
      mgrTaskFieldIds: ['tf3'],
      mgrTaskIds: ['t3'],
    };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, 'חזרה');
    expect(lastMsg()).toContain('חריגים ודיווחים');
  });
});

// ── Item 4: leads sub-menu ────────────────────────────────────────────────────

describe('item 4 — leads sub-menu', () => {
  it('opens leads sub-menu with 4 options', async () => {
    ctxStore = { awaiting: 'mgr_menu_root' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '4');
    const msg = lastMsg();
    expect(msg).toContain('לידים לא משויכים');
    expect(msg).toContain('שיוך ליד לעובד');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_leads_sub' });
  });

  it('option 3 (assign lead) rejects non-leads-viewer', async () => {
    // יורם is exceptions viewer but NOT leads viewer
    const nonLeadsViewer = makeUser({ name: 'יורם', role: 'SALES', isElevated: false });
    ctxStore = { awaiting: 'mgr_leads_sub' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(nonLeadsViewer, '3');
    expect(lastMsg()).toContain('אין הרשאה');
  });

  it('option 3 starts assign_lead flow for סשה (leads viewer)', async () => {
    const { findUnassignedLeadsForAssignment } = await import('../services/incomingLeads');
    (findUnassignedLeadsForAssignment as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'lead1', fromName: 'רונן', subject: 'בדיקת קרינה', body: null,
        fromEmail: null, receivedAt: new Date(), status: null, ownerId: null, taskId: null },
    ]);

    ctxStore = { awaiting: 'mgr_leads_sub' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(sasha, '3');
    // Should enter the assign_lead_pick_lead flow
    expect(lastMsg()).toContain('רונן');
    expect(ctxStore).toMatchObject({ awaiting: 'assign_lead_pick_lead' });
  });

  it('option 4 returns to menu', async () => {
    ctxStore = { awaiting: 'mgr_leads_sub' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '4');
    expect(lastMsg()).toContain('שלום, מה תרצה לעשות?');
  });
});

// ── Item 5: workers sub-menu ──────────────────────────────────────────────────

describe('item 5 — workers sub-menu', () => {
  const mockWorkers = [
    { workerId: 'w1', workerName: 'דני', finished: 2, total: 3, exceptions: 0 },
    { workerId: 'w2', workerName: 'יוסי', finished: 1, total: 2, exceptions: 1 },
  ];

  it('opens workers sub-menu with 3 options', async () => {
    ctxStore = { awaiting: 'mgr_menu_root' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '5');
    const msg = lastMsg();
    expect(msg).toContain('סיכום יום — כל העובדים');
    expect(msg).toContain('בחר עובד');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_workers_sub' });
  });

  it('option 1 shows per-worker table', async () => {
    getAllWorkersDayOverview.mockResolvedValue(mockWorkers);
    ctxStore = { awaiting: 'mgr_workers_sub' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '1');
    const msg = lastMsg();
    expect(msg).toContain('דני: 2/3');
    expect(msg).toContain('יוסי: 1/2');
  });

  it('option 2 shows numbered worker list', async () => {
    getAllWorkersDayOverview.mockResolvedValue(mockWorkers);
    ctxStore = { awaiting: 'mgr_workers_sub' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '2');
    const msg = lastMsg();
    expect(msg).toContain('1. דני');
    expect(msg).toContain('2. יוסי');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_workers_pick_worker' });
  });

  it('picking a worker shows that worker\'s day detail', async () => {
    getWorkerDayDetail.mockResolvedValue({
      inspections: [
        { taskFieldId: 'tf1', taskId: 't1', workerName: 'דני', customerName: 'לקוח',
          timeHm: '09:00', siteCity: 'עיר', fieldStatus: 'FINISHED_FIELD',
          family: 'noise', typeLabelHe: 'רעש' },
      ],
      finished: 1,
      total: 1,
      openExceptions: 0,
    });
    ctxStore = {
      awaiting: 'mgr_workers_pick_worker',
      mgrWorkerIds: ['w1'],
      mgrWorkerNames: ['דני'],
    };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '1');
    const msg = lastMsg();
    expect(msg).toContain('דני');
    expect(msg).toContain('1/1 בוצעו');
  });

  it('option 3 returns to menu', async () => {
    ctxStore = { awaiting: 'mgr_workers_sub' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '3');
    expect(lastMsg()).toContain('שלום, מה תרצה לעשות?');
  });
});

// ── Item 6: search sub-menu ───────────────────────────────────────────────────

describe('item 6 — search sub-menu', () => {
  it('opens search sub-menu with 4 options', async () => {
    ctxStore = { awaiting: 'mgr_menu_root' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '6');
    const msg = lastMsg();
    expect(msg).toContain('לפי לקוח');
    expect(msg).toContain('לפי עובד');
    expect(msg).toContain('לפי מק"ט');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_sub' });
  });

  it('option 1 prompts for customer name', async () => {
    ctxStore = { awaiting: 'mgr_search_sub' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '1');
    expect(lastMsg()).toContain('שם לקוח');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_await_query', mgrSearchKind: 'customer' });
  });

  it('option 2 prompts for worker name', async () => {
    ctxStore = { awaiting: 'mgr_search_sub' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '2');
    expect(lastMsg()).toContain('שם עובד');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_await_query', mgrSearchKind: 'worker' });
  });

  it('option 3 prompts for product code', async () => {
    ctxStore = { awaiting: 'mgr_search_sub' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '3');
    expect(lastMsg()).toContain('מק"ט');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_await_query', mgrSearchKind: 'product' });
  });

  it('search by worker returns results list', async () => {
    searchTasksByWorkerName.mockResolvedValue([
      { taskFieldId: 'tf5', taskId: 't5', workerName: 'דני כהן', customerName: 'לקוח',
        timeHm: '10:00', siteCity: 'ת"א', fieldStatus: 'ASSIGNED', family: 'noise', typeLabelHe: 'רעש' },
    ]);
    ctxStore = { awaiting: 'mgr_search_await_query', mgrSearchKind: 'worker' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, 'דני');
    expect(searchTasksByWorkerName).toHaveBeenCalledWith('דני');
    const msg = lastMsg();
    // worker search: 2-line row — "סוג בדיקה: <label>" on line 1, labeled time/city/status on line 2
    expect(msg).toContain('סוג בדיקה: רעש');
    expect(msg).toContain('שעה: 10:00');
    expect(msg).toContain('עיר: ת"א');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_pick_task' });
  });

  it('search by product code calls searchTasksByProductCode', async () => {
    searchTasksByProductCode.mockResolvedValue([
      { taskFieldId: 'tf6', taskId: 't6', workerName: 'עובד', customerName: 'ל',
        timeHm: '08:00', siteCity: 'X', fieldStatus: 'CONFIRMED', family: 'radiation', typeLabelHe: 'קרינה' },
    ]);
    ctxStore = { awaiting: 'mgr_search_await_query', mgrSearchKind: 'product' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '9');
    expect(searchTasksByProductCode).toHaveBeenCalledWith('9');
    const msg = lastMsg();
    // Product search now shows worker on its own labeled line
    expect(msg).toContain('שם עובד: עובד');
  });

  it('empty search query sends error message', async () => {
    ctxStore = { awaiting: 'mgr_search_await_query', mgrSearchKind: 'worker' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '   ');
    expect(lastMsg()).toContain('אנא כתוב טקסט לחיפוש');
  });

  it('no results message is sent when search returns empty', async () => {
    searchTasksByWorkerName.mockResolvedValue([]);
    ctxStore = { awaiting: 'mgr_search_await_query', mgrSearchKind: 'worker' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, 'xyz');
    expect(lastMsg()).toContain('לא נמצאו תוצאות');
  });

  it('option 4 returns to menu', async () => {
    ctxStore = { awaiting: 'mgr_search_sub' };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '4');
    expect(lastMsg()).toContain('שלום, מה תרצה לעשות?');
  });
});

// ── Layer 1: sub-menu "חזרה" restores mgr_menu_root ──────────────────────────
// Verify that after returning to the menu with "חזרה", a subsequent bare digit
// routes to the correct menu item (not to the AI parser).

describe('Layer 1 — back navigation leaves mgr_menu_root active', () => {
  it('"חזרה" from exceptions sub restores mgr_menu_root, next "3" picks item 3', async () => {
    // User is in exceptions sub, types "חזרה".
    ctxStore = { awaiting: 'mgr_exceptions_sub' };
    getContext.mockResolvedValue(ctxStore);
    await handleAIMessage(admin, '6'); // option 6 = חזרה in exceptions sub

    // After returning, context should be mgr_menu_root.
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_menu_root' });

    // Simulate "3" next — should open exceptions sub-menu (item 3).
    getContext.mockResolvedValue(ctxStore);
    await handleAIMessage(admin, '3');
    const msg = lastMsg();
    expect(msg).toContain('חריגים ודיווחים');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_exceptions_sub' });
  });

  it('"חזרה" from workers sub restores mgr_menu_root, next "5" picks item 5', async () => {
    ctxStore = { awaiting: 'mgr_workers_sub' };
    getContext.mockResolvedValue(ctxStore);
    await handleAIMessage(admin, '3'); // option 3 = חזרה in workers sub

    expect(ctxStore).toMatchObject({ awaiting: 'mgr_menu_root' });

    getContext.mockResolvedValue(ctxStore);
    await handleAIMessage(admin, '5');
    const msg = lastMsg();
    expect(msg).toContain('עובדים וסיכומי יום');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_workers_sub' });
  });

  it('"חזרה" from search sub restores mgr_menu_root, next "6" picks item 6', async () => {
    ctxStore = { awaiting: 'mgr_search_sub' };
    getContext.mockResolvedValue(ctxStore);
    await handleAIMessage(admin, '4'); // option 4 = חזרה in search sub

    expect(ctxStore).toMatchObject({ awaiting: 'mgr_menu_root' });

    getContext.mockResolvedValue(ctxStore);
    await handleAIMessage(admin, '6');
    const msg = lastMsg();
    expect(msg).toContain('מה לחפש?');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_sub' });
  });
});

// ── Inline actions ────────────────────────────────────────────────────────────

describe('inline actions from task detail view', () => {
  const detailRow = {
    taskFieldId: 'tf-detail', taskId: 't-detail', workerName: 'דני', customerName: 'לקוח',
    siteAddress: 'רחוב 1', siteCity: 'עיר', fieldContactName: null, fieldContactPhone: null,
    fieldStatus: 'CONFIRMED', scheduledStartAt: new Date(), family: 'noise',
    typeLabelHe: 'רעש', specialInstructions: null, problemNote: null,
    problemType: null, missingReportInfoNote: null, hasOpenProblem: false, missingReportInfo: false,
  };

  it('action 1 (correct site) primes D2-T12 flow with the pre-picked taskFieldId', async () => {
    ctxStore = {
      awaiting: 'mgr_today_action',
      mgrSelectedTaskFieldId: 'tf-detail',
      mgrSelectedTaskId: 't-detail',
    };
    getContext.mockResolvedValue(ctxStore);
    void detailRow; // suppress lint

    await handleAIMessage(admin, '1');
    // Should transition to correct_site_await_value with the taskFieldId
    expect(ctxStore).toMatchObject({ awaiting: 'correct_site_await_value', taskFieldId: 'tf-detail' });
  });

  it('action 3 (reassign) requires isElevated', async () => {
    const nonElevated = makeUser({ name: 'יורם', role: 'SALES', isElevated: false });
    ctxStore = {
      awaiting: 'mgr_today_action',
      mgrSelectedTaskFieldId: 'tf-detail',
      mgrSelectedTaskId: 't-detail',
    };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(nonElevated, '3');
    expect(lastMsg()).toContain('אין הרשאה');
  });

  it('action 4 / "חזרה" returns to top-level menu', async () => {
    ctxStore = {
      awaiting: 'mgr_today_action',
      mgrSelectedTaskFieldId: 'tf-detail',
      mgrSelectedTaskId: 't-detail',
    };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(admin, '4');
    expect(lastMsg()).toContain('שלום, מה תרצה לעשות?');
  });
});
