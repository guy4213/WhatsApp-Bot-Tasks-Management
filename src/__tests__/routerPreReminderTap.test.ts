/**
 * D2-T15 — Router-level tests for pre-reminder button taps.
 *
 * Coverage:
 *  - matchPreReminderTap regex — happy paths + rejects other payloads
 *  - PREREMIND_DEPART_... → advances fieldStatus to EN_ROUTE (mocked service)
 *  - PREREMIND_DEPART_... on already-EN_ROUTE row → does NOT advance, sends "already" message
 *  - PREREMIND_NEED_INFO_... → sets awaiting pre_reminder_need_info_note
 *  - PREREMIND_PROBLEM_... → routes to problem_type_choice flow
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// ── Pool mock (for the status check in DEPART handler) ───────────────────────

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

// ── Inspections service mock ──────────────────────────────────────────────────

const advanceFieldStatus = vi.fn().mockResolvedValue(undefined);
const findOpenTaskFieldForWorker = vi.fn();
const resolveOpenTaskFieldByHint = vi.fn();
const writeFieldNotes = vi.fn().mockResolvedValue(undefined);
const writeMissingInfo = vi.fn().mockResolvedValue(undefined);
const writeProblem = vi.fn().mockResolvedValue(undefined);
// D5-T19a: notifyOffice* return Promise<boolean> (true = actually delivered).
const notifyOfficeMissingInfo = vi.fn().mockResolvedValue(true);
const notifyOfficeProblem = vi.fn().mockResolvedValue(true);
const notifyOfficeMissingEquipment = vi.fn().mockResolvedValue(true);
const dayFieldSummary = vi.fn().mockResolvedValue({ finished: [], waitingForInfoCount: 0 });
const confirmInspection = vi.fn().mockResolvedValue(undefined);
const declineInspection = vi.fn().mockResolvedValue(undefined);
const requestMoreInfo = vi.fn().mockResolvedValue(undefined);
const notifyOfficeDeclined = vi.fn().mockResolvedValue(true);
const notifyOfficeNeedsMoreInfo = vi.fn().mockResolvedValue(true);
// Active-task context (Phase 1) — default: no in-progress match, validation ok.
const findActiveInProgressTaskFieldForWorker = vi.fn().mockResolvedValue(null);
const validateWorkerTaskField = vi.fn().mockResolvedValue({ ok: true, taskFieldId: 'tf-x', fieldStatus: 'EN_ROUTE', customerName: null, taskTitle: null });
const writeTravelEta = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/inspections', () => ({
  findOpenTaskFieldForWorker: (...a: unknown[]) => findOpenTaskFieldForWorker(...a),
  findActiveInProgressTaskFieldForWorker: (...a: unknown[]) => findActiveInProgressTaskFieldForWorker(...a),
  validateWorkerTaskField: (...a: unknown[]) => validateWorkerTaskField(...a),
  writeTravelEta: (...a: unknown[]) => writeTravelEta(...a),
  resolveOpenTaskFieldByHint: (...a: unknown[]) => resolveOpenTaskFieldByHint(...a),
  advanceFieldStatus: (...a: unknown[]) => advanceFieldStatus(...a),
  writeFieldNotes: (...a: unknown[]) => writeFieldNotes(...a),
  writeMissingInfo: (...a: unknown[]) => writeMissingInfo(...a),
  writeProblem: (...a: unknown[]) => writeProblem(...a),
  notifyOfficeMissingInfo: (...a: unknown[]) => notifyOfficeMissingInfo(...a),
  notifyOfficeProblem: (...a: unknown[]) => notifyOfficeProblem(...a),
  notifyOfficeMissingEquipment: (...a: unknown[]) => notifyOfficeMissingEquipment(...a),
  dayFieldSummary: (...a: unknown[]) => dayFieldSummary(...a),
  confirmInspection: (...a: unknown[]) => confirmInspection(...a),
  declineInspection: (...a: unknown[]) => declineInspection(...a),
  requestMoreInfo: (...a: unknown[]) => requestMoreInfo(...a),
  notifyOfficeDeclined: (...a: unknown[]) => notifyOfficeDeclined(...a),
  notifyOfficeNeedsMoreInfo: (...a: unknown[]) => notifyOfficeNeedsMoreInfo(...a),
}));

// ── Sender mock ───────────────────────────────────────────────────────────────

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
const sendListMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage:   (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
  sendListMessage:   (...a: unknown[]) => sendListMessage(...a),
}));

// ── Conversation context mock ─────────────────────────────────────────────────

let ctxStore: Record<string, unknown> | null = null;
const setContext = vi.fn(async (_phone: string, state: unknown) => {
  ctxStore = state as Record<string, unknown>;
});
const getContext = vi.fn(async () => ctxStore);
const clearContext = vi.fn(async () => { ctxStore = null; });
// Active-task pointer (Phase 1) — stateful over the same ctxStore.
const setActiveInspection = vi.fn(async (
  _phone: string, taskFieldId: string, departedAt: string,
  opts: { awaiting?: string; etaMinutes?: number } = {},
) => {
  ctxStore = {
    awaiting: opts.awaiting ?? 'idle_active_inspection',
    taskFieldId,
    activeInspection: {
      taskFieldId, departedAt,
      expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
      etaMinutes: opts.etaMinutes,
    },
  };
});
const getActiveInspection = vi.fn(async () =>
  (ctxStore as { activeInspection?: unknown } | null)?.activeInspection ?? null);
const clearActiveInspection = vi.fn(async () => { ctxStore = null; });
vi.mock('../services/conversationContext', () => ({
  setContext: (phone: string, state: unknown) => setContext(phone, state),
  getContext: (_phone: string) => getContext(),
  clearContext: (_phone: string) => clearContext(),
  setActiveInspection: (...a: unknown[]) => (setActiveInspection as (...x: unknown[]) => unknown)(...a),
  getActiveInspection: (_phone: string) => getActiveInspection(),
  clearActiveInspection: (_phone: string) => clearActiveInspection(),
}));

// ── Other required mocks ──────────────────────────────────────────────────────

vi.mock('../services/chatHistory', () => ({
  appendTurn: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../ai/provider', () => ({
  getProvider: () => ({ name: 'test' }),
}));
vi.mock('../ai/intentParser', () => ({
  parseIntent: vi.fn().mockResolvedValue({ intent: 'help', confidence: 0 }),
}));
vi.mock('../services/tasks', () => ({
  listTasks: vi.fn().mockResolvedValue([]),
  getTaskById: vi.fn(),
  getAllowedTaskTypes: vi.fn().mockResolvedValue([]),
  getAllowedPriorities: vi.fn().mockResolvedValue([]),
  findUsersByName: vi.fn().mockResolvedValue([]),
  getEmployeeEndOfDay: vi.fn().mockResolvedValue([]),
  getCompanyEndOfDay: vi.fn().mockResolvedValue([]),
}));
vi.mock('../utils/auditLog', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/pendingActions', () => ({
  getManagersForBroadcast: vi.fn().mockResolvedValue([]),
}));
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
vi.mock('../ai/digestCommands', () => ({
  matchDigestCommand: vi.fn().mockReturnValue(null),
  planDigestCommand: vi.fn(),
}));
vi.mock('../services/digestPreferences', () => ({
  getEffectiveDigestPreference: vi.fn().mockResolvedValue(null),
  upsertDigestPreference: vi.fn(),
  parseTimeInput: vi.fn(),
}));
vi.mock('../services/viewContext', () => ({
  setViewOwners: vi.fn(),
  getViewOwners: vi.fn().mockReturnValue(null),
  clearViewOwners: vi.fn(),
}));
vi.mock('../services/taskContext', () => ({
  setActiveTask: vi.fn(),
  getActiveTask: vi.fn().mockResolvedValue(null),
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
vi.mock('../ai/leadSuggester', () => ({
  suggestWorkerForLead: vi.fn().mockResolvedValue({ userId: null, reason: '' }),
}));
vi.mock('../services/leadCategorizer', () => ({
  enrichLead: vi.fn().mockResolvedValue(null),
}));
vi.mock('../whatsapp/leadDisplay', () => ({
  formatLeadListRowCompact: vi.fn().mockReturnValue(''),
  formatLeadDetailCompact: vi.fn().mockReturnValue(''),
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
vi.mock('../services/preInspectionReminder', () => ({
  preReminderDepartPayloadId: (id: string) => `PREREMIND_DEPART_${id}`,
  preReminderNeedInfoPayloadId: (id: string) => `PREREMIND_NEED_INFO_${id}`,
  preReminderProblemPayloadId: (id: string) => `PREREMIND_PROBLEM_${id}`,
}));
vi.mock('../ai/contextExtractor', () => ({
  extractFromContext: vi.fn().mockResolvedValue(null),
  extractNote: vi.fn().mockImplementation(async (text: string) => text),
  extractInspectionActions: vi.fn().mockResolvedValue([]),
}));

import { handleAIMessage } from '../ai/router';
import { parseIntent } from '../ai/intentParser';

const TASK_FIELD_ID = '33333333-3333-3333-3333-333333333333';
const UUID_RE = TASK_FIELD_ID;

import type { ResolvedUser } from '../types';

function makeUser(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'user-1',
    phone: '972501111111',
    name: 'דני',
    role: 'SALES',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ctxStore = null;
  poolQuery.mockReset();
  sendTextMessage.mockResolvedValue(undefined);
  sendListMessage.mockResolvedValue(undefined);
  advanceFieldStatus.mockResolvedValue(undefined);
  findActiveInProgressTaskFieldForWorker.mockResolvedValue(null);
  validateWorkerTaskField.mockResolvedValue({ ok: true, taskFieldId: 'tf-x', fieldStatus: 'EN_ROUTE', customerName: null, taskTitle: null });
  writeTravelEta.mockResolvedValue(undefined);
  requestMoreInfo.mockResolvedValue(undefined);
  // D5-T19a: notifyOffice* return Promise<boolean> — default to true (happy path).
  notifyOfficeNeedsMoreInfo.mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); });

// ── matchPreReminderTap regex ─────────────────────────────────────────────────

describe('matchPreReminderTap regex (via handleAIMessage routing)', () => {
  // These tests verify the router correctly dispatches all three kinds.

  it('routes PREREMIND_DEPART_<uuid> without calling parseIntent', async () => {
    // DEPART: DB returns ASSIGNED (not yet advanced)
    poolQuery.mockResolvedValueOnce({ rows: [{ fieldStatus: 'ASSIGNED' }] });
    advanceFieldStatus.mockResolvedValueOnce(undefined);

    await handleAIMessage(makeUser(), `PREREMIND_DEPART_${TASK_FIELD_ID}`);

    // advanceFieldStatus should have been called with DEPARTED
    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: TASK_FIELD_ID,
      transition: 'DEPARTED',
      updatedBy: 'user-1',
    });
  });

  it('routes PREREMIND_NEED_INFO_<uuid>', async () => {
    await handleAIMessage(makeUser(), `PREREMIND_NEED_INFO_${TASK_FIELD_ID}`);
    expect(setContext).toHaveBeenCalledWith(
      '972501111111',
      expect.objectContaining({ awaiting: 'pre_reminder_need_info_note', taskFieldId: TASK_FIELD_ID }),
    );
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('פרטים') }),
    );
  });

  it('routes PREREMIND_PROBLEM_<uuid> to problem_type_choice', async () => {
    // sendListMessage succeeds (problem menu sent as list)
    sendListMessage.mockResolvedValueOnce(undefined);

    await handleAIMessage(makeUser(), `PREREMIND_PROBLEM_${TASK_FIELD_ID}`);

    expect(setContext).toHaveBeenCalledWith(
      '972501111111',
      expect.objectContaining({ awaiting: 'problem_type_choice', taskFieldId: TASK_FIELD_ID }),
    );
  });

  it('does NOT match INSP_ payloads', async () => {
    // If matchPreReminderTap returned a result for INSP_ payloads, handleAIMessage
    // would set context to pre_reminder_need_info_note or problem_type_choice.
    // Instead it should route to the INSP_ handler. We just verify it doesn't
    // match by checking no pre-reminder state is set.
    const payload = `INSP_CONFIRM_${TASK_FIELD_ID}`;
    confirmInspection.mockResolvedValueOnce(undefined);
    await handleAIMessage(makeUser(), payload);
    // confirmInspection should have been called (INSP_ path), not pre-reminder
    expect(confirmInspection).toHaveBeenCalled();
    // No pre_reminder state set
    expect(setContext).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ awaiting: 'pre_reminder_need_info_note' }),
    );
  });

  it('does NOT match arbitrary text', async () => {
    // "שלום" should not trigger any pre-reminder path
    await handleAIMessage(makeUser(), 'שלום');
    expect(advanceFieldStatus).not.toHaveBeenCalled();
    expect(setContext).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ awaiting: 'pre_reminder_need_info_note' }),
    );
  });

  it('does NOT match PREREMIND_ without a valid UUID', async () => {
    // Short/invalid id — should not route to pre-reminder handler
    await handleAIMessage(makeUser(), 'PREREMIND_DEPART_not-a-uuid');
    expect(advanceFieldStatus).not.toHaveBeenCalled();
  });
});

// ── PREREMIND_DEPART: already-advanced guard ──────────────────────────────────

describe('PREREMIND_DEPART on already-advanced status', () => {
  it('does NOT call advanceFieldStatus when fieldStatus is EN_ROUTE', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ fieldStatus: 'EN_ROUTE' }] });

    await handleAIMessage(makeUser(), `PREREMIND_DEPART_${TASK_FIELD_ID}`);

    expect(advanceFieldStatus).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('כבר מתקדם') }),
    );
  });

  it('does NOT call advanceFieldStatus when fieldStatus is ARRIVED', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ fieldStatus: 'ARRIVED' }] });

    await handleAIMessage(makeUser(), `PREREMIND_DEPART_${TASK_FIELD_ID}`);

    expect(advanceFieldStatus).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('כבר מתקדם') }),
    );
  });

  it('does NOT call advanceFieldStatus when fieldStatus is FINISHED_FIELD', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ fieldStatus: 'FINISHED_FIELD' }] });

    await handleAIMessage(makeUser(), `PREREMIND_DEPART_${TASK_FIELD_ID}`);

    expect(advanceFieldStatus).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('כבר מתקדם') }),
    );
  });

  it('DOES call advanceFieldStatus when fieldStatus is CONFIRMED', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ fieldStatus: 'CONFIRMED' }] });
    advanceFieldStatus.mockResolvedValueOnce(undefined);

    await handleAIMessage(makeUser(), `PREREMIND_DEPART_${TASK_FIELD_ID}`);

    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: TASK_FIELD_ID,
      transition: 'DEPARTED',
      updatedBy: 'user-1',
    });
    // DEPART now goes through performTransition → asks for the travel ETA
    // (same as a typed "יצאתי").
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('נסיעה') }),
    );
  });
});

// ── PREREMIND_DEPART feeds the active-task context (Phase 1) ───────────────────

describe('PREREMIND_DEPART → active-task context (Phase 1)', () => {
  it('stores the active pointer and, afterwards, "הגעתי"/"סיימתי" stay on the SAME TaskField', async () => {
    // 1. Tap "יצאתי" from the pre-reminder card (status ASSIGNED → advances).
    poolQuery.mockResolvedValueOnce({ rows: [{ fieldStatus: 'ASSIGNED' }] });
    await handleAIMessage(makeUser(), `PREREMIND_DEPART_${TASK_FIELD_ID}`);
    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: TASK_FIELD_ID, transition: 'DEPARTED', updatedBy: 'user-1',
    });
    // Pointer stored (not a direct advance that bypasses the mechanism).
    expect(ctxStore).toMatchObject({
      awaiting: 'status_eta_prompt',
      activeInspection: { taskFieldId: TASK_FIELD_ID },
    });

    // 2. "הגעתי" (keyword during the ETA prompt) → ARRIVED on the SAME TaskField.
    advanceFieldStatus.mockClear();
    await handleAIMessage(makeUser(), 'הגעתי');
    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: TASK_FIELD_ID, transition: 'ARRIVED', updatedBy: 'user-1',
    });

    // 3. "סיימתי" (fresh AI message, resolved via the stored pointer) → FINISHED
    //    on the SAME TaskField.
    advanceFieldStatus.mockClear();
    validateWorkerTaskField.mockResolvedValueOnce({ ok: true, taskFieldId: TASK_FIELD_ID, fieldStatus: 'ARRIVED', customerName: null, taskTitle: null });
    (parseIntent as unknown as Mock).mockResolvedValueOnce({
      intent: 'set_field_status', confidence: 0.96, task_reference: null, field: null,
      new_value: null, params: {}, missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: 'FINISHED', problem_type: null,
    });
    await handleAIMessage(makeUser(), 'סיימתי');
    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: TASK_FIELD_ID, transition: 'FINISHED', updatedBy: 'user-1',
    });
    // Resolution used the stored pointer (not the "any open" fallback).
    expect(findOpenTaskFieldForWorker).not.toHaveBeenCalled();
  });
});

// ── PREREMIND_NEED_INFO awaiting state ────────────────────────────────────────

describe('PREREMIND_NEED_INFO_... → sets awaiting state', () => {
  it('sets pre_reminder_need_info_note and prompts for details', async () => {
    await handleAIMessage(makeUser(), `PREREMIND_NEED_INFO_${TASK_FIELD_ID}`);

    expect(setContext).toHaveBeenCalledWith('972501111111', {
      awaiting: 'pre_reminder_need_info_note',
      taskFieldId: TASK_FIELD_ID,
    });
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('פרטים חסרים') }),
    );
  });
});

// ── PREREMIND_PROBLEM → routes to problem flow ────────────────────────────────

describe('PREREMIND_PROBLEM_... → routes to problem_type_choice', () => {
  it('sets problem_type_choice awaiting state with the correct taskFieldId', async () => {
    sendListMessage.mockResolvedValueOnce(undefined);

    await handleAIMessage(makeUser(), `PREREMIND_PROBLEM_${TASK_FIELD_ID}`);

    expect(setContext).toHaveBeenCalledWith('972501111111', {
      awaiting: 'problem_type_choice',
      taskFieldId: TASK_FIELD_ID,
    });
  });
});
