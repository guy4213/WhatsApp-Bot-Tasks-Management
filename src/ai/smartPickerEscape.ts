/**
 * UX-T1 — Smart Picker Escape (pure classifier).
 *
 * The 18 `NUMERIC_PICKER_AWAITING` states in `src/ai/router.ts` reject free
 * text and (historically) escaped via `clearContext + handleAIMessage`,
 * wiping any partial selection and restarting the flow. This module is the
 * pure decision-tree that replaces that blunt escape with a
 * context-preserving "smart picker escape": given the current awaiting
 * state and a freshly parsed intent, decide whether to merge into the
 * in-progress flow, pivot to a different flow (with confirmation), redisplay
 * the current picker, or fall through to the legacy passthrough path.
 *
 * NO side effects. NO import from router.ts. `parseIntent` is injected via
 * `SmartEscapeDeps` so this module stays deterministic and unit-testable
 * without touching the AI layer or the DB.
 */
import type { AIIntentResult } from '../types';
import type { AwaitingKind, ConversationState } from '../services/conversationContext';

/** In-progress-selection states → the AIIntent string that owns that flow.
 *  States NOT in this map (pure menu/nav: menu, mgr_menu_root, finished_followup,
 *  day_summary_choice, etc.) intentionally fall through to legacy behavior. */
export const FLOW_INTENT_BY_STATE: Partial<Record<AwaitingKind, string>> = {
  assign_lead_pick_lead:    'assign_lead',
  assign_lead_pick_worker:  'assign_lead',
  assign_lead_confirm:      'assign_lead',
  schedule_intake_pick_task:'schedule_task_field',
  schedule_pick_from_search:'schedule_task_field',
  schedule_confirm:         'schedule_task_field',
  reassign_pick_worker:     'reassign_task',
  reassign_confirm:         'reassign_task',
  correct_site_pick_field:  'correct_task_field_site',
  correct_site_confirm:     'correct_task_field_site',
  correct_type_confirm:     'correct_inspection_type',
  // manager pickers that carry a selected row/worker:
  mgr_today_pick_task:      'list_today_field_inspections',
  mgr_my_today_pick_task:   'list_my_inspections',
  mgr_exceptions_pick_row:  'list_open_exceptions',
  mgr_leads_pick_row:       'list_pending_leads',
  mgr_workers_pick_worker:  'workers_day_overview',
  mgr_search_pick_task:     'search_task',
  // manager sub-menus (navigation depth, but still map so same-intent = stay):
  mgr_exceptions_sub:       'list_open_exceptions',
  mgr_leads_sub:            'list_pending_leads',
  mgr_workers_sub:          'workers_day_overview',
  mgr_search_sub:           'search_task',
};

export type SmartEscapeDecision =
  | { kind: 'merge';       intent: AIIntentResult }  // same intent → caller merges + advances
  | { kind: 'pivot';       intent: AIIntentResult }  // different high-conf intent → pivot_confirm
  | { kind: 'redisplay' }                            // unclear / low-conf → re-prompt, keep state
  | { kind: 'passthrough' };                         // menu-like state OR parse failed → legacy path

export interface SmartEscapeDeps {
  /** Already-bound parser: returns the parsed intent, or null on any failure. */
  parseIntent: (text: string) => Promise<AIIntentResult | null>;
  confHigh?: number; // default 0.85
}

/**
 * Decision logic (implemented EXACTLY per the UX-T1 shared contract):
 * 1. `flowIntent = FLOW_INTENT_BY_STATE[ctx.awaiting]`. If undefined → `passthrough`.
 * 2. `intent = await deps.parseIntent(text)`. If null / confidence not a number → `redisplay`.
 * 3. If `intent.intent === flowIntent` → `merge`.
 * 4. Else if `intent.confidence >= (deps.confHigh ?? 0.85)` → `pivot`.
 * 5. Else → `redisplay`.
 */
export async function classifySmartPickerEscape(
  text: string,
  ctx: ConversationState,
  deps: SmartEscapeDeps,
): Promise<SmartEscapeDecision> {
  const flowIntent = FLOW_INTENT_BY_STATE[ctx.awaiting];
  if (flowIntent === undefined) {
    return { kind: 'passthrough' };
  }

  const intent = await deps.parseIntent(text);
  if (intent === null || typeof intent.confidence !== 'number') {
    return { kind: 'redisplay' };
  }

  if (intent.intent === flowIntent) {
    return { kind: 'merge', intent };
  }

  const confHigh = deps.confHigh ?? 0.85;
  if (intent.confidence >= confHigh) {
    return { kind: 'pivot', intent };
  }

  return { kind: 'redisplay' };
}
