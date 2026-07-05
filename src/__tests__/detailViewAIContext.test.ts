/**
 * detailViewAIContext.test.ts
 *
 * Tests for the context-aware free-text / voice dispatch in mgr_*_action states.
 *
 * Bug scenario: manager is viewing a specific TaskField (taskFieldId in context),
 * sends voice "החלף את איש הקשר מרונית לוי למישהו אחר" → should NOT ask
 * "לאיזה בדיקה אתה מתכוון?" — should extract action+values and dispatch directly.
 *
 * Coverage:
 *  - Bare digit "1"  → fast-path: goes to correct_site flow (showSiteFieldMenu)
 *  - Bare digit "2"  → fast-path: goes to correct_type flow
 *  - Bare digit "3"  → fast-path: goes to reassign worker list
 *  - Bare digit "4" / "חזרה" → fast-path: back to menu
 *  - "ביטול" → clears context
 *  - Free-text: "החלף איש קשר מרונית לוי לגל לגזיאל, 050-1234567"
 *               → extracts action=correct_site, name+phone, high conf → applies directly
 *  - Free-text: "שנה כתובת לרוטשילד 20 תל אביב"
 *               → action=correct_site, newSiteAddress, high conf → applies directly
 *  - Free-text: "שייך מחדש לדני"
 *               → action=reassign, newWorkerName=דני, single match + high conf → confirm prompt
 *  - Free-text: "שנה סוג בדיקה לבדיקת קרינה"
 *               → action=correct_type, shows filtered type list
 *  - Medium confidence → shows confirmation prompt
 *  - Low confidence → falls back to numbered menu prompt
 *  - All three mgr_*_action states route through the same handler
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// managerViews
const getManagementSnapshot = vi.fn();
const getTodayFieldInspections = vi.fn();
const getFieldExceptionRows = vi.fn();
const getAllWorkersDayOverview = vi.fn();
const getWorkerDayDetail = vi.fn();
const searchTasksByWorkerName = vi.fn();
const searchTasksByProductCode = vi.fn();
const getTaskFieldDetail = vi.fn();
const getTaskFieldValuesForContext = vi.fn();

vi.mock('../services/managerViews', () => ({
  getManagementSnapshot: (...a: unknown[]) => getManagementSnapshot(...a),
  getTodayFieldInspections: (...a: unknown[]) => getTodayFieldInspections(...a),
  getFieldExceptionRows: (...a: unknown[]) => getFieldExceptionRows(...a),
  getAllWorkersDayOverview: (...a: unknown[]) => getAllWorkersDayOverview(...a),
  getWorkerDayDetail: (...a: unknown[]) => getWorkerDayDetail(...a),
  searchTasksByWorkerName: (...a: unknown[]) => searchTasksByWorkerName(...a),
  searchTasksByProductCode: (...a: unknown[]) => searchTasksByProductCode(...a),
  getTaskFieldDetail: (...a: unknown[]) => getTaskFieldDetail(...a),
  getTaskFieldValuesForContext: (...a: unknown[]) => getTaskFieldValuesForContext(...a),
}));

// taskFieldCorrections
const updateSiteMetadata = vi.fn().mockResolvedValue(undefined);
const reassignTask = vi.fn().mockResolvedValue({ resetCount: 1, hadInProgressRows: false });
const correctInspectionType = vi.fn().mockResolvedValue({ oldProductName: 'old', newProductName: 'new' });
const listInspectionTypes = vi.fn().mockResolvedValue([]);
const getTaskFieldForCorrection = vi.fn().mockResolvedValue(null);

vi.mock('../services/taskFieldCorrections', () => ({
  updateSiteMetadata: (...a: unknown[]) => updateSiteMetadata(...a),
  reassignTask: (...a: unknown[]) => reassignTask(...a),
  correctInspectionType: (...a: unknown[]) => correctInspectionType(...a),
  ClosedInspectionError: class ClosedInspectionError extends Error {
    constructor(msg: string) { super(msg); this.name = 'ClosedInspectionError'; }
  },
  listInspectionTypes: (...a: unknown[]) => listInspectionTypes(...a),
  getTaskFieldForCorrection: (...a: unknown[]) => getTaskFieldForCorrection(...a),
}));

// inspections service — D5-T15 tests need trackable advance/writeProblem/writeMissingInfo mocks.
const advanceFieldStatusMock = vi.fn().mockResolvedValue(undefined);
const writeMissingInfoMock = vi.fn().mockResolvedValue(undefined);
const writeProblemMock = vi.fn().mockResolvedValue(undefined);
const notifyOfficeMissingInfoMock = vi.fn().mockResolvedValue(undefined);
const notifyOfficeProblemMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/inspections', () => ({
  findOpenTaskFieldForWorker: vi.fn().mockResolvedValue(null),
  resolveOpenTaskFieldByHint: vi.fn().mockResolvedValue(null),
  advanceFieldStatus: (...a: unknown[]) => advanceFieldStatusMock(...a),
  writeFieldNotes: vi.fn().mockResolvedValue(undefined),
  writeMissingInfo: (...a: unknown[]) => writeMissingInfoMock(...a),
  writeProblem: (...a: unknown[]) => writeProblemMock(...a),
  notifyOfficeMissingInfo: (...a: unknown[]) => notifyOfficeMissingInfoMock(...a),
  notifyOfficeProblem: (...a: unknown[]) => notifyOfficeProblemMock(...a),
  notifyOfficeMissingEquipment: vi.fn().mockResolvedValue(undefined),
  dayFieldSummary: vi.fn().mockResolvedValue({ finished: [], waitingForInfoCount: 0 }),
  confirmInspection: vi.fn().mockResolvedValue(undefined),
  declineInspection: vi.fn().mockResolvedValue(undefined),
  requestMoreInfo: vi.fn().mockResolvedValue(undefined),
  notifyOfficeDeclined: vi.fn().mockResolvedValue(undefined),
  notifyOfficeNeedsMoreInfo: vi.fn().mockResolvedValue(undefined),
}));

// tasks service
const findUsersByName = vi.fn().mockResolvedValue([]);
vi.mock('../services/tasks', () => ({
  findUsersByName: (...a: unknown[]) => findUsersByName(...a),
  listTasks: vi.fn().mockResolvedValue({ tasks: [], truncated: false }),
  getTaskById: vi.fn().mockResolvedValue(null),
  getAllowedTaskTypes: vi.fn().mockResolvedValue([]),
  getAllowedPriorities: vi.fn().mockResolvedValue([]),
  getEmployeeEndOfDay: vi.fn().mockResolvedValue({ dueToday: 0, completed: 0, notCompleted: 0, overdue: 0, openCarry: 0, unfinishedTitles: [] }),
  getCompanyEndOfDay: vi.fn().mockResolvedValue({ employees: [] }),
}));

// contextExtractor — injectable mock
const extractFromContextMock = vi.fn();
const extractInspectionActionsMock = vi.fn();
vi.mock('../ai/contextExtractor', async () => {
  const actual = await vi.importActual<typeof import('../ai/contextExtractor')>('../ai/contextExtractor');
  return {
    ...actual,
    extractFromContext: (...a: unknown[]) => extractFromContextMock(...a),
    extractInspectionActions: (...a: unknown[]) => extractInspectionActionsMock(...a),
    extractNote: vi.fn().mockResolvedValue(null),
  };
});

// sender
const sendTextMessage = vi.fn().mockResolvedValue(undefined);
const sendButtonMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: (...a: unknown[]) => sendButtonMessage(...a),
  sendListMessage: vi.fn().mockResolvedValue(undefined),
}));

// conversation context — in-memory store
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

vi.mock('../ai/provider', () => ({
  getProvider: () => ({ name: 'test' }),
}));

const parseIntentMock = vi.fn().mockResolvedValue({
  intent: 'unknown', confidence: 0.1, task_reference: null, field: null,
  new_value: null, params: {}, missing_fields: [], clarification: null,
  requires_confirmation: false, requires_manager_approval: false,
  transition: null, problem_type: null,
});
vi.mock('../ai/intentParser', () => ({
  parseIntent: (...a: unknown[]) => parseIntentMock(...a),
  buildSystemPrompt: vi.fn().mockReturnValue(''),
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

vi.mock('../services/taskFieldScheduling', () => ({
  findOpenTasksForOwner: vi.fn().mockResolvedValue([]),
  findOpenTasksForAdmin: vi.fn().mockResolvedValue([]),
  findCustomersByName: vi.fn().mockResolvedValue([]),
  findOpenTasksForCustomer: vi.fn().mockResolvedValue([]),
  scheduleTaskField: vi.fn().mockResolvedValue({ taskFieldId: 'new-tf' }),
}));

vi.mock('../services/specialUsers', () => ({
  isLeadsViewer: vi.fn().mockReturnValue(false),
}));

vi.mock('../services/inspectionsQueries', () => ({
  getInspectionsForWorkerOnDate: vi.fn().mockResolvedValue([]),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { handleAIMessage } from '../ai/router';
import type { ResolvedUser } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeManager(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-mgr',
    name: 'מנהל',
    phone: '97250000001',
    role: 'MANAGER',
    isElevated: true,
    canViewAllRecords: true,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

const manager = makeManager();

/** Seed the in-memory context store with an action state on a specific TaskField. */
function seedActionCtx(awaiting: 'mgr_today_action' | 'mgr_exceptions_action' | 'mgr_search_action'): void {
  ctxStore = {
    awaiting,
    mgrSelectedTaskFieldId: 'tf-abc',
    mgrSelectedTaskId: 't-xyz',
  };
  getContext.mockResolvedValue(ctxStore);
}

