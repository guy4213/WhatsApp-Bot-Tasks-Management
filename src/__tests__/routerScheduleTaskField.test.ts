/**
 * D2-T11 — router-level flow tests for the "schedule TaskField" feature.
 *
 * Covers:
 *  - Triggering `schedule_task_field` intent → shows task list → enters schedule_intake_pick_task
 *  - WORKER auth rejection for a task owned by another user
 *  - Happy path (WORKER): pick → time → duration → confirm → INSERT
 *  - Happy path (MANAGER): sees all tasks (admin query path)
 *  - Cancellation at each state
 *  - Task with missing inspectionTypeId rejected at pick step
 *  - Customer search fallback path (חיפוש → customer list → task list → confirm)
 *  - No tasks available short-circuit
 *  - Invalid number re-prompts without clearing state
 *  - prefilled scheduledStartAt skips the time-ask step
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (declared before any import so vi.mock hoisting works) ──────────────

const findOpenTasksForOwner = vi.fn();
const findOpenTasksForAdmin = vi.fn();
const findCustomersByName = vi.fn();
const findOpenTasksForCustomer = vi.fn();
const scheduleTaskField = vi.fn();
vi.mock('../services/taskFieldScheduling', () => ({
  findOpenTasksForOwner: (...a: unknown[]) => findOpenTasksForOwner(...a),
  findOpenTasksForAdmin: (...a: unknown[]) => findOpenTasksForAdmin(...a),
  findCustomersByName: (...a: unknown[]) => findCustomersByName(...a),
  findOpenTasksForCustomer: (...a: unknown[]) => findOpenTasksForCustomer(...a),
  scheduleTaskField: (...a: unknown[]) => scheduleTaskField(...a),
}));

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
}));

// Conversation context — simple in-memory simulation.
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

vi.mock('../ai/provider', () => ({
  getProvider: () => ({ name: 'test' }),
}));

// parseIntent — returns schedule_task_field with high confidence when called.
vi.mock('../ai/intentParser', () => ({
  parseIntent: vi.fn().mockResolvedValue({
    intent: 'schedule_task_field',
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
  }),
  buildSystemPrompt: vi.fn().mockReturnValue(''),
}));

vi.mock('../utils/auditLog', () => ({
  writeAuditLog: vi.fn().mockResolvedValue('audit-log-id'),
  updateTranscribedMessage: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../ai/leadSuggester', () => ({
  suggestWorkerForLead: vi.fn().mockResolvedValue({ userId: null, reason: '' }),
}));

vi.mock('../services/pendingActions', () => ({
  getManagersForBroadcast: vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/tasks', () => ({
  listTasks: vi.fn().mockResolvedValue({ tasks: [], truncated: false }),
  getTaskById: vi.fn().mockResolvedValue(null),
  getAllowedTaskTypes: vi.fn().mockResolvedValue([]),
  getAllowedPriorities: vi.fn().mockResolvedValue([]),
  findUsersByName: vi.fn().mockResolvedValue([]),
  getEmployeeEndOfDay: vi.fn().mockResolvedValue({ tasks: [] }),
  getCompanyEndOfDay: vi.fn().mockResolvedValue({ workers: [] }),
}));
vi.mock('../services/digestPreferences', () => ({
  getEffectiveDigestPreference: vi.fn().mockResolvedValue({ morningEnabled: true, morningTime: '09:00', eveningEnabled: true, eveningTime: '17:00' }),
  upsertDigestPreference: vi.fn().mockResolvedValue(undefined),
  parseTimeInput: vi.fn().mockReturnValue(null),
}));
vi.mock('../services/taskContext', () => ({
  setActiveTask: vi.fn(),
  getActiveTask: vi.fn().mockReturnValue(null),
}));
vi.mock('../services/viewContext', () => ({
  setViewOwners: vi.fn(),
  getViewOwners: vi.fn().mockReturnValue(null),
  clearViewOwners: vi.fn(),
}));
vi.mock('../ai/taskResolver', () => ({
  resolveTask: vi.fn().mockResolvedValue({ match: null, ambiguous: false, candidates: [] }),
}));
vi.mock('./digestCommands', () => ({
  matchDigestCommand: vi.fn().mockReturnValue(null),
  planDigestCommand: vi.fn().mockReturnValue({ kind: 'free_text' }),
}));
vi.mock('../whatsapp/digestContent', () => ({
  formatDayFieldSummary: vi.fn().mockReturnValue(''),
  formatEmployeeEndOfDay: vi.fn().mockReturnValue({ text: '' }),
  formatManagerEndOfDay: vi.fn().mockReturnValue({ text: '' }),
}));
vi.mock('../services/taskFieldCorrections', () => ({
  updateSiteMetadata: vi.fn().mockResolvedValue(undefined),
  reassignTask: vi.fn().mockResolvedValue({ resetCount: 0, hadInProgressRows: false }),
  correctInspectionType: vi.fn().mockResolvedValue(undefined),
  getTaskFieldForCorrection: vi.fn().mockResolvedValue(null),
  listInspectionTypes: vi.fn().mockResolvedValue([]),
  ClosedInspectionError: class ClosedInspectionError extends Error {},
}));

// contextExtractor — default returns low confidence so AI path is a no-op.
vi.mock('../ai/contextExtractor', () => ({
  extractFromContext: vi.fn().mockResolvedValue({ values: {}, confidence: 0, clarification: null }),
  extractNote: vi.fn().mockResolvedValue(null),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

import type { ResolvedUser } from '../types';

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

function makeManager(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-manager',
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

const SAMPLE_TASK_WORKER = {
  id: 'task-1',
  title: 'בדיקת קרינה',
  productName: 'RADON',
  customerId: 'cust-1',
  customerName: 'כהן בע"מ',
  inspectionLabelHe: 'ראדון',
  inspectionFamily: 'RADON',
  inspectionTypeId: 'it-radon',
  ownerId: 'u-worker',
  siteAddress: 'הרצל 1',
  siteCity: 'תל אביב',
  fieldContactName: 'ישראל',
  fieldContactPhone: '0501111111',
  navigationUrl: 'https://waze.com/xyz',
};

const SAMPLE_TASK_OTHER_OWNER = {
  ...SAMPLE_TASK_WORKER,
  id: 'task-other',
  ownerId: 'u-other-worker',
};

const SAMPLE_TASK_NO_TYPE = {
  ...SAMPLE_TASK_WORKER,
  id: 'task-no-type',
  inspectionTypeId: null,
  inspectionFamily: null,
};

// ── Lazy-load the router after mocks are in place ─────────────────────────────

async function loadRouter() {
  return await import('../ai/router');
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  ctxStore = null;
  findOpenTasksForOwner.mockReset();
  findOpenTasksForAdmin.mockReset();
  findCustomersByName.mockReset();
  findOpenTasksForCustomer.mockReset();
  scheduleTaskField.mockReset();
  scheduleTaskField.mockResolvedValue({ taskFieldId: 'tf-new-123' });
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue(undefined);
  setContext.mockClear();
  clearContext.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────────
// Intent trigger: schedule_task_field
// ─────────────────────────────────────────────────────────────────────────────

describe('schedule_task_field — intent triggers task list for WORKER', () => {
  it('calls findOpenTasksForOwner and shows numbered task list', async () => {
    const user = makeWorker();
    findOpenTasksForOwner.mockResolvedValueOnce([SAMPLE_TASK_WORKER]);

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'לתזמן ביקור');

    expect(findOpenTasksForOwner).toHaveBeenCalledWith(user.id, expect.any(Number));
    expect(findOpenTasksForAdmin).not.toHaveBeenCalled();

    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    const listMsg = texts.find((t) => t.includes('כהן בע"מ'));
    expect(listMsg).toBeDefined();
    expect(listMsg).toContain('1.');

    expect(ctxStore).toMatchObject({
      awaiting: 'schedule_intake_pick_task',
    });
    expect(scheduleTaskField).not.toHaveBeenCalled();
  });

  it('calls findOpenTasksForAdmin for MANAGER users', async () => {
    const user = makeManager();
    findOpenTasksForAdmin.mockResolvedValueOnce([SAMPLE_TASK_WORKER]);

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'לתזמן ביקור');

    expect(findOpenTasksForAdmin).toHaveBeenCalled();
    expect(findOpenTasksForOwner).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({ awaiting: 'schedule_intake_pick_task' });
  });

  it('sends "אין משימות פתוחות" and does not set context when task list is empty', async () => {
    const user = makeWorker();
    findOpenTasksForOwner.mockResolvedValueOnce([]);

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'לתזמן ביקור');

    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('אין לך משימות פתוחות') || t.includes('אין משימות פתוחות'))).toBe(true);
    expect(ctxStore).toBeNull();
    expect(scheduleTaskField).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// schedule_intake_pick_task state
// ─────────────────────────────────────────────────────────────────────────────

describe('schedule_intake_pick_task state', () => {
  it('WORKER can pick their own task and advances to schedule_await_time', async () => {
    const user = makeWorker();
    ctxStore = {
      awaiting: 'schedule_intake_pick_task',
      scheduleTaskCandidates: [
        {
          id: SAMPLE_TASK_WORKER.id,
          title: SAMPLE_TASK_WORKER.title,
          customerName: SAMPLE_TASK_WORKER.customerName,
          inspectionLabelHe: SAMPLE_TASK_WORKER.inspectionLabelHe,
          siteCity: SAMPLE_TASK_WORKER.siteCity,
          inspectionTypeId: SAMPLE_TASK_WORKER.inspectionTypeId,
          family: SAMPLE_TASK_WORKER.inspectionFamily,
          ownerId: SAMPLE_TASK_WORKER.ownerId,
          siteAddress: SAMPLE_TASK_WORKER.siteAddress,
          fieldContactName: SAMPLE_TASK_WORKER.fieldContactName,
          fieldContactPhone: SAMPLE_TASK_WORKER.fieldContactPhone,
          navigationUrl: SAMPLE_TASK_WORKER.navigationUrl,
          productName: SAMPLE_TASK_WORKER.productName,
        },
      ],
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    expect(ctxStore).toMatchObject({ awaiting: 'schedule_await_time' });
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('מתי'))).toBe(true);
    expect(scheduleTaskField).not.toHaveBeenCalled();
  });

  it('WORKER is rejected when picking a task they do not own', async () => {
    const user = makeWorker();
    ctxStore = {
      awaiting: 'schedule_intake_pick_task',
      scheduleTaskCandidates: [
        {
          id: SAMPLE_TASK_OTHER_OWNER.id,
          title: SAMPLE_TASK_OTHER_OWNER.title,
          customerName: SAMPLE_TASK_OTHER_OWNER.customerName,
          inspectionLabelHe: SAMPLE_TASK_OTHER_OWNER.inspectionLabelHe,
          siteCity: SAMPLE_TASK_OTHER_OWNER.siteCity,
          inspectionTypeId: SAMPLE_TASK_OTHER_OWNER.inspectionTypeId,
          family: SAMPLE_TASK_OTHER_OWNER.inspectionFamily,
          ownerId: SAMPLE_TASK_OTHER_OWNER.ownerId,
          siteAddress: SAMPLE_TASK_OTHER_OWNER.siteAddress,
          fieldContactName: null,
          fieldContactPhone: null,
          navigationUrl: null,
          productName: null,
        },
      ],
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('אין הרשאה'))).toBe(true);
    expect(ctxStore).toBeNull();
    expect(scheduleTaskField).not.toHaveBeenCalled();
  });

  it('task without inspectionTypeId is rejected with a catalog error message', async () => {
    const user = makeWorker();
    ctxStore = {
      awaiting: 'schedule_intake_pick_task',
      scheduleTaskCandidates: [
        {
          id: SAMPLE_TASK_NO_TYPE.id,
          title: SAMPLE_TASK_NO_TYPE.title,
          customerName: SAMPLE_TASK_NO_TYPE.customerName,
          inspectionLabelHe: SAMPLE_TASK_NO_TYPE.inspectionLabelHe,
          siteCity: SAMPLE_TASK_NO_TYPE.siteCity,
          inspectionTypeId: null,
          family: null,
          ownerId: SAMPLE_TASK_NO_TYPE.ownerId,
          siteAddress: SAMPLE_TASK_NO_TYPE.siteAddress,
          fieldContactName: null,
          fieldContactPhone: null,
          navigationUrl: null,
          productName: null,
        },
      ],
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('קטלוג') || t.includes('אדמין'))).toBe(true);
    expect(ctxStore).toBeNull();
    expect(scheduleTaskField).not.toHaveBeenCalled();
  });

  it('typing "חיפוש" transitions to schedule_search_customer state', async () => {
    const user = makeWorker();
    ctxStore = {
      awaiting: 'schedule_intake_pick_task',
      scheduleTaskCandidates: [],
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'חיפוש');

    expect(ctxStore).toMatchObject({ awaiting: 'schedule_search_customer' });
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('שם הלקוח'))).toBe(true);
  });

  it('invalid pick number re-prompts without clearing state', async () => {
    const user = makeWorker();
    ctxStore = {
      awaiting: 'schedule_intake_pick_task',
      scheduleTaskCandidates: [
        { id: 'task-1', title: 'ת', customerName: null, inspectionLabelHe: null,
          siteCity: null, inspectionTypeId: 'it-1', family: 'F', ownerId: user.id,
          siteAddress: null, fieldContactName: null, fieldContactPhone: null,
          navigationUrl: null, productName: null },
      ],
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '99');

    expect(ctxStore).toMatchObject({ awaiting: 'schedule_intake_pick_task' });
    expect(scheduleTaskField).not.toHaveBeenCalled();
  });

  it('typing "ביטול" clears context and sends confirmation', async () => {
    const user = makeWorker();
    ctxStore = { awaiting: 'schedule_intake_pick_task', scheduleTaskCandidates: [] };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'ביטול');

    expect(ctxStore).toBeNull();
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'בוטל.' });
    expect(scheduleTaskField).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// schedule_await_time state
// ─────────────────────────────────────────────────────────────────────────────

describe('schedule_await_time state', () => {
  const BASE_CTX = {
    awaiting: 'schedule_await_time',
    scheduleSelectedTask: {
      id: 'task-1', title: 'בדיקת קרינה', customerName: 'כהן', inspectionLabelHe: 'ראדון',
      inspectionTypeId: 'it-radon', family: 'RADON', ownerId: 'u-worker',
      siteAddress: 'הרצל 1', siteCity: 'תל אביב', fieldContactName: null,
      fieldContactPhone: null, navigationUrl: null,
    },
  };

  it('accepts ISO datetime and advances to schedule_await_duration', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '2099-12-31T10:00:00+03:00');

    expect(ctxStore).toMatchObject({ awaiting: 'schedule_await_duration', scheduleStartAt: expect.any(String) });
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('משך'))).toBe(true);
  });

  it('accepts DD/MM/YYYY HH:mm format and advances', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '31/12/2099 10:00');

    expect(ctxStore).toMatchObject({ awaiting: 'schedule_await_duration' });
  });

  it('rejects invalid date format with re-prompt', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'not a date');

    expect(ctxStore).toMatchObject({ awaiting: 'schedule_await_time' });
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('לא הצלחתי') || t.includes('תאריך'))).toBe(true);
    expect(scheduleTaskField).not.toHaveBeenCalled();
  });

  it('rejects past date with re-prompt', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '2020-01-01T10:00:00+03:00');

    // Should still be awaiting time (or re-prompt without advancing).
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('עבר') || t.includes('עתידי'))).toBe(true);
    expect(scheduleTaskField).not.toHaveBeenCalled();
  });

  it('typing "ביטול" clears context', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'ביטול');

    expect(ctxStore).toBeNull();
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'בוטל.' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// schedule_await_duration state
// ─────────────────────────────────────────────────────────────────────────────

describe('schedule_await_duration state', () => {
  const BASE_CTX = {
    awaiting: 'schedule_await_duration',
    scheduleStartAt: '2099-12-31T10:00:00.000Z',
    scheduleSelectedTask: {
      id: 'task-1', title: 'בדיקת קרינה', customerName: 'כהן', inspectionLabelHe: 'ראדון',
      inspectionTypeId: 'it-radon', family: 'RADON', ownerId: 'u-worker',
      siteAddress: 'הרצל 1', siteCity: 'תל אביב', fieldContactName: null,
      fieldContactPhone: null, navigationUrl: null,
    },
  };

  it('"אישור" uses default 60-minute duration and advances to schedule_confirm', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'אישור');

    expect(ctxStore).toMatchObject({ awaiting: 'schedule_confirm', scheduleDurationMinutes: 60 });
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('לאישור') || t.includes('1. אישור'))).toBe(true);
  });

  it('numeric input sets custom duration', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '90');

    expect(ctxStore).toMatchObject({ awaiting: 'schedule_confirm', scheduleDurationMinutes: 90 });
  });

  it('"שעה וחצי" is now recognized as 90 minutes and advances to confirm', async () => {
    // The fast-path Hebrew duration parser recognises "שעה וחצי" → 90 minutes.
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'שעה וחצי');

    expect(ctxStore).toMatchObject({ awaiting: 'schedule_confirm', scheduleDurationMinutes: 90 });
    expect(scheduleTaskField).not.toHaveBeenCalled(); // not yet — still needs confirmation
  });

  it('truly unrecognized text re-prompts for duration', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };

    const { handleAIMessage } = await loadRouter();
    // Something that neither the fast-path nor the AI extractor (mocked to return low confidence) can parse.
    await handleAIMessage(user, 'לא יודע');

    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('דקות'))).toBe(true);
    expect(scheduleTaskField).not.toHaveBeenCalled();
  });

  it('typing "ביטול" clears context', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'ביטול');

    expect(ctxStore).toBeNull();
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'בוטל.' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// schedule_confirm state
// ─────────────────────────────────────────────────────────────────────────────

describe('schedule_confirm state', () => {
  const BASE_CTX = {
    awaiting: 'schedule_confirm',
    scheduleStartAt: '2099-12-31T10:00:00.000Z',
    scheduleDurationMinutes: 60,
    scheduleSpecialInstructions: null,
    scheduleSelectedTask: {
      id: 'task-1', title: 'בדיקת קרינה', customerName: 'כהן', inspectionLabelHe: 'ראדון',
      inspectionTypeId: 'it-radon', family: 'RADON', ownerId: 'u-worker',
      siteAddress: 'הרצל 1', siteCity: 'תל אביב', fieldContactName: null,
      fieldContactPhone: null, navigationUrl: null,
    },
  };

  it('choice "1" calls scheduleTaskField with correct params, clears context, sends success', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };
    scheduleTaskField.mockResolvedValueOnce({ taskFieldId: 'tf-confirmed' });

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    expect(scheduleTaskField).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      inspectionTypeId: 'it-radon',
      family: 'RADON',
      durationMinutes: 60,
      scheduledStartAt: expect.any(String),
      updatedByUserId: user.id,
    }));
    expect(ctxStore).toBeNull();
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('נקלט') || t.includes('TaskField ID'))).toBe(true);
  });

  it('choice "2" cancels without calling scheduleTaskField', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '2');

    expect(scheduleTaskField).not.toHaveBeenCalled();
    expect(ctxStore).toBeNull();
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'בוטל.' });
  });

  it('"ביטול" text cancels without calling scheduleTaskField', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'ביטול');

    expect(scheduleTaskField).not.toHaveBeenCalled();
    expect(ctxStore).toBeNull();
  });

  it('free-text at confirm escapes to AI (no schedule call, ctx cleared per v2 UX)', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };
    // After the escape, the AI mock in this file parses as `schedule_task_field`
    // and re-enters `startScheduleTaskFieldFlow`, which calls
    // `findOpenTasksForOwner`. Empty list is enough — the test only checks
    // that scheduleTaskField isn't called and the ctx moved off confirm.
    findOpenTasksForOwner.mockResolvedValueOnce([]);

    const { handleAIMessage } = await loadRouter();
    // "אולי" is Hebrew free text — the router's top-level escape hatch clears
    // ctx and re-enters as a fresh message so the AI parser can try to
    // understand it. `schedule_confirm` is NOT re-run.
    await handleAIMessage(user, 'אולי');

    expect(scheduleTaskField).not.toHaveBeenCalled();
    expect(ctxStore?.awaiting).not.toBe('schedule_confirm');
  });

  it('final auth re-check rejects WORKER who no longer owns the task', async () => {
    const user = makeWorker();
    ctxStore = {
      ...BASE_CTX,
      scheduleSelectedTask: {
        ...BASE_CTX.scheduleSelectedTask,
        ownerId: 'u-someone-else',
      },
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    expect(scheduleTaskField).not.toHaveBeenCalled();
    expect(ctxStore).toBeNull();
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('אין הרשאה'))).toBe(true);
  });

  it('scheduleTaskField DB error sends error message and clears context', async () => {
    const user = makeWorker();
    ctxStore = { ...BASE_CTX };
    scheduleTaskField.mockRejectedValueOnce(new Error('connection timeout'));

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    expect(ctxStore).toBeNull();
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('שגיאה'))).toBe(true);
  });

  it('MANAGER can confirm scheduling a task owned by another worker', async () => {
    const user = makeManager();
    ctxStore = {
      ...BASE_CTX,
      scheduleSelectedTask: {
        ...BASE_CTX.scheduleSelectedTask,
        ownerId: 'u-some-worker',  // not the manager
      },
    };
    scheduleTaskField.mockResolvedValueOnce({ taskFieldId: 'tf-mgr' });

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    expect(scheduleTaskField).toHaveBeenCalled();
    expect(ctxStore).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Customer search fallback path
// ─────────────────────────────────────────────────────────────────────────────

describe('customer search fallback — schedule_search_customer state', () => {
  it('blank input re-prompts', async () => {
    const user = makeWorker();
    ctxStore = { awaiting: 'schedule_search_customer' };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '');

    expect(ctxStore).toMatchObject({ awaiting: 'schedule_search_customer' });
    expect(findCustomersByName).not.toHaveBeenCalled();
  });

  it('no results sends "לא נמצאו" message and stays in state', async () => {
    const user = makeWorker();
    ctxStore = { awaiting: 'schedule_search_customer' };
    findCustomersByName.mockResolvedValueOnce([]);

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'כהן');

    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('לא נמצאו'))).toBe(true);
    expect(ctxStore).toMatchObject({ awaiting: 'schedule_search_customer' });
  });

  it('found customers → shows numbered list, transitions to schedule_pick_from_search', async () => {
    const user = makeWorker();
    ctxStore = { awaiting: 'schedule_search_customer' };
    findCustomersByName.mockResolvedValueOnce([
      { id: 'c-1', name: 'כהן בע"מ', openTaskCount: 2 },
      { id: 'c-2', name: 'כהנמן', openTaskCount: 0 },
    ]);

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'כהן');

    expect(ctxStore).toMatchObject({
      awaiting: 'schedule_pick_from_search',
      scheduleCustomerCandidates: expect.arrayContaining([
        expect.objectContaining({ id: 'c-1' }),
      ]),
    });
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    const listMsg = texts.find((t) => t.includes('כהן בע"מ'));
    expect(listMsg).toBeDefined();
    expect(listMsg).toContain('1.');
  });

  it('"ביטול" from search state clears context', async () => {
    const user = makeWorker();
    ctxStore = { awaiting: 'schedule_search_customer' };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'ביטול');

    expect(ctxStore).toBeNull();
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'בוטל.' });
  });
});

describe('customer search fallback — schedule_pick_from_search state', () => {
  it('picking a customer shows their open tasks and transitions to schedule_intake_pick_task', async () => {
    const user = makeWorker();
    ctxStore = {
      awaiting: 'schedule_pick_from_search',
      scheduleCustomerCandidates: [
        { id: 'c-1', name: 'כהן בע"מ', openTaskCount: 1 },
      ],
    };
    findOpenTasksForCustomer.mockResolvedValueOnce([SAMPLE_TASK_WORKER]);

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    expect(findOpenTasksForCustomer).toHaveBeenCalledWith('c-1', expect.any(Number));
    expect(ctxStore).toMatchObject({ awaiting: 'schedule_intake_pick_task' });
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('כהן') && t.includes('1.'))).toBe(true);
  });

  it('no open tasks for chosen customer sends message and clears context', async () => {
    const user = makeWorker();
    ctxStore = {
      awaiting: 'schedule_pick_from_search',
      scheduleCustomerCandidates: [{ id: 'c-2', name: 'לוי', openTaskCount: 0 }],
    };
    findOpenTasksForCustomer.mockResolvedValueOnce([]);

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    expect(ctxStore).toBeNull();
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('אין') && t.includes('לוי'))).toBe(true);
  });

  it('invalid pick number re-prompts without clearing state', async () => {
    const user = makeWorker();
    ctxStore = {
      awaiting: 'schedule_pick_from_search',
      scheduleCustomerCandidates: [{ id: 'c-1', name: 'כהן', openTaskCount: 1 }],
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '99');

    expect(ctxStore).toMatchObject({ awaiting: 'schedule_pick_from_search' });
    expect(scheduleTaskField).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pre-filled startAt from intent params skips the time-ask step
// ─────────────────────────────────────────────────────────────────────────────

describe('prefilled scheduledStartAt from intent params', () => {
  it('if LLM provides scheduledStartAt, skips schedule_await_time after task pick', async () => {
    // Simulate: LLM parsed "לתזמן ביקור מחר ב-10" → params.scheduledStartAt set.
    // We test via task-pick state that already has scheduleStartAt in ctx.
    const user = makeWorker();
    ctxStore = {
      awaiting: 'schedule_intake_pick_task',
      scheduleStartAt: '2099-12-31T10:00:00.000Z',  // pre-filled
      scheduleTaskCandidates: [
        {
          id: SAMPLE_TASK_WORKER.id, title: SAMPLE_TASK_WORKER.title,
          customerName: SAMPLE_TASK_WORKER.customerName,
          inspectionLabelHe: SAMPLE_TASK_WORKER.inspectionLabelHe,
          siteCity: SAMPLE_TASK_WORKER.siteCity,
          inspectionTypeId: SAMPLE_TASK_WORKER.inspectionTypeId,
          family: SAMPLE_TASK_WORKER.inspectionFamily,
          ownerId: SAMPLE_TASK_WORKER.ownerId,
          siteAddress: SAMPLE_TASK_WORKER.siteAddress,
          fieldContactName: null, fieldContactPhone: null,
          navigationUrl: null, productName: null,
        },
      ],
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    // Should skip to duration step because startAt already set.
    expect(ctxStore).toMatchObject({ awaiting: 'schedule_await_duration' });
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('משך'))).toBe(true);
  });
});
