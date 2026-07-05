/**
 * managerSearchExpansion.test.ts — D5-T12 Phase 5
 *
 * Verifies Phase 5 additions:
 *  5a — schema: new searchBy enum values + count_only param
 *  5b — prompt: new FEW_SHOT examples present in the manager prompt
 *  5c — router: new searchBy dimensions dispatched to correct service functions,
 *       Hebrew field_status synonyms resolve correctly, count_only skips picker
 *  5d — services: new search functions called with correct arguments
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
const searchTasksByAddress = vi.fn();
const searchTasksByPhone = vi.fn();
const searchTasksByTaskId = vi.fn();
const searchTasksByFieldStatus = vi.fn();
const getTaskFieldDetail = vi.fn();
const getTaskFieldValuesForContext = vi.fn();
const getMyFieldInspectionsToday = vi.fn();

vi.mock('../services/managerViews', () => ({
  getManagementSnapshot: (...a: unknown[]) => getManagementSnapshot(...a),
  getTodayFieldInspections: (...a: unknown[]) => getTodayFieldInspections(...a),
  getMyFieldInspectionsToday: (...a: unknown[]) => getMyFieldInspectionsToday(...a),
  getFieldExceptionRows: (...a: unknown[]) => getFieldExceptionRows(...a),
  getAllWorkersDayOverview: (...a: unknown[]) => getAllWorkersDayOverview(...a),
  getWorkerDayDetail: (...a: unknown[]) => getWorkerDayDetail(...a),
  searchTasksByWorkerName: (...a: unknown[]) => searchTasksByWorkerName(...a),
  searchTasksByProductCode: (...a: unknown[]) => searchTasksByProductCode(...a),
  searchTasksByAddress: (...a: unknown[]) => searchTasksByAddress(...a),
  searchTasksByPhone: (...a: unknown[]) => searchTasksByPhone(...a),
  searchTasksByTaskId: (...a: unknown[]) => searchTasksByTaskId(...a),
  searchTasksByFieldStatus: (...a: unknown[]) => searchTasksByFieldStatus(...a),
  getTaskFieldDetail: (...a: unknown[]) => getTaskFieldDetail(...a),
  getTaskFieldValuesForContext: (...a: unknown[]) => getTaskFieldValuesForContext(...a),
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
  getLeadById: vi.fn().mockResolvedValue(null),
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
  sendTextMessage: (arg: { to: string; text: string }) => sendTextMessage(arg),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
  sendListMessage: (arg: { to: string; body: string; sections: Array<{ rows: Array<{ id: string; title: string }> }> }) => sendListMessage(arg),
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
import { parseIntentResult, INTENT_JSON_SCHEMA } from '../ai/schema';
import type { ResolvedUser } from '../types';

// buildSystemPrompt: imported via vi.importActual inside the describe block to
// avoid top-level await (which requires module:esnext in tsconfig).
let buildSystemPrompt: (typeof import('../ai/intentParser'))['buildSystemPrompt'];

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

function makeWorker(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-worker',
    name: 'דני',
    phone: '97250000002',
    role: 'TECHNICIAN',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
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

function mockParseIntent(result: Record<string, unknown>): void {
  parseIntentMock.mockResolvedValue(result);
}

function lastMsg(): string {
  return msgLog[msgLog.length - 1] ?? '';
}

/** A minimal TodayFieldInspectionRow for mocking */
function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    taskFieldId: 'tf1',
    taskId: 't1',
    workerName: 'דני',
    customerName: 'לקוח א',
    taskTitle: 'משימה',
    timeHm: '09:00',
    siteCity: 'רעננה',
    fieldStatus: 'ASSIGNED',
    family: 'noise',
    typeLabelHe: 'רעש',
    ...overrides,
  };
}

const admin = makeManager();
const worker = makeWorker();

beforeEach(() => {
  sendTextMessage.mockClear();
  sendListMessage.mockClear();
  msgLog.length = 0;
  setContext.mockClear();
  clearContext.mockClear();
  getContext.mockClear();
  parseIntentMock.mockClear();
  ctxStore = null;
  getManagementSnapshot.mockReset();
  getTodayFieldInspections.mockReset();
  getFieldExceptionRows.mockReset();
  getAllWorkersDayOverview.mockReset();
  getWorkerDayDetail.mockReset();
  searchTasksByWorkerName.mockReset();
  searchTasksByProductCode.mockReset();
  searchTasksByAddress.mockReset();
  searchTasksByPhone.mockReset();
  searchTasksByTaskId.mockReset();
  searchTasksByFieldStatus.mockReset();
  getTaskFieldDetail.mockReset();
});