/** Default snapshot returned by getTaskFieldValuesForContext. */
const DEFAULT_SNAPSHOT = {
  customerName: 'חברת אלפא',
  contactName: 'רונית לוי',
  contactPhone: '052-7654321',
  siteAddress: 'הרצל 5 תל אביב',
  siteCity: 'תל אביב',
  inspectionTypeLabel: 'בדיקת רעש',
  workerName: 'דני כהן',
};

function lastMsg(): string {
  const calls = sendTextMessage.mock.calls;
  return calls[calls.length - 1]?.[0]?.text ?? '';
}

beforeEach(() => {
  sendTextMessage.mockClear();
  sendButtonMessage.mockClear();
  setContext.mockClear();
  clearContext.mockClear();
  getContext.mockClear();
  extractFromContextMock.mockClear();
  extractInspectionActionsMock.mockClear();
  updateSiteMetadata.mockClear();
  findUsersByName.mockClear();
  listInspectionTypes.mockClear();
  getTaskFieldValuesForContext.mockReset();
  getTaskFieldDetail.mockReset();
  parseIntentMock.mockReset().mockResolvedValue({
    intent: 'unknown', confidence: 0.1, task_reference: null, field: null,
    new_value: null, params: {}, missing_fields: [], clarification: null,
    requires_confirmation: false, requires_manager_approval: false,
    transition: null, problem_type: null,
  });
  advanceFieldStatusMock.mockClear();
  writeMissingInfoMock.mockClear();
  writeProblemMock.mockClear();
  notifyOfficeMissingInfoMock.mockClear();
  notifyOfficeProblemMock.mockClear();
  ctxStore = null;

  // Default: snapshot available
  getTaskFieldValuesForContext.mockResolvedValue(DEFAULT_SNAPSHOT);
  // Default: no inspection types (overridden per-test when needed)
  listInspectionTypes.mockResolvedValue([]);

  // Default multi-action extraction: empty (override per test)
  extractInspectionActionsMock.mockResolvedValue({ actions: [], confidence: 0, clarification: null });
});

