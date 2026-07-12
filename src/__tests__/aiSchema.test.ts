import { describe, it, expect } from 'vitest';
import {
  parseIntentResult, INTENT_JSON_SCHEMA, AI_INTENTS,
  FIELD_STATUS_TRANSITIONS, FIELD_PROBLEM_TYPES,
} from '../ai/schema';

describe('parseIntentResult', () => {
  it('parses a well-formed model output', () => {
    const r = parseIntentResult({
      intent: 'get_task',
      confidence: 0.92,
      task_reference: 'T-123',
      field: null,
      new_value: null,
      params: {},
      missing_fields: [],
      clarification: null,
      requires_confirmation: false,
      requires_manager_approval: false,
    });
    expect(r.intent).toBe('get_task');
    expect(r.confidence).toBe(0.92);
    expect(r.task_reference).toBe('T-123');
  });

  it('coerces an invalid intent to unknown', () => {
    const r = parseIntentResult({
      intent: 'frobnicate',
      confidence: 0.5,
      new_value: null,
    });
    expect(r.intent).toBe('unknown');
  });

  it('fills sane defaults when optional fields are missing', () => {
    const r = parseIntentResult({ intent: 'help', confidence: 1 });
    expect(r.params).toEqual({});
    expect(r.missing_fields).toEqual([]);
    expect(r.task_reference).toBeNull();
    expect(r.clarification).toBeNull();
    expect(r.requires_confirmation).toBe(false);
    expect(r.requires_manager_approval).toBe(false);
    // v2 field-inspector extras default to null when absent.
    expect(r.transition).toBeNull();
    expect(r.problem_type).toBeNull();
  });

  it('clamps out-of-range confidence to 0', () => {
    const r = parseIntentResult({ intent: 'help', confidence: 5 });
    expect(r.confidence).toBe(0);
  });

  it('exposes a valid JSON schema with all required keys', () => {
    const required = INTENT_JSON_SCHEMA.required as string[];
    expect(required).toContain('intent');
    expect(required).toContain('confidence');
    expect(required).toContain('params');
  });
});

// ── v2 field-inspector intents (D5-T3) ──────────────────────────────────────
// SPEC_FIELD_V2 §7-§9. `set_field_status`, `report_problem`, `report_missing_info`
// live alongside the legacy CRM intents until X-T2 drops the latter.

describe('AI_INTENTS — v2 field-inspector kinds', () => {
  it('includes the 3 new inspector kinds', () => {
    expect(AI_INTENTS).toContain('set_field_status');
    expect(AI_INTENTS).toContain('report_problem');
    expect(AI_INTENTS).toContain('report_missing_info');
  });

  it('contains the known active intents (X-T2 removed legacy CRM kinds; new intents added by later tasks)', () => {
    // Original 6 (X-T2) plus later additions: D2-T11 schedule_task_field,
    // D2-T12/13/14 correction intents, D3-T6 assign_lead,
    // and 7 manager-facing intents.
    const expected = [
      'assign_lead',
      'correct_inspection_type',
      'correct_task_field_site',
      'day_summary_query',
      'enable_worker_location_tracking',
      'get_task',
      'help',
      'list_my_inspections',
      'list_open_exceptions',
      'list_pending_leads',
      'list_today_field_inspections',
      'management_snapshot',
      'missing_equipment_free',
      'open_manager_menu',
      'reassign_task',
      'report_missing_info',
      'report_problem',
      'schedule_task_field',
      'search_task',
      'set_field_status',
      'unknown',
      'workers_day_overview',
    ];
    expect([...AI_INTENTS].sort()).toEqual(expected);
  });
});

// ── Manager-facing intents ───────────────────────────────────────────────────

describe('AI_INTENTS — manager-facing kinds', () => {
  it('includes all 7 new manager intents', () => {
    expect(AI_INTENTS).toContain('open_manager_menu');
    expect(AI_INTENTS).toContain('management_snapshot');
    expect(AI_INTENTS).toContain('list_today_field_inspections');
    expect(AI_INTENTS).toContain('list_open_exceptions');
    expect(AI_INTENTS).toContain('list_pending_leads');
    expect(AI_INTENTS).toContain('workers_day_overview');
    expect(AI_INTENTS).toContain('search_task');
  });
});