afterEach(() => { vi.restoreAllMocks(); });

// ── 5a: Schema — expanded searchBy enum + count_only ─────────────────────────

describe('5a — schema: expanded searchBy enum', () => {
  const schemaProperties = (INTENT_JSON_SCHEMA as { properties: { params: { properties: { searchBy: { enum: string[] } } } } }).properties.params.properties.searchBy;

  it('schema searchBy enum includes "address"', () => {
    expect(schemaProperties.enum).toContain('address');
  });

  it('schema searchBy enum includes "phone"', () => {
    expect(schemaProperties.enum).toContain('phone');
  });

  it('schema searchBy enum includes "task_id"', () => {
    expect(schemaProperties.enum).toContain('task_id');
  });

  it('schema searchBy enum includes "field_status"', () => {
    expect(schemaProperties.enum).toContain('field_status');
  });

  it('schema searchBy enum still contains existing values', () => {
    expect(schemaProperties.enum).toContain('customer');
    expect(schemaProperties.enum).toContain('worker');
    expect(schemaProperties.enum).toContain('product');
  });
});

describe('5a — schema: count_only param', () => {
  it('count_only param exists in schema', () => {
    const props = (INTENT_JSON_SCHEMA as { properties: { params: { properties: Record<string, unknown> } } }).properties.params.properties;
    expect(props).toHaveProperty('count_only');
  });

  it('count_only param has type boolean', () => {
    const countOnly = (INTENT_JSON_SCHEMA as { properties: { params: { properties: { count_only: { type: string } } } } }).properties.params.properties.count_only;
    expect(countOnly.type).toBe('boolean');
  });

  it('parseIntentResult passes count_only=true through params', () => {
    const r = parseIntentResult({
      intent: 'list_today_field_inspections',
      confidence: 0.95,
      params: { count_only: true },
    });
    expect(r.params.count_only).toBe(true);
  });

  it('parseIntentResult passes count_only=false through params', () => {
    const r = parseIntentResult({
      intent: 'workers_day_overview',
      confidence: 0.9,
      params: { count_only: false },
    });
    expect(r.params.count_only).toBe(false);
  });
});

// ── 5b: Prompt — manager FEW_SHOT examples ───────────────────────────────────

describe('5b — prompt: new FEW_SHOT examples in manager prompt', () => {
  beforeEach(async () => {
    if (!buildSystemPrompt) {
      const mod = await vi.importActual<typeof import('../ai/intentParser')>('../ai/intentParser');
      buildSystemPrompt = mod.buildSystemPrompt;
    }
  });

  it('manager prompt contains address search example', () => {
    const prompt = buildSystemPrompt({ user: makeManager(), allowedTypes: [], allowedPriorities: [] });
    expect(prompt).toContain('searchBy="address"');
  });

  it('manager prompt contains phone search example', () => {
    const prompt = buildSystemPrompt({ user: makeManager(), allowedTypes: [], allowedPriorities: [] });
    expect(prompt).toContain('searchBy="phone"');
  });

  it('manager prompt contains task_id search example', () => {
    const prompt = buildSystemPrompt({ user: makeManager(), allowedTypes: [], allowedPriorities: [] });
    expect(prompt).toContain('searchBy="task_id"');
  });

  it('manager prompt contains field_status search example', () => {
    const prompt = buildSystemPrompt({ user: makeManager(), allowedTypes: [], allowedPriorities: [] });
    expect(prompt).toContain('searchBy="field_status"');
  });

  it('manager prompt contains count_only=true example for כמה בדיקות', () => {
    const prompt = buildSystemPrompt({ user: makeManager(), allowedTypes: [], allowedPriorities: [] });
    expect(prompt).toContain('count_only=true');
    expect(prompt).toContain('כמה בדיקות היום');
  });

  it('manager prompt contains count_only example for כמה חריגים', () => {
    const prompt = buildSystemPrompt({ user: makeManager(), allowedTypes: [], allowedPriorities: [] });
    expect(prompt).toContain('כמה חריגים');
  });

  it('manager prompt contains count_only example for כמה לידים לא שויכו', () => {
    const prompt = buildSystemPrompt({ user: makeManager(), allowedTypes: [], allowedPriorities: [] });
    expect(prompt).toContain('כמה לידים לא שויכו');
  });

  it('manager prompt contains count_only example for כמה עובדים בשטח', () => {
    const prompt = buildSystemPrompt({ user: makeManager(), allowedTypes: [], allowedPriorities: [] });
    expect(prompt).toContain('כמה עובדים בשטח היום');
  });

  it('manager prompt does NOT expose count_only examples to workers', () => {
    const workerPrompt = buildSystemPrompt({ user: makeWorker(), allowedTypes: [], allowedPriorities: [] });
    // count_only is a manager-only concept — must NOT appear in worker prompt.
    expect(workerPrompt).not.toContain('count_only');
  });
});