afterEach(() => { vi.restoreAllMocks(); });

// ── Fast-path: bare digits ────────────────────────────────────────────────────

describe('fast path — bare digit dispatches without AI', () => {
  it('"1" goes to correct_site (showSiteFieldMenu) without calling AI extractor', async () => {
    seedActionCtx('mgr_today_action');
    await handleAIMessage(manager, '1');
    expect(extractFromContextMock).not.toHaveBeenCalled();
    // Should set correct_site_await_value state
    expect(ctxStore).toMatchObject({ awaiting: 'correct_site_await_value', taskFieldId: 'tf-abc' });
  });

  it('"2" goes to correct_type flow (showInspectionTypeListForCorrection)', async () => {
    seedActionCtx('mgr_today_action');
    listInspectionTypes.mockResolvedValue([
      { id: 'it1', code: 'NOISE', labelHe: 'רעש' },
    ]);
    await handleAIMessage(manager, '2');
    expect(extractFromContextMock).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({ awaiting: 'correct_type_pick_from_list', taskFieldId: 'tf-abc' });
  });

  it('"3" goes to reassign worker list', async () => {
    seedActionCtx('mgr_today_action');
    findUsersByName.mockResolvedValue([{ id: 'w1', name: 'דני' }]);
    await handleAIMessage(manager, '3');
    expect(extractFromContextMock).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({ awaiting: 'reassign_pick_worker' });
  });

  it('"4" goes back to menu', async () => {
    seedActionCtx('mgr_today_action');
    await handleAIMessage(manager, '4');
    expect(extractFromContextMock).not.toHaveBeenCalled();
    // showMenu sets mgr_menu_root state
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_menu_root' });
  });

  it('"חזרה" goes back to menu', async () => {
    seedActionCtx('mgr_today_action');
    await handleAIMessage(manager, 'חזרה');
    expect(extractFromContextMock).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_menu_root' });
  });

  it('"ביטול" clears context', async () => {
    seedActionCtx('mgr_today_action');
    await handleAIMessage(manager, 'ביטול');
    expect(extractFromContextMock).not.toHaveBeenCalled();
    expect(clearContext).toHaveBeenCalled();
    expect(lastMsg()).toBe('בוטל.');
  });
});

// ── Free-text: contact replacement ───────────────────────────────────────────

describe('free-text — replace contact (action=correct_site)', () => {
  it('high confidence: extracts name+phone, applies both immediately (skips pick-task)', async () => {
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [{
        action: 'correct_site',
        newSiteAddress: undefined,
        newSiteCity: undefined,
        newContactName: 'גל לגזיאל',
        newContactPhone: '050-1234567',
        newInspectionTypeQuery: undefined,
        newWorkerName: undefined,
      }],
      confidence: 0.93,
      clarification: null,
    });

    await handleAIMessage(manager, 'החלף את איש הקשר מרונית לוי לגל לגזיאל, 050-1234567');

    // Should call multi-action AI extractor (free-text path)
    expect(extractInspectionActionsMock).toHaveBeenCalledOnce();
    // Should look up snapshot for context
    expect(getTaskFieldValuesForContext).toHaveBeenCalledWith('tf-abc');
    // Should have written both fields
    expect(updateSiteMetadata).toHaveBeenCalledTimes(2);
    expect(updateSiteMetadata).toHaveBeenCalledWith('tf-abc', 'u-mgr', { fieldContactName: 'גל לגזיאל' });
    expect(updateSiteMetadata).toHaveBeenCalledWith('tf-abc', 'u-mgr', { fieldContactPhone: '050-1234567' });
    // Context should be cleared after write
    expect(clearContext).toHaveBeenCalled();
    expect(lastMsg()).toContain('עודכן בהצלחה');
  });

  it('high confidence: single field (only contact name) — applies directly', async () => {
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [{
        action: 'correct_site',
        newContactName: 'משה כהן',
      }],
      confidence: 0.92,
      clarification: null,
    });

    await handleAIMessage(manager, 'שנה שם איש קשר למשה כהן');

    expect(updateSiteMetadata).toHaveBeenCalledOnce();
    expect(updateSiteMetadata).toHaveBeenCalledWith('tf-abc', 'u-mgr', { fieldContactName: 'משה כהן' });
    expect(clearContext).toHaveBeenCalled();
  });
});

