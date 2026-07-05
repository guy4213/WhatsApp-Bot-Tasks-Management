/**
 * managerRichness.test.ts — Phase 6 manager richness + polish coverage.
 *
 * Verifies:
 *  - Voice colloquialisms + confirmation prefixes route through the LLM intent
 *    parser and dispatch correctly (mocked LLM).
 *  - Exceptions filter synonyms map through params.filter.
 *  - Owner-scoped leads phrasing ("לידים שלי" / "לידים של סשה") returns a
 *    clarification and still runs the unassigned-leads path.
 *  - assign_lead with BOTH `leadRef` and `assigneeName` pre-populates and
 *    lands on `assign_lead_confirm` state (single confirm step).
 *  - assign_lead with only `assigneeName` falls through to the normal
 *    multi-step flow.
 *  - Digit + polite word "2 בבקשה" from a manager opens menu + dispatches 2.
 *  - Confirmation + digit "כן 2" from a worker opens worker menu + dispatches 2.
 *  - "יאללה תפריט" matches MENU_TRIGGER_RE (menu.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

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

const parseIntentMock = vi.fn();
vi.mock('../ai/intentParser', () => ({
  parseIntent: (...a: unknown[]) => parseIntentMock(...a),
  buildSystemPrompt: vi.fn().mockReturnValue(''),
}));

vi.mock('../ai/provider', () => ({
  getProvider: () => ({ name: 'test' }),
}));

let ctxStore: Record<string, unknown> | null = null;
const setContext = vi.fn(async (_phone: string, state: unknown) => { ctxStore = state as Record<string, unknown>; });
const getContext = vi.fn(async () => ctxStore);
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

const findUnassignedLeadsForAssignment = vi.fn();
const findActiveInspectors = vi.fn();
vi.mock('../services/incomingLeads', () => ({
  findUnassignedLeadsForAssignment: (...a: unknown[]) => findUnassignedLeadsForAssignment(...a),
  findActiveInspectors: (...a: unknown[]) => findActiveInspectors(...a),
  assignLead: vi.fn().mockResolvedValue(undefined),
  findUnassignedInWindow: vi.fn().mockResolvedValue([]),
  findOvernightUnassignedLeads: vi.fn().mockResolvedValue([]),
  findNewlyAssignedLeads: vi.fn().mockResolvedValue([]),
  findEscalationCandidates: vi.fn().mockResolvedValue([]),
  getYoramLeadCounts: vi.fn().mockResolvedValue({ overnight: 0, unassigned: 0 }),
}));

const getFieldExceptionRows = vi.fn().mockResolvedValue([]);
const getManagementSnapshot = vi.fn().mockResolvedValue({
  today: { total: 0, finished: 0, inProgress: 0, pending: 0 },
  openExceptions: 0,
  leads: { totalOpen: 0, overnight: 0, escalated: 0 },
});
vi.mock('../services/managerViews', () => ({
  getManagementSnapshot: (...a: unknown[]) => getManagementSnapshot(...a),
  getTodayFieldInspections: vi.fn().mockResolvedValue([]),
  getFieldExceptionRows: (...a: unknown[]) => getFieldExceptionRows(...a),
  getAllWorkersDayOverview: vi.fn().mockResolvedValue([]),
  getWorkerDayDetail: vi.fn().mockResolvedValue(null),
  searchTasksByWorkerName: vi.fn().mockResolvedValue([]),
  searchTasksByProductCode: vi.fn().mockResolvedValue([]),
  searchTasksByAddress: vi.fn().mockResolvedValue([]),
  searchTasksByPhone: vi.fn().mockResolvedValue([]),
  searchTasksByTaskId: vi.fn().mockResolvedValue([]),
  searchTasksByFieldStatus: vi.fn().mockResolvedValue([]),
  getTaskFieldDetail: vi.fn().mockResolvedValue(null),
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

vi.mock('../ai/taskResolver', () => ({
  resolveTask: vi.fn().mockResolvedValue({ match: null, ambiguous: false, candidates: [] }),
}));

vi.mock('../whatsapp/digestContent', () => ({
  formatDayFieldSummary: vi.fn().mockReturnValue('סיכום יום'),
  formatManagerEndOfDay: vi.fn().mockReturnValue({ text: 'eod' }),
  formatEmployeeEndOfDay: vi.fn().mockReturnValue({ text: 'eod' }),
  formatInspectorDayList: vi.fn().mockReturnValue('אין בדיקות משובצות למחר.'),
  formatInspectorMorning: vi.fn().mockReturnValue('בוקר טוב'),
  formatEquipmentReminder: vi.fn().mockReturnValue({ text: 'ציוד' }),
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
  getFieldSummaryForWorkerOnDate: vi.fn().mockResolvedValue({ items: [], missingInfoCount: 0 }),
}));

vi.mock('../services/myInspectionsRange', () => ({
  getMyInspectionsInRange: vi.fn().mockResolvedValue([]),
  getAllMyInspections: vi.fn().mockResolvedValue([]),
}));

// Sasha is in the leads-viewer set (services/specialUsers.ts).
// The manager we mock in this suite reuses that name so isLeadsViewer returns true.

// ── Import after mocks ────────────────────────────────────────────────────────

import { handleAIMessage } from '../ai/router';
import { MENU_TRIGGER_RE } from '../ai/menu';
import type { ResolvedUser } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAdmin(): ResolvedUser {
  return {
    id: 'u-admin', name: 'מנהל', phone: '97250000001', role: 'ADMIN',
    isElevated: true, canViewAllRecords: true, canManageUsers: true, canManagePermissions: true,
  };
}

/** Sasha is in the leads-viewer allow-list — used for assign_lead scenarios. */
function makeSasha(): ResolvedUser {
  return {
    id: 'u-sasha', name: 'סשה', phone: '97250000005', role: 'ADMIN',
    isElevated: true, canViewAllRecords: true, canManageUsers: true, canManagePermissions: true,
  };
}

