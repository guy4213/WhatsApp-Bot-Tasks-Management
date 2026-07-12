/**
 * PROV-T5 — router-level tests for `enable_worker_location_tracking`.
 *
 * Covers:
 *  1. Non-manager → 'אין הרשאה.'
 *  2. Manager, no hint → prompt for worker name
 *  3. Manager, hint, 0 matches → "לא נמצא עובד"
 *  4. Manager, ambiguous match (>1) → disambiguation list
 *  5. Manager, 1 match, no phone → phone-missing message
 *  6. Manager, createProvisioning throws with 'PUBLIC_BASE_URL' → env-missing message
 *  7. Manager, createProvisioning throws with other error → generic error
 *  8. Manager, notify throws → error with URL included
 *  9. Happy path — full success → worker gets notify, manager gets confirmation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (declared before any import so vi.mock hoisting works) ──────────────

// db/connection — pool.query is controlled per-test
const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: {
    query: (...args: unknown[]) => poolQuery(...args),
    connect: vi.fn().mockRejectedValue(new Error('pool.connect not mocked in this test')),
  },
}));

// owntracksProvisioning — createProvisioning is the key mock
const createProvisioning = vi.fn();
vi.mock('../services/owntracksProvisioning', () => ({
  createProvisioning: (...args: unknown[]) => createProvisioning(...args),
  consumeProvisioning: vi.fn().mockResolvedValue(null),
}));

// templates — notify is the key mock
const notify = vi.fn();
vi.mock('../whatsapp/templates', () => ({
  notify: (...args: unknown[]) => notify(...args),
}));

// tasks service — findUsersByName is the key mock here
const findUsersByName = vi.fn();
vi.mock('../services/tasks', () => ({
  findUsersByName: (...args: unknown[]) => findUsersByName(...args),
  listTasks: vi.fn().mockResolvedValue({ tasks: [], truncated: false }),
  getTaskById: vi.fn().mockResolvedValue(null),
  getAllowedTaskTypes: vi.fn().mockResolvedValue([]),
  getAllowedPriorities: vi.fn().mockResolvedValue([]),
  getEmployeeEndOfDay: vi.fn().mockResolvedValue({ dueToday: 0, completed: 0, notCompleted: 0, overdue: 0, openCarry: 0, unfinishedTitles: [] }),
  getCompanyEndOfDay: vi.fn().mockResolvedValue({ employees: [] }),
  getTaskDetailsForReminder: vi.fn().mockResolvedValue(null),
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

// Conversation context — simple in-memory simulation
let ctxStore: Record<string, unknown> | null = null;
const setContext  = vi.fn(async (_phone: string, state: unknown) => { ctxStore = state as Record<string, unknown>; });
const getContext  = vi.fn(async () => null as Record<string, unknown> | null);
const clearContext = vi.fn(async () => { ctxStore = null; });
vi.mock('../services/conversationContext', () => ({
  setContext:  (p: string, s: unknown) => setContext(p, s),
  getContext:  (_p: string) => getContext(),
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

// intentParser — controlled per-test via mockParseIntent()
const parseIntentMock = vi.fn();
vi.mock('../ai/intentParser', () => ({
  parseIntent: (...a: unknown[]) => parseIntentMock(...a),
  buildSystemPrompt: vi.fn().mockReturnValue(''),
}));

// Audit log — no-op
vi.mock('../utils/auditLog', () => ({
  writeAuditLog: vi.fn().mockResolvedValue('audit-id'),
  updateTranscribedMessage: vi.fn().mockResolvedValue(undefined),
}));

// inspections service — stubs
vi.mock('../services/inspections', () => ({
  findOpenTaskFieldForWorker: vi.fn().mockResolvedValue(null),
  findActiveInProgressTaskFieldForWorker: vi.fn().mockResolvedValue(null),
  validateWorkerTaskField: vi.fn().mockResolvedValue(null),
  writeTravelEta: vi.fn().mockResolvedValue(undefined),
  resolveOpenTaskFieldByHint: vi.fn().mockResolvedValue(null),
  advanceFieldStatus: vi.fn().mockResolvedValue(undefined),
  writeFieldNotes: vi.fn().mockResolvedValue(undefined),
  writeMissingInfo: vi.fn().mockResolvedValue(undefined),
  writeProblem: vi.fn().mockResolvedValue(undefined),
  notifyOfficeMissingInfo: vi.fn().mockResolvedValue(true),
  notifyOfficeProblem: vi.fn().mockResolvedValue(true),
  notifyOfficeMissingEquipment: vi.fn().mockResolvedValue(true),
  notifyOfficeCallbackRequest: vi.fn().mockResolvedValue(true),
  dayFieldSummary: vi.fn().mockResolvedValue({ finished: [], waitingForInfoCount: 0 }),
  confirmInspection: vi.fn().mockResolvedValue(undefined),
  declineInspection: vi.fn().mockResolvedValue(undefined),
  requestMoreInfo: vi.fn().mockResolvedValue(undefined),
  notifyOfficeDeclined: vi.fn().mockResolvedValue(true),
  notifyOfficeNeedsMoreInfo: vi.fn().mockResolvedValue(true),
}));

// taskFieldCorrections — stubs
vi.mock('../services/taskFieldCorrections', () => ({
  updateSiteMetadata: vi.fn().mockResolvedValue(undefined),
  reassignTask: vi.fn().mockResolvedValue({ resetCount: 0, hadInProgressRows: false }),
  correctInspectionType: vi.fn().mockResolvedValue({ oldProductName: 'old', newProductName: 'new' }),
  ClosedInspectionError: class ClosedInspectionError extends Error {},
  listInspectionTypes: vi.fn().mockResolvedValue([]),
  getTaskFieldForCorrection: vi.fn().mockResolvedValue(null),
  updateTaskFieldSchedule: vi.fn().mockResolvedValue(undefined),
}));

// taskFieldScheduling — stubs
vi.mock('../services/taskFieldScheduling', () => ({
  findOpenTasksForOwner: vi.fn().mockResolvedValue([]),
  findOpenTasksForAdmin: vi.fn().mockResolvedValue([]),
  findCustomersByName: vi.fn().mockResolvedValue([]),
  findOpenTasksForCustomer: vi.fn().mockResolvedValue([]),
  scheduleTaskField: vi.fn().mockResolvedValue({ taskFieldId: 'new-tf' }),
}));

// incomingLeads — stubs
vi.mock('../services/incomingLeads', () => ({
  findUnassignedLeadsForAssignment: vi.fn().mockResolvedValue([]),
  findActiveInspectors: vi.fn().mockResolvedValue([]),
  assignLead: vi.fn().mockResolvedValue(undefined),
  getLeadById: vi.fn().mockResolvedValue(null),
  findUnassignedInWindow: vi.fn().mockResolvedValue([]),
  findOvernightUnassignedLeads: vi.fn().mockResolvedValue([]),
  findNewlyAssignedLeads: vi.fn().mockResolvedValue([]),
  findEscalationCandidates: vi.fn().mockResolvedValue([]),
  getYoramLeadCounts: vi.fn().mockResolvedValue({ overnight: 0, unassigned: 0 }),
}));

// pendingActions — stubs
vi.mock('../services/pendingActions', () => ({
  getManagersForBroadcast: vi.fn().mockResolvedValue([]),
  createPendingAction: vi.fn().mockResolvedValue({ id: 'pa1' }),
  updatePendingActionState: vi.fn().mockResolvedValue(undefined),
}));

// digestPreferences — stubs
vi.mock('../services/digestPreferences', () => ({
  getEffectiveDigestPreference: vi.fn().mockResolvedValue({ morningEnabled: true, morningTime: '08:00', eveningEnabled: true, eveningTime: '17:00' }),
  upsertDigestPreference: vi.fn().mockResolvedValue(undefined),
  parseTimeInput: vi.fn().mockReturnValue(null),
}));

// viewContext — stubs
vi.mock('../services/viewContext', () => ({
  setViewOwners: vi.fn(),
  getViewOwners: vi.fn().mockReturnValue(null),
  clearViewOwners: vi.fn(),
}));

// taskContext — stubs
vi.mock('../services/taskContext', () => ({
  setActiveTask: vi.fn(),
  getActiveTask: vi.fn().mockReturnValue(null),
}));

// taskResolver — stubs
vi.mock('../ai/taskResolver', () => ({
  resolveTask: vi.fn().mockResolvedValue({ match: null, ambiguous: false, candidates: [] }),
}));

// leadSuggester — stubs
vi.mock('../ai/leadSuggester', () => ({
  suggestWorkerForLead: vi.fn().mockResolvedValue({ userId: null, reason: '' }),
}));

// digestCommands — stubs
vi.mock('../ai/digestCommands', () => ({
  matchDigestCommand: vi.fn().mockReturnValue(null),
  planDigestCommand: vi.fn().mockReturnValue({ kind: 'free_text' }),
  DIGEST_PAYLOAD_IDS: { FREE_TEXT: 'FREE_TEXT', EMP_TODAY: 'EMP_TODAY', EMP_EOD: 'EMP_EOD', TEAM_TODAY: 'TEAM_TODAY', TEAM_EOD: 'TEAM_EOD' },
}));

// digestContent — stubs
vi.mock('../whatsapp/digestContent', () => ({
  formatDayFieldSummary: vi.fn().mockReturnValue(''),
  formatEmployeeEndOfDay: vi.fn().mockReturnValue({ text: '' }),
  formatManagerEndOfDay: vi.fn().mockReturnValue({ text: '' }),
  formatInspectorDayList: vi.fn().mockReturnValue(''),
}));

// managerViews — stubs
vi.mock('../services/managerViews', () => ({
  getManagementSnapshot: vi.fn().mockResolvedValue(null),
  getTodayFieldInspections: vi.fn().mockResolvedValue([]),
  getMyFieldInspectionsToday: vi.fn().mockResolvedValue([]),
  getFieldExceptionRows: vi.fn().mockResolvedValue([]),
  getAllWorkersDayOverview: vi.fn().mockResolvedValue([]),
  getWorkerDayDetail: vi.fn().mockResolvedValue(null),
  searchTasksByWorkerName: vi.fn().mockResolvedValue([]),
  searchTasksByProductCode: vi.fn().mockResolvedValue([]),
  searchTasksByCustomerName: vi.fn().mockResolvedValue([]),
  searchTasksByAddress: vi.fn().mockResolvedValue([]),
  searchTasksByPhone: vi.fn().mockResolvedValue([]),
  searchTasksByTaskId: vi.fn().mockResolvedValue([]),
  searchTasksByFieldStatus: vi.fn().mockResolvedValue([]),
  getTaskFieldDetail: vi.fn().mockResolvedValue(null),
  getTaskFieldValuesForContext: vi.fn().mockResolvedValue(null),
}));

// inspectionsQueries — stubs
vi.mock('../services/inspectionsQueries', () => ({
  getInspectionsForWorkerOnDate: vi.fn().mockResolvedValue([]),
}));

// myInspectionsRange — stubs
vi.mock('../services/myInspectionsRange', () => ({
  getMyInspectionsInRange: vi.fn().mockResolvedValue([]),
  getAllMyInspections: vi.fn().mockResolvedValue([]),
}));

// tracking — stubs
vi.mock('../services/tracking', () => ({
  openTrackingSession: vi.fn().mockResolvedValue(undefined),
  markArrived: vi.fn().mockResolvedValue(undefined),
  closeSession: vi.fn().mockResolvedValue(undefined),
}));

// messageRefs — stubs
vi.mock('../services/messageRefs', () => ({
  resolveQuotedContext: vi.fn().mockResolvedValue(null),
  recordTaskFieldRef: vi.fn().mockResolvedValue(undefined),
}));

// preInspectionReminder — stubs
vi.mock('../services/preInspectionReminder', () => ({
  preReminderDepartPayloadId: vi.fn().mockReturnValue('depart'),
  preReminderNeedInfoPayloadId: vi.fn().mockReturnValue('needinfo'),
  preReminderProblemPayloadId: vi.fn().mockReturnValue('problem'),
}));

// dueDateReminder — stubs
vi.mock('../scheduler/jobs/dueDateReminder', () => ({
  matchTaskDetailsPayload: vi.fn().mockReturnValue(null),
}));

// contextExtractor — stubs
vi.mock('../ai/contextExtractor', () => ({
  extractFromContext: vi.fn().mockResolvedValue({ values: {}, confidence: 0, clarification: null }),
  extractNote: vi.fn().mockResolvedValue(null),
  extractInspectionActions: vi.fn().mockResolvedValue([]),
}));

// leadCategorizer — stubs
vi.mock('../services/leadCategorizer', () => ({
  enrichLead: vi.fn().mockResolvedValue(null),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { handleAIMessage } from '../ai/router';
import type { ResolvedUser } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeManager(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-manager',
    name: 'מנהל',
    phone: '972501111111',
    role: 'MANAGER',
    isElevated: true,
    canViewAllRecords: true,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

function makeWorkerUser(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-worker',
    name: 'עובד',
    phone: '972509999999',
    role: 'SALES',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

/** Build a high-confidence AIIntentResult stub for enable_worker_location_tracking */
function makeTrackingIntent(extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'enable_worker_location_tracking',
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

function mockParseIntent(result: Record<string, unknown>): void {
  parseIntentMock.mockResolvedValue(result);
}

beforeEach(() => {
  ctxStore = null;
  poolQuery.mockReset();
  createProvisioning.mockReset();
  notify.mockReset();
  findUsersByName.mockReset();
  sendTextMessage.mockReset();  sendTextMessage.mockResolvedValue(undefined);
  sendButtonMessage.mockReset(); sendButtonMessage.mockResolvedValue(undefined);
  sendListMessage.mockReset();   sendListMessage.mockResolvedValue(undefined);
  setContext.mockClear();
  clearContext.mockClear();
  getContext.mockImplementation(async () => null);
  parseIntentMock.mockReset();
});

afterEach(() => { vi.restoreAllMocks(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

// ── Test 1: Non-manager → 'אין הרשאה.' ──────────────────────────────────────

describe('enable_worker_location_tracking — auth guard', () => {
  it('rejects a non-manager with "אין הרשאה."', async () => {
    mockParseIntent(makeTrackingIntent({ task_reference: 'דני' }));

    await handleAIMessage(makeWorkerUser(), 'הפעל מעקב מיקום לדני');

    const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(texts.some((t) => t.includes('אין הרשאה'))).toBe(true);
    expect(createProvisioning).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

// ── Test 2: Manager, no hint → prompt ────────────────────────────────────────

describe('enable_worker_location_tracking — no hint', () => {
  it('prompts for worker name when no hint is provided', async () => {
    mockParseIntent(makeTrackingIntent({
      task_reference: null,
      params: {},
    }));

    await handleAIMessage(makeManager(), 'הפעל מעקב מיקום');

    const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(texts.some((t) => t.includes('לאיזה עובד להפעיל מעקב מיקום'))).toBe(true);
    expect(createProvisioning).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

// ── Test 3: Manager, hint, 0 matches → "לא נמצא עובד" ───────────────────────

describe('enable_worker_location_tracking — no matching worker', () => {
  it('sends "לא נמצא עובד" when findUsersByName returns empty', async () => {
    findUsersByName.mockResolvedValueOnce([]);
    mockParseIntent(makeTrackingIntent({ task_reference: 'גורדון' }));

    await handleAIMessage(makeManager(), 'הפעל מעקב מיקום לגורדון');

    const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(texts.some((t) => t.includes('לא נמצא עובד'))).toBe(true);
    expect(createProvisioning).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

// ── Test 4: Manager, ambiguous match → disambiguation list ───────────────────

describe('enable_worker_location_tracking — ambiguous match', () => {
  it('sends disambiguation list when findUsersByName returns >1 result', async () => {
    findUsersByName.mockResolvedValueOnce([
      { id: 'w1', name: 'דני כהן' },
      { id: 'w2', name: 'דני לוי' },
    ]);
    mockParseIntent(makeTrackingIntent({ task_reference: 'דני' }));

    await handleAIMessage(makeManager(), 'הפעל מעקב מיקום לדני');

    const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    const matchingText = texts.find((t) => t.includes('נמצאו מספר עובדים תואמים'));
    expect(matchingText).toBeDefined();
    expect(matchingText).toContain('דני כהן');
    expect(matchingText).toContain('דני לוי');
    expect(createProvisioning).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

// ── Test 5: Manager, one match, no phone → phone-missing message ──────────────

describe('enable_worker_location_tracking — no phone', () => {
  it('sends phone-missing message when worker has no phone', async () => {
    findUsersByName.mockResolvedValueOnce([{ id: 'w1', name: 'דני' }]);
    poolQuery.mockResolvedValueOnce({ rows: [{ phone: null }] });
    mockParseIntent(makeTrackingIntent({ task_reference: 'דני' }));

    await handleAIMessage(makeManager(), 'הפעל מעקב מיקום לדני');

    const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(texts.some((t) => t.includes('לא רשום מספר טלפון'))).toBe(true);
    expect(createProvisioning).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

// ── Test 6: createProvisioning throws PUBLIC_BASE_URL → env-missing message ───

describe('enable_worker_location_tracking — createProvisioning PUBLIC_BASE_URL error', () => {
  it('sends PUBLIC_BASE_URL-missing message when createProvisioning throws with that message', async () => {
    findUsersByName.mockResolvedValueOnce([{ id: 'w1', name: 'דני' }]);
    poolQuery.mockResolvedValueOnce({ rows: [{ phone: '972501234567' }] });
    createProvisioning.mockRejectedValueOnce(new Error('PUBLIC_BASE_URL env var is not set'));
    mockParseIntent(makeTrackingIntent({ task_reference: 'דני' }));

    await handleAIMessage(makeManager(), 'הפעל מעקב מיקום לדני');

    const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(texts.some((t) => t.includes('PUBLIC_BASE_URL חסר'))).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });
});

// ── Test 7: createProvisioning throws generic error → "שגיאה ביצירת קישור" ───

describe('enable_worker_location_tracking — createProvisioning generic error', () => {
  it('sends generic error message when createProvisioning throws a non-env error', async () => {
    findUsersByName.mockResolvedValueOnce([{ id: 'w1', name: 'דני' }]);
    poolQuery.mockResolvedValueOnce({ rows: [{ phone: '972501234567' }] });
    createProvisioning.mockRejectedValueOnce(new Error('boom'));
    mockParseIntent(makeTrackingIntent({ task_reference: 'דני' }));

    await handleAIMessage(makeManager(), 'הפעל מעקב מיקום לדני');

    const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(texts.some((t) => t.includes('שגיאה ביצירת קישור'))).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });
});

// ── Test 8: notify throws → error with URL told to manager ───────────────────

describe('enable_worker_location_tracking — notify failure', () => {
  it('tells manager about URL when notify throws', async () => {
    const expiresAt = new Date('2026-07-14T10:00:00Z');
    findUsersByName.mockResolvedValueOnce([{ id: 'w1', name: 'דני' }]);
    poolQuery.mockResolvedValueOnce({ rows: [{ phone: '972501234567' }] });
    createProvisioning.mockResolvedValueOnce({
      magicUrl: 'https://bot.example.com/o/tok123',
      workerKey: 'w_abc',
      expiresAt,
    });
    notify.mockRejectedValueOnce(new Error('meta down'));
    mockParseIntent(makeTrackingIntent({ task_reference: 'דני' }));

    await handleAIMessage(makeManager(), 'הפעל מעקב מיקום לדני');

    const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    const errorMsg = texts.find((t) => t.includes('נכשלה'));
    expect(errorMsg).toBeDefined();
    expect(errorMsg).toContain('https://bot.example.com/o/tok123');
  });
});

// ── Test 9: Happy path — full success ────────────────────────────────────────

describe('enable_worker_location_tracking — happy path', () => {
  it('sends notify to worker and confirmation to manager on success', async () => {
    const expiresAt = new Date('2026-07-14T10:00:00Z');
    findUsersByName.mockResolvedValueOnce([{ id: 'w1', name: 'דני' }]);
    poolQuery.mockResolvedValueOnce({ rows: [{ phone: '972501234567' }] });
    createProvisioning.mockResolvedValueOnce({
      magicUrl: 'https://bot.example.com/o/tok123',
      workerKey: 'w_abc',
      expiresAt,
    });
    notify.mockResolvedValueOnce('wamid-xyz');
    mockParseIntent(makeTrackingIntent({ task_reference: 'דני' }));

    await handleAIMessage(makeManager(), 'הפעל מעקב מיקום לדני');

    // Assert notify was called with correct args
    expect(notify).toHaveBeenCalledTimes(1);
    const notifyArg = notify.mock.calls[0][0] as {
      to: string;
      key: string;
      bodyParams: string[];
      fallbackText: string;
    };
    expect(notifyArg.to).toBe('972501234567');
    expect(notifyArg.key).toBe('OWNTRACKS_PROVISIONING');
    expect(notifyArg.bodyParams).toEqual(['דני', 'https://bot.example.com/o/tok123']);
    // fallbackText contains the URL, checklist keywords, and 48h expiry
    expect(notifyArg.fallbackText).toContain('https://bot.example.com/o/tok123');
    expect(notifyArg.fallbackText).toContain('Always');
    expect(notifyArg.fallbackText).toContain('אופטימיזציית סוללה');
    expect(notifyArg.fallbackText).toContain('48 שעות');

    // Assert manager gets confirmation containing worker name
    const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(texts.some((t) => t.includes('נשלח לעובד דני'))).toBe(true);
  });

  it('uses workerHint from params when task_reference is null', async () => {
    const expiresAt = new Date('2026-07-14T10:00:00Z');
    findUsersByName.mockResolvedValueOnce([{ id: 'w2', name: 'יוסי' }]);
    poolQuery.mockResolvedValueOnce({ rows: [{ phone: '972507777777' }] });
    createProvisioning.mockResolvedValueOnce({
      magicUrl: 'https://bot.example.com/o/tok456',
      workerKey: 'w_yossi',
      expiresAt,
    });
    notify.mockResolvedValueOnce('wamid-abc');
    mockParseIntent(makeTrackingIntent({
      task_reference: null,
      params: { workerHint: 'יוסי' },
    }));

    await handleAIMessage(makeManager(), 'הפעל מעקב מיקום ליוסי');

    expect(findUsersByName).toHaveBeenCalledWith('יוסי');
    const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(texts.some((t) => t.includes('נשלח לעובד יוסי'))).toBe(true);
  });
});