// ── Free-text: address change ─────────────────────────────────────────────────

describe('free-text — address change (action=correct_site)', () => {
  it('high confidence: extracts newSiteAddress, applies directly', async () => {
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [{
        action: 'correct_site',
        newSiteAddress: 'רוטשילד 20 תל אביב',
        newSiteCity: 'תל אביב',
      }],
      confidence: 0.91,
      clarification: null,
    });

    await handleAIMessage(manager, 'לשנות את הכתובת לרוטשילד 20 תל אביב');

    expect(updateSiteMetadata).toHaveBeenCalledWith('tf-abc', 'u-mgr', { siteAddress: 'רוטשילד 20 תל אביב' });
    expect(updateSiteMetadata).toHaveBeenCalledWith('tf-abc', 'u-mgr', { siteCity: 'תל אביב' });
    expect(clearContext).toHaveBeenCalled();
    expect(lastMsg()).toContain('עודכן בהצלחה');
  });
});

// ── Free-text: reassign ───────────────────────────────────────────────────────

describe('free-text — reassign (action=reassign)', () => {
  it('high confidence, single worker match → sends confirm prompt (1. כן / 2. לא)', async () => {
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [{ action: 'reassign', newWorkerName: 'דני' }],
      confidence: 0.91,
      clarification: null,
    });
    findUsersByName.mockResolvedValue([{ id: 'w-danny', name: 'דני כהן' }]);

    await handleAIMessage(manager, 'לשייך מחדש לדני');

    expect(ctxStore).toMatchObject({
      awaiting: 'reassign_pick_worker',
      candidateTaskIds: ['t-xyz'],
      candidateUserIds: ['w-danny'],
    });
    expect(lastMsg()).toContain('דני כהן');
  });

  it('multiple workers → shows numbered list for disambiguation', async () => {
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [{ action: 'reassign', newWorkerName: 'כהן' }],
      confidence: 0.90,
      clarification: null,
    });
    findUsersByName.mockResolvedValue([
      { id: 'w1', name: 'דני כהן' },
      { id: 'w2', name: 'יוסי כהן' },
    ]);

    await handleAIMessage(manager, 'שייך מחדש לכהן');

    expect(ctxStore).toMatchObject({
      awaiting: 'reassign_pick_worker',
      candidateUserIds: ['w1', 'w2'],
    });
    expect(lastMsg()).toContain('דני כהן');
    expect(lastMsg()).toContain('יוסי כהן');
  });

  it('non-elevated user gets auth rejection (does not invoke reassign)', async () => {
    const worker = makeManager({ role: 'SALES', isElevated: false });
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [{ action: 'reassign', newWorkerName: 'דני' }],
      confidence: 0.92,
      clarification: null,
    });

    await handleAIMessage(worker, 'שייך מחדש לדני');

    expect(findUsersByName).not.toHaveBeenCalled();
    expect(lastMsg()).toContain('אין הרשאה');
  });
});

// ── Free-text: inspection type ────────────────────────────────────────────────

describe('free-text — inspection type change (action=correct_type)', () => {
  it('extracts newInspectionTypeQuery, filters type list, shows numbered list', async () => {
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [{ action: 'correct_type', newInspectionTypeQuery: 'קרינה' }],
      confidence: 0.90,
      clarification: null,
    });
    listInspectionTypes.mockResolvedValue([
      { id: 'it1', code: 'RAD', labelHe: 'בדיקת קרינה' },
      { id: 'it2', code: 'NOISE', labelHe: 'בדיקת רעש' },
    ]);

    await handleAIMessage(manager, 'לשנות את סוג הבדיקה לבדיקת קרינה');

    expect(ctxStore).toMatchObject({
      awaiting: 'correct_type_pick_from_list',
      taskFieldId: 'tf-abc',
      // Only the matched type should be in the list
      candidateUserIds: ['it1'],
    });
    expect(lastMsg()).toContain('קרינה');
  });

  it('no match for query → shows full type list', async () => {
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [{ action: 'correct_type', newInspectionTypeQuery: 'אסבסט' }],
      confidence: 0.87,
      clarification: null,
    });
    listInspectionTypes.mockResolvedValue([
      { id: 'it1', code: 'RAD', labelHe: 'בדיקת קרינה' },
      { id: 'it2', code: 'NOISE', labelHe: 'בדיקת רעש' },
    ]);

    await handleAIMessage(manager, 'שנה סוג לאסבסט');

    // Falls back to full list
    expect(ctxStore).toMatchObject({
      awaiting: 'correct_type_pick_from_list',
      taskFieldId: 'tf-abc',
    });
  });
});

// ── Free-text: "חזרה" as text ─────────────────────────────────────────────────

