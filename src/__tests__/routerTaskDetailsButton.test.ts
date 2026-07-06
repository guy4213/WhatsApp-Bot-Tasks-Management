/**
 * Router-level tests for the enhanced due-date reminder "פרטים נוספים" flow.
 * (TASK_ENHANCED_DUE_REMINDER.md)
 *
 * Coverage:
 *  - TASK_DETAILS_<taskId> button payload → extended details sent.
 *  - Text "פרטים" / "פרטים נוספים" WITH an active task → same handler.
 *  - Text "פרטים" with NO active task → does not send, does not throw (falls through).
 *  - getTaskDetailsForReminder returns null → "לא הצלחתי למצוא" message, no crash.
 *
 * Mirrors the mock scaffolding of routerPreReminderTap.test.ts. The pure
 * taskDetailFormatter is NOT mocked — the test asserts the real extended output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
const sendListMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage:   (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
  sendListMessage:   (...a: unknown[]) => sendListMessage(...a),
}));

let ctxStore: Record<string, unknown> | null = null;
const setContext = vi.fn(async (_phone: string, state: unknown) => { ctxStore = state as Record<string, unknown>; });
const getContext = vi.fn(async () => ctxStore);
const clearContext = vi.fn(async () => { ctxStore = null; });
vi.mock('../services/conversationContext', () => ({
  setContext: (phone: string, state: unknown) => setContext(phone, state),
  getContext: (_phone: string) => getContext(),
  clearContext: (_phone: string) => clearContext(),
}));

// getActiveTask is SYNCHRONOUS in the real code — must return the value directly.
type ActiveTask = { taskId: string; title?: string } | null;
const getActiveTask = vi.fn((): ActiveTask => null);
const setActiveTask = vi.fn();
vi.mock('../services/taskContext', () => ({
  getActiveTask: (...a: unknown[]) => getActiveTask(...(a as [])),
  setActiveTask: (...a: unknown[]) => setActiveTask(...a),
  clearActiveTask: vi.fn(),
}));

const getTaskDetailsForReminder = vi.fn();
vi.mock('../services/tasks', () => ({
  listTasks: vi.fn().mockResolvedValue([]),
  getTaskById: vi.fn(),
  getTaskDetailsForReminder: (...a: unknown[]) => getTaskDetailsForReminder(...a),
  getAllowedTaskTypes: vi.fn().mockResolvedValue([]),
  getAllowedPriorities: vi.fn().mockResolvedValue([]),
  findUsersByName: vi.fn().mockResolvedValue([]),
  getEmployeeEndOfDay: vi.fn().mockResolvedValue([]),
  getCompanyEndOfDay: vi.fn().mockResolvedValue([]),
}));

// ── Remaining router deps (allow a clean import) ─────────────────────────────
vi.mock('../services/inspections', () => ({
  findOpenTaskFieldForWorker: vi.fn().mockResolvedValue(null),
  resolveOpenTaskFieldByHint: vi.fn().mockResolvedValue(null),
  advanceFieldStatus: vi.fn().mockResolvedValue(undefined),
  writeFieldNotes: vi.fn().mockResolvedValue(undefined),
  writeMissingInfo: vi.fn().mockResolvedValue(undefined),
  writeProblem: vi.fn().mockResolvedValue(undefined),
  notifyOfficeMissingInfo: vi.fn().mockResolvedValue(true),
  notifyOfficeProblem: vi.fn().mockResolvedValue(true),
  notifyOfficeMissingEquipment: vi.fn().mockResolvedValue(true),
  dayFieldSummary: vi.fn().mockResolvedValue({ finished: [], waitingForInfoCount: 0 }),
  confirmInspection: vi.fn().mockResolvedValue(undefined),
  declineInspection: vi.fn().mockResolvedValue(undefined),
  requestMoreInfo: vi.fn().mockResolvedValue(undefined),
  notifyOfficeDeclined: vi.fn().mockResolvedValue(true),
  notifyOfficeNeedsMoreInfo: vi.fn().mockResolvedValue(true),
}));
vi.mock('../services/chatHistory', () => ({
  appendTurn: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../ai/provider', () => ({ getProvider: () => ({ name: 'test' }) }));
vi.mock('../ai/intentParser', () => ({
  parseIntent: vi.fn().mockResolvedValue({ intent: 'help', confidence: 0 }),
}));
vi.mock('../utils/auditLog', () => ({ writeAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/pendingActions', () => ({ getManagersForBroadcast: vi.fn().mockResolvedValue([]) }));
vi.mock('../services/inspectionsQueries', () => ({
  getInspectionsForWorkerOnDate: vi.fn().mockResolvedValue([]),
  getFieldSummaryForWorkerOnDate: vi.fn().mockResolvedValue([]),
  getEquipmentChecklistForFamilies: vi.fn().mockResolvedValue([]),
}));
vi.mock('../whatsapp/digestContent', () => ({
  formatDayFieldSummary: vi.fn().mockReturnValue('summary'),
  formatInspectorDayList: vi.fn().mockReturnValue('list'),
  formatEmployeeEndOfDay: vi.fn().mockReturnValue('eod'),
  formatManagerEndOfDay: vi.fn().mockReturnValue('mgr-eod'),
}));
vi.mock('../ai/digestCommands', () => ({ matchDigestCommand: vi.fn().mockReturnValue(null), planDigestCommand: vi.fn() }));
vi.mock('../services/digestPreferences', () => ({
  getEffectiveDigestPreference: vi.fn().mockResolvedValue(null),
  upsertDigestPreference: vi.fn(),
  parseTimeInput: vi.fn(),
}));
vi.mock('../services/viewContext', () => ({
  setViewOwners: vi.fn(), getViewOwners: vi.fn().mockReturnValue(null), clearViewOwners: vi.fn(),
}));
vi.mock('../services/specialUsers', () => ({
  isLeadsViewer: vi.fn().mockReturnValue(false),
  isExceptionsViewer: vi.fn().mockReturnValue(false),
  isSasha: vi.fn().mockReturnValue(false),
  isYoram: vi.fn().mockReturnValue(false),
}));
vi.mock('../services/managerViews', () => ({
  getManagementSnapshot: vi.fn().mockResolvedValue({}),
  getTodayFieldInspections: vi.fn().mockResolvedValue([]),
  getFieldExceptionRows: vi.fn().mockResolvedValue([]),
  getAllWorkersDayOverview: vi.fn().mockResolvedValue([]),
  getWorkerDayDetail: vi.fn().mockResolvedValue([]),
  searchTasksByWorkerName: vi.fn().mockResolvedValue([]),
  searchTasksByProductCode: vi.fn().mockResolvedValue([]),
  getTaskFieldDetail: vi.fn().mockResolvedValue(null),
  getTaskFieldValuesForContext: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/incomingLeads', () => ({
  findUnassignedLeadsForAssignment: vi.fn().mockResolvedValue([]),
  findActiveInspectors: vi.fn().mockResolvedValue([]),
  assignLead: vi.fn().mockResolvedValue(undefined),
  getLeadById: vi.fn().mockResolvedValue(null),
}));
vi.mock('../ai/leadSuggester', () => ({ suggestWorkerForLead: vi.fn().mockResolvedValue({ userId: null, reason: '' }) }));
vi.mock('../services/leadCategorizer', () => ({ enrichLead: vi.fn().mockResolvedValue(null) }));
vi.mock('../whatsapp/leadDisplay', () => ({
  formatLeadListRowCompact: vi.fn().mockReturnValue(''), formatLeadDetailCompact: vi.fn().mockReturnValue(''),
}));
vi.mock('../services/taskFieldCorrections', () => ({
  updateSiteMetadata: vi.fn().mockResolvedValue(undefined),
  reassignTask: vi.fn().mockResolvedValue(undefined),
  correctInspectionType: vi.fn().mockResolvedValue(undefined),
  updateTaskFieldSchedule: vi.fn().mockResolvedValue(undefined),
  ClosedInspectionError: class ClosedInspectionError extends Error {},
  listInspectionTypes: vi.fn().mockResolvedValue([]),
  getTaskFieldForCorrection: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/taskFieldScheduling', () => ({
  findOpenTasksForOwner: vi.fn().mockResolvedValue([]),
  findOpenTasksForAdmin: vi.fn().mockResolvedValue([]),
  findCustomersByName: vi.fn().mockResolvedValue([]),
  findOpenTasksForCustomer: vi.fn().mockResolvedValue([]),
  scheduleTaskField: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../ai/contextExtractor', () => ({
  extractFromContext: vi.fn().mockResolvedValue(null),
  extractNote: vi.fn().mockImplementation(async (text: string) => text),
  extractInspectionActions: vi.fn().mockResolvedValue([]),
}));

import { handleAIMessage } from '../ai/router';
import { formatTaskDetailsExtended, type TaskDetailForReminder } from '../services/taskDetailFormatter';
import type { ResolvedUser } from '../types';

function makeUser(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'user-1', phone: '972501111111', name: 'דני', role: 'SALES',
    isElevated: false, canViewAllRecords: false, canManageUsers: false, canManagePermissions: false,
    ...overrides,
  };
}

const TASK_ID = 'task-abc123';
function makeDetails(overrides: Partial<TaskDetailForReminder> = {}): TaskDetailForReminder {
  return {
    taskId: TASK_ID,
    taskTitle: 'בדיקת מעלית',
    customerName: 'משה כהן',
    customerPhone: '03-1234567',
    contactName: 'דנה',
    contactPhone: '050-1112222',
    dueDate: new Date('2026-07-06T11:00:00Z'),
    assignedTo: 'יוסי',
    description: 'לבדוק בלמים',
    processNotes: 'להתקשר לפני',
    address: 'הרצל 10',
    city: 'תל אביב',
    status: 'OPEN',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ctxStore = null;
  getActiveTask.mockReturnValue(null);
  delete process.env.CRM_TASK_URL_TEMPLATE; // crmUrl → null in these tests
});
afterEach(() => { vi.restoreAllMocks(); });

describe('due-date reminder — TASK_DETAILS button + text trigger', () => {
  it('button payload TASK_DETAILS_<taskId> → sends the extended details', async () => {
    const details = makeDetails();
    getTaskDetailsForReminder.mockResolvedValueOnce(details);

    await handleAIMessage(makeUser(), `TASK_DETAILS_${TASK_ID}`);

    expect(getTaskDetailsForReminder).toHaveBeenCalledWith(TASK_ID);
    expect(sendTextMessage).toHaveBeenCalledWith({
      to: '972501111111',
      text: formatTaskDetailsExtended(details, null),
    });
  });

  it('text "פרטים" WITH an active task → same extended details', async () => {
    getActiveTask.mockReturnValue({ taskId: TASK_ID, title: 'בדיקת מעלית' });
    const details = makeDetails();
    getTaskDetailsForReminder.mockResolvedValueOnce(details);

    await handleAIMessage(makeUser(), 'פרטים');

    expect(getTaskDetailsForReminder).toHaveBeenCalledWith(TASK_ID);
    expect(sendTextMessage).toHaveBeenCalledWith({
      to: '972501111111',
      text: formatTaskDetailsExtended(details, null),
    });
  });

  it('text "פרטים נוספים" WITH an active task → same handler', async () => {
    getActiveTask.mockReturnValue({ taskId: TASK_ID });
    getTaskDetailsForReminder.mockResolvedValueOnce(makeDetails());

    await handleAIMessage(makeUser(), 'פרטים נוספים');

    expect(getTaskDetailsForReminder).toHaveBeenCalledWith(TASK_ID);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('text "פרטים" with NO active task → does not send, does not throw (falls through)', async () => {
    getActiveTask.mockReturnValue(null);

    await expect(handleAIMessage(makeUser(), 'פרטים')).resolves.not.toThrow();

    expect(getTaskDetailsForReminder).not.toHaveBeenCalled();
    // The details handler never sent anything.
    const sentTexts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(sentTexts.some((t) => t.includes('🔍 פרטי המשימה'))).toBe(false);
  });

  it('getTaskDetailsForReminder returns null → "לא הצלחתי למצוא" message, no crash', async () => {
    getTaskDetailsForReminder.mockResolvedValueOnce(null);

    await handleAIMessage(makeUser(), `TASK_DETAILS_${TASK_ID}`);

    expect(sendTextMessage).toHaveBeenCalledWith({
      to: '972501111111',
      text: 'לא הצלחתי למצוא את פרטי המשימה. נסה שוב או פנה למנהל.',
    });
  });
});