// ── 5c + 5d: Router dispatches new searchBy dimensions ───────────────────────

describe('5c+5d — router: searchBy=address dispatches to searchTasksByAddress', () => {
  it('calls searchTasksByAddress with the query', async () => {
    searchTasksByAddress.mockResolvedValue([makeRow({ siteCity: 'רעננה' })]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'address', query: 'הרצל' } }));
    await handleAIMessage(admin, 'חפש לפי כתובת הרצל');
    expect(searchTasksByAddress).toHaveBeenCalledWith('הרצל');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_pick_task', mgrSearchKind: 'address' });
  });

  it('returns no-results message when address search returns empty', async () => {
    searchTasksByAddress.mockResolvedValue([]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'address', query: 'כתובת לא קיימת' } }));
    await handleAIMessage(admin, 'חפש כתובת לא קיימת');
    expect(lastMsg()).toContain('לא נמצאו תוצאות');
    expect(ctxStore).toBeNull();
  });

  it('does NOT call searchTasksByWorkerName or other functions', async () => {
    searchTasksByAddress.mockResolvedValue([makeRow()]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'address', query: 'הרצל' } }));
    await handleAIMessage(admin, 'בדיקות בהרצל');
    expect(searchTasksByWorkerName).not.toHaveBeenCalled();
    expect(searchTasksByProductCode).not.toHaveBeenCalled();
    expect(searchTasksByPhone).not.toHaveBeenCalled();
  });
});

describe('5c+5d — router: searchBy=phone dispatches to searchTasksByPhone', () => {
  it('calls searchTasksByPhone with the query', async () => {
    searchTasksByPhone.mockResolvedValue([makeRow()]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'phone', query: '054' } }));
    await handleAIMessage(admin, 'חפש לפי טלפון 054');
    expect(searchTasksByPhone).toHaveBeenCalledWith('054');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_pick_task', mgrSearchKind: 'phone' });
  });

  it('returns no-results message when phone search returns empty', async () => {
    searchTasksByPhone.mockResolvedValue([]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'phone', query: '0509999999' } }));
    await handleAIMessage(admin, 'חפש לפי טלפון 0509999999');
    expect(lastMsg()).toContain('לא נמצאו תוצאות');
  });
});

describe('5c+5d — router: searchBy=task_id dispatches to searchTasksByTaskId', () => {
  it('calls searchTasksByTaskId with the query', async () => {
    searchTasksByTaskId.mockResolvedValue([makeRow({ taskFieldId: '123' })]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'task_id', query: '12345' } }));
    await handleAIMessage(admin, 'מספר בדיקה 12345');
    expect(searchTasksByTaskId).toHaveBeenCalledWith('12345');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_pick_task', mgrSearchKind: 'task_id' });
  });

  it('returns no-results when task_id search is empty (bad input)', async () => {
    searchTasksByTaskId.mockResolvedValue([]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'task_id', query: 'not-a-valid-id' } }));
    await handleAIMessage(admin, 'מספר בדיקה not-a-valid-id');
    expect(lastMsg()).toContain('לא נמצאו תוצאות');
    expect(ctxStore).toBeNull();
  });
});