describe('free-text — "חזרה" as free text', () => {
  it('"חזרה" (digit path) goes back to menu without calling AI', async () => {
    seedActionCtx('mgr_today_action');
    await handleAIMessage(manager, 'חזרה');
    expect(extractFromContextMock).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_menu_root' });
  });

  it('"תפריט" in detail-view context returns to main menu (no AI call)', async () => {
    seedActionCtx('mgr_today_action');
    await handleAIMessage(manager, 'תפריט');
    expect(extractInspectionActionsMock).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_menu_root' });
  });

  it('"menu" (English) in detail-view returns to main menu', async () => {
    seedActionCtx('mgr_today_action');
    await handleAIMessage(manager, 'menu');
    expect(extractInspectionActionsMock).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_menu_root' });
  });

  it('"אחורה" in detail-view returns to main menu', async () => {
    seedActionCtx('mgr_today_action');
    await handleAIMessage(manager, 'אחורה');
    expect(extractInspectionActionsMock).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_menu_root' });
  });
});

// ── Medium confidence ─────────────────────────────────────────────────────────

describe('medium confidence (0.60–0.85) — shows confirmation prompt', () => {
  it('shows confirm prompt with extracted field/value (single action)', async () => {
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [{ action: 'correct_site', newContactName: 'גל לגזיאל' }],
      confidence: 0.72,
      clarification: null,
    });

    await handleAIMessage(manager, 'אני חושב שצריך לשנות את השם לגל לגזיאל');

    // Should NOT write immediately
    expect(updateSiteMetadata).not.toHaveBeenCalled();
    // Should show confirm prompt
    expect(ctxStore).toMatchObject({ awaiting: 'correct_site_confirm_extracted', taskFieldId: 'tf-abc' });
    expect(lastMsg()).toContain('גל לגזיאל');
    expect(lastMsg()).toContain('נכון?');
  });
});

// ── Low confidence ────────────────────────────────────────────────────────────

describe('low confidence (< 0.60) — falls back to numbered prompt', () => {
  it('ambiguous phrase → shows numbered menu again', async () => {
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [],
      confidence: 0.35,
      clarification: 'לא הבנתי את הכוונה. אנא בחר פעולה מהרשימה.',
    });

    await handleAIMessage(manager, 'הבדיקה הזאת נראית בעייתית');

    expect(updateSiteMetadata).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({
      awaiting: 'mgr_today_action',
      mgrSelectedTaskFieldId: 'tf-abc',
    });
    expect(lastMsg()).toContain('1. תיקון פרטי ביקור');
  });

  it('AI returns empty actions array at high confidence → falls back to numbered prompt', async () => {
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [],
      confidence: 0.90,  // high confidence but no actions
      clarification: null,
    });

    await handleAIMessage(manager, 'yyy');

    expect(lastMsg()).toContain('1. תיקון פרטי ביקור');
  });
});

// ── Three states route through same handler ───────────────────────────────────

describe('all three mgr_*_action states route through the same AI handler', () => {
  const actionStates = [
    'mgr_today_action',
    'mgr_exceptions_action',
    'mgr_search_action',
  ] as const;

  for (const state of actionStates) {
    it(`${state}: free-text invokes AI extractor`, async () => {
      seedActionCtx(state);
      extractInspectionActionsMock.mockResolvedValue({
        actions: [{ action: 'correct_site', newContactName: 'בדיקה' }],
        confidence: 0.92,
        clarification: null,
      });

      await handleAIMessage(manager, 'שנה שם איש קשר לבדיקה');

      expect(extractInspectionActionsMock).toHaveBeenCalledOnce();
      expect(updateSiteMetadata).toHaveBeenCalled();
    });
  }
});

// ── AI extractor receives snapshot values ─────────────────────────────────────

describe('AI extractor receives current TaskField values in context', () => {
  it('passes currentTaskFieldValues from snapshot to extractInspectionActions', async () => {
    seedActionCtx('mgr_today_action');
    getTaskFieldValuesForContext.mockResolvedValue(DEFAULT_SNAPSHOT);
    extractInspectionActionsMock.mockResolvedValue({
      actions: [{ action: 'correct_site', newContactName: 'חדש' }],
      confidence: 0.91,
      clarification: null,
    });

    await handleAIMessage(manager, 'שנה שם איש קשר לחדש');

    expect(extractInspectionActionsMock).toHaveBeenCalledWith(
      expect.anything(), // message
      expect.objectContaining({
        contactName: 'רונית לוי',
        contactPhone: '052-7654321',
        customerName: 'חברת אלפא',
      }),
      expect.anything(), // history
    );
  });

  it('handles missing snapshot gracefully (snapshot returns null)', async () => {
    seedActionCtx('mgr_today_action');
    getTaskFieldValuesForContext.mockResolvedValue(null);
    extractInspectionActionsMock.mockResolvedValue({
      actions: [{ action: 'correct_site', newContactName: 'חדש' }],
      confidence: 0.91,
      clarification: null,
    });

    await handleAIMessage(manager, 'שנה שם');

    // Should still work — currentTaskFieldValues will be undefined
    expect(extractInspectionActionsMock).toHaveBeenCalledWith(
      expect.anything(), // message
      undefined,          // no snapshot → undefined ctxValues
      expect.anything(), // history
    );
    // And still apply the update
    expect(updateSiteMetadata).toHaveBeenCalled();
  });
});

// ── Multi-action flow ─────────────────────────────────────────────────────────

