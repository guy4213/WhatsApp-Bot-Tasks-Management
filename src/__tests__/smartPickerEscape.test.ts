/**
 * UX-T1 — smartPickerEscape.ts tests.
 *
 * Pure classifier: no DB, no router import. `parseIntent` is injected via
 * `SmartEscapeDeps` so every case below builds a fake parser and asserts on
 * `classifySmartPickerEscape`'s returned decision.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AIIntent, AIIntentResult } from '../types';
import type { ConversationState } from '../services/conversationContext';
import { classifySmartPickerEscape, FLOW_INTENT_BY_STATE } from '../ai/smartPickerEscape';

/** Minimal-but-valid AIIntentResult fixture — only `intent`/`confidence` vary
 *  across tests; the rest are filled with neutral defaults since the
 *  classifier never reads them. */
function makeIntent(intent: AIIntent, confidence: number): AIIntentResult {
  return {
    intent,
    confidence,
    task_reference: null,
    field: null,
    new_value: null,
    params: {},
    missing_fields: [],
    clarification: null,
    requires_confirmation: false,
    requires_manager_approval: false,
  };
}

function makeCtx(awaiting: ConversationState['awaiting']): ConversationState {
  return { awaiting };
}

/** Same as makeIntent, but lets a test smuggle in a non-numeric `confidence`
 *  (e.g. a malformed parser response) without resorting to `any`. */
function makeIntentWithRawConfidence(intent: AIIntent, confidence: unknown): AIIntentResult {
  return { ...makeIntent(intent, 0), confidence: confidence as number };
}

describe('classifySmartPickerEscape', () => {
  it('returns passthrough for a pure menu-like state (menu) without calling parseIntent', async () => {
    const parseIntent = vi.fn().mockResolvedValue(null);
    const decision = await classifySmartPickerEscape('משהו', makeCtx('menu'), { parseIntent });

    expect(decision).toEqual({ kind: 'passthrough' });
    expect(parseIntent).not.toHaveBeenCalled();
  });

  it('returns passthrough for a pure menu-like state (mgr_menu_root) without calling parseIntent', async () => {
    const parseIntent = vi.fn().mockResolvedValue(null);
    const decision = await classifySmartPickerEscape('משהו', makeCtx('mgr_menu_root'), { parseIntent });

    expect(decision).toEqual({ kind: 'passthrough' });
    expect(parseIntent).not.toHaveBeenCalled();
  });

  it('returns merge when the parsed intent matches the flow owner', async () => {
    // assign_lead_pick_lead → owned by 'assign_lead' (see FLOW_INTENT_BY_STATE)
    expect(FLOW_INTENT_BY_STATE.assign_lead_pick_lead).toBe('assign_lead');
    const parsed = makeIntent('assign_lead', 0.4); // confidence irrelevant when intents match
    const parseIntent = vi.fn().mockResolvedValue(parsed);

    const decision = await classifySmartPickerEscape(
      'שייך את הליד לדני',
      makeCtx('assign_lead_pick_lead'),
      { parseIntent },
    );

    expect(decision.kind).toBe('merge');
    expect(decision.kind === 'merge' && decision.intent).toBe(parsed);
  });

  it('returns pivot on a different intent at high confidence (0.9)', async () => {
    expect(FLOW_INTENT_BY_STATE.assign_lead_pick_lead).toBe('assign_lead');
    const parsed = makeIntent('schedule_task_field', 0.9);
    const parseIntent = vi.fn().mockResolvedValue(parsed);

    const decision = await classifySmartPickerEscape(
      'לתזמן ביקור מחר ב-10',
      makeCtx('assign_lead_pick_lead'),
      { parseIntent },
    );

    expect(decision.kind).toBe('pivot');
    expect(decision.kind === 'pivot' && decision.intent).toBe(parsed);
  });

  it('returns redisplay on a different intent at low confidence (0.5)', async () => {
    const parsed = makeIntent('schedule_task_field', 0.5);
    const parseIntent = vi.fn().mockResolvedValue(parsed);

    const decision = await classifySmartPickerEscape(
      'משהו לא ברור',
      makeCtx('assign_lead_pick_lead'),
      { parseIntent },
    );

    expect(decision).toEqual({ kind: 'redisplay' });
  });

  it('returns redisplay when parseIntent resolves null', async () => {
    const parseIntent = vi.fn().mockResolvedValue(null);

    const decision = await classifySmartPickerEscape(
      '???',
      makeCtx('assign_lead_pick_lead'),
      { parseIntent },
    );

    expect(decision).toEqual({ kind: 'redisplay' });
  });

  it('returns redisplay when parseIntent resolves a non-numeric confidence', async () => {
    const parseIntent = vi.fn().mockResolvedValue(makeIntentWithRawConfidence('assign_lead', 'high'));

    const decision = await classifySmartPickerEscape(
      'כן',
      makeCtx('assign_lead_pick_lead'),
      { parseIntent },
    );

    expect(decision).toEqual({ kind: 'redisplay' });
  });

  it('respects a custom confHigh threshold', async () => {
    const parsed = makeIntent('schedule_task_field', 0.7);
    const parseIntent = vi.fn().mockResolvedValue(parsed);

    const decision = await classifySmartPickerEscape(
      'לתזמן ביקור',
      makeCtx('assign_lead_pick_lead'),
      { parseIntent, confHigh: 0.65 },
    );

    expect(decision.kind).toBe('pivot');
    expect(decision.kind === 'pivot' && decision.intent).toBe(parsed);
  });
});
