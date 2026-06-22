import { z } from 'zod';
import type { AIIntentResult } from '../types';

// The set of intents the model may emit.
export const AI_INTENTS = [
  'list_tasks',
  'get_task',
  'create_task',
  'edit_field',
  'edit_duedate',
  'reassign_task',
  'relink_task',
  'confirm_pending_action',
  'decline_pending_action',
  'team_workload',
  'help',
  'unknown',
] as const;

// Editable fields the model may target with edit_field.
export const EDITABLE_FIELDS = ['title', 'description', 'priority', 'type'] as const;
export const TASK_FILTERS = ['today', 'this_week', 'open', 'next_deadline', 'overdue', 'unlinked', 'all'] as const;

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
    task_reference: { type: ['string', 'null'], description: 'Free text describing which task the user means' },
    field: { type: ['string', 'null'], description: 'Field to edit for edit_field intent' },
    new_value: { description: 'New value for an edit intent (string, number, or null)' },
    params: {
      type: 'object',
      additionalProperties: true,
      description: 'Intent-specific extras: title, type, dueDate (ISO), priority, filter, ownerId, customerId, leadId, projectId',
    },
    missing_fields: { type: 'array', items: { type: 'string' } },
    clarification: { type: ['string', 'null'], description: 'A short question in Hebrew to ask the user when info is missing or ambiguous' },
    requires_confirmation: { type: 'boolean' },
    requires_manager_approval: { type: 'boolean' },
  },
  required: [
    'intent', 'confidence', 'task_reference', 'field', 'new_value',
    'params', 'missing_fields', 'clarification',
    'requires_confirmation', 'requires_manager_approval',
  ],
};

// Zod validator — tolerant of missing optionals so a slightly-off model response
// still parses; we normalise to the full AIIntentResult shape.
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
  };
}