function makeWorker(): ResolvedUser {
  return {
    id: 'u-worker', name: 'אופק', phone: '97250000009', role: 'TECHNICIAN',
    isElevated: false, canViewAllRecords: false, canManageUsers: false, canManagePermissions: false,
  };
}

beforeEach(() => {
  sendTextMessage.mockClear();
  sendListMessage.mockClear();
  msgLog.length = 0;
  parseIntentMock.mockReset();
  setContext.mockClear();
  clearContext.mockClear();
  getContext.mockClear();
  ctxStore = null;
  findUnassignedLeadsForAssignment.mockReset().mockResolvedValue([]);
  findActiveInspectors.mockReset().mockResolvedValue([]);
  getFieldExceptionRows.mockReset().mockResolvedValue([]);
  getManagementSnapshot.mockReset().mockResolvedValue({
    today: { total: 0, finished: 0, inProgress: 0, pending: 0 },
    openExceptions: 0,
    leads: { totalOpen: 0, overnight: 0, escalated: 0 },
  });
});

afterEach(() => { vi.restoreAllMocks(); });

// ── 6a: Voice colloquialisms + confirmation prefixes ─────────────────────────

describe('Phase 6a — voice colloquialisms', () => {
  it('routes "אה, תראה מה קורה" → management_snapshot when LLM emits it', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'management_snapshot', confidence: 0.9,
      task_reference: null, field: null, new_value: null,
      params: {}, missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeAdmin(), 'אה, תראה מה קורה');
    expect(getManagementSnapshot).toHaveBeenCalled();
  });

  it('routes "כן, תראה חריגים" → list_open_exceptions filter=open', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'list_open_exceptions', confidence: 0.9,
      task_reference: null, field: null, new_value: null,
      params: { filter: 'open' }, missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeAdmin(), 'כן, תראה חריגים');
    expect(getFieldExceptionRows).toHaveBeenCalled();
  });
});

// ── 6a: Exceptions filter synonyms ───────────────────────────────────────────

describe('Phase 6a — exceptions filter synonyms', () => {
  const cases = [
    { phrase: 'בעיות שטח',      filter: 'has_problem' },
    { phrase: 'בעייתיים',        filter: 'has_problem' },
    { phrase: 'המתינות לאישור', filter: 'not_confirmed' },
    { phrase: 'חסרות מידע',     filter: 'waiting_for_info' },
    { phrase: 'עדיין לא סגרו',  filter: 'not_closed' },
  ];
  it.each(cases)('LLM synonym "$phrase" → list_open_exceptions filter=$filter', async ({ phrase, filter }) => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'list_open_exceptions', confidence: 0.9,
      task_reference: null, field: null, new_value: null,
      params: { filter }, missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeAdmin(), phrase);
    expect(getFieldExceptionRows).toHaveBeenCalledWith(
      expect.any(String),
      filter,
      undefined,
    );
  });
});

// ── 6b: Structured assign_lead pre-population ────────────────────────────────

