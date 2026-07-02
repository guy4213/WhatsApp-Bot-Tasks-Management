/**
 * AI router — orchestrates: parse → threshold-route → clarify → resolve task →
 * dispatch to the existing routes (which keep confirm-before-write intact).
 *
 * Reads (list/get) call the service layer directly. Writes go through the HTTP
 * routes via dispatchInternal so validation, pending-action creation, the
 * confirm prompt, and audit logging all run exactly as in Phase 2/3.
 */
import type {
  AIIntentResult, FieldProblemType, FieldStatusTransition,
  ResolvedUser, TaskFilter, TaskListItem,
} from '../types';
import { TASK_TYPE_LABELS } from '../types';
import { getProvider } from './provider';
import { parseIntent } from './intentParser';
import { resolveTask } from './taskResolver';
import {
  getContext, setContext, clearContext,
  type ConversationState, type AwaitingKind,
} from '../services/conversationContext';
import { setViewOwners, getViewOwners, clearViewOwners } from '../services/viewContext';
import { setActiveTask, getActiveTask } from '../services/taskContext';
import { getHistory, appendTurn } from '../services/chatHistory';
import {
  listTasks, getTaskById, getAllowedTaskTypes, getAllowedPriorities, findUsersByName,
} from '../services/tasks';
import { sendTextMessage, sendButtonMessage, sendListMessage } from '../whatsapp/sender';
import { writeAuditLog } from '../utils/auditLog';
import { moduleLogger } from '../utils/logger';
import {
  MENU_TRIGGER_RE, menuItemsFor, renderMenu, type MenuRoute,
  problemTypeMenu, renderProblemTypeMenu,
  statusUpdateMenu, renderStatusUpdateMenu,
  finishedFollowUpMenu, renderFinishedFollowUpMenu,
  daySummaryFollowUpMenu, renderDaySummaryFollowUpMenu,
} from './menu';
import {
  findOpenTaskFieldForWorker,
  resolveOpenTaskFieldByHint,
  advanceFieldStatus,
  writeFieldNotes,
  writeMissingInfo,
  writeProblem,
  notifyOfficeMissingInfo,
  notifyOfficeProblem,
  notifyOfficeMissingEquipment,
  dayFieldSummary,
  confirmInspection,
  declineInspection,
  requestMoreInfo,
  notifyOfficeDeclined,
  notifyOfficeNeedsMoreInfo,
  type AdvanceTransition,
} from '../services/inspections';
import { getManagersForBroadcast } from '../services/pendingActions';
import { getInspectionsForWorkerOnDate } from '../services/inspectionsQueries';
import { formatDayFieldSummary, formatInspectorDayList } from '../whatsapp/digestContent';
import {
  matchDigestCommand, planDigestCommand, type DigestCommand,
} from './digestCommands';
import {
  getEffectiveDigestPreference, upsertDigestPreference, parseTimeInput,
  type DigestPreference,
} from '../services/digestPreferences';
import { getEmployeeEndOfDay, getCompanyEndOfDay } from '../services/tasks';
import { formatEmployeeEndOfDay, formatManagerEndOfDay } from '../whatsapp/digestContent';
// D3-T6: Sasha lead-assignment via WhatsApp.
import { isLeadsViewer } from '../services/specialUsers';
// Manager menu: unified 6-item manager menu view queries.
import {
  getManagementSnapshot,
  getTodayFieldInspections,
  getFieldExceptionRows,
  getAllWorkersDayOverview,
  getWorkerDayDetail,
  searchTasksByWorkerName,
  searchTasksByProductCode,
  getTaskFieldDetail,
  getTaskFieldValuesForContext,
  type TodayFieldInspectionRow,
} from '../services/managerViews';
import { isManagerMenuUser } from './menu';
import {
  findUnassignedLeadsForAssignment,
  findActiveInspectors,
  assignLead,
} from '../services/incomingLeads';
import { suggestWorkerForLead } from './leadSuggester';
import {
  extractFromContext, extractNote, extractInspectionActions,
  type ExtractionRequest, type InspectionActionExtractionItem,
} from './contextExtractor';
// Display helpers for manager-menu inspection list rows and detail views (Bug 2 fix).
import {
  hebrewShortLabel,
  formatHebrewDateTime,
  formatInspectionListRow,
  formatInspectionDetail,
  formatLeadListRow,
  fieldStatusHe as inspFieldStatusHe,
  type InspectionListRowData,
  type InspectionDetailData,
  type LeadListRowData,
} from './inspectionFormatters';
// D2-T12/T13/T14: site metadata correction, task reassign, inspection type correction.
import {
  updateSiteMetadata,
  reassignTask,
  correctInspectionType,
  ClosedInspectionError,
  listInspectionTypes,
  getTaskFieldForCorrection,
} from '../services/taskFieldCorrections';
// D2-T11: schedule a new TaskField for an existing Task from WhatsApp.
import {
  findOpenTasksForOwner,
  findOpenTasksForAdmin,
  findCustomersByName,
  findOpenTasksForCustomer,
  scheduleTaskField,
  type TaskCandidate,
} from '../services/taskFieldScheduling';

const log = moduleLogger('ai-router');

const CONF_HIGH = parseFloat(process.env.AI_CONFIDENCE_HIGH ?? '0.85');
const CONF_LOW  = parseFloat(process.env.AI_CONFIDENCE_LOW  ?? '0.60');

// ── Free-text escape hatch for numeric-only awaiting states ────────────────
// The v2 UX contract: the user can type or record free text at ANY time and
// the AI must try to understand it — never be trapped inside a numeric picker
// after asking a question about the currently-displayed item. The states
// listed below are numeric pickers (they expect a number / short nav word);
// any free-text reply escapes to the AI parser via `handleAIMessage`. States
// NOT listed here are either text-capture (missing_info_note, decline_reason,
// notes, search queries, time/duration prompts) OR already handle text
// intelligently (task-hint pickers) — do NOT add them or the capture breaks.
const NUMERIC_PICKER_AWAITING: Set<AwaitingKind> = new Set<AwaitingKind>([
  // Worker + role menus.
  'menu',
  'problem_type_choice', 'status_choice', 'finished_followup', 'day_summary_choice',
  // Confirmations.
  'reassign_confirm', 'correct_site_confirm', 'correct_type_confirm', 'schedule_confirm',
  'assign_lead_confirm',
  // Numbered pickers.
  'reassign_pick_worker',
  'correct_site_pick_field',
  // NOTE: `correct_type_pick_from_list` is intentionally OMITTED — its handler
  // treats free text as a search filter over the inspection-type catalog, so
  // escaping to the AI would break the search-refine loop.
  'schedule_intake_pick_task', 'schedule_pick_from_search',
  'assign_lead_pick_lead', 'assign_lead_pick_worker',
  // Manager menu system — top-level, sub-menus, list pickers.
  // NOTE: mgr_*_action states are intentionally EXCLUDED — they handle free-text
  // via context-aware AI extraction (handleMgrActionFreeText) rather than escaping
  // to the generic AI parser, which would lose the taskFieldId context.
  'mgr_menu_root',
  'mgr_exceptions_sub', 'mgr_leads_sub', 'mgr_workers_sub', 'mgr_search_sub',
  'mgr_today_pick_task',
  'mgr_exceptions_pick_row',
  'mgr_leads_pick_row',
  'mgr_workers_pick_worker',
  'mgr_search_pick_task',
]);

// Nav words a numeric picker will accept without escaping to AI: pure digits,
// Hebrew/English navigation vocabulary, or interactive button/list payload IDs
// (CONFIRM_*, MGR_MENU_*, ACTION_*) that arrive from tapped WhatsApp buttons.
const NUMERIC_PICKER_NAV_RE = /^(?:\d+|חזרה|ביטול|עצור|אישור|כן|לא|חיפוש|yes|no|cancel|ok|CONFIRM_(?:YES|NO|EDIT)_\w+|MGR_MENU_\d+|ACTION_(?:CORRECT_SITE|CORRECT_TYPE|REASSIGN|BACK))$/i;

// Payload IDs for the multi-action confirmation buttons.
const CONFIRM_YES_MULTI = 'CONFIRM_YES_MULTI_ACTION';
const CONFIRM_NO_MULTI  = 'CONFIRM_NO_MULTI_ACTION';

/** True when `trimmed` is either digits or a known picker navigation word. */
function looksLikeNumericPickerInput(trimmed: string): boolean {
  return NUMERIC_PICKER_NAV_RE.test(trimmed);
}

// How many tasks to fetch/show in a list (override with LIST_TASKS_LIMIT).
const LIST_LIMIT = parseInt(process.env.LIST_TASKS_LIMIT ?? '100', 10);
// WhatsApp rejects text bodies over 4096 chars; chunk safely below that.
const WA_MAX_CHARS = 3500;

/**
 * Send a possibly-long message as several WhatsApp messages, splitting on line
 * boundaries so a long task list is never truncated by Meta's 4096-char cap.
 */
async function sendChunked(to: string, text: string): Promise<void> {
  if (text.length <= WA_MAX_CHARS) {
    await sendTextMessage({ to, text });
    return;
  }
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf && buf.length + line.length + 1 > WA_MAX_CHARS) {
      await sendTextMessage({ to, text: buf });
      buf = '';
    }
    buf = buf ? `${buf}\n${line}` : line;
    while (buf.length > WA_MAX_CHARS) {
      await sendTextMessage({ to, text: buf.slice(0, WA_MAX_CHARS) });
      buf = buf.slice(WA_MAX_CHARS);
    }
  }
  if (buf) await sendTextMessage({ to, text: buf });
}

// NOTE: \b (ASCII word boundary) does NOT work after Hebrew letters, so a bare
// "כן"/"לא" never matched. Use a negative lookahead for a following letter/digit
// (Hebrew or Latin) instead — matches "כן", "כן בבקשה", "yes" but not "yesterday"
// or "לאט".
export const YES_RE = /^(כן|אישור|אשר|תאשר|מאשר|בצע|בטח|אוקיי|אוקי|סבבה|yes|y|ok)(?![א-תa-z0-9])/i;
export const NO_RE  = /^(לא|ביטול|בטל|עצור|אל\s+תבצע|no|n)(?![א-תa-z0-9])/i;
// Correction: user wants to revise (not approve, not cancel). Only genuine
// correction words — NOT "שנה"/"תקן", which begin real edit commands
// ("שנה את הכותרת", "תקן את התיאור") and must stay fresh requests.
export const CORRECTION_RE = /^(תיקון|רגע|לא לזה התכוונתי|לא לזה)(?![א-תa-z0-9])/i;

// ── Entry point ────────────────────────────────────────────────────────────────

export async function handleAIMessage(user: ResolvedUser, text: string): Promise<void> {
  // Deterministic digest follow-up commands / quick-reply button taps. Handled
  // FIRST — before the AI provider check, before context, before NLU — so a
  // tapped digest button (its payload id arrives here as text) or the exact text
  // command always routes the same way and never depends on the AI parser.
  const digestCmd = matchDigestCommand(text);
  if (digestCmd) {
    await handleDigestCommand(user, digestCmd);
    return;
  }

  // D2-T9 equipment reminder button taps. The payload arrives here as text
  // (webhook routes `interactive.button_reply.id` through the same text path);
  // route deterministically ahead of AI/NLU + context. Not-my-userId taps are
  // ignored silently — a stale button belonging to another user should never
  // hand control back to the AI parser for the tapping user.
  const equipTap = matchEquipmentTap(text);
  if (equipTap) {
    if (equipTap.userId !== user.id) {
      log.warn(
        { from: user.id, embeddedUserId: equipTap.userId, kind: equipTap.kind },
        'equipment tap ignored — payload userId does not match caller',
      );
      return;
    }
    await handleEquipmentTap(user, equipTap.kind, equipTap.localDate);
    return;
  }

  // D2-T3 inspection-card button taps. Same routing rationale as the equipment
  // reminder — payload arrives here as text via webhook.ts's interactive path.
  // The payload embeds the `TaskField.id`; ownership is enforced by the DB
  // write (the caller could only have received the card if they are the owner,
  // but the write path re-verifies via Task.ownerId → User in DoDs downstream).
  const inspTap = matchInspectionCardTap(text);
  if (inspTap) {
    await handleInspectionCardTap(user, inspTap.kind, inspTap.taskFieldId);
    return;
  }

  // MGR_MENU_N list-tap with no active context: treat as if user is at mgr_menu_root.
  // This handles stale-context scenarios where context cleared between the list-message
  // send and the tap arriving.
  if (/^MGR_MENU_\d+$/i.test(text.trim()) && isManagerMenuUser(user)) {
    await setContext(user.phone, { awaiting: 'mgr_menu_root' });
    await continueConversation(user, text.trim(), { awaiting: 'mgr_menu_root' });
    return;
  }

  if (!getProvider()) {
    await sendTextMessage({ to: user.phone, text: 'שירות ה-AI אינו מוגדר עדיין. נסה שוב מאוחר יותר.' });
    return;
  }

  // Mid-conversation? Continue the clarification flow.
  const ctx = await getContext(user.phone);
  if (ctx) {
    await continueConversation(user, text, ctx);
    return;
  }

  // Fresh message that is exactly a menu trigger (menu/תפריט/עזרה/היי/שלום) →
  // open the role-based numbered menu. Any other text falls through to the AI
  // parser unchanged, so existing free-text behavior is fully preserved.
  if (MENU_TRIGGER_RE.test(text.trim())) {
    await showMenu(user);
    return;
  }

  // ── Layer 2: bare-digit guard ────────────────────────────────────────────────
  // If a manager-menu user types a single digit (1–9) with NO active context,
  // treat it as a menu pick rather than sending it to the AI parser.
  // This prevents the scenario: show menu → item 1 (snapshot) → context
  // cleared → "2" gets routed through the AI parser which may recycle stale
  // chat history and produce an unrelated search result.
  //
  // We re-open the menu (which sets awaiting:'mgr_menu_root') and then
  // immediately dispatch the digit to handleMgrMenuRootReply by passing a
  // synthetic mgr_menu_root context. This avoids a second getContext() call
  // whose cached mock value might not yet reflect the freshly-set context.
  //
  // Worker users are intentionally excluded — their bare digits (e.g. picker
  // selections in an inspection flow) are NOT the same pattern and they do not
  // have a persistent manager-root menu to fall back to.
  const trimmedForGuard = text.trim();
  if (/^[1-9]$/.test(trimmedForGuard) && isManagerMenuUser(user)) {
    await showMenu(user);          // sets awaiting: 'mgr_menu_root' + sends menu text
    // Immediately route the digit as if the user replied to the freshly-shown menu.
    await continueConversation(user, trimmedForGuard, { awaiting: 'mgr_menu_root' });
    return;
  }

  // Fresh message → parse, with the recent rolling window for reference resolution.
  let intent: AIIntentResult;
  try {
    const [allowedTypes, allowedPriorities, history] = await Promise.all([
      getAllowedTaskTypes(),
      safePriorities(),
      getHistory(user.phone),
    ]);
    intent = await parseIntent(text, { user, allowedTypes, allowedPriorities, history });
  } catch (err) {
    log.error({ err }, 'Intent parse failed');
    await sendTextMessage({ to: user.phone, text: 'שגיאה בעיבוד הבקשה. נסה שוב או נסח מחדש.' });
    return;
  }

  // Record the user's turn AFTER parsing (so it isn't fed back into its own parse).
  await appendTurn(user.phone, 'user', text);

  await routeIntent(user, intent, text);
}

// ── Threshold routing ──────────────────────────────────────────────────────────

async function routeIntent(
  user: ResolvedUser,
  intent: AIIntentResult,
  originalText?: string,
): Promise<void> {
  // 1. Unknown or very low confidence → use the model's Hebrew clarification when it
  //    provided one (status-change / out-of-scope answers), else ask to rephrase.
  //    Either way, record the event in the audit log.
  if (intent.intent === 'unknown' || intent.confidence < CONF_LOW) {
    await auditEvent(user, 'unknown', null, 'SKIPPED', intent.clarification ?? 'unrecognized request');

    // Layer 4 fix: for a manager-menu user with a very short input (≤3 chars),
    // SHOW the menu directly instead of printing a generic hint. The model correctly
    // returned 'unknown' for a bare digit (per the Layer 3 system-prompt rule), but
    // a bare digit for a manager-menu user almost certainly means a menu pick, so we
    // re-open the menu so they can try again with clear context visible.
    if (isManagerMenuUser(user) && originalText !== undefined) {
      const trimmedInput = originalText.trim();
      if (trimmedInput.length <= 3) {
        await showMenu(user);
        return;
      }
    }

    const mgrSuffix = isManagerMenuUser(user)
      ? '\nתרצה לראות את התפריט? כתוב "תפריט".'
      : '';
    await sendTextMessage({
      to: user.phone,
      text: (intent.clarification
        ?? 'לא הצלחתי להבין את הבקשה. נסה לנסח מחדש, למשל: "צור משימה תיאום ללקוח X" או "הצג את המשימות שלי להיום".') + mgrSuffix,
    });
    return;
  }

  // 2. Missing required info → ask for the first missing field.
  // If the only thing missing is WHICH task and the user just acted on one,
  // reuse that active task instead of asking again (resolveOrAsk picks it up).
  if (
    intent.intent === 'get_task' &&
    intent.missing_fields.includes('task_reference') &&
    getActiveTask(user.phone)
  ) {
    intent.missing_fields = intent.missing_fields.filter((f) => f !== 'task_reference');
  }
  if (intent.missing_fields.length > 0) {
    const field = intent.missing_fields[0];
    await setContext(user.phone, { awaiting: 'missing_field', intent, missingField: field });
    await sendTextMessage({
      to: user.phone,
      text: intent.clarification ?? `אנא ציין ${field}.`,
    });
    return;
  }

  // 3. Medium confidence → confirm intent before acting
  if (intent.confidence < CONF_HIGH) {
    await setContext(user.phone, { awaiting: 'intent_confirm', intent });
    await sendTextMessage({
      to: user.phone,
      text: `${describeIntent(intent)}\nהאם להמשיך? השב "כן" או "לא".`,
    });
    return;
  }

  // 4. High confidence → execute
  await executeIntent(user, intent);
}

// ── Continuation (clarification loop) ───────────────────────────────────────────

async function continueConversation(
  user: ResolvedUser,
  text: string,
  ctx: ConversationState,
): Promise<void> {
  const trimmed = text.trim();

  // Correction request — pause the pending action and ask the user to restate.
  // Only when it's a short standalone correction (so "שנה את הכותרת…" stays a new request).
  if (CORRECTION_RE.test(trimmed) && trimmed.split(/\s+/).length <= 4) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בסדר, לא ביצעתי כלום. נסח מחדש מה לתקן ואטפל בזה.' });
    return;
  }

  // ── Free-text escape hatch (v2 UX contract) ─────────────────────────────
  // If we're in a numeric-picker awaiting state (see NUMERIC_PICKER_AWAITING)
  // and the user typed free-text — a question, a command, a description —
  // rather than a number or nav word, clear the context and re-enter the
  // fresh-message path so the AI parser can try to understand it. This is
  // what makes free text + voice work "at any time", including while a
  // manager is viewing a specific inspection's detail card.
  if (
    NUMERIC_PICKER_AWAITING.has(ctx.awaiting) &&
    !looksLikeNumericPickerInput(trimmed)
  ) {
    await clearContext(user.phone);
    await handleAIMessage(user, text);
    return;
  }

  // ── Numbered menu + digest-settings flows (these states carry NO AI intent) ──
  if (ctx.awaiting === 'menu') {
    await handleMenuReply(user, trimmed);
    return;
  }
  if (ctx.awaiting === 'digest_settings') {
    await handleDigestSettingsReply(user, trimmed);
    return;
  }
  if (ctx.awaiting === 'digest_set_time') {
    await handleDigestTimeReply(user, trimmed, ctx);
    return;
  }

  // ── v2 inspector flows (D2-T5 + D2-T6 + D2-T7 + D2-T8) — no AI intent ──────
  if (ctx.awaiting === 'missing_info_note') {
    await handleMissingInfoNoteReply(user, text, ctx);
    return;
  }
  if (ctx.awaiting === 'problem_type_choice') {
    await handleProblemTypeChoiceReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'problem_type_note') {
    await handleProblemTypeNoteReply(user, text, ctx);
    return;
  }
  if (ctx.awaiting === 'missing_info_disambig') {
    await handleDisambigReply(user, trimmed, 'missing_info');
    return;
  }
  if (ctx.awaiting === 'problem_disambig') {
    await handleDisambigReply(user, trimmed, 'problem');
    return;
  }
  if (ctx.awaiting === 'status_disambig') {
    await handleDisambigReply(user, trimmed, 'status', ctx.pendingTransition);
    return;
  }
  if (ctx.awaiting === 'status_choice') {
    await handleStatusChoiceReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'finished_followup') {
    await handleFinishedFollowUpReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'finished_notes') {
    await handleFinishedNotesReply(user, text, ctx);
    return;
  }
  if (ctx.awaiting === 'day_summary_choice') {
    await handleDaySummaryChoiceReply(user, trimmed);
    return;
  }
  if (ctx.awaiting === 'callback_customer_note') {
    await handleCallbackCustomerNoteReply(user, text);
    return;
  }
  if (ctx.awaiting === 'equipment_missing_note') {
    await handleEquipmentMissingNoteReply(user, text, ctx);
    return;
  }
  if (ctx.awaiting === 'inspection_decline_reason') {
    await handleInspectionDeclineReasonReply(user, text, ctx);
    return;
  }
  if (ctx.awaiting === 'inspection_need_info_note') {
    await handleInspectionNeedInfoNoteReply(user, text, ctx);
    return;
  }

  // D3-T6: Sasha lead-assignment multi-step flow.
  if (ctx.awaiting === 'assign_lead_pick_lead') {
    await handleAssignLeadPickLeadReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'assign_lead_pick_worker') {
    await handleAssignLeadPickWorkerReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'assign_lead_confirm') {
    await handleAssignLeadConfirmReply(user, trimmed, ctx);
    return;
  }

  // D2-T11: schedule TaskField multi-step flow.
  if (ctx.awaiting === 'schedule_intake_pick_task') {
    await handleSchedulePickTaskReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'schedule_search_customer') {
    await handleScheduleSearchCustomerReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'schedule_pick_from_search') {
    await handleSchedulePickFromSearchReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'schedule_await_time') {
    await handleScheduleAwaitTimeReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'schedule_await_duration') {
    await handleScheduleAwaitDurationReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'schedule_confirm') {
    await handleScheduleConfirmReply(user, trimmed, ctx);
    return;
  }

  // D2-T12: correct site metadata on a TaskField.
  if (ctx.awaiting === 'correct_site_pick_task' || ctx.awaiting === 'correct_site_pick_field') {
    // Re-use the existing resolveAndShowSiteFieldMenu path with the free-text hint.
    const intent = ctx.intent;
    if (!intent) { await clearContext(user.phone); await handleAIMessage(user, text); return; }
    await resolveAndShowSiteFieldMenu(user, intent, trimmed);
    return;
  }
  if (ctx.awaiting === 'correct_site_await_value') {
    await handleCorrectSiteAwaitValueReply(user, text, ctx);
    return;
  }
  if (ctx.awaiting === 'correct_site_confirm_extracted') {
    await handleCorrectSiteConfirmExtractedReply(user, trimmed, ctx);
    return;
  }

  // D2-T13: reassign a Task to another worker.
  if (ctx.awaiting === 'reassign_pick_task') {
    const intent = ctx.intent;
    if (!intent) { await clearContext(user.phone); await handleAIMessage(user, text); return; }
    await resolveAndShowWorkerListForReassign(user, intent, trimmed);
    return;
  }
  if (ctx.awaiting === 'reassign_pick_worker') {
    await handleReassignPickWorkerReply(user, trimmed, ctx);
    return;
  }

  // D2-T14: correct inspection type.
  if (ctx.awaiting === 'correct_type_pick_task' || ctx.awaiting === 'correct_type_await_search') {
    const intent = ctx.intent;
    if (!intent) { await clearContext(user.phone); await handleAIMessage(user, text); return; }
    await resolveAndShowTypeList(user, intent, trimmed);
    return;
  }
  if (ctx.awaiting === 'correct_type_pick_from_list') {
    await handleCorrectTypePickFromListReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'correct_type_confirm') {
    await handleCorrectTypeConfirmReply(user, trimmed, ctx);
    return;
  }

  // Manager menu: unified 6-item manager menu flows.
  if (ctx.awaiting === 'mgr_menu_root') {
    await handleMgrMenuRootReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'mgr_exceptions_sub') {
    await handleMgrExceptionsSubReply(user, trimmed);
    return;
  }
  if (ctx.awaiting === 'mgr_leads_sub') {
    await handleMgrLeadsSubReply(user, trimmed);
    return;
  }
  if (ctx.awaiting === 'mgr_workers_sub') {
    await handleMgrWorkersSubReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'mgr_search_sub') {
    await handleMgrSearchSubReply(user, trimmed);
    return;
  }
  if (ctx.awaiting === 'mgr_today_pick_task') {
    await handleMgrTodayPickTaskReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'mgr_today_action') {
    await handleMgrTaskActionReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'mgr_exceptions_pick_row') {
    await handleMgrExceptionsPickRowReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'mgr_exceptions_action') {
    await handleMgrTaskActionReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'mgr_leads_pick_row') {
    await handleMgrLeadsPickRowReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'mgr_workers_pick_worker') {
    await handleMgrWorkersPickWorkerReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'mgr_search_await_query') {
    await handleMgrSearchAwaitQueryReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'mgr_search_pick_task') {
    await handleMgrSearchPickTaskReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'mgr_search_action') {
    await handleMgrTaskActionReply(user, trimmed, ctx);
    return;
  }

  if (ctx.awaiting === 'mgr_multi_action_confirm') {
    await handleMgrMultiActionConfirmReply(user, trimmed, ctx);
    return;
  }

  // Every remaining state carries a parsed intent. (Captured into a const so the
  // not-undefined narrowing survives the awaits in the branches below.)
  const ctxIntent = ctx.intent;
  if (!ctxIntent) {
    // Unknown / corrupt state with no intent — reset and treat as a fresh message.
    await clearContext(user.phone);
    await handleAIMessage(user, text);
    return;
  }

  if (ctx.awaiting === 'intent_confirm') {
    if (YES_RE.test(trimmed)) {
      await clearContext(user.phone);
      await executeIntent(user, ctxIntent);
    } else if (NO_RE.test(trimmed)) {
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    } else {
      // Treated as a new request
      await clearContext(user.phone);
      await handleAIMessage(user, text);
    }
    return;
  }

  if (ctx.awaiting === 'missing_field' && ctx.missingField) {
    const intent = applyFieldValue(ctxIntent, ctx.missingField, trimmed);
    const remaining = intent.missing_fields.filter((f) => f !== ctx.missingField);
    intent.missing_fields = remaining;

    if (remaining.length > 0) {
      const next = remaining[0];
      await setContext(user.phone, { awaiting: 'missing_field', intent, missingField: next });
      await sendTextMessage({ to: user.phone, text: `אנא ציין ${next}.` });
    } else {
      await clearContext(user.phone);
      await executeIntent(user, intent);
    }
    return;
  }

  if (ctx.awaiting === 'task_disambig' && ctx.candidateTaskIds) {
    const idx = parseInt(trimmed, 10);
    if (!Number.isInteger(idx) || idx < 1 || idx > ctx.candidateTaskIds.length) {
      await sendTextMessage({ to: user.phone, text: `אנא השב במספר בין 1 ל-${ctx.candidateTaskIds.length}.` });
      return;
    }
    const taskId = ctx.candidateTaskIds[idx - 1];
    await clearContext(user.phone);
    await executeIntent(user, ctxIntent, taskId);
    return;
  }

  // Unknown state — reset
  await clearContext(user.phone);
  await handleAIMessage(user, text);
}

