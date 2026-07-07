/**
 * routerActiveInspection.test.ts — Phase 1: active-task context after "יצאתי".
 *
 * Proves that once a worker departs for a specific TaskField, the follow-up
 * "הגעתי" / "סיימתי" attach to THAT SAME TaskField via the stored
 * activeInspection pointer — even when the worker has several open inspections —
 * and that a status search is only a fallback when there is no valid pointer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── sender ────────────────────────────────────────────────────────────────────
const msgLog: string[] = [];
const sendTextMessage = vi.fn(async (arg: { to: string; text: string }) => { msgLog.push(arg.text); });
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: (arg: { to: string; text: string }) => sendTextMessage(arg),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
  sendListMessage: vi.fn().mockResolvedValue(undefined),
}));

// ── intent parser ─────────────────────────────────────────────────────────────
const parseIntentMock = vi.fn();
vi.mock('../ai/intentParser', () => ({ parseIntent: (...a: unknown[]) => parseIntentMock(...a) }));
vi.mock('../ai/provider', () => ({ getProvider: () => ({ name: 'test' }) }));

// ── conversation context — stateful, incl. the active-task pointer ─────────────
let ctxStore: Record<string, unknown> | null = null;
const setContext = vi.fn(async (_p: string, state: unknown) => { ctxStore = state as Record<string, unknown>; });
const getContext = vi.fn(async () => ctxStore);
const clearContext = vi.fn(async () => { ctxStore = null; });
const setActiveInspection = vi.fn(async (
  _p: string, taskFieldId: string, departedAt: string,
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
  setContext: (p: string, s: unknown) => setContext(p, s),
  getContext: (_p: string) => getContext(),
  clearContext: (_p: string) => clearContext(),
  setActiveInspection: (...a: unknown[]) => (setActiveInspection as (...x: unknown[]) => unknown)(...a),
  getActiveInspection: (_p: string) => getActiveInspection(),
  clearActiveInspection: (_p: string) => clearActiveInspection(),
}));

// ── inspections — controllable resolvers ───────────────────────────────────────
const findOpenTaskFieldForWorker = vi.fn();
const findActiveInProgressTaskFieldForWorker = vi.fn();
const validateWorkerTaskField = vi.fn();
const resolveOpenTaskFieldByHint = vi.fn();
const advanceFieldStatus = vi.fn().mockResolvedValue(undefined);
const writeTravelEta = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/inspections', () => ({
  findOpenTaskFieldForWorker: (...a: unknown[]) => findOpenTaskFieldForWorker(...a),
  findActiveInProgressTaskFieldForWorker: (...a: unknown[]) => findActiveInProgressTaskFieldForWorker(...a),
  validateWorkerTaskField: (...a: unknown[]) => validateWorkerTaskField(...a),
  resolveOpenTaskFieldByHint: (...a: unknown[]) => resolveOpenTaskFieldByHint(...a),
  advanceFieldStatus: (...a: unknown[]) => advanceFieldStatus(...a),
  writeTravelEta: (...a: unknown[]) => writeTravelEta(...a),
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

// ── quoted-message context (Phase 2) ───────────────────────────────────────────
const resolveQuotedContext = vi.fn().mockResolvedValue(null);
const recordTaskFieldRef = vi.fn().mockResolvedValue(true);
const recordOutboundRef = vi.fn().mockResolvedValue(true);
vi.mock('../services/messageRefs', () => ({
  resolveQuotedContext: (...a: unknown[]) => resolveQuotedContext(...a),
  recordTaskFieldRef: (...a: unknown[]) => recordTaskFieldRef(...a),
  recordOutboundRef: (...a: unknown[]) => recordOutboundRef(...a),
}));

// ── remaining service stubs the router touches ─────────────────────────────────
vi.mock('../services/chatHistory', () => ({
  appendTurn: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue([]),
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
vi.mock('../services/taskFieldCorrections', () => ({
  updateSiteMetadata: vi.fn().mockResolvedValue(undefined),
  reassignTask: vi.fn().mockResolvedValue({ resetCount: 0, hadInProgressRows: false }),
  correctInspectionType: vi.fn().mockResolvedValue({ oldProductName: 'o', newProductName: 'n' }),
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
  setViewOwners: vi.fn(), getViewOwners: vi.fn().mockReturnValue(null), clearViewOwners: vi.fn(),
}));
vi.mock('../services/taskContext', () => ({
  setActiveTask: vi.fn(), getActiveTask: vi.fn().mockReturnValue(null),
}));
vi.mock('../ai/leadSuggester', () => ({ suggestWorkerForLead: vi.fn().mockResolvedValue({ userId: null, reason: '' }) }));
vi.mock('../utils/auditLog', () => ({ writeAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../ai/taskResolver', () => ({ resolveTask: vi.fn().mockResolvedValue({ match: null, ambiguous: false, candidates: [] }) }));
vi.mock('../whatsapp/digestContent', () => ({
  formatDayFieldSummary: vi.fn().mockReturnValue('סיכום'),
  formatManagerEndOfDay: vi.fn().mockReturnValue({ text: 'eod' }),
  formatEmployeeEndOfDay: vi.fn().mockReturnValue({ text: 'eod' }),
  formatInspectorDayList: vi.fn().mockReturnValue('רשימה'),
}));
vi.mock('../ai/digestCommands', () => ({
  matchDigestCommand: vi.fn().mockReturnValue(null), planDigestCommand: vi.fn(),
  DIGEST_PAYLOAD_IDS: { FREE_TEXT: 'FREE_TEXT', EMP_TODAY: 'EMP_TODAY', EMP_EOD: 'EMP_EOD', TEAM_TODAY: 'TEAM_TODAY', TEAM_EOD: 'TEAM_EOD' },
}));
vi.mock('../db/connection', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('../ai/contextExtractor', () => ({
  extractFromContext: vi.fn().mockResolvedValue({ values: {}, confidence: 0, clarification: null }),
  extractNote: vi.fn().mockResolvedValue(null),
  extractInspectionActions: vi.fn().mockResolvedValue({ actions: [], confidence: 0 }),
}));
vi.mock('../services/inspectionsQueries', () => ({
  getInspectionsForWorkerOnDate: vi.fn().mockResolvedValue([]),
  getFieldSummaryForWorkerOnDate: vi.fn().mockResolvedValue({ items: [], missingInfoCount: 0 }),
}));
vi.mock('../services/myInspectionsRange', () => ({
  getMyInspectionsInRange: vi.fn().mockResolvedValue([]),
  getAllMyInspections: vi.fn().mockResolvedValue([]),
}));

import { handleAIMessage } from '../ai/router';
import type { ResolvedUser } from '../types';

function worker(): ResolvedUser {
  return {
    id: 'u-worker', name: 'דני', phone: '97250000009', role: 'TECHNICIAN',
    isElevated: false, canViewAllRecords: false, canManageUsers: false, canManagePermissions: false,
  };
}

/** parseIntent → set_field_status with the given transition + optional hint. */
function statusIntent(transition: string, task_reference: string | null) {
  parseIntentMock.mockResolvedValueOnce({
    intent: 'set_field_status', confidence: 0.96,
    task_reference, field: null, new_value: null, params: {},
    missing_fields: [], clarification: null,
    requires_confirmation: false, requires_manager_approval: false,
    transition, problem_type: null,
  });
}