describe('Phase 6b — structured assign_lead pre-population', () => {
  it('leadRef + assigneeName that both resolve unambiguously → jumps to assign_lead_confirm', async () => {
    getContext.mockResolvedValue(null);
    findUnassignedLeadsForAssignment.mockResolvedValue([
      { id: 'lead-1', fromName: 'יוסי', subject: null, receivedAt: null, fromEmail: null },
      { id: 'lead-2', fromName: 'אבנר', subject: null, receivedAt: null, fromEmail: null },
    ]);
    findActiveInspectors.mockResolvedValue([
      { id: 'w-1', name: 'לירן', role: 'TECHNICIAN' },
      { id: 'w-2', name: 'רון',  role: 'TECHNICIAN' },
    ]);
    parseIntentMock.mockResolvedValue({
      intent: 'assign_lead', confidence: 0.9,
      task_reference: null, field: null, new_value: null,
      params: { leadRef: 'יוסי', assigneeName: 'לירן' },
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });

    await handleAIMessage(makeSasha(), 'לשייך את הליד של יוסי ללירן');

    // State jumped straight to confirm.
    const confirmCall = setContext.mock.calls.find((c) => {
      const s = c[1] as { awaiting?: string };
      return s.awaiting === 'assign_lead_confirm';
    });
    expect(confirmCall).toBeTruthy();
    const state = confirmCall![1] as {
      awaiting: string;
      assignLeadSelectedLeadId?: string;
      assignLeadSelectedWorkerId?: string;
      assignLeadSelectedLeadName?: string;
      assignLeadSelectedWorkerName?: string;
    };
    expect(state.assignLeadSelectedLeadId).toBe('lead-1');
    expect(state.assignLeadSelectedWorkerId).toBe('w-1');
    expect(state.assignLeadSelectedLeadName).toBe('יוסי');
    expect(state.assignLeadSelectedWorkerName).toBe('לירן');

    // Confirmation message present.
    expect(msgLog.join('\n')).toMatch(/לשייך את הליד של יוסי לעובד לירן\?/);
  });

  it('assigneeName alone (no leadRef) → falls back to normal multi-step flow', async () => {
    getContext.mockResolvedValue(null);
    findUnassignedLeadsForAssignment.mockResolvedValue([
      { id: 'lead-1', fromName: 'יוסי', subject: null, receivedAt: null, fromEmail: null },
    ]);
    findActiveInspectors.mockResolvedValue([
      { id: 'w-1', name: 'לירן', role: 'TECHNICIAN' },
    ]);
    parseIntentMock.mockResolvedValue({
      intent: 'assign_lead', confidence: 0.9,
      task_reference: null, field: null, new_value: null,
      params: { assigneeName: 'לירן' },
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });

    await handleAIMessage(makeSasha(), 'להקצות ליד לירן');

    // Normal flow lands on assign_lead_pick_lead (NOT confirm).
    const pickLeadCall = setContext.mock.calls.find((c) => {
      const s = c[1] as { awaiting?: string };
      return s.awaiting === 'assign_lead_pick_lead';
    });
    expect(pickLeadCall).toBeTruthy();
  });

  it('ambiguous leadRef (matches 2 leads) → falls back to normal multi-step flow', async () => {
    getContext.mockResolvedValue(null);
    findUnassignedLeadsForAssignment.mockResolvedValue([
      { id: 'lead-1', fromName: 'יוסי כהן', subject: null, receivedAt: null, fromEmail: null },
      { id: 'lead-2', fromName: 'יוסי לוי',  subject: null, receivedAt: null, fromEmail: null },
    ]);
    findActiveInspectors.mockResolvedValue([
      { id: 'w-1', name: 'לירן', role: 'TECHNICIAN' },
    ]);
    parseIntentMock.mockResolvedValue({
      intent: 'assign_lead', confidence: 0.9,
      task_reference: null, field: null, new_value: null,
      params: { leadRef: 'יוסי', assigneeName: 'לירן' },
      missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });

    await handleAIMessage(makeSasha(), 'לשייך את הליד של יוסי ללירן');

    const pickLeadCall = setContext.mock.calls.find((c) => {
      const s = c[1] as { awaiting?: string };
      return s.awaiting === 'assign_lead_pick_lead';
    });
    expect(pickLeadCall).toBeTruthy();
    // Never landed on confirm.
    const confirmCall = setContext.mock.calls.find((c) => {
      const s = c[1] as { awaiting?: string };
      return s.awaiting === 'assign_lead_confirm';
    });
    expect(confirmCall).toBeFalsy();
  });
});

// ── 6c: Guard expansion for digit + polite word / confirmation + digit ───────