// ── Execution ────────────────────────────────────────────────────────────────

async function executeIntent(
  user: ResolvedUser,
  intent: AIIntentResult,
  resolvedTaskId?: string,
): Promise<void> {
  switch (intent.intent) {
    case 'help':
      await sendTextMessage({ to: user.phone, text: helpText() });
      return;

    case 'get_task': {
      const id = await resolveOrAsk(user, intent, resolvedTaskId);
      if (!id) return;
      await doGetTask(user, id);
      return;
    }

    case 'report_missing_info': {
      // D5-T3 free-text intent — if a note was extracted, skip the sub-prompt.
      const note = typeof intent.params?.note === 'string' ? intent.params.note.trim() : '';
      if (note) {
        await runMissingInfoDirect(user, note);
      } else {
        await startMissingInfoFlow(user);
      }
      return;
    }

    case 'report_problem': {
      // D5-T3 free-text intent — if a problem_type was extracted, write directly;
      // otherwise fall through to the same 7-item sub-menu the menu path uses.
      const problemType = intent.problem_type ?? null;
      const note = typeof intent.params?.note === 'string' ? intent.params.note.trim() : '';
      if (problemType) {
        await runProblemDirect(user, problemType, note || null);
      } else {
        await startReportProblemFlow(user);
      }
      return;
    }

    case 'set_field_status': {
      // D5-T3 free-text / voice intent. WAITING_FOR_INFO + HAS_PROBLEM are
      // separate flows (they need a note / problemType), so re-route them to
      // the corresponding entry points; the direct DEPARTED/ARRIVED/FINISHED
      // path handles the rest.
      const transition = intent.transition ?? null;
      if (transition === 'WAITING_FOR_INFO') {
        const note = typeof intent.params?.note === 'string' ? intent.params.note.trim() : '';
        if (note) {
          await runMissingInfoDirect(user, note);
        } else {
          await startMissingInfoFlow(user);
        }
        return;
      }
      if (transition === 'HAS_PROBLEM') {
        const problemType = intent.problem_type ?? null;
        const note = typeof intent.params?.note === 'string' ? intent.params.note.trim() : '';
        if (problemType) {
          await runProblemDirect(user, problemType, note || null);
        } else {
          await startReportProblemFlow(user);
        }
        return;
      }
      if (transition === 'DEPARTED' || transition === 'ARRIVED' || transition === 'FINISHED') {
        const hint = typeof intent.task_reference === 'string' ? intent.task_reference.trim() : '';
        await runAdvanceStatusDirect(user, transition, hint || null);
        return;
      }
      // No transition supplied — fall through to help.
      await sendTextMessage({ to: user.phone, text: helpText() });
      return;
    }

    // D3-T6: Sasha lead-assignment via WhatsApp.
    case 'assign_lead':
      await startAssignLeadFlow(user);
      return;

    // D2-T11: schedule a new TaskField for an existing Task from WhatsApp.
    case 'schedule_task_field': {
      const startAt = typeof intent.params?.scheduledStartAt === 'string'
        ? intent.params.scheduledStartAt.trim() : null;
      const duration = typeof intent.params?.durationMinutes === 'number'
        ? intent.params.durationMinutes : null;
      const specialInstr = typeof intent.params?.specialInstructions === 'string'
        ? intent.params.specialInstructions.trim() : null;
      await startScheduleTaskFieldFlow(user, startAt, duration, specialInstr);
      return;
    }

    // D2-T12: correct site metadata on a TaskField (address/city/contact).
    case 'correct_task_field_site':
      await startCorrectSiteFlow(user, intent);
      return;

    // D2-T13: reassign a Task to another worker (MANAGER/ADMIN only).
    case 'reassign_task':
      await startReassignTaskFlow(user, intent);
      return;

    // D2-T14: correct inspection type on a TaskField.
    case 'correct_inspection_type':
      await startCorrectInspectionTypeFlow(user, intent);
      return;

    // ── Manager-facing intents (role-aware) ─────────────────────────────────
    // All require isManagerMenuUser(user). Workers get a rejection.

    case 'open_manager_menu':
      if (!isManagerMenuUser(user)) {
        await sendTextMessage({ to: user.phone, text: 'אין הרשאה.' });
        return;
      }
      await showMenu(user);
      return;

    case 'management_snapshot':
      if (!isManagerMenuUser(user)) {
        await sendTextMessage({ to: user.phone, text: 'אין הרשאה.' });
        return;
      }
      await clearContext(user.phone);
      await showMgrSnapshot(user);
      return;

    case 'list_today_field_inspections':
      if (!isManagerMenuUser(user)) {
        await sendTextMessage({ to: user.phone, text: 'אין הרשאה.' });
        return;
      }
      await showMgrTodayInspections(user);
      return;

    case 'list_open_exceptions': {
      if (!isManagerMenuUser(user)) {
        await sendTextMessage({ to: user.phone, text: 'אין הרשאה.' });
        return;
      }
      // Map the optional params.filter to a FieldExceptionFilter.
      const exFilter = typeof intent.params?.filter === 'string'
        ? intent.params.filter.trim()
        : 'open';
      const exFilterMap: Record<string, import('../services/managerViews').FieldExceptionFilter> = {
        open: 'open_exceptions',
        not_confirmed: 'not_confirmed',
        has_problem: 'has_problem',
        waiting_for_info: 'waiting_for_info',
        not_closed: 'not_closed',
        // Aliases that LLM may emit
        open_exceptions: 'open_exceptions',
      };
      const resolvedExFilter: import('../services/managerViews').FieldExceptionFilter =
        exFilterMap[exFilter] ?? 'open_exceptions';
      const localDateEx = localJerusalemDate();
      const exRows = await getFieldExceptionRows(localDateEx, resolvedExFilter);
      if (exRows.length === 0) {
        await showMgrExceptionsSub(user);
        return;
      }
      const exLines = exRows.map((r, i) => {
        const shortLabel = hebrewShortLabel(r.taskTitle, r.workerName ?? '—');
        const city   = r.siteCity ?? '—';
        const status = mgrFieldStatusHe(r.fieldStatus);
        const desc   = r.description ? `\n   ${r.description}` : '';
        return `${i + 1}. ${shortLabel}\n   ${city}  ·  ${status}${desc}`;
      });
      await setContext(user.phone, {
        awaiting: 'mgr_exceptions_pick_row',
        mgrTaskFieldIds: exRows.map((r) => r.taskFieldId),
        mgrTaskIds: exRows.map((r) => r.taskId),
      });
      await sendChunked(user.phone,
        `חריגים (${exRows.length}):\n\n${exLines.join('\n\n')}\n\nבחר מספר לפרטים, או "חזרה".`,
      );
      return;
    }

    case 'list_pending_leads': {
      if (!isManagerMenuUser(user)) {
        await sendTextMessage({ to: user.phone, text: 'אין הרשאה.' });
        return;
      }
      const leadsFilter = typeof intent.params?.filter === 'string'
        ? intent.params.filter.trim()
        : 'unassigned';
      if (leadsFilter === 'escalated') {
        // Show escalation candidates list
        const { findEscalationCandidates } = await import('../services/incomingLeads');
        const escLeads = await findEscalationCandidates(20);
        if (escLeads.length === 0) {
          await sendTextMessage({ to: user.phone, text: 'אין לידים שעברו שעה ללא שיוך כרגע.' });
          return;
        }
        const escLines = escLeads.map((l, i) => {
          const rowData: LeadListRowData = {
            fromName: l.fromName ?? null,
            fromEmail: l.fromEmail ?? null,
            subject: l.subject ?? null,
            receivedAt: l.receivedAt ?? null,
          };
          return `${i + 1}. ${formatLeadListRow(rowData)}`;
        });
        await setContext(user.phone, {
          awaiting: 'mgr_leads_pick_row',
          mgrLeadIds: escLeads.map((l) => l.id),
          mgrLeadNames: escLeads.map((l) => l.fromName ?? '—'),
        });
        await sendChunked(user.phone, `לידים שעברו שעה ללא שיוך (${escLeads.length}):\n\n${escLines.join('\n\n')}\n\nבחר מספר לפרטים, או "חזרה".`);
      } else {
        // Default: unassigned
        const unassLeads = await findUnassignedLeadsForAssignment(20);
        if (unassLeads.length === 0) {
          await sendTextMessage({ to: user.phone, text: 'אין כרגע לידים לא משויכים.' });
          return;
        }
        const unassLines = unassLeads.map((l, i) => {
          const rowData: LeadListRowData = {
            fromName: l.fromName ?? null,
            fromEmail: l.fromEmail ?? null,
            subject: l.subject ?? null,
            receivedAt: l.receivedAt ?? null,
          };
          return `${i + 1}. ${formatLeadListRow(rowData)}`;
        });
        await setContext(user.phone, {
          awaiting: 'mgr_leads_pick_row',
          mgrLeadIds: unassLeads.map((l) => l.id),
          mgrLeadNames: unassLeads.map((l) => l.fromName ?? '—'),
        });
        await sendChunked(user.phone, `לידים לא משויכים (${unassLeads.length}):\n\n${unassLines.join('\n\n')}\n\nבחר מספר לפרטים, או "חזרה".`);
      }
      return;
    }

    case 'workers_day_overview': {
      if (!isManagerMenuUser(user)) {
        await sendTextMessage({ to: user.phone, text: 'אין הרשאה.' });
        return;
      }
      const workerName = typeof intent.params?.workerName === 'string'
        ? intent.params.workerName.trim()
        : null;
      const localDateW = localJerusalemDate();
      if (workerName) {
        // Named worker — find them in today's overview and show detail.
        const allWorkers = await getAllWorkersDayOverview(localDateW);
        const matched = allWorkers.find((w) =>
          w.workerName.includes(workerName) || workerName.includes(w.workerName),
        );
        if (!matched) {
          // Fallback: show the full overview with a note.
          if (allWorkers.length === 0) {
            await sendTextMessage({ to: user.phone, text: `לא נמצאו בדיקות היום עבור "${workerName}".` });
            return;
          }
          const lines = allWorkers.map((r) => `${r.workerName}: ${r.finished}/${r.total} · חריגים ${r.exceptions}`);
          await clearContext(user.phone);
          await sendChunked(user.phone, `לא מצאתי עובד בשם "${workerName}". סיכום יום — ${fmtDDMM(localDateW)}:\n${lines.join('\n')}`);
          return;
        }
        // Show detail for the matched worker.
        const detail = await getWorkerDayDetail(matched.workerId, localDateW);
        const lines = detail.inspections.map((r, i) => {
          const rowData: InspectionListRowData = {
            taskTitle: r.taskTitle,
            typeLabelHe: r.typeLabelHe,
            timeHm: r.timeHm,
            siteCity: r.siteCity,
            fieldStatus: r.fieldStatus,
            dateStr: localDateW,
          };
          return `${i + 1}. ${formatInspectionListRow(rowData)}`;
        });
        const summary = `סיכום: ${detail.finished}/${detail.total} בוצעו, חריגים פתוחים: ${detail.openExceptions}`;
        await clearContext(user.phone);
        await sendChunked(user.phone, `${matched.workerName} — היום (${fmtDDMM(localDateW)}):\n\n${lines.join('\n\n')}\n\n${summary}`);
      } else {
        // All workers table view.
        const allWorkers = await getAllWorkersDayOverview(localDateW);
        if (allWorkers.length === 0) {
          await sendTextMessage({ to: user.phone, text: `אין עובדים עם בדיקות היום (${fmtDDMM(localDateW)}).` });
          return;
        }
        const lines = allWorkers.map((r) => `${r.workerName}: ${r.finished}/${r.total} · חריגים ${r.exceptions}`);
        await clearContext(user.phone);
        await sendChunked(user.phone, `סיכום יום — ${fmtDDMM(localDateW)}:\n${lines.join('\n')}`);
      }
      return;
    }

    case 'search_task': {
      if (!isManagerMenuUser(user)) {
        await sendTextMessage({ to: user.phone, text: 'אין הרשאה.' });
        return;
      }
      const searchBy = typeof intent.params?.searchBy === 'string'
        ? intent.params.searchBy.trim() as 'customer' | 'worker' | 'product'
        : null;
      const query = typeof intent.params?.query === 'string'
        ? intent.params.query.trim()
        : null;

      if (!searchBy && !query) {
        // Nothing specified — show the search sub-menu.
        await showMgrSearchSub(user);
        return;
      }

      if (searchBy && !query) {
        // Know dimension but not the query — prompt for it.
        const promptMap: Record<string, string> = {
          customer: 'שם לקוח / חלק ממנו:',
          worker: 'שם עובד / חלק ממנו:',
          product: 'מק"ט (קוד מוצר):',
        };
        await setContext(user.phone, { awaiting: 'mgr_search_await_query', mgrSearchKind: searchBy });
        await sendTextMessage({ to: user.phone, text: promptMap[searchBy] ?? 'מה לחפש?' });
        return;
      }

      // Both searchBy and query present — run the search directly.
      if (searchBy && query) {
        let searchResults: TodayFieldInspectionRow[] = [];
        if (searchBy === 'customer') {
          const { rows } = await import('../db/connection').then(async ({ pool }) => {
            return pool.query<TodayFieldInspectionRow>(
              `SELECT
                 tf.id AS "taskFieldId", tf."taskId" AS "taskId",
                 u.name AS "workerName",
                 -- Customer name: 6-source COALESCE (SCHEMA_CRM.md) — Task.title/description excluded
                 COALESCE(
                   c.name,
                   l."fullName",
                   NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
                   l.company,
                   p.client,
                   il."fromName"
                 ) AS "customerName",
                 t.title AS "taskTitle",
                 to_char(tf."scheduledStartAt" AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI') AS "timeHm",
                 tf."siteCity" AS "siteCity", tf."fieldStatus" AS "fieldStatus",
                 tf.family AS family, it."labelHe" AS "typeLabelHe"
               FROM "TaskField" tf
               JOIN "Task" t             ON t.id  = tf."taskId"
               JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
               LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
               LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
               LEFT JOIN "Project"      p  ON p.id  = t."projectId"
               LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
               LEFT JOIN "User" u          ON u.id  = t."ownerId"
               WHERE c.name ILIKE '%' || $1 || '%'
               ORDER BY tf."scheduledStartAt" DESC LIMIT 20`,
              [query],
            );
          });
          searchResults = rows;
        } else if (searchBy === 'worker') {
          searchResults = await searchTasksByWorkerName(query);
        } else if (searchBy === 'product') {
          searchResults = await searchTasksByProductCode(query);
        }

        if (searchResults.length === 0) {
          await sendTextMessage({ to: user.phone, text: `לא נמצאו תוצאות עבור "${query}". נסה שוב.` });
          return;
        }

        const srLines = searchResults.map((r, i) => {
          const rowData: InspectionListRowData = {
            taskTitle: r.taskTitle,
            typeLabelHe: r.typeLabelHe,
            timeHm: r.timeHm,
            siteCity: r.siteCity,
            fieldStatus: r.fieldStatus,
            workerName: r.workerName,
          };
          // For product search, include worker in the row; for worker/customer
          // search, the worker/customer is already the search context.
          const showWorker = searchBy === 'product';
          return `${i + 1}. ${formatInspectionListRow(rowData, showWorker)}`;
        });

        await setContext(user.phone, {
          awaiting: 'mgr_search_pick_task',
          mgrTaskFieldIds: searchResults.map((r) => r.taskFieldId),
          mgrTaskIds: searchResults.map((r) => r.taskId),
          mgrSearchKind: searchBy,
        });
        await sendChunked(user.phone,
          `תוצאות חיפוש '${query}' — ${searchResults.length} בדיקות:\n\n${srLines.join('\n\n')}\n\nבחר מספר לפרטים, או "חזרה".`,
        );
      }
      return;
    }

    default:
      await sendTextMessage({ to: user.phone, text: helpText() });
  }
}

/** Record in chat history that an action was taken on the active task, so a
 *  follow-up "same task" reference (task_reference=null) stays anchored to the
 *  right task instead of an older list item. */
async function noteWorkingTask(phone: string): Promise<void> {
  const active = getActiveTask(phone);
  if (active?.title) {
    await appendTurn(phone, 'assistant', `הפעולה האחרונה בוצעה על המשימה "${active.title}".`);
  }
}

/** Resolve the intent's task_reference to an id, or ask the user. Returns null when it has handled messaging itself. */
async function resolveOrAsk(
  user: ResolvedUser,
  intent: AIIntentResult,
  resolvedTaskId?: string,
): Promise<string | null> {
  // A concrete id (task-disambiguation re-entry) — remember it as the active task.
  if (resolvedTaskId) {
    setActiveTask(user.phone, resolvedTaskId);
    return resolvedTaskId;
  }

  const ref = intent.task_reference;
  if (!ref) {
    // No task named — reuse the task the user just acted on, so they can chain
    // actions ("שנה כותרת… עכשיו תקבע עדיפות גבוהה") without re-identifying it.
    const active = getActiveTask(user.phone);
    if (active) return active.taskId;

    await setContext(user.phone, { awaiting: 'missing_field', intent, missingField: 'task_reference' });
    await sendTextMessage({ to: user.phone, text: 'לאיזו משימה הכוונה? ציין שם או תיאור.' });
    return null;
  }

  // If we're currently viewing a specific employee's tasks, narrow the name search
  // to them so "details on X" doesn't pull look-alike titles from other people.
  const viewed = getViewOwners(user.phone);
  const res = await resolveTask(user, ref, viewed?.ownerIds);
  if (res.match) {
    // This task is now the working context for any follow-up actions.
    setActiveTask(user.phone, res.match.id, res.match.title);
    return res.match.id;
  }

  if (res.ambiguous && res.candidates.length > 0) {
    // Show owner + date so near-identical titles can be told apart.
    const lines = res.candidates.map((t, i) => {
      const owner = t.ownerName ? ` — ${t.ownerName}` : '';
      const stamp = t.dueDate ?? t.createdAt;
      const when = stamp ? ` (${fmtDate(stamp)})` : '';
      return `${i + 1}. ${t.title}${owner}${when}`;
    });
    await setContext(user.phone, {
      awaiting: 'task_disambig',
      intent,
      candidateTaskIds: res.candidates.map((t) => t.id),
    });
    await sendTextMessage({ to: user.phone, text: `נמצאו כמה משימות. לאיזו הכוונה?\n${lines.join('\n')}\nהשב במספר.` });
    return null;
  }

  await sendTextMessage({ to: user.phone, text: `לא מצאתי משימה התואמת ל"${ref}".` });
  return null;
}

// ── Read helpers (call services directly) ───────────────────────────────────────

interface ListQuery {
  filter: TaskFilter;
  scope: 'own' | 'all';
  dateField: 'dueDate' | 'createdAt';
  dateFrom?: string;
  dateTo?: string;
  ownerIds?: string[];    // resolved employee filter (elevated only)
  ownerNames?: string[];  // for display
}