beforeEach(() => {
  msgLog.length = 0; ctxStore = null;
  sendTextMessage.mockClear(); setContext.mockClear(); clearContext.mockClear();
  setActiveInspection.mockClear(); getActiveInspection.mockClear();
  parseIntentMock.mockReset();
  findOpenTaskFieldForWorker.mockReset();
  findActiveInProgressTaskFieldForWorker.mockReset().mockResolvedValue(null);
  validateWorkerTaskField.mockReset().mockResolvedValue({ ok: true, taskFieldId: 'tf-B', fieldStatus: 'EN_ROUTE', customerName: 'כהן', taskTitle: null });
  resolveOpenTaskFieldByHint.mockReset().mockResolvedValue(null);
  advanceFieldStatus.mockReset().mockResolvedValue(undefined);
  writeTravelEta.mockReset().mockResolvedValue(undefined);
  resolveQuotedContext.mockReset().mockResolvedValue(null);
  recordTaskFieldRef.mockReset().mockResolvedValue(true);
  recordOutboundRef.mockReset().mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); });

// ── Core proof: chained יצאתי → הגעתי → סיימתי on the SAME TaskField ───────────

describe('active-task context — chained flow with 3 open inspections', () => {
  it('"יצאתי לכהן" stores the pointer; then "הגעתי"/"סיימתי" hit the SAME TaskField (no disambig)', async () => {
    const u = worker();

    // 1. Depart for a specific inspection (hint resolves to tf-B).
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-B', customerName: 'כהן', taskTitle: null });
    statusIntent('DEPARTED', 'כהן');
    await handleAIMessage(u, 'יצאתי לכהן');
    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-B', transition: 'DEPARTED', updatedBy: u.id });
    expect(ctxStore).toMatchObject({ awaiting: 'status_eta_prompt', activeInspection: { taskFieldId: 'tf-B' } });
    expect(msgLog.at(-1)).toContain('נסיעה'); // ETA prompt

    // 2. Provide the (optional) ETA — stored, pointer kept, goes idle.
    await handleAIMessage(u, '20 דקות');
    expect(writeTravelEta).toHaveBeenCalledWith({ taskFieldId: 'tf-B', minutes: 20, updatedBy: u.id });
    expect(ctxStore).toMatchObject({ awaiting: 'idle_active_inspection', activeInspection: { taskFieldId: 'tf-B' } });

    // 3. "הגעתי" (no task named) → pointer drives it to tf-B, NOT a status search.
    advanceFieldStatus.mockClear();
    validateWorkerTaskField.mockResolvedValueOnce({ ok: true, taskFieldId: 'tf-B', fieldStatus: 'EN_ROUTE', customerName: 'כהן', taskTitle: null });
    statusIntent('ARRIVED', null);
    await handleAIMessage(u, 'הגעתי');
    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-B', transition: 'ARRIVED', updatedBy: u.id });
    expect(findOpenTaskFieldForWorker).not.toHaveBeenCalled();
    expect(findActiveInProgressTaskFieldForWorker).not.toHaveBeenCalled();

    // 4. "סיימתי" → same pointer → FINISHED on tf-B.
    advanceFieldStatus.mockClear();
    validateWorkerTaskField.mockResolvedValueOnce({ ok: true, taskFieldId: 'tf-B', fieldStatus: 'ARRIVED', customerName: 'כהן', taskTitle: null });
    statusIntent('FINISHED', null);
    await handleAIMessage(u, 'סיימתי');
    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-B', transition: 'FINISHED', updatedBy: u.id });
    expect(findOpenTaskFieldForWorker).not.toHaveBeenCalled();
  });

  it('ETA is NOT a condition — no ETA reply, later "הגעתי" still resolves to the pointer', async () => {
    const u = worker();
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-B', customerName: 'כהן', taskTitle: null });
    statusIntent('DEPARTED', 'כהן');
    await handleAIMessage(u, 'יצאתי לכהן');

    // Worker replies gibberish to the ETA prompt → not trapped, pointer kept (idle).
    parseIntentMock.mockResolvedValueOnce({
      intent: 'unknown', confidence: 0.2, task_reference: null, field: null, new_value: null,
      params: {}, missing_fields: [], clarification: 'לא הבנתי', requires_confirmation: false,
      requires_manager_approval: false, transition: null, problem_type: null,
    });
    await handleAIMessage(u, 'בלה בלה בלה');
    expect(ctxStore).toMatchObject({ awaiting: 'idle_active_inspection', activeInspection: { taskFieldId: 'tf-B' } });

    advanceFieldStatus.mockClear();
    validateWorkerTaskField.mockResolvedValueOnce({ ok: true, taskFieldId: 'tf-B', fieldStatus: 'EN_ROUTE', customerName: 'כהן', taskTitle: null });
    statusIntent('ARRIVED', null);
    await handleAIMessage(u, 'הגעתי');
    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-B', transition: 'ARRIVED', updatedBy: u.id });
  });

  it('"הגעתי" typed during the ETA prompt advances the pointer (ETA skipped)', async () => {
    const u = worker();
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-B', customerName: 'כהן', taskTitle: null });
    statusIntent('DEPARTED', 'כהן');
    await handleAIMessage(u, 'יצאתי לכהן');

    advanceFieldStatus.mockClear();
    await handleAIMessage(u, 'הגעתי'); // status_eta_prompt handler catches the keyword
    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-B', transition: 'ARRIVED', updatedBy: u.id });
    expect(writeTravelEta).not.toHaveBeenCalled();
  });
});