describe('parseIntentResult — manager intents', () => {
  it('validates management_snapshot with no params', () => {
    const r = parseIntentResult({ intent: 'management_snapshot', confidence: 0.92 });
    expect(r.intent).toBe('management_snapshot');
    expect(r.confidence).toBe(0.92);
  });

  it('validates list_today_field_inspections', () => {
    const r = parseIntentResult({ intent: 'list_today_field_inspections', confidence: 0.95 });
    expect(r.intent).toBe('list_today_field_inspections');
  });

  it('validates list_open_exceptions with filter param', () => {
    const r = parseIntentResult({
      intent: 'list_open_exceptions', confidence: 0.9,
      params: { filter: 'has_problem' },
    });
    expect(r.intent).toBe('list_open_exceptions');
    expect(r.params.filter).toBe('has_problem');
  });

  it('validates list_open_exceptions without filter (defaults to open)', () => {
    const r = parseIntentResult({ intent: 'list_open_exceptions', confidence: 0.88 });
    expect(r.intent).toBe('list_open_exceptions');
    expect(r.params).toEqual({});
  });

  it('validates list_pending_leads with filter=unassigned', () => {
    const r = parseIntentResult({
      intent: 'list_pending_leads', confidence: 0.9,
      params: { filter: 'unassigned' },
    });
    expect(r.intent).toBe('list_pending_leads');
    expect(r.params.filter).toBe('unassigned');
  });

  it('validates list_pending_leads with filter=escalated', () => {
    const r = parseIntentResult({
      intent: 'list_pending_leads', confidence: 0.9,
      params: { filter: 'escalated' },
    });
    expect(r.params.filter).toBe('escalated');
  });

  it('validates workers_day_overview without workerName (all-workers view)', () => {
    const r = parseIntentResult({ intent: 'workers_day_overview', confidence: 0.9 });
    expect(r.intent).toBe('workers_day_overview');
    expect(r.params.workerName).toBeUndefined();
  });

  it('validates workers_day_overview with workerName', () => {
    const r = parseIntentResult({
      intent: 'workers_day_overview', confidence: 0.9,
      params: { workerName: 'דני' },
    });
    expect(r.params.workerName).toBe('דני');
  });

  it('validates search_task with searchBy and query', () => {
    const r = parseIntentResult({
      intent: 'search_task', confidence: 0.95,
      params: { searchBy: 'customer', query: 'כהן' },
    });
    expect(r.intent).toBe('search_task');
    expect(r.params.searchBy).toBe('customer');
    expect(r.params.query).toBe('כהן');
  });

  it('validates search_task with searchBy=worker', () => {
    const r = parseIntentResult({
      intent: 'search_task', confidence: 0.9,
      params: { searchBy: 'worker', query: 'יוסי' },
    });
    expect(r.params.searchBy).toBe('worker');
    expect(r.params.query).toBe('יוסי');
  });

  it('validates search_task with searchBy=product', () => {
    const r = parseIntentResult({
      intent: 'search_task', confidence: 0.9,
      params: { searchBy: 'product', query: '10156' },
    });
    expect(r.params.searchBy).toBe('product');
    expect(r.params.query).toBe('10156');
  });

  it('validates search_task with no params (sub-menu will show)', () => {
    const r = parseIntentResult({ intent: 'search_task', confidence: 0.75 });
    expect(r.intent).toBe('search_task');
    expect(r.params).toEqual({});
  });

  it('validates search_task with searchBy=address', () => {
    const r = parseIntentResult({
      intent: 'search_task', confidence: 0.9,
      params: { searchBy: 'address', query: 'הרצל' },
    });
    expect(r.params.searchBy).toBe('address');
    expect(r.params.query).toBe('הרצל');
  });

  it('validates search_task with searchBy=phone', () => {
    const r = parseIntentResult({
      intent: 'search_task', confidence: 0.9,
      params: { searchBy: 'phone', query: '054' },
    });
    expect(r.params.searchBy).toBe('phone');
  });

  it('validates search_task with searchBy=task_id', () => {
    const r = parseIntentResult({
      intent: 'search_task', confidence: 0.9,
      params: { searchBy: 'task_id', query: '12345' },
    });
    expect(r.params.searchBy).toBe('task_id');
  });

  it('validates search_task with searchBy=field_status', () => {
    const r = parseIntentResult({
      intent: 'search_task', confidence: 0.9,
      params: { searchBy: 'field_status', query: 'WAITING_FOR_INFO' },
    });
    expect(r.params.searchBy).toBe('field_status');
    expect(r.params.query).toBe('WAITING_FOR_INFO');
  });

  it('validates count_only=true for list_today_field_inspections', () => {
    const r = parseIntentResult({
      intent: 'list_today_field_inspections', confidence: 0.92,
      params: { count_only: true },
    });
    expect(r.intent).toBe('list_today_field_inspections');
    expect(r.params.count_only).toBe(true);
  });

  it('validates count_only=true for list_open_exceptions', () => {
    const r = parseIntentResult({
      intent: 'list_open_exceptions', confidence: 0.9,
      params: { filter: 'open', count_only: true },
    });
    expect(r.params.count_only).toBe(true);
    expect(r.params.filter).toBe('open');
  });

  it('validates count_only=true for list_pending_leads', () => {
    const r = parseIntentResult({
      intent: 'list_pending_leads', confidence: 0.9,
      params: { filter: 'unassigned', count_only: true },
    });
    expect(r.params.count_only).toBe(true);
  });

  it('validates count_only=true for workers_day_overview', () => {
    const r = parseIntentResult({
      intent: 'workers_day_overview', confidence: 0.92,
      params: { count_only: true },
    });
    expect(r.params.count_only).toBe(true);
  });

  it('validates open_manager_menu', () => {
    const r = parseIntentResult({ intent: 'open_manager_menu', confidence: 0.95 });
    expect(r.intent).toBe('open_manager_menu');
  });

  it('INTENT_JSON_SCHEMA searchBy enum contains all 7 values', () => {
    const searchByEnum = (INTENT_JSON_SCHEMA as { properties: { params: { properties: { searchBy: { enum: string[] } } } } }).properties.params.properties.searchBy.enum;
    expect(searchByEnum).toContain('customer');
    expect(searchByEnum).toContain('worker');
    expect(searchByEnum).toContain('product');
    expect(searchByEnum).toContain('address');
    expect(searchByEnum).toContain('phone');
    expect(searchByEnum).toContain('task_id');
    expect(searchByEnum).toContain('field_status');
    expect(searchByEnum).toHaveLength(7);
  });

  it('INTENT_JSON_SCHEMA params.properties contains count_only', () => {
    const props = (INTENT_JSON_SCHEMA as { properties: { params: { properties: Record<string, unknown> } } }).properties.params.properties;
    expect(props).toHaveProperty('count_only');
  });
});

