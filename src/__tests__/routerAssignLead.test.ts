/**
 * D3-T6 — router-level flow tests for the Sasha lead-assignment feature.
 *
 * Covers:
 *  - Auth rejection for non-leads-viewer users
 *  - Full happy path: trigger → pick lead → pick worker → confirm → assignLead
 *  - Cancellation from each state (ביטול)
 *  - "no unassigned leads" short-circuit
 *  - "no workers" short-circuit
 *  - Invalid numeric picks re-prompt without clearing state
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (declared before any import so vi.mock hoisting works) ──────────────

const findUnassignedLeadsForAssignment = vi.fn();
const findActiveInspectors = vi.fn();
const assignLead = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/incomingLeads', () => ({
  findUnassignedLeadsForAssignment: (...a: unknown[]) => findUnassignedLeadsForAssignment(...a),
  findActiveInspectors: (...a: unknown[]) => findActiveInspectors(...a),
  assignLead: (...a: unknown[]) => assignLead(...a),
  // Other functions used by the router but not by this flow.
  findUnassignedInWindow: vi.fn().mockResolvedValue([]),
  findOvernightUnassignedLeads: vi.fn().mockResolvedValue([]),
  findNewlyAssignedLeads: vi.fn().mockResolvedValue([]),
  findEscalationCandidates: vi.fn().mockResolvedValue([]),
  getYoramLeadCounts: vi.fn().mockResolvedValue({ overnight: 0, unassigned: 0 }),
}));

const suggestWorkerForLead = vi.fn();
vi.mock('../ai/leadSuggester', () => ({
  suggestWorkerForLead: (...a: unknown[]) => suggestWorkerForLead(...a),
}));

const sendTextMessage   = vi.fn().mockResolvedValue(undefined);
const sendButtonMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage:   (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: (...a: unknown[]) => sendButtonMessage(...a),
  sendListMessage:   vi.fn().mockResolvedValue(undefined),
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

// Chat history — no-op.
vi.mock('../services/chatHistory', () => ({
  appendTurn: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue([]),
}));

// AI provider — configured so router doesn't short-circuit on the initial parse.
vi.mock('../ai/provider', () => ({
  getProvider: () => ({ name: 'test' }),
}));

// parseIntent — defaults to assign_lead with high confidence when called.
// Declared as a controllable mock (not an inline `vi.fn().mockResolvedValue`)
// so UX-T1 tests can override it per-call via `parseIntent.mockResolvedValueOnce`
// — the smart-picker-escape scaffolding in router.ts calls this SAME parseIntent
// (via `boundParseIntentForEscape`) to classify free-text replies inside a
// numeric-picker state, so tests that exercise merge/pivot need per-test control.
function defaultAssignLeadIntent(overrides: Partial<{
  intent: string; confidence: number; params: Record<string, unknown>;
}> = {}) {
  return {
    intent: 'assign_lead',
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
    ...overrides,
  };
}
const parseIntent = vi.fn().mockResolvedValue(defaultAssignLeadIntent());
vi.mock('../ai/intentParser', () => ({
  parseIntent: (...a: unknown[]) => parseIntent(...(a as [string, unknown])),
  buildSystemPrompt: vi.fn().mockReturnValue(''),
}));

// Audit log — no-op.
vi.mock('../utils/auditLog', () => ({
  writeAuditLog: vi.fn().mockResolvedValue('audit-log-id'),
  updateTranscribedMessage: vi.fn().mockResolvedValue(undefined),
}));

// Other services the router imports (stub to avoid real DB).
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

import type { ResolvedUser } from '../types';

function makeLeadsViewer(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-sasha',
    name: 'סשה',
    phone: '972501111111',
    role: 'MANAGER',
    isElevated: true,
    canViewAllRecords: true,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

function makeWorker(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-worker',
    name: 'דני',
    phone: '972502222222',
    role: 'SALES',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

// D5-T19i: a MANAGER/ADMIN who is NOT one of the named leads viewers (Sasha
// + dev observers) — e.g. a plain manager named "רותם" who never appears in
// LEADS_VIEWER_NAMES. Previously always rejected; now allowed via isElevated.
function makeElevatedNonLeadsViewer(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-manager',
    name: 'רותם',
    phone: '972503333333',
    role: 'MANAGER',
    isElevated: true,
    canViewAllRecords: true,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

const SAMPLE_LEADS = [
  { id: 'lead-1', subject: 'בדיקת קרינה', fromName: 'ישראל ישראלי', fromEmail: null, body: null, receivedAt: new Date(), status: null, ownerId: null, taskId: null },
  { id: 'lead-2', subject: 'בדיקת מים', fromName: 'שרה כהן', fromEmail: null, body: null, receivedAt: new Date(), status: null, ownerId: null, taskId: null },
];

const SAMPLE_WORKERS = [
  { id: 'w-1', name: 'דני', role: 'TECHNICIAN' },
  { id: 'w-2', name: 'יוסי', role: 'WORKER' },
];

beforeEach(() => {
  ctxStore = null;
  findUnassignedLeadsForAssignment.mockReset();
  findActiveInspectors.mockReset();
  assignLead.mockReset(); assignLead.mockResolvedValue(undefined);
  suggestWorkerForLead.mockReset();
  suggestWorkerForLead.mockResolvedValue({ userId: null, reason: 'אין המלצה' });
  sendTextMessage.mockReset(); sendTextMessage.mockResolvedValue(undefined);
  sendButtonMessage.mockReset(); sendButtonMessage.mockResolvedValue(undefined);
  setContext.mockClear();
  clearContext.mockClear();
  parseIntent.mockReset();
  parseIntent.mockResolvedValue(defaultAssignLeadIntent());
});
afterEach(() => { vi.restoreAllMocks(); });

// ── Lazy-load the router so mocks are in place ────────────────────────────────

async function loadRouter() {
  return await import('../ai/router');
}

// ── Auth: non-leads-viewer is rejected ───────────────────────────────────────

describe('assign_lead — auth rejection for non-leads-viewer', () => {
  it('rejects a regular worker who is NOT a leads viewer and NOT elevated', async () => {
    const user = makeWorker();
    // Seed context with assign_lead intent so it routes to executeIntent.
    ctxStore = null;
    findUnassignedLeadsForAssignment.mockResolvedValueOnce(SAMPLE_LEADS);
    findActiveInspectors.mockResolvedValueOnce(SAMPLE_WORKERS);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'לשייך ליד');
    // Should send auth rejection (parseIntent mock returns assign_lead with high conf).
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('אין הרשאה'))).toBe(true);
    expect(assignLead).not.toHaveBeenCalled();
  });

  // D5-T19i regression: ADMIN/MANAGER must now be allowed even when they are
  // not one of the named leads-viewer special users.
  it('allows a MANAGER who is not a named leads viewer (D5-T19i)', async () => {
    const user = makeElevatedNonLeadsViewer();
    ctxStore = null;
    findUnassignedLeadsForAssignment.mockResolvedValueOnce(SAMPLE_LEADS);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'לשייך ליד');
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('אין הרשאה'))).toBe(false);
    expect(ctxStore).toMatchObject({ awaiting: 'assign_lead_pick_lead' });
  });

  it('allows an ADMIN who is not a named leads viewer (D5-T19i)', async () => {
    const user = makeElevatedNonLeadsViewer({ id: 'u-admin', name: 'אורלי', role: 'ADMIN' });
    ctxStore = null;
    findUnassignedLeadsForAssignment.mockResolvedValueOnce(SAMPLE_LEADS);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'לשייך ליד');
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('אין הרשאה'))).toBe(false);
    expect(ctxStore).toMatchObject({ awaiting: 'assign_lead_pick_lead' });
  });
});

// ── Happy path: full flow ─────────────────────────────────────────────────────

describe('assign_lead — happy path', () => {
  it('step 1: shows numbered lead list and enters assign_lead_pick_lead state', async () => {
    const user = makeLeadsViewer();
    findUnassignedLeadsForAssignment.mockResolvedValueOnce(SAMPLE_LEADS);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'לשייך ליד');

    // Should list leads.
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    const listMsg = texts.find((t) => t.includes('ישראל ישראלי'));
    expect(listMsg).toBeDefined();
    expect(listMsg).toContain('1.');
    expect(listMsg).toContain('שרה כהן');
    // State should be awaiting pick_lead.
    expect(ctxStore).toMatchObject({
      awaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1', 'lead-2'],
    });
    expect(assignLead).not.toHaveBeenCalled();
  });

  it('step 2: user picks lead, bot shows worker list with AI suggestion', async () => {
    const user = makeLeadsViewer();
    // Seed pick_lead context.
    ctxStore = {
      awaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1', 'lead-2'],
      assignLeadCandidateNames: ['ישראל ישראלי', 'שרה כהן'],
    };
    findActiveInspectors.mockResolvedValueOnce(SAMPLE_WORKERS);
    suggestWorkerForLead.mockResolvedValueOnce({ userId: 'w-1', reason: 'בדיקות קרינה' });

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    const workerMsg = texts.find((t) => t.includes('דני') && t.includes('יוסי'));
    expect(workerMsg).toBeDefined();
    // AI suggestion should be mentioned.
    expect(workerMsg).toContain('הצעת AI');
    expect(ctxStore).toMatchObject({
      awaiting: 'assign_lead_pick_worker',
      assignLeadSelectedLeadId: 'lead-1',
      assignLeadSelectedLeadName: 'ישראל ישראלי',
      assignLeadWorkerIds: ['w-1', 'w-2'],
    });
    expect(assignLead).not.toHaveBeenCalled();
  });

  it('step 3: user picks worker, bot shows confirmation prompt', async () => {
    const user = makeLeadsViewer();
    ctxStore = {
      awaiting: 'assign_lead_pick_worker',
      assignLeadSelectedLeadId: 'lead-1',
      assignLeadSelectedLeadName: 'ישראל ישראלי',
      assignLeadWorkerIds: ['w-1', 'w-2'],
      assignLeadWorkerNames: ['דני', 'יוסי'],
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    // Confirmation now sent via sendButtonMessage (Group A UX upgrade);
    // fall back to checking sendTextMessage for the body content.
    const btnCalls = sendButtonMessage.mock.calls.map((c) => c[0] as { body: string; buttons: unknown[] });
    const txtCalls = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    const confirmMsg =
      btnCalls.find((c) => c.body.includes('לשייך'))?.body ??
      txtCalls.find((t) => t.includes('לשייך') && t.includes('אישור'));
    expect(confirmMsg).toBeDefined();
    expect(confirmMsg).toContain('ישראל ישראלי');
    expect(confirmMsg).toContain('דני');
    expect(ctxStore).toMatchObject({
      awaiting: 'assign_lead_confirm',
      assignLeadSelectedLeadId: 'lead-1',
      assignLeadSelectedWorkerId: 'w-1',
      assignLeadSelectedWorkerName: 'דני',
    });
    expect(assignLead).not.toHaveBeenCalled();
  });

  it('step 4 confirm: calls assignLead and sends success message', async () => {
    const user = makeLeadsViewer();
    ctxStore = {
      awaiting: 'assign_lead_confirm',
      assignLeadSelectedLeadId: 'lead-1',
      assignLeadSelectedLeadName: 'ישראל ישראלי',
      assignLeadSelectedWorkerId: 'w-1',
      assignLeadSelectedWorkerName: 'דני',
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    expect(assignLead).toHaveBeenCalledWith('lead-1', 'w-1', user.id, user.phone);
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('שויך') && t.includes('דני'))).toBe(true);
    expect(ctxStore).toBeNull(); // context cleared
  });
});

// ── Cancellation from each state ─────────────────────────────────────────────

describe('assign_lead — cancellation', () => {
  it('cancel from assign_lead_pick_lead sends "בוטל" and clears context', async () => {
    const user = makeLeadsViewer();
    ctxStore = {
      awaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1'],
      assignLeadCandidateNames: ['ישראל ישראלי'],
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'ביטול');
    expect(assignLead).not.toHaveBeenCalled();
    expect(ctxStore).toBeNull();
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'בוטל.' });
  });

  it('cancel from assign_lead_pick_worker sends "בוטל" and clears context', async () => {
    const user = makeLeadsViewer();
    ctxStore = {
      awaiting: 'assign_lead_pick_worker',
      assignLeadSelectedLeadId: 'lead-1',
      assignLeadSelectedLeadName: 'ישראל ישראלי',
      assignLeadWorkerIds: ['w-1'],
      assignLeadWorkerNames: ['דני'],
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'ביטול');
    expect(assignLead).not.toHaveBeenCalled();
    expect(ctxStore).toBeNull();
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'בוטל.' });
  });

  it('choice "2" at confirm state cancels without calling assignLead', async () => {
    const user = makeLeadsViewer();
    ctxStore = {
      awaiting: 'assign_lead_confirm',
      assignLeadSelectedLeadId: 'lead-1',
      assignLeadSelectedLeadName: 'ישראל ישראלי',
      assignLeadSelectedWorkerId: 'w-1',
      assignLeadSelectedWorkerName: 'דני',
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '2');
    expect(assignLead).not.toHaveBeenCalled();
    expect(ctxStore).toBeNull();
    expect(sendTextMessage).toHaveBeenCalledWith({ to: user.phone, text: 'בוטל.' });
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('assign_lead — edge cases', () => {
  it('no unassigned leads → sends "אין כרגע לידים" and clears context', async () => {
    const user = makeLeadsViewer();
    findUnassignedLeadsForAssignment.mockResolvedValueOnce([]);
    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'לשייך ליד');
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('אין כרגע לידים'))).toBe(true);
    expect(ctxStore).toBeNull();
    expect(assignLead).not.toHaveBeenCalled();
  });

  it('no active workers → sends error and clears context', async () => {
    const user = makeLeadsViewer();
    ctxStore = {
      awaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1'],
      assignLeadCandidateNames: ['ישראל ישראלי'],
    };
    findActiveInspectors.mockResolvedValueOnce([]);
    suggestWorkerForLead.mockResolvedValueOnce({ userId: null, reason: '' });

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('לא נמצאו עובדים'))).toBe(true);
    expect(ctxStore).toBeNull();
    expect(assignLead).not.toHaveBeenCalled();
  });

  it('invalid number at pick_lead re-prompts without clearing state', async () => {
    const user = makeLeadsViewer();
    ctxStore = {
      awaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1', 'lead-2'],
      assignLeadCandidateNames: ['ישראל ישראלי', 'שרה כהן'],
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '99');
    expect(assignLead).not.toHaveBeenCalled();
    // State still set to pick_lead (not cleared).
    expect(ctxStore).toMatchObject({ awaiting: 'assign_lead_pick_lead' });
  });

  it('invalid number at pick_worker re-prompts without clearing state', async () => {
    const user = makeLeadsViewer();
    ctxStore = {
      awaiting: 'assign_lead_pick_worker',
      assignLeadSelectedLeadId: 'lead-1',
      assignLeadSelectedLeadName: 'ישראל ישראלי',
      assignLeadWorkerIds: ['w-1'],
      assignLeadWorkerNames: ['דני'],
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '99');
    expect(assignLead).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({ awaiting: 'assign_lead_pick_worker' });
  });

  // UX-T1 UPDATE: this test previously asserted the OLD blunt escape hatch
  // (clearContext + handleAIMessage on ANY free text at a numeric-picker
  // state), which wiped the in-progress lead/worker selection and restarted
  // the whole assign_lead flow from scratch. The smart-picker escape
  // (classifySmartPickerEscape + mergeAssignLead) now recognizes that the
  // free-text reply parses (per this file's default parseIntent mock) as the
  // SAME intent already in progress (`assign_lead`) and merges instead of
  // wiping: since `params` carries no new leadRef/assigneeName, the already-
  // selected lead/worker are kept as-is and the confirm prompt is re-sent —
  // context-preserving, not silently restarted.
  it('free-text at confirm with no new signal re-confirms (does not wipe ctx) — UX-T1 merge', async () => {
    const user = makeLeadsViewer();
    ctxStore = {
      awaiting: 'assign_lead_confirm',
      assignLeadSelectedLeadId: 'lead-1',
      assignLeadSelectedLeadName: 'ישראל ישראלי',
      assignLeadSelectedWorkerId: 'w-1',
      assignLeadSelectedWorkerName: 'דני',
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'אולי');

    expect(assignLead).not.toHaveBeenCalled();
    // Context NOT cleared/restarted — same lead + worker retained.
    expect(ctxStore).toMatchObject({
      awaiting: 'assign_lead_confirm',
      assignLeadSelectedLeadId: 'lead-1',
      assignLeadSelectedWorkerId: 'w-1',
    });
    const btnCalls = sendButtonMessage.mock.calls.map((c) => c[0] as { body: string });
    const txtCalls = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    const confirmMsg = btnCalls.find((c) => c.body.includes('לשייך'))?.body
      ?? txtCalls.find((t) => t.includes('לשייך'));
    expect(confirmMsg).toBeDefined();
  });

  it('AI suggestion shown when provider returns a valid candidate', async () => {
    const user = makeLeadsViewer();
    ctxStore = {
      awaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1'],
      assignLeadCandidateNames: ['ישראל ישראלי'],
    };
    findActiveInspectors.mockResolvedValueOnce(SAMPLE_WORKERS);
    suggestWorkerForLead.mockResolvedValueOnce({ userId: 'w-1', reason: 'בדיקות קרינה' });

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('הצעת AI') && t.includes('דני'))).toBe(true);
  });
});

// ── UX-T1 — smart picker escape: merge / pivot / pivot_confirm ──────────────
//
// The old escape hatch for numeric-picker states (assign_lead_pick_lead,
// assign_lead_pick_worker, assign_lead_confirm, …) always did
// `clearContext + handleAIMessage` on any free text, wiping the in-progress
// selection. `trySmartPickerEscape` (router.ts) now classifies the reply via
// `classifySmartPickerEscape` (smartPickerEscape.ts): same intent → merge into
// the current flow (`mergeAssignLead`); different high-confidence intent →
// pivot_confirm; low-confidence/unparseable → redisplay hint; no owning
// intent for the state → legacy passthrough.
describe('UX-T1 — smart picker escape (merge / pivot / pivot_confirm)', () => {
  it('(a) mid-picker merge: free-text worker name in assign_lead_pick_lead stores the worker, stays awaiting a lead pick, does NOT restart', async () => {
    const user = makeLeadsViewer();
    ctxStore = {
      awaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1', 'lead-2'],
      assignLeadCandidateNames: ['ישראל ישראלי', 'שרה כהן'],
    };
    findActiveInspectors.mockResolvedValueOnce(SAMPLE_WORKERS);
    parseIntent.mockResolvedValueOnce(defaultAssignLeadIntent({ params: { assigneeName: 'דני' } }));

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'שייך אל דני');

    // NOT a restart: context was never cleared, and the original lead list
    // presented to the user is still intact.
    expect(clearContext).not.toHaveBeenCalled();
    expect(assignLead).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({
      awaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1', 'lead-2'],
      assignLeadSelectedWorkerId: 'w-1',
      assignLeadSelectedWorkerName: 'דני',
    });
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('דני'))).toBe(true);
  });

  it('(b) self-reference ("אלי") resolves to the acting user when they are an active inspector', async () => {
    const user = makeLeadsViewer(); // id: 'u-sasha', name: 'סשה'
    ctxStore = {
      awaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1', 'lead-2'],
      assignLeadCandidateNames: ['ישראל ישראלי', 'שרה כהן'],
    };
    findActiveInspectors.mockResolvedValueOnce([
      { id: user.id, name: user.name, role: 'MANAGER' },
      ...SAMPLE_WORKERS,
    ]);
    parseIntent.mockResolvedValueOnce(defaultAssignLeadIntent({ params: { assigneeName: 'אלי' } }));

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'שייך אלי');

    expect(ctxStore).toMatchObject({
      awaiting: 'assign_lead_pick_lead',
      assignLeadSelectedWorkerId: user.id,
      assignLeadSelectedWorkerName: user.name,
    });
  });

  it('(c) a different high-confidence intent triggers pivot_confirm — NOT a silent reset', async () => {
    const user = makeLeadsViewer();
    ctxStore = {
      awaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1', 'lead-2'],
      assignLeadCandidateNames: ['ישראל ישראלי', 'שרה כהן'],
    };
    parseIntent.mockResolvedValueOnce({
      intent: 'list_today_field_inspections',
      confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: {}, missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    });

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'מה יש להיום בשטח');

    expect(clearContext).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({
      awaiting: 'pivot_confirm',
      pivotPrevAwaiting: 'assign_lead_pick_lead',
    });
    expect((ctxStore as { pendingIntent?: { intent?: string } } | null)?.pendingIntent?.intent)
      .toBe('list_today_field_inspections');
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('לצאת'))).toBe(true);
  });

  it('(d) pivot_confirm "1" dispatches the pendingIntent through routeIntent and clears the pivot context', async () => {
    const user = makeLeadsViewer();
    const pendingIntent = {
      intent: 'assign_lead', confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: {}, missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    };
    ctxStore = {
      awaiting: 'pivot_confirm',
      pendingIntent,
      pivotPrevAwaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1'],
      assignLeadCandidateNames: ['ישראל ישראלי'],
    };
    findUnassignedLeadsForAssignment.mockResolvedValueOnce(SAMPLE_LEADS);

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '1');

    // The pendingIntent (assign_lead) was dispatched via routeIntent →
    // startAssignLeadFlow, which shows a FRESH lead list (2 leads, matching
    // SAMPLE_LEADS) — proof this went through real dispatch, not a leftover
    // of the pivot state (which only had 1 candidate lead).
    expect(ctxStore).toMatchObject({
      awaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1', 'lead-2'],
    });
    expect((ctxStore as Record<string, unknown>).pendingIntent).toBeUndefined();
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('ישראל ישראלי'))).toBe(true);
  });

  it('(d) pivot_confirm "2" restores pivotPrevAwaiting and drops pendingIntent — no dispatch', async () => {
    const user = makeLeadsViewer();
    const pendingIntent = {
      intent: 'list_today_field_inspections', confidence: 0.95,
      task_reference: null, field: null, new_value: null,
      params: {}, missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false,
      transition: null, problem_type: null,
    };
    ctxStore = {
      awaiting: 'pivot_confirm',
      pendingIntent,
      pivotPrevAwaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1', 'lead-2'],
      assignLeadCandidateNames: ['ישראל ישראלי', 'שרה כהן'],
    };

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, '2');

    expect(clearContext).not.toHaveBeenCalled();
    expect(findUnassignedLeadsForAssignment).not.toHaveBeenCalled();
    expect(ctxStore).toMatchObject({
      awaiting: 'assign_lead_pick_lead',
      assignLeadCandidateIds: ['lead-1', 'lead-2'],
    });
    expect((ctxStore as Record<string, unknown>).pendingIntent).toBeUndefined();
    expect((ctxStore as Record<string, unknown>).pivotPrevAwaiting).toBeUndefined();
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('נמשיך'))).toBe(true);
  });

  it('(e) regression — one-shot from scratch: leadRef + self-reference assigneeName ("אלי") still jumps straight to a single confirm', async () => {
    const user = makeLeadsViewer();
    ctxStore = null; // fresh message, no context
    findUnassignedLeadsForAssignment.mockResolvedValueOnce([
      {
        id: 'lead-1', fromName: 'יוסי כהן', subject: null, receivedAt: new Date(),
        fromEmail: null, body: null, status: null, ownerId: null, taskId: null,
      },
    ]);
    findActiveInspectors.mockResolvedValueOnce([
      { id: user.id, name: user.name, role: 'MANAGER' },
    ]);
    parseIntent.mockResolvedValueOnce(defaultAssignLeadIntent({
      params: { leadRef: 'יוסי', assigneeName: 'אלי' },
    }));

    const { handleAIMessage } = await loadRouter();
    await handleAIMessage(user, 'לשייך את הליד של יוסי אלי');

    expect(ctxStore).toMatchObject({
      awaiting: 'assign_lead_confirm',
      assignLeadSelectedLeadId: 'lead-1',
      assignLeadSelectedWorkerId: user.id,
    });
    const texts = sendTextMessage.mock.calls.map((c) => c[0].text as string);
    expect(texts.some((t) => t.includes('לשייך') && t.includes('אישור'))).toBe(true);
    expect(assignLead).not.toHaveBeenCalled(); // not yet confirmed
  });
});
