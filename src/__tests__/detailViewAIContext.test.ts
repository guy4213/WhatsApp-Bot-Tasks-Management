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

// inspections service
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
vi.mock('../ai/contextExtractor', async () => {
  const actual = await vi.importActual<typeof import('../ai/contextExtractor')>('../ai/contextExtractor');
  return {
    ...actual,
    extractFromContext: (...a: unknown[]) => extractFromContextMock(...a),
    extractNote: vi.fn().mockResolvedValue(null),
  };
});

// sender
const sendTextMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../ai/intentParser', () => ({
  parseIntent: vi.fn().mockResolvedValue({
    intent: 'unknown', confidence: 0.1, task_reference: null, field: null,
    new_value: null, params: {}, missing_fields: [], clarification: null,
    requires_confirmation: false, requires_manager_approval: false,
    transition: null, problem_type: null,
  }),
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
  setContext.mockClear();
  clearContext.mockClear();
  getContext.mockClear();
  extractFromContextMock.mockClear();
  updateSiteMetadata.mockClear();
  findUsersByName.mockClear();
  listInspectionTypes.mockClear();
  getTaskFieldValuesForContext.mockReset();
  getTaskFieldDetail.mockReset();
  ctxStore = null;

  // Default: snapshot available
  getTaskFieldValuesForContext.mockResolvedValue(DEFAULT_SNAPSHOT);
  // Default: no inspection types (overridden per-test when needed)
  listInspectionTypes.mockResolvedValue([]);
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
    extractFromContextMock.mockResolvedValue({
      values: {
        action: 'correct_site',
        newSiteAddress: null,
        newSiteCity: null,
        newContactName: 'גל לגזיאל',
        newContactPhone: '050-1234567',
        newInspectionTypeQuery: null,
        newWorkerName: null,
      },
      confidence: 0.93,
      clarification: null,
    });

    await handleAIMessage(manager, 'החלף את איש הקשר מרונית לוי לגל לגזיאל, 050-1234567');

    // Should call AI extractor (free-text path)
    expect(extractFromContextMock).toHaveBeenCalledOnce();
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
    extractFromContextMock.mockResolvedValue({
      values: {
        action: 'correct_site',
        newSiteAddress: null, newSiteCity: null,
        newContactName: 'משה כהן', newContactPhone: null,
        newInspectionTypeQuery: null, newWorkerName: null,
      },
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
    extractFromContextMock.mockResolvedValue({
      values: {
        action: 'correct_site',
        newSiteAddress: 'רוטשילד 20 תל אביב',
        newSiteCity: 'תל אביב',
        newContactName: null, newContactPhone: null,
        newInspectionTypeQuery: null, newWorkerName: null,
      },
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
    extractFromContextMock.mockResolvedValue({
      values: {
        action: 'reassign',
        newSiteAddress: null, newSiteCity: null, newContactName: null, newContactPhone: null,
        newInspectionTypeQuery: null, newWorkerName: 'דני',
      },
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
    extractFromContextMock.mockResolvedValue({
      values: {
        action: 'reassign',
        newWorkerName: 'כהן',
        newSiteAddress: null, newSiteCity: null, newContactName: null, newContactPhone: null,
        newInspectionTypeQuery: null,
      },
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
    extractFromContextMock.mockResolvedValue({
      values: {
        action: 'reassign',
        newWorkerName: 'דני',
        newSiteAddress: null, newSiteCity: null, newContactName: null, newContactPhone: null,
        newInspectionTypeQuery: null,
      },
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
    extractFromContextMock.mockResolvedValue({
      values: {
        action: 'correct_type',
        newInspectionTypeQuery: 'קרינה',
        newSiteAddress: null, newSiteCity: null, newContactName: null, newContactPhone: null,
        newWorkerName: null,
      },
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
    extractFromContextMock.mockResolvedValue({
      values: {
        action: 'correct_type',
        newInspectionTypeQuery: 'אסבסט',
        newSiteAddress: null, newSiteCity: null, newContactName: null, newContactPhone: null,
        newWorkerName: null,
      },
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
});

// ── Medium confidence ─────────────────────────────────────────────────────────

describe('medium confidence (0.60–0.85) — shows confirmation prompt', () => {
  it('shows confirm prompt with extracted field/value', async () => {
    seedActionCtx('mgr_today_action');
    extractFromContextMock.mockResolvedValue({
      values: {
        action: 'correct_site',
        newSiteAddress: null, newSiteCity: null,
        newContactName: 'גל לגזיאל', newContactPhone: null,
        newInspectionTypeQuery: null, newWorkerName: null,
      },
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
    extractFromContextMock.mockResolvedValue({
      values: {
        action: null,
        newSiteAddress: null, newSiteCity: null, newContactName: null, newContactPhone: null,
        newInspectionTypeQuery: null, newWorkerName: null,
      },
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

  it('AI returns null action → falls back to numbered prompt', async () => {
    seedActionCtx('mgr_today_action');
    extractFromContextMock.mockResolvedValue({
      values: { action: null, newSiteAddress: null, newSiteCity: null, newContactName: null, newContactPhone: null, newInspectionTypeQuery: null, newWorkerName: null },
      confidence: 0.90,  // high confidence but no action
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
      extractFromContextMock.mockResolvedValue({
        values: {
          action: 'correct_site',
          newSiteAddress: null, newSiteCity: null,
          newContactName: 'בדיקה', newContactPhone: null,
          newInspectionTypeQuery: null, newWorkerName: null,
        },
        confidence: 0.92,
        clarification: null,
      });

      await handleAIMessage(manager, 'שנה שם איש קשר לבדיקה');

      expect(extractFromContextMock).toHaveBeenCalledOnce();
      expect(updateSiteMetadata).toHaveBeenCalled();
    });
  }
});

// ── AI extractor receives snapshot values ─────────────────────────────────────

describe('AI extractor receives current TaskField values in context', () => {
  it('passes currentTaskFieldValues from snapshot to extractFromContext', async () => {
    seedActionCtx('mgr_today_action');
    getTaskFieldValuesForContext.mockResolvedValue(DEFAULT_SNAPSHOT);
    extractFromContextMock.mockResolvedValue({
      values: {
        action: 'correct_site',
        newContactName: 'חדש', newContactPhone: null,
        newSiteAddress: null, newSiteCity: null, newInspectionTypeQuery: null, newWorkerName: null,
      },
      confidence: 0.91,
      clarification: null,
    });

    await handleAIMessage(manager, 'שנה שם איש קשר לחדש');

    expect(extractFromContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'inspection_action',
        currentTaskFieldValues: expect.objectContaining({
          contactName: 'רונית לוי',
          contactPhone: '052-7654321',
          customerName: 'חברת אלפא',
        }),
      }),
    );
  });

  it('handles missing snapshot gracefully (snapshot returns null)', async () => {
    seedActionCtx('mgr_today_action');
    getTaskFieldValuesForContext.mockResolvedValue(null);
    extractFromContextMock.mockResolvedValue({
      values: {
        action: 'correct_site',
        newContactName: 'חדש', newContactPhone: null,
        newSiteAddress: null, newSiteCity: null, newInspectionTypeQuery: null, newWorkerName: null,
      },
      confidence: 0.91,
      clarification: null,
    });

    await handleAIMessage(manager, 'שנה שם');

    // Should still work — currentTaskFieldValues will be undefined
    expect(extractFromContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'inspection_action',
        currentTaskFieldValues: undefined,
      }),
    );
    // And still apply the update
    expect(updateSiteMetadata).toHaveBeenCalled();
  });
});