describe('5c+5d — router: searchBy=field_status dispatches to searchTasksByFieldStatus', () => {
  it('calls searchTasksByFieldStatus with raw enum value', async () => {
    searchTasksByFieldStatus.mockResolvedValue([makeRow({ fieldStatus: 'ASSIGNED' })]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'field_status', query: 'ASSIGNED' } }));
    await handleAIMessage(admin, 'בדיקות בסטטוס ASSIGNED');
    expect(searchTasksByFieldStatus).toHaveBeenCalledWith('ASSIGNED');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_pick_task', mgrSearchKind: 'field_status' });
  });

  it('Hebrew synonym "פתוח" maps to "ASSIGNED" before calling searchTasksByFieldStatus', async () => {
    searchTasksByFieldStatus.mockResolvedValue([makeRow()]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'field_status', query: 'פתוח' } }));
    await handleAIMessage(admin, 'בדיקות בסטטוס פתוח');
    expect(searchTasksByFieldStatus).toHaveBeenCalledWith('ASSIGNED');
  });

  it('Hebrew synonym "בדרך" maps to "EN_ROUTE"', async () => {
    searchTasksByFieldStatus.mockResolvedValue([makeRow({ fieldStatus: 'EN_ROUTE' })]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'field_status', query: 'בדרך' } }));
    await handleAIMessage(admin, 'בדיקות בדרך');
    expect(searchTasksByFieldStatus).toHaveBeenCalledWith('EN_ROUTE');
  });

  it('Hebrew synonym "ממתין למידע" maps to "WAITING_FOR_INFO"', async () => {
    searchTasksByFieldStatus.mockResolvedValue([makeRow({ fieldStatus: 'WAITING_FOR_INFO' })]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'field_status', query: 'ממתין למידע' } }));
    await handleAIMessage(admin, 'בדיקות שממתינות למידע');
    expect(searchTasksByFieldStatus).toHaveBeenCalledWith('WAITING_FOR_INFO');
  });

  it('Hebrew synonym "בעיה" maps to "HAS_PROBLEM"', async () => {
    searchTasksByFieldStatus.mockResolvedValue([makeRow({ fieldStatus: 'HAS_PROBLEM' })]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'field_status', query: 'בעיה' } }));
    await handleAIMessage(admin, 'בדיקות עם בעיה');
    expect(searchTasksByFieldStatus).toHaveBeenCalledWith('HAS_PROBLEM');
  });

  it('unknown Hebrew query falls through as-is (no crash)', async () => {
    searchTasksByFieldStatus.mockResolvedValue([]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'field_status', query: 'CUSTOM_STATUS' } }));
    await handleAIMessage(admin, 'סטטוס לא מוכר');
    expect(searchTasksByFieldStatus).toHaveBeenCalledWith('CUSTOM_STATUS');
    expect(lastMsg()).toContain('לא נמצאו תוצאות');
  });
});

// ── 5c: Existing search dimensions still work (no regression) ────────────────

describe('5c — no regression: existing searchBy dimensions still work', () => {
  it('searchBy=worker still dispatches to searchTasksByWorkerName', async () => {
    searchTasksByWorkerName.mockResolvedValue([makeRow({ workerName: 'יוסי' })]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'worker', query: 'יוסי' } }));
    await handleAIMessage(admin, 'בדיקות של יוסי');
    expect(searchTasksByWorkerName).toHaveBeenCalledWith('יוסי');
    expect(searchTasksByAddress).not.toHaveBeenCalled();
  });

  it('searchBy=product still dispatches to searchTasksByProductCode', async () => {
    searchTasksByProductCode.mockResolvedValue([makeRow()]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'product', query: '10156' } }));
    await handleAIMessage(admin, 'בדיקות מק"ט 10156');
    expect(searchTasksByProductCode).toHaveBeenCalledWith('10156');
    expect(searchTasksByFieldStatus).not.toHaveBeenCalled();
  });
});

// ── 5c: count_only=true returns numeric message + does NOT set picker context ─