describe('Phase 6c — guard expansion for "digit + word" inputs', () => {
  it('"2 בבקשה" from manager opens menu + dispatches item 2 (no AI parser)', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeAdmin(), '2 בבקשה');
    expect(parseIntentMock).not.toHaveBeenCalled();
    // First message = menu, later = item 2 dispatch.
    expect(msgLog[0]).toContain('שלום, מה תרצה לעשות?');
  });

  it('"כן 2" from manager opens menu + dispatches item 2', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeAdmin(), 'כן 2');
    expect(parseIntentMock).not.toHaveBeenCalled();
    expect(msgLog[0]).toContain('שלום, מה תרצה לעשות?');
  });

  it('"אוקי 3" from manager → item 3 (חריגים)', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeAdmin(), 'אוקי 3');
    expect(parseIntentMock).not.toHaveBeenCalled();
    expect(msgLog[0]).toContain('שלום, מה תרצה לעשות?');
    expect(msgLog.some((m) => /חריגים ודיווחים/.test(m))).toBe(true);
  });

  it('"2 בבקשה" from worker opens worker menu + dispatches item 2', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeWorker(), '2 בבקשה');
    expect(parseIntentMock).not.toHaveBeenCalled();
    expect(msgLog.some((m) => /אין בדיקות משובצות/.test(m))).toBe(true);
  });

  it('"כן 2" from worker opens worker menu + dispatches item 2', async () => {
    getContext.mockResolvedValue(null);
    await handleAIMessage(makeWorker(), 'כן 2');
    expect(parseIntentMock).not.toHaveBeenCalled();
    expect(msgLog.some((m) => /אין בדיקות משובצות/.test(m))).toBe(true);
  });

  it('"תודה 5" (non-guard pattern) falls through to AI parser', async () => {
    // "תודה" is NOT in the confirmation prefix list (deliberate — "תודה" alone is
    // a closing word, not a "yes → do this" prefix). Should hit AI.
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'unknown', confidence: 0.1, task_reference: null, field: null,
      new_value: null, params: {}, missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeAdmin(), 'תודה 5');
    expect(parseIntentMock).toHaveBeenCalled();
  });

  // D5-T19m — QA report TC-8.3 claimed "2 בבקשה" / "כן 2" / "אוקי 4" are NOT
  // intercepted live. The tests above only exercise the FRESH-message path
  // (getContext pinned to null via mockResolvedValue). The realistic live
  // scenario is a manager who is ALREADY looking at the menu — i.e. an
  // active `mgr_menu_root` context already stored — and then replies with a
  // polite/confirmation-prefixed digit. Restore the stateful ctxStore-backed
  // implementation (undoing the `mockResolvedValue(null)` pin from earlier
  // tests in this file) to reproduce that scenario faithfully.
  it('"2 בבקשה" from an ACTIVE mgr_menu_root context still dispatches item 2 (no AI parser)', async () => {
    getContext.mockImplementation(async () => ctxStore);
    ctxStore = { awaiting: 'mgr_menu_root' };
    await handleAIMessage(makeAdmin(), '2 בבקשה');
    expect(parseIntentMock).not.toHaveBeenCalled();
    expect(msgLog.some((m) => /בדיקות שטח להיום/.test(m))).toBe(true);
  });

  it('"אוקי 3" from an ACTIVE mgr_menu_root context still dispatches item 3', async () => {
    getContext.mockImplementation(async () => ctxStore);
    ctxStore = { awaiting: 'mgr_menu_root' };
    await handleAIMessage(makeAdmin(), 'אוקי 3');
    expect(parseIntentMock).not.toHaveBeenCalled();
    expect(msgLog.some((m) => /חריגים ודיווחים/.test(m))).toBe(true);
  });
});

// ── 6d: Owner-scoped leads phrasing (documented rejection) ────────────────────

describe('Phase 6d — owner-scoped leads clarification', () => {
  it('LLM emits "לידים שלי" with unassigned filter + clarification — clarification message reaches user', async () => {
    getContext.mockResolvedValue(null);
    parseIntentMock.mockResolvedValue({
      intent: 'list_pending_leads', confidence: 0.9,
      task_reference: null, field: null, new_value: null,
      params: { filter: 'unassigned' }, missing_fields: [],
      clarification: 'נכון לעכשיו אני מציג את כל הלידים הפתוחים. סינון לפי בעל טיפול טרם נתמך.',
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });
    await handleAIMessage(makeAdmin(), 'לידים שלי');
    // The clarification wording surfaces (attached to the list rendering or as
    // a mid-confidence pre-confirm prompt).
    expect(msgLog.some((m) => /סינון לפי בעל טיפול טרם נתמך/.test(m))).toBe(true);
  });
});

// ── 6f: MENU_TRIGGER_RE parity check ─────────────────────────────────────────

describe('Phase 6f — MENU_TRIGGER_RE catches "יאללה תפריט"', () => {
  const shouldMatch = [
    'תפריט',
    'תפריט בבקשה',
    'בבקשה תפריט',
    'יאללה תפריט',
    'תראה לי את התפריט',
    'הצג לי את התפריט',
    'אני רוצה לראות תפריט',
  ];
  it.each(shouldMatch)('matches "%s"', (phrase) => {
    expect(MENU_TRIGGER_RE.test(phrase)).toBe(true);
  });

  const shouldNotMatch = [
    'מה יש בתפריט של המערכת?',
    'תפריט של הבוקר',
    'איך תפריט עובד',
  ];
  it.each(shouldNotMatch)('does NOT match "%s"', (phrase) => {
    expect(MENU_TRIGGER_RE.test(phrase)).toBe(false);
  });
});
