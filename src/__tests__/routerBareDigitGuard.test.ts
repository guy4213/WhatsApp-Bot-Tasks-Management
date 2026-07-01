/**
 * routerBareDigitGuard.test.ts — Layer 2 bare-digit guard tests.
 *
 * Verifies that when a manager-menu user types a bare digit (1–9) with NO
 * active conversation context, the router treats it as a menu pick rather than
 * sending it to the AI parser — preventing the stale-history search bug.
 *
 * Bug scenario:
 *   1. User types "היי" → manager menu shown (mgr_menu_root set).
 *   2. User types "1" → management snapshot shown, context cleared.
 *   3. User types "2" — NO active context at this point.
 *      ❌ Old behavior: "2" goes to AI parser → parser recycles "יאיר" from
 *         stale history → executes search_task(worker, "יאיר") — wrong.
 *      ✅ New behavior: bare-digit guard detects manager-menu user + no context
 *         → opens menu (sets mgr_menu_root) → dispatches "2" → item 2 shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

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

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
}));

// parseIntent spy — tracks whether the AI parser was called.
const parseIntentMock = vi.fn().mockResolvedValue({
  intent: 'search_task',
  confidence: 0.9,
  task_reference: null,
  field: null,
  new_value: null,
  params: { searchBy: 'worker', query: 'יאיר' },
  missing_fields: [],
  clarification: null,
  requires_confirmation: false,
  requires_manager_approval: false,
  transition: null,
  problem_type: null,
});
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
  getHistory: vi.fn().mockResolvedValue([
    // Simulate stale history with "יאיר" from a previous search turn.
    { role: 'user',      content: 'חפש בדיקות של יאיר' },
    { role: 'assistant', content: 'מציג תוצאות חיפוש עבור יאיר (3 בדיקות)' },
  ]),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAdmin(): ResolvedUser {
  return {
    id: 'u-admin',
    name: 'מנהל',
    phone: '97250000001',
    role: 'ADMIN',
    isElevated: true,
    canViewAllRecords: true,
    canManageUsers: true,
    canManagePermissions: true,
  };
}

function makeWorker(): ResolvedUser {
  return {
    id: 'u-worker',
    name: 'דני',
    phone: '97250000002',
    role: 'SALES',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
  };
}

function allMessages(): string[] {
  return sendTextMessage.mock.calls.map((c) => c[0]?.text ?? '');
}

beforeEach(() => {
  sendTextMessage.mockClear();
  parseIntentMock.mockClear();
  setContext.mockClear();
  clearContext.mockClear();
  getContext.mockClear();
  ctxStore = null;
  getManagementSnapshot.mockReset();
  getTodayFieldInspections.mockReset();
  getFieldExceptionRows.mockReset();
  getAllWorkersDayOverview.mockReset();
});

afterEach(() => { vi.restoreAllMocks(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Layer 2 — bare-digit guard for manager-menu users', () => {
  it('bare "2" with no context shows manager menu + dispatches to item 2 (today inspections)', async () => {
    // Scenario: no active conversation context (ctxStore = null).
    getContext.mockResolvedValue(null);
    getTodayFieldInspections.mockResolvedValue([]);

    await handleAIMessage(makeAdmin(), '2');

    // Must NOT have called the AI parser.
    expect(parseIntentMock).not.toHaveBeenCalled();

    // Must have shown the menu (first message) then handled item 2.
    const msgs = allMessages();
    expect(msgs[0]).toContain('שלום, מה תרצה לעשות?');  // menu
    // Item 2 with empty results emits "אין בדיקות".
    expect(msgs.some((m) => /אין בדיקות/.test(m))).toBe(true);
  });

  it('bare "1" with no context shows manager menu + dispatches to item 1 (snapshot)', async () => {
    getContext.mockResolvedValue(null);
    getManagementSnapshot.mockResolvedValue({
      today: { total: 3, finished: 1, inProgress: 1, pending: 1 },
      openExceptions: 0,
      leads: { totalOpen: 0, overnight: 0, escalated: 0 },
    });

    await handleAIMessage(makeAdmin(), '1');

    expect(parseIntentMock).not.toHaveBeenCalled();
    const msgs = allMessages();
    expect(msgs[0]).toContain('שלום, מה תרצה לעשות?');
    expect(msgs.some((m) => /תמונת מצב/.test(m))).toBe(true);
  });

  it('bare "3" with no context shows manager menu + dispatches to item 3 (exceptions sub)', async () => {
    getContext.mockResolvedValue(null);

    await handleAIMessage(makeAdmin(), '3');

    expect(parseIntentMock).not.toHaveBeenCalled();
    const msgs = allMessages();
    expect(msgs[0]).toContain('שלום, מה תרצה לעשות?');
    expect(msgs.some((m) => /חריגים ודיווחים/.test(m))).toBe(true);
  });

  it('stale history with "יאיר" does NOT pollute a bare "2" for manager — no search_task executed', async () => {
    // This is the exact bug scenario: stale history has "יאיר" from a prior search.
    // Mock getHistory to return the stale turns (already configured in mock above).
    getContext.mockResolvedValue(null);
    getTodayFieldInspections.mockResolvedValue([]);

    await handleAIMessage(makeAdmin(), '2');

    // AI parser must NOT be called (bare-digit guard short-circuits it).
    expect(parseIntentMock).not.toHaveBeenCalled();

    // No message should contain "יאיר" (which would indicate a stale search ran).
    const msgs = allMessages();
    expect(msgs.every((m) => !m.includes('יאיר'))).toBe(true);
  });

  it('bare digit does NOT trigger the guard for a regular worker (worker gets normal flow)', async () => {
    // Worker with no context — bare "2" should go through the menu trigger logic or AI parser,
    // NOT the manager bare-digit guard. Since "2" is not a MENU_TRIGGER_RE match and the
    // worker has no context, it goes to AI parser.
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'unknown', confidence: 0.1, task_reference: null, field: null,
      new_value: null, params: {}, missing_fields: [], clarification: 'לא הבנתי',
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });

    await handleAIMessage(makeWorker(), '2');

    // AI parser WAS called for the worker.
    expect(parseIntentMock).toHaveBeenCalled();
  });

  it('multi-character text is NOT intercepted by the bare-digit guard', async () => {
    // "12" is two digits — not a bare single digit — so the guard should not fire.
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'unknown', confidence: 0.1, task_reference: null, field: null,
      new_value: null, params: {}, missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });

    await handleAIMessage(makeAdmin(), '12');

    // AI parser WAS called (multi-digit input goes through normal path).
    expect(parseIntentMock).toHaveBeenCalled();
  });
});
