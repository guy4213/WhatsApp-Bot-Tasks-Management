/**
 * managerDateRange.test.ts — D5-T11 Phase 4
 *
 * Verifies that dateRange params emitted by the LLM are correctly extracted and
 * forwarded to the service mocks for the three manager intents:
 *   - list_open_exceptions
 *   - list_pending_leads
 *   - workers_day_overview
 *
 * Invalid dateRange handling decision: IGNORED (falls back to today).
 * If the LLM emits a malformed dateRange (non-date strings, from > to, missing
 * keys, wrong type), `extractDateRange` returns null and each handler falls
 * back to `localJerusalemDate()` for today's window. This is simpler and
 * safer than routing to "unknown" — the manager still gets a useful response.
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

const findUnassignedLeadsForAssignment = vi.fn();
const findEscalationCandidates = vi.fn();

vi.mock('../services/incomingLeads', () => ({
  findUnassignedLeadsForAssignment: (...a: unknown[]) => findUnassignedLeadsForAssignment(...a),
  findActiveInspectors: vi.fn().mockResolvedValue([]),
  assignLead: vi.fn().mockResolvedValue(undefined),
  findUnassignedInWindow: vi.fn().mockResolvedValue([]),
  findOvernightUnassignedLeads: vi.fn().mockResolvedValue([]),
  findNewlyAssignedLeads: vi.fn().mockResolvedValue([]),
  findEscalationCandidates: (...a: unknown[]) => findEscalationCandidates(...a),
  getYoramLeadCounts: vi.fn().mockResolvedValue({ overnight: 0, unassigned: 0 }),
}));

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

let ctxStore: Record<string, unknown> | null = null;
const setContext = vi.fn(async (_phone: string, state: unknown) => { ctxStore = state as Record<string, unknown>; });
const getContext = vi.fn(async () => null);
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function makeIntent(intent: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
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

const admin = makeManager();

beforeEach(() => {
  msgLog.length = 0;
  sendTextMessage.mockClear();
  sendListMessage.mockClear();
  setContext.mockClear();
  clearContext.mockClear();
  getContext.mockClear();
  parseIntentMock.mockClear();
  ctxStore = null;
  getFieldExceptionRows.mockReset();
  getAllWorkersDayOverview.mockReset();
  getWorkerDayDetail.mockReset();
  findUnassignedLeadsForAssignment.mockReset();
  findEscalationCandidates.mockReset();
});

afterEach(() => { vi.restoreAllMocks(); });

const DR = { from: '2026-07-01', to: '2026-07-04' };

// ── list_open_exceptions with dateRange ───────────────────────────────────────

describe('list_open_exceptions — dateRange forwarding', () => {
  it('passes dateRange to getFieldExceptionRows when present', async () => {
    const exRow = {
      taskFieldId: 'tf1', taskId: 't1', workerName: 'דני', customerName: 'לקוח',
      siteCity: 'רעננה', fieldStatus: 'HAS_PROBLEM', description: 'בעיה פתוחה',
    };
    getFieldExceptionRows.mockResolvedValue([exRow]);
    parseIntentMock.mockResolvedValue(makeIntent('list_open_exceptions', {
      params: { filter: 'open', dateRange: DR },
    }));
    await handleAIMessage(admin, 'חריגים של 1/7 עד 3/7');
    // Service called with localDate (any string), the resolved filter, AND the dateRange.
    expect(getFieldExceptionRows).toHaveBeenCalledWith(
      expect.any(String),   // localDate (today)
      'open_exceptions',
      DR,
    );
  });

  it('passes undefined (no dateRange) when dateRange is absent — today default', async () => {
    getFieldExceptionRows.mockResolvedValue([]);
    parseIntentMock.mockResolvedValue(makeIntent('list_open_exceptions', {
      params: { filter: 'open' },
    }));
    await handleAIMessage(admin, 'תציג את החריגים');
    expect(getFieldExceptionRows).toHaveBeenCalledWith(
      expect.any(String),
      'open_exceptions',
      undefined,
    );
  });

  it('ignores invalid dateRange (from > to) — falls back to undefined', async () => {
    getFieldExceptionRows.mockResolvedValue([]);
    parseIntentMock.mockResolvedValue(makeIntent('list_open_exceptions', {
      params: { filter: 'open', dateRange: { from: '2026-07-05', to: '2026-07-01' } },
    }));
    await handleAIMessage(admin, 'חריגים');
    expect(getFieldExceptionRows).toHaveBeenCalledWith(
      expect.any(String),
      'open_exceptions',
      undefined,  // invalid range discarded
    );
  });

  it('ignores invalid dateRange (non-date strings) — falls back to undefined', async () => {
    getFieldExceptionRows.mockResolvedValue([]);
    parseIntentMock.mockResolvedValue(makeIntent('list_open_exceptions', {
      params: { filter: 'open', dateRange: { from: 'yesterday', to: 'today' } },
    }));
    await handleAIMessage(admin, 'חריגים');
    expect(getFieldExceptionRows).toHaveBeenCalledWith(
      expect.any(String),
      'open_exceptions',
      undefined,
    );
  });
});

// ── list_pending_leads with dateRange ─────────────────────────────────────────

describe('list_pending_leads — dateRange forwarding', () => {
  it('passes dateRange to findUnassignedLeadsForAssignment when filter=unassigned', async () => {
    findUnassignedLeadsForAssignment.mockResolvedValue([]);
    parseIntentMock.mockResolvedValue(makeIntent('list_pending_leads', {
      params: { filter: 'unassigned', dateRange: DR },
    }));
    await handleAIMessage(admin, 'לידים של שבוע זה');
    expect(findUnassignedLeadsForAssignment).toHaveBeenCalledWith(20, DR);
  });

  it('passes undefined when dateRange is absent (all-open, existing behavior)', async () => {
    findUnassignedLeadsForAssignment.mockResolvedValue([]);
    parseIntentMock.mockResolvedValue(makeIntent('list_pending_leads', {
      params: { filter: 'unassigned' },
    }));
    await handleAIMessage(admin, 'לידים ממתינים');
    expect(findUnassignedLeadsForAssignment).toHaveBeenCalledWith(20, undefined);
  });

  it('does NOT call findUnassignedLeadsForAssignment for escalated filter (uses findEscalationCandidates)', async () => {
    findEscalationCandidates.mockResolvedValue([]);
    parseIntentMock.mockResolvedValue(makeIntent('list_pending_leads', {
      params: { filter: 'escalated', dateRange: DR },
    }));
    await handleAIMessage(admin, 'לידים באיחור');
    expect(findEscalationCandidates).toHaveBeenCalled();
    expect(findUnassignedLeadsForAssignment).not.toHaveBeenCalled();
  });
});

// ── workers_day_overview with dateRange ───────────────────────────────────────

describe('workers_day_overview — dateRange forwarding', () => {
  const mockWorkers = [
    { workerId: 'w1', workerName: 'דני', finished: 3, total: 4, exceptions: 0 },
    { workerId: 'w2', workerName: 'יוסי', finished: 2, total: 3, exceptions: 1 },
  ];

  it('passes dateRange to getAllWorkersDayOverview for all-workers view', async () => {
    getAllWorkersDayOverview.mockResolvedValue(mockWorkers);
    parseIntentMock.mockResolvedValue(makeIntent('workers_day_overview', {
      params: { dateRange: DR },
    }));
    await handleAIMessage(admin, 'מה כולם עשו השבוע');
    expect(getAllWorkersDayOverview).toHaveBeenCalledWith(
      expect.any(String),  // localDate
      DR,
    );
  });

  it('passes dateRange to both getAllWorkersDayOverview and getWorkerDayDetail for named worker', async () => {
    getAllWorkersDayOverview.mockResolvedValue(mockWorkers);
    getWorkerDayDetail.mockResolvedValue({ inspections: [], finished: 0, total: 0, openExceptions: 0 });
    parseIntentMock.mockResolvedValue(makeIntent('workers_day_overview', {
      params: { workerName: 'דני', dateRange: DR },
    }));
    await handleAIMessage(admin, 'סיכום של דני מהשבוע');
    expect(getAllWorkersDayOverview).toHaveBeenCalledWith(expect.any(String), DR);
    expect(getWorkerDayDetail).toHaveBeenCalledWith('w1', expect.any(String), DR);
  });

  it('passes undefined when dateRange is absent — today default (all-workers)', async () => {
    getAllWorkersDayOverview.mockResolvedValue(mockWorkers);
    parseIntentMock.mockResolvedValue(makeIntent('workers_day_overview', {
      params: {},
    }));
    await handleAIMessage(admin, 'סיכום עובדים');
    expect(getAllWorkersDayOverview).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
    );
  });

  it('passes undefined when dateRange is absent — today default (named worker)', async () => {
    getAllWorkersDayOverview.mockResolvedValue(mockWorkers);
    getWorkerDayDetail.mockResolvedValue({ inspections: [], finished: 0, total: 0, openExceptions: 0 });
    parseIntentMock.mockResolvedValue(makeIntent('workers_day_overview', {
      params: { workerName: 'דני' },
    }));
    await handleAIMessage(admin, 'מה דני עשה היום');
    expect(getAllWorkersDayOverview).toHaveBeenCalledWith(expect.any(String), undefined);
    expect(getWorkerDayDetail).toHaveBeenCalledWith('w1', expect.any(String), undefined);
  });

  it('shows date-range label in message when dateRange is present', async () => {
    getAllWorkersDayOverview.mockResolvedValue(mockWorkers);
    parseIntentMock.mockResolvedValue(makeIntent('workers_day_overview', {
      params: { dateRange: DR },
    }));
    await handleAIMessage(admin, 'מה כולם עשו');
    const msg = msgLog[msgLog.length - 1] ?? '';
    // The label should contain the from date in DD/MM format
    expect(msg).toContain('01/07');
  });

  it('ignores invalid dateRange (non-YYYY-MM-DD) — falls back to today', async () => {
    getAllWorkersDayOverview.mockResolvedValue(mockWorkers);
    parseIntentMock.mockResolvedValue(makeIntent('workers_day_overview', {
      params: { dateRange: { from: 'abc', to: 'def' } },
    }));
    await handleAIMessage(admin, 'סיכום עובדים');
    expect(getAllWorkersDayOverview).toHaveBeenCalledWith(expect.any(String), undefined);
  });
});