describe('FIELD_STATUS_TRANSITIONS', () => {
  it('has exactly the 6 worker-triggered transitions (D5-T18 added CONFIRM)', () => {
    expect([...FIELD_STATUS_TRANSITIONS].sort()).toEqual(
      ['ARRIVED', 'CONFIRM', 'DEPARTED', 'FINISHED', 'HAS_PROBLEM', 'WAITING_FOR_INFO'],
    );
  });
});

describe('FIELD_PROBLEM_TYPES', () => {
  it('has the 7 declared problem types', () => {
    expect([...FIELD_PROBLEM_TYPES].sort()).toEqual([
      'CANNOT_PERFORM', 'CUSTOMER_NOT_ANSWERING', 'CUSTOMER_NOT_PRESENT',
      'MISSING_EQUIPMENT', 'NO_ACCESS', 'OTHER', 'PROFESSIONAL_ISSUE',
    ]);
  });
});

describe('parseIntentResult — set_field_status', () => {
  it('validates a well-formed set_field_status with transition + taskRef', () => {
    const r = parseIntentResult({
      intent: 'set_field_status',
      confidence: 0.95,
      task_reference: 'כהן',
      field: null,
      new_value: null,
      params: {},
      missing_fields: [],
      clarification: null,
      requires_confirmation: false,
      requires_manager_approval: false,
      transition: 'DEPARTED',
    });
    expect(r.intent).toBe('set_field_status');
    expect(r.transition).toBe('DEPARTED');
    expect(r.task_reference).toBe('כהן');
  });

  it('accepts every declared transition value', () => {
    for (const t of FIELD_STATUS_TRANSITIONS) {
      const r = parseIntentResult({
        intent: 'set_field_status', confidence: 0.9, transition: t,
      });
      expect(r.transition).toBe(t);
    }
  });

  it('rejects an out-of-set transition value', () => {
    expect(() => parseIntentResult({
      intent: 'set_field_status', confidence: 0.9, transition: 'STARTED',
    })).toThrow();
  });

  it('validates when taskRef is absent (backend disambiguates)', () => {
    const r = parseIntentResult({
      intent: 'set_field_status', confidence: 0.9, transition: 'ARRIVED',
    });
    expect(r.transition).toBe('ARRIVED');
    expect(r.task_reference).toBeNull();
  });
});