// ── QA-FIX-5: no-quote deterministic keyword-with-pointer fast path ─────────
// Live bug: worker taps "יוצא בזמן" on a pre-reminder → active pointer set on
// tf-B → ETA logged → worker types bare "הגעתי" → AI parser sometimes returns
// unknown/low-confidence (history noise) → bot showed "לא ברור מה הכוונה"
// instead of advancing the pointer. This new fast path fires BEFORE the AI so
// the bot never depends on the LLM correctly classifying an unambiguous verb.
describe('QA-FIX-5: no-quote keyword + active pointer bypasses the AI parser', () => {
  it('bare "הגעתי" with pointer on tf-B → advances tf-B without calling parseIntent', async () => {
    const u = worker();
    // Seed the pointer directly, as if a prior "יצאתי" already ran.
    ctxStore = {
      awaiting: 'idle_active_inspection',
      taskFieldId: 'tf-B',
      activeInspection: {
        taskFieldId: 'tf-B',
        departedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
        etaMinutes: 45,
      },
    };
    // Simulate the real bug: the AI parser would have returned unknown here.
    parseIntentMock.mockResolvedValue({
      intent: 'unknown', confidence: 0.2, task_reference: null, field: null,
      new_value: null, params: {}, missing_fields: [], clarification: 'לא ברור',
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });

    await handleAIMessage(u, 'הגעתי');

    // The fast path fired BEFORE the AI.
    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: 'tf-B', transition: 'ARRIVED', updatedBy: u.id,
    });
    expect(parseIntentMock).not.toHaveBeenCalled();
  });

  it('bare "סיימתי" with pointer on tf-B → FINISHED on tf-B, no AI call', async () => {
    const u = worker();
    ctxStore = {
      awaiting: 'idle_active_inspection',
      taskFieldId: 'tf-B',
      activeInspection: {
        taskFieldId: 'tf-B',
        departedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
      },
    };
    validateWorkerTaskField.mockResolvedValueOnce({
      ok: true, taskFieldId: 'tf-B', fieldStatus: 'ARRIVED',
      customerName: null, taskTitle: null,
    });

    await handleAIMessage(u, 'סיימתי');

    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: 'tf-B', transition: 'FINISHED', updatedBy: u.id,
    });
    expect(parseIntentMock).not.toHaveBeenCalled();
  });

  it('no pointer + "הגעתי" → falls through to the AI path (no keyword fast path)', async () => {
    const u = worker(); // ctxStore stays null → no pointer
    findActiveInProgressTaskFieldForWorker.mockResolvedValueOnce({
      taskFieldId: 'tf-C', customerName: 'לוי', taskTitle: null,
    });
    statusIntent('ARRIVED', null);
    await handleAIMessage(u, 'הגעתי');
    // AI parser WAS invoked (no active pointer → no fast path).
    expect(parseIntentMock).toHaveBeenCalledOnce();
    // The runAdvanceStatusDirect fallback still resolves via the in-progress lookup.
    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: 'tf-C', transition: 'ARRIVED', updatedBy: u.id,
    });
  });

  it('pointer present but validateWorkerTaskField fails → falls through, no write on the pointer', async () => {
    const u = worker();
    ctxStore = {
      awaiting: 'idle_active_inspection',
      taskFieldId: 'tf-closed',
      activeInspection: {
        taskFieldId: 'tf-closed',
        departedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
      },
    };
    // Pointer's TaskField is no longer usable (closed / not owner). Persistent
    // so both the fast path AND runAdvanceStatusDirect's fallback see it closed.
    validateWorkerTaskField.mockResolvedValue({ ok: false, reason: 'not_open' });
    // AI path picks up and finds a different in-progress TF (or asks — here we
    // just verify the pointer's TF was NOT advanced, i.e. the fast path aborted).
    statusIntent('ARRIVED', null);
    findActiveInProgressTaskFieldForWorker.mockResolvedValueOnce(null);
    findOpenTaskFieldForWorker.mockResolvedValueOnce(null);

    await handleAIMessage(u, 'הגעתי');

    // The pointer's TF was NOT written (validate failed).
    expect(advanceFieldStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ taskFieldId: 'tf-closed' }),
    );
  });

  it('quote wins over pointer + keyword (existing Phase-2 priority preserved)', async () => {
    const u = worker();
    ctxStore = {
      awaiting: 'idle_active_inspection',
      taskFieldId: 'tf-A',
      activeInspection: {
        taskFieldId: 'tf-A',
        departedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
      },
    };
    // The quoted context resolves to a DIFFERENT TF (tf-B).
    resolveQuotedContext.mockResolvedValueOnce({
      wamid: 'w-B', recipientUserId: u.id, entityType: 'task_field',
      entityId: 'tf-B', taskFieldId: 'tf-B', kind: 'assignment_card',
      payload: null, createdAt: new Date(), expiresAt: null,
    });
    validateWorkerTaskField.mockResolvedValueOnce({
      ok: true, taskFieldId: 'tf-B', fieldStatus: 'EN_ROUTE',
      customerName: null, taskTitle: null,
    });

    await handleAIMessage(u, 'הגעתי', 'w-B');

    // Quote wins — tf-B advances, not the pointer's tf-A.
    expect(advanceFieldStatus).toHaveBeenCalledWith({
      taskFieldId: 'tf-B', transition: 'ARRIVED', updatedBy: u.id,
    });
    expect(advanceFieldStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ taskFieldId: 'tf-A' }),
    );
  });
});

