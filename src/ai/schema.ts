import { z } from 'zod';
import type { AIIntentResult } from '../types';

// The set of intents the model may emit. Legacy CRM intents removed by X-T2.
export const AI_INTENTS = [
  'get_task',
  'set_field_status',
  'report_problem',
  'report_missing_info',
  'help',
  'unknown',
  // D2-T12/T13/T14: correction intents (site metadata / task reassign / inspection type)
  'correct_task_field_site',
  'reassign_task',
  'correct_inspection_type',
  // D2-T11: schedule a new TaskField for an existing Task from WhatsApp.
  'schedule_task_field',
  // D3-T6: Sasha lead-assignment via WhatsApp.
  'assign_lead',
] as const;

// Editable fields the model may target with edit_field.
export const EDITABLE_FIELDS = ['title', 'description', 'priority', 'type'] as const;
export const TASK_FILTERS = ['today', 'this_week', 'open', 'next_deadline', 'overdue', 'unlinked', 'all'] as const;

// v2 field-inspector enums (SPEC_FIELD_V2 §4/§7/§9). These are the SUBSET of
// worker-triggered fieldStatus transitions and the 7 declared problem types.
export const FIELD_STATUS_TRANSITIONS = [
  'DEPARTED',
  'ARRIVED',
  'FINISHED',
  'WAITING_FOR_INFO',
  'HAS_PROBLEM',
] as const;

export const FIELD_PROBLEM_TYPES = [
  'CUSTOMER_NOT_ANSWERING',
  'NO_ACCESS',
  'CUSTOMER_NOT_PRESENT',
  'MISSING_EQUIPMENT',
  'CANNOT_PERFORM',
  'PROFESSIONAL_ISSUE',
  'OTHER',
] as const;

export const TOOL_NAME = 'emit_intent';
export const TOOL_DESCRIPTION =
  'Emit the structured interpretation of the user message. ALWAYS call this tool exactly once.';

// JSON Schema passed to the LLM tool/function definition (OpenAI & Anthropic compatible).
export const INTENT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: [...AI_INTENTS] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    task_reference: { type: ['string', 'null'], description: 'Free text describing which task/inspection the user means (customer name, address, or free ref)' },
    field: { type: ['string', 'null'], description: 'Field to edit for edit_field intent' },
    new_value: { description: 'New value for an edit intent (string, number, or null)' },
    params: {
      type: 'object',
      additionalProperties: true,
      description: 'Intent-specific extras: title, type, dueDate (ISO), priority, filter, ownerId, customerId, leadId, projectId, note',
    },
    missing_fields: { type: 'array', items: { type: 'string' } },
    clarification: { type: ['string', 'null'], description: 'A short question in Hebrew to ask the user when info is missing or ambiguous' },
    requires_confirmation: { type: 'boolean' },
    requires_manager_approval: { type: 'boolean' },
    transition: {
      type: ['string', 'null'],
      enum: [...FIELD_STATUS_TRANSITIONS, null],
      description: 'For set_field_status only: the worker-triggered fieldStatus transition',
    },
    problem_type: {
      type: ['string', 'null'],
      enum: [...FIELD_PROBLEM_TYPES, null],
      description: 'For report_problem only: the 7-value problemType, or null when the user did not name one (D2-T8 renders the sub-menu)',
    },
  },
  required: [
    'intent', 'confidence', 'task_reference', 'field', 'new_value',
    'params', 'missing_fields', 'clarification',
    'requires_confirmation', 'requires_manager_approval',
  ],
};

// Zod validator — tolerant of missing optionals so a slightly-off model response
// still parses; we normalise to the full AIIntentResult shape.
// The v2 `transition` / `problem_type` enums are strict (no `.catch`): an
// out-of-set value must be rejected so the router never dispatches a bogus
// fieldStatus write. `null` and absence are both fine (the router asks).
const rawSchema = z.object({
  intent: z.enum(AI_INTENTS).catch('unknown'),
  confidence: z.number().min(0).max(1).catch(0),
  task_reference: z.string().nullish().transform((v) => v ?? null),
  field: z.string().nullish().transform((v) => v ?? null),
  new_value: z.unknown().optional(),
  params: z.record(z.string(), z.unknown()).nullish().transform((v) => v ?? {}),
  missing_fields: z.array(z.string()).nullish().transform((v) => v ?? []),
  clarification: z.string().nullish().transform((v) => v ?? null),
  requires_confirmation: z.boolean().nullish().transform((v) => v ?? false),
  requires_manager_approval: z.boolean().nullish().transform((v) => v ?? false),
  transition: z.enum(FIELD_STATUS_TRANSITIONS).nullish().transform((v) => v ?? null),
  problem_type: z.enum(FIELD_PROBLEM_TYPES).nullish().transform((v) => v ?? null),
});

/** Validate & normalise a raw model output into an AIIntentResult. */
export function parseIntentResult(raw: unknown): AIIntentResult {
  const r = rawSchema.parse(raw);
  return {
    intent: r.intent,
    confidence: r.confidence,
    task_reference: r.task_reference,
    field: r.field,
    new_value: r.new_value ?? null,
    params: r.params,
    missing_fields: r.missing_fields,
    clarification: r.clarification,
    requires_confirmation: r.requires_confirmation,
    requires_manager_approval: r.requires_manager_approval,
    transition: r.transition,
    problem_type: r.problem_type,
  };
}
