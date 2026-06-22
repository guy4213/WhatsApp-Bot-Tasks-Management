import { describe, it, expect } from 'vitest';
import { parseIntentResult, INTENT_JSON_SCHEMA } from '../ai/schema';

describe('parseIntentResult', () => {
  it('parses a well-formed model output', () => {
    const r = parseIntentResult({
      intent: 'create_task',
      confidence: 0.92,
      task_reference: null,
      field: null,
      new_value: null,
      params: { title: 'תיאום', type: 'step5' },
      missing_fields: [],
      clarification: null,
      requires_confirmation: true,
      requires_manager_approval: false,
    });
    expect(r.intent).toBe('create_task');
    expect(r.confidence).toBe(0.92);
    expect(r.params.title).toBe('תיאום');
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
  });

  it('clamps out-of-range confidence to 0', () => {
    const r = parseIntentResult({ intent: 'list_tasks', confidence: 5 });
    expect(r.confidence).toBe(0);
  });

  it('exposes a valid JSON schema with all required keys', () => {
    const required = INTENT_JSON_SCHEMA.required as string[];
    expect(required).toContain('intent');
    expect(required).toContain('confidence');
    expect(required).toContain('params');
  });
});
