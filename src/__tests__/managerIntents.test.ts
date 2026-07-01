/**
 * managerIntents.test.ts
 *
 * End-to-end intent parsing tests for the 7 new manager-facing intents.
 * The LLM is mocked via the same mockProvider pattern as leadSuggester.test.ts.
 * We feed the parser a deterministic "model output" and assert that
 * parseIntentResult + the schema layer round-trips it correctly.
 *
 * We also test buildSystemPrompt to verify that:
 *  - Manager users get MANAGER_INTENT_LIST / MANAGER_FEW_SHOT
 *  - Worker users get WORKER_INTENT_LIST / WORKER_FEW_SHOT
 */
import { describe, it, expect, vi } from 'vitest';
import { parseIntent, buildSystemPrompt, type ParseContext } from '../ai/intentParser';
import { parseIntentResult } from '../ai/schema';
import type { LLMProvider, StructuredRequest } from '../ai/provider';
import type { ResolvedUser } from '../types';

// ── Test helpers ──────────────────────────────────────────────────────────────

function mockProvider(
  returnValue: Record<string, unknown>,
  name = 'mock',
): LLMProvider {
  return {
    name,
    emitStructured: vi.fn().mockResolvedValue(returnValue),
  };
}

function makeManager(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-mgr',
    name: 'מנהל',
    phone: '97250000001',
    role: 'MANAGER',
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

function makeCtx(user: ResolvedUser, overrides: Partial<ParseContext> = {}): ParseContext {
  return { user, allowedTypes: [], allowedPriorities: [], ...overrides };
}

// ── buildSystemPrompt role-awareness ─────────────────────────────────────────

describe('buildSystemPrompt — role-awareness', () => {
  it('manager prompt contains MANAGER_INTENT_LIST keywords', () => {
    const prompt = buildSystemPrompt(makeCtx(makeManager()));
    expect(prompt).toContain('management_snapshot');
    expect(prompt).toContain('list_today_field_inspections');
    expect(prompt).toContain('list_open_exceptions');
    expect(prompt).toContain('list_pending_leads');
    expect(prompt).toContain('workers_day_overview');
    expect(prompt).toContain('search_task');
    expect(prompt).toContain('open_manager_menu');
  });

  it('manager prompt contains MANAGER_FEW_SHOT examples', () => {
    const prompt = buildSystemPrompt(makeCtx(makeManager()));
    expect(prompt).toContain('management_snapshot');
    expect(prompt).toContain('list_today_field_inspections');
    expect(prompt).toContain('לידים ממתינים');
    expect(prompt).toContain('workers_day_overview');
  });

  it('manager prompt does NOT contain WORKER_INTENT_LIST exclusive phrasing', () => {
    const prompt = buildSystemPrompt(makeCtx(makeManager()));
    // Worker examples should NOT dominate the prompt
    // (worker intents appear in a smaller block for managers too, but the primary block is manager)
    expect(prompt).toContain('MANAGER-SIDE INTENTS');
    expect(prompt).not.toContain('WORKER-SIDE INTENTS');
  });

  it('worker prompt contains WORKER_INTENT_LIST keywords', () => {
    const prompt = buildSystemPrompt(makeCtx(makeWorker()));
    expect(prompt).toContain('set_field_status');
    expect(prompt).toContain('report_problem');
    expect(prompt).toContain('report_missing_info');
    expect(prompt).toContain('WORKER-SIDE INTENTS');
  });

  it('worker prompt does NOT contain MANAGER_INTENT_LIST block', () => {
    const prompt = buildSystemPrompt(makeCtx(makeWorker()));
    expect(prompt).not.toContain('MANAGER-SIDE INTENTS');
    expect(prompt).not.toContain('management_snapshot');
  });

  it('manager prompt contains role hint with manager-level=true', () => {
    const prompt = buildSystemPrompt(makeCtx(makeManager()));
    expect(prompt).toContain('Manager-level: true');
  });

  it('worker prompt contains role hint with manager-level=false', () => {
    const prompt = buildSystemPrompt(makeCtx(makeWorker()));
    expect(prompt).toContain('Manager-level: false');
  });

  it('יורם (exceptions viewer) gets manager prompt', () => {
    const yoram = makeWorker({ name: 'יורם', role: 'SALES' });
    const prompt = buildSystemPrompt(makeCtx(yoram));
    expect(prompt).toContain('Manager-level: true');
    expect(prompt).toContain('MANAGER-SIDE INTENTS');
  });

  it('סשה (leads viewer) gets manager prompt', () => {
    const sasha = makeWorker({ name: 'סשה', role: 'SALES' });
    const prompt = buildSystemPrompt(makeCtx(sasha));
    expect(prompt).toContain('Manager-level: true');
    expect(prompt).toContain('MANAGER-SIDE INTENTS');
  });

  it('ADMIN gets manager prompt', () => {
    const admin = makeManager({ role: 'ADMIN' });
    const prompt = buildSystemPrompt(makeCtx(admin));
    expect(prompt).toContain('Manager-level: true');
    expect(prompt).toContain('MANAGER-SIDE INTENTS');
  });
});

// ── parseIntent — simulated LLM outputs for manager phrases ──────────────────
// Each test provides a deterministic model response (as if the real LLM had
// chosen that output) and asserts the schema layer round-trips it correctly.

describe('parseIntent — management_snapshot', () => {
  it('"מה יש להיום" → management_snapshot', async () => {
    const provider = mockProvider({ intent: 'management_snapshot', confidence: 0.95 });
    const r = await parseIntent('מה יש להיום', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('management_snapshot');
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('"תמונת מצב" → management_snapshot', async () => {
    const provider = mockProvider({ intent: 'management_snapshot', confidence: 0.97 });
    const r = await parseIntent('תמונת מצב', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('management_snapshot');
  });

  it('"מה קורה" → management_snapshot', async () => {
    const provider = mockProvider({ intent: 'management_snapshot', confidence: 0.9 });
    const r = await parseIntent('מה קורה', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('management_snapshot');
  });

  it('"בבקשה תראה לי מה קורה" (voice prefix) → management_snapshot', async () => {
    const provider = mockProvider({ intent: 'management_snapshot', confidence: 0.93 });
    const r = await parseIntent('בבקשה תראה לי מה קורה', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('management_snapshot');
  });
});

describe('parseIntent — list_today_field_inspections', () => {
  it('"תציג לי את בדיקות השטח להיום" → list_today_field_inspections', async () => {
    const provider = mockProvider({ intent: 'list_today_field_inspections', confidence: 0.96 });
    const r = await parseIntent('תציג לי את בדיקות השטח להיום', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('list_today_field_inspections');
  });

  it('"רשימת בדיקות היום" → list_today_field_inspections', async () => {
    const provider = mockProvider({ intent: 'list_today_field_inspections', confidence: 0.95 });
    const r = await parseIntent('רשימת בדיקות היום', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('list_today_field_inspections');
  });

  it('"מה יש היום בשטח" → list_today_field_inspections', async () => {
    const provider = mockProvider({ intent: 'list_today_field_inspections', confidence: 0.9 });
    const r = await parseIntent('מה יש היום בשטח', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('list_today_field_inspections');
  });

  it('"אני רוצה לראות בדיקות של היום" (voice prefix) → list_today_field_inspections', async () => {
    const provider = mockProvider({ intent: 'list_today_field_inspections', confidence: 0.92 });
    const r = await parseIntent('אני רוצה לראות בדיקות של היום', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('list_today_field_inspections');
  });
});

describe('parseIntent — list_open_exceptions', () => {
  it('"תציג את החריגים" → list_open_exceptions, filter=open', async () => {
    const provider = mockProvider({
      intent: 'list_open_exceptions', confidence: 0.93,
      params: { filter: 'open' },
    });
    const r = await parseIntent('תציג את החריגים', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('list_open_exceptions');
    expect(r.params.filter).toBe('open');
  });

  it('"משימות עם בעיה" → list_open_exceptions, filter=has_problem', async () => {
    const provider = mockProvider({
      intent: 'list_open_exceptions', confidence: 0.91,
      params: { filter: 'has_problem' },
    });
    const r = await parseIntent('משימות עם בעיה', makeCtx(makeManager()), provider);
    expect(r.params.filter).toBe('has_problem');
  });

  it('"אילו בדיקות לא אושרו" → list_open_exceptions, filter=not_confirmed', async () => {
    const provider = mockProvider({
      intent: 'list_open_exceptions', confidence: 0.9,
      params: { filter: 'not_confirmed' },
    });
    const r = await parseIntent('אילו בדיקות לא אושרו', makeCtx(makeManager()), provider);
    expect(r.params.filter).toBe('not_confirmed');
  });

  it('"ממתינות למידע" → list_open_exceptions, filter=waiting_for_info', async () => {
    const provider = mockProvider({
      intent: 'list_open_exceptions', confidence: 0.9,
      params: { filter: 'waiting_for_info' },
    });
    const r = await parseIntent('ממתינות למידע', makeCtx(makeManager()), provider);
    expect(r.params.filter).toBe('waiting_for_info');
  });

  it('"מי לא סגר יום" → list_open_exceptions, filter=not_closed', async () => {
    const provider = mockProvider({
      intent: 'list_open_exceptions', confidence: 0.9,
      params: { filter: 'not_closed' },
    });
    const r = await parseIntent('מי לא סגר יום', makeCtx(makeManager()), provider);
    expect(r.params.filter).toBe('not_closed');
  });
});

describe('parseIntent — list_pending_leads', () => {
  it('"לידים ממתינים" → list_pending_leads, filter=unassigned', async () => {
    const provider = mockProvider({
      intent: 'list_pending_leads', confidence: 0.94,
      params: { filter: 'unassigned' },
    });
    const r = await parseIntent('לידים ממתינים', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('list_pending_leads');
    expect(r.params.filter).toBe('unassigned');
  });

  it('"לידים שעברו שעה" → list_pending_leads, filter=escalated', async () => {
    const provider = mockProvider({
      intent: 'list_pending_leads', confidence: 0.91,
      params: { filter: 'escalated' },
    });
    const r = await parseIntent('לידים שעברו שעה', makeCtx(makeManager()), provider);
    expect(r.params.filter).toBe('escalated');
  });

  it('"לידים באיחור" → list_pending_leads, filter=escalated', async () => {
    const provider = mockProvider({
      intent: 'list_pending_leads', confidence: 0.9,
      params: { filter: 'escalated' },
    });
    const r = await parseIntent('לידים באיחור', makeCtx(makeManager()), provider);
    expect(r.params.filter).toBe('escalated');
  });

  it('"אני רוצה לראות לידים שלא שויכו" (voice prefix) → list_pending_leads', async () => {
    const provider = mockProvider({
      intent: 'list_pending_leads', confidence: 0.92,
      params: { filter: 'unassigned' },
    });
    const r = await parseIntent('אני רוצה לראות לידים שלא שויכו', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('list_pending_leads');
  });
});

describe('parseIntent — workers_day_overview', () => {
  it('"סיכום עובדים" → workers_day_overview (all workers)', async () => {
    const provider = mockProvider({ intent: 'workers_day_overview', confidence: 0.93, params: {} });
    const r = await parseIntent('סיכום עובדים', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('workers_day_overview');
    expect(r.params.workerName).toBeUndefined();
  });

  it('"מה כל עובד עשה" → workers_day_overview', async () => {
    const provider = mockProvider({ intent: 'workers_day_overview', confidence: 0.9, params: {} });
    const r = await parseIntent('מה כל עובד עשה', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('workers_day_overview');
  });

  it('"סיכום של דני" → workers_day_overview + workerName=דני', async () => {
    const provider = mockProvider({
      intent: 'workers_day_overview', confidence: 0.94,
      params: { workerName: 'דני' },
    });
    const r = await parseIntent('סיכום של דני', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('workers_day_overview');
    expect(r.params.workerName).toBe('דני');
  });

  it('"מה דני עשה היום" → workers_day_overview + workerName=דני', async () => {
    const provider = mockProvider({
      intent: 'workers_day_overview', confidence: 0.93,
      params: { workerName: 'דני' },
    });
    const r = await parseIntent('מה דני עשה היום', makeCtx(makeManager()), provider);
    expect(r.params.workerName).toBe('דני');
  });

  it('"בבקשה תראה לי מה דני עשה" (voice prefix) → workers_day_overview + workerName=דני', async () => {
    const provider = mockProvider({
      intent: 'workers_day_overview', confidence: 0.92,
      params: { workerName: 'דני' },
    });
    const r = await parseIntent('בבקשה תראה לי מה דני עשה', makeCtx(makeManager()), provider);
    expect(r.params.workerName).toBe('דני');
  });
});

describe('parseIntent — search_task', () => {
  it('"חפש בדיקה של כהן" → search_task, searchBy=customer, query=כהן', async () => {
    const provider = mockProvider({
      intent: 'search_task', confidence: 0.95,
      params: { searchBy: 'customer', query: 'כהן' },
    });
    const r = await parseIntent('חפש בדיקה של כהן', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('search_task');
    expect(r.params.searchBy).toBe('customer');
    expect(r.params.query).toBe('כהן');
  });

  it('"בדיקות של יוסי" → search_task, searchBy=worker, query=יוסי', async () => {
    const provider = mockProvider({
      intent: 'search_task', confidence: 0.93,
      params: { searchBy: 'worker', query: 'יוסי' },
    });
    const r = await parseIntent('בדיקות של יוסי', makeCtx(makeManager()), provider);
    expect(r.params.searchBy).toBe('worker');
    expect(r.params.query).toBe('יוסי');
  });

  it('"בדיקות מק"ט 10156" → search_task, searchBy=product, query=10156', async () => {
    const provider = mockProvider({
      intent: 'search_task', confidence: 0.94,
      params: { searchBy: 'product', query: '10156' },
    });
    const r = await parseIntent('בדיקות מק"ט 10156', makeCtx(makeManager()), provider);
    expect(r.params.searchBy).toBe('product');
    expect(r.params.query).toBe('10156');
  });

  it('"תחפש לי בדיקות של יוסי" (voice prefix) → search_task, searchBy=worker', async () => {
    const provider = mockProvider({
      intent: 'search_task', confidence: 0.92,
      params: { searchBy: 'worker', query: 'יוסי' },
    });
    const r = await parseIntent('תחפש לי בדיקות של יוסי', makeCtx(makeManager()), provider);
    expect(r.params.searchBy).toBe('worker');
  });

  it('"חפש לפי מקט" (no query) → search_task with no params', async () => {
    const provider = mockProvider({ intent: 'search_task', confidence: 0.75, params: {} });
    const r = await parseIntent('חפש לפי מקט', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('search_task');
    expect(r.params.searchBy).toBeUndefined();
    expect(r.params.query).toBeUndefined();
  });
});

describe('parseIntent — open_manager_menu', () => {
  it('"תפריט" → open_manager_menu for manager', async () => {
    const provider = mockProvider({ intent: 'open_manager_menu', confidence: 0.98 });
    const r = await parseIntent('תפריט', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('open_manager_menu');
  });

  it('"מה יש כאן" → open_manager_menu', async () => {
    const provider = mockProvider({ intent: 'open_manager_menu', confidence: 0.91 });
    const r = await parseIntent('מה יש כאן', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('open_manager_menu');
  });

  it('"מה אפשר לעשות" → open_manager_menu', async () => {
    const provider = mockProvider({ intent: 'open_manager_menu', confidence: 0.9 });
    const r = await parseIntent('מה אפשר לעשות', makeCtx(makeManager()), provider);
    expect(r.intent).toBe('open_manager_menu');
  });
});

// ── Worker phrases should NOT map to manager intents ─────────────────────────

describe('parseIntent — worker phrases stay worker intents', () => {
  it('"יצאתי" stays set_field_status for workers', async () => {
    const provider = mockProvider({
      intent: 'set_field_status', confidence: 0.97, transition: 'DEPARTED',
    });
    const r = await parseIntent('יצאתי', makeCtx(makeWorker()), provider);
    expect(r.intent).toBe('set_field_status');
    expect(r.transition).toBe('DEPARTED');
  });

  it('"סיימתי" stays set_field_status for workers', async () => {
    const provider = mockProvider({
      intent: 'set_field_status', confidence: 0.96, transition: 'FINISHED',
    });
    const r = await parseIntent('סיימתי', makeCtx(makeWorker()), provider);
    expect(r.intent).toBe('set_field_status');
    expect(r.transition).toBe('FINISHED');
  });

  it('"הלקוח לא ענה" stays report_problem for workers', async () => {
    const provider = mockProvider({
      intent: 'report_problem', confidence: 0.95,
      problem_type: 'CUSTOMER_NOT_ANSWERING',
    });
    const r = await parseIntent('הלקוח לא ענה', makeCtx(makeWorker()), provider);
    expect(r.intent).toBe('report_problem');
    expect(r.problem_type).toBe('CUSTOMER_NOT_ANSWERING');
  });
});
