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

// parseIntent — returns assign_lead with high confidence when called.
vi.mock('../ai/intentParser', () => ({
  parseIntent: vi.fn().mockResolvedValue({
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
  }),
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
  setContext.mockClear();
  clearContext.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

// ── Lazy-load the router so mocks are in place ────────────────────────────────

async function loadRouter() {
  return await import('../ai/router');
}

// ── Auth: non-leads-viewer is rejected ───────────────────────────────────────

describe('assign_lead — auth rejection for non-leads-viewer', () => {
  it('rejects a regular worker who is NOT a leads viewer', async () => {
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

  it('free-text at confirm escapes to AI (no assignLead call, ctx cleared per v2 UX)', async () => {
    const user = makeLeadsViewer();
    ctxStore = {
      awaiting: 'assign_lead_confirm',
      assignLeadSelectedLeadId: 'lead-1',
      assignLeadSelectedLeadName: 'ישראל ישראלי',
      assignLeadSelectedWorkerId: 'w-1',
      assignLeadSelectedWorkerName: 'דני',
    };
    // After the escape, AI (per this file's parseIntent mock) parses as
    // `assign_lead` and re-enters `startAssignLeadFlow`, which needs a lead
    // list. Empty list is fine — the test only cares that assignLead is not
    // called and the ctx is no longer `assign_lead_confirm`.
    findUnassignedLeadsForAssignment.mockResolvedValueOnce([]);

    const { handleAIMessage } = await loadRouter();
    // "אולי" is Hebrew free text — the top-of-router escape hatch clears the
    // ctx and re-enters as a fresh message so the AI parser can try to
    // understand it. The confirm branch is NOT re-run (assignLead is not
    // invoked). This is the v2 "free text at any time" UX contract.
    await handleAIMessage(user, 'אולי');
    expect(assignLead).not.toHaveBeenCalled();
    expect(ctxStore?.awaiting).not.toBe('assign_lead_confirm');
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