// ── Fallback (only when there is no valid pointer) ─────────────────────────────

describe('active-task context — status fallback when no valid pointer', () => {
  it('no pointer + exactly one in-progress → uses it', async () => {
    const u = worker(); // ctxStore stays null → no pointer
    findActiveInProgressTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-C', customerName: 'לוי', taskTitle: null });
    statusIntent('ARRIVED', null);
    await handleAIMessage(u, 'הגעתי');
    expect(getActiveInspection).toHaveBeenCalled();
    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-C', transition: 'ARRIVED', updatedBy: u.id });
  });

  it('no pointer + several in-progress → asks (status_disambig), no write', async () => {
    const u = worker();
    findActiveInProgressTaskFieldForWorker.mockResolvedValueOnce({
      ambiguous: true, count: 2,
      items: [
        { taskFieldId: 'tf-1', customerName: 'א', siteAddress: null, siteCity: null, scheduledStartAt: null },
        { taskFieldId: 'tf-2', customerName: 'ב', siteAddress: null, siteCity: null, scheduledStartAt: null },
      ],
    });
    statusIntent('ARRIVED', null);
    await handleAIMessage(u, 'הגעתי');
    expect(advanceFieldStatus).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({ awaiting: 'status_disambig', pendingTransition: 'ARRIVED' });
  });

  it('pointer present but no longer valid (closed) → falls back to in-progress search', async () => {
    const u = worker();
    // Seed a pointer, but validation says it is closed.
    await setActiveInspection('x', 'tf-B', new Date().toISOString(), { awaiting: 'idle_active_inspection' });
    setActiveInspection.mockClear();
    // Persistent (not `once`) — the QA-FIX-5 keyword fast path AND the
    // runAdvanceStatusDirect fallback both validate the pointer, so BOTH calls
    // must see the closed status.
    validateWorkerTaskField.mockResolvedValue({ ok: false, reason: 'closed', fieldStatus: 'FINISHED_FIELD' });
    findActiveInProgressTaskFieldForWorker.mockResolvedValueOnce({ taskFieldId: 'tf-C', customerName: 'לוי', taskTitle: null });
    statusIntent('ARRIVED', null);
    await handleAIMessage(u, 'הגעתי');
    expect(validateWorkerTaskField).toHaveBeenCalledWith(u.id, 'tf-B');
    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-C', transition: 'ARRIVED', updatedBy: u.id });
  });
});