/** Fetch + render the task list for menu and digest commands. */
async function runListTasks(user: ResolvedUser, q: ListQuery): Promise<void> {
  log.info(
    { userId: user.id, scope: q.scope, filter: q.filter, dateField: q.dateField, owners: q.ownerIds?.length ?? 0 },
    'Listing tasks',
  );

  const { tasks, truncated } = await listTasks(user, {
    filter: q.filter, scope: q.scope, ownerIds: q.ownerIds, dateField: q.dateField,
    dateFrom: q.dateFrom, dateTo: q.dateTo, limit: LIST_LIMIT,
  });

  await auditEvent(user, 'list_tasks', null, 'SUCCESS');

  // Remember a specific-employee view so follow-up "details on X" narrows to them;
  // a whole-team / own list clears the hint.
  if (q.ownerIds?.length && q.ownerNames?.length) {
    setViewOwners(user.phone, q.ownerIds, q.ownerNames);
  } else {
    clearViewOwners(user.phone);
  }

  if (tasks.length === 0) {
    await appendTurn(user.phone, 'assistant', 'לא נמצאו משימות התואמות לבקשה.');
    const scopeTxt = q.scope === 'all' ? 'של הצוות' : 'שלך';
    const options = [
      '"המשימות שלי"',
      '"מה באיחור"',
      '"המשימות שלי השבוע"',
      '"כל המשימות"',
      ...(user.isElevated ? ['"עומס משימות בצוות"'] : []),
    ].join(' · ');
    await sendTextMessage({
      to: user.phone,
      text:
        `לא מצאתי משימות ${scopeTxt} שתואמות לבקשה.\n` +
        `למה התכוונת? אפשר לנסות: ${options}\n` +
        `או לציין תאריך / עובד / סטטוס מדויק יותר.`,
    });
    return;
  }

  const now = new Date();
  const more = truncated ? `\n…מוצגות ${LIST_LIMIT} הראשונות. ניתן לצמצם את החיפוש.` : '';

  // Group by owner for a team view OR when more than one employee was requested —
  // and send ONE message per worker so a manager can read each separately.
  const groupByOwner = q.scope === 'all' || (q.ownerIds?.length ?? 0) > 1;

  if (groupByOwner) {
    const groups = new Map<string, TaskListItem[]>();
    for (const t of tasks) {
      const key = t.ownerName ?? '—';
      const arr = groups.get(key);
      if (arr) arr.push(t); else groups.set(key, [t]);
    }

    // 1. Team overview message.
    const header = q.ownerNames?.length ? `👥 משימות של: ${q.ownerNames.join(', ')}\n` : '';
    await sendTextMessage({
      to: user.phone,
      text: `${header}${buildPulse(tasks, truncated, now)} · 👥 ${groups.size} עובדים${more}`,
    });

    // 2. One message per worker (own mini-summary + their tasks).
    for (const [owner, ts] of groups) {
      const block =
        `👤 *${owner}*\n${buildPulse(ts, false, now)}\n\n` +
        ts.map((t) => renderTaskLine(t, q, now)).join('\n');
      await sendChunked(user.phone, block);
    }
  } else {
    const body = tasks.map((t) => renderTaskLine(t, q, now)).join('\n');
    await sendChunked(user.phone, `${buildPulse(tasks, truncated, now)}\n\n${body}${more}`);
  }

  // Store a COMPACT, numbered summary (built by code, not the AI) so a follow-up
  // like "details on the third one" can be resolved against these titles.
  const summaryItems = tasks
    .slice(0, 30)
    .map((t, i) => `${i + 1}) ${t.title}${t.ownerName ? ` [${t.ownerName}]` : ''}`)
    .join('; ');
  const ownerNote = q.ownerNames?.length ? ` של ${q.ownerNames.join(', ')}` : '';
  await appendTurn(user.phone, 'assistant', `הצגתי ${tasks.length} משימות${ownerNote}: ${summaryItems}`);
}

// ── Role-based numbered menu ────────────────────────────────────────────────────
// V1 is a numbered TEXT menu only (no WhatsApp interactive list messages). It is
// opened ONLY by an exact trigger word; all other free text still goes straight to
// the AI parser, so the existing NLU behavior is unchanged.

/** Open the role-based menu and remember that we're awaiting a numeric choice. */
async function showMenu(user: ResolvedUser): Promise<void> {
  // Manager users get a separate awaiting state so the router can distinguish
  // between the 6-item manager menu and the 7-item employee menu.
  const awaitingKind = isManagerMenuUser(user) ? 'mgr_menu_root' : 'menu';
  await setContext(user.phone, { awaiting: awaitingKind });

  // Group B: manager menu → Meta List Message (up to 10 rows, avoids typing).
  // Falls back to numbered text on any send failure.
  if (isManagerMenuUser(user)) {
    const items = menuItemsFor(user);
    try {
      await sendListMessage({
        to: user.phone,
        body: 'שלום, מה תרצה לעשות?',
        buttonLabel: 'פתח תפריט',
        sections: [{
          title: 'תפריט ניהול',
          rows: items.map((r) => ({
            id: `MGR_MENU_${r.n}`,
            title: r.label,
          })),
        }],
      });
      return;
    } catch (err) {
      log.warn({ err }, 'sendListMessage failed for manager menu — falling back to text');
    }
  }

  await sendTextMessage({ to: user.phone, text: renderMenu(user) });
}

/** Handle a numeric reply while the main menu is open. Non-numeric replies
 *  are intercepted by the top-of-`continueConversation` free-text escape hatch
 *  (see `NUMERIC_PICKER_AWAITING`) before they ever reach this handler, so any
 *  input arriving here is either digits or a nav word (`ביטול` etc.). */
async function handleMenuReply(user: ResolvedUser, trimmed: string): Promise<void> {
  const items = menuItemsFor(user);
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    await sendTextMessage({ to: user.phone, text: `אנא השב במספר בין 1 ל-${items.length}.` });
    return; // keep the menu context so the next number still works
  }
  await handleMenuRoute(user, items[idx - 1]);
}

/** Map a chosen menu route to existing behavior. */
async function handleMenuRoute(user: ResolvedUser, route: MenuRoute): Promise<void> {
  const action = route.action;
  switch (action.kind) {
    case 'list_tasks':
      await clearContext(user.phone);
      await runListTasks(user, { filter: action.filter, scope: action.scope, dateField: action.dateField });
      return;
    case 'digest_settings':
      await showDigestSettings(user);
      return;
    case 'free_text':
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'בטח! כתוב את הבקשה שלך בלשון חופשית ואטפל בה.' });
      return;
    case 'guide':
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: action.guide });
      return;

    // ── v2 inspector menu (SPEC_FIELD_V2 §5) — on-demand day list ───────────
    // Menu items 1 (today) and 2 (tomorrow): fetch inspections via the same
    // `getInspectionsForWorkerOnDate` query the scheduled morning digest uses,
    // then render via the menu-friendly `formatInspectorDayList` (no greeting).
    case 'list_inspections_today':
      await clearContext(user.phone);
      await sendInspectorDayList(user, 'today');
      return;
    case 'list_inspections_tomorrow':
      await clearContext(user.phone);
      await sendInspectorDayList(user, 'tomorrow');
      return;
    case 'update_inspection_status':
      await startStatusUpdateFlow(user);
      return;
    case 'report_problem':
      await startReportProblemFlow(user);
      return;
    case 'missing_equipment':
      // D2-T9: menu item 5 shortcut → same "what's missing?" prompt as the
      // "חסר לי ציוד" button on the morning equipment reminder. Uses today's
      // Asia/Jerusalem local date so the office alert stamps the right day.
      await setContext(user.phone, {
        awaiting: 'equipment_missing_note',
        equipmentLocalDate: localJerusalemDate(),
      });
      await sendTextMessage({ to: user.phone, text: 'איזה ציוד חסר לך?' });
      return;
    case 'missing_report_info':
      await startMissingInfoFlow(user);
      return;
    case 'day_summary':
      await startDaySummaryFlow(user);
      return;

    // ── Unified manager menu actions ───────────────────────────────────────────
    case 'mgr_snapshot':
      await clearContext(user.phone);
      await showMgrSnapshot(user);
      return;
    case 'mgr_today_inspections':
      await showMgrTodayInspections(user);
      return;
    case 'mgr_exceptions_sub':
      await showMgrExceptionsSub(user);
      return;
    case 'mgr_leads_sub':
      await showMgrLeadsSub(user);
      return;
    case 'mgr_workers_sub':
      await showMgrWorkersSub(user);
      return;
    case 'mgr_search_sub':
      await showMgrSearchSub(user);
      return;
  }
}

// ── D2-T7: "Missing info for report" flow ────────────────────────────────────
// Menu item 6 or D5-T3 intent `report_missing_info` → prompt for the missing
// detail, capture it, write into TaskField, notify the office. Voice arrives
// as text via D5-T2 so no special path is needed for voice.

async function startMissingInfoFlow(user: ResolvedUser): Promise<void> {
  const found = await findOpenTaskFieldForWorker(user.id);
  if (found === null) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'אין לך כרגע בדיקות פתוחות.' });
    return;
  }
  if ('ambiguous' in found) {
    // D2-T5 will implement disambiguation by customer name / site address.
    await setContext(user.phone, { awaiting: 'missing_info_disambig' });
    await sendTextMessage({
      to: user.phone,
      text: `יש לך ${found.count} בדיקות פתוחות. כתוב את שם הלקוח או כתובת האתר כדי לציין את הבדיקה.`,
    });
    return;
  }
  await setContext(user.phone, {
    awaiting: 'missing_info_note',
    taskFieldId: found.taskFieldId,
  });
  await sendTextMessage({ to: user.phone, text: 'מה חסר לדוח?' });
}

async function handleMissingInfoNoteReply(
  user: ResolvedUser,
  raw: string,
  ctx: ConversationState,
): Promise<void> {
  if (!ctx.taskFieldId) {
    // Corrupt state — reset and bail politely.
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const rawTrimmed = raw.trim();
  if (!rawTrimmed) {
    await sendTextMessage({ to: user.phone, text: 'מה חסר לדוח?' });
    return;
  }
  // AI extraction: strip polite prefixes. Falls back to raw if no provider / low confidence.
  const extracted = await extractNote(rawTrimmed, 'missing_info_note');
  const note = extracted ?? rawTrimmed;
  await writeMissingInfo({ taskFieldId: ctx.taskFieldId, note, updatedBy: user.id });
  await notifyOfficeMissingInfo(ctx.taskFieldId);
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: 'עדכנתי. המשרד קיבל התראה.' });
}

/** Direct dispatch used by the D5-T3 free-text intent — no menu step. */
async function runMissingInfoDirect(user: ResolvedUser, note: string): Promise<void> {
  const found = await findOpenTaskFieldForWorker(user.id);
  if (found === null) {
    await sendTextMessage({ to: user.phone, text: 'אין לך כרגע בדיקות פתוחות.' });
    return;
  }
  if ('ambiguous' in found) {
    await setContext(user.phone, { awaiting: 'missing_info_disambig' });
    await sendTextMessage({
      to: user.phone,
      text: `יש לך ${found.count} בדיקות פתוחות. כתוב את שם הלקוח או כתובת האתר כדי לציין את הבדיקה.`,
    });
    return;
  }
  await writeMissingInfo({ taskFieldId: found.taskFieldId, note, updatedBy: user.id });
  await notifyOfficeMissingInfo(found.taskFieldId);
  await sendTextMessage({ to: user.phone, text: 'עדכנתי. המשרד קיבל התראה.' });
}

// ── D2-T8: "Report a problem" flow (7-item numbered sub-menu) ────────────────
// Menu item 4 or D5-T3 intent `report_problem` → 7-item sub-menu (or direct
// write if the AI already picked a problem type). Types 6 (PROFESSIONAL_ISSUE)
// and 7 (OTHER) prompt for an elaboration note before writing.

async function startReportProblemFlow(user: ResolvedUser): Promise<void> {
  const found = await findOpenTaskFieldForWorker(user.id);
  if (found === null) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'אין לך כרגע בדיקות פתוחות.' });
    return;
  }
  if ('ambiguous' in found) {
    await setContext(user.phone, { awaiting: 'problem_disambig' });
    await sendTextMessage({
      to: user.phone,
      text: `יש לך ${found.count} בדיקות פתוחות. כתוב את שם הלקוח או כתובת האתר כדי לציין את הבדיקה.`,
    });
    return;
  }
  await setContext(user.phone, {
    awaiting: 'problem_type_choice',
    taskFieldId: found.taskFieldId,
  });
  await sendTextMessage({ to: user.phone, text: renderProblemTypeMenu() });
}

async function handleProblemTypeChoiceReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (!ctx.taskFieldId) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const items = problemTypeMenu();
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    // Invalid — resend the menu, keep the awaiting state.
    await sendTextMessage({
      to: user.phone,
      text: `בחר מספר תקין:\n${renderProblemTypeMenu()}`,
    });
    return;
  }
  const chosen = items[idx - 1];
  // Types 6 (PROFESSIONAL_ISSUE) and 7 (OTHER) require an elaboration note.
  if (chosen.problemType === 'PROFESSIONAL_ISSUE' || chosen.problemType === 'OTHER') {
    await setContext(user.phone, {
      awaiting: 'problem_type_note',
      taskFieldId: ctx.taskFieldId,
      problemType: chosen.problemType,
    });
    await sendTextMessage({ to: user.phone, text: 'פרט בבקשה:' });
    return;
  }
  // Types 1-5 write directly with no note.
  await writeProblem({
    taskFieldId: ctx.taskFieldId,
    problemType: chosen.problemType,
    note: null,
    updatedBy: user.id,
  });
  await notifyOfficeProblem(ctx.taskFieldId);
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: 'עדכנתי. המנהל קיבל התראה.' });
}

async function handleProblemTypeNoteReply(
  user: ResolvedUser,
  raw: string,
  ctx: ConversationState,
): Promise<void> {
  if (!ctx.taskFieldId || !ctx.problemType) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const rawTrimmed = raw.trim();
  if (!rawTrimmed) {
    await sendTextMessage({ to: user.phone, text: 'פרט בבקשה:' });
    return;
  }
  // AI extraction: strip polite prefixes. Falls back to raw if no provider / low confidence.
  const extracted = await extractNote(rawTrimmed, 'problem_note');
  const note = extracted ?? rawTrimmed;
  await writeProblem({
    taskFieldId: ctx.taskFieldId,
    problemType: ctx.problemType,
    note,
    updatedBy: user.id,
  });
  await notifyOfficeProblem(ctx.taskFieldId);
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: 'עדכנתי. המנהל קיבל התראה.' });
}

/** Direct dispatch used by the D5-T3 free-text intent — no menu step. */
async function runProblemDirect(
  user: ResolvedUser,
  problemType: FieldProblemType,
  note: string | null,
): Promise<void> {
  const found = await findOpenTaskFieldForWorker(user.id);
  if (found === null) {
    await sendTextMessage({ to: user.phone, text: 'אין לך כרגע בדיקות פתוחות.' });
    return;
  }
  if ('ambiguous' in found) {
    await setContext(user.phone, { awaiting: 'problem_disambig' });
    await sendTextMessage({
      to: user.phone,
      text: `יש לך ${found.count} בדיקות פתוחות. כתוב את שם הלקוח או כתובת האתר כדי לציין את הבדיקה.`,
    });
    return;
  }
  await writeProblem({
    taskFieldId: found.taskFieldId,
    problemType,
    note,
    updatedBy: user.id,
  });
  await notifyOfficeProblem(found.taskFieldId);
  await sendTextMessage({ to: user.phone, text: 'עדכנתי. המנהל קיבל התראה.' });
}

// ── D2-T5 / D2-T6: on-demand status transitions + finished follow-up ────────
// Menu item 3 → 3-item status sub-menu → DEPARTED/ARRIVED/FINISHED write.
// A FINISHED write ALWAYS opens the 4-option follow-up (spec §7 / D2-T6).
// The D5-T3 `set_field_status` intent gets a direct entry point via
// `runAdvanceStatusDirect`. When the worker has >1 open TaskField, we hold
// the requested transition in `pendingTransition` on the awaiting state and
// resolve via `resolveOpenTaskFieldByHint`.

const STATUS_HE_LABEL: Record<AdvanceTransition, string> = {
  DEPARTED: 'בדרך',
  ARRIVED:  'באתר',
  FINISHED: 'הבדיקה הסתיימה',
};

/** Menu item 3 entry. Resolve open TaskField → show status sub-menu. */
async function startStatusUpdateFlow(user: ResolvedUser): Promise<void> {
  const found = await findOpenTaskFieldForWorker(user.id);
  if (found === null) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'אין לך כרגע בדיקות פתוחות.' });
    return;
  }
  if ('ambiguous' in found) {
    await setContext(user.phone, { awaiting: 'status_disambig' });
    await sendTextMessage({
      to: user.phone,
      text: `יש לך ${found.count} בדיקות פתוחות. כתוב את שם הלקוח או כתובת האתר כדי לציין את הבדיקה.`,
    });
    return;
  }
  await setContext(user.phone, { awaiting: 'status_choice', taskFieldId: found.taskFieldId });
  await sendTextMessage({ to: user.phone, text: renderStatusUpdateMenu() });
}

async function handleStatusChoiceReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (!ctx.taskFieldId) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const items = statusUpdateMenu();
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    await sendTextMessage({
      to: user.phone,
      text: `בחר מספר תקין:\n${renderStatusUpdateMenu()}`,
    });
    return;
  }
  const chosen = items[idx - 1];
  await performTransition(user, ctx.taskFieldId, chosen.transition);
}

/**
 * Shared write + reply path. FINISHED opens the 4-option follow-up + keeps
 * the awaiting state alive (`finished_followup`); DEPARTED / ARRIVED clear it.
 */
async function performTransition(
  user: ResolvedUser,
  taskFieldId: string,
  transition: AdvanceTransition,
): Promise<void> {
  await advanceFieldStatus({ taskFieldId, transition, updatedBy: user.id });
  if (transition === 'FINISHED') {
    await setContext(user.phone, { awaiting: 'finished_followup', taskFieldId });
    await sendTextMessage({ to: user.phone, text: renderFinishedFollowUpMenu() });
    return;
  }
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: `עדכנתי — סטטוס: ${STATUS_HE_LABEL[transition]}.` });
}

async function handleFinishedFollowUpReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (!ctx.taskFieldId) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const items = finishedFollowUpMenu();
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    await sendTextMessage({
      to: user.phone,
      text: `בחר מספר תקין:\n${renderFinishedFollowUpMenu()}`,
    });
    return;
  }
  const chosen = items[idx - 1];
  const taskFieldId = ctx.taskFieldId;
  switch (chosen.choice) {
    case 'no_notes':
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'רשמנו. כל טוב!' });
      return;
    case 'has_notes':
      await setContext(user.phone, { awaiting: 'finished_notes', taskFieldId });
      await sendTextMessage({ to: user.phone, text: 'מה ההערות מהשטח?' });
      return;
    case 'has_problem':
      // Hand off to D2-T8 — reuse the same code path as `report_problem` menu
      // tap. We already know the TaskField, so skip `findOpenTaskFieldForWorker`.
      await setContext(user.phone, { awaiting: 'problem_type_choice', taskFieldId });
      await sendTextMessage({ to: user.phone, text: renderProblemTypeMenu() });
      return;
    case 'missing_info':
      // Hand off to D2-T7 — reuse the same code path as `missing_report_info`.
      await setContext(user.phone, { awaiting: 'missing_info_note', taskFieldId });
      await sendTextMessage({ to: user.phone, text: 'מה חסר לדוח?' });
      return;
  }
}

async function handleFinishedNotesReply(
  user: ResolvedUser,
  raw: string,
  ctx: ConversationState,
): Promise<void> {
  if (!ctx.taskFieldId) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const rawTrimmed = raw.trim();
  if (!rawTrimmed) {
    await sendTextMessage({ to: user.phone, text: 'מה ההערות מהשטח?' });
    return;
  }
  // AI extraction: strip polite prefixes. Falls back to raw if no provider / low confidence.
  const extracted = await extractNote(rawTrimmed, 'field_notes');
  const notes = extracted ?? rawTrimmed;
  await writeFieldNotes({ taskFieldId: ctx.taskFieldId, notes, updatedBy: user.id });
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: 'נשמר. תודה.' });
}

/** Direct dispatch used by the D5-T3 `set_field_status` free-text intent. */
async function runAdvanceStatusDirect(
  user: ResolvedUser,
  transition: AdvanceTransition,
  hint: string | null,
): Promise<void> {
  const found = hint
    ? await resolveOpenTaskFieldByHint(user.id, hint)
    : await findOpenTaskFieldForWorker(user.id);
  if (found === null) {
    await sendTextMessage({
      to: user.phone,
      text: hint
        ? `לא הצלחתי לזהות בדיקה עבור "${hint}".`
        : 'אין לך כרגע בדיקות פתוחות.',
    });
    return;
  }
  if ('ambiguous' in found) {
    await setContext(user.phone, {
      awaiting: 'status_disambig',
      pendingTransition: transition,
    });
    await sendTextMessage({
      to: user.phone,
      text: `יש לך ${found.count} בדיקות פתוחות. כתוב את שם הלקוח או כתובת האתר כדי לציין את הבדיקה.`,
    });
    return;
  }
  await performTransition(user, found.taskFieldId, transition);
}

// ── D2-T5 disambig: resolve free-text hint into a specific TaskField ─────────
// Shared handler for `status_disambig`, `missing_info_disambig`, and
// `problem_disambig`. On unique match → transition into the appropriate
// follow-up state (status sub-menu / note prompt / problem sub-menu). On no
// match → keep the awaiting state and ask again. "ביטול" clears the state.

type DisambigFlow = 'status' | 'missing_info' | 'problem';

async function handleDisambigReply(
  user: ResolvedUser,
  trimmed: string,
  flow: DisambigFlow,
  pendingTransition?: FieldStatusTransition,
): Promise<void> {
  if (/^ביטול$/.test(trimmed)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }
  if (!trimmed) {
    await sendTextMessage({
      to: user.phone,
      text: 'לא הצלחתי לזהות. נסה שוב או כתוב "ביטול".',
    });
    return;
  }
  const found = await resolveOpenTaskFieldByHint(user.id, trimmed);
  if (found === null || 'ambiguous' in found) {
    await sendTextMessage({
      to: user.phone,
      text: 'לא הצלחתי לזהות. נסה שוב או כתוב "ביטול".',
    });
    return;
  }
  const taskFieldId = found.taskFieldId;

  if (flow === 'status') {
    // If a pendingTransition was pre-stored (free-text set_field_status path),
    // perform it directly. Otherwise open the 3-item status sub-menu.
    if (pendingTransition === 'DEPARTED' || pendingTransition === 'ARRIVED' || pendingTransition === 'FINISHED') {
      await performTransition(user, taskFieldId, pendingTransition);
      return;
    }
    if (pendingTransition === 'WAITING_FOR_INFO') {
      await setContext(user.phone, { awaiting: 'missing_info_note', taskFieldId });
      await sendTextMessage({ to: user.phone, text: 'מה חסר לדוח?' });
      return;
    }
    if (pendingTransition === 'HAS_PROBLEM') {
      await setContext(user.phone, { awaiting: 'problem_type_choice', taskFieldId });
      await sendTextMessage({ to: user.phone, text: renderProblemTypeMenu() });
      return;
    }
    await setContext(user.phone, { awaiting: 'status_choice', taskFieldId });
    await sendTextMessage({ to: user.phone, text: renderStatusUpdateMenu() });
    return;
  }
  if (flow === 'missing_info') {
    await setContext(user.phone, { awaiting: 'missing_info_note', taskFieldId });
    await sendTextMessage({ to: user.phone, text: 'מה חסר לדוח?' });
    return;
  }
  // flow === 'problem'
  await setContext(user.phone, { awaiting: 'problem_type_choice', taskFieldId });
  await sendTextMessage({ to: user.phone, text: renderProblemTypeMenu() });
}

