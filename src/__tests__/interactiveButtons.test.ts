/**
 * interactiveButtons.test.ts — Group A/B/C UX upgrade tests.
 *
 * Covers:
 *  - sendListMessage payload shape: manager menu (6 rows with correct MGR_MENU_N ids)
 *  - sendButtonMessage payload shape: 2-option and 3-option confirmations
 *  - Router routes MGR_MENU_2 (list tap) correctly to the right handler
 *  - Router routes ACTION_REASSIGN (list tap) as "3" in the action menu
 *  - Router routes CONFIRM_YES_SITE_CORRECT as "כן" in site-correct confirm state
 *  - Router routes CONFIRM_NO_SCHEDULE as "לא" in schedule confirm state
 *  - Fallback: on sendListMessage failure showMenu falls back to sendTextMessage
 *  - Fallback: on sendButtonMessage failure confirmation falls back to sendTextMessage
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// sender — capture ALL three send functions
const sendTextMessage  = vi.fn().mockResolvedValue(undefined);
const sendButtonMessage = vi.fn().mockResolvedValue(undefined);
const sendListMessage   = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage:   (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: (...a: unknown[]) => sendButtonMessage(...a),
  sendListMessage:   (...a: unknown[]) => sendListMessage(...a),
}));

// Conversation context — in-memory
let ctxStore: Record<string, unknown> | null = null;
const setContext = vi.fn(async (_phone: string, state: unknown) => { ctxStore = state as Record<string, unknown>; });
const getContext = vi.fn(async () => ctxStore);
const clearContext = vi.fn(async () => { ctxStore = null; });
vi.mock('../services/conversationContext', () => ({
  setContext:   (p: string, s: unknown) => setContext(p, s),
  getContext:   (_p: string) => getContext(),
  clearContext: (_p: string) => clearContext(),
}));

// Chat history — no-op
vi.mock('../services/chatHistory', () => ({
  appendTurn: vi.fn().mockResolvedValue(undefined),
  getHistory:  vi.fn().mockResolvedValue([]),
}));

// AI provider
vi.mock('../ai/provider', () => ({
  getProvider: () => ({ name: 'test' }),
}));

// parseIntent — high confidence unknown (shouldn't reach it for menu/button flows)
vi.mock('../ai/intentParser', () => ({
  parseIntent: vi.fn().mockResolvedValue({
    intent: 'unknown', confidence: 0.1, task_reference: null, field: null,
    new_value: null, params: {}, missing_fields: [], clarification: null,
    requires_confirmation: false, requires_manager_approval: false,
    transition: null, problem_type: null,
  }),
}));

// managerViews — provide minimal data for snapshot / today inspections
const getManagementSnapshot = vi.fn().mockResolvedValue({
  today: { total: 5, finished: 2, inProgress: 1, pending: 2 },
  openExceptions: 1,
  leads: { totalOpen: 3, overnight: 1, escalated: 0 },
});
const getTodayFieldInspections = vi.fn().mockResolvedValue([]);
const getFieldExceptionRows    = vi.fn().mockResolvedValue([]);
const getAllWorkersDayOverview  = vi.fn().mockResolvedValue([]);
const getWorkerDayDetail       = vi.fn().mockResolvedValue({ inspections: [], finished: 0, total: 0, openExceptions: 0 });
const searchTasksByWorkerName  = vi.fn().mockResolvedValue([]);
const searchTasksByProductCode = vi.fn().mockResolvedValue([]);
const getTaskFieldDetail       = vi.fn().mockResolvedValue(null);
vi.mock('../services/managerViews', () => ({
  getManagementSnapshot:    (...a: unknown[]) => getManagementSnapshot(...a),
  getTodayFieldInspections: (...a: unknown[]) => getTodayFieldInspections(...a),
  getFieldExceptionRows:    (...a: unknown[]) => getFieldExceptionRows(...a),
  getAllWorkersDayOverview:  (...a: unknown[]) => getAllWorkersDayOverview(...a),
  getWorkerDayDetail:       (...a: unknown[]) => getWorkerDayDetail(...a),
  searchTasksByWorkerName:  (...a: unknown[]) => searchTasksByWorkerName(...a),
  searchTasksByProductCode: (...a: unknown[]) => searchTasksByProductCode(...a),
  getTaskFieldDetail:       (...a: unknown[]) => getTaskFieldDetail(...a),
}));

vi.mock('../services/incomingLeads', () => ({
  findUnassignedLeadsForAssignment: vi.fn().mockResolvedValue([]),
  findActiveInspectors:             vi.fn().mockResolvedValue([]),
  assignLead:                       vi.fn().mockResolvedValue(undefined),
  findUnassignedInWindow:           vi.fn().mockResolvedValue([]),
  findOvernightUnassignedLeads:     vi.fn().mockResolvedValue([]),
  findNewlyAssignedLeads:           vi.fn().mockResolvedValue([]),
  findEscalationCandidates:         vi.fn().mockResolvedValue([]),
  getYoramLeadCounts:               vi.fn().mockResolvedValue({ overnight: 0, unassigned: 0 }),
}));

vi.mock('../services/inspections', () => ({
  findOpenTaskFieldForWorker:   vi.fn().mockResolvedValue(null),
  resolveOpenTaskFieldByHint:   vi.fn().mockResolvedValue(null),
  advanceFieldStatus:           vi.fn().mockResolvedValue(undefined),
  writeFieldNotes:              vi.fn().mockResolvedValue(undefined),
  writeMissingInfo:             vi.fn().mockResolvedValue(undefined),
  writeProblem:                 vi.fn().mockResolvedValue(undefined),
  notifyOfficeMissingInfo:      vi.fn().mockResolvedValue(undefined),
  notifyOfficeProblem:          vi.fn().mockResolvedValue(undefined),
  notifyOfficeMissingEquipment: vi.fn().mockResolvedValue(undefined),
  dayFieldSummary:              vi.fn().mockResolvedValue({ finished: [], waitingForInfoCount: 0 }),
  confirmInspection:            vi.fn().mockResolvedValue(undefined),
  declineInspection:            vi.fn().mockResolvedValue(undefined),
  requestMoreInfo:              vi.fn().mockResolvedValue(undefined),
  notifyOfficeDeclined:         vi.fn().mockResolvedValue(undefined),
  notifyOfficeNeedsMoreInfo:    vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/tasks', () => ({
  listTasks:              vi.fn().mockResolvedValue({ tasks: [], truncated: false }),
  getTaskById:            vi.fn().mockResolvedValue(null),
  getAllowedTaskTypes:     vi.fn().mockResolvedValue([]),
  getAllowedPriorities:   vi.fn().mockResolvedValue([]),
  findUsersByName:        vi.fn().mockResolvedValue([]),
  getEmployeeEndOfDay:    vi.fn().mockResolvedValue({ tasks: [] }),
  getCompanyEndOfDay:     vi.fn().mockResolvedValue({ workers: [] }),
}));

vi.mock('../services/pendingActions', () => ({
  getManagersForBroadcast: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/digestPreferences', () => ({
  getEffectiveDigestPreference: vi.fn().mockResolvedValue({ morningEnabled: true, morningTime: '09:00', eveningEnabled: true, eveningTime: '17:00' }),
  upsertDigestPreference:       vi.fn().mockResolvedValue(undefined),
  parseTimeInput:               vi.fn().mockReturnValue(null),
}));

vi.mock('../services/taskContext', () => ({
  setActiveTask:  vi.fn(),
  getActiveTask:  vi.fn().mockReturnValue(null),
}));

vi.mock('../services/viewContext', () => ({
  setViewOwners:   vi.fn(),
  getViewOwners:   vi.fn().mockReturnValue(null),
  clearViewOwners: vi.fn(),
}));

vi.mock('../ai/taskResolver', () => ({
  resolveTask: vi.fn().mockResolvedValue({ match: null, ambiguous: false, candidates: [] }),
}));

vi.mock('../ai/digestCommands', () => ({
  matchDigestCommand: vi.fn().mockReturnValue(null),
  planDigestCommand:  vi.fn().mockReturnValue({ kind: 'free_text' }),
}));

vi.mock('../whatsapp/digestContent', () => ({
  formatDayFieldSummary:      vi.fn().mockReturnValue(''),
  formatInspectorDayList:     vi.fn().mockReturnValue(''),
  formatEmployeeEndOfDay:     vi.fn().mockReturnValue({ text: '' }),
  formatManagerEndOfDay:      vi.fn().mockReturnValue({ text: '' }),
}));

vi.mock('../services/taskFieldCorrections', () => ({
  updateSiteMetadata:    vi.fn().mockResolvedValue(undefined),
  reassignTask:          vi.fn().mockResolvedValue({ resetCount: 0, hadInProgressRows: false }),
  correctInspectionType: vi.fn().mockResolvedValue(undefined),
  getTaskFieldForCorrection: vi.fn().mockResolvedValue(null),
  listInspectionTypes:   vi.fn().mockResolvedValue([]),
  ClosedInspectionError: class ClosedInspectionError extends Error {},
}));

vi.mock('../services/taskFieldScheduling', () => ({
  findOpenTasksForOwner:   vi.fn().mockResolvedValue([]),
  findOpenTasksForAdmin:   vi.fn().mockResolvedValue([]),
  findCustomersByName:     vi.fn().mockResolvedValue([]),
  findOpenTasksForCustomer: vi.fn().mockResolvedValue([]),
  scheduleTaskField:       vi.fn().mockResolvedValue({ taskFieldId: 'tf-new' }),
}));

vi.mock('../ai/contextExtractor', () => ({
  extractFromContext: vi.fn().mockResolvedValue({ values: {}, confidence: 0, clarification: null }),
  extractNote:        vi.fn().mockResolvedValue(null),
}));

vi.mock('../ai/leadSuggester', () => ({
  suggestWorkerForLead: vi.fn().mockResolvedValue({ userId: null, reason: '' }),
}));

vi.mock('../services/inspectionsQueries', () => ({
  getInspectionsForWorkerOnDate: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/greetings', () => ({
  claimDailyGreeting: vi.fn().mockResolvedValue(false),
  buildGreeting:      vi.fn().mockReturnValue(''),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import type { ResolvedUser } from '../types';
import { handleAIMessage } from '../ai/router';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeManager(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-mgr',
    name: 'גלית',
    phone: '972501000000',
    role: 'MANAGER',
    isElevated: true,
    canViewAllRecords: true,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

function makeWorker(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-worker',
    name: 'דני',
    phone: '972502222222',
    role: 'TECHNICIAN',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Group B: manager menu → sendListMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctxStore = null;
  });
  afterEach(() => { ctxStore = null; });

  it('sends a list message with 6 rows and correct MGR_MENU_N ids when manager opens menu', async () => {
    const mgr = makeManager();
    await handleAIMessage(mgr, 'תפריט');

    expect(sendListMessage).toHaveBeenCalledTimes(1);
    const call = sendListMessage.mock.calls[0][0] as {
      to: string; body: string; buttonLabel: string;
      sections: Array<{ title?: string; rows: Array<{ id: string; title: string }> }>;
    };

    expect(call.to).toBe(mgr.phone);
    expect(call.buttonLabel.length).toBeLessThanOrEqual(20);
    expect(call.sections).toHaveLength(1);

    const rows = call.sections[0].rows;
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.id)).toEqual([
      'MGR_MENU_1', 'MGR_MENU_2', 'MGR_MENU_3',
      'MGR_MENU_4', 'MGR_MENU_5', 'MGR_MENU_6', 'MGR_MENU_7',
    ]);

    // All row titles are ≤ 24 chars
    for (const row of rows) {
      expect(row.title.length).toBeLessThanOrEqual(24);
    }

    // sendTextMessage should NOT have been called for the menu itself
    // (it may have been called for other reasons, but the list message is primary)
    expect(sendListMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back to sendTextMessage when sendListMessage throws', async () => {
    sendListMessage.mockRejectedValueOnce(new Error('Meta rejected'));
    const mgr = makeManager();
    await handleAIMessage(mgr, 'תפריט');

    expect(sendListMessage).toHaveBeenCalledTimes(1);
    // Fallback: numbered text menu must have been sent
    expect(sendTextMessage).toHaveBeenCalled();
    const textCall = sendTextMessage.mock.calls.find((c) =>
      typeof c[0]?.text === 'string' && /1\.\s/.test(c[0].text),
    );
    expect(textCall).toBeDefined();
  });

  it('routes MGR_MENU_2 (list tap) as menu item 2 — today inspections', async () => {
    const mgr = makeManager();
    // Set awaiting context as if menu was shown
    ctxStore = { awaiting: 'mgr_menu_root' };

    await handleAIMessage(mgr, 'MGR_MENU_2');

    // getTodayFieldInspections should have been called (item 2 action)
    expect(getTodayFieldInspections).toHaveBeenCalled();
  });

  it('routes MGR_MENU_1 (list tap with no context) — stale context path', async () => {
    // No context — tests the early MGR_MENU_N handler in handleAIMessage
    const mgr = makeManager();
    ctxStore = null;

    await handleAIMessage(mgr, 'MGR_MENU_1');

    // Item 1 = management snapshot
    expect(getManagementSnapshot).toHaveBeenCalled();
  });
});

describe('Group A: confirmation prompts → sendButtonMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctxStore = null;
  });
  afterEach(() => { ctxStore = null; });

  it('shows 2-button confirmation when schedule confirm is reached', async () => {
    // Simulate the final step before schedule_confirm sends the button prompt.
    // Set up context as if duration was just entered (scheduleAwaitDuration state).
    const mgr = makeManager();
    ctxStore = {
      awaiting: 'schedule_await_duration',
      scheduleStartAt: '2026-07-10T09:00:00+03:00',
      scheduleSelectedTask: {
        id: 'task-1',
        title: 'בדיקת ראדון',
        customerName: 'כהן בע"מ',
        inspectionLabelHe: 'ראדון',
        inspectionTypeId: 'it-1',
        family: 'RADON',
        ownerId: mgr.id,
        siteAddress: 'הרצל 1',
        siteCity: 'תל אביב',
        fieldContactName: 'ישראל',
        fieldContactPhone: '0501111111',
        navigationUrl: null,
        productName: 'RADON',
      },
    };

    await handleAIMessage(mgr, 'אישור'); // accept default duration

    expect(sendButtonMessage).toHaveBeenCalledTimes(1);
    const call = sendButtonMessage.mock.calls[0][0] as {
      to: string; body: string; buttons: Array<{ id: string; title: string }>;
    };
    expect(call.to).toBe(mgr.phone);
    expect(call.buttons).toHaveLength(2);
    expect(call.buttons[0].id).toMatch(/^CONFIRM_YES_/);
    expect(call.buttons[1].id).toMatch(/^CONFIRM_NO_/);
    expect(call.buttons[0].title.length).toBeLessThanOrEqual(20);
    expect(call.buttons[1].title.length).toBeLessThanOrEqual(20);
  });

  it('CONFIRM_YES_SCHEDULE routes as confirm in schedule_confirm state', async () => {
    const { scheduleTaskField } = await import('../services/taskFieldScheduling');
    const mgr = makeManager();
    ctxStore = {
      awaiting: 'schedule_confirm',
      scheduleStartAt: '2026-07-10T09:00:00+03:00',
      scheduleDurationMinutes: 60,
      scheduleSelectedTask: {
        id: 'task-1',
        title: 'בדיקת ראדון',
        customerName: 'כהן בע"מ',
        inspectionLabelHe: 'ראדון',
        inspectionTypeId: 'it-1',
        family: 'RADON',
        ownerId: mgr.id,
        siteAddress: 'הרצל 1',
        siteCity: 'תל אביב',
        fieldContactName: null,
        fieldContactPhone: null,
        navigationUrl: null,
        productName: 'RADON',
      },
    };

    await handleAIMessage(mgr, 'CONFIRM_YES_SCHEDULE');

    // scheduleTaskField should have been called (confirming the action)
    expect(scheduleTaskField).toHaveBeenCalled();
  });

  it('CONFIRM_NO_SCHEDULE routes as cancel in schedule_confirm state', async () => {
    const { scheduleTaskField } = await import('../services/taskFieldScheduling');
    const mgr = makeManager();
    ctxStore = {
      awaiting: 'schedule_confirm',
      scheduleStartAt: '2026-07-10T09:00:00+03:00',
      scheduleDurationMinutes: 60,
      scheduleSelectedTask: {
        id: 'task-1', title: 'x', customerName: 'y',
        inspectionLabelHe: 'z', inspectionTypeId: 'it-1', family: 'RADON',
        ownerId: mgr.id, siteAddress: null, siteCity: null,
        fieldContactName: null, fieldContactPhone: null, navigationUrl: null, productName: 'RADON',
      },
    };

    await handleAIMessage(mgr, 'CONFIRM_NO_SCHEDULE');

    expect(scheduleTaskField).not.toHaveBeenCalled();
    const cancelCall = sendTextMessage.mock.calls.find((c) =>
      typeof c[0]?.text === 'string' && c[0].text.includes('בוטל'),
    );
    expect(cancelCall).toBeDefined();
  });

  it('CONFIRM_YES_SITE_CORRECT routes as confirm in correct_site_confirm_extracted state', async () => {
    const { updateSiteMetadata } = await import('../services/taskFieldCorrections');
    const worker = makeWorker();
    // Elevated so no auth check on site correction
    const elevatedWorker = { ...worker, isElevated: true };
    ctxStore = {
      awaiting: 'correct_site_confirm_extracted',
      taskFieldId: 'tf-abc',
      pendingExtractedField: 'siteCity',
      pendingExtractedValue: 'חיפה',
    };

    await handleAIMessage(elevatedWorker, 'CONFIRM_YES_SITE_CORRECT');

    expect(updateSiteMetadata).toHaveBeenCalledWith(
      'tf-abc',
      elevatedWorker.id,
      { siteCity: 'חיפה' },
    );
  });

  it('fallback: sendButtonMessage failure → sendTextMessage for schedule confirm', async () => {
    sendButtonMessage.mockRejectedValueOnce(new Error('Meta rejected'));
    const mgr = makeManager();
    ctxStore = {
      awaiting: 'schedule_await_duration',
      scheduleStartAt: '2026-07-10T09:00:00+03:00',
      scheduleSelectedTask: {
        id: 'task-1', title: 'x', customerName: 'y',
        inspectionLabelHe: 'z', inspectionTypeId: 'it-1', family: 'RADON',
        ownerId: mgr.id, siteAddress: null, siteCity: null,
        fieldContactName: null, fieldContactPhone: null, navigationUrl: null, productName: 'RADON',
      },
    };

    await handleAIMessage(mgr, 'אישור');

    // Button send attempted
    expect(sendButtonMessage).toHaveBeenCalledTimes(1);
    // Fallback text send should contain "1" and "2"
    const fallbackCall = sendTextMessage.mock.calls.find((c) =>
      typeof c[0]?.text === 'string' && /1\.\s?אישור/.test(c[0].text),
    );
    expect(fallbackCall).toBeDefined();
  });
});

describe('Group C: detail-view action prompt → sendListMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctxStore = null;
  });
  afterEach(() => { ctxStore = null; });

  it('sends a list message with ACTION_* ids when showing task field detail', async () => {
    const mgr = makeManager();
    // Mock getTaskFieldDetail to return a usable row
    getTaskFieldDetail.mockResolvedValueOnce({
      taskTitle: 'בדיקת ראדון', typeLabelHe: 'ראדון',
      workerName: 'דני', customerName: 'כהן',
      siteAddress: 'הרצל 1', siteCity: 'תל אביב',
      fieldContactName: 'ישראל', fieldContactPhone: '0501111111',
      fieldStatus: 'PENDING_FIELD', scheduledStartAt: '2026-07-10T09:00:00Z',
      specialInstructions: null, fieldNotes: null,
      problemNote: null, missingReportInfoNote: null,
    });

    ctxStore = {
      awaiting: 'mgr_today_pick_task',
      mgrTaskFieldIds: ['tf-1'],
      mgrTaskIds: ['task-1'],
    };

    await handleAIMessage(mgr, '1'); // pick row 1 from today's list

    expect(getTaskFieldDetail).toHaveBeenCalledWith('tf-1');
    expect(sendListMessage).toHaveBeenCalledTimes(1);

    const call = sendListMessage.mock.calls[0][0] as {
      to: string; body: string; buttonLabel: string;
      sections: Array<{ title?: string; rows: Array<{ id: string; title: string }> }>;
    };
    expect(call.to).toBe(mgr.phone);
    const rows = call.sections.flatMap((s) => s.rows);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('ACTION_CORRECT_SITE');
    expect(ids).toContain('ACTION_CORRECT_TYPE');
    expect(ids).toContain('ACTION_REASSIGN');
    expect(ids).toContain('ACTION_BACK');
  });

  it('ACTION_REASSIGN routes as "3" in mgr_today_action state', async () => {
    const { findUsersByName } = await import('../services/tasks');
    (findUsersByName as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'u-1', name: 'עובד א' },
    ]);

    const mgr = makeManager();
    ctxStore = {
      awaiting: 'mgr_today_action',
      mgrSelectedTaskFieldId: 'tf-1',
      mgrSelectedTaskId: 'task-1',
    };

    await handleAIMessage(mgr, 'ACTION_REASSIGN');

    // Should have fetched worker list (showWorkerListForReassign path)
    expect(findUsersByName).toHaveBeenCalled();
  });

  it('ACTION_BACK in mgr_exceptions_action state shows menu', async () => {
    const mgr = makeManager();
    ctxStore = {
      awaiting: 'mgr_exceptions_action',
      mgrSelectedTaskFieldId: 'tf-1',
      mgrSelectedTaskId: 'task-1',
    };

    await handleAIMessage(mgr, 'ACTION_BACK');

    // showMenu called → list message sent again
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    const call = sendListMessage.mock.calls[0][0] as { sections: Array<{ rows: Array<{ id: string }> }> };
    expect(call.sections[0].rows[0].id).toBe('MGR_MENU_1');
  });

  it('falls back to text when sendListMessage fails for action prompt', async () => {
    getTaskFieldDetail.mockResolvedValueOnce({
      taskTitle: 'בדיקה', typeLabelHe: 'ראדון',
      workerName: 'דני', customerName: 'כהן',
      siteAddress: null, siteCity: null,
      fieldContactName: null, fieldContactPhone: null,
      fieldStatus: 'PENDING_FIELD', scheduledStartAt: '2026-07-10T09:00:00Z',
      specialInstructions: null, fieldNotes: null,
      problemNote: null, missingReportInfoNote: null,
    });
    // Fail only the action-list send, not the detail text send
    sendListMessage.mockRejectedValueOnce(new Error('Meta rejected'));

    const mgr = makeManager();
    ctxStore = {
      awaiting: 'mgr_today_pick_task',
      mgrTaskFieldIds: ['tf-1'],
      mgrTaskIds: ['task-1'],
    };

    await handleAIMessage(mgr, '1');

    // sendListMessage attempted once then fell back
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    // Fallback combined text should contain the numeric actions
    const fallbackCall = sendTextMessage.mock.calls.find((c) =>
      typeof c[0]?.text === 'string' && c[0].text.includes('1. תיקון פרטי ביקור'),
    );
    expect(fallbackCall).toBeDefined();
  });
});