// ── Phase 2: quoted-message reply ─────────────────────────────────────────────

/** Seed an active pointer on task A (idle) so we can prove a quote beats it. */
function seedPointerA(): void {
  ctxStore = {
    awaiting: 'idle_active_inspection',
    taskFieldId: 'tf-A',
    activeInspection: {
      taskFieldId: 'tf-A',
      departedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  };
}

const QUOTED_TF_B = {
  wamid: 'wamid-B', recipientUserId: 'u-worker', entityType: 'task_field',
  entityId: 'tf-B', taskFieldId: 'tf-B', kind: 'pre_reminder', payload: null,
  createdAt: new Date(), expiresAt: null,
};

describe('quoted-message reply — TaskField status', () => {
  it('reply "הגעתי" to task B\'s card BEATS the pointer on A, deterministically (no AI)', async () => {
    const u = worker();
    seedPointerA();
    resolveQuotedContext.mockResolvedValueOnce(QUOTED_TF_B);
    validateWorkerTaskField.mockResolvedValueOnce({ ok: true, taskFieldId: 'tf-B', fieldStatus: 'ASSIGNED', customerName: null, taskTitle: null });

    await handleAIMessage(u, 'הגעתי', 'wamid-B');

    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-B', transition: 'ARRIVED', updatedBy: u.id });
    expect(parseIntentMock).not.toHaveBeenCalled(); // fast path — no LLM
  });

  it('verbose reply (no bare keyword) resolves via the LLM path — still task B', async () => {
    const u = worker();
    seedPointerA();
    resolveQuotedContext.mockResolvedValueOnce(QUOTED_TF_B);
    // First validate call (LLM path priority#1) → ok for tf-B.
    validateWorkerTaskField.mockResolvedValueOnce({ ok: true, taskFieldId: 'tf-B', fieldStatus: 'ASSIGNED', customerName: null, taskTitle: null });
    statusIntent('ARRIVED', null);

    await handleAIMessage(u, 'אני כבר אצל הלקוח', 'wamid-B');

    expect(parseIntentMock).toHaveBeenCalled();
    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-B', transition: 'ARRIVED', updatedBy: u.id });
  });

  it('unknown quote → falls through to the pointer (A)', async () => {
    const u = worker();
    seedPointerA();
    resolveQuotedContext.mockResolvedValueOnce(null); // not in the ref table
    statusIntent('ARRIVED', null);

    await handleAIMessage(u, 'הגעתי', 'wamid-unknown');

    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-A', transition: 'ARRIVED', updatedBy: u.id });
  });

  it('quoted TaskField closed / not the worker\'s → falls back to the pointer', async () => {
    const u = worker();
    seedPointerA();
    resolveQuotedContext.mockResolvedValue(QUOTED_TF_B);
    // tf-B is closed; tf-A (the pointer) is fine.
    validateWorkerTaskField.mockImplementation(async (_uid: string, tfid: string) =>
      tfid === 'tf-B'
        ? { ok: false, reason: 'closed', fieldStatus: 'FINISHED_FIELD' }
        : { ok: true, taskFieldId: tfid, fieldStatus: 'EN_ROUTE', customerName: null, taskTitle: null });
    statusIntent('ARRIVED', null);

    await handleAIMessage(u, 'הגעתי', 'wamid-B');

    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-A', transition: 'ARRIVED', updatedBy: u.id });
  });

  it('reply to a NON-TaskField message (equipment reminder) → context handed to the AI, no status write', async () => {
    const u = worker();
    resolveQuotedContext.mockResolvedValueOnce({
      wamid: 'wamid-eq', recipientUserId: 'u-worker', entityType: 'equipment_reminder',
      entityId: '2026-07-08', taskFieldId: null, kind: 'equipment_reminder',
      payload: { workerId: 'u-worker', localDate: '2026-07-08' }, createdAt: new Date(), expiresAt: null,
    });
    parseIntentMock.mockResolvedValueOnce({
      intent: 'missing_equipment_free', confidence: 0.95, task_reference: null, field: null,
      new_value: null, params: { note: 'מד רעש' }, missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false, transition: null, problem_type: null,
    });

    await handleAIMessage(u, 'חסר לי מד רעש', 'wamid-eq');

    // The quoted context reached the AI parse…
    const opts = parseIntentMock.mock.calls[0]?.[1] as { quotedContext?: { entityType?: string } };
    expect(opts?.quotedContext?.entityType).toBe('equipment_reminder');
    // …and it did NOT trigger a TaskField status write.
    expect(advanceFieldStatus).not.toHaveBeenCalled();
  });
});

// ── QA-FIX-1: quoted context must survive the status_eta_prompt live await ─────
//
// Bug: while the worker is answering the travel-ETA prompt (awaiting
// 'status_eta_prompt', pointer on tf-A), a swipe-reply to a DIFFERENT
// TaskField's card (tf-B) with VERBOSE text (no bare status keyword) lost the
// quote during the recursion in `handleStatusEtaReply` case 3, so the update
// landed on the pointer (tf-A) instead of the quoted card (tf-B).

/** Seed the ETA-prompt live await with the active pointer on task A. */
function seedEtaPromptA(): void {
  ctxStore = {
    awaiting: 'status_eta_prompt',
    taskFieldId: 'tf-A',
    activeInspection: {
      taskFieldId: 'tf-A',
      departedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  };
}

describe('quoted-message reply during the status_eta_prompt await (QA-FIX-1)', () => {
  it('REGRESSION: verbose quoted reply to tf-B updates tf-B, NOT the pointer tf-A', async () => {
    const u = worker();
    seedEtaPromptA();
    // Quote resolves on BOTH the initial pass and the post-recursion pass.
    resolveQuotedContext.mockResolvedValue(QUOTED_TF_B);
    validateWorkerTaskField.mockResolvedValue({ ok: true, taskFieldId: 'tf-B', fieldStatus: 'EN_ROUTE', customerName: null, taskTitle: null });
    statusIntent('ARRIVED', null); // LLM classifies the verbose text, no task_reference

    await handleAIMessage(u, 'אני כבר אצל הלקוח', 'wamid-B');

    // The quoted TaskField (B) wins over the ETA pointer (A).
    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-B', transition: 'ARRIVED', updatedBy: u.id });
    expect(advanceFieldStatus).not.toHaveBeenCalledWith(expect.objectContaining({ taskFieldId: 'tf-A' }));
  });

  it('quoted reply with a bare keyword hits tf-B via the fast path (no LLM), pointer on A ignored', async () => {
    const u = worker();
    seedEtaPromptA();
    resolveQuotedContext.mockResolvedValueOnce(QUOTED_TF_B);
    validateWorkerTaskField.mockResolvedValueOnce({ ok: true, taskFieldId: 'tf-B', fieldStatus: 'EN_ROUTE', customerName: null, taskTitle: null });

    await handleAIMessage(u, 'הגעתי', 'wamid-B');

    // Deterministic fast path runs before the context dispatch → tf-B, no parse.
    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-B', transition: 'ARRIVED', updatedBy: u.id });
    expect(parseIntentMock).not.toHaveBeenCalled();
  });

  it('no quote + unclear ETA reply keeps the pointer on tf-A (no stray tf-B write)', async () => {
    const u = worker();
    seedEtaPromptA();
    // Neither a status keyword nor a parseable ETA → not trapped, pointer kept, idle.
    parseIntentMock.mockResolvedValueOnce({
      intent: 'unknown', confidence: 0.2, task_reference: null, field: null, new_value: null,
      params: {}, missing_fields: [], clarification: 'לא הבנתי', requires_confirmation: false,
      requires_manager_approval: false, transition: null, problem_type: null,
    });

    await handleAIMessage(u, 'בלה בלה בלה');

    expect(ctxStore).toMatchObject({ awaiting: 'idle_active_inspection', activeInspection: { taskFieldId: 'tf-A' } });
    expect(advanceFieldStatus).not.toHaveBeenCalled();

    // A follow-up bare keyword (still no quote) resolves to the KEPT pointer tf-A.
    validateWorkerTaskField.mockResolvedValueOnce({ ok: true, taskFieldId: 'tf-A', fieldStatus: 'EN_ROUTE', customerName: null, taskTitle: null });
    statusIntent('ARRIVED', null);
    await handleAIMessage(u, 'הגעתי');
    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-A', transition: 'ARRIVED', updatedBy: u.id });
  });
});
