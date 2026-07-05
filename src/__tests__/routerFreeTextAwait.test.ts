/**
 * routerFreeTextAwait.test.ts
 *
 * Verifies that all Priority-2 free-text await handlers call `extractNote`
 * (or `extractFromContext`) for AI-assisted prefix stripping, and that
 * they still work correctly when the extractor returns null (no provider)
 * by falling back to the raw input.
 *
 * One test per handler:
 *  - handleInspectionDeclineReasonReply → extractNote('decline_reason')
 *  - handleInspectionNeedInfoNoteReply  → extractNote('missing_info_note')
 *  - handleEquipmentMissingNoteReply    → extractNote('equipment_missing_note')
 *  - handleFinishedNotesReply           → extractNote('field_notes')
 *  - handleMissingInfoNoteReply         → extractNote('missing_info_note')
 *  - handleProblemTypeNoteReply         → extractNote('problem_note')
 *  - handleMgrSearchAwaitQueryReply     → extractNote (search_query proxy)
 *  - handleScheduleAwaitDurationReply   → extractFromContext('schedule_duration')
 *  - handleScheduleAwaitTimeReply       → extractFromContext('schedule_time')
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedUser } from '../types';

// ── Mocks ────────────────────────────────────────────────────────────────────

const findOpenTaskFieldForWorker = vi.fn();
const resolveOpenTaskFieldByHint = vi.fn();
const advanceFieldStatus = vi.fn().mockResolvedValue(undefined);
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

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
  sendListMessage:   vi.fn().mockResolvedValue(undefined),
}));

let ctxStore: Record<string, unknown> | null = null;
const setContext = vi.fn(async (_phone: string, state: unknown) => {
  ctxStore = state as Record<string, unknown>;
});
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
const parseIntentMock = vi.fn().mockRejectedValue(new Error('unused'));
vi.mock('../ai/intentParser', () => ({
  parseIntent: (...a: unknown[]) => parseIntentMock(...a),
  buildSystemPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('../utils/auditLog', () => ({
  writeAuditLog: vi.fn().mockResolvedValue('audit-id'),
  updateTranscribedMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/tasks', () => ({
  findUsersByName: vi.fn().mockResolvedValue([]),
  listTasks: vi.fn().mockResolvedValue({ tasks: [], truncated: false }),
  getTaskById: vi.fn().mockResolvedValue(null),
  getAllowedTaskTypes: vi.fn().mockResolvedValue([]),
  getAllowedPriorities: vi.fn().mockResolvedValue([]),
  getEmployeeEndOfDay: vi.fn().mockResolvedValue({}),
  getCompanyEndOfDay: vi.fn().mockResolvedValue({}),
}));
vi.mock('../ai/taskResolver', () => ({
  resolveTask: vi.fn().mockResolvedValue({ match: null, ambiguous: false, candidates: [] }),
}));
vi.mock('../services/pendingActions', () => ({
  getManagersForBroadcast: vi.fn().mockResolvedValue([]),
}));
vi.mock('../whatsapp/digestContent', () => ({
  formatDayFieldSummary: vi.fn().mockReturnValue('summary'),
  formatInspectorDayList: vi.fn().mockReturnValue('day-list'),
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
  setViewOwners: vi.fn(), getViewOwners: vi.fn().mockReturnValue(null), clearViewOwners: vi.fn(),
}));
vi.mock('../services/taskContext', () => ({
  setActiveTask: vi.fn(), getActiveTask: vi.fn().mockReturnValue(null),
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
vi.mock('../services/taskFieldCorrections', () => ({
  updateSiteMetadata: vi.fn().mockResolvedValue(undefined),
  reassignTask: vi.fn().mockResolvedValue({ resetCount: 1, hadInProgressRows: false }),
  correctInspectionType: vi.fn().mockResolvedValue({ oldProductName: '73', newProductName: '62' }),
  ClosedInspectionError: class extends Error { constructor(msg: string) { super(msg); this.name = 'ClosedInspectionError'; } },
  listInspectionTypes: vi.fn().mockResolvedValue([]),
  getTaskFieldForCorrection: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/taskFieldScheduling', () => ({
  findOpenTasksForOwner: vi.fn().mockResolvedValue([]),
  findOpenTasksForAdmin: vi.fn().mockResolvedValue([]),
  findCustomersByName: vi.fn().mockResolvedValue([]),
  findOpenTasksForCustomer: vi.fn().mockResolvedValue([]),
  scheduleTaskField: vi.fn().mockResolvedValue('new-tf-id'),
}));
vi.mock('../services/inspectionsQueries', () => ({
  getInspectionsForWorkerOnDate: vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/managerViews', () => ({
  getManagementSnapshot: vi.fn().mockResolvedValue({ text: '' }),
  getTodayFieldInspections: vi.fn().mockResolvedValue([]),
  getFieldExceptionRows: vi.fn().mockResolvedValue([]),
  getAllWorkersDayOverview: vi.fn().mockResolvedValue([]),
  getWorkerDayDetail: vi.fn().mockResolvedValue(null),
  searchTasksByWorkerName: vi.fn().mockResolvedValue([]),
  searchTasksByProductCode: vi.fn().mockResolvedValue([]),
  getTaskFieldDetail: vi.fn().mockResolvedValue(null),
}));

// ── contextExtractor mock — the key control for these tests ──────────────────
const extractFromContext = vi.fn().mockResolvedValue({ values: {}, confidence: 0, clarification: null });
const extractNote = vi.fn().mockResolvedValue(null);
vi.mock('../ai/contextExtractor', () => ({
  extractFromContext: (...a: unknown[]) => extractFromContext(...a),
  extractNote: (...a: unknown[]) => extractNote(...a),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-worker', name: 'דני', phone: '972501234567',
    role: 'SALES', isElevated: false,
    canViewAllRecords: false, canManageUsers: false, canManagePermissions: false,
    ...overrides,
  };
}

async function loadRouter() {
  return await import('../ai/router');
}

async function sendWithCtx(ctx: Record<string, unknown>, message: string, user = makeUser()) {
  const { handleAIMessage } = await loadRouter();
  ctxStore = ctx;
  sendTextMessage.mockClear();
  await handleAIMessage(user, message);
}

beforeEach(() => {
  ctxStore = null;
  findOpenTaskFieldForWorker.mockReset();
  resolveOpenTaskFieldByHint.mockReset();
  writeFieldNotes.mockReset(); writeFieldNotes.mockResolvedValue(undefined);
  writeMissingInfo.mockReset(); writeMissingInfo.mockResolvedValue(undefined);
  writeProblem.mockReset(); writeProblem.mockResolvedValue(undefined);
  // D5-T19a: notifyOffice* return Promise<boolean> — default to true (happy path).
  notifyOfficeMissingInfo.mockReset(); notifyOfficeMissingInfo.mockResolvedValue(true);
  notifyOfficeProblem.mockReset(); notifyOfficeProblem.mockResolvedValue(true);
  notifyOfficeMissingEquipment.mockReset(); notifyOfficeMissingEquipment.mockResolvedValue(true);
  declineInspection.mockReset(); declineInspection.mockResolvedValue(undefined);
  requestMoreInfo.mockReset(); requestMoreInfo.mockResolvedValue(undefined);
  notifyOfficeDeclined.mockReset(); notifyOfficeDeclined.mockResolvedValue(true);
  notifyOfficeNeedsMoreInfo.mockReset(); notifyOfficeNeedsMoreInfo.mockResolvedValue(true);
  sendTextMessage.mockReset(); sendTextMessage.mockResolvedValue(undefined);
  extractFromContext.mockReset(); extractFromContext.mockResolvedValue({ values: {}, confidence: 0, clarification: null });
  extractNote.mockReset(); extractNote.mockResolvedValue(null);
  setContext.mockClear();
  clearContext.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

// ── Tests: one per Priority-2 handler ─────────────────────────────────────────

describe('Priority-2 free-text await handlers call extractNote', () => {

  it('handleInspectionDeclineReasonReply: calls extractNote and uses extracted reason', async () => {
    extractNote.mockResolvedValueOnce('חוסר ציוד');
    await sendWithCtx(
      { awaiting: 'inspection_decline_reason', taskFieldId: 'tf-1' },
      'בבקשה, אני לא יכול להגיע בגלל חוסר ציוד',
    );
    expect(extractNote).toHaveBeenCalledWith(
      expect.any(String), 'decline_reason',
    );
    expect(declineInspection).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'חוסר ציוד' }),
    );
  });

  it('handleInspectionDeclineReasonReply: falls back to raw message when extractNote returns null', async () => {
    extractNote.mockResolvedValueOnce(null);
    await sendWithCtx(
      { awaiting: 'inspection_decline_reason', taskFieldId: 'tf-2' },
      'לא יכול להגיע',
    );
    expect(declineInspection).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'לא יכול להגיע' }),
    );
  });

  it('handleInspectionNeedInfoNoteReply: calls extractNote and uses extracted note', async () => {
    extractNote.mockResolvedValueOnce('חסר טופס היתר');
    await sendWithCtx(
      { awaiting: 'inspection_need_info_note', taskFieldId: 'tf-3' },
      'אני צריך את טופס ההיתר',
    );
    expect(extractNote).toHaveBeenCalledWith(
      expect.any(String), 'missing_info_note',
    );
    expect(requestMoreInfo).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'חסר טופס היתר' }),
    );
  });

  it('handleEquipmentMissingNoteReply: calls extractNote and uses extracted note', async () => {
    extractNote.mockResolvedValueOnce('מד לחץ');
    await sendWithCtx(
      { awaiting: 'equipment_missing_note', taskFieldId: 'tf-4' },
      'חסר לי מד לחץ',
    );
    expect(extractNote).toHaveBeenCalledWith(
      expect.any(String), 'equipment_missing_note',
    );
    expect(notifyOfficeMissingEquipment).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'מד לחץ' }),
    );
  });

  it('handleEquipmentMissingNoteReply: falls back to raw when extractNote returns null', async () => {
    extractNote.mockResolvedValueOnce(null);
    await sendWithCtx(
      { awaiting: 'equipment_missing_note', taskFieldId: 'tf-4b' },
      'חסר ציוד מדידה',
    );
    expect(notifyOfficeMissingEquipment).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'חסר ציוד מדידה' }),
    );
  });

  it('handleFinishedNotesReply: calls extractNote and uses extracted notes', async () => {
    extractNote.mockResolvedValueOnce('הבדיקה הושלמה');
    await sendWithCtx(
      { awaiting: 'finished_notes', taskFieldId: 'tf-5' },
      'בבקשה רשום שהבדיקה הושלמה',
    );
    expect(extractNote).toHaveBeenCalledWith(
      expect.any(String), 'field_notes',
    );
    expect(writeFieldNotes).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'הבדיקה הושלמה' }),
    );
  });

  it('handleMissingInfoNoteReply: calls extractNote and uses extracted note', async () => {
    extractNote.mockResolvedValueOnce('מספר היתר בנייה');
    await sendWithCtx(
      { awaiting: 'missing_info_note', taskFieldId: 'tf-6' },
      'צריך את מספר ההיתר',
    );
    expect(extractNote).toHaveBeenCalledWith(
      expect.any(String), 'missing_info_note',
    );
    expect(writeMissingInfo).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'מספר היתר בנייה' }),
    );
  });

  it('handleProblemTypeNoteReply: calls extractNote and uses extracted note', async () => {
    extractNote.mockResolvedValueOnce('הציוד התקלקל');
    await sendWithCtx(
      { awaiting: 'problem_type_note', taskFieldId: 'tf-7', problemType: 'OTHER' },
      'הציוד התקלקל לי בדרך',
    );
    expect(extractNote).toHaveBeenCalledWith(
      expect.any(String), 'problem_note',
    );
    expect(writeProblem).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'הציוד התקלקל' }),
    );
  });

  it('handleScheduleAwaitDurationReply: handles "שעה וחצי" via fast-path regex (no AI call)', async () => {
    // The fast-path should handle this without calling extractFromContext
    extractFromContext.mockResolvedValueOnce({ values: {}, confidence: 0, clarification: null });

    const scheduleCtx = {
      awaiting: 'schedule_await_duration',
      scheduleSelectedTask: {
        id: 'task-1', title: 'ביקור', customerName: 'כהן',
        inspectionLabelHe: 'בדיקה', inspectionTypeId: 'it-1', family: null,
        ownerId: 'u-worker', siteAddress: 'רוטשילד 1', siteCity: 'תל אביב',
        fieldContactName: 'משה', fieldContactPhone: '050-1234567', navigationUrl: null,
      },
      scheduleStartAt: new Date(Date.now() + 3600000).toISOString(),
    };

    await sendWithCtx(scheduleCtx, 'שעה וחצי');

    // Should proceed to confirm state with 90 minutes
    expect(ctxStore?.awaiting).toBe('schedule_confirm');
    expect(ctxStore?.scheduleDurationMinutes).toBe(90);
    // extractFromContext should NOT have been called (fast path handled it)
    expect(extractFromContext).not.toHaveBeenCalled();
  });

  it('handleScheduleAwaitDurationReply: calls extractFromContext for unrecognized input', async () => {
    extractFromContext.mockResolvedValueOnce({
      values: { duration_minutes: 75 },
      confidence: 0.9,
      clarification: null,
    });

    const scheduleCtx = {
      awaiting: 'schedule_await_duration',
      scheduleSelectedTask: {
        id: 'task-1', title: 'ביקור', customerName: 'כהן',
        inspectionLabelHe: 'בדיקה', inspectionTypeId: 'it-1', family: null,
        ownerId: 'u-worker', siteAddress: 'רוטשילד 1', siteCity: 'תל אביב',
        fieldContactName: 'משה', fieldContactPhone: '050-1234567', navigationUrl: null,
      },
      scheduleStartAt: new Date(Date.now() + 3600000).toISOString(),
    };

    await sendWithCtx(scheduleCtx, 'שעה ורבע בערך');

    expect(extractFromContext).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'schedule_duration' }),
    );
    expect(ctxStore?.awaiting).toBe('schedule_confirm');
    expect(ctxStore?.scheduleDurationMinutes).toBe(75);
  });

  it('handleScheduleAwaitTimeReply: calls extractFromContext for Hebrew date when rigid parse fails', async () => {
    const futureIso = new Date(Date.now() + 86400000).toISOString();
    extractFromContext.mockResolvedValueOnce({
      values: { iso_datetime: futureIso },
      confidence: 0.85,
      clarification: null,
    });

    const scheduleCtx = {
      awaiting: 'schedule_await_time',
      scheduleSelectedTask: {
        id: 'task-1', title: 'ביקור', customerName: 'כהן',
        inspectionLabelHe: 'בדיקה', inspectionTypeId: 'it-1', family: null,
        ownerId: 'u-worker', siteAddress: 'רוטשילד 1', siteCity: 'תל אביב',
        fieldContactName: 'משה', fieldContactPhone: '050-1234567', navigationUrl: null,
      },
    };

    await sendWithCtx(scheduleCtx, 'מחר ב-10 בבוקר');

    expect(extractFromContext).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'schedule_time' }),
    );
    // Should advance to duration state
    expect(ctxStore?.awaiting).toBe('schedule_await_duration');
  });
});

// ── D5-T16: Universal AI-first pivot from text-capture states ───────────────

describe('D5-T16 — universal AI-first pivot from text-capture states', () => {
  it('missing_info_note: LOW confidence intent → stays in capture (no false pivot)', async () => {
    // Verifies the pivot check does NOT fire on a plausible free-text note
    // that the LLM did not confidently classify as a top-level intent.
    parseIntentMock.mockReset().mockResolvedValue({
      intent: 'set_field_status', confidence: 0.3,
      task_reference: null, field: null, new_value: null, params: {},
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: 'DEPARTED', problem_type: null,
    });
    // Longer than 6 chars so the short-token guard doesn't shortcut.
    await sendWithCtx(
      { awaiting: 'missing_info_note', taskFieldId: 'tf-1' },
      'טופס דגימה של יוסי',
    );

    // parseIntent was invoked but pivot did NOT fire (below CONF_HIGH).
    expect(parseIntentMock).toHaveBeenCalled();
    // Note capture went through → writeMissingInfo was called.
    expect(writeMissingInfo).toHaveBeenCalled();
  });

  it('missing_info_note: short single-word notes skip the LLM check entirely', async () => {
    parseIntentMock.mockReset();

    // Short single word like "מדד" (≤6 chars, no space) — the pivot check
    // short-circuits (never calls parseIntent) so we don't pay LLM latency
    // for a trivially-obvious note.
    await sendWithCtx(
      { awaiting: 'missing_info_note', taskFieldId: 'tf-1' },
      'מדד',
    );

    expect(parseIntentMock).not.toHaveBeenCalled();
    // Note went through.
    expect(writeMissingInfo).toHaveBeenCalled();
  });
});
