/**
 * Router-level tests for the leads display flow (D3-T6 display enhancement).
 *
 * Covers:
 *  - Menu item 1 (unassigned leads) → sends labeled list + sets mgr_leads_pick_row context
 *  - Menu item 1 empty state → unchanged "אין לידים לא משויכים" branch fires
 *  - Menu item 2 (escalation) → header says "לידים שעברו שעה ללא שיוך"
 *  - Picking a lead by number → getLeadById called → detail message sent
 *  - Invalid number → re-prompt, state preserved
 *  - "חזרה" → showMgrLeadsSub called, no detail fetch
 *
 * Mocking approach: mirrors routerManagerMenu.test.ts.  We mock all the
 * modules the router imports at the top-level so the module can load cleanly
 * without a real DB connection.  enrichLead and getLeadById are mocked here so
 * we can control their output without touching the DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks must be declared before any import ──────────────────────────────────

// leadCategorizer mock (enrichLead)
const enrichLead = vi.fn();
vi.mock('../services/leadCategorizer', () => ({
  enrichLead: (...a: unknown[]) => enrichLead(...a),
  _resetCacheForTests: vi.fn(),
}));

// leadDisplay mock
const formatLeadListRowCompact = vi.fn();
const formatLeadDetailCompact = vi.fn();
vi.mock('../whatsapp/leadDisplay', () => ({
  formatLeadListRowCompact: (...a: unknown[]) => formatLeadListRowCompact(...a),
  formatLeadDetailCompact: (...a: unknown[]) => formatLeadDetailCompact(...a),
}));

// incomingLeads
const findUnassignedLeadsForAssignment = vi.fn();
const findEscalationCandidates = vi.fn();
const getLeadById = vi.fn();
vi.mock('../services/incomingLeads', () => ({
  findUnassignedLeadsForAssignment: (...a: unknown[]) => findUnassignedLeadsForAssignment(...a),
  findEscalationCandidates: (...a: unknown[]) => findEscalationCandidates(...a),
  getLeadById: (...a: unknown[]) => getLeadById(...a),
  findActiveInspectors: vi.fn().mockResolvedValue([]),
  assignLead: vi.fn().mockResolvedValue(undefined),
  findUnassignedInWindow: vi.fn().mockResolvedValue([]),
  findOvernightUnassignedLeads: vi.fn().mockResolvedValue([]),
  findNewlyAssignedLeads: vi.fn().mockResolvedValue([]),
  getYoramLeadCounts: vi.fn().mockResolvedValue({ overnight: 0, unassigned: 0 }),
}));

// managerViews
vi.mock('../services/managerViews', () => ({
  getManagementSnapshot: vi.fn().mockResolvedValue({}),
  getTodayFieldInspections: vi.fn().mockResolvedValue([]),
  getFieldExceptionRows: vi.fn().mockResolvedValue([]),
  getAllWorkersDayOverview: vi.fn().mockResolvedValue([]),
  getWorkerDayDetail: vi.fn().mockResolvedValue(null),
  searchTasksByWorkerName: vi.fn().mockResolvedValue([]),
  searchTasksByProductCode: vi.fn().mockResolvedValue([]),
  getTaskFieldDetail: vi.fn().mockResolvedValue(null),
  getTaskFieldValuesForContext: vi.fn().mockResolvedValue(null),
}));

// sender
const msgLog: string[] = [];
const sendTextMessage = vi.fn(async (arg: { to: string; text: string }) => { msgLog.push(arg.text); });
const sendListMessage = vi.fn(async () => undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: (arg: { to: string; text: string }) => sendTextMessage(arg),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
  sendListMessage: vi.fn().mockResolvedValue(undefined),
}));

// conversationContext
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

vi.mock('../ai/provider', () => ({
  getProvider: () => ({ name: 'test' }),
}));

vi.mock('../ai/intentParser', () => ({
  parseIntent: vi.fn().mockResolvedValue({
    intent: 'unknown', confidence: 0.1, task_reference: null, field: null,
    new_value: null, params: {}, missing_fields: [], clarification: null,
    requires_confirmation: false, requires_manager_approval: false,
    transition: null, problem_type: null,
  }),
  buildSystemPrompt: vi.fn().mockReturnValue(''),
}));

vi.mock('../utils/auditLog', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  updateTranscribedMessage: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../services/pendingActions', () => ({
  getManagersForBroadcast: vi.fn().mockResolvedValue([]),
  createPendingAction: vi.fn().mockResolvedValue({ id: 'pa1' }),
  updatePendingActionState: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../services/digestPreferences', () => ({
  getEffectiveDigestPreference: vi.fn().mockResolvedValue({ morningEnabled: true, morningTime: '09:00', eveningEnabled: true, eveningTime: '17:00' }),
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

vi.mock('../ai/taskResolver', () => ({
  resolveTask: vi.fn().mockResolvedValue({ match: null, ambiguous: false, candidates: [] }),
}));

vi.mock('../whatsapp/digestContent', () => ({
  formatDayFieldSummary: vi.fn().mockReturnValue(''),
  formatManagerEndOfDay: vi.fn().mockReturnValue({ text: '' }),
  formatEmployeeEndOfDay: vi.fn().mockReturnValue({ text: '' }),
  formatInspectorDayList: vi.fn().mockReturnValue(''),
}));

vi.mock('../ai/digestCommands', () => ({
  matchDigestCommand: vi.fn().mockReturnValue(null),
  planDigestCommand: vi.fn(),
  DIGEST_PAYLOAD_IDS: { FREE_TEXT: 'FREE_TEXT', EMP_TODAY: 'EMP_TODAY', EMP_EOD: 'EMP_EOD', TEAM_TODAY: 'TEAM_TODAY', TEAM_EOD: 'TEAM_EOD' },
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

vi.mock('../db/connection', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { handleAIMessage } from '../ai/router';
import type { ResolvedUser } from '../types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeManager(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-mgr',
    name: 'מנהל',
    phone: '972501000001',
    role: 'ADMIN',
    isElevated: true,
    canViewAllRecords: true,
    canManageUsers: true,
    canManagePermissions: true,
    ...overrides,
  };
}

const SAMPLE_LEAD_1 = {
  id: 'lead-id-1',
  subject: 'בדיקת קרינה',
  body: 'צריך בדיקה בת\"א',
  fromName: 'ישראל ישראלי',
  fromEmail: null,
  receivedAt: new Date('2026-07-01T09:00:00Z'),
  status: null,
  ownerId: null,
  taskId: null,
};

const SAMPLE_LEAD_2 = {
  id: 'lead-id-2',
  subject: 'בדיקת מים',
  body: 'בדיקת איכות מים',
  fromName: 'שרה כהן',
  fromEmail: null,
  receivedAt: new Date('2026-07-01T08:00:00Z'),
  status: null,
  ownerId: null,
  taskId: null,
};

const SAMPLE_ENRICHMENT = {
  category: 'radiation' as const,
  categoryHe: 'קרינה',
  inspectionType: null,
  location: 'תל אביב',
};

// ── beforeEach/afterEach ──────────────────────────────────────────────────────

beforeEach(() => {
  ctxStore = null;
  msgLog.length = 0;
  findUnassignedLeadsForAssignment.mockReset();
  findEscalationCandidates.mockReset();
  getLeadById.mockReset();
  enrichLead.mockReset();
  formatLeadListRowCompact.mockReset();
  formatLeadDetailCompact.mockReset();
  sendTextMessage.mockClear();
  sendListMessage.mockClear();
  setContext.mockClear();
  clearContext.mockClear();
  getContext.mockClear();

  // Defaults
  findUnassignedLeadsForAssignment.mockResolvedValue([]);
  findEscalationCandidates.mockResolvedValue([]);
  enrichLead.mockResolvedValue(SAMPLE_ENRICHMENT);
  formatLeadListRowCompact.mockImplementation(
    (lead: typeof SAMPLE_LEAD_1) => `שם: ${lead.fromName ?? 'לא צוין'}\nקטגוריית בדיקה: קרינה\nסוג בדיקה: לא זוהה בוודאות\nמיקום: תל אביב\nהתקבל: 12:00\nממתין: 30 דקות`,
  );
  formatLeadDetailCompact.mockReturnValue(
    'פרטי ליד\n\nשם: ישראל ישראלי\nאימייל: לא צוין\nקטגוריית בדיקה: קרינה\nסוג בדיקה: לא זוהה בוודאות\nמיקום: תל אביב\nהתקבל: 01/07/2026 12:00\nסטטוס: לא משויך\nממתין: 30 דקות\n\nתקציר הפנייה:\nצריך בדיקה בת"א\n\nמה תרצה לעשות?\n• כתוב "חזרה" — לחזור לרשימת הלידים\n• לשיוך — חזור לתפריט הלידים ובחר "שיוך ליד לעובד"',
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helper: enter leads sub-menu then pick a numbered item ────────────────────

async function pickLeadsSubMenuItem(user: ResolvedUser, itemNumber: number) {
  ctxStore = { awaiting: 'mgr_leads_sub' };
  await handleAIMessage(user, String(itemNumber));
}

async function pickLeadRow(user: ResolvedUser, itemNumber: number) {
  await handleAIMessage(user, String(itemNumber));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('leads sub-menu — item 1 (unassigned)', () => {
  it('sends a list header "לידים ממתינים לטיפול (2):" with two lead blocks', async () => {
    const user = makeManager();
    findUnassignedLeadsForAssignment.mockResolvedValueOnce([SAMPLE_LEAD_1, SAMPLE_LEAD_2]);

    await pickLeadsSubMenuItem(user, 1);

    // At least one sent message should contain the header.
    const allText = msgLog.join('\n');
    expect(allText).toContain('לידים ממתינים לטיפול (2):');
    // Both leads should appear (our mock returns the fromName in the row).
    expect(allText).toContain('ישראל ישראלי');
    expect(allText).toContain('שרה כהן');
  });

  it('sets mgrLeadIds and mgrLeadNames in context', async () => {
    const user = makeManager();
    findUnassignedLeadsForAssignment.mockResolvedValueOnce([SAMPLE_LEAD_1, SAMPLE_LEAD_2]);

    await pickLeadsSubMenuItem(user, 1);

    expect(ctxStore).toMatchObject({
      awaiting: 'mgr_leads_pick_row',
      mgrLeadIds: ['lead-id-1', 'lead-id-2'],
    });
  });

  it('calls formatLeadListRowCompact for each lead', async () => {
    const user = makeManager();
    findUnassignedLeadsForAssignment.mockResolvedValueOnce([SAMPLE_LEAD_1, SAMPLE_LEAD_2]);

    await pickLeadsSubMenuItem(user, 1);

    expect(formatLeadListRowCompact).toHaveBeenCalledTimes(2);
    expect(enrichLead).toHaveBeenCalledTimes(2);
  });
});

describe('leads sub-menu — item 1 empty state', () => {
  it('sends "אין לידים לא משויכים כרגע" and stays in mgr_leads_sub', async () => {
    const user = makeManager();
    findUnassignedLeadsForAssignment.mockResolvedValueOnce([]);

    await pickLeadsSubMenuItem(user, 1);

    const allText = msgLog.join('\n');
    expect(allText).toContain('אין לידים לא משויכים כרגע');
    // Context should be mgr_leads_sub (not mgr_leads_pick_row).
    expect(ctxStore?.awaiting).toBe('mgr_leads_sub');
    // The new formatter should NOT have been called.
    expect(formatLeadListRowCompact).not.toHaveBeenCalled();
  });
});

describe('leads sub-menu — item 2 (escalation)', () => {
  it('sends header "לידים שעברו שעה ללא שיוך" with lead blocks', async () => {
    const user = makeManager();
    findEscalationCandidates.mockResolvedValueOnce([SAMPLE_LEAD_1]);

    await pickLeadsSubMenuItem(user, 2);

    const allText = msgLog.join('\n');
    expect(allText).toContain('לידים שעברו שעה ללא שיוך');
    expect(allText).toContain('ישראל ישראלי');
  });

  it('sets context to mgr_leads_pick_row with correct lead ids', async () => {
    const user = makeManager();
    findEscalationCandidates.mockResolvedValueOnce([SAMPLE_LEAD_1]);

    await pickLeadsSubMenuItem(user, 2);

    expect(ctxStore).toMatchObject({
      awaiting: 'mgr_leads_pick_row',
      mgrLeadIds: ['lead-id-1'],
    });
  });
});

describe('leads pick-row — selecting a lead by number', () => {
  it('calls getLeadById with the correct lead id and sends detail', async () => {
    const user = makeManager();
    // Pre-seed the context as if we just showed the list.
    ctxStore = {
      awaiting: 'mgr_leads_pick_row',
      mgrLeadIds: ['lead-id-1', 'lead-id-2'],
      mgrLeadNames: ['ישראל ישראלי', 'שרה כהן'],
    };
    getLeadById.mockResolvedValueOnce(SAMPLE_LEAD_1);

    await pickLeadRow(user, 1);

    expect(getLeadById).toHaveBeenCalledWith('lead-id-1');
    expect(enrichLead).toHaveBeenCalledWith(SAMPLE_LEAD_1);
    expect(formatLeadDetailCompact).toHaveBeenCalled();
    const allText = msgLog.join('\n');
    expect(allText).toContain('פרטי ליד');
  });

  it('preserves mgrLeadIds/mgrLeadNames in context after showing detail', async () => {
    const user = makeManager();
    ctxStore = {
      awaiting: 'mgr_leads_pick_row',
      mgrLeadIds: ['lead-id-1', 'lead-id-2'],
      mgrLeadNames: ['ישראל ישראלי', 'שרה כהן'],
    };
    getLeadById.mockResolvedValueOnce(SAMPLE_LEAD_1);

    await pickLeadRow(user, 1);

    // State should be preserved so "חזרה" can still show the sub-menu.
    expect(ctxStore).toMatchObject({
      awaiting: 'mgr_leads_pick_row',
      mgrLeadIds: ['lead-id-1', 'lead-id-2'],
    });
  });
});

describe('leads pick-row — invalid number', () => {
  it('re-prompts and preserves state when number is out of range', async () => {
    const user = makeManager();
    ctxStore = {
      awaiting: 'mgr_leads_pick_row',
      mgrLeadIds: ['lead-id-1', 'lead-id-2'],
      mgrLeadNames: ['ישראל ישראלי', 'שרה כהן'],
    };

    await handleAIMessage(user, '99');

    expect(getLeadById).not.toHaveBeenCalled();
    const allText = msgLog.join('\n');
    expect(allText).toContain('אנא השב במספר בין 1 ל-2 או "חזרה"');
    // Context should remain mgr_leads_pick_row.
    expect(ctxStore?.awaiting).toBe('mgr_leads_pick_row');
  });
});

describe('leads pick-row — "חזרה"', () => {
  it('sends the leads sub-menu and does not call getLeadById', async () => {
    const user = makeManager();
    ctxStore = {
      awaiting: 'mgr_leads_pick_row',
      mgrLeadIds: ['lead-id-1'],
      mgrLeadNames: ['ישראל ישראלי'],
    };

    await handleAIMessage(user, 'חזרה');

    expect(getLeadById).not.toHaveBeenCalled();
    // After "חזרה", context changes to mgr_leads_sub.
    expect(ctxStore?.awaiting).toBe('mgr_leads_sub');
  });
});

describe('leads pick-row — lead not found', () => {
  it('clears context and sends "לא נמצא ליד" when getLeadById returns null', async () => {
    const user = makeManager();
    ctxStore = {
      awaiting: 'mgr_leads_pick_row',
      mgrLeadIds: ['lead-id-gone'],
      mgrLeadNames: ['נעלם'],
    };
    getLeadById.mockResolvedValueOnce(null);

    await handleAIMessage(user, '1');

    expect(ctxStore).toBeNull(); // context cleared
    const allText = msgLog.join('\n');
    expect(allText).toContain('לא נמצא ליד');
  });
});