// ── D2-T9: equipment reminder button taps + missing-note flow ───────────────
// SPEC_FIELD_V2 §10. The morning equipment reminder is one of the two allowed
// button surfaces per D5-T4 (see `sendButtonMessage` JSDoc in
// `src/whatsapp/sender.ts` and `formatEquipmentReminder` in
// `src/whatsapp/digestContent.ts`). Payload shape (from the formatter):
//   EQUIP_ALL_<userId>_<YYYY-MM-DD>
//   EQUIP_MISSING_<userId>_<YYYY-MM-DD>
// Deterministic. Parsed in `matchEquipmentTap` at the entry to
// `handleAIMessage`, ahead of the AI parser and awaiting-state resolution.

type EquipmentTapKind = 'all' | 'missing';

/**
 * Parse an inbound message that IS an equipment tap payload. Returns null for
 * anything else so the caller falls through to the normal (digest / context /
 * AI) routing untouched. Anchored to the full trimmed message and rejects any
 * text after the date so free text like "EQUIP_ALL_… הלכתי" cannot spoof a
 * tap. Only the two known kinds are accepted.
 */
function matchEquipmentTap(
  raw: string,
): { kind: EquipmentTapKind; userId: string; localDate: string } | null {
  const m = raw.trim().match(
    /^EQUIP_(ALL|MISSING)_([0-9a-f-]{36})_(\d{4}-\d{2}-\d{2})$/i,
  );
  if (!m) return null;
  return {
    kind: m[1].toUpperCase() === 'ALL' ? 'all' : 'missing',
    userId: m[2],
    localDate: m[3],
  };
}

async function handleEquipmentTap(
  user: ResolvedUser,
  kind: EquipmentTapKind,
  localDate: string,
): Promise<void> {
  if (kind === 'all') {
    // "לקחתי הכל" — ack and clear any lingering awaiting state (a tap that
    // arrives mid-conversation shouldn't strand the user in a stale context).
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'מעולה, יום עבודה טוב!' });
    return;
  }
  // "חסר לי ציוד" — prompt for the free-text note; the next inbound text
  // lands in `handleEquipmentMissingNoteReply`.
  await setContext(user.phone, {
    awaiting: 'equipment_missing_note',
    equipmentLocalDate: localDate,
  });
  await sendTextMessage({ to: user.phone, text: 'איזה ציוד חסר לך?' });
}

async function handleEquipmentMissingNoteReply(
  user: ResolvedUser,
  raw: string,
  ctx: ConversationState,
): Promise<void> {
  const rawTrimmed = raw.trim();
  if (!rawTrimmed) {
    await sendTextMessage({ to: user.phone, text: 'איזה ציוד חסר לך?' });
    return;
  }
  // AI extraction: strip polite prefixes. Falls back to raw if no provider / low confidence.
  const extracted = await extractNote(rawTrimmed, 'equipment_missing_note');
  const note = extracted ?? rawTrimmed;
  const localDate = ctx.equipmentLocalDate ?? localJerusalemDate();
  await notifyOfficeMissingEquipment({
    userId: user.id,
    userName: user.name,
    note,
    localDate,
  });
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: 'עדכנתי. המשרד קיבל התראה.' });
}

// ── D2-T3: inspection-card button taps + follow-up state handlers ───────────
// SPEC_FIELD_V2 §6/§7. The three buttons on the §6 card carry deterministic
// payload IDs from `services/inspectionAssignment.ts`:
//   INSP_CONFIRM_<taskFieldId>    → CONFIRMED   + confirmedAt (immediate ack)
//   INSP_DECLINE_<taskFieldId>    → DECLINED    + declinedAt (prompts reason)
//   INSP_NEED_INFO_<taskFieldId>  → NEEDS_MORE_INFO (prompts follow-up text)
// Ownership: the card was sent to the assigned worker (Task.ownerId → User),
// so only that user could have tapped it. Not defended against payload spoof
// beyond that — a UUID guess is not a real threat and the write is scoped to
// the specific TaskField id.

type InspectionCardTapKind = 'confirm' | 'decline' | 'need_info';

/** Parse an inbound message that IS an inspection-card tap payload. Returns
 *  null for anything else so the caller falls through untouched. */
function matchInspectionCardTap(
  raw: string,
): { kind: InspectionCardTapKind; taskFieldId: string } | null {
  const m = raw.trim().match(
    /^INSP_(CONFIRM|DECLINE|NEED_INFO)_([0-9a-f-]{36})$/i,
  );
  if (!m) return null;
  const token = m[1].toUpperCase();
  const kind: InspectionCardTapKind =
    token === 'CONFIRM' ? 'confirm'
    : token === 'DECLINE' ? 'decline'
    : 'need_info';
  return { kind, taskFieldId: m[2] };
}

async function handleInspectionCardTap(
  user: ResolvedUser,
  kind: InspectionCardTapKind,
  taskFieldId: string,
): Promise<void> {
  switch (kind) {
    case 'confirm':
      await confirmInspection({ taskFieldId, updatedBy: user.id });
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'הבדיקה אושרה. תודה.' });
      return;
    case 'decline':
      await setContext(user.phone, {
        awaiting: 'inspection_decline_reason',
        taskFieldId,
      });
      await sendTextMessage({ to: user.phone, text: 'מדוע אינך יכול להגיע? כתוב סיבה קצרה.' });
      return;
    case 'need_info':
      await setContext(user.phone, {
        awaiting: 'inspection_need_info_note',
        taskFieldId,
      });
      await sendTextMessage({ to: user.phone, text: 'אילו פרטים חסרים? כתוב מה צריך.' });
      return;
  }
}

async function handleInspectionDeclineReasonReply(
  user: ResolvedUser,
  raw: string,
  ctx: ConversationState,
): Promise<void> {
  if (!ctx.taskFieldId) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const rawTrimmed = raw.trim();
  if (!rawTrimmed) {
    await sendTextMessage({ to: user.phone, text: 'מדוע אינך יכול להגיע? כתוב סיבה קצרה.' });
    return;
  }
  // AI extraction: strip polite prefixes. Falls back to raw if no provider / low confidence.
  const extracted = await extractNote(rawTrimmed, 'decline_reason');
  const reason = extracted ?? rawTrimmed;
  await declineInspection({ taskFieldId: ctx.taskFieldId, reason, updatedBy: user.id });
  await notifyOfficeDeclined(ctx.taskFieldId, reason);
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: 'עדכנתי. המשרד קיבל התראה.' });
}

async function handleInspectionNeedInfoNoteReply(
  user: ResolvedUser,
  raw: string,
  ctx: ConversationState,
): Promise<void> {
  if (!ctx.taskFieldId) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const rawTrimmed = raw.trim();
  if (!rawTrimmed) {
    await sendTextMessage({ to: user.phone, text: 'אילו פרטים חסרים? כתוב מה צריך.' });
    return;
  }
  // AI extraction: strip polite prefixes. Falls back to raw if no provider / low confidence.
  const extracted = await extractNote(rawTrimmed, 'missing_info_note');
  const note = extracted ?? rawTrimmed;
  await requestMoreInfo({ taskFieldId: ctx.taskFieldId, note, updatedBy: user.id });
  await notifyOfficeNeedsMoreInfo(ctx.taskFieldId, note);
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: 'עדכנתי. המשרד קיבל התראה.' });
}

// ── D2-T10: on-demand worker day summary (menu item 7) ─────────────────────
// SPEC_FIELD_V2 §11. Menu item 7 → summary text (FINISHED_FIELD list +
// WAITING_FOR_INFO count for the worker's local day) + a 4-option follow-up
// menu. Options 2 (missing info) and 4 (open problem) hand back into the
// D2-T7 / D2-T8 flows (with disambig when multiple TaskFields are open).
// Option 3 ("צריך לחזור ללקוח") is alert-only — no DB write per spec brief
// ("TODO: no persistence per D2-T10 spec — alert-only"). Option 1
// acknowledges and clears; NO FieldWorkerDayClose row is written (deferred
// per §14).

/**
 * On-demand inspector list for menu items 1 (today) and 2 (tomorrow).
 * `tomorrow` = 24h ahead in Asia/Jerusalem (24h > DST shift, so the calendar
 * day always advances by 1). Handles empty result set with a friendly one-liner.
 */
async function sendInspectorDayList(
  user: ResolvedUser,
  when: 'today' | 'tomorrow',
): Promise<void> {
  const baseNow = when === 'today'
    ? new Date()
    : new Date(Date.now() + 24 * 60 * 60 * 1000);
  const localDate = localJerusalemDate(baseNow);
  const items = await getInspectionsForWorkerOnDate(user.id, localDate);
  const text = formatInspectorDayList(items, { when });
  await sendTextMessage({ to: user.phone, text });
}

/** Compute the worker's local calendar day (Asia/Jerusalem) as 'YYYY-MM-DD'. */
function localJerusalemDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value ?? '';
  const m = parts.find((p) => p.type === 'month')?.value ?? '';
  const d = parts.find((p) => p.type === 'day')?.value ?? '';
  return `${y}-${m}-${d}`;
}

async function startDaySummaryFlow(user: ResolvedUser): Promise<void> {
  const localDate = localJerusalemDate();
  const { finished, waitingForInfoCount } = await dayFieldSummary(user.id, localDate);
  const summary = formatDayFieldSummary(finished, waitingForInfoCount, user.name);
  await sendTextMessage({ to: user.phone, text: summary });
  await setContext(user.phone, { awaiting: 'day_summary_choice' });
  await sendTextMessage({ to: user.phone, text: renderDaySummaryFollowUpMenu() });
}

async function handleDaySummaryChoiceReply(user: ResolvedUser, trimmed: string): Promise<void> {
  const items = daySummaryFollowUpMenu();
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    await sendTextMessage({
      to: user.phone,
      text: `בחר מספר תקין:\n${renderDaySummaryFollowUpMenu()}`,
    });
    return;
  }
  const chosen = items[idx - 1];
  switch (chosen.choice) {
    case 'all_done':
      // Acknowledge, clear awaiting, DO NOT write any DB row (no
      // FieldWorkerDayClose per D2-T10 spec / §14).
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'רשמנו. כל טוב!' });
      return;
    case 'missing_info': {
      // Hand off to the D2-T7 missing-info flow. Uses the shared open-
      // TaskField resolver so 0 / 1 / N cases are handled uniformly with
      // the menu-item-6 entry point (disambig routes through
      // `missing_info_disambig`).
      await startMissingInfoFlow(user);
      return;
    }
    case 'callback_customer': {
      // Light "call back later" handler — free-text note → alert to
      // managers. No DB column.
      // TODO: no persistence per D2-T10 spec — alert-only.
      await setContext(user.phone, { awaiting: 'callback_customer_note' });
      await sendTextMessage({ to: user.phone, text: 'לאיזה לקוח צריך לחזור? כתוב שם והערה קצרה.' });
      return;
    }
    case 'open_problem': {
      // Hand off to the D2-T8 report-problem flow.
      await startReportProblemFlow(user);
      return;
    }
  }
}

async function handleCallbackCustomerNoteReply(user: ResolvedUser, raw: string): Promise<void> {
  const rawTrimmed = raw.trim();
  if (!rawTrimmed) {
    await sendTextMessage({ to: user.phone, text: 'לאיזה לקוח צריך לחזור? כתוב שם והערה קצרה.' });
    return;
  }
  // AI extraction: strip polite prefixes. Falls back to raw if no provider / low confidence.
  const extracted = await extractNote(rawTrimmed, 'field_notes');
  const note = extracted ?? rawTrimmed;
  const workerName = user.name ?? '—';
  const alert =
    `בקשת חזרה ללקוח\n` +
    `עובד: ${workerName}\n` +
    `${note}\n` +
    `לטיפול המשרד.`;
  const managers = await getManagersForBroadcast();
  if (managers.length === 0) {
    log.warn({ userId: user.id }, 'callback_customer: no managers configured; alert not sent');
  } else {
    await Promise.allSettled(
      managers.map((m) =>
        sendTextMessage({ to: m.phone, text: alert }).catch((err) => {
          log.error({ err, userId: user.id, managerId: m.id }, 'callback alert send failed');
        }),
      ),
    );
  }
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: 'עדכנתי. המשרד קיבל התראה.' });
}

// ── Deterministic digest follow-up commands (buttons + exact text) ──────────────
// Routes a tapped digest quick-reply (its payload id) or the exact Hebrew command
// to a fixed action WITHOUT the AI parser. Team views are elevated-only, so an
// employee can never reach other employees' tasks through a digest button.

async function handleDigestCommand(user: ResolvedUser, cmd: DigestCommand): Promise<void> {
  // A digest command is an explicit fresh navigation — drop any half-finished
  // clarification context so it routes cleanly.
  await clearContext(user.phone);

  const plan = planDigestCommand(cmd, user);
  switch (plan.kind) {
    case 'list':
      await runListTasks(user, { filter: plan.filter, scope: plan.scope, dateField: 'dueDate' });
      return;
    case 'employee_eod':
      await doEmployeeEndOfDayReport(user);
      return;
    case 'team_eod':
      await doTeamEndOfDayReport(user);
      return;
    case 'free_text':
      await sendTextMessage({ to: user.phone, text: 'כתוב את בקשתך בלשון חופשית ואטפל בה.' });
      return;
    case 'denied':
      await auditEvent(user, 'digest_team_command', null, 'SKIPPED', 'not elevated');
      await sendTextMessage({ to: user.phone, text: 'התצוגה הזו זמינה למנהלים בלבד.' });
      return;
  }
}

/** Employee on-demand end-of-day status report — reuses the digest builder (own tasks only). */
async function doEmployeeEndOfDayReport(user: ResolvedUser): Promise<void> {
  const eod = await getEmployeeEndOfDay(user.id);
  const { text } = formatEmployeeEndOfDay(user.name, eod);
  await auditEvent(user, 'digest_emp_eod', null, 'SUCCESS');
  await sendChunked(user.phone, text);
  await appendTurn(user.phone, 'assistant', 'הצגתי את דוח סוף היום שלך (סטטוס נוכחי).');
}

/** Manager/Admin on-demand company end-of-day report — reuses the digest builder. */
async function doTeamEndOfDayReport(user: ResolvedUser): Promise<void> {
  const co = await getCompanyEndOfDay();
  const { text } = formatManagerEndOfDay(user.name, co);
  await auditEvent(user, 'digest_team_eod', null, 'SUCCESS');
  await sendChunked(user.phone, text);
  await appendTurn(user.phone, 'assistant', 'הצגתי את דוח סוף היום של הצוות (סטטוס נוכחי).');
}

// ── Digest settings flow ────────────────────────────────────────────────────────

/** Show the digest-settings sub-menu and await a numeric choice. */
async function showDigestSettings(user: ResolvedUser): Promise<void> {
  const pref = await getEffectiveDigestPreference(user.id);
  await setContext(user.phone, { awaiting: 'digest_settings' });
  await sendTextMessage({ to: user.phone, text: renderDigestSettings(pref) });
}

function renderDigestSettings(pref: DigestPreference): string {
  const onOff = (b: boolean) => (b ? 'פעיל' : 'כבוי');
  return [
    'הגדרות סיכום בוקר / דוח סוף יום',
    `מצב נוכחי: ☀️ סיכום בוקר ${onOff(pref.morningEnabled)} (${pref.morningTime}) · 🌆 דוח סוף יום ${onOff(pref.eveningEnabled)} (${pref.eveningTime})`,
    '',
    '1. הפעלת סיכום בוקר',
    '2. כיבוי סיכום בוקר',
    '3. שינוי שעת סיכום בוקר',
    '4. הפעלת דוח סוף יום',
    '5. כיבוי דוח סוף יום',
    '6. שינוי שעת דוח סוף יום',
    '7. חזרה לתפריט הראשי',
    '',
    'השב במספר.',
  ].join('\n');
}

/** Handle a numeric choice in the digest-settings sub-menu. */
async function handleDigestSettingsReply(user: ResolvedUser, trimmed: string): Promise<void> {
  const audit = { phone: user.phone };
  switch (parseInt(trimmed, 10)) {
    case 1:
      await upsertDigestPreference(user.id, { morningEnabled: true }, audit);
      await sendTextMessage({ to: user.phone, text: '☀️ סיכום הבוקר הופעל.' });
      await showDigestSettings(user);
      return;
    case 2:
      await upsertDigestPreference(user.id, { morningEnabled: false }, audit);
      await sendTextMessage({ to: user.phone, text: '☀️ סיכום הבוקר כובה.' });
      await showDigestSettings(user);
      return;
    case 3:
      await setContext(user.phone, { awaiting: 'digest_set_time', digestField: 'morning' });
      await sendTextMessage({ to: user.phone, text: 'לאיזו שעה לקבוע את סיכום הבוקר? (למשל 8 או 08:30)' });
      return;
    case 4:
      await upsertDigestPreference(user.id, { eveningEnabled: true }, audit);
      await sendTextMessage({ to: user.phone, text: '🌆 דוח סוף היום הופעל.' });
      await showDigestSettings(user);
      return;
    case 5:
      await upsertDigestPreference(user.id, { eveningEnabled: false }, audit);
      await sendTextMessage({ to: user.phone, text: '🌆 דוח סוף היום כובה.' });
      await showDigestSettings(user);
      return;
    case 6:
      await setContext(user.phone, { awaiting: 'digest_set_time', digestField: 'evening' });
      await sendTextMessage({ to: user.phone, text: 'לאיזו שעה לקבוע את דוח סוף היום? (למשל 17 או 17:30)' });
      return;
    case 7:
      await showMenu(user);
      return;
    default:
      await sendTextMessage({ to: user.phone, text: 'אנא השב במספר בין 1 ל-7.' });
  }
}

/** Handle a time reply while awaiting a digest time — validate, save, reshow. */
async function handleDigestTimeReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  const field = ctx.digestField;
  if (field !== 'morning' && field !== 'evening') {
    await showDigestSettings(user); // corrupt state — bounce back to settings
    return;
  }
  const hhmm = parseTimeInput(trimmed);
  if (!hhmm) {
    await sendTextMessage({ to: user.phone, text: 'שעה לא תקינה. אנא כתוב שעה כמו 8, 8:30 או 08:00.' });
    return; // keep awaiting:'digest_set_time' so the user can retry
  }
  const patch = field === 'morning' ? { morningTime: hhmm } : { eveningTime: hhmm };
  await upsertDigestPreference(user.id, patch, { phone: user.phone });
  const label = field === 'morning' ? 'סיכום הבוקר' : 'דוח סוף היום';
  await sendTextMessage({ to: user.phone, text: `✅ שעת ${label} עודכנה ל-${hhmm}.` });
  await showDigestSettings(user);
}

/** One-line pulse summary shown above a task list. */
function buildPulse(tasks: TaskListItem[], truncated: boolean, now: Date): string {
  let overdue = 0, today = 0, inProgress = 0, done = 0;
  const todayStr = fmtDate(now);
  for (const t of tasks) {
    if (t.status === 'DONE') { done++; continue; }
    if (t.status === 'IN_PROGRESS') inProgress++;
    if (t.dueDate) {
      const d = new Date(t.dueDate);
      if (d < now) overdue++;
      else if (fmtDate(d) === todayStr) today++;
    }
  }
  const segs = [`📊 סה״כ ${tasks.length}${truncated ? '+' : ''}`];
  if (overdue)    segs.push(`⚠️ ${overdue} באיחור`);
  if (today)      segs.push(`🔴 ${today} להיום`);
  if (inProgress) segs.push(`🔄 ${inProgress} בתהליך`);
  if (done)       segs.push(`✅ ${done} הושלמו`);
  return segs.join(' · ');
}

/** Render a single task line: status + priority + title, then due date (always),
 *  linked context, an aging marker, and creation time when sorted by it. */
function renderTaskLine(t: TaskListItem, q: ListQuery, now: Date): string {
  const icon = t.status === 'DONE' ? '✅' : t.status === 'IN_PROGRESS' ? '🔄' : '📋';
  const prio = String(t.priority ?? '').toUpperCase();
  const prioBadge = prio === 'URGENT' ? ' 🔴' : prio === 'HIGH' ? ' 🟠' : '';

  const due = t.dueDate ? `${fmtDate(t.dueDate)} ${fmtTime(t.dueDate)}` : 'ללא מועד';
  const overdue = t.dueDate && t.status !== 'DONE' && new Date(t.dueDate) < now ? ' ⚠️ באיחור' : '';

  let line = `${icon}${prioBadge} ${t.title}\n   📅 יעד: ${due}${overdue}`;

  const ctx = t.customerName ?? t.leadName ?? t.projectName;
  if (ctx) line += `\n   🏢 ${ctx}`;

  // Aging — open and untouched for a while (helps spot stuck work).
  if (t.status !== 'DONE' && t.createdAt) {
    const ageDays = Math.floor((now.getTime() - new Date(t.createdAt).getTime()) / 86_400_000);
    if (ageDays >= 14) line += `\n   🐌 פתוחה ${ageDays} ימים`;
  }

  if (q.dateField === 'createdAt' && t.createdAt) {
    line += `\n   🕓 נוצר: ${fmtDate(t.createdAt)} ${fmtTime(t.createdAt)}`;
  }
  return line;
}

/** A plain-Hebrew description of the read about to run (no SQL). */
const STATUS_LABELS: Record<string, string> = {
  OPEN: 'פתוח', IN_PROGRESS: 'בתהליך', DONE: 'בוצע',
};
const statusLabel = (s: string) => STATUS_LABELS[s] ?? s;

const fmtDate = (d: Date | string) =>
  new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d));
const fmtTime = (d: Date | string) =>
  new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d));