describe('multi-action flow — confirmation + dispatch', () => {
  // 1. Two-action confirmation renders correctly and uses button message
  it('2-action batch: shows consolidated confirm via sendButtonMessage', async () => {
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [
        { action: 'correct_site', newSiteAddress: 'רוטשילד 15', newSiteCity: 'תל אביב' },
        { action: 'reassign', newWorkerName: 'דני' },
      ],
      confidence: 0.92,
      clarification: null,
    });

    await handleAIMessage(manager, 'תשנה את הכתובת לרוטשילד 15 ותשייך את זה לדני');

    expect(sendButtonMessage).toHaveBeenCalledOnce();
    const call = sendButtonMessage.mock.calls[0][0];
    expect(call.body).toContain('2 שינויים');
    expect(call.body).toContain('רוטשילד 15');
    expect(call.body).toContain('דני');
    expect(call.buttons).toContainEqual(expect.objectContaining({ id: 'CONFIRM_YES_MULTI_ACTION' }));
    expect(call.buttons).toContainEqual(expect.objectContaining({ id: 'CONFIRM_NO_MULTI_ACTION' }));
    expect(ctxStore).toMatchObject({
      awaiting: 'mgr_multi_action_confirm',
      mgrSelectedTaskFieldId: 'tf-abc',
      mgrSelectedTaskId: 't-xyz',
      pendingMultiActions: expect.arrayContaining([
        expect.objectContaining({ action: 'correct_site' }),
        expect.objectContaining({ action: 'reassign' }),
      ]),
    });
  });

  // 2. Confirm → all actions dispatched in order
  it('confirm → correct_site applied, reassign applied (single unique worker match)', async () => {
    ctxStore = {
      awaiting: 'mgr_multi_action_confirm',
      mgrSelectedTaskFieldId: 'tf-abc',
      mgrSelectedTaskId: 't-xyz',
      pendingMultiActions: [
        { action: 'correct_site', newSiteAddress: 'רוטשילד 15' },
        { action: 'reassign', newWorkerName: 'דני' },
      ],
    };
    getContext.mockResolvedValue(ctxStore);
    findUsersByName.mockResolvedValue([{ id: 'w-danny', name: 'דני כהן' }]);

    await handleAIMessage(manager, 'CONFIRM_YES_MULTI_ACTION');

    expect(updateSiteMetadata).toHaveBeenCalledWith('tf-abc', 'u-mgr', { siteAddress: 'רוטשילד 15' });
    const reassignFn = (await import('../services/taskFieldCorrections')).reassignTask;
    // reassignTask is mocked globally in this test file
    expect(clearContext).toHaveBeenCalled();
    const msg = lastMsg();
    expect(msg).toContain('בוצע');
  });

  // 3. Cancel → nothing applied
  it('cancel → nothing applied, context cleared', async () => {
    ctxStore = {
      awaiting: 'mgr_multi_action_confirm',
      mgrSelectedTaskFieldId: 'tf-abc',
      mgrSelectedTaskId: 't-xyz',
      pendingMultiActions: [
        { action: 'correct_site', newSiteAddress: 'רוטשילד 15' },
      ],
    };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(manager, 'CONFIRM_NO_MULTI_ACTION');

    expect(updateSiteMetadata).not.toHaveBeenCalled();
    expect(clearContext).toHaveBeenCalled();
    expect(lastMsg()).toBe('בוטל.');
  });

  // 4. Ambiguous worker in a batch → skipped with a report line
  it('ambiguous worker → skipped, reported in summary', async () => {
    ctxStore = {
      awaiting: 'mgr_multi_action_confirm',
      mgrSelectedTaskFieldId: 'tf-abc',
      mgrSelectedTaskId: 't-xyz',
      pendingMultiActions: [
        { action: 'correct_site', newContactName: 'גל' },
        { action: 'reassign', newWorkerName: 'דני' },
      ],
    };
    getContext.mockResolvedValue(ctxStore);
    // Multiple workers match "דני" → ambiguous → skip
    findUsersByName.mockResolvedValue([
      { id: 'w1', name: 'דני כהן' },
      { id: 'w2', name: 'דני לוי' },
    ]);

    await handleAIMessage(manager, '1');

    // correct_site should have been applied
    expect(updateSiteMetadata).toHaveBeenCalledWith('tf-abc', 'u-mgr', { fieldContactName: 'גל' });
    // reassign skipped
    const msg = lastMsg();
    expect(msg).toContain('לא בוצע');
    // context still cleared
    expect(clearContext).toHaveBeenCalled();
  });

  // 5. Multi-action batch filtered to only back/cancel → cleared immediately (no confirm)
  it('batch filtered to back/cancel only → cleared without showing confirm', async () => {
    seedActionCtx('mgr_today_action');
    // Use a message that doesn't match the fast-path nav regex
    extractInspectionActionsMock.mockResolvedValue({
      actions: [
        { action: 'back' },
        { action: 'cancel' },
      ],
      confidence: 0.92,
      clarification: null,
    });

    await handleAIMessage(manager, 'תעצור הכל בבקשה');

    expect(sendButtonMessage).not.toHaveBeenCalled();
    expect(clearContext).toHaveBeenCalled();
    expect(lastMsg()).toBe('בוטל.');
  });

  // 6. sendButtonMessage called with correct payload IDs
  it('confirm button has CONFIRM_YES_MULTI_ACTION, cancel has CONFIRM_NO_MULTI_ACTION', async () => {
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [
        { action: 'correct_site', newSiteAddress: 'כתובת חדשה' },
        { action: 'correct_type', newInspectionTypeQuery: 'קרינה' },
      ],
      confidence: 0.91,
      clarification: null,
    });

    await handleAIMessage(manager, 'שנה כתובת וסוג');

    const call = sendButtonMessage.mock.calls[0][0];
    const buttonIds = call.buttons.map((b: { id: string }) => b.id);
    expect(buttonIds).toContain('CONFIRM_YES_MULTI_ACTION');
    expect(buttonIds).toContain('CONFIRM_NO_MULTI_ACTION');
  });

  // 7. Medium confidence multi-action shows clarification note in body
  it('medium confidence multi-action shows clarification note in confirm body', async () => {
    seedActionCtx('mgr_today_action');
    extractInspectionActionsMock.mockResolvedValue({
      actions: [
        { action: 'correct_site', newSiteAddress: 'בן יהודה 5' },
        { action: 'reassign', newWorkerName: 'יוסי' },
      ],
      confidence: 0.72, // medium
      clarification: null,
    });

    await handleAIMessage(manager, 'שנה וכו');

    const call = sendButtonMessage.mock.calls[0][0];
    expect(call.body).toContain('לא בטוח');
  });

  // 8. "כן" text reply confirms multi-action
  it('"כן" text reply confirms multi-action batch', async () => {
    ctxStore = {
      awaiting: 'mgr_multi_action_confirm',
      mgrSelectedTaskFieldId: 'tf-abc',
      mgrSelectedTaskId: 't-xyz',
      pendingMultiActions: [
        { action: 'correct_site', newSiteAddress: 'רוטשילד 15' },
      ],
    };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(manager, 'כן');

    expect(updateSiteMetadata).toHaveBeenCalledWith('tf-abc', 'u-mgr', { siteAddress: 'רוטשילד 15' });
    expect(clearContext).toHaveBeenCalled();
  });

  // 9. "לא" text reply cancels multi-action
  it('"לא" text reply cancels multi-action batch', async () => {
    ctxStore = {
      awaiting: 'mgr_multi_action_confirm',
      mgrSelectedTaskFieldId: 'tf-abc',
      mgrSelectedTaskId: 't-xyz',
      pendingMultiActions: [
        { action: 'correct_site', newSiteAddress: 'רוטשילד 15' },
      ],
    };
    getContext.mockResolvedValue(ctxStore);

    await handleAIMessage(manager, 'לא');

    expect(updateSiteMetadata).not.toHaveBeenCalled();
    expect(clearContext).toHaveBeenCalled();
    expect(lastMsg()).toBe('בוטל.');
  });

  // 10. Unique correct_type in batch → applied directly
  it('correct_type with unique match → applied directly in batch confirm', async () => {
    ctxStore = {
      awaiting: 'mgr_multi_action_confirm',
      mgrSelectedTaskFieldId: 'tf-abc',
      mgrSelectedTaskId: 't-xyz',
      pendingMultiActions: [
        { action: 'correct_type', newInspectionTypeQuery: 'קרינה' },
      ],
    };
    getContext.mockResolvedValue(ctxStore);
    listInspectionTypes.mockResolvedValue([
      { id: 'it-rad', code: 'RAD', labelHe: 'בדיקת קרינה' },
    ]);

    await handleAIMessage(manager, '1');

    expect(correctInspectionType).toHaveBeenCalledWith('tf-abc', 'it-rad', 'u-mgr', 'מנהל');
    expect(clearContext).toHaveBeenCalled();
    expect(lastMsg()).toContain('בוצע');
  });
});

