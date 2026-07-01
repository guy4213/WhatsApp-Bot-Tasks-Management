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

  it('contains exactly the 6 active intents (X-T2 removed legacy CRM kinds)', () => {
    expect([...AI_INTENTS].sort()).toEqual([
      'get_task', 'help', 'report_missing_info', 'report_problem', 'set_field_status', 'unknown',
    ]);
  });
});

describe('FIELD_STATUS_TRANSITIONS', () => {
  it('has exactly the 5 worker-triggered transitions', () => {
    expect([...FIELD_STATUS_TRANSITIONS].sort()).toEqual(
      ['ARRIVED', 'DEPARTED', 'FINISHED', 'HAS_PROBLEM', 'WAITING_FOR_INFO'],
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