/** Format an ISO date label (YYYY-MM-DD…) as DD/MM/YYYY without timezone shifts. */
function fmtDateStr(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

async function doGetTask(user: ResolvedUser, taskId: string): Promise<void> {
  const task = await getTaskById(user, taskId);
  if (!task) {
    await auditEvent(user, 'get_task', taskId, 'SKIPPED', 'not found or no permission');
    await sendTextMessage({ to: user.phone, text: 'המשימה לא נמצאה או שאין לך הרשאה.' });
    return;
  }
  await auditEvent(user, 'get_task', taskId, 'SUCCESS');
  const due = task.dueDate ? `${fmtDate(task.dueDate)} ${fmtTime(task.dueDate)}` : 'ללא מועד';
  const overdue = task.dueDate && task.status !== 'DONE' && new Date(task.dueDate) < new Date() ? ' ⚠️ באיחור' : '';
  const parts = [
    `📋 ${task.title}`,
    `סטטוס: ${statusLabel(task.status)}`,
    `סוג: ${TASK_TYPE_LABELS[task.type] ?? task.type}`,
    `עדיפות: ${task.priority ?? '—'}`,
  ];
  // Description is nullable — show it only when set (right under the header block).
  if (task.description) parts.push(`📝 תיאור: ${task.description}`);
  parts.push(
    `📅 מועד יעד: ${due}${overdue}`,
    `🕓 נוצר: ${fmtDate(task.createdAt)} ${fmtTime(task.createdAt)}`,
  );
  if (task.updatedAt) parts.push(`✏️ עודכן: ${fmtDate(task.updatedAt)} ${fmtTime(task.updatedAt)}`);
  // Linked entities — show the richer fields already fetched (phone/city), not just the name.
  if (task.customer) {
    const extra = [task.customer.city, task.customer.phone].filter(Boolean).join(', ');
    parts.push(`לקוח: ${task.customer.name}${extra ? ` (${extra})` : ''}`);
  }
  if (task.lead) {
    const extra = [task.lead.city, task.lead.phone].filter(Boolean).join(', ');
    parts.push(`ליד: ${task.lead.fullName}${extra ? ` (${extra})` : ''}`);
  }
  if (task.project) {
    const num = task.project.projectNumber ? `#${task.project.projectNumber} ` : '';
    parts.push(`פרויקט: ${num}${task.project.name}`);
  }
  await sendTextMessage({ to: user.phone, text: parts.join('\n') });
  await appendTurn(user.phone, 'assistant', `הצגתי פרטים על המשימה "${task.title}".`);
}

// ── Misc helpers ────────────────────────────────────────────────────────────────

function applyFieldValue(intent: AIIntentResult, field: string, value: string): AIIntentResult {
  if (field === 'new_value') intent.new_value = value;
  else if (field === 'task_reference') intent.task_reference = value;
  else intent.params[field] = value;
  return intent;
}

function describeIntent(intent: AIIntentResult): string {
  switch (intent.intent) {
    case 'get_task': return `הבנתי שברצונך לראות פרטי משימה "${intent.task_reference ?? ''}".`;
    default:         return 'הבנתי את בקשתך.';
  }
}

/** Record a read / non-write event in the audit log (never throws). */
async function auditEvent(
  user: ResolvedUser,
  intent: string,
  taskId: string | null,
  status: 'SUCCESS' | 'SKIPPED' | 'FAILED',
  error?: string,
): Promise<void> {
  await writeAuditLog({
    userId: user.id, whatsappNumber: user.phone,
    originalMessage: null, transcribedMessage: null,
    detectedIntent: intent, detectedAction: null, confidence: null,
    targetTaskId: taskId, oldValues: null, newValues: null,
    confirmationStatus: null, approvalStatus: null, approverUserId: null,
    managerNotified: false, executionStatus: status, errorMessage: error ?? null,
    pendingActionId: null,
  });
}

function helpText(): string {
  return [
    'אני עוזר לעובדי שטח לדווח על בדיקות. אפשר לבקש למשל:',
    '• "יצאתי" / "הגעתי" / "סיימתי" — עדכון סטטוס בדיקה',
    '• "הלקוח לא ענה" / "אין גישה" — דיווח על בעיה',
    '• "חסר לי טופס דגימה" — דיווח על מידע חסר',
    '• כתוב "תפריט" לפתיחת התפריט המלא.',
  ].join('\n');
}

async function safePriorities(): Promise<string[]> {
  try {
    return await getAllowedPriorities();
  } catch {
    return [];
  }
}

// D3-T6: Sasha lead-assignment via WhatsApp ──────────────────────────────────
//
// Flow (3-step state machine):
//   1. assign_lead intent → auth check → list unassigned leads (numbered)
//   2. User picks lead → fetch inspectors + AI suggestion → show numbered list
//   3. User picks worker → confirmation prompt
//   4. User confirms → assignLead() writes ownerId → ack message
//
// Auth: only isLeadsViewer(user.name) may proceed. Others get a rejection.
// After assignLead() the D3-T3 poller picks up the new ownerId automatically.

const AUTH_REJECT_MSG =
  'אין הרשאה — רק סשה או תצפיתני dev יכולים לשייך לידים.';

/** Entry-point: triggered by the `assign_lead` AI intent or a direct call. */
async function startAssignLeadFlow(user: ResolvedUser): Promise<void> {
  if (!isLeadsViewer(user.name)) {
    await sendTextMessage({ to: user.phone, text: AUTH_REJECT_MSG });
    return;
  }

  const leads = await findUnassignedLeadsForAssignment(20);
  if (leads.length === 0) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'אין כרגע לידים לא משויכים.' });
    return;
  }

  const lines = leads.map((l, i) => {
    const rowData: LeadListRowData = {
      fromName: l.fromName ?? null,
      fromEmail: l.fromEmail ?? null,
      subject: l.subject ?? null,
      receivedAt: l.receivedAt ?? null,
    };
    return `${i + 1}. ${formatLeadListRow(rowData)}`;
  });

  await setContext(user.phone, {
    awaiting: 'assign_lead_pick_lead',
    assignLeadCandidateIds: leads.map((l) => l.id),
    assignLeadCandidateNames: leads.map((l) => l.fromName ?? '—'),
  });
  await sendTextMessage({
    to: user.phone,
    text: `לידים ללא שיוך (${leads.length}):\n\n${lines.join('\n\n')}\n\nהשב במספר כדי לבחור ליד.`,
  });
}

/** State: assign_lead_pick_lead — user picked a lead number. */
async function handleAssignLeadPickLeadReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (!isLeadsViewer(user.name)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: AUTH_REJECT_MSG });
    return;
  }

  if (/^ביטול$/.test(trimmed)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }

  const ids = ctx.assignLeadCandidateIds ?? [];
  const names = ctx.assignLeadCandidateNames ?? [];
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > ids.length) {
    await sendTextMessage({
      to: user.phone,
      text: `אנא השב במספר בין 1 ל-${ids.length} (או "ביטול").`,
    });
    return;
  }

  const leadId = ids[idx - 1];
  const leadName = names[idx - 1] ?? '—';

  // Fetch inspectors then AI suggestion (suggestion needs the candidate list).
  const candidates = await findActiveInspectors();
  const suggestion = await suggestWorkerForLead({ customerName: leadName }, candidates);

  if (candidates.length === 0) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'לא נמצאו עובדים פעילים לשיוך.' });
    return;
  }

  const suggestedCandidate = suggestion.userId
    ? candidates.find((c) => c.id === suggestion.userId) ?? null
    : null;

  const lines = candidates.map((c, i) => `${i + 1}. ${c.name} (${c.role})`);
  const suggestionLine = suggestedCandidate
    ? `הצעת AI: ${suggestedCandidate.name} (${suggestedCandidate.role}) — ${suggestion.reason}.\n`
    : '';

  await setContext(user.phone, {
    awaiting: 'assign_lead_pick_worker',
    assignLeadSelectedLeadId: leadId,
    assignLeadSelectedLeadName: leadName,
    assignLeadWorkerIds: candidates.map((c) => c.id),
    assignLeadWorkerNames: candidates.map((c) => c.name),
  });
  await sendTextMessage({
    to: user.phone,
    text: `${suggestionLine}בחר עובד לשיוך הליד של ${leadName}:\n${lines.join('\n')}\n\nהשב במספר (או "ביטול").`,
  });
}

/** State: assign_lead_pick_worker — user picked a worker number. */
async function handleAssignLeadPickWorkerReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (!isLeadsViewer(user.name)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: AUTH_REJECT_MSG });
    return;
  }

  if (/^ביטול$/.test(trimmed)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }

  const workerIds = ctx.assignLeadWorkerIds ?? [];
  const workerNames = ctx.assignLeadWorkerNames ?? [];
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > workerIds.length) {
    await sendTextMessage({
      to: user.phone,
      text: `אנא השב במספר בין 1 ל-${workerIds.length} (או "ביטול").`,
    });
    return;
  }

  const workerId = workerIds[idx - 1];
  const workerName = workerNames[idx - 1] ?? '—';
  const leadName = ctx.assignLeadSelectedLeadName ?? '—';

  await setContext(user.phone, {
    awaiting: 'assign_lead_confirm',
    assignLeadSelectedLeadId: ctx.assignLeadSelectedLeadId,
    assignLeadSelectedLeadName: leadName,
    assignLeadSelectedWorkerId: workerId,
    assignLeadSelectedWorkerName: workerName,
  });
  // Group A: confirmation via reply buttons; fallback to numbered text.
  const assignConfirmBody = `לשייך את הליד של ${leadName} ל-${workerName}?`;
  try {
    await sendButtonMessage({
      to: user.phone,
      body: assignConfirmBody,
      buttons: [
        { id: 'CONFIRM_YES_ASSIGN_LEAD', title: 'אישור' },
        { id: 'CONFIRM_NO_ASSIGN_LEAD',  title: 'ביטול' },
      ],
    });
  } catch (err) {
    log.warn({ err }, 'sendButtonMessage failed for assign_lead confirm — falling back to text');
    await sendTextMessage({ to: user.phone, text: `${assignConfirmBody}\n1. אישור\n2. ביטול` });
  }
}

/** State: assign_lead_confirm — user typed 1 (confirm) or 2 (cancel). */
async function handleAssignLeadConfirmReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (!isLeadsViewer(user.name)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: AUTH_REJECT_MSG });
    return;
  }

  const leadId = ctx.assignLeadSelectedLeadId;
  const workerId = ctx.assignLeadSelectedWorkerId;
  const workerName = ctx.assignLeadSelectedWorkerName ?? '—';

  if (!leadId || !workerId) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }

  // Accept "1", CONFIRM_YES_*, or any YES word; "2", CONFIRM_NO_*, or NO words cancel.
  const isYes = trimmed === '1' || /^CONFIRM_YES_/i.test(trimmed) || YES_RE.test(trimmed);
  const isNo  = trimmed === '2' || /^CONFIRM_NO_/i.test(trimmed)  || NO_RE.test(trimmed);

  if (isNo) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }

  if (!isYes) {
    await sendTextMessage({ to: user.phone, text: 'השב 1 לאישור או 2 לביטול.' });
    return;
  }

  // Perform the assignment — FIRST bot write to a CRM-owned table (SPEC Addendum 1).
  await assignLead(leadId, workerId, user.id, user.phone);
  await clearContext(user.phone);
  await sendTextMessage({
    to: user.phone,
    text: `הליד שויך ל-${workerName} ✓. הוא יקבל התראה תוך כמה דקות.`,
  });
}

// ── D2-T12: correct site metadata on a TaskField ─────────────────────────────
// Intent: correct_task_field_site
// Auth: WORKER on own TaskField; MANAGER/ADMIN any.
// Flow: resolve TaskField by hint → choose which field → new value → write.

async function startCorrectSiteFlow(user: ResolvedUser, intent: AIIntentResult): Promise<void> {
  const ref = intent.task_reference;
  if (!ref) {
    await setContext(user.phone, { awaiting: 'correct_site_pick_task', intent });
    await sendTextMessage({ to: user.phone, text: 'לאיזו בדיקה הכוונה? ציין שם לקוח או כתובת אתר.' });
    return;
  }
  await resolveAndShowSiteFieldMenu(user, intent, ref);
}

async function resolveAndShowSiteFieldMenu(
  user: ResolvedUser,
  intent: AIIntentResult,
  hint: string,
): Promise<void> {
  const found = await resolveOpenTaskFieldByHint(user.id, hint).catch(() => null);
  if (found === null) {
    await sendTextMessage({ to: user.phone, text: `לא מצאתי בדיקה עבור "${hint}". נסה שוב.` });
    return;
  }
  if ('ambiguous' in found) {
    await setContext(user.phone, { awaiting: 'correct_site_pick_field', intent });
    await sendTextMessage({
      to: user.phone,
      text: `יש מספר בדיקות תואמות. ציין שם לקוח או כתובת מדויקים יותר.`,
    });
    return;
  }
  await showSiteFieldMenu(user, found.taskFieldId);
}

async function showSiteFieldMenu(user: ResolvedUser, taskFieldId: string): Promise<void> {
  await setContext(user.phone, { awaiting: 'correct_site_await_value', taskFieldId });
  await sendTextMessage({
    to: user.phone,
    text: [
      'מה לתקן? כתוב בתבנית: <שדה>: <ערך חדש>',
      '1. כתובת אתר  (siteAddress)',
      '2. עיר  (siteCity)',
      '3. שם איש קשר  (fieldContactName)',
      '4. טלפון איש קשר  (fieldContactPhone)',
      'לדוגמה: "כתובת אתר: רוטשילד 10 תל אביב"',
    ].join('\n'),
  });
}

/** Map of Hebrew label variants → camelCase column key for site metadata fields. */
const SITE_FIELD_MAP: Record<string, keyof import('../services/taskFieldCorrections').SiteMetadataFields> = {
  'כתובת': 'siteAddress', 'כתובת אתר': 'siteAddress', 'siteaddress': 'siteAddress',
  'עיר': 'siteCity', 'sitecity': 'siteCity',
  'שם איש קשר': 'fieldContactName', 'איש קשר': 'fieldContactName',
  'fieldcontactname': 'fieldContactName',
  'טלפון': 'fieldContactPhone', 'טלפון איש קשר': 'fieldContactPhone',
  'fieldcontactphone': 'fieldContactPhone',
};

async function handleCorrectSiteAwaitValueReply(
  user: ResolvedUser,
  raw: string,
  ctx: ConversationState,
): Promise<void> {
  if (!ctx.taskFieldId) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const text = raw.trim();
  if (!text) {
    await showSiteFieldMenu(user, ctx.taskFieldId);
    return;
  }

  // ── Fast path: rigid colon-split template (e.g. "כתובת אתר: רוטשילד 10") ──
  const colonIdx = text.indexOf(':');
  if (colonIdx !== -1) {
    const rawField = text.slice(0, colonIdx).trim().toLowerCase();
    const newValue = text.slice(colonIdx + 1).trim();
    const siteFieldKey = SITE_FIELD_MAP[rawField];
    if (siteFieldKey && newValue) {
      return applySiteCorrection(user, ctx.taskFieldId, siteFieldKey, newValue);
    }
    // Has a colon but field is unrecognized — fall through to AI extractor.
    if (!siteFieldKey) {
      // Check if it looks like a genuine field:value attempt before trying AI.
      // If rawField doesn't look like a key (e.g. it's a URL), still try AI.
      await sendTextMessage({
        to: user.phone,
        text: `לא הכרתי את השדה "${rawField}". השתמש ב: כתובת אתר, עיר, שם איש קשר, טלפון איש קשר.`,
      });
      return;
    }
  }

  // ── AI extraction path (voice / free-text) ──────────────────────────────────
  const SITE_FIELDS: ExtractionRequest['fields'] = [
    { key: 'siteAddress',       labelHe: 'כתובת אתר',       kind: 'address' },
    { key: 'siteCity',          labelHe: 'עיר',              kind: 'string' },
    { key: 'fieldContactName',  labelHe: 'שם איש קשר',      kind: 'string' },
    { key: 'fieldContactPhone', labelHe: 'טלפון איש קשר',   kind: 'phone' },
  ];

  const history = await getHistory(user.phone);
  const result = await extractFromContext({
    message: text,
    intent: 'correct_site',
    fields: SITE_FIELDS,
    history: history.map((t) => ({ role: t.role === 'assistant' ? 'bot' : 'user', content: t.content })),
    todayIsoDate: localJerusalemDate(),
  });

  // Find the single populated field.
  const populatedEntries = SITE_FIELDS
    .map((f) => ({ key: f.key as keyof import('../services/taskFieldCorrections').SiteMetadataFields, value: result.values[f.key] }))
    .filter((e) => typeof e.value === 'string' && e.value.trim());

  // High confidence (>= 0.85) + exactly one field → auto-apply.
  if (result.confidence >= 0.85 && populatedEntries.length === 1) {
    const { key, value } = populatedEntries[0];
    return applySiteCorrection(user, ctx.taskFieldId, key, value as string);
  }

  // Medium confidence (0.60–0.85) + exactly one field → ask for confirmation.
  if (result.confidence >= CONF_LOW && populatedEntries.length === 1) {
    const { key, value } = populatedEntries[0];
    const labelMap: Record<string, string> = {
      siteAddress: 'כתובת אתר', siteCity: 'עיר',
      fieldContactName: 'שם איש קשר', fieldContactPhone: 'טלפון איש קשר',
    };
    const label = labelMap[key] ?? key;
    await setContext(user.phone, {
      ...ctx,
      awaiting: 'correct_site_confirm_extracted',
      pendingExtractedField: key,
      pendingExtractedValue: value as string,
    });
    // Group A: 2-way confirm via reply buttons; fallback to text.
    const siteConfirmBody = `הבנתי: ${label} = ${value as string}\nנכון?`;
    try {
      await sendButtonMessage({
        to: user.phone,
        body: siteConfirmBody,
        buttons: [
          { id: 'CONFIRM_YES_SITE_CORRECT', title: 'אישור' },
          { id: 'CONFIRM_NO_SITE_CORRECT',  title: 'תיקון' },
        ],
      });
    } catch (err) {
      log.warn({ err }, 'sendButtonMessage failed for site_correct confirm — falling back to text');
      await sendTextMessage({ to: user.phone, text: `${siteConfirmBody}\n1. כן  2. לא (שלח שוב בתבנית: <שדה>: <ערך>)` });
    }
    return;
  }

  // Low confidence → fall back to the rigid rejection message.
  await sendTextMessage({
    to: user.phone,
    text: result.clarification
      ?? 'לא הצלחתי לזהות. השתמש בתבנית: <שם שדה>: <ערך חדש>',
  });
}

/** Apply a validated site-metadata correction and clear the context. */
async function applySiteCorrection(
  user: ResolvedUser,
  taskFieldId: string,
  siteFieldKey: keyof import('../services/taskFieldCorrections').SiteMetadataFields,
  newValue: string,
): Promise<void> {
  // Auth check: WORKER can only correct their own TaskField.
  if (!user.isElevated) {
    const taskFieldRow = await getTaskFieldForCorrection(taskFieldId);
    if (!taskFieldRow || taskFieldRow.taskOwnerId !== user.id) {
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'אין הרשאה לתקן בדיקה זו.' });
      return;
    }
  }
  await updateSiteMetadata(taskFieldId, user.id, { [siteFieldKey]: newValue });
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: 'עודכן בהצלחה.' });
  await auditEvent(user, 'correct_task_field_site', null, 'SUCCESS');
}

/** State: correct_site_confirm_extracted — user confirms or rejects AI-extracted value. */
async function handleCorrectSiteConfirmExtractedReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  const isYes = trimmed === '1' || /^CONFIRM_YES_/i.test(trimmed) || YES_RE.test(trimmed);
  const isNo  = trimmed === '2' || /^CONFIRM_NO_/i.test(trimmed)  || /^CONFIRM_EDIT_/i.test(trimmed) || NO_RE.test(trimmed);

  if (isNo || /^ביטול$|^cancel$/i.test(trimmed)) {
    // Revert to the await_value state so they can try again.
    await setContext(user.phone, { awaiting: 'correct_site_await_value', taskFieldId: ctx.taskFieldId });
    await showSiteFieldMenu(user, ctx.taskFieldId!);
    return;
  }
  if (!isYes) {
    await sendTextMessage({ to: user.phone, text: 'השב 1 לאישור או 2 לתיקון.' });
    return;
  }
  if (!ctx.taskFieldId || !ctx.pendingExtractedField || !ctx.pendingExtractedValue) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  return applySiteCorrection(
    user,
    ctx.taskFieldId,
    ctx.pendingExtractedField as keyof import('../services/taskFieldCorrections').SiteMetadataFields,
    ctx.pendingExtractedValue,
  );
}

// ── D2-T13: reassign a Task to another worker ─────────────────────────────────
// Intent: reassign_task — MANAGER / ADMIN only.

async function startReassignTaskFlow(user: ResolvedUser, intent: AIIntentResult): Promise<void> {
  if (!user.isElevated) {
    await sendTextMessage({ to: user.phone, text: 'אין הרשאה — רק מנהל יכול לשייך מחדש.' });
    return;
  }
  const ref = intent.task_reference;
  if (!ref) {
    await setContext(user.phone, { awaiting: 'reassign_pick_task', intent });
    await sendTextMessage({ to: user.phone, text: 'לאיזו משימה הכוונה? ציין שם לקוח, כותרת, או מספר.' });
    return;
  }
  await resolveAndShowWorkerListForReassign(user, intent, ref);
}

async function resolveAndShowWorkerListForReassign(
  user: ResolvedUser,
  intent: AIIntentResult,
  taskRef: string,
): Promise<void> {
  const res = await resolveTask(user, taskRef);
  if (!res.match && (!res.ambiguous || res.candidates.length === 0)) {
    await sendTextMessage({ to: user.phone, text: `לא מצאתי משימה התואמת ל"${taskRef}".` });
    return;
  }
  if (res.ambiguous && res.candidates.length > 0) {
    const lines = res.candidates.map((t, i) => `${i + 1}. ${t.title}`);
    await setContext(user.phone, {
      awaiting: 'task_disambig',
      intent,
      candidateTaskIds: res.candidates.map((t) => t.id),
    });
    await sendTextMessage({
      to: user.phone,
      text: `נמצאו כמה משימות:\n${lines.join('\n')}\nהשב במספר.`,
    });
    return;
  }
  await showWorkerListForReassign(user, intent, res.match!.id);
}

async function showWorkerListForReassign(
  user: ResolvedUser,
  intent: AIIntentResult,
  taskId: string,
): Promise<void> {
  const workers = await findUsersByName('');
  if (!workers || workers.length === 0) {
    await sendTextMessage({ to: user.phone, text: 'לא נמצאו עובדים פעילים.' });
    return;
  }
  const lines = workers.map((w, i) => `${i + 1}. ${w.name}`);
  await setContext(user.phone, {
    awaiting: 'reassign_pick_worker',
    intent,
    candidateTaskIds: [taskId],
    candidateUserIds: workers.map((w) => w.id),
  });
  await sendTextMessage({ to: user.phone, text: `למי לשייך את המשימה?\n${lines.join('\n')}\nהשב במספר.` });
}

async function handleReassignPickWorkerReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (!user.isElevated) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'אין הרשאה — רק מנהל יכול לשייך מחדש.' });
    return;
  }
  if (!ctx.candidateUserIds || !ctx.candidateTaskIds || ctx.candidateTaskIds.length === 0) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > ctx.candidateUserIds.length) {
    await sendTextMessage({ to: user.phone, text: `אנא השב במספר בין 1 ל-${ctx.candidateUserIds.length}.` });
    return;
  }
  const newOwnerId = ctx.candidateUserIds[idx - 1];
  const taskId = ctx.candidateTaskIds[0];
  const result = await reassignTask(taskId, newOwnerId, user.id);
  await clearContext(user.phone);
  let msg = `המשימה שויכה מחדש. ${result.resetCount} שורות בדיקה אופסו.`;
  if (result.hadInProgressRows) msg += ' (שורות שכבר בביצוע לא שונו.)';
  await sendTextMessage({ to: user.phone, text: msg });
  await auditEvent(user, 'reassign_task', taskId, 'SUCCESS');
}

// ── D2-T14: correct inspection type ──────────────────────────────────────────
// Intent: correct_inspection_type
// Auth: WORKER on own TaskField; MANAGER/ADMIN any.
// Flow: resolve TaskField → list types → worker picks → CONFIRM → write + notify.

async function startCorrectInspectionTypeFlow(
  user: ResolvedUser,
  intent: AIIntentResult,
): Promise<void> {
  const ref = intent.task_reference;
  if (!ref) {
    await setContext(user.phone, { awaiting: 'correct_type_pick_task', intent });
    await sendTextMessage({ to: user.phone, text: 'לאיזו בדיקה הכוונה? ציין שם לקוח או כתובת אתר.' });
    return;
  }
  await resolveAndShowTypeList(user, intent, ref);
}

async function resolveAndShowTypeList(
  user: ResolvedUser,
  intent: AIIntentResult,
  hint: string,
): Promise<void> {
  const found = await resolveOpenTaskFieldByHint(user.id, hint).catch(() => null);
  if (found === null) {
    await sendTextMessage({ to: user.phone, text: `לא מצאתי בדיקה פתוחה עבור "${hint}". נסה שם לקוח או כתובת.` });
    return;
  }
  if ('ambiguous' in found) {
    await setContext(user.phone, { awaiting: 'correct_type_pick_task', intent });
    await sendTextMessage({ to: user.phone, text: `יש מספר בדיקות תואמות. ציין שם לקוח מדויק יותר.` });
    return;
  }
  const { taskFieldId } = found;
  // Auth + status check for WORKER.
  if (!user.isElevated) {
    const taskFieldRow = await getTaskFieldForCorrection(taskFieldId);
    if (!taskFieldRow || taskFieldRow.taskOwnerId !== user.id) {
      await sendTextMessage({ to: user.phone, text: 'אין הרשאה לתקן בדיקה זו.' });
      return;
    }
    if (taskFieldRow.fieldStatus === 'FINISHED_FIELD' || taskFieldRow.fieldStatus === 'CANCELED') {
      await sendTextMessage({ to: user.phone, text: 'בדיקה כבר סגורה — לא ניתן לתקן.' });
      return;
    }
  }
  await showInspectionTypeListForCorrection(user, intent, taskFieldId);
}