describe('5c — count_only: list_today_field_inspections', () => {
  it('count_only=true returns "יש X בדיקות שטח היום" and skips picker context', async () => {
    getTodayFieldInspections.mockResolvedValue([makeRow(), makeRow({ taskFieldId: 'tf2' }), makeRow({ taskFieldId: 'tf3' })]);
    mockParseIntent(makeIntent('list_today_field_inspections', { params: { count_only: true } }));
    await handleAIMessage(admin, 'כמה בדיקות היום');
    expect(lastMsg()).toMatch(/יש 3 בדיקות שטח היום/);
    // context must not be set to mgr_today_pick_task
    expect(ctxStore).toBeNull();
  });

  it('count_only=false (default) still sets picker context', async () => {
    getTodayFieldInspections.mockResolvedValue([makeRow()]);
    mockParseIntent(makeIntent('list_today_field_inspections', { params: {} }));
    await handleAIMessage(admin, 'בדיקות שטח היום');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_today_pick_task' });
  });
});

describe('5c — count_only: list_open_exceptions', () => {
  it('count_only=true returns "יש X חריגים פתוחים" and skips picker context', async () => {
    getFieldExceptionRows.mockResolvedValue([
      { taskFieldId: 'tf1', taskId: 't1', workerName: 'דני', customerName: 'לקוח', siteCity: 'ת"א', fieldStatus: 'HAS_PROBLEM', description: null },
      { taskFieldId: 'tf2', taskId: 't2', workerName: 'יוסי', customerName: 'לקוח ב', siteCity: 'רמת גן', fieldStatus: 'WAITING_FOR_INFO', description: null },
    ]);
    mockParseIntent(makeIntent('list_open_exceptions', { params: { filter: 'open', count_only: true } }));
    await handleAIMessage(admin, 'כמה חריגים');
    expect(lastMsg()).toMatch(/יש 2 חריגים פתוחים/);
    expect(ctxStore).toBeNull();
  });

  it('count_only=false still sets picker context', async () => {
    getFieldExceptionRows.mockResolvedValue([
      { taskFieldId: 'tf1', taskId: 't1', workerName: 'דני', customerName: 'לקוח', siteCity: 'ת"א', fieldStatus: 'HAS_PROBLEM', description: null },
    ]);
    mockParseIntent(makeIntent('list_open_exceptions', { params: { filter: 'open' } }));
    await handleAIMessage(admin, 'תציג את החריגים');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_exceptions_pick_row' });
  });
});

describe('5c — count_only: list_pending_leads', () => {
  it('count_only=true (unassigned) returns "יש X לידים לא משויכים" and skips picker context', async () => {
    const { findUnassignedLeadsForAssignment } = await import('../services/incomingLeads');
    (findUnassignedLeadsForAssignment as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'l1', fromName: 'אבי', subject: 'ליד', body: null, fromEmail: null, receivedAt: new Date(), status: null, ownerId: null, taskId: null },
      { id: 'l2', fromName: 'רון', subject: 'ליד', body: null, fromEmail: null, receivedAt: new Date(), status: null, ownerId: null, taskId: null },
      { id: 'l3', fromName: 'גל', subject: 'ליד', body: null, fromEmail: null, receivedAt: new Date(), status: null, ownerId: null, taskId: null },
      { id: 'l4', fromName: 'מי', subject: 'ליד', body: null, fromEmail: null, receivedAt: new Date(), status: null, ownerId: null, taskId: null },
      { id: 'l5', fromName: 'דן', subject: 'ליד', body: null, fromEmail: null, receivedAt: new Date(), status: null, ownerId: null, taskId: null },
    ]);
    mockParseIntent(makeIntent('list_pending_leads', { params: { filter: 'unassigned', count_only: true } }));
    await handleAIMessage(admin, 'כמה לידים לא שויכו');
    expect(lastMsg()).toMatch(/יש 5 לידים לא משויכים/);
    expect(ctxStore).toBeNull();
  });

  it('count_only=false still sets picker context', async () => {
    const { findUnassignedLeadsForAssignment } = await import('../services/incomingLeads');
    (findUnassignedLeadsForAssignment as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'l1', fromName: 'אבי', subject: 'ליד', body: null, fromEmail: null, receivedAt: new Date(), status: null, ownerId: null, taskId: null },
    ]);
    mockParseIntent(makeIntent('list_pending_leads', { params: { filter: 'unassigned' } }));
    await handleAIMessage(admin, 'לידים ממתינים');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_leads_pick_row' });
  });
});