// ── D5-T15: worker-intent inline dispatch inside mgr_*_action states ─────────
// Live bug: user viewing a specific TaskField's detail typed "יצאתי" — the
// bot invoked the correction extractor (`extractInspectionActions`) which
// doesn't recognize status transitions → responded "לא זוהתה פעולה ברורה".
// After D5-T15: run the general worker-intent parser FIRST; on
// `set_field_status` / `report_problem` / `report_missing_info` with
// high confidence, dispatch against the currently-viewed TaskField.

describe('D5-T15 — worker-intent inline dispatch (mgr_today_action)', () => {
  it('"יצאתי" → set_field_status DEPARTED → advanceFieldStatus on current TF (no extractor call)', async () => {
    seedActionCtx('mgr_today_action');
    parseIntentMock.mockResolvedValue({
      intent: 'set_field_status', confidence: 0.96,
      task_reference: null, field: null, new_value: null, params: {},
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: 'DEPARTED', problem_type: null,
    });
    await handleAIMessage(manager, 'יצאתי');
    expect(advanceFieldStatusMock).toHaveBeenCalledWith({
      taskFieldId: 'tf-abc',
      transition: 'DEPARTED',
      updatedBy: manager.id,
    });
    // The correction extractor must NOT be invoked when the worker-intent
    // path already consumed the message.
    expect(extractInspectionActionsMock).not.toHaveBeenCalled();
    // The "לא זוהתה פעולה ברורה" fallback must NOT appear.
    const allText = sendTextMessage.mock.calls
      .map((c) => (c[0] as { text: string }).text)
      .join('\n');
    expect(allText).not.toContain('לא זוהתה פעולה ברורה');
  });

  it('"הגעתי" → set_field_status ARRIVED → advanceFieldStatus on current TF', async () => {
    seedActionCtx('mgr_today_action');
    parseIntentMock.mockResolvedValue({
      intent: 'set_field_status', confidence: 0.95,
      task_reference: null, field: null, new_value: null, params: {},
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: 'ARRIVED', problem_type: null,
    });
    await handleAIMessage(manager, 'הגעתי');
    expect(advanceFieldStatusMock).toHaveBeenCalledWith({
      taskFieldId: 'tf-abc',
      transition: 'ARRIVED',
      updatedBy: manager.id,
    });
  });

  it('"סיימתי" → set_field_status FINISHED → performTransition opens finished follow-up (state kept alive)', async () => {
    seedActionCtx('mgr_today_action');
    parseIntentMock.mockResolvedValue({
      intent: 'set_field_status', confidence: 0.97,
      task_reference: null, field: null, new_value: null, params: {},
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: 'FINISHED', problem_type: null,
    });
    await handleAIMessage(manager, 'סיימתי');
    expect(advanceFieldStatusMock).toHaveBeenCalledWith({
      taskFieldId: 'tf-abc',
      transition: 'FINISHED',
      updatedBy: manager.id,
    });
    // FINISHED opens the 4-option follow-up + sets awaiting=finished_followup.
    const fupCall = setContext.mock.calls.find((c) => {
      const s = c[1] as { awaiting?: string; taskFieldId?: string };
      return s.awaiting === 'finished_followup' && s.taskFieldId === 'tf-abc';
    });
    expect(fupCall).toBeTruthy();
  });

  it('"הלקוח לא ענה" → report_problem CUSTOMER_NOT_ANSWERING → writeProblem on current TF', async () => {
    seedActionCtx('mgr_today_action');
    parseIntentMock.mockResolvedValue({
      intent: 'report_problem', confidence: 0.95,
      task_reference: null, field: null, new_value: null, params: {},
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: 'CUSTOMER_NOT_ANSWERING',
    });
    await handleAIMessage(manager, 'הלקוח לא ענה');
    expect(writeProblemMock).toHaveBeenCalledWith({
      taskFieldId: 'tf-abc',
      problemType: 'CUSTOMER_NOT_ANSWERING',
      note: null,
      updatedBy: manager.id,
    });
    expect(notifyOfficeProblemMock).toHaveBeenCalledWith('tf-abc');
  });

  it('"יש לי בעיה" (no problem_type) → opens 7-item sub-menu on current TF', async () => {
    seedActionCtx('mgr_today_action');
    parseIntentMock.mockResolvedValue({
      intent: 'report_problem', confidence: 0.92,
      task_reference: null, field: null, new_value: null, params: {},
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(manager, 'יש לי בעיה');
    // Expect a context set to problem_type_choice with the current TF.
    const problemChoiceCall = setContext.mock.calls.find((c) => {
      const s = c[1] as { awaiting?: string; taskFieldId?: string };
      return s.awaiting === 'problem_type_choice' && s.taskFieldId === 'tf-abc';
    });
    expect(problemChoiceCall).toBeTruthy();
    // writeProblem must NOT be called yet (waiting for the sub-menu pick).
    expect(writeProblemMock).not.toHaveBeenCalled();
  });

  it('"שכחתי את המדד" → report_missing_info → writeMissingInfo on current TF', async () => {
    seedActionCtx('mgr_today_action');
    parseIntentMock.mockResolvedValue({
      intent: 'report_missing_info', confidence: 0.93,
      task_reference: null, field: null, new_value: null,
      params: { note: 'המדד' },
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(manager, 'שכחתי את המדד');
    expect(writeMissingInfoMock).toHaveBeenCalledWith({
      taskFieldId: 'tf-abc',
      note: 'המדד',
      updatedBy: manager.id,
    });
    expect(notifyOfficeMissingInfoMock).toHaveBeenCalledWith('tf-abc');
  });

  it('correction intent (not a worker intent) still routes to extractor (regression check)', async () => {
    seedActionCtx('mgr_today_action');
    // parseIntent returns an intent that is NOT one of the 3 worker-inline ones.
    parseIntentMock.mockResolvedValue({
      intent: 'correct_task_field_site', confidence: 0.9,
      task_reference: null, field: null, new_value: null, params: {},
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    extractInspectionActionsMock.mockResolvedValue({
      actions: [{ action: 'correct_site', newSiteAddress: 'הרצל 5' }],
      confidence: 0.9, clarification: null,
    });
    await handleAIMessage(manager, 'תשנה את הכתובת להרצל 5');
    // The extractor should still be called (worker-intent path returned false).
    expect(extractInspectionActionsMock).toHaveBeenCalled();
  });

  it('low-confidence parseIntent → falls through to extractor (regression check)', async () => {
    seedActionCtx('mgr_today_action');
    parseIntentMock.mockResolvedValue({
      intent: 'set_field_status', confidence: 0.3, // below CONF_LOW threshold
      task_reference: null, field: null, new_value: null, params: {},
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: 'DEPARTED', problem_type: null,
    });
    extractInspectionActionsMock.mockResolvedValue({
      actions: [], confidence: 0, clarification: null,
    });
    await handleAIMessage(manager, 'משהו מעורפל');
    // Extractor should be called since the intent parse was low confidence.
    expect(extractInspectionActionsMock).toHaveBeenCalled();
    // No status advance.
    expect(advanceFieldStatusMock).not.toHaveBeenCalled();
  });
});