async function showInspectionTypeListForCorrection(
  user: ResolvedUser,
  intent: AIIntentResult,
  taskFieldId: string,
): Promise<void> {
  const types = await listInspectionTypes();
  if (types.length === 0) {
    await sendTextMessage({ to: user.phone, text: 'לא נמצאו סוגי בדיקות.' });
    return;
  }
  const display = types.slice(0, 20);
  const lines = display.map((t, i) => `${i + 1}. [${t.code}] ${t.labelHe}`);
  await setContext(user.phone, {
    awaiting: 'correct_type_pick_from_list',
    taskFieldId,
    candidateUserIds: display.map((t) => t.id),
  });
  const extraLine = types.length > 20 ? `\nועוד ${types.length - 20}. כתוב מילת חיפוש לצמצום.` : '';
  await sendTextMessage({
    to: user.phone,
    text: `בחר סוג בדיקה חדש (השב במספר), או כתוב מילת חיפוש לסינון:\n${lines.join('\n')}${extraLine}`,
  });
}

async function handleCorrectTypePickFromListReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (!ctx.taskFieldId || !ctx.candidateUserIds) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const idx = parseInt(trimmed, 10);
  if (Number.isInteger(idx) && idx >= 1 && idx <= ctx.candidateUserIds.length) {
    const newTypeId = ctx.candidateUserIds[idx - 1];
    const allTypes = await listInspectionTypes();
    const chosen = allTypes.find((t) => t.id === newTypeId);
    await setContext(user.phone, {
      awaiting: 'correct_type_confirm',
      taskFieldId: ctx.taskFieldId,
      candidateUserIds: [newTypeId],
    });
    // Group A: 2-way confirm via reply buttons; fallback to text.
    const typeConfirmBody = `לשנות את סוג הבדיקה ל-"${chosen?.labelHe ?? newTypeId}"?`;
    try {
      await sendButtonMessage({
        to: user.phone,
        body: typeConfirmBody,
        buttons: [
          { id: 'CONFIRM_YES_TYPE_CORRECT', title: 'אישור' },
          { id: 'CONFIRM_NO_TYPE_CORRECT',  title: 'ביטול' },
        ],
      });
    } catch (err) {
      log.warn({ err }, 'sendButtonMessage failed for type_correct confirm — falling back to text');
      await sendTextMessage({ to: user.phone, text: `${typeConfirmBody}\nהשב "כן" לאישור או "לא" לביטול.` });
    }
    return;
  }
  // Treat as a search term.
  const allTypes = await listInspectionTypes();
  const lower = trimmed.toLowerCase();
  const filtered = allTypes.filter(
    (t) => t.labelHe.includes(trimmed) || t.code.toLowerCase().includes(lower),
  );
  if (filtered.length === 0) {
    await sendTextMessage({ to: user.phone, text: `לא נמצאו תוצאות עבור "${trimmed}". נסה שוב.` });
    return;
  }
  const display = filtered.slice(0, 20);
  const lines = display.map((t, i) => `${i + 1}. [${t.code}] ${t.labelHe}`);
  await setContext(user.phone, {
    awaiting: 'correct_type_pick_from_list',
    taskFieldId: ctx.taskFieldId,
    candidateUserIds: display.map((t) => t.id),
  });
  await sendTextMessage({ to: user.phone, text: `תוצאות חיפוש:\n${lines.join('\n')}` });
}

async function handleCorrectTypeConfirmReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (!ctx.taskFieldId || !ctx.candidateUserIds || ctx.candidateUserIds.length === 0) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  if (NO_RE.test(trimmed) || /^CONFIRM_NO_/i.test(trimmed)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }
  if (!YES_RE.test(trimmed) && !/^CONFIRM_YES_/i.test(trimmed)) {
    await sendTextMessage({ to: user.phone, text: 'השב "כן" לאישור או "לא" לביטול.' });
    return;
  }
  const newTypeId = ctx.candidateUserIds[0];
  try {
    const result = await correctInspectionType(ctx.taskFieldId, newTypeId, user.id, user.name);
    await clearContext(user.phone);
    await sendTextMessage({
      to: user.phone,
      text: `סוג הבדיקה עודכן מ-${result.oldProductName} ל-${result.newProductName}.`,
    });
  } catch (err) {
    await clearContext(user.phone);
    if (err instanceof ClosedInspectionError) {
      await sendTextMessage({ to: user.phone, text: 'בדיקה כבר סגורה — לא ניתן לתקן.' });
    } else {
      log.error({ err, taskFieldId: ctx.taskFieldId, newTypeId }, 'D2-T14: correction failed');
      await sendTextMessage({ to: user.phone, text: 'שגיאה בעדכון. נסה שוב.' });
    }
  }
}

// ── D2-T11: Schedule a new TaskField for an existing Task from WhatsApp ──────
//
// Flow (HANDOFF §3 state machine, 6 states):
//   1. `schedule_task_field` intent → list open Tasks (own for WORKER, any for MANAGER/ADMIN)
//   2. User picks Task number, or types "חיפוש" for the customer-search fallback
//   3. [Fallback] search customer → pick customer → pick Task
//   4. Ask for date+time (MVP: ISO or DD/MM/YYYY HH:mm; voice via D5-T2 pre-transcribed)
//   5. Ask for duration (default 60 min)
//   6. Confirmation card → confirm → INSERT TaskField (workerNotifiedAt=NULL)
//      → D5-T6 poller sends the §6 assignment card automatically.
//
// Auth (HANDOFF §2): WORKER/TECHNICIAN → own tasks only. MANAGER/ADMIN → any.
// The bot NEVER writes Task or Customer (HANDOFF §1 / SPEC §1 core principle 2).

/** True when the caller may schedule TaskFields for any Task. */
function canScheduleAnyTask(user: ResolvedUser): boolean {
  return user.role === 'MANAGER' || user.role === 'ADMIN';
}

/** Render a numbered task list for the task-pick prompt (D2-T11). */
function renderTaskCandidateList(
  tasks: NonNullable<ConversationState['scheduleTaskCandidates']>,
): string {
  return tasks.map((t, i) => {
    const customer = t.customerName ?? '(לקוח לא ידוע)';
    const type = t.inspectionLabelHe ?? t.productName ?? '(סוג לא ידוע)';
    const city = t.siteCity ? ` — ${t.siteCity}` : '';
    return `${i + 1}. ${customer} — ${type}${city}`;
  }).join('\n');
}

/** Entry-point: triggered by the `schedule_task_field` AI intent (D2-T11). */
async function startScheduleTaskFieldFlow(
  user: ResolvedUser,
  prefilledStartAt: string | null,
  prefilledDuration: number | null,
  prefilledSpecialInstructions: string | null,
): Promise<void> {
  const rawTasks = canScheduleAnyTask(user)
    ? await findOpenTasksForAdmin(10)
    : await findOpenTasksForOwner(user.id, 10);

  if (rawTasks.length === 0) {
    await clearContext(user.phone);
    await sendTextMessage({
      to: user.phone,
      text: canScheduleAnyTask(user)
        ? 'לא נמצאו משימות פתוחות לתזמון.'
        : 'אין לך משימות פתוחות לתזמון.',
    });
    return;
  }

  const taskCandidates = rawTasks.map((t: TaskCandidate) => ({
    id: t.id,
    title: t.title,
    customerName: t.customerName,
    inspectionLabelHe: t.inspectionLabelHe,
    siteCity: t.siteCity,
    inspectionTypeId: t.inspectionTypeId,
    family: t.inspectionFamily,
    ownerId: t.ownerId,
    siteAddress: t.siteAddress,
    fieldContactName: t.fieldContactName,
    fieldContactPhone: t.fieldContactPhone,
    navigationUrl: t.navigationUrl,
    productName: t.productName,
  }));

  const list = renderTaskCandidateList(taskCandidates);
  await setContext(user.phone, {
    awaiting: 'schedule_intake_pick_task',
    scheduleTaskCandidates: taskCandidates,
    scheduleStartAt: prefilledStartAt ?? undefined,
    scheduleDurationMinutes: prefilledDuration ?? undefined,
    scheduleSpecialInstructions: prefilledSpecialInstructions ?? undefined,
  });
  await sendTextMessage({
    to: user.phone,
    text: `המשימות הפתוחות שלך:\n${list}\n\nבחר מספר, או כתוב "חיפוש" לחיפוש לפי לקוח, או "ביטול".`,
  });
}

/** State: schedule_intake_pick_task — user picks a number or types "חיפוש" / "ביטול". */
async function handleSchedulePickTaskReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (/^ביטול$|^cancel$/i.test(trimmed)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }
  if (/^חיפוש$/.test(trimmed)) {
    await setContext(user.phone, { ...ctx, awaiting: 'schedule_search_customer' });
    await sendTextMessage({ to: user.phone, text: 'שם הלקוח או חלק ממנו?' });
    return;
  }
  const tasks = ctx.scheduleTaskCandidates ?? [];
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > tasks.length) {
    await sendTextMessage({
      to: user.phone,
      text: `אנא השב במספר בין 1 ל-${tasks.length}, "חיפוש", או "ביטול".`,
    });
    return;
  }
  await scheduleProcessChosenTask(user, ctx, tasks[idx - 1]);
}

/** Internal: validate chosen Task then route to time or duration prompt. */
async function scheduleProcessChosenTask(
  user: ResolvedUser,
  ctx: ConversationState,
  chosen: NonNullable<ConversationState['scheduleTaskCandidates']>[number],
): Promise<void> {
  if (!canScheduleAnyTask(user) && chosen.ownerId !== user.id) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'אין הרשאה למשימה הזאת.' });
    return;
  }
  if (!chosen.inspectionTypeId || !chosen.family) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'סוג הבדיקה של המשימה לא בקטלוג — פנה לאדמין.' });
    return;
  }
  const selectedTask: NonNullable<ConversationState['scheduleSelectedTask']> = {
    id: chosen.id, title: chosen.title, customerName: chosen.customerName,
    inspectionLabelHe: chosen.inspectionLabelHe, inspectionTypeId: chosen.inspectionTypeId,
    family: chosen.family, ownerId: chosen.ownerId, siteAddress: chosen.siteAddress,
    siteCity: chosen.siteCity, fieldContactName: chosen.fieldContactName,
    fieldContactPhone: chosen.fieldContactPhone, navigationUrl: chosen.navigationUrl,
  };
  if (ctx.scheduleStartAt) {
    await setContext(user.phone, {
      awaiting: 'schedule_await_duration', scheduleSelectedTask: selectedTask,
      scheduleStartAt: ctx.scheduleStartAt, scheduleDurationMinutes: ctx.scheduleDurationMinutes,
      scheduleSpecialInstructions: ctx.scheduleSpecialInstructions,
    });
    await sendTextMessage({ to: user.phone, text: 'משך? (ברירת מחדל: 60 דקות. שלח מספר בדקות או "אישור")' });
    return;
  }
  await setContext(user.phone, {
    awaiting: 'schedule_await_time', scheduleSelectedTask: selectedTask,
    scheduleDurationMinutes: ctx.scheduleDurationMinutes,
    scheduleSpecialInstructions: ctx.scheduleSpecialInstructions,
  });
  await sendTextMessage({ to: user.phone, text: 'מתי? (תאריך + שעה. למשל: "05/07/2026 10:00" או "2026-07-05T10:00")' });
}

/** State: schedule_search_customer — user typed a customer name query. */
async function handleScheduleSearchCustomerReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (/^ביטול$|^cancel$/i.test(trimmed)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }
  if (!trimmed) {
    await sendTextMessage({ to: user.phone, text: 'שם הלקוח או חלק ממנו?' });
    return;
  }
  const customers = await findCustomersByName(trimmed, 10);
  if (customers.length === 0) {
    await sendTextMessage({ to: user.phone, text: `לא נמצאו לקוחות עבור "${trimmed}". נסה שם אחר או כתוב "ביטול".` });
    return;
  }
  const lines = customers.map((c, i) => {
    const w = c.openTaskCount === 1 ? '1 משימה פתוחה' : `${c.openTaskCount} משימות פתוחות`;
    return `${i + 1}. ${c.name} — ${w}`;
  });
  await setContext(user.phone, { ...ctx, awaiting: 'schedule_pick_from_search', scheduleCustomerCandidates: customers });
  await sendTextMessage({ to: user.phone, text: `מצאתי:\n${lines.join('\n')}\nבחר לקוח (או "ביטול").` });
}

/** State: schedule_pick_from_search — user picks a customer, then we show their Tasks. */
async function handleSchedulePickFromSearchReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (/^ביטול$|^cancel$/i.test(trimmed)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }
  const customers = ctx.scheduleCustomerCandidates ?? [];
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > customers.length) {
    await sendTextMessage({ to: user.phone, text: `אנא השב במספר בין 1 ל-${customers.length} (או "ביטול").` });
    return;
  }
  const chosen = customers[idx - 1];
  const rawTasks = await findOpenTasksForCustomer(chosen.id, 10);
  if (rawTasks.length === 0) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: `אין משימות פתוחות עבור ${chosen.name}.` });
    return;
  }
  const filteredTasks = canScheduleAnyTask(user) ? rawTasks : rawTasks.filter((t) => t.ownerId === user.id);
  if (filteredTasks.length === 0) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: `אין לך משימות פתוחות עבור ${chosen.name}.` });
    return;
  }
  const taskCandidates = filteredTasks.map((t: TaskCandidate) => ({
    id: t.id, title: t.title, customerName: t.customerName,
    inspectionLabelHe: t.inspectionLabelHe, siteCity: t.siteCity,
    inspectionTypeId: t.inspectionTypeId, family: t.inspectionFamily,
    ownerId: t.ownerId, siteAddress: t.siteAddress,
    fieldContactName: t.fieldContactName, fieldContactPhone: t.fieldContactPhone,
    navigationUrl: t.navigationUrl, productName: t.productName,
  }));
  const list = renderTaskCandidateList(taskCandidates);
  await setContext(user.phone, {
    ...ctx, awaiting: 'schedule_intake_pick_task',
    scheduleTaskCandidates: taskCandidates, scheduleCustomerCandidates: undefined,
  });
  await sendTextMessage({ to: user.phone, text: `משימות פתוחות של ${chosen.name}:\n${list}\nבחר משימה (או "ביטול").` });
}

/** State: schedule_await_time — user types a date+time (ISO, DD/MM/YYYY HH:mm, or Hebrew). */
async function handleScheduleAwaitTimeReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (/^ביטול$|^cancel$/i.test(trimmed)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }
  if (!trimmed) {
    await sendTextMessage({ to: user.phone, text: 'מתי? (תאריך + שעה)' });
    return;
  }
  // Fast path: Try ISO then DD/MM/YYYY HH:mm.
  let isoStart: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)) {
    isoStart = trimmed;
  } else {
    const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[T ](\d{1,2}):(\d{2})/);
    if (m) {
      isoStart = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}:00+03:00`;
    }
  }
  // AI extraction path for Hebrew / voice-style date input ("מחר ב-10", "יום ראשון בעשר").
  if (!isoStart || isNaN(new Date(isoStart).getTime())) {
    const result = await extractFromContext({
      message: trimmed,
      intent: 'schedule_time',
      fields: [{ key: 'iso_datetime', labelHe: 'תאריך ושעה', kind: 'datetime', required: true }],
      todayIsoDate: localJerusalemDate(),
    });
    const aiIso = result.values.iso_datetime;
    if (result.confidence >= 0.6 && typeof aiIso === 'string' && aiIso.trim()) {
      isoStart = aiIso.trim();
    }
  }
  if (!isoStart || isNaN(new Date(isoStart).getTime())) {
    await sendTextMessage({
      to: user.phone,
      text: 'לא הצלחתי להבין את התאריך. נסה: "05/07/2026 10:00" או "2026-07-05T10:00".',
    });
    return;
  }
  if (new Date(isoStart) <= new Date()) {
    await sendTextMessage({ to: user.phone, text: 'לא ניתן לתזמן בעבר. אנא בחר תאריך עתידי.' });
    return;
  }
  await setContext(user.phone, { ...ctx, awaiting: 'schedule_await_duration', scheduleStartAt: new Date(isoStart).toISOString() });
  await sendTextMessage({ to: user.phone, text: 'משך? (ברירת מחדל: 60 דקות. שלח מספר בדקות או "אישור")' });
}

/** Parses a Hebrew duration string to minutes. Returns null if unparseable. */
function parseHebrewDuration(input: string): number | null {
  const t = input.trim();
  // "אישור" / "ok" — accept default
  if (/^אישור$|^ok$/i.test(t)) return null; // null = use default
  // Pure integer minutes
  const asInt = parseInt(t, 10);
  if (Number.isInteger(asInt) && asInt > 0 && String(asInt) === t.trim()) return asInt;
  // Hebrew patterns
  if (/^שעתיים$/.test(t)) return 120;
  if (/^שעה וחצי$|^שעה ו-?30$/.test(t)) return 90;
  if (/^שעה ו-?45$/.test(t)) return 105;
  if (/^שעה ו-?(\d+)/.test(t)) {
    const m = t.match(/^שעה ו-?(\d+)/);
    if (m) return 60 + parseInt(m[1], 10);
  }
  if (/^שעה$/.test(t)) return 60;
  // "45 דקות" or "45דקות"
  const minutesMatch = t.match(/^(\d+)\s*דקות?$/);
  if (minutesMatch) return parseInt(minutesMatch[1], 10);
  return undefined as unknown as null; // truly unparseable
}

/** State: schedule_await_duration — user types minutes or "אישור". */
async function handleScheduleAwaitDurationReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (/^ביטול$|^cancel$/i.test(trimmed)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }
  let duration = ctx.scheduleDurationMinutes ?? 60;
  if (trimmed && !/^אישור$|^ok$/i.test(trimmed)) {
    // Fast path: try Hebrew duration patterns before calling AI.
    const parsed = parseHebrewDuration(trimmed);
    if (typeof parsed === 'number' && parsed > 0) {
      duration = parsed;
    } else if (parsed === null) {
      // "אישור" — keep default
    } else {
      // AI extraction path for more complex phrasing.
      const result = await extractFromContext({
        message: trimmed,
        intent: 'schedule_duration',
        fields: [{ key: 'duration_minutes', labelHe: 'משך בדקות', kind: 'number', required: true }],
      });
      const aiDuration = result.values.duration_minutes;
      if (result.confidence >= 0.6 && typeof aiDuration === 'number' && aiDuration > 0) {
        duration = aiDuration;
      } else {
        await sendTextMessage({ to: user.phone, text: 'שלח מספר דקות (למשל 90), "שעה", "שעה וחצי", או "אישור" לברירת המחדל (60 דקות).' });
        return;
      }
    }
  }
  const task = ctx.scheduleSelectedTask;
  if (!task || !ctx.scheduleStartAt) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const startFormatted = `${fmtDate(ctx.scheduleStartAt)} ${fmtTime(ctx.scheduleStartAt)}`;
  const confirmBody = [
    'לאישור:',
    `לקוח: ${task.customerName ?? '(לא ידוע)'}`,
    `בדיקה: ${task.inspectionLabelHe ?? task.title}`,
    `כתובת: ${[task.siteAddress, task.siteCity].filter(Boolean).join(', ') || '—'}`,
    `איש קשר: ${[task.fieldContactName, task.fieldContactPhone].filter(Boolean).join(', ') || '—'}`,
    `מתי: ${startFormatted}`,
    `משך: ${duration} דקות`,
  ].join('\n');
  await setContext(user.phone, { ...ctx, awaiting: 'schedule_confirm', scheduleDurationMinutes: duration });
  // Group A: confirmation via reply buttons; fallback to numbered text.
  try {
    await sendButtonMessage({
      to: user.phone,
      body: confirmBody,
      buttons: [
        { id: 'CONFIRM_YES_SCHEDULE', title: 'אישור' },
        { id: 'CONFIRM_NO_SCHEDULE',  title: 'ביטול' },
      ],
    });
  } catch (err) {
    log.warn({ err }, 'sendButtonMessage failed for schedule confirm — falling back to text');
    await sendTextMessage({ to: user.phone, text: `${confirmBody}\n\n1. אישור  2. ביטול` });
  }
}

/** State: schedule_confirm — user types 1 (confirm) or 2 (cancel) or taps a button. */
async function handleScheduleConfirmReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  const isYes = trimmed === '1' || /^CONFIRM_YES_/i.test(trimmed) || YES_RE.test(trimmed);
  const isNo  = trimmed === '2' || /^CONFIRM_NO_/i.test(trimmed)  || NO_RE.test(trimmed);
  if (isNo || /^ביטול$|^cancel$/i.test(trimmed)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }
  if (!isYes) {
    await sendTextMessage({ to: user.phone, text: 'השב 1 לאישור או 2 לביטול.' });
    return;
  }
  const task = ctx.scheduleSelectedTask;
  const startAt = ctx.scheduleStartAt;
  const duration = ctx.scheduleDurationMinutes ?? 60;
  if (!task || !startAt || !task.inspectionTypeId || !task.family) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  // Final auth re-check at commit time (HANDOFF §2).
  if (!canScheduleAnyTask(user) && task.ownerId !== user.id) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'אין הרשאה למשימה הזאת.' });
    return;
  }
  try {
    const { taskFieldId } = await scheduleTaskField({
      taskId: task.id,
      inspectionTypeId: task.inspectionTypeId,
      family: task.family,
      appointmentTitle: `בדיקה נוספת ל-${task.customerName ?? task.title}`,
      scheduledStartAt: startAt,
      durationMinutes: duration,
      siteAddress: task.siteAddress,
      siteCity: task.siteCity,
      fieldContactName: task.fieldContactName,
      fieldContactPhone: task.fieldContactPhone,
      navigationUrl: task.navigationUrl,
      specialInstructions: ctx.scheduleSpecialInstructions ?? null,
      updatedByUserId: user.id,
    });
    await clearContext(user.phone);
    await sendTextMessage({
      to: user.phone,
      text: `התיזמון נקלט.\nTaskField ID: ${taskFieldId}\nהטכנאי יקבל כרטיס משימה תוך כמה דקות.`,
    });
  } catch (err) {
    log.error({ err, userId: user.id, taskId: task.id }, 'D2-T11: scheduleTaskField INSERT failed');
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה בשמירת התיזמון. נסה שוב מאוחר יותר.' });
  }
}

// Manager menu: unified 6-item manager menu handlers ─────────────────────────
//
// Architecture:
// - showMenu() sets awaiting to 'mgr_menu_root' for manager users
// - continueConversation() dispatches 'mgr_menu_root' → handleMgrMenuRootReply
// - handleMgrMenuRootReply → handleMenuRoute (reuses the same route dispatcher)
// - Sub-menus each have their own 'mgr_*_sub' awaiting state
// - Inline actions (correct site / type / reassign) prime the existing D2-T12/T13/T14
//   flows by setting taskFieldId on context and jumping to the right awaiting state,
//   skipping the initial pick-task step.
//
// All queries are READ-ONLY via managerViews.ts. CRM writes go through the
// existing services (taskFieldCorrections, incomingLeads.assignLead).

/** Delegate to the shared formatter helper (Bug 2 fix). */
function mgrFieldStatusHe(status: string): string {
  return inspFieldStatusHe(status);
}

/** Format DD/MM from a YYYY-MM-DD string (no TZ shift). */
function fmtDDMM(localDate: string): string {
  const m = localDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}` : localDate;
}

// ── 1. Management snapshot (one-shot, no sub-menu) ───────────────────────────