describe('5c — count_only: workers_day_overview', () => {
  it('count_only=true returns "יש X עובדים בשטח" with workers who have tasks>0', async () => {
    getAllWorkersDayOverview.mockResolvedValue([
      { workerId: 'w1', workerName: 'דני', finished: 3, total: 4, exceptions: 0 },
      { workerId: 'w2', workerName: 'יוסי', finished: 0, total: 2, exceptions: 0 },
      { workerId: 'w3', workerName: 'גיא', finished: 0, total: 0, exceptions: 0 }, // no tasks today
    ]);
    mockParseIntent(makeIntent('workers_day_overview', { params: { count_only: true } }));
    await handleAIMessage(admin, 'כמה עובדים בשטח היום');
    // w3 has total=0, so active count is 2
    expect(lastMsg()).toMatch(/יש 2 עובדים בשטח/);
    expect(ctxStore).toBeNull();
  });

  it('count_only=false still shows the full workers table', async () => {
    getAllWorkersDayOverview.mockResolvedValue([
      { workerId: 'w1', workerName: 'דני', finished: 2, total: 3, exceptions: 0 },
    ]);
    mockParseIntent(makeIntent('workers_day_overview', { params: {} }));
    await handleAIMessage(admin, 'סיכום עובדים');
    expect(lastMsg()).toContain('דני: 2/3');
    // No picker context for all-workers view (it's a one-shot)
  });
});

// ── Permission gate for new search dimensions ─────────────────────────────────

describe('5c — permission: non-manager blocked for new search dimensions', () => {
  it('rejects worker for searchBy=address with "אין הרשאה"', async () => {
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'address', query: 'הרצל' } }));
    await handleAIMessage(worker, 'חפש לפי כתובת הרצל');
    expect(lastMsg()).toContain('אין הרשאה');
    expect(searchTasksByAddress).not.toHaveBeenCalled();
  });

  it('rejects worker for searchBy=field_status with "אין הרשאה"', async () => {
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'field_status', query: 'ASSIGNED' } }));
    await handleAIMessage(worker, 'בדיקות פתוחות');
    expect(lastMsg()).toContain('אין הרשאה');
    expect(searchTasksByFieldStatus).not.toHaveBeenCalled();
  });
});

// ── searchBy=task_id: invalid input returns empty gracefully ──────────────────

describe('5d — service robustness: searchTasksByTaskId bad input', () => {
  it('non-uuid, non-numeric query causes searchTasksByTaskId to return empty (service returns [])', async () => {
    // The service itself handles bad input gracefully — returns [] instead of throwing.
    // Here we simulate that behavior via the mock and confirm the router handles it.
    searchTasksByTaskId.mockResolvedValue([]);
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'task_id', query: 'not-a-uuid-not-numeric' } }));
    await handleAIMessage(admin, 'מספר בדיקה not-a-uuid-not-numeric');
    expect(lastMsg()).toContain('לא נמצאו תוצאות');
    // No picker context set.
    expect(ctxStore).toBeNull();
  });
});

// ── searchBy prompt: "searchBy only, no query" shows correct prompt ───────────

describe('5c — router: searchBy only (no query) prompts correctly', () => {
  it('searchBy=address without query prompts for address', async () => {
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'address' } }));
    await handleAIMessage(admin, 'חפש לפי כתובת');
    expect(lastMsg()).toContain('כתובת');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_await_query', mgrSearchKind: 'address' });
  });

  it('searchBy=phone without query prompts for phone', async () => {
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'phone' } }));
    await handleAIMessage(admin, 'חפש לפי טלפון');
    expect(lastMsg()).toContain('טלפון');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_await_query', mgrSearchKind: 'phone' });
  });

  it('searchBy=task_id without query prompts for task id', async () => {
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'task_id' } }));
    await handleAIMessage(admin, 'חפש לפי מספר בדיקה');
    expect(lastMsg()).toContain('מזהה');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_await_query', mgrSearchKind: 'task_id' });
  });

  it('searchBy=field_status without query prompts for status', async () => {
    mockParseIntent(makeIntent('search_task', { params: { searchBy: 'field_status' } }));
    await handleAIMessage(admin, 'חפש לפי סטטוס');
    expect(lastMsg()).toContain('סטטוס');
    expect(ctxStore).toMatchObject({ awaiting: 'mgr_search_await_query', mgrSearchKind: 'field_status' });
  });
});
