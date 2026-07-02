/**
 * D2-T12 + D2-T13 + D2-T14 — router-level flow tests.
 *
 * Coverage:
 *  D2-T12 (correct_task_field_site):
 *    - WORKER rejected when taskField belongs to another worker
 *    - happy path: resolve TaskField → await_value state → parse "field: value" → write
 *    - invalid field label → error prompt
 *    - cancellation via "לא"
 *
 *  D2-T13 (reassign_task):
 *    - WORKER rejected with Hebrew auth error
 *    - MANAGER happy path: task_reference → worker list → pick → write
 *    - in-progress warning appended
 *
 *  D2-T14 (correct_inspection_type):
 *    - WORKER rejected when taskField belongs to another worker
 *    - closed TaskField → "בדיקה כבר סגורה" rejection
 *    - happy path: resolve → show list → pick → confirm → write + notification ack
 *    - "לא" at confirm step → cancelled
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// taskFieldCorrections service
const updateSiteMetadata = vi.fn().mockResolvedValue(undefined);
const reassignTask = vi.fn().mockResolvedValue({ resetCount: 1, hadInProgressRows: false });
const correctInspectionType = vi.fn().mockResolvedValue({ oldProductName: '73', newProductName: '62' });
const ClosedInspectionError = class extends Error { constructor(msg: string) { super(msg); this.name = 'ClosedInspectionError'; } };
const listInspectionTypes = vi.fn().mockResolvedValue([]);
const getTaskFieldForCorrection = vi.fn().mockResolvedValue(null);

vi.mock('../services/taskFieldCorrections', () => ({
  updateSiteMetadata: (...a: unknown[]) => updateSiteMetadata(...a),
  reassignTask: (...a: unknown[]) => reassignTask(...a),
  correctInspectionType: (...a: unknown[]) => correctInspectionType(...a),
  ClosedInspectionError,
  listInspectionTypes: (...a: unknown[]) => listInspectionTypes(...a),
  getTaskFieldForCorrection: (...a: unknown[]) => getTaskFieldForCorrection(...a),
}));

// inspections service
const findOpenTaskFieldForWorker = vi.fn();
const resolveOpenTaskFieldByHint = vi.fn();
const advanceFieldStatus = vi.fn().mockResolvedValue(undefined);
const writeFieldNotes = vi.fn().mockResolvedValue(undefined);
const writeMissingInfo = vi.fn().mockResolvedValue(undefined);
const writeProblem = vi.fn().mockResolvedValue(undefined);
const notifyOfficeMissingInfo = vi.fn().mockResolvedValue(undefined);
const notifyOfficeProblem = vi.fn().mockResolvedValue(undefined);
const notifyOfficeMissingEquipment = vi.fn().mockResolvedValue(undefined);
const dayFieldSummary = vi.fn().mockResolvedValue({ finished: [], waitingForInfoCount: 0 });
const confirmInspection = vi.fn().mockResolvedValue(undefined);
const declineInspection = vi.fn().mockResolvedValue(undefined);
const requestMoreInfo = vi.fn().mockResolvedValue(undefined);
const notifyOfficeDeclined = vi.fn().mockResolvedValue(undefined);
const notifyOfficeNeedsMoreInfo = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/inspections', () => ({
  findOpenTaskFieldForWorker: (...a: unknown[]) => findOpenTaskFieldForWorker(...a),
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

// tasks service (findUsersByName for reassign worker list)
const findUsersByName = vi.fn().mockResolvedValue([]);
const listTasks = vi.fn().mockResolvedValue({ tasks: [], truncated: false });
const getTaskById = vi.fn().mockResolvedValue(null);
const getAllowedTaskTypes = vi.fn().mockResolvedValue([]);
const getAllowedPriorities = vi.fn().mockResolvedValue([]);
const getEmployeeEndOfDay = vi.fn().mockResolvedValue({});
const getCompanyEndOfDay = vi.fn().mockResolvedValue({});
vi.mock('../services/tasks', () => ({
  findUsersByName: (...a: unknown[]) => findUsersByName(...a),
  listTasks: (...a: unknown[]) => listTasks(...a),
  getTaskById: (...a: unknown[]) => getTaskById(...a),
  getAllowedTaskTypes: (...a: unknown[]) => getAllowedTaskTypes(...a),
  getAllowedPriorities: (...a: unknown[]) => getAllowedPriorities(...a),
  getEmployeeEndOfDay: (...a: unknown[]) => getEmployeeEndOfDay(...a),
  getCompanyEndOfDay: (...a: unknown[]) => getCompanyEndOfDay(...a),
}));

// taskResolver
const resolveTask = vi.fn().mockResolvedValue({ match: null, ambiguous: false, candidates: [] });
vi.mock('../ai/taskResolver', () => ({
  resolveTask: (...a: unknown[]) => resolveTask(...a),
}));

// sender
const sendTextMessage   = vi.fn().mockResolvedValue(undefined);
const sendButtonMessage = vi.fn().mockResolvedValue(undefined);
const sendListMessage   = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage:   (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: (...a: unknown[]) => sendButtonMessage(...a),
  sendListMessage:   (...a: unknown[]) => sendListMessage(...a),
}));

// Conversation context: simple in-memory state.
let ctxStore: Record<string, unknown> | null = null;
const setContext = vi.fn(async (_phone: string, state: unknown) => { ctxStore = state as Record<string, unknown>; });
const getContext = vi.fn(async () => ctxStore);
const clearContext = vi.fn(async () => { ctxStore = null; });
vi.mock('../services/conversationContext', () => ({
  setContext: (phone: string, state: unknown) => setContext(phone, state),
  getContext: (_phone: string) => getContext(),
  clearContext: (_phone: string) => clearContext(),
}));

vi.mock('../services/chatHistory', () => ({
  appendTurn: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue([]),
}));

vi.mock('../ai/provider', () => ({ getProvider: () => ({ name: 'test' }) }));
vi.mock('../ai/intentParser', () => ({
  parseIntent: vi.fn().mockRejectedValue(new Error('unused')),
}));
vi.mock('../utils/auditLog', () => ({
  writeAuditLog: vi.fn().mockResolvedValue('audit-id'),
  updateTranscribedMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/pendingActions', () => ({
  getManagersForBroadcast: vi.fn().mockResolvedValue([]),
}));
vi.mock('../whatsapp/digestContent', () => ({
  formatDayFieldSummary: vi.fn().mockReturnValue('summary'),
  formatEmployeeEndOfDay: vi.fn().mockReturnValue({ text: 'eod' }),
  formatManagerEndOfDay: vi.fn().mockReturnValue({ text: 'meod' }),
}));
vi.mock('../ai/digestCommands', () => ({
  matchDigestCommand: vi.fn().mockReturnValue(null),
  planDigestCommand: vi.fn().mockReturnValue({ kind: 'free_text' }),
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
vi.mock('../services/specialUsers', () => ({
  isLeadsViewer: vi.fn().mockReturnValue(false),
  isExceptionsViewer: vi.fn().mockReturnValue(false),
  isSasha: vi.fn().mockReturnValue(false),
}));
vi.mock('../services/incomingLeads', () => ({
  findUnassignedLeadsForAssignment: vi.fn().mockResolvedValue([]),
  findActiveInspectors: vi.fn().mockResolvedValue([]),
  assignLead: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../ai/leadSuggester', () => ({
  suggestWorkerForLead: vi.fn().mockResolvedValue(null),
}));
// D2-T11 scheduling service
vi.mock('../services/taskFieldScheduling', () => ({
  findRecentTasksForScheduling: vi.fn().mockResolvedValue([]),
  searchCustomersByName: vi.fn().mockResolvedValue([]),
  createTaskField: vi.fn().mockResolvedValue('new-tf-id'),
}));

// contextExtractor — default: returns low confidence so rigid path still runs.
const extractFromContext = vi.fn().mockResolvedValue({ values: {}, confidence: 0, clarification: null });
const extractNote = vi.fn().mockResolvedValue(null);
vi.mock('../ai/contextExtractor', () => ({
  extractFromContext: (...a: unknown[]) => extractFromContext(...a),
  extractNote: (...a: unknown[]) => extractNote(...a),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import type { ResolvedUser } from '../types';

function makeWorker(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-worker',
    name: 'דני',
    phone: '972501234567',
    role: 'SALES',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

function makeManager(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return makeWorker({ id: 'u-manager', name: 'ניהול', role: 'MANAGER', isElevated: true, ...overrides });
}

beforeEach(() => {
  ctxStore = null;
  findOpenTaskFieldForWorker.mockReset();
  resolveOpenTaskFieldByHint.mockReset();
  findUsersByName.mockReset(); findUsersByName.mockResolvedValue([]);
  resolveTask.mockReset(); resolveTask.mockResolvedValue({ match: null, ambiguous: false, candidates: [] });
  updateSiteMetadata.mockReset(); updateSiteMetadata.mockResolvedValue(undefined);
  reassignTask.mockReset(); reassignTask.mockResolvedValue({ resetCount: 1, hadInProgressRows: false });
  correctInspectionType.mockReset(); correctInspectionType.mockResolvedValue({ oldProductName: '73', newProductName: '62' });
  extractFromContext.mockReset(); extractFromContext.mockResolvedValue({ values: {}, confidence: 0, clarification: null });
  extractNote.mockReset(); extractNote.mockResolvedValue(null);
  listInspectionTypes.mockReset(); listInspectionTypes.mockResolvedValue([]);
  getTaskFieldForCorrection.mockReset(); getTaskFieldForCorrection.mockResolvedValue(null);
  sendTextMessage.mockReset(); sendTextMessage.mockResolvedValue(undefined);
  sendListMessage.mockReset(); sendListMessage.mockResolvedValue(undefined);
  setContext.mockClear();
  clearContext.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

async function loadRouter() {
  return await import('../ai/router');
}

// Send an intent directly into executeIntent-like path by pre-seeding intent_confirm
// OR by driving through the menu awaiting state that calls executeIntent.
// We use a direct call to handleAIMessage with an intent-triggered entry.
// The simplest path is to pre-set awaiting='intent_confirm' with the intent,
// then send "כן" to trigger executeIntent.
async function driveIntent(user: ResolvedUser, intent: Record<string, unknown>) {
  const { handleAIMessage } = await loadRouter();
  ctxStore = { awaiting: 'intent_confirm', intent };
  sendTextMessage.mockClear();
  await handleAIMessage(user, 'כן');
}

// Drive a multi-turn conversation: execute one turn then send a reply.
async function sendMessage(user: ResolvedUser, text: string) {
  const { handleAIMessage } = await loadRouter();
  await handleAIMessage(user, text);
}

// ─────────────────────────────────────────────────────────────────────────────
// D2-T12: correct_task_field_site
// ─────────────────────────────────────────────────────────────────────────────

describe('D2-T12 — correct_task_field_site', () => {
  it('asks for a task reference when task_reference is null', async () => {
    await driveIntent(makeWorker(), {
      intent: 'correct_task_field_site',
      confidence: 1,
      task_reference: null,
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    expect(ctxStore?.awaiting).toBe('correct_site_pick_task');
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][0].text).toContain('לאיזו בדיקה הכוונה');
  });

  it('shows field menu when TaskField resolves to a single match', async () => {
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: 'כהן' });

    await driveIntent(makeWorker(), {
      intent: 'correct_task_field_site',
      confidence: 1,
      task_reference: 'כהן',
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });

    expect(ctxStore?.awaiting).toBe('correct_site_await_value');
    expect(ctxStore?.taskFieldId).toBe('tf-1');
    // Site field picker is now a List Message.
    expect(sendListMessage).toHaveBeenCalledTimes(1);
    expect(sendListMessage.mock.calls[0][0].body).toContain('מה לתקן');
  });

  it('auth-rejects WORKER trying to correct another worker\'s TaskField', async () => {
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-1', customerName: 'ישראל' });
    // TaskField owner is a different worker.
    getTaskFieldForCorrection.mockResolvedValueOnce({
      taskFieldId: 'tf-1', taskId: 'task-1',
      taskOwnerId: 'other-worker', fieldStatus: 'ASSIGNED',
      currentInspectionTypeId: null, currentLabelHe: null,
    });

    // Get to await_value state.
    await driveIntent(makeWorker(), {
      intent: 'correct_task_field_site',
      confidence: 1, task_reference: 'ישראל',
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    // Worker sends a correction.
    await sendMessage(makeWorker(), 'כתובת אתר: רוטשילד 10');

    expect(updateSiteMetadata).not.toHaveBeenCalled();
    const text = sendTextMessage.mock.calls[0][0].text;
    expect(text).toContain('אין הרשאה');
  });

  it('writes updateSiteMetadata when WORKER corrects own TaskField', async () => {
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-own', customerName: 'לוי' });
    getTaskFieldForCorrection.mockResolvedValueOnce({
      taskFieldId: 'tf-own', taskId: 'task-1',
      taskOwnerId: 'u-worker', // matches makeWorker().id
      fieldStatus: 'ASSIGNED',
      currentInspectionTypeId: null, currentLabelHe: null,
    });

    await driveIntent(makeWorker(), {
      intent: 'correct_task_field_site', confidence: 1, task_reference: 'לוי',
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    await sendMessage(makeWorker(), 'כתובת אתר: רוטשילד 10 תל אביב');

    expect(updateSiteMetadata).toHaveBeenCalledWith(
      'tf-own',
      'u-worker',
      { siteAddress: 'רוטשילד 10 תל אביב' },
    );
    expect(sendTextMessage.mock.calls[0][0].text).toContain('עודכן בהצלחה');
    expect(ctxStore).toBeNull(); // context cleared
  });

  it('shows error on unknown field label', async () => {
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-own', customerName: 'לוי' });
    getTaskFieldForCorrection.mockResolvedValueOnce({
      taskFieldId: 'tf-own', taskId: 'task-1', taskOwnerId: 'u-worker',
      fieldStatus: 'ASSIGNED', currentInspectionTypeId: null, currentLabelHe: null,
    });

    await driveIntent(makeWorker(), {
      intent: 'correct_task_field_site', confidence: 1, task_reference: 'לוי',
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    await sendMessage(makeWorker(), 'שדה_לא_קיים: ערך');
    expect(updateSiteMetadata).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls[0][0].text).toContain('לא הכרתי את השדה');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2-T12 — AI extraction path tests
// ─────────────────────────────────────────────────────────────────────────────

describe('D2-T12 — correct_site AI extraction path', () => {
  it('auto-applies when AI returns high confidence (>= 0.85) and single field', async () => {
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-own', customerName: 'לוי' });
    getTaskFieldForCorrection.mockResolvedValueOnce({
      taskFieldId: 'tf-own', taskId: 'task-1', taskOwnerId: 'u-worker',
      fieldStatus: 'ASSIGNED', currentInspectionTypeId: null, currentLabelHe: null,
    });
    // Mock AI extractor: high confidence, fieldContactPhone
    extractFromContext.mockResolvedValueOnce({
      values: { siteAddress: null, siteCity: null, fieldContactName: null, fieldContactPhone: '050-9999999' },
      confidence: 0.92,
      clarification: null,
    });

    await driveIntent(makeWorker(), {
      intent: 'correct_task_field_site', confidence: 1, task_reference: 'לוי',
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    // Voice-style input (no colon) — should trigger AI extractor
    await sendMessage(makeWorker(), 'אני רוצה לעדכן את הטלפון של איש הקשר ל-050-9999999');

    expect(updateSiteMetadata).toHaveBeenCalledWith(
      'tf-own', 'u-worker', { fieldContactPhone: '050-9999999' },
    );
    expect(sendTextMessage.mock.calls[0][0].text).toContain('עודכן בהצלחה');
  });

  it('asks for confirmation at medium confidence (0.60-0.85)', async () => {
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-own', customerName: 'לוי' });
    // Mock AI extractor: medium confidence
    extractFromContext.mockResolvedValueOnce({
      values: { siteAddress: null, siteCity: 'חיפה', fieldContactName: null, fieldContactPhone: null },
      confidence: 0.72,
      clarification: null,
    });

    await driveIntent(makeWorker(), {
      intent: 'correct_task_field_site', confidence: 1, task_reference: 'לוי',
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    await sendMessage(makeWorker(), 'תעדכן את הערים לחיפה');

    // Should show confirmation prompt (via sendButtonMessage), not apply immediately
    expect(updateSiteMetadata).not.toHaveBeenCalled();
    expect(ctxStore?.awaiting).toBe('correct_site_confirm_extracted');
    // Confirmation is now sent via sendButtonMessage (Group A UX upgrade)
    const btnCalls = sendButtonMessage.mock.calls;
    const txtCalls = sendTextMessage.mock.calls;
    const confirmBody =
      (btnCalls[0]?.[0] as { body: string } | undefined)?.body ??
      txtCalls[0]?.[0]?.text ?? '';
    expect(confirmBody).toContain('הבנתי');
    expect(confirmBody).toContain('חיפה');
  });

  it('falls back to rigid rejection at low confidence (< 0.60)', async () => {
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-own', customerName: 'לוי' });
    extractFromContext.mockResolvedValueOnce({
      values: { siteAddress: null, siteCity: null, fieldContactName: null, fieldContactPhone: null },
      confidence: 0.2,
      clarification: 'לא הצלחתי לזהות',
    });

    await driveIntent(makeWorker(), {
      intent: 'correct_task_field_site', confidence: 1, task_reference: 'לוי',
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    await sendMessage(makeWorker(), 'שלום מה נשמע');

    expect(updateSiteMetadata).not.toHaveBeenCalled();
    // Should show rejection
    const text = sendTextMessage.mock.calls[0][0].text;
    expect(text).toMatch(/לא הצלחתי|לא הצלחתי לזהות/);
  });

  it('rigid template path still works — does not call extractFromContext', async () => {
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-rigid', customerName: 'כהן' });
    getTaskFieldForCorrection.mockResolvedValueOnce({
      taskFieldId: 'tf-rigid', taskId: 'task-1', taskOwnerId: 'u-worker',
      fieldStatus: 'ASSIGNED', currentInspectionTypeId: null, currentLabelHe: null,
    });

    await driveIntent(makeWorker(), {
      intent: 'correct_task_field_site', confidence: 1, task_reference: 'כהן',
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    // Rigid template input
    await sendMessage(makeWorker(), 'כתובת אתר: רוטשילד 10 תל אביב');

    expect(updateSiteMetadata).toHaveBeenCalledWith(
      'tf-rigid', 'u-worker', { siteAddress: 'רוטשילד 10 תל אביב' },
    );
    // extractFromContext should NOT have been called (fast path handled it)
    expect(extractFromContext).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls[0][0].text).toContain('עודכן בהצלחה');
  });

  it('confirms extracted value then applies it after user says "1"', async () => {
    // Pre-seed the confirm_extracted state
    const { handleAIMessage } = await import('../ai/router');
    ctxStore = {
      awaiting: 'correct_site_confirm_extracted',
      taskFieldId: 'tf-own',
      pendingExtractedField: 'siteCity',
      pendingExtractedValue: 'חיפה',
    };
    getTaskFieldForCorrection.mockResolvedValueOnce({
      taskFieldId: 'tf-own', taskId: 'task-1', taskOwnerId: 'u-worker',
      fieldStatus: 'ASSIGNED', currentInspectionTypeId: null, currentLabelHe: null,
    });
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    await handleAIMessage(makeWorker(), '1');

    expect(updateSiteMetadata).toHaveBeenCalledWith('tf-own', 'u-worker', { siteCity: 'חיפה' });
    expect(sendTextMessage.mock.calls[0][0].text).toContain('עודכן בהצלחה');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2-T13: reassign_task
// ─────────────────────────────────────────────────────────────────────────────

describe('D2-T13 — reassign_task', () => {
  it('rejects WORKER with Hebrew auth error', async () => {
    await driveIntent(makeWorker(), {
      intent: 'reassign_task', confidence: 1, task_reference: null,
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: false, requires_manager_approval: true,
      transition: null, problem_type: null,
    });
    expect(sendTextMessage.mock.calls[0][0].text).toContain('אין הרשאה');
    expect(sendTextMessage.mock.calls[0][0].text).toContain('מנהל');
    expect(reassignTask).not.toHaveBeenCalled();
  });

  it('asks for task reference when task_reference is null (MANAGER)', async () => {
    await driveIntent(makeManager(), {
      intent: 'reassign_task', confidence: 1, task_reference: null,
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: false, requires_manager_approval: true,
      transition: null, problem_type: null,
    });
    expect(ctxStore?.awaiting).toBe('reassign_pick_task');
    expect(sendTextMessage.mock.calls[0][0].text).toContain('לאיזו משימה הכוונה');
  });

  it('shows worker list when task resolves to a match', async () => {
    resolveTask.mockResolvedValueOnce({ match: { id: 'task-1', title: 'ביקור לוי' }, ambiguous: false, candidates: [] });
    findUsersByName.mockResolvedValueOnce([
      { id: 'w-1', name: 'דני' },
      { id: 'w-2', name: 'מרים' },
    ]);

    await driveIntent(makeManager(), {
      intent: 'reassign_task', confidence: 1, task_reference: 'ביקור לוי',
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: false, requires_manager_approval: true,
      transition: null, problem_type: null,
    });

    expect(ctxStore?.awaiting).toBe('reassign_pick_worker');
    expect(ctxStore?.candidateTaskIds).toEqual(['task-1']);
    expect(ctxStore?.candidateUserIds).toEqual(['w-1', 'w-2']);
    const text = sendTextMessage.mock.calls[0][0].text;
    expect(text).toContain('למי לשייך');
    expect(text).toContain('דני');
    expect(text).toContain('מרים');
  });

  it('calls reassignTask and acks on valid worker pick', async () => {
    reassignTask.mockResolvedValueOnce({ resetCount: 2, hadInProgressRows: false });

    // Pre-seed context in reassign_pick_worker state.
    ctxStore = {
      awaiting: 'reassign_pick_worker',
      candidateTaskIds: ['task-1'],
      candidateUserIds: ['w-1', 'w-2'],
    };
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    await sendMessage(makeManager(), '1');

    expect(reassignTask).toHaveBeenCalledWith('task-1', 'w-1', 'u-manager');
    expect(ctxStore).toBeNull();
    const text = sendTextMessage.mock.calls[0][0].text;
    expect(text).toContain('שויכה מחדש');
    expect(text).toContain('2');
  });

  it('includes in-progress warning when hadInProgressRows=true', async () => {
    reassignTask.mockResolvedValueOnce({ resetCount: 0, hadInProgressRows: true });
    ctxStore = {
      awaiting: 'reassign_pick_worker',
      candidateTaskIds: ['task-2'],
      candidateUserIds: ['w-1'],
    };
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    await sendMessage(makeManager(), '1');

    const text = sendTextMessage.mock.calls[0][0].text;
    expect(text).toContain('בביצוע');
  });

  it('rejects out-of-range worker pick', async () => {
    ctxStore = {
      awaiting: 'reassign_pick_worker',
      candidateTaskIds: ['task-1'],
      candidateUserIds: ['w-1'],
    };
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    await sendMessage(makeManager(), '99');
    expect(reassignTask).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls[0][0].text).toContain('מספר בין 1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2-T14: correct_inspection_type
// ─────────────────────────────────────────────────────────────────────────────

describe('D2-T14 — correct_inspection_type', () => {
  it('asks for a task reference when task_reference is null', async () => {
    await driveIntent(makeWorker(), {
      intent: 'correct_inspection_type', confidence: 1, task_reference: null,
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: true, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    expect(ctxStore?.awaiting).toBe('correct_type_pick_task');
    expect(sendTextMessage.mock.calls[0][0].text).toContain('לאיזו בדיקה הכוונה');
  });

  it('rejects WORKER trying to correct another worker\'s TaskField', async () => {
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-other', customerName: 'פלוני' });
    getTaskFieldForCorrection.mockResolvedValueOnce({
      taskFieldId: 'tf-other', taskId: 'task-1', taskOwnerId: 'other-worker',
      fieldStatus: 'ASSIGNED', currentInspectionTypeId: null, currentLabelHe: null,
    });

    await driveIntent(makeWorker(), {
      intent: 'correct_inspection_type', confidence: 1, task_reference: 'פלוני',
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: true, requires_manager_approval: false,
      transition: null, problem_type: null,
    });

    expect(correctInspectionType).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls[0][0].text).toContain('אין הרשאה');
  });

  it('rejects closed TaskField (FINISHED_FIELD)', async () => {
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-closed', customerName: 'סגור' });
    getTaskFieldForCorrection.mockResolvedValueOnce({
      taskFieldId: 'tf-closed', taskId: 'task-1', taskOwnerId: 'u-worker',
      fieldStatus: 'FINISHED_FIELD', currentInspectionTypeId: null, currentLabelHe: null,
    });

    await driveIntent(makeWorker(), {
      intent: 'correct_inspection_type', confidence: 1, task_reference: 'סגור',
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: true, requires_manager_approval: false,
      transition: null, problem_type: null,
    });

    expect(correctInspectionType).not.toHaveBeenCalled();
    expect(sendTextMessage.mock.calls[0][0].text).toContain('סגורה');
  });

  it('shows numbered type list when TaskField resolves and worker owns it', async () => {
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-own', customerName: 'לוי' });
    getTaskFieldForCorrection.mockResolvedValueOnce({
      taskFieldId: 'tf-own', taskId: 'task-1', taskOwnerId: 'u-worker',
      fieldStatus: 'ASSIGNED', currentInspectionTypeId: 'type-1', currentLabelHe: 'רעש',
    });
    listInspectionTypes.mockResolvedValueOnce([
      { id: 'type-a', code: '62', labelHe: 'גהות', family: 'occupational' },
      { id: 'type-b', code: '73', labelHe: 'רעש', family: 'noise' },
    ]);

    await driveIntent(makeWorker(), {
      intent: 'correct_inspection_type', confidence: 1, task_reference: 'לוי',
      field: null, new_value: null, params: {}, missing_fields: [],
      clarification: null, requires_confirmation: true, requires_manager_approval: false,
      transition: null, problem_type: null,
    });

    expect(ctxStore?.awaiting).toBe('correct_type_pick_from_list');
    expect(ctxStore?.candidateUserIds).toEqual(['type-a', 'type-b']);
    const text = sendTextMessage.mock.calls[0][0].text;
    expect(text).toContain('62');
    expect(text).toContain('גהות');
  });

  it('moves to confirm state when worker picks a valid number', async () => {
    listInspectionTypes.mockResolvedValue([
      { id: 'type-a', code: '62', labelHe: 'גהות', family: 'occupational' },
    ]);
    ctxStore = {
      awaiting: 'correct_type_pick_from_list',
      taskFieldId: 'tf-own',
      candidateUserIds: ['type-a'],
    };
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    await sendMessage(makeWorker(), '1');

    expect(ctxStore?.awaiting).toBe('correct_type_confirm');
    expect(ctxStore?.candidateUserIds).toEqual(['type-a']);
    // Confirmation is now sent via sendButtonMessage (Group A UX upgrade)
    const btnBody = (sendButtonMessage.mock.calls[0]?.[0] as { body: string } | undefined)?.body;
    const txtBody = sendTextMessage.mock.calls[0]?.[0]?.text;
    const confirmBody = btnBody ?? txtBody ?? '';
    expect(confirmBody).toContain('גהות');
    // Button message contains the type name; fallback text contains 'כן' hint
    // Accept either form.
    const hasYesHint = (btnBody !== undefined) || (txtBody ?? '').includes('כן');
    expect(hasYesHint).toBe(true);
  });

  it('calls correctInspectionType on "כן" and acks with old/new names', async () => {
    correctInspectionType.mockResolvedValueOnce({ oldProductName: '73', newProductName: '62' });
    ctxStore = {
      awaiting: 'correct_type_confirm',
      taskFieldId: 'tf-own',
      candidateUserIds: ['type-a'],
    };
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    await sendMessage(makeWorker(), 'כן');

    expect(correctInspectionType).toHaveBeenCalledWith('tf-own', 'type-a', 'u-worker', 'דני');
    expect(ctxStore).toBeNull();
    const text = sendTextMessage.mock.calls[0][0].text;
    expect(text).toContain('73');
    expect(text).toContain('62');
  });

  it('cancels on "לא" at confirm step', async () => {
    ctxStore = {
      awaiting: 'correct_type_confirm',
      taskFieldId: 'tf-own',
      candidateUserIds: ['type-a'],
    };
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    await sendMessage(makeWorker(), 'לא');

    expect(correctInspectionType).not.toHaveBeenCalled();
    expect(ctxStore).toBeNull();
    expect(sendTextMessage.mock.calls[0][0].text).toBe('בוטל.');
  });

  it('shows "בדיקה כבר סגורה" when correctInspectionType throws ClosedInspectionError', async () => {
    correctInspectionType.mockRejectedValueOnce(new ClosedInspectionError('closed'));
    ctxStore = {
      awaiting: 'correct_type_confirm',
      taskFieldId: 'tf-closed',
      candidateUserIds: ['type-a'],
    };
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    await sendMessage(makeWorker(), 'כן');

    expect(ctxStore).toBeNull();
    expect(sendTextMessage.mock.calls[0][0].text).toContain('סגורה');
  });

  it('filters type list when worker types a search term', async () => {
    listInspectionTypes.mockResolvedValue([
      { id: 'type-a', code: '62', labelHe: 'גהות – בדיקת רעש', family: 'occupational' },
      { id: 'type-b', code: '73', labelHe: 'רעש – סביבתי', family: 'noise' },
    ]);
    ctxStore = {
      awaiting: 'correct_type_pick_from_list',
      taskFieldId: 'tf-own',
      candidateUserIds: ['type-a', 'type-b'],
    };
    sendTextMessage.mockClear(); sendButtonMessage.mockClear();

    await sendMessage(makeWorker(), 'גהות');

    expect(ctxStore?.awaiting).toBe('correct_type_pick_from_list');
    const text = sendTextMessage.mock.calls[0][0].text;
    expect(text).toContain('גהות');
    // Only the matching type should appear.
    expect(text).not.toContain('רעש – סביבתי');
  });
});