async function showMgrSnapshot(user: ResolvedUser): Promise<void> {
  const localDate = localJerusalemDate();
  const snap = await getManagementSnapshot(localDate);

  const text = [
    `תמונת מצב — ${fmtDDMM(localDate)}:`,
    `בדיקות שטח היום: ${snap.today.total} (בוצעו ${snap.today.finished}, בתהליך ${snap.today.inProgress}, ממתינות ${snap.today.pending})`,
    `חריגים פתוחים: ${snap.openExceptions}`,
    `לידים לטיפול: ${snap.leads.totalOpen} (מהלילה: ${snap.leads.overnight}, מעל שעה: ${snap.leads.escalated})`,
  ].join('\n');

  await sendTextMessage({ to: user.phone, text });
  // Layer 1 fix: restore mgr_menu_root so the next bare digit picks the right item.
  // Do NOT re-send the menu text — the snapshot is a one-shot display; the state
  // preservation alone is enough for "2" to route to item 2 on the next turn.
  await setContext(user.phone, { awaiting: 'mgr_menu_root' });
}

// ── 2. Today's field inspections ─────────────────────────────────────────────

async function showMgrTodayInspections(user: ResolvedUser): Promise<void> {
  const localDate = localJerusalemDate();
  const rows = await getTodayFieldInspections(localDate);

  if (rows.length === 0) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: `אין בדיקות שטח משובצות להיום (${fmtDDMM(localDate)}).` });
    return;
  }

  const lines = rows.map((r, i) => {
    const rowData: InspectionListRowData = {
      taskTitle: r.taskTitle,
      typeLabelHe: r.typeLabelHe,
      timeHm: r.timeHm,
      siteCity: r.siteCity,
      fieldStatus: r.fieldStatus,
      workerName: r.workerName,
      dateStr: localDate,
    };
    // Today's org-wide list: include worker name for each row
    return `${i + 1}. ${formatInspectionListRow(rowData, true)}`;
  });

  await setContext(user.phone, {
    awaiting: 'mgr_today_pick_task',
    mgrTaskFieldIds: rows.map((r) => r.taskFieldId),
    mgrTaskIds: rows.map((r) => r.taskId),
  });
  await sendChunked(user.phone,
    `בדיקות שטח היום — ${fmtDDMM(localDate)} (${rows.length}):\n\n${lines.join('\n\n')}\n\nבחר מספר לפרטים ופעולות, או "חזרה" לתפריט.`,
  );
}

async function handleMgrMenuRootReply(
  user: ResolvedUser,
  trimmed: string,
  _ctx: ConversationState,
): Promise<void> {
  if (/^חזרה$|^תפריט$|^menu$/i.test(trimmed)) {
    await showMenu(user);
    return;
  }

  // Accept MGR_MENU_N list-tap payloads (e.g. "MGR_MENU_2") as equivalent to typing the digit.
  const listTapMatch = trimmed.match(/^MGR_MENU_(\d+)$/i);
  const resolvedTrimmed = listTapMatch ? listTapMatch[1] : trimmed;

  const items = menuItemsFor(user);
  const idx = parseInt(resolvedTrimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    await sendTextMessage({ to: user.phone, text: `אנא השב במספר בין 1 ל-${items.length}.` });
    return;
  }
  await handleMenuRoute(user, items[idx - 1]);
}

async function handleMgrTodayPickTaskReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (/^חזרה$/.test(trimmed)) {
    await showMenu(user);
    return;
  }
  const ids = ctx.mgrTaskFieldIds ?? [];
  const taskIds = ctx.mgrTaskIds ?? [];
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > ids.length) {
    await sendTextMessage({ to: user.phone, text: `אנא השב במספר בין 1 ל-${ids.length} או "חזרה".` });
    return;
  }
  const taskFieldId = ids[idx - 1];
  const taskId = taskIds[idx - 1];
  await showMgrTaskFieldDetail(user, taskFieldId, taskId, 'mgr_today_action');
}

// ── 3. Exceptions sub-menu ───────────────────────────────────────────────────

function renderMgrExceptionsSub(): string {
  return [
    'חריגים ודיווחים — בחר:',
    '1. חריגים פתוחים',
    '2. משימות לא אושרו',
    '3. משימות עם בעיה',
    '4. ממתינות למידע',
    '5. לא סגרו יום',
    '6. חזרה',
  ].join('\n');
}

async function showMgrExceptionsSub(user: ResolvedUser): Promise<void> {
  await setContext(user.phone, { awaiting: 'mgr_exceptions_sub' });
  await sendTextMessage({ to: user.phone, text: renderMgrExceptionsSub() });
}

async function handleMgrExceptionsSubReply(user: ResolvedUser, trimmed: string): Promise<void> {
  const idx = parseInt(trimmed, 10);
  if (idx === 6 || /^חזרה$/.test(trimmed)) {
    await showMenu(user);
    return;
  }

  const filterMap: Record<number, import('../services/managerViews').FieldExceptionFilter> = {
    1: 'open_exceptions',
    2: 'not_confirmed',
    3: 'has_problem',
    4: 'waiting_for_info',
    5: 'not_closed',
  };
  const labelMap: Record<number, string> = {
    1: 'חריגים פתוחים',
    2: 'משימות לא אושרו',
    3: 'משימות עם בעיה',
    4: 'ממתינות למידע',
    5: 'לא סגרו יום',
  };

  const filter = filterMap[idx];
  if (!filter) {
    await sendTextMessage({ to: user.phone, text: renderMgrExceptionsSub() });
    return;
  }

  const localDate = localJerusalemDate();
  const rows = await getFieldExceptionRows(localDate, filter);
  const label = labelMap[idx];

  if (rows.length === 0) {
    await setContext(user.phone, { awaiting: 'mgr_exceptions_sub' });
    await sendTextMessage({
      to: user.phone,
      text: `אין פריטים בקטגוריה "${label}".\n\n${renderMgrExceptionsSub()}`,
    });
    return;
  }

  const lines = rows.map((r, i) => {
    const shortLabel = hebrewShortLabel(r.taskTitle, r.workerName ?? '—');
    const city   = r.siteCity ?? '—';
    const status = mgrFieldStatusHe(r.fieldStatus);
    const desc   = r.description ? `\n   ${r.description}` : '';
    return `${i + 1}. ${shortLabel}\n   ${city}  ·  ${status}${desc}`;
  });

  await setContext(user.phone, {
    awaiting: 'mgr_exceptions_pick_row',
    mgrTaskFieldIds: rows.map((r) => r.taskFieldId),
    mgrTaskIds: rows.map((r) => r.taskId),
  });
  await sendChunked(user.phone,
    `${label} (${rows.length}):\n\n${lines.join('\n\n')}\n\nבחר מספר לפרטים, או "חזרה".`,
  );
}

async function handleMgrExceptionsPickRowReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (/^חזרה$/.test(trimmed)) {
    await showMgrExceptionsSub(user);
    return;
  }
  const ids = ctx.mgrTaskFieldIds ?? [];
  const taskIds = ctx.mgrTaskIds ?? [];
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > ids.length) {
    await sendTextMessage({ to: user.phone, text: `אנא השב במספר בין 1 ל-${ids.length} או "חזרה".` });
    return;
  }
  const taskFieldId = ids[idx - 1];
  const taskId = taskIds[idx - 1];
  await showMgrTaskFieldDetail(user, taskFieldId, taskId, 'mgr_exceptions_action');
}

// ── 4. Leads sub-menu ────────────────────────────────────────────────────────

function renderMgrLeadsSub(): string {
  return [
    'לידים ממתינים לטיפול — בחר:',
    '1. לידים לא משויכים',
    '2. לידים שעברו שעה ללא שיוך',
    '3. שיוך ליד לעובד',
    '4. חזרה',
  ].join('\n');
}

async function showMgrLeadsSub(user: ResolvedUser): Promise<void> {
  await setContext(user.phone, { awaiting: 'mgr_leads_sub' });
  await sendTextMessage({ to: user.phone, text: renderMgrLeadsSub() });
}

async function handleMgrLeadsSubReply(user: ResolvedUser, trimmed: string): Promise<void> {
  const idx = parseInt(trimmed, 10);
  if (idx === 4 || /^חזרה$/.test(trimmed)) {
    await showMenu(user);
    return;
  }

  if (idx === 3) {
    // Assign lead — requires isLeadsViewer
    if (!isLeadsViewer(user.name)) {
      await setContext(user.phone, { awaiting: 'mgr_leads_sub' });
      await sendTextMessage({
        to: user.phone,
        text: 'אין הרשאה — רק סשה או תצפיתני dev יכולים לשייך לידים.\n\n' + renderMgrLeadsSub(),
      });
      return;
    }
    await startAssignLeadFlow(user);
    return;
  }

  if (idx === 1) {
    // Unassigned leads
    const leads = await findUnassignedLeadsForAssignment(20);
    if (leads.length === 0) {
      await setContext(user.phone, { awaiting: 'mgr_leads_sub' });
      await sendTextMessage({ to: user.phone, text: 'אין לידים לא משויכים כרגע.\n\n' + renderMgrLeadsSub() });
      return;
    }
    const lines = leads.map((l, i) => {
      const rowData: LeadListRowData = {
        fromName: l.fromName ?? null,
        fromEmail: l.fromEmail ?? null,
        subject: l.subject ?? null,
        receivedAt: l.receivedAt ?? null,
      };
      return `${i + 1}. ${formatLeadListRow(rowData)}`;
    });
    await setContext(user.phone, {
      awaiting: 'mgr_leads_pick_row',
      mgrLeadIds: leads.map((l) => l.id),
      mgrLeadNames: leads.map((l) => l.fromName ?? '—'),
    });
    await sendChunked(user.phone, `לידים לא משויכים (${leads.length}):\n\n${lines.join('\n\n')}\n\nבחר מספר לפרטים, או "חזרה".`);
    return;
  }

  if (idx === 2) {
    // Escalation candidates
    const { findEscalationCandidates } = await import('../services/incomingLeads');
    const leads = await findEscalationCandidates(20);
    if (leads.length === 0) {
      await setContext(user.phone, { awaiting: 'mgr_leads_sub' });
      await sendTextMessage({ to: user.phone, text: 'אין לידים שעברו שעה ללא שיוך כרגע.\n\n' + renderMgrLeadsSub() });
      return;
    }
    const lines = leads.map((l, i) => {
      const rowData: LeadListRowData = {
        fromName: l.fromName ?? null,
        fromEmail: l.fromEmail ?? null,
        subject: l.subject ?? null,
        receivedAt: l.receivedAt ?? null,
      };
      return `${i + 1}. ${formatLeadListRow(rowData)}`;
    });
    await setContext(user.phone, {
      awaiting: 'mgr_leads_pick_row',
      mgrLeadIds: leads.map((l) => l.id),
      mgrLeadNames: leads.map((l) => l.fromName ?? '—'),
    });
    await sendChunked(user.phone, `לידים שעברו שעה ללא שיוך (${leads.length}):\n\n${lines.join('\n\n')}\n\nבחר מספר לפרטים, או "חזרה".`);
    return;
  }

  await sendTextMessage({ to: user.phone, text: renderMgrLeadsSub() });
}

async function handleMgrLeadsPickRowReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (/^חזרה$/.test(trimmed)) {
    await showMgrLeadsSub(user);
    return;
  }
  const ids = ctx.mgrLeadIds ?? [];
  const names = ctx.mgrLeadNames ?? [];
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > ids.length) {
    await sendTextMessage({ to: user.phone, text: `אנא השב במספר בין 1 ל-${ids.length} או "חזרה".` });
    return;
  }
  const leadId = ids[idx - 1];
  const leadName = names[idx - 1] ?? '—';
  // Show lead details — read from IncomingLead
  void leadId; // referenced for display only (no ID-based fetch in this list path)
  // Layer 1 fix: restore mgr_menu_root so the next bare digit picks the right item.
  await setContext(user.phone, { awaiting: 'mgr_menu_root' });
  await sendTextMessage({
    to: user.phone,
    text: `ליד: ${leadName}\nלשיוך, בחר אפשרות 3 בתפריט הלידים.`,
  });
}

// ── 5. Workers sub-menu ───────────────────────────────────────────────────────

function renderMgrWorkersSub(): string {
  return [
    'עובדים וסיכומי יום — בחר:',
    '1. סיכום יום — כל העובדים (טבלה)',
    '2. בחר עובד לצפייה בסיכום שלו',
    '3. חזרה',
  ].join('\n');
}

async function showMgrWorkersSub(user: ResolvedUser): Promise<void> {
  await setContext(user.phone, { awaiting: 'mgr_workers_sub' });
  await sendTextMessage({ to: user.phone, text: renderMgrWorkersSub() });
}

async function handleMgrWorkersSubReply(
  user: ResolvedUser,
  trimmed: string,
  _ctx: ConversationState,
): Promise<void> {
  const idx = parseInt(trimmed, 10);
  if (idx === 3 || /^חזרה$/.test(trimmed)) {
    await showMenu(user);
    return;
  }

  const localDate = localJerusalemDate();

  if (idx === 1) {
    const rows = await getAllWorkersDayOverview(localDate);
    if (rows.length === 0) {
      await setContext(user.phone, { awaiting: 'mgr_workers_sub' });
      await sendTextMessage({ to: user.phone, text: `אין עובדים עם בדיקות היום (${fmtDDMM(localDate)}).\n\n${renderMgrWorkersSub()}` });
      return;
    }
    const lines = rows.map((r) => `${r.workerName}: ${r.finished}/${r.total} · חריגים ${r.exceptions}`);
    await setContext(user.phone, { awaiting: 'mgr_workers_sub' });
    await sendChunked(user.phone, `סיכום יום — ${fmtDDMM(localDate)}:\n${lines.join('\n')}\n\n${renderMgrWorkersSub()}`);
    return;
  }

  if (idx === 2) {
    const rows = await getAllWorkersDayOverview(localDate);
    if (rows.length === 0) {
      await setContext(user.phone, { awaiting: 'mgr_workers_sub' });
      await sendTextMessage({ to: user.phone, text: `אין עובדים עם בדיקות היום.\n\n${renderMgrWorkersSub()}` });
      return;
    }
    const lines = rows.map((r, i) => `${i + 1}. ${r.workerName}`);
    await setContext(user.phone, {
      awaiting: 'mgr_workers_pick_worker',
      mgrWorkerIds: rows.map((r) => r.workerId),
      mgrWorkerNames: rows.map((r) => r.workerName),
    });
    await sendTextMessage({
      to: user.phone,
      text: `בחר עובד (${rows.length}):\n${lines.join('\n')}\n\nהשב במספר, או "חזרה".`,
    });
    return;
  }

  await sendTextMessage({ to: user.phone, text: renderMgrWorkersSub() });
}

async function handleMgrWorkersPickWorkerReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (/^חזרה$/.test(trimmed)) {
    await showMgrWorkersSub(user);
    return;
  }
  const ids = ctx.mgrWorkerIds ?? [];
  const names = ctx.mgrWorkerNames ?? [];
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > ids.length) {
    await sendTextMessage({ to: user.phone, text: `אנא השב במספר בין 1 ל-${ids.length} או "חזרה".` });
    return;
  }
  const workerId = ids[idx - 1];
  const workerName = names[idx - 1] ?? '—';
  const localDate = localJerusalemDate();
  const detail = await getWorkerDayDetail(workerId, localDate);

  if (detail.total === 0) {
    await setContext(user.phone, { awaiting: 'mgr_workers_sub' });
    await sendTextMessage({ to: user.phone, text: `אין בדיקות היום עבור ${workerName}.\n\n${renderMgrWorkersSub()}` });
    return;
  }

  const lines = detail.inspections.map((r, i) => {
    const rowData: InspectionListRowData = {
      taskTitle: r.taskTitle,
      typeLabelHe: r.typeLabelHe,
      timeHm: r.timeHm,
      siteCity: r.siteCity,
      fieldStatus: r.fieldStatus,
      dateStr: localDate,
    };
    return `${i + 1}. ${formatInspectionListRow(rowData)}`;
  });
  const summary = `סיכום: ${detail.finished}/${detail.total} בוצעו, חריגים פתוחים: ${detail.openExceptions}`;

  // Layer 1 fix: restore mgr_menu_root so the next bare digit picks the right item.
  await setContext(user.phone, { awaiting: 'mgr_menu_root' });
  await sendChunked(user.phone,
    `${workerName} — היום (${fmtDDMM(localDate)}):\n\n${lines.join('\n\n')}\n\n${summary}`,
  );
}

// ── 6. Search sub-menu ────────────────────────────────────────────────────────

function renderMgrSearchSub(): string {
  return [
    'מה לחפש?',
    '1. לפי לקוח',
    '2. לפי עובד',
    '3. לפי מק"ט',
    '4. חזרה',
  ].join('\n');
}

async function showMgrSearchSub(user: ResolvedUser): Promise<void> {
  await setContext(user.phone, { awaiting: 'mgr_search_sub' });
  await sendTextMessage({ to: user.phone, text: renderMgrSearchSub() });
}

async function handleMgrSearchSubReply(user: ResolvedUser, trimmed: string): Promise<void> {
  const idx = parseInt(trimmed, 10);
  if (idx === 4 || /^חזרה$/.test(trimmed)) {
    await showMenu(user);
    return;
  }

  const promptMap: Record<number, string> = {
    1: 'שם לקוח / חלק ממנו:',
    2: 'שם עובד / חלק ממנו:',
    3: 'מק"ט (קוד מוצר):',
  };
  const kindMap: Record<number, 'customer' | 'worker' | 'product'> = {
    1: 'customer',
    2: 'worker',
    3: 'product',
  };

  const prompt = promptMap[idx];
  const kind = kindMap[idx];
  if (!prompt || !kind) {
    await sendTextMessage({ to: user.phone, text: renderMgrSearchSub() });
    return;
  }

  await setContext(user.phone, { awaiting: 'mgr_search_await_query', mgrSearchKind: kind });
  await sendTextMessage({ to: user.phone, text: prompt });
}

async function handleMgrSearchAwaitQueryReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (/^חזרה$/.test(trimmed)) {
    await showMgrSearchSub(user);
    return;
  }
  if (!trimmed) {
    await sendTextMessage({ to: user.phone, text: 'אנא כתוב טקסט לחיפוש.' });
    return;
  }

  const kind = ctx.mgrSearchKind;
  if (!kind) {
    await showMgrSearchSub(user);
    return;
  }

  // AI extraction: strip polite prefixes from the search query.
  const extractedQuery = await extractNote(trimmed, 'field_notes');
  const searchQuery = (extractedQuery && extractedQuery.trim()) ? extractedQuery.trim() : trimmed;

  let results: TodayFieldInspectionRow[] = [];

  if (kind === 'customer') {
    // findCustomersByName is already imported; we need TaskField rows for those customers.
    // Reuse the searchTasksByWorkerName pattern but for customer name via managerViews.
    // We'll query via getFieldExceptionRows or a new helper — but we already have
    // getTodayFieldInspections filtered. Use searchTasksByWorkerName is for workers.
    // For customers, do a direct pool query via the imported managerViews helper.
    // The brief says findCustomersByName already exists — use it to find customer IDs,
    // then fetch their TaskFields. For simplicity, use the ILIKE approach directly
    // through a dedicated path: search by customer name in managerViews is covered by
    // the existing getTodayFieldInspections + client-side filter, but the spec says
    // we can add searchTasksByWorkerName. For customers, the brief says "findCustomersByName
    // already exists" — use it, then join. Since we don't have a searchTasksByCustomerName
    // function yet, do it inline via the existing findCustomersByName + a follow-on query.
    // Actually, the simpler route: use the existing query helpers by ILIKE on customer name.
    // We'll do a filtered fetch via the pool directly (same pattern as managerViews).
    const { rows } = await import('../db/connection').then(async ({ pool }) => {
      return pool.query<TodayFieldInspectionRow>(
        `SELECT
           tf.id AS "taskFieldId", tf."taskId" AS "taskId",
           u.name AS "workerName",
           -- Customer name: COALESCE across Customer/Lead/Project/IncomingLead/Task (SCHEMA_CRM.md)
           COALESCE(
             c.name,
             l."fullName",
             NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
             l.company,
             p.client,
             il."fromName",
             NULLIF(TRIM(t.title), ''),
             NULLIF(TRIM(t.description), '')
           ) AS "customerName",
           to_char(tf."scheduledStartAt" AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI') AS "timeHm",
           tf."siteCity" AS "siteCity", tf."fieldStatus" AS "fieldStatus",
           tf.family AS family, it."labelHe" AS "typeLabelHe"
         FROM "TaskField" tf
         JOIN "Task" t             ON t.id  = tf."taskId"
         JOIN "InspectionType" it  ON it.id = tf."inspectionTypeId"
         LEFT JOIN "Customer"     c  ON c.id  = t."customerId"
         LEFT JOIN "Lead"         l  ON l.id  = t."leadId"
         LEFT JOIN "Project"      p  ON p.id  = t."projectId"
         LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
         LEFT JOIN "User" u          ON u.id  = t."ownerId"
         WHERE c.name ILIKE '%' || $1 || '%'
         ORDER BY tf."scheduledStartAt" DESC LIMIT 20`,
        [searchQuery],
      );
    });
    results = rows;
  } else if (kind === 'worker') {
    results = await searchTasksByWorkerName(searchQuery);
  } else if (kind === 'product') {
    results = await searchTasksByProductCode(searchQuery);
  }

  if (results.length === 0) {
    await setContext(user.phone, { awaiting: 'mgr_search_await_query', mgrSearchKind: kind });
    await sendTextMessage({ to: user.phone, text: `לא נמצאו תוצאות עבור "${searchQuery}". נסה שוב או "חזרה".` });
    return;
  }

  const lines = results.map((r, i) => {
    const rowData: InspectionListRowData = {
      taskTitle: r.taskTitle,
      typeLabelHe: r.typeLabelHe,
      timeHm: r.timeHm,
      siteCity: r.siteCity,
      fieldStatus: r.fieldStatus,
      workerName: r.workerName,
    };
    // For product search, include worker in the row; for worker/customer
    // search, the worker/customer is already the search context.
    const showWorker = kind === 'product';
    return `${i + 1}. ${formatInspectionListRow(rowData, showWorker)}`;
  });

  await setContext(user.phone, {
    awaiting: 'mgr_search_pick_task',
    mgrTaskFieldIds: results.map((r) => r.taskFieldId),
    mgrTaskIds: results.map((r) => r.taskId),
    mgrSearchKind: kind,
  });
  await sendChunked(user.phone,
    `תוצאות חיפוש '${trimmed}' — ${results.length} בדיקות:\n\n${lines.join('\n\n')}\n\nבחר מספר לפרטים, או "חזרה".`,
  );
}

async function handleMgrSearchPickTaskReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (/^חזרה$/.test(trimmed)) {
    await showMgrSearchSub(user);
    return;
  }
  const ids = ctx.mgrTaskFieldIds ?? [];
  const taskIds = ctx.mgrTaskIds ?? [];
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > ids.length) {
    await sendTextMessage({ to: user.phone, text: `אנא השב במספר בין 1 ל-${ids.length} או "חזרה".` });
    return;
  }
  const taskFieldId = ids[idx - 1];
  const taskId = taskIds[idx - 1];
  await showMgrTaskFieldDetail(user, taskFieldId, taskId, 'mgr_search_action');
}

// ── Shared: TaskField detail + inline actions ─────────────────────────────────
// Used by items 2, 3, and 6. Shows full details + inline action menu.
// Inline actions prime the existing D2-T12/T13/T14 flows with the already-picked
// taskFieldId and skip the initial pick-task step.