describe('parseIntentResult — report_problem', () => {
  it('validates with a mapped problem_type', () => {
    const r = parseIntentResult({
      intent: 'report_problem', confidence: 0.9,
      problem_type: 'CUSTOMER_NOT_ANSWERING',
    });
    expect(r.intent).toBe('report_problem');
    expect(r.problem_type).toBe('CUSTOMER_NOT_ANSWERING');
  });

  it('validates without a problem_type (D2-T8 sub-menu picks it)', () => {
    const r = parseIntentResult({
      intent: 'report_problem', confidence: 0.9,
      params: { note: 'לא מצליח למדוד' },
    });
    expect(r.intent).toBe('report_problem');
    expect(r.problem_type).toBeNull();
    expect(r.params.note).toBe('לא מצליח למדוד');
  });

  it('accepts every declared problem_type value', () => {
    for (const p of FIELD_PROBLEM_TYPES) {
      const r = parseIntentResult({
        intent: 'report_problem', confidence: 0.9, problem_type: p,
      });
      expect(r.problem_type).toBe(p);
    }
  });

  it('rejects an out-of-set problem_type value', () => {
    expect(() => parseIntentResult({
      intent: 'report_problem', confidence: 0.9, problem_type: 'WEATHER',
    })).toThrow();
  });
});

describe('parseIntentResult — report_missing_info', () => {
  it('validates with a free-text note in params', () => {
    const r = parseIntentResult({
      intent: 'report_missing_info', confidence: 0.9,
      params: { note: 'טופס דגימה' },
    });
    expect(r.intent).toBe('report_missing_info');
    expect(r.params.note).toBe('טופס דגימה');
  });

  it('validates when both taskRef and note are absent', () => {
    const r = parseIntentResult({
      intent: 'report_missing_info', confidence: 0.9,
    });
    expect(r.intent).toBe('report_missing_info');
    expect(r.task_reference).toBeNull();
  });
});

// Simulated LLM outputs for the Hebrew phrases from the spec / prompt few-shot.
// We do NOT call the LLM here — we assert that if the parser returned this JSON,
// the schema layer would round-trip it correctly.
describe('parseIntentResult — Hebrew phrase → intent shape (simulated)', () => {
  it('"יצאתי לרעננה" → set_field_status DEPARTED + taskRef', () => {
    const r = parseIntentResult({
      intent: 'set_field_status', confidence: 0.95,
      task_reference: 'רעננה', transition: 'DEPARTED',
    });
    expect(r.intent).toBe('set_field_status');
    expect(r.transition).toBe('DEPARTED');
    expect(r.task_reference).toBe('רעננה');
  });

  it('"הגעתי" → set_field_status ARRIVED, taskRef null', () => {
    const r = parseIntentResult({
      intent: 'set_field_status', confidence: 0.95, transition: 'ARRIVED',
    });
    expect(r.transition).toBe('ARRIVED');
    expect(r.task_reference).toBeNull();
  });

  it('"סיימתי" → set_field_status FINISHED', () => {
    const r = parseIntentResult({
      intent: 'set_field_status', confidence: 0.95, transition: 'FINISHED',
    });
    expect(r.transition).toBe('FINISHED');
  });

  it('"הלקוח לא ענה" → report_problem CUSTOMER_NOT_ANSWERING', () => {
    const r = parseIntentResult({
      intent: 'report_problem', confidence: 0.9,
      problem_type: 'CUSTOMER_NOT_ANSWERING',
    });
    expect(r.problem_type).toBe('CUSTOMER_NOT_ANSWERING');
  });

  it('"אין גישה" → report_problem NO_ACCESS', () => {
    const r = parseIntentResult({
      intent: 'report_problem', confidence: 0.9, problem_type: 'NO_ACCESS',
    });
    expect(r.problem_type).toBe('NO_ACCESS');
  });

  it('"חסר לי טופס דגימה" → report_missing_info + note', () => {
    const r = parseIntentResult({
      intent: 'report_missing_info', confidence: 0.9,
      params: { note: 'טופס דגימה' },
    });
    expect(r.intent).toBe('report_missing_info');
    expect(r.params.note).toBe('טופס דגימה');
  });
});