const MGR_TASK_INLINE_ACTIONS = [
  '1. תיקון פרטי ביקור',
  '2. תיקון סוג בדיקה',
  '3. שיוך מחדש',
  '4. חזרה',
].join('\n');

// Group C: detail-view action prompt via List Message (4 options > 3-button limit).
const MGR_ACTION_LIST_SECTIONS = [{
  title: 'פעולות',
  rows: [
    { id: 'ACTION_CORRECT_SITE', title: 'תיקון פרטי ביקור' },
    { id: 'ACTION_CORRECT_TYPE', title: 'תיקון סוג בדיקה' },
    { id: 'ACTION_REASSIGN',     title: 'שיוך מחדש' },
    { id: 'ACTION_BACK',         title: 'חזרה' },
  ],
}];

async function showMgrTaskFieldDetail(
  user: ResolvedUser,
  taskFieldId: string,
  taskId: string,
  returnState: 'mgr_today_action' | 'mgr_exceptions_action' | 'mgr_search_action',
): Promise<void> {
  const detail = await getTaskFieldDetail(taskFieldId);
  if (!detail) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'לא נמצאה בדיקה. נסה שוב.' });
    return;
  }

  const detailData: InspectionDetailData = {
    taskTitle: detail.taskTitle,
    typeLabelHe: detail.typeLabelHe,
    workerName: detail.workerName,
    customerName: detail.customerName,
    siteAddress: detail.siteAddress,
    siteCity: detail.siteCity,
    fieldContactName: detail.fieldContactName,
    fieldContactPhone: detail.fieldContactPhone,
    fieldStatus: detail.fieldStatus,
    scheduledStartAt: detail.scheduledStartAt,
    specialInstructions: detail.specialInstructions,
    fieldNotes: detail.fieldNotes ?? null,
    problemNote: detail.problemNote ?? (detail.missingReportInfoNote ? `חסר: ${detail.missingReportInfoNote}` : null),
  };

  await setContext(user.phone, {
    awaiting: returnState,
    mgrSelectedTaskFieldId: taskFieldId,
    mgrSelectedTaskId: taskId,
  });

  // Group C: send detail text first, then action list message.
  // Fall back to combined text+actions on list-message failure.
  const detailText = formatInspectionDetail(detailData, '');
  const detailBody = detailText.replace(/\n\s*$/, ''); // trim trailing newlines
  try {
    await sendTextMessage({ to: user.phone, text: detailBody.trim() });
    await sendListMessage({
      to: user.phone,
      body: 'מה תרצה לעשות?',
      buttonLabel: 'בחר פעולה',
      sections: MGR_ACTION_LIST_SECTIONS,
    });
  } catch (err) {
    log.warn({ err }, 'sendListMessage failed for action prompt — falling back to text');
    await sendTextMessage({ to: user.phone, text: `${detailBody.trim()}\n\nמה תרצה לעשות?\n${MGR_TASK_INLINE_ACTIONS}` });
  }
}

// Normalize ACTION_* list-tap payloads to the digit equivalent.
function resolveActionPayload(trimmed: string): string {
  const payloadMap: Record<string, string> = {
    'ACTION_CORRECT_SITE': '1',
    'ACTION_CORRECT_TYPE': '2',
    'ACTION_REASSIGN':     '3',
    'ACTION_BACK':         '4',
  };
  return payloadMap[trimmed.toUpperCase()] ?? trimmed;
}

/** Handles inline action picks from detail views (items 2, 3, 6). */
async function handleMgrTaskActionReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  // Normalize ACTION_* list-tap payloads to the digit equivalent (Agent A).
  const resolved = resolveActionPayload(trimmed);

  // Fast path: "חזרה" or "4" → back to menu.
  if (/^חזרה$/.test(resolved) || resolved === '4') {
    await showMenu(user);
    return;
  }

  // Fast path: "ביטול" / "cancel" / "עצור" → cancel without AI (Agent B).
  if (/^ביטול$|^cancel$|^עצור$/i.test(trimmed)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }

  const taskFieldId = ctx.mgrSelectedTaskFieldId;
  const taskId = ctx.mgrSelectedTaskId;
  if (!taskFieldId || !taskId) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }

  const idx = parseInt(resolved, 10);

  if (idx === 1) {
    // תיקון פרטי ביקור → prime D2-T12 flow (skip pick-task step)
    await showSiteFieldMenu(user, taskFieldId);
    return;
  }

  if (idx === 2) {
    // תיקון סוג בדיקה → prime D2-T14 flow (skip pick-task step)
    // We already have the taskFieldId, so go straight to the type list.
    const fakeIntent: import('../types').AIIntentResult = {
      intent: 'correct_inspection_type',
      confidence: 1,
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
    };
    await showInspectionTypeListForCorrection(user, fakeIntent, taskFieldId);
    return;
  }

  if (idx === 3) {
    // שיוך מחדש → MANAGER/ADMIN only, prime D2-T13 flow
    if (!user.isElevated) {
      await sendTextMessage({ to: user.phone, text: 'אין הרשאה — רק מנהל יכול לשייך מחדש.\n\n' + MGR_TASK_INLINE_ACTIONS });
      return;
    }
    // Show the worker list directly (skip pick-task step by passing the known taskId).
    const fakeIntent: import('../types').AIIntentResult = {
      intent: 'reassign_task',
      confidence: 1,
      task_reference: taskId,
      field: null,
      new_value: null,
      params: {},
      missing_fields: [],
      clarification: null,
      requires_confirmation: false,
      requires_manager_approval: false,
      transition: null,
      problem_type: null,
    };
    await showWorkerListForReassign(user, fakeIntent, taskId);
    return;
  }

  // Free-text / voice path: context-aware AI extraction (Agent B).
  // The user is VIEWING a specific TaskField and sent free-text or a voice message.
  // We pass the current TaskField values to the extractor so it can understand
  // references like "מרונית לוי" as "the current contact" rather than a search term.
  await handleMgrActionFreeText(user, trimmed, ctx, taskFieldId, taskId);
}

/**
 * Context-aware free-text handler for mgr_*_action states.
 * Invoked when the user sends non-digit text while viewing a specific TaskField.
 *
 * Flow:
 * 1. Call extractInspectionActions → get actions[].
 * 2. Low confidence / empty → numbered menu fallback.
 * 3. Single action → fast-path (same as before).
 * 4. Multiple actions → build consolidated confirm, store pendingMultiActions,
 *    set awaiting=mgr_multi_action_confirm.
 */
async function handleMgrActionFreeText(
  user: ResolvedUser,
  text: string,
  ctx: ConversationState,
  taskFieldId: string,
  taskId: string,
): Promise<void> {
  // Load current TaskField values for the extractor context.
  const snapshot = await getTaskFieldValuesForContext(taskFieldId);
  const ctxValues = snapshot
    ? {
        customerName: snapshot.customerName,
        contactName: snapshot.contactName,
        contactPhone: snapshot.contactPhone,
        siteAddress: snapshot.siteAddress,
        siteCity: snapshot.siteCity,
        inspectionTypeLabel: snapshot.inspectionTypeLabel,
        workerName: snapshot.workerName,
      }
    : undefined;

  const history = await getHistory(user.phone);
  const mappedHistory = history.map((t) => ({
    role: (t.role === 'assistant' ? 'bot' : 'user') as 'user' | 'bot',
    content: t.content,
  }));

  const extraction = await extractInspectionActions(text, ctxValues, mappedHistory);

  const { actions, confidence, clarification } = extraction;

  // ── Fallback: low confidence or nothing extracted ──────────────────────────
  if (confidence < CONF_LOW || actions.length === 0) {
    await setContext(user.phone, {
      awaiting: ctx.awaiting,
      mgrSelectedTaskFieldId: taskFieldId,
      mgrSelectedTaskId: taskId,
    });
    await sendTextMessage({
      to: user.phone,
      text: (clarification ?? 'לא הבנתי — כתוב 1/2/3/4 או נסח מחדש.') + '\n\n' + MGR_TASK_INLINE_ACTIONS,
    });
    return;
  }

  // ── Single action fast-path ────────────────────────────────────────────────
  if (actions.length === 1) {
    await dispatchSingleAction(user, ctx, taskFieldId, taskId, actions[0], confidence, clarification);
    return;
  }

  // ── Multi-action path ──────────────────────────────────────────────────────
  // Filter out back/cancel from the batch (shouldn't appear, but be defensive).
  const batchActions = actions.filter(
    (a) => a.action !== 'back' && a.action !== 'cancel' && a.action !== null,
  );

  if (batchActions.length === 0) {
    // All actions were back/cancel — treat as cancel.
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }

  // Build human-readable summary of planned changes.
  const labelMap: Record<string, string> = {
    siteAddress: 'כתובת האתר', siteCity: 'עיר',
    fieldContactName: 'שם איש קשר', fieldContactPhone: 'טלפון איש קשר',
    newInspectionTypeQuery: 'סוג בדיקה', newWorkerName: 'עובד',
    newSiteAddress: 'כתובת האתר', newSiteCity: 'עיר',
    newContactName: 'שם איש קשר', newContactPhone: 'טלפון איש קשר',
  };

  const lines: string[] = [];
  for (const act of batchActions) {
    if (act.action === 'correct_site') {
      if (act.newSiteAddress) lines.push(`כתובת האתר → ${act.newSiteAddress}${act.newSiteCity ? ', ' + act.newSiteCity : ''}`);
      else if (act.newSiteCity) lines.push(`עיר → ${act.newSiteCity}`);
      if (act.newContactName) lines.push(`שם איש קשר → ${act.newContactName}${act.newContactPhone ? ', ' + act.newContactPhone : ''}`);
      else if (act.newContactPhone) lines.push(`טלפון איש קשר → ${act.newContactPhone}`);
    } else if (act.action === 'correct_type') {
      lines.push(`סוג בדיקה → ${act.newInspectionTypeQuery ?? '(לא צוין)'}`);
    } else if (act.action === 'reassign') {
      lines.push(`עובד → ${act.newWorkerName ?? '(לא צוין)'}`);
    }
  }

  const numberedLines = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const clarNote = confidence < CONF_HIGH && confidence >= CONF_LOW
    ? '\n\nאני לא בטוח לגמרי — בדוק שוב:'
    : '';

  const confirmBody = `הבנתי — ${lines.length} שינויים:${clarNote}\n\n${numberedLines}`;

  await setContext(user.phone, {
    awaiting: 'mgr_multi_action_confirm',
    mgrSelectedTaskFieldId: taskFieldId,
    mgrSelectedTaskId: taskId,
    pendingMultiActions: batchActions,
  });

  await sendButtonMessage({
    to: user.phone,
    body: confirmBody,
    buttons: [
      { id: CONFIRM_YES_MULTI, title: 'אישור' },
      { id: CONFIRM_NO_MULTI,  title: 'ביטול' },
    ],
  });
}

/**
 * Dispatch a single extracted action — shared by the single-action fast path
 * and internally by multi-action helpers.
 */
async function dispatchSingleAction(
  user: ResolvedUser,
  ctx: ConversationState,
  taskFieldId: string,
  taskId: string,
  item: InspectionActionExtractionItem,
  confidence: number,
  clarification: string | null,
): Promise<void> {
  const action = item.action;

  if (!action) {
    // No recognisable action even at high confidence — fall back to menu.
    await setContext(user.phone, {
      awaiting: ctx.awaiting,
      mgrSelectedTaskFieldId: taskFieldId,
      mgrSelectedTaskId: taskId,
    });
    await sendTextMessage({
      to: user.phone,
      text: (clarification ?? 'לא הבנתי — כתוב 1/2/3/4 או נסח מחדש.') + '\n\n' + MGR_TASK_INLINE_ACTIONS,
    });
    return;
  }

  if (action === 'back') {
    await showMenu(user);
    return;
  }

  if (action === 'cancel') {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }

  if (action === 'correct_site') {
    // Extract whichever site fields were provided.
    const siteFields: Array<{ key: keyof import('../services/taskFieldCorrections').SiteMetadataFields; value: string }> = [];
    const fieldMappings: Array<[keyof InspectionActionExtractionItem, keyof import('../services/taskFieldCorrections').SiteMetadataFields]> = [
      ['newSiteAddress', 'siteAddress'],
      ['newSiteCity', 'siteCity'],
      ['newContactName', 'fieldContactName'],
      ['newContactPhone', 'fieldContactPhone'],
    ];
    for (const [extractedKey, dbKey] of fieldMappings) {
      const val = item[extractedKey];
      if (typeof val === 'string' && val.trim()) {
        siteFields.push({ key: dbKey, value: val.trim() });
      }
    }

    if (siteFields.length === 0) {
      // AI said correct_site but gave no values — show the site field menu.
      await showSiteFieldMenu(user, taskFieldId);
      return;
    }

    if (confidence >= CONF_HIGH) {
      // High confidence: apply all extracted fields directly.
      for (const { key, value } of siteFields) {
        await updateSiteMetadata(taskFieldId, user.id, { [key]: value });
      }
      await clearContext(user.phone);
      const summary = siteFields.map(({ key, value }) => {
        const labelMap: Record<string, string> = {
          siteAddress: 'כתובת אתר', siteCity: 'עיר',
          fieldContactName: 'שם איש קשר', fieldContactPhone: 'טלפון איש קשר',
        };
        return `${labelMap[key] ?? key}: ${value}`;
      }).join(', ');
      await sendTextMessage({ to: user.phone, text: `עודכן בהצלחה — ${summary}` });
      await auditEvent(user, 'correct_task_field_site', null, 'SUCCESS');
      return;
    }

    // Medium confidence (0.60–0.85): echo back the extracted values and ask for confirmation.
    const { key: firstKey, value: firstValue } = siteFields[0];
    const labelMap: Record<string, string> = {
      siteAddress: 'כתובת אתר', siteCity: 'עיר',
      fieldContactName: 'שם איש קשר', fieldContactPhone: 'טלפון איש קשר',
    };
    const label = labelMap[firstKey] ?? firstKey;
    await setContext(user.phone, {
      awaiting: 'correct_site_confirm_extracted',
      taskFieldId,
      pendingExtractedField: firstKey,
      pendingExtractedValue: firstValue,
    });
    await sendTextMessage({
      to: user.phone,
      text: `הבנתי: ${label} = ${firstValue}\nנכון? 1. כן  2. לא`,
    });
    return;
  }

  if (action === 'correct_type') {
    const typeQuery = item.newInspectionTypeQuery?.trim() ?? null;

    const allTypes = await listInspectionTypes();
    let typesToShow = allTypes;

    if (typeQuery) {
      const lower = typeQuery.toLowerCase();
      const filtered = allTypes.filter(
        (t) => t.labelHe.includes(typeQuery) || t.code.toLowerCase().includes(lower),
      );
      if (filtered.length > 0) typesToShow = filtered;
    }

    const display = typesToShow.slice(0, 20);
    if (display.length === 0) {
      // Fall back to full type list.
      const fakeIntent: import('../types').AIIntentResult = {
        intent: 'correct_inspection_type', confidence: 1, task_reference: null,
        field: null, new_value: null, params: {}, missing_fields: [], clarification: null,
        requires_confirmation: false, requires_manager_approval: false, transition: null, problem_type: null,
      };
      await showInspectionTypeListForCorrection(user, fakeIntent, taskFieldId);
      return;
    }

    const typeLines = display.map((t, i) => `${i + 1}. [${t.code}] ${t.labelHe}`);
    await setContext(user.phone, {
      awaiting: 'correct_type_pick_from_list',
      taskFieldId,
      candidateUserIds: display.map((t) => t.id),
    });
    const extraLine = typesToShow.length > 20 ? `\nועוד ${typesToShow.length - 20}. כתוב מילת חיפוש לצמצום.` : '';
    await sendTextMessage({
      to: user.phone,
      text: `בחר סוג בדיקה חדש (השב במספר):\n${typeLines.join('\n')}${extraLine}`,
    });
    return;
  }

  if (action === 'reassign') {
    if (!user.isElevated) {
      await setContext(user.phone, {
        awaiting: ctx.awaiting,
        mgrSelectedTaskFieldId: taskFieldId,
        mgrSelectedTaskId: taskId,
      });
      await sendTextMessage({ to: user.phone, text: 'אין הרשאה — רק מנהל יכול לשייך מחדש.\n\n' + MGR_TASK_INLINE_ACTIONS });
      return;
    }

    const workerQuery = item.newWorkerName?.trim() ?? null;

    // Fuzzy match on the worker list.
    const allWorkers = await findUsersByName(workerQuery ?? '');
    if (!allWorkers || allWorkers.length === 0) {
      await setContext(user.phone, {
        awaiting: ctx.awaiting,
        mgrSelectedTaskFieldId: taskFieldId,
        mgrSelectedTaskId: taskId,
      });
      await sendTextMessage({
        to: user.phone,
        text: `לא נמצאו עובדים${workerQuery ? ` בשם "${workerQuery}"` : ''}.\n\n${MGR_TASK_INLINE_ACTIONS}`,
      });
      return;
    }

    if (allWorkers.length === 1 && confidence >= CONF_HIGH) {
      // Single unambiguous match + high confidence → confirm before writing.
      const worker = allWorkers[0];
      await setContext(user.phone, {
        awaiting: 'reassign_pick_worker',
        candidateTaskIds: [taskId],
        candidateUserIds: [worker.id],
      });
      // Pre-select: skip the list and jump to confirmation.
      await sendTextMessage({
        to: user.phone,
        text: `לשייך את המשימה ל-${worker.name}?\n1. כן  2. לא`,
      });
      return;
    }

    // Multiple workers or medium confidence → show numbered list.
    const workerLines = allWorkers.map((w, i) => `${i + 1}. ${w.name}`);
    const fakeIntent: import('../types').AIIntentResult = {
      intent: 'reassign_task', confidence: 1, task_reference: taskId, field: null,
      new_value: null, params: {}, missing_fields: [], clarification: null,
      requires_confirmation: false, requires_manager_approval: false, transition: null, problem_type: null,
    };
    await setContext(user.phone, {
      awaiting: 'reassign_pick_worker',
      intent: fakeIntent,
      candidateTaskIds: [taskId],
      candidateUserIds: allWorkers.map((w) => w.id),
    });
    await sendTextMessage({ to: user.phone, text: `למי לשייך את המשימה?\n${workerLines.join('\n')}\nהשב במספר.` });
    return;
  }

  // Unknown action — show the menu again.
  await setContext(user.phone, {
    awaiting: ctx.awaiting,
    mgrSelectedTaskFieldId: taskFieldId,
    mgrSelectedTaskId: taskId,
  });
  await sendTextMessage({
    to: user.phone,
    text: (clarification ?? 'לא הבנתי — כתוב 1/2/3/4 או נסח מחדש.') + '\n\n' + MGR_TASK_INLINE_ACTIONS,
  });
}

/**
 * Handle the confirm/cancel reply in the mgr_multi_action_confirm state.
 * Loops through pendingMultiActions, applies each, and reports the result.
 */
async function handleMgrMultiActionConfirmReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  const taskFieldId = ctx.mgrSelectedTaskFieldId;
  const taskId = ctx.mgrSelectedTaskId;
  const pendingActions = ctx.pendingMultiActions ?? [];

  const isYes = trimmed === '1'
    || /^CONFIRM_YES_/i.test(trimmed)
    || YES_RE.test(trimmed);
  const isNo = trimmed === '2'
    || /^CONFIRM_NO_/i.test(trimmed)
    || NO_RE.test(trimmed);

  if (isNo || (!isYes && !isNo)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }

  // Yes — apply all pending actions in order.
  if (!taskFieldId || !taskId) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית — לא נמצא מזהה בדיקה. נסה שוב.' });
    return;
  }

  const results: Array<{ label: string; ok: boolean; note?: string }> = [];

  for (const act of pendingActions) {
    if (act.action === 'correct_site') {
      const fieldMappings: Array<[keyof typeof act, keyof import('../services/taskFieldCorrections').SiteMetadataFields]> = [
        ['newSiteAddress', 'siteAddress'],
        ['newSiteCity', 'siteCity'],
        ['newContactName', 'fieldContactName'],
        ['newContactPhone', 'fieldContactPhone'],
      ];

      let appliedAny = false;
      for (const [extractedKey, dbKey] of fieldMappings) {
        const val = act[extractedKey];
        if (typeof val === 'string' && val.trim()) {
          try {
            await updateSiteMetadata(taskFieldId, user.id, { [dbKey]: val.trim() });
            appliedAny = true;
          } catch (err) {
            log.error({ err, dbKey }, 'multi-action: updateSiteMetadata failed');
          }
        }
      }

      // Build a human-readable label for the result line.
      const parts: string[] = [];
      if (act.newSiteAddress) parts.push(`כתובת: ${act.newSiteAddress}`);
      if (act.newSiteCity) parts.push(`עיר: ${act.newSiteCity}`);
      if (act.newContactName) parts.push(`איש קשר: ${act.newContactName}`);
      if (act.newContactPhone) parts.push(`טלפון: ${act.newContactPhone}`);
      const label = parts.join(', ') || 'עדכון פרטי אתר';
      results.push({ label, ok: appliedAny });

    } else if (act.action === 'correct_type') {
      const typeQuery = act.newInspectionTypeQuery?.trim() ?? '';
      const label = `סוג בדיקה${typeQuery ? ': ' + typeQuery : ''}`;
      try {
        const allTypes = await listInspectionTypes();
        const lower = typeQuery.toLowerCase();
        const matches = typeQuery
          ? allTypes.filter((t) => t.labelHe.includes(typeQuery) || t.code.toLowerCase().includes(lower))
          : [];

        if (matches.length === 1) {
          await correctInspectionType(taskFieldId, matches[0].id, user.id, user.name);
          results.push({ label, ok: true });
        } else if (matches.length === 0) {
          results.push({ label, ok: false, note: `לא נמצא סוג בדיקה "${typeQuery}"` });
        } else {
          // Ambiguous — skip
          results.push({ label, ok: false, note: `מספר סוגים תואמים "${typeQuery}" — לא בוצע` });
        }
      } catch (err) {
        log.error({ err }, 'multi-action: correctInspectionType failed');
        results.push({ label, ok: false, note: 'שגיאה בעדכון סוג בדיקה' });
      }

    } else if (act.action === 'reassign') {
      const workerQuery = act.newWorkerName?.trim() ?? '';
      const label = `עובד${workerQuery ? ': ' + workerQuery : ''}`;
      if (!user.isElevated) {
        results.push({ label, ok: false, note: 'אין הרשאה לשיוך מחדש' });
        continue;
      }
      try {
        const matches = await findUsersByName(workerQuery);
        if (matches.length === 1) {
          await reassignTask(taskId, matches[0].id, user.id);
          results.push({ label, ok: true });
        } else if (matches.length === 0) {
          results.push({ label, ok: false, note: `לא נמצא עובד בשם "${workerQuery}"` });
        } else {
          results.push({ label, ok: false, note: `מספר עובדים תואמים "${workerQuery}" — לא בוצע` });
        }
      } catch (err) {
        log.error({ err }, 'multi-action: reassignTask failed');
        results.push({ label, ok: false, note: 'שגיאה בשיוך מחדש' });
      }
    }
    // back/cancel: already filtered out before storing
  }

  await clearContext(user.phone);

  if (results.length === 0) {
    await sendTextMessage({ to: user.phone, text: 'לא בוצעו שינויים.' });
    return;
  }

  const doneLine = results.filter((r) => r.ok).length > 0 ? 'בוצעו:' : '';
  const summaryLines = results.map((r) => {
    if (r.ok) return `בוצע — ${r.label}`;
    return `לא בוצע — ${r.label}${r.note ? ': ' + r.note : ''}`;
  });

  await sendTextMessage({
    to: user.phone,
    text: [doneLine, ...summaryLines].filter(Boolean).join('\n'),
  });
}
