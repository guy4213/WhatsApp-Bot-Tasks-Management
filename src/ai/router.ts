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
import { pool } from '../db/connection';
import { getProvider } from './provider';
import { parseIntent } from './intentParser';
import { resolveTask } from './taskResolver';
import {
  getContext, setContext, clearContext,
  setActiveInspection, getActiveInspection,
  type ConversationState, type AwaitingKind,
} from '../services/conversationContext';
// UX-T1: smart picker escape (Wave 2 router wiring — see router.ts §"Smart
// Picker Escape" below).
import { classifySmartPickerEscape, FLOW_INTENT_BY_STATE } from './smartPickerEscape';
import { resolveSelfReference, resolveWorkerName, resolveLeadReference } from './nameResolvers';
import { parseTravelMinutes } from './travelEta';
import { resolveQuotedContext, recordTaskFieldRef, type QuotedContext } from '../services/messageRefs';
import {
  openTrackingSession, markArrived as markTrackingArrived, closeSession as closeTrackingSession,
} from '../services/tracking';
import { setViewOwners, getViewOwners, clearViewOwners } from '../services/viewContext';
import { setActiveTask, getActiveTask } from '../services/taskContext';
import { getHistory, appendTurn } from '../services/chatHistory';
import {
  listTasks, getTaskById, getAllowedTaskTypes, getAllowedPriorities, findUsersByName,
  getTaskDetailsForReminder,
} from '../services/tasks';
import { formatTaskDetailsExtended, buildCrmTaskUrl } from '../services/taskDetailFormatter';
import { sendTextMessage, sendButtonMessage, sendListMessage } from '../whatsapp/sender';
import { notify } from '../whatsapp/templates';
import { createProvisioning, buildInlineConfigLink, hasActiveProvisioning } from '../services/owntracksProvisioning';
import { writeAuditLog } from '../utils/auditLog';
import { moduleLogger } from '../utils/logger';
import {
  MENU_TRIGGER_RE, menuItemsFor, renderMenu, type MenuRoute,
  problemTypeMenu, renderProblemTypeMenu,
  statusUpdateMenu, renderStatusUpdateMenu,
  finishedFollowUpMenu, renderFinishedFollowUpMenu,
  daySummaryFollowUpMenu, renderDaySummaryFollowUpMenu,
  missingInfoMenu, renderMissingInfoMenu,
  missingEquipmentMenu, renderMissingEquipmentMenu,
} from './menu';
import {
  findOpenTaskFieldForWorker,
  findActiveInProgressTaskFieldForWorker,
  validateWorkerTaskField,
  writeTravelEta,
  resolveOpenTaskFieldByHint,
  advanceFieldStatus,
  writeFieldNotes,
  writeMissingInfo,
  writeProblem,
  notifyOfficeMissingInfo,
  notifyOfficeProblem,
  notifyOfficeMissingEquipment,
  notifyOfficeCallbackRequest,
  dayFieldSummary,
  confirmInspection,
  declineInspection,
  requestMoreInfo,
  notifyOfficeDeclined,
  notifyOfficeNeedsMoreInfo,
  type AdvanceTransition,
  type OpenTaskFieldPreview,
} from '../services/inspections';
import { getInspectionsForWorkerOnDate, countOpenInspectionsForWorkerOnDate } from '../services/inspectionsQueries';
import {
  getMyInspectionsInRange,
  getAllMyInspections,
  type MyInspectionRangeItem,
} from '../services/myInspectionsRange';
import { parseHebrewInspectionRange } from './dateRangeParser';
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
import { canAssignLeads } from '../services/specialUsers';
// CAL-WA: Outlook calendar over WhatsApp text — delegates to the CRM's stored
// Outlook connection keyed by user.id (same path the voice tools use).
import {
  crmApiConfigured,
  listCrmCalendarEvents,
  createCrmCalendarEvent,
  updateCrmCalendarEvent,
  deleteCrmCalendarEvent,
  type CrmCalendarEvent,
} from '../services/crmApi';
// Manager menu: unified 7-item manager menu view queries.
import {
  getManagementSnapshot,
  getTodayFieldInspections,
  getMyFieldInspectionsToday,
  getFieldExceptionRows,
  getAllWorkersDayOverview,
  getWorkerDayDetail,
  searchTasksByWorkerName,
  searchTasksByProductCode,
  searchTasksByCustomerName,
  searchTasksByAddress,
  searchTasksByPhone,
  searchTasksByTaskId,
  searchTasksByFieldStatus,
  getTaskFieldDetail,
  getTaskFieldValuesForContext,
  type TodayFieldInspectionRow,
} from '../services/managerViews';
import { isManagerMenuUser } from './menu';
import {
  findUnassignedLeadsForAssignment,
  findActiveInspectors,
  assignLead,
  getLeadById,
} from '../services/incomingLeads';
import { suggestWorkerForLead } from './leadSuggester';
import { enrichLead } from '../services/leadCategorizer';
import { formatLeadListRowCompact, formatLeadDetailCompact } from '../whatsapp/leadDisplay';
import {
  extractFromContext, extractNote, extractInspectionActions,
  type ExtractionRequest, type InspectionActionExtractionItem,
} from './contextExtractor';
// Display helpers for manager-menu inspection list rows and detail views (Bug 2 fix).
import {
  hebrewShortLabel,
  formatHebrewDateTime,
  formatShortDateTimeIL,
  formatScheduledStartForPrompt,
  formatInspectionListRow,
  formatInspectionDetail,
  formatLeadListRow,
  fieldStatusHe as inspFieldStatusHe,
  type InspectionListRowData,
  type InspectionDetailData,
  type LeadListRowData,
} from './inspectionFormatters';
// D2-T12/T13/T14: site metadata correction, task reassign, inspection type correction.
// Reschedule: updateTaskFieldSchedule.
import {
  updateSiteMetadata,
  reassignTask,
  correctInspectionType,
  updateTaskFieldSchedule,
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
// D2-T15: pre-inspection reminder payload IDs (source-of-truth helpers).
import {
  preReminderDepartPayloadId,
  preReminderNeedInfoPayloadId,
  preReminderProblemPayloadId,
} from '../services/preInspectionReminder';
// Enhanced due-date reminder: "פרטים נוספים" button payload matcher.
import { matchTaskDetailsPayload } from '../scheduler/jobs/dueDateReminder';

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
  'missing_info_choice', 'missing_equipment_choice', // D5-T19j/k
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
  'mgr_my_today_pick_task',   // D2-T16: manager's own personal inspections today (item 7)
  'mgr_exceptions_pick_row',
  'mgr_leads_pick_row',
  'mgr_workers_pick_worker',
  'mgr_search_pick_task',
]);

/**
 * D5-T16 — TEXT-CAPTURE awaiting states where a mid-flow AI-first pivot is
 * checked. When the user types a NEW top-level intent instead of the expected
 * note/answer, `tryPivotToAIIntent` clears the capture and dispatches the
 * intent. States NOT listed here are either:
 *  - numeric-picker states (handled by the older `NUMERIC_PICKER_AWAITING`
 *    escape hatch above),
 *  - `mgr_*_action` states (they own their own AI-first path via
 *    `tryDispatchWorkerIntentInline` — do NOT pivot-check here or we
 *    double-invoke the LLM), or
 *  - text-refine loops like `correct_type_pick_from_list` where free text is a
 *    search filter over the catalog and escaping would break the loop.
 */
const TEXT_CAPTURE_PIVOT_STATES: Set<AwaitingKind> = new Set<AwaitingKind>([
  // "Note" states — user is expected to type a short free-text answer. If
  // they type a top-level intent instead (mid-flow pivot), escape.
  'missing_info_note',
  'problem_type_note',
  'finished_notes',
  'callback_customer_note',
  'equipment_missing_note',
  'inspection_decline_reason',
  'inspection_need_info_note',
  'pre_reminder_need_info_note',
  'mgr_search_await_query',
  // D5-T19l — "task/customer hint" ENTRY states: the user has just started a
  // correction/reassign flow and is asked for a free-text reference (name /
  // address / task id) to look up a task. Nothing has been selected yet, so
  // pivoting away loses no in-progress state — same shape as
  // `mgr_search_await_query` above, just missed when D5-T16 first shipped.
  // Without this, typing "תפריט" or another top-level request here was fed
  // straight into the task-hint resolver as literal search text instead of
  // being recognized, leaving the user stuck without "ביטול".
  'correct_site_pick_task',
  'reassign_pick_task',
  'correct_type_pick_task',
  'correct_type_await_search',
  // NOTE: schedule_await_time / schedule_await_duration / correct_site_*
  // (except pick_task above) / correct_site_confirm_extracted /
  // correct_type_pick_from_list / correct_type_confirm / *_disambig / any
  // *_confirm state are deliberately EXCLUDED — the user is deep in a
  // specific multi-step flow (or has already narrowed to a specific
  // candidate) and their reply is meant as a value (date / minutes /
  // corrected address / yes-no confirmation) or a list-refine search.
  // Pivoting mid-flow there would cause more accidental exits than
  // intentional ones.
]);

// Nav words a numeric picker will accept without escaping to AI: pure digits,
// Hebrew/English navigation vocabulary, or interactive button/list payload IDs
// (CONFIRM_*, MGR_MENU_*, ACTION_*) that arrive from tapped WhatsApp buttons.
const NUMERIC_PICKER_NAV_RE = /^(?:\d+|חזרה|ביטול|עצור|אישור|כן|לא|חיפוש|yes|no|cancel|ok|CONFIRM_(?:YES|NO|EDIT)_\w+|MGR_MENU_\d+|ACTION_(?:CORRECT_SITE|CORRECT_TYPE|REASSIGN|BACK)|MGR_LEADS_\d+|MGR_EXC_\d+|MGR_WRK_\d+|MGR_SRC_\d+|EMP_MENU_\d+|PROBLEM_TYPE_\d+|FIN_FUP_\d+|DAY_FUP_\d+|SITE_FIELD_\d+|STATUS_UPD_\d+)$/i;

// Payload IDs for the multi-action confirmation buttons.
const CONFIRM_YES_MULTI = 'CONFIRM_YES_MULTI_ACTION';
const CONFIRM_NO_MULTI  = 'CONFIRM_NO_MULTI_ACTION';

/**
 * "הבדיקות שלי …" / "המשימות שלי …" free-text intent — any lead-in phrase
 * asking for the user's own inspections (optionally followed by a Hebrew
 * date/range expression). Anchored to the trimmed start so real free text
 * that merely mentions "בדיקות" (e.g. "מה קורה עם בדיקות") does NOT match.
 *
 * The generic phrase "מה יש לי" is ambiguous (can mean tasks, messages, etc.),
 * so we only match it when a date-cue follows. All other alternatives are
 * self-contained (allow empty suffix → defaults to today).
 *
 * Phase 1 expansion — adds display-verb prefixes ("הצג את", "תציג", "תן לי",
 * "אני רוצה לראות") and open-day phrasings ("היום שלי", "מה על הפרק",
 * "מה מחכה לי", "רשימת הבדיקות שלי") so a worker's natural Hebrew never falls
 * through to the AI parser as `unknown`.
 *
 * QA-FIX-6 — a MANAGER asking "המשימות שלי" / "המשימות שלי למחר" (using
 * "משימות" instead of "בדיקות") must hit this same fast path. "משימות" is
 * accepted as a synonym of "בדיקות" everywhere the latter appears (direct
 * form, list form, display-verb forms, "איזה ... יש לי"), EXCEPT there is no
 * "משימות השטח" variant — the "השטח" suffix only ever follows "בדיקות".
 *
 * Captures group 1 = leading phrase, group 2 = suffix (may be empty).
 */
const MY_INSPECTIONS_DATE_CUE_RE = String.raw`(?:היום|מחר|השבוע|החודש|שבוע\s+הבא|חודש\s+הבא|לשבוע\s+הבא|לחודש\s+הבא|לעוד\s+(?:שבוע|חודש)|(?:ב?)?יום\s+(?:ראשון|שני|שלישי|רביעי|חמישי|שישי)|(?:ב)?שבת|בין\s+\d|ב[־\-]?\s*\d)`;
export const MY_INSPECTIONS_RE = new RegExp(
  String.raw`^(` +
  // Direct forms: "הבדיקות שלי", "בדיקות שלי", "בדיקות השטח שלי",
  // "המשימות שלי", "משימות שלי" (no "משימות השטח" variant).
  String.raw`(?:ה?(?:בדיקות(?:\s+השטח)?|משימות)\s+שלי|` +
  // "רשימת הבדיקות שלי" / "רשימה של הבדיקות שלי" / "רשימת המשימות שלי"
  String.raw`רשימ[הת]?\s+(?:של\s+)?ה?(?:בדיקות(?:\s+השטח)?|משימות)\s+שלי|` +
  // Display verbs: "תראה לי (את) הבדיקות שלי", "הצג (לי) את הבדיקות שלי",
  // "תציג לי את הבדיקות שלי", "תן לי (את) הבדיקות שלי",
  // "אני רוצה לראות את הבדיקות שלי" — and the "משימות" synonym forms.
  String.raw`(?:תראה\s+לי\s+את\s+|הצג\s+(?:לי\s+)?(?:את\s+)?|תציג\s+לי\s+(?:את\s+)?|תן\s+לי\s+(?:את\s+)?|אני\s+רוצה\s+לראות\s+(?:את\s+)?)(?:ה)?(?:בדיקות(?:\s+השטח)?|משימות)\s+שלי|` +
  // "איזה בדיקות יש לי" / "איזה משימות יש לי"
  String.raw`איזה\s+(?:בדיקות|משימות)\s+יש\s+לי|` +
  // "היום שלי" / "מה היום שלי"
  String.raw`(?:מה\s+)?היום\s+שלי|` +
  // "מה על הפרק" / "מה מחכה לי"
  String.raw`מה\s+על\s+הפרק|` +
  String.raw`מה\s+מחכה\s+לי)` +
  // Ambiguous "מה יש לי" — only with a date cue
  String.raw`|(?:מה\s+יש\s+לי)(?=\s+${MY_INSPECTIONS_DATE_CUE_RE})` +
  String.raw`)(.*)$`,
);

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

export async function handleAIMessage(user: ResolvedUser, text: string, quotedWamid?: string): Promise<void> {
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

  // D2-T15 pre-reminder button taps. PREREMIND_DEPART / NEED_INFO / PROBLEM.
  // Pattern: PREREMIND_<KIND>_<uuid>. Parsed before the AI/NLU path so the
  // worker's tap always routes here regardless of conversation context.
  const preReminderTap = matchPreReminderTap(text);
  if (preReminderTap) {
    await handlePreReminderTap(user, preReminderTap.kind, preReminderTap.taskFieldId);
    return;
  }

  // Enhanced due-date reminder — "פרטים נוספים" button tap or text trigger.
  // (a) Button tap payload → always route to the details handler.
  const taskDetailsTap = matchTaskDetailsPayload(text);
  if (taskDetailsTap) {
    await handleTaskDetailsRequest(user, taskDetailsTap.taskId);
    return;
  }
  // (b) Text triggers "פרטים" / "פרטים נוספים" — only when there is an active
  //     task in context (set by dueDateReminder after a successful send). With
  //     no active task, fall through so the general router / AI handles it.
  const trimmedTaskDetails = text.trim();
  if (/^פרטים(?:\s+נוספים)?$/u.test(trimmedTaskDetails)) {
    const active = getActiveTask(user.phone);
    if (active?.taskId) {
      await handleTaskDetailsRequest(user, active.taskId);
      return;
    }
  }

  // MGR_MENU_N list-tap with no active context: treat as if user is at mgr_menu_root.
  // This handles stale-context scenarios where context cleared between the list-message
  // send and the tap arriving.
  if (/^MGR_MENU_\d+$/i.test(text.trim()) && isManagerMenuUser(user)) {
    await setContext(user.phone, { awaiting: 'mgr_menu_root' });
    await continueConversation(user, text.trim(), { awaiting: 'mgr_menu_root' });
    return;
  }

  // Phase 1 parity: EMP_MENU_N list-tap with no active context (worker menu).
  // Scenario: worker taps item 1 → list_inspections_today clears context → they
  // tap item 2 from the SAME still-visible list message → payload arrives here
  // as `EMP_MENU_2` text with cleared context. Without this handler it falls
  // through to the AI parser which returns "לא הבנתי". Set the awaiting=menu
  // state and re-dispatch through the normal menu path.
  if (/^EMP_MENU_\d+$/i.test(text.trim()) && !isManagerMenuUser(user)) {
    await setContext(user.phone, { awaiting: 'menu' });
    await continueConversation(user, text.trim(), { awaiting: 'menu' });
    return;
  }

  // ── Phase 2: quoted-message context (swipe-reply) ──────────────────────────
  // Resolve the quoted (replied-to) message ONCE to a general context. It's the
  // strongest signal about what the reply is about — used deterministically for
  // TaskField status here, and passed to the AI for other kinds (equipment
  // reminder, …) further down.
  const quotedContext: QuotedContext | null = quotedWamid
    ? await resolveQuotedContext(quotedWamid)
    : null;

  // Deterministic TaskField status fast path — works with NO AI provider (like a
  // button tap). A swipe-reply to a TaskField message + an unambiguous status
  // keyword updates exactly that TaskField, outranking the Phase-1 active pointer.
  if (quotedContext?.entityType === 'task_field' && quotedContext.taskFieldId) {
    const kw = extractDirectStatusKeyword(text);
    if (kw) {
      const v = await validateWorkerTaskField(user.id, quotedContext.taskFieldId);
      if (v.ok) {
        await performTransition(user, quotedContext.taskFieldId, kw);
        return;
      }
      // Quoted TaskField no longer usable (closed / not owner / missing) → do NOT
      // throw; fall through to the normal flow (pointer / ask).
    }
  }

  // QA-FIX-5: no-quote deterministic status fast path — when the worker types
  // an unambiguous status verb ("הגעתי" / "סיימתי" / "יצאתי") without a quote
  // AND has an active-inspection pointer set (from a prior "יצאתי"), dispatch
  // on that pointer BEFORE the LLM runs. Fixes the case where the AI parser
  // occasionally returns unknown/low-confidence for a bare verb because the
  // recent history is noisy (customer notifications, ETA acks, …).
  // The quote path above still wins when both are present (a quote is a
  // stronger signal than the pointer).
  if (!(quotedContext?.entityType === 'task_field' && quotedContext.taskFieldId)) {
    const kw = extractDirectStatusKeyword(text);
    if (kw) {
      const active = await getActiveInspection(user.phone);
      if (active) {
        const v = await validateWorkerTaskField(user.id, active.taskFieldId);
        if (v.ok) {
          await performTransition(user, active.taskFieldId, kw);
          return;
        }
        // Pointer's TF closed / not owned / missing → fall through.
      }
    }
  }

  if (!getProvider()) {
    await sendTextMessage({ to: user.phone, text: 'שירות ה-AI אינו מוגדר עדיין. נסה שוב מאוחר יותר.' });
    return;
  }

  // Mid-conversation? Continue the clarification flow.
  // EXCEPTION: `idle_active_inspection` is not a live await — the row exists only
  // to hold the active-task pointer after "יצאתי". Treat it as "no context" so the
  // message flows through fresh intent parsing; the pointer is read later by
  // `runAdvanceStatusDirect` via getActiveInspection.
  const ctx = await getContext(user.phone);
  if (ctx && ctx.awaiting !== 'idle_active_inspection') {
    await continueConversation(user, text, ctx, quotedWamid);
    return;
  }

  // Fresh message that is exactly a menu trigger (menu/תפריט/עזרה/היי/שלום) →
  // open the role-based numbered menu. Any other text falls through to the AI
  // parser unchanged, so existing free-text behavior is fully preserved.
  if (MENU_TRIGGER_RE.test(text.trim())) {
    await showMenu(user);
    return;
  }

  // ── "הבדיקות שלי …" free-text fast path ──────────────────────────────────────
  // Any user (worker or manager) can ask for their inspections by an arbitrary
  // range. This runs BEFORE the AI parser so the deterministic Hebrew phrase
  // never gets rerouted to `create_task` / `get_task` etc. by the LLM.
  //
  // The regex captures the leading phrase and any trailing range expression;
  // the parser handles the range vocabulary and returns null for garbage.
  if (MY_INSPECTIONS_RE.test(text.trim())) {
    await handleMyInspectionsFreeText(user, text.trim());
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

  // Phase 6 parity — normalize "digit + polite word" and "confirmation + digit"
  // patterns to a bare digit so the existing guards below still fire. Real-life
  // manager typing: "2 בבקשה", "כן 2", "אוקי 3". Without this the message goes
  // to the AI parser which may return `unknown`.
  const DIGIT_POLITE_RE = /^([1-9])\s+(בבקשה|תודה|תודה\s+רבה)$/;
  const CONFIRM_DIGIT_RE = /^(?:כן|אישור|בטח|אוקי|אוקיי|סבבה)\s+([1-9])$/;
  let normalizedDigit: string | null = null;
  const mDp = trimmedForGuard.match(DIGIT_POLITE_RE);
  if (mDp) normalizedDigit = mDp[1];
  else {
    const mCd = trimmedForGuard.match(CONFIRM_DIGIT_RE);
    if (mCd) normalizedDigit = mCd[1];
  }
  const effectiveGuardText = normalizedDigit ?? trimmedForGuard;

  if (/^[1-9]$/.test(effectiveGuardText) && isManagerMenuUser(user)) {
    await showMenu(user);          // sets awaiting: 'mgr_menu_root' + sends menu text
    // Immediately route the digit as if the user replied to the freshly-shown menu.
    await continueConversation(user, effectiveGuardText, { awaiting: 'mgr_menu_root' });
    return;
  }

  // Phase 1 parity — worker bare-digit guard. Scenario: worker opens menu →
  // taps item 1 → its flow calls clearContext() → they then type a bare digit
  // to try picking again. Without this the digit goes to the AI parser which
  // returns "לא הבנתי". Re-open the worker menu (sets awaiting:'menu') and
  // route the digit through the standard menu-reply path. Only fires for
  // digits 1..7 (the worker menu has 7 items) — 8/9 fall through unchanged.
  if (/^[1-7]$/.test(effectiveGuardText) && !isManagerMenuUser(user)) {
    await showMenu(user);
    await continueConversation(user, effectiveGuardText, { awaiting: 'menu' });
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
    intent = await parseIntent(text, { user, allowedTypes, allowedPriorities, history, quotedContext });
  } catch (err) {
    log.error({ err }, 'Intent parse failed');
    await sendTextMessage({ to: user.phone, text: 'שגיאה בעיבוד הבקשה. נסה שוב או נסח מחדש.' });
    return;
  }

  // Record the user's turn AFTER parsing (so it isn't fed back into its own parse).
  await appendTurn(user.phone, 'user', text);

  await routeIntent(user, intent, text, quotedContext);
}

// ── Threshold routing ──────────────────────────────────────────────────────────

async function routeIntent(
  user: ResolvedUser,
  intent: AIIntentResult,
  originalText?: string,
  quotedContext?: QuotedContext | null,
): Promise<void> {
  // 1. Unknown or very low confidence → use the model's Hebrew clarification when it
  //    provided one (status-change / out-of-scope answers), else ask to rephrase.
  //    Either way, record the event in the audit log.
  if (intent.intent === 'unknown' || intent.confidence < CONF_LOW) {
    await auditEvent(user, 'unknown', null, 'SKIPPED', intent.clarification ?? 'unrecognized request');

    // Layer 4 fix: for ANY user with a very short input (≤3 chars), SHOW the
    // menu directly instead of a generic hint. The bare-digit guards above
    // already caught the most common case; this catches short non-digit inputs
    // (e.g. "היי", "ok") that dodged the guards.
    if (originalText !== undefined) {
      const trimmedInput = originalText.trim();
      if (trimmedInput.length <= 3) {
        await showMenu(user);
        return;
      }
    }

    // Phase 1 parity: workers now get the same menu-hint suffix as managers,
    // so a fall-through "unknown" always ends with a concrete next step.
    const menuHint = '\nתרצה לראות את התפריט? כתוב "תפריט".';
    const fallbackExample = isManagerMenuUser(user)
      ? 'לא הצלחתי להבין את הבקשה. נסה לנסח מחדש, למשל: "צור משימה תיאום ללקוח X" או "הצג את המשימות שלי להיום".'
      : 'לא הצלחתי להבין את הבקשה. נסה לנסח מחדש, למשל: "הבדיקות שלי היום", "יצאתי לרעננה", או "יש לי בעיה".';
    await sendTextMessage({
      to: user.phone,
      text: (intent.clarification ?? fallbackExample) + menuHint,
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

  // Phase 6 — for high-confidence LIST/QUERY intents where the LLM ALSO
  // emitted a `clarification` (e.g. "לידים שלי" → unassigned + note that
  // owner-scope is not supported), surface the clarification as a leading
  // message so the user still sees the caveat. Executed BEFORE the intent so
  // the response order reads "note → data".
  const HIGH_CONF_CLARIFICATION_INTENTS = new Set([
    'list_open_exceptions',
    'list_pending_leads',
    'workers_day_overview',
    'list_today_field_inspections',
    'management_snapshot',
    'search_task',
  ]);
  if (
    intent.clarification &&
    intent.clarification.trim().length > 0 &&
    HIGH_CONF_CLARIFICATION_INTENTS.has(intent.intent)
  ) {
    await sendTextMessage({ to: user.phone, text: intent.clarification });
  }

  // 4. High confidence → execute
  await executeIntent(user, intent, undefined, quotedContext);
}

// ── Continuation (clarification loop) ───────────────────────────────────────────

async function continueConversation(
  user: ResolvedUser,
  text: string,
  ctx: ConversationState,
  quotedWamid?: string,
): Promise<void> {
  const trimmed = text.trim();

  // Correction request — pause the pending action and ask the user to restate.
  // Only when it's a short standalone correction (so "שנה את הכותרת…" stays a new request).
  if (CORRECTION_RE.test(trimmed) && trimmed.split(/\s+/).length <= 4) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בסדר, לא ביצעתי כלום. נסח מחדש מה לתקן ואטפל בזה.' });
    return;
  }

  // UX-T1: mid-flow pivot yes/no confirmation. `pivot_confirm` is NOT in
  // NUMERIC_PICKER_AWAITING (its "1"/"2" reply is handled explicitly here),
  // so it must be dispatched before the escape hatch below.
  if (ctx.awaiting === 'pivot_confirm') {
    await handlePivotConfirmReply(user, trimmed, ctx);
    return;
  }

  // ── Free-text escape hatch (v2 UX contract) ─────────────────────────────
  // If we're in a numeric-picker awaiting state (see NUMERIC_PICKER_AWAITING)
  // and the user typed free-text — a question, a command, a description —
  // rather than a number or nav word, try the UX-T1 "smart picker escape"
  // first: classify the reply against the intent that owns the current flow
  // and either merge it into the in-progress selection, ask to confirm a
  // pivot to a different flow, or redisplay a short hint — all without
  // wiping the partial selection. Only when that classifier can't make a
  // call (no AI provider / parse failure — `passthrough`) do we fall back to
  // the old defensive net: clear the context and re-enter the fresh-message
  // path so the AI parser can try to understand it from scratch.
  if (
    NUMERIC_PICKER_AWAITING.has(ctx.awaiting) &&
    !looksLikeNumericPickerInput(trimmed)
  ) {
    const consumed = await trySmartPickerEscape(user, text, ctx);
    if (consumed) return;
    await clearContext(user.phone);   // defensive legacy net (parse failed / no provider)
    await handleAIMessage(user, text);
    return;
  }

  // ── D5-T16 (2026-07-05): Universal AI-first pivot escape hatch ──────────
  // Applies to text-capture states where the user's answer is a free-text note
  // (missing_info_note, equipment_missing_note, decline_reason, correct-*
  // value prompts, schedule intake, etc.). If they type a NEW top-level intent
  // instead of the expected note, they are pivoting mid-flow. Escape the
  // current capture and route through the main AI parser. The AI decides; if
  // it's uncertain, the AI asks (via `clarification`) rather than the bot
  // forcing a confusing capture.
  //
  // Policy: AI-first, no regex intent-detection. Deterministic MENU_TRIGGER_RE
  // matches (an unambiguous menu request like "תפריט" / "יאללה תפריט") short-
  // circuit for zero latency, but any other decision goes through
  // `tryPivotToAIIntent` which runs the LLM and only escapes on a HIGH-confidence
  // top-level intent from a curated allow-list.
  //
  // `mgr_*_action` states are EXCLUDED — they already have their own AI-first
  // path via `tryDispatchWorkerIntentInline` inside `handleMgrActionFreeText`
  // (D5-T15). Duplicating the pivot check here would double-invoke the LLM
  // on every message.
  if (TEXT_CAPTURE_PIVOT_STATES.has(ctx.awaiting)) {
    if (MENU_TRIGGER_RE.test(trimmed)) {
      await clearContext(user.phone);
      await handleAIMessage(user, text);
      return;
    }
    const pivoted = await tryPivotToAIIntent(user, text, ctx);
    if (pivoted) return;
  }

  // ── CAL-WA: delete-confirm (yes/no before removing a calendar event) ──────
  if (ctx.awaiting === 'calendar_delete_confirm') {
    await handleCalendarDeleteConfirmReply(user, trimmed, ctx);
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
  if (ctx.awaiting === 'missing_info_choice') {
    await handleMissingInfoChoiceReply(user, trimmed, ctx);
    return;
  }
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
    await handleDisambigReply(user, trimmed, 'missing_info', undefined, ctx.disambigTaskFieldIds);
    return;
  }
  if (ctx.awaiting === 'problem_disambig') {
    await handleDisambigReply(user, trimmed, 'problem', undefined, ctx.disambigTaskFieldIds);
    return;
  }
  if (ctx.awaiting === 'status_disambig') {
    await handleDisambigReply(user, trimmed, 'status', ctx.pendingTransition, ctx.disambigTaskFieldIds);
    return;
  }
  if (ctx.awaiting === 'status_choice') {
    await handleStatusChoiceReply(user, trimmed, ctx);
    return;
  }
  if (ctx.awaiting === 'status_eta_prompt') {
    await handleStatusEtaReply(user, text, ctx, quotedWamid);
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
  if (ctx.awaiting === 'missing_equipment_choice') {
    await handleMissingEquipmentChoiceReply(user, trimmed, ctx);
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
  // D2-T15: pre-reminder NEED_INFO note capture.
  if (ctx.awaiting === 'pre_reminder_need_info_note') {
    await handlePreReminderNeedInfoNoteReply(user, text, ctx);
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
  // UX-T1: single-shot reassign confirmation (reached when the user named the
  // target worker in one message). A numeric "1"/"2" reaches here directly (it's
  // a NUMERIC_PICKER_AWAITING state, so the smart-escape hatch is skipped).
  if (ctx.awaiting === 'reassign_confirm') {
    await handleReassignConfirmReply(user, trimmed, ctx);
    return;
  }

  // PROV-T9 (TASKS §4.20): manager asked to enable OwnTracks tracking without
  // naming the worker; this reply is the worker name.
  if (ctx.awaiting === 'enable_tracking_pick_worker') {
    await clearContext(user.phone);
    await resolveAndTriggerEnableTracking(user, trimmed);
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
  // D2-T16: item 7 — manager's own personal inspections today.
  if (ctx.awaiting === 'mgr_my_today_pick_task') {
    await handleMgrMyTodayPickTaskReply(user, trimmed, ctx);
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
  quotedContext?: QuotedContext | null,
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

    case 'list_my_inspections': {
      // Phase 1 worker parity — LLM-parsed "show my inspections" with an
      // optional dateScope / rangeExpr param.
      const dateScope = typeof intent.params?.dateScope === 'string'
        ? intent.params.dateScope.trim().toLowerCase()
        : '';
      const rangeExpr = typeof intent.params?.rangeExpr === 'string'
        ? intent.params.rangeExpr.trim()
        : '';

      // "all" scope — no date filter, show everything (post-Phase-6 addition).
      // Triggered by phrases like "כל הבדיקות שלי מכל הזמנים", "מאז ומעולם",
      // "בלי הגבלה", "הכל".
      if (dateScope === 'all') {
        await handleMyInspectionsAllTime(user);
        return;
      }

      // QA-FIX-7: free `params.dateRange` channel — lets the LLM resolve ANY
      // time expression (especially PAST ones: "אתמול", "שלשום", "שבוע שעבר",
      // explicit past dates) that the deterministic parser/dateScope enum
      // can't express, the same way the org-wide list intents already do.
      // Wins over rangeExpr/dateScope when present and valid; invalid/absent
      // falls through to the existing synthesis below unchanged.
      const myDateRange = extractDateRange(intent.params?.dateRange);
      if (myDateRange) {
        const spanDays = daysBetween(myDateRange.from, myDateRange.to);
        const label = spanDays <= 1
          ? fmtDDMM(myDateRange.from)
          : `${fmtDDMM(myDateRange.from)}–${fmtDDMM(addLocalDay(myDateRange.to, -1))}`;
        await renderMyInspectionsRange(user, {
          fromLocalDate: myDateRange.from,
          toLocalDate: myDateRange.to,
          label,
        });
        return;
      }

      // Bounded scopes — synthesize a text form that MY_INSPECTIONS_RE +
      // parseHebrewInspectionRange will resolve deterministically.
      let synthesized = 'הבדיקות שלי';
      if (rangeExpr.length > 0) {
        synthesized += ' ' + rangeExpr;
      } else if (dateScope === 'tomorrow') {
        synthesized += ' מחר';
      } else if (dateScope === 'week') {
        synthesized += ' השבוע';
      } else if (dateScope === 'next_week') {
        synthesized += ' שבוע הבא';
      } // else: default (today) — leave suffix empty
      await handleMyInspectionsFreeText(user, synthesized);
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
      if (transition === 'CONFIRM' || transition === 'DEPARTED' || transition === 'ARRIVED' || transition === 'FINISHED') {
        const hint = typeof intent.task_reference === 'string' ? intent.task_reference.trim() : '';
        await runAdvanceStatusDirect(user, transition, hint || null, quotedContext);
        return;
      }
      // No transition supplied — fall through to help.
      await sendTextMessage({ to: user.phone, text: helpText() });
      return;
    }

    // D5-T10 Phase 2: worker day-summary via free text (same as menu item 7).
    case 'day_summary_query':
      await startDaySummaryFlow(user);
      return;

    // D5-T10 Phase 2: worker reports missing equipment before going out (general).
    // Mirrors the menu-item-5 handler in handleWorkerMenuReply.
    case 'missing_equipment_free': {
      const note = typeof intent.params?.note === 'string' ? intent.params.note.trim() : '';
      const localDate = localJerusalemDate();
      if (note) {
        // Construct a minimal ConversationState for handleEquipmentMissingNoteReply
        // so it can stamp the correct local date on the office alert.
        const equipCtx: ConversationState = {
          awaiting: 'equipment_missing_note',
          equipmentLocalDate: localDate,
        };
        await handleEquipmentMissingNoteReply(user, note, equipCtx);
      } else {
        // D5-T19k: no specific item named yet — show the structured sub-menu.
        await showMissingEquipmentChoice(user, localDate);
      }
      return;
    }

    // D3-T6: Sasha lead-assignment via WhatsApp.
    // Phase 6 enhancement: when the LLM extracted BOTH a lead reference
    // (`params.leadRef`) AND a target worker name (`params.assigneeName`) from
    // a single-sentence request ("לשייך את הליד של יוסי ללירן"), attempt to
    // pre-populate both picks so Sasha only confirms. Falls through to the
    // normal multi-step flow if either lookup is ambiguous or empty.
    case 'assign_lead': {
      const leadRef = typeof intent.params?.leadRef === 'string' ? intent.params.leadRef.trim() : '';
      const assigneeName = typeof intent.params?.assigneeName === 'string'
        ? intent.params.assigneeName.trim() : '';
      if (leadRef || assigneeName) {
        const consumed = await tryPrePopulateAssignLead(user, leadRef, assigneeName);
        if (consumed) return;
      }
      await startAssignLeadFlow(user);
      return;
    }

    // D2-T11: schedule a new TaskField for an existing Task from WhatsApp.
    case 'schedule_task_field': {
      const startAt = typeof intent.params?.scheduledStartAt === 'string'
        ? intent.params.scheduledStartAt.trim() : null;
      const duration = typeof intent.params?.durationMinutes === 'number'
        ? intent.params.durationMinutes : null;
      const specialInstr = typeof intent.params?.specialInstructions === 'string'
        ? intent.params.specialInstructions.trim() : null;
      // UX-T1 single-shot: a customer/task hint in the same message
      // ("לתזמן ביקור מחר ב-10 ללקוח לוי") rides in task_reference.
      const scheduleCustomerRef = typeof intent.task_reference === 'string'
        ? intent.task_reference : null;
      await startScheduleTaskFieldFlow(user, startAt, duration, specialInstr, scheduleCustomerRef);
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

    // PROV-T5 (TASKS §4.20): manager enables OwnTracks auto-provisioning for a worker.
    case 'enable_worker_location_tracking':
      await startEnableWorkerLocationTracking(user, intent);
      return;

    // ── CAL-WA: Outlook calendar over WhatsApp text ─────────────────────────
    // Available to every connected user; delegates to the CRM's stored Outlook
    // connection via crmApi (keyed by user.id). Reads + create + update run
    // directly; delete asks for a "כן/לא" confirmation first.
    case 'calendar_list': {
      if (!crmApiConfigured()) {
        await sendTextMessage({ to: user.phone, text: 'חיבור היומן אינו מוגדר כרגע.' });
        return;
      }
      const daysAhead = typeof intent.params?.days_ahead === 'number'
        ? Math.min(Math.max(intent.params.days_ahead, 1), 60) : 7;
      const now = Date.now();
      const startIso = typeof intent.params?.from_iso === 'string'
        ? intent.params.from_iso : new Date(now).toISOString();
      const endIso = typeof intent.params?.to_iso === 'string'
        ? intent.params.to_iso : new Date(now + daysAhead * 86_400_000).toISOString();
      try {
        const events = await listCrmCalendarEvents(user.id, { startIso, endIso, top: 25 });
        if (events.length === 0) {
          await sendTextMessage({ to: user.phone, text: 'היומן פנוי בתקופה הזו.' });
          return;
        }
        const shown = events.slice(0, 12);
        const lines = shown.map((e, i) => {
          const loc = e.location ? ` — ${e.location}` : '';
          return `${i + 1}. ${e.subject ?? 'ללא נושא'} — ${fmtCalendarWhen(e.start?.dateTime ?? null)}${loc}`;
        });
        const more = events.length > shown.length ? `\n(ועוד ${events.length - shown.length}…)` : '';
        await sendTextMessage({ to: user.phone, text: `📅 היומן שלך:\n${lines.join('\n')}${more}` });
      } catch (err) {
        await sendTextMessage({ to: user.phone, text: calendarErrorText(err) });
      }
      return;
    }

    case 'calendar_create': {
      if (!crmApiConfigured()) {
        await sendTextMessage({ to: user.phone, text: 'חיבור היומן אינו מוגדר כרגע.' });
        return;
      }
      const subject = typeof intent.params?.subject === 'string' ? intent.params.subject.trim() : '';
      const startIso = typeof intent.params?.start_iso === 'string' ? intent.params.start_iso.trim() : '';
      if (!subject || !startIso) {
        await sendTextMessage({ to: user.phone, text: intent.clarification ?? 'עם מי הפגישה ומתי? (חסר נושא או מועד)' });
        return;
      }
      // end = explicit end_iso, else start + duration_minutes (default 60).
      let endIso = typeof intent.params?.end_iso === 'string' ? intent.params.end_iso.trim() : '';
      if (!endIso) {
        const durationMin = typeof intent.params?.duration_minutes === 'number'
          ? intent.params.duration_minutes : 60;
        const startDate = new Date(startIso);
        if (Number.isNaN(startDate.getTime())) {
          await sendTextMessage({ to: user.phone, text: 'לא הצלחתי להבין את המועד. נסה שוב עם תאריך ושעה.' });
          return;
        }
        // Keep local wall-time semantics: add minutes to the parsed instant and
        // re-emit an ISO local string (no Z) matching the CRM's expectation.
        endIso = new Date(startDate.getTime() + durationMin * 60_000).toISOString().replace(/\.\d{3}Z$/, '');
      }
      const location = typeof intent.params?.location === 'string' ? intent.params.location.trim() : undefined;
      const notes = typeof intent.params?.notes === 'string' ? intent.params.notes.trim() : undefined;
      try {
        await createCrmCalendarEvent(user.id, {
          subject, start: startIso, end: endIso, timeZone: 'Asia/Jerusalem',
          ...(location ? { location } : {}),
          ...(notes ? { body: notes } : {}),
        });
        await sendTextMessage({
          to: user.phone,
          text: `✅ נקבע ביומן: "${subject}" ל-${fmtCalendarWhen(startIso)}.`,
        });
      } catch (err) {
        await sendTextMessage({ to: user.phone, text: calendarErrorText(err) });
      }
      return;
    }

    case 'calendar_update': {
      if (!crmApiConfigured()) {
        await sendTextMessage({ to: user.phone, text: 'חיבור היומן אינו מוגדר כרגע.' });
        return;
      }
      const resolved = await resolveCalendarEventForRouter(user.id, intent.params);
      if (!resolved.ok) {
        await sendTextMessage({ to: user.phone, text: resolved.message });
        return;
      }
      const patch: {
        subject?: string; start?: string; end?: string; location?: string; body?: string;
      } = {};
      if (typeof intent.params?.subject === 'string' && intent.params.subject.trim()) patch.subject = intent.params.subject.trim();
      if (typeof intent.params?.start_iso === 'string' && intent.params.start_iso.trim()) patch.start = intent.params.start_iso.trim();
      if (typeof intent.params?.end_iso === 'string' && intent.params.end_iso.trim()) patch.end = intent.params.end_iso.trim();
      if (typeof intent.params?.location === 'string' && intent.params.location.trim()) patch.location = intent.params.location.trim();
      if (typeof intent.params?.notes === 'string' && intent.params.notes.trim()) patch.body = intent.params.notes.trim();
      if (Object.keys(patch).length === 0) {
        await sendTextMessage({ to: user.phone, text: `מה לעדכן באירוע "${resolved.subject}"? (נושא / מועד / מיקום)` });
        return;
      }
      try {
        await updateCrmCalendarEvent(user.id, resolved.eventId, { ...patch, timeZone: 'Asia/Jerusalem' });
        await sendTextMessage({ to: user.phone, text: `✏️ האירוע "${resolved.subject}" עודכן ביומן.` });
      } catch (err) {
        await sendTextMessage({ to: user.phone, text: calendarErrorText(err) });
      }
      return;
    }

    case 'calendar_delete': {
      if (!crmApiConfigured()) {
        await sendTextMessage({ to: user.phone, text: 'חיבור היומן אינו מוגדר כרגע.' });
        return;
      }
      const resolved = await resolveCalendarEventForRouter(user.id, intent.params);
      if (!resolved.ok) {
        await sendTextMessage({ to: user.phone, text: resolved.message });
        return;
      }
      // Confirm before deleting — store the resolved event and await "כן/לא".
      await setContext(user.phone, {
        awaiting: 'calendar_delete_confirm',
        calendarDeleteEventId: resolved.eventId,
        calendarDeleteSubject: resolved.subject,
      });
      await sendTextMessage({
        to: user.phone,
        text: `למחוק מהיומן את "${resolved.subject}"? השב "כן" למחיקה או "לא" לביטול.`,
      });
      return;
    }

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

    case 'list_today_field_inspections': {
      if (!isManagerMenuUser(user)) {
        await sendTextMessage({ to: user.phone, text: 'אין הרשאה.' });
        return;
      }
      // D5-T19g: optional dateRange widens the window beyond today, same
      // pattern as list_open_exceptions / list_pending_leads / workers_day_overview.
      const tfiDateRange = extractDateRange(intent.params?.dateRange);
      // count_only: return a numeric count rather than the full picker list.
      if (intent.params?.count_only === true) {
        const todayRows = await getTodayFieldInspections(localJerusalemDate(), tfiDateRange ?? undefined);
        const tfiLabel = tfiDateRange ? `${fmtDDMM(tfiDateRange.from)}–${fmtDDMM(tfiDateRange.to)}` : 'היום';
        await clearContext(user.phone);
        await sendTextMessage({ to: user.phone, text: `יש ${todayRows.length} בדיקות שטח ${tfiLabel}.` });
        return;
      }
      await showMgrTodayInspections(user, tfiDateRange ?? undefined);
      return;
    }

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
      // Extract optional dateRange from params; validate basic shape.
      const exDateRange = extractDateRange(intent.params?.dateRange);
      const exRows = await getFieldExceptionRows(localDateEx, resolvedExFilter, exDateRange ?? undefined);
      // count_only: return a numeric count rather than the full picker list.
      if (intent.params?.count_only === true) {
        await clearContext(user.phone);
        await sendTextMessage({ to: user.phone, text: `יש ${exRows.length} חריגים פתוחים.` });
        return;
      }
      if (exRows.length === 0) {
        // D5-T19h: previously fell back to the generic exceptions sub-menu on
        // an empty filtered result, which looked exactly like the filter had
        // been ignored (e.g. "בעיות שטח" → filter=has_problem, zero matching
        // rows → the full "חריגים ודיווחים" menu instead of a clear
        // "none of this kind right now" answer). Send a filter-specific empty
        // message instead, matching the established pattern in
        // list_pending_leads (see the `unassLeads.length === 0` /
        // `escLeads.length === 0` branches just below).
        const exEmptyMsg: Record<import('../services/managerViews').FieldExceptionFilter, string> = {
          open_exceptions:   'אין חריגים פתוחים כרגע.',
          not_confirmed:     'אין משימות שלא אושרו כרגע.',
          has_problem:       'אין חריגים עם בעיה כרגע.',
          waiting_for_info:  'אין משימות שממתינות למידע כרגע.',
          not_closed:        'כל הבדיקות נסגרו — אין חריגים מסוג זה כרגע.',
        };
        await clearContext(user.phone);
        await sendTextMessage({ to: user.phone, text: exEmptyMsg[resolvedExFilter] });
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
      // Extract optional dateRange from params.
      const leadsDateRange = extractDateRange(intent.params?.dateRange);
      const leadsCountOnly = intent.params?.count_only === true;
      if (leadsFilter === 'escalated') {
        // Show escalation candidates list (dateRange not applied to escalated — time-relative query)
        const { findEscalationCandidates } = await import('../services/incomingLeads');
        const escLeads = await findEscalationCandidates(20);
        // count_only: return numeric count only.
        if (leadsCountOnly) {
          await clearContext(user.phone);
          await sendTextMessage({ to: user.phone, text: `יש ${escLeads.length} לידים שעברו שעה ללא שיוך.` });
          return;
        }
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
        // Default: unassigned; pass dateRange when present (scopes on receivedAt per §6.2)
        const unassLeads = await findUnassignedLeadsForAssignment(20, leadsDateRange ?? undefined);
        // count_only: return numeric count only.
        if (leadsCountOnly) {
          await clearContext(user.phone);
          await sendTextMessage({ to: user.phone, text: `יש ${unassLeads.length} לידים לא משויכים.` });
          return;
        }
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
      // Extract optional dateRange from params.
      const wovDateRange = extractDateRange(intent.params?.dateRange);
      // Build a display label for the date range shown in messages.
      const wovLabel = wovDateRange
        ? `${fmtDDMM(wovDateRange.from)}–${fmtDDMM(wovDateRange.to)}`
        : `היום (${fmtDDMM(localDateW)})`;
      // count_only: return the number of workers with field tasks today.
      if (intent.params?.count_only === true) {
        const allWorkersForCount = await getAllWorkersDayOverview(localDateW, wovDateRange ?? undefined);
        const activeWorkers = allWorkersForCount.filter((w) => w.total > 0).length;
        await clearContext(user.phone);
        await sendTextMessage({ to: user.phone, text: `יש ${activeWorkers} עובדים בשטח ${wovLabel}.` });
        return;
      }
      if (workerName) {
        // Named worker — find them in the overview and show detail.
        const allWorkers = await getAllWorkersDayOverview(localDateW, wovDateRange ?? undefined);
        const matched = allWorkers.find((w) =>
          w.workerName.includes(workerName) || workerName.includes(w.workerName),
        );
        if (!matched) {
          // Fallback: show the full overview with a note.
          if (allWorkers.length === 0) {
            await sendTextMessage({ to: user.phone, text: `לא נמצאו בדיקות עבור "${workerName}" (${wovLabel}).` });
            return;
          }
          const lines = allWorkers.map((r) => `${r.workerName}: ${r.finished}/${r.total} · חריגים ${r.exceptions}`);
          await clearContext(user.phone);
          await sendChunked(user.phone, `לא מצאתי עובד בשם "${workerName}". סיכום — ${wovLabel}:\n${lines.join('\n')}`);
          return;
        }
        // Show detail for the matched worker.
        const detail = await getWorkerDayDetail(matched.workerId, localDateW, wovDateRange ?? undefined);
        await clearContext(user.phone);
        if (detail.total === 0) {
          await sendTextMessage({
            to: user.phone,
            text: `${matched.workerName} — ${wovLabel}:\n\nאין בדיקות שטח מתוזמנות${wovDateRange ? '' : ' היום'}.`,
          });
          return;
        }
        const lines = detail.inspections.map((r, i) => {
          const rowData: InspectionListRowData = {
            taskTitle: r.taskTitle,
            typeLabelHe: r.typeLabelHe,
            timeHm: r.timeHm,
            siteCity: r.siteCity,
            fieldStatus: r.fieldStatus,
            dateStr: wovDateRange ? wovDateRange.from : localDateW,
          };
          return `${i + 1}. ${formatInspectionListRow(rowData)}`;
        });
        const summary = `סיכום: ${detail.finished}/${detail.total} בוצעו, חריגים פתוחים: ${detail.openExceptions}`;
        await sendChunked(user.phone, `${matched.workerName} — ${wovLabel}:\n\n${lines.join('\n\n')}\n\n${summary}`);
      } else {
        // All workers table view.
        const allWorkers = await getAllWorkersDayOverview(localDateW, wovDateRange ?? undefined);
        if (allWorkers.length === 0) {
          await sendTextMessage({ to: user.phone, text: `אין עובדים עם בדיקות (${wovLabel}).` });
          return;
        }
        const lines = allWorkers.map((r) => `${r.workerName}: ${r.finished}/${r.total} · חריגים ${r.exceptions}`);
        await clearContext(user.phone);
        await sendChunked(user.phone, `סיכום — ${wovLabel}:\n${lines.join('\n')}`);
      }
      return;
    }

    case 'search_task': {
      if (!isManagerMenuUser(user)) {
        await sendTextMessage({ to: user.phone, text: 'אין הרשאה.' });
        return;
      }
      // Phase 5: expanded searchBy enum includes 4 new dimensions.
      type SearchByDimension = 'customer' | 'worker' | 'product' | 'address' | 'phone' | 'task_id' | 'field_status';
      const searchBy = typeof intent.params?.searchBy === 'string'
        ? intent.params.searchBy.trim() as SearchByDimension
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
          address: 'כתובת / עיר / חלק מהכתובת:',
          phone: 'מספר טלפון / חלק ממנו:',
          task_id: 'מספר / מזהה בדיקה:',
          field_status: 'סטטוס שדה (למשל: ASSIGNED, WAITING_FOR_INFO, FINISHED_FIELD):',
        };
        await setContext(user.phone, { awaiting: 'mgr_search_await_query', mgrSearchKind: searchBy });
        await sendTextMessage({ to: user.phone, text: promptMap[searchBy] ?? 'מה לחפש?' });
        return;
      }

      // Both searchBy and query present — run the search directly.
      if (searchBy && query) {
        // Hebrew synonym → fieldStatus enum mapping for field_status searches.
        const FIELD_STATUS_SYNONYMS: Record<string, string> = {
          'פתוח': 'ASSIGNED',
          'אושר': 'CONFIRMED',
          'בדרך': 'EN_ROUTE',
          'באתר': 'ARRIVED',
          'ממתין למידע': 'WAITING_FOR_INFO',
          'חסר מידע': 'WAITING_FOR_INFO',
          'סיים': 'FINISHED_FIELD',
          'סיים שדה': 'FINISHED_FIELD',
          'בעיה': 'HAS_PROBLEM',
          'יש בעיה': 'HAS_PROBLEM',
          'בוטל': 'CANCELED',
          'סירב': 'DECLINED',
        };

        let searchResults: TodayFieldInspectionRow[] = [];
        if (searchBy === 'customer') {
          searchResults = await searchTasksByCustomerName(query);
        } else if (searchBy === 'worker') {
          searchResults = await searchTasksByWorkerName(query);
        } else if (searchBy === 'product') {
          searchResults = await searchTasksByProductCode(query);
        } else if (searchBy === 'address') {
          searchResults = await searchTasksByAddress(query);
        } else if (searchBy === 'phone') {
          searchResults = await searchTasksByPhone(query);
        } else if (searchBy === 'task_id') {
          searchResults = await searchTasksByTaskId(query);
        } else if (searchBy === 'field_status') {
          // Resolve Hebrew synonyms to enum value; fall back to the raw query.
          const resolvedStatus = FIELD_STATUS_SYNONYMS[query] ?? query;
          searchResults = await searchTasksByFieldStatus(resolvedStatus);
        }

        if (searchResults.length === 0) {
          // Distinguish "person exists but has no field inspections" from "no
          // such person" — otherwise a valid manager/office user like יורם gets
          // a misleading "not found" when what actually happened is that they
          // have zero TaskField rows (e.g. the CEO who never does field work).
          if (searchBy === 'worker') {
            const matchingUsers = await findUsersByName(query);
            if (matchingUsers.length === 1) {
              await sendTextMessage({ to: user.phone, text: `${matchingUsers[0].name} קיים במערכת, אך אין לו בדיקות שטח משובצות.` });
            } else if (matchingUsers.length > 1) {
              const list = matchingUsers.map((u) => `"${u.name}"`).join(', ');
              await sendTextMessage({ to: user.phone, text: `נמצאו ${matchingUsers.length} עובדים תואמים (${list}), אך לאף אחד מהם אין בדיקות שטח משובצות.` });
            } else {
              await sendTextMessage({ to: user.phone, text: `לא נמצא עובד בשם "${query}". נסה שם אחר או "תפריט".` });
            }
            return;
          }
          if (searchBy === 'customer') {
            const matchingCustomers = await findCustomersByName(query, 10);
            if (matchingCustomers.length === 1) {
              await sendTextMessage({ to: user.phone, text: `${matchingCustomers[0].name} קיים במערכת, אך אין לו בדיקות שטח משובצות.` });
            } else if (matchingCustomers.length > 1) {
              const list = matchingCustomers.map((c) => `"${c.name}"`).join(', ');
              await sendTextMessage({ to: user.phone, text: `נמצאו ${matchingCustomers.length} לקוחות תואמים (${list}), אך לאף אחד מהם אין בדיקות שטח משובצות.` });
            } else {
              await sendTextMessage({ to: user.phone, text: `לא נמצא לקוח בשם "${query}". נסה שם אחר או "תפריט".` });
            }
            return;
          }
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
          // For product/status/address/phone/task_id search, include worker in the row.
          const showWorker = searchBy === 'product' || searchBy === 'address' || searchBy === 'phone' || searchBy === 'task_id' || searchBy === 'field_status';
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

  // All menus → Meta List Message (up to 10 rows). Falls back to numbered text.
  const items = menuItemsFor(user);
  const isManager = isManagerMenuUser(user);
  const payloadPrefix = isManager ? 'MGR_MENU_' : 'EMP_MENU_';
  const body = isManager ? 'שלום, מה תרצה לעשות?' : 'תפריט — בחר:';
  const sectionTitle = isManager ? 'תפריט ניהול' : 'תפריט עובד';
  try {
    await sendListMessage({
      to: user.phone,
      body,
      buttonLabel: 'פתח תפריט',
      sections: [{
        title: sectionTitle,
        rows: items.map((r) => ({
          id: `${payloadPrefix}${r.n}`,
          title: r.label,
        })),
      }],
    });
    return;
  } catch (err) {
    log.warn({ err }, 'sendListMessage failed for menu — falling back to text');
  }

  await sendTextMessage({ to: user.phone, text: renderMenu(user) });
}

/** Handle a numeric reply while the main menu is open. Non-numeric replies
 *  are intercepted by the top-of-`continueConversation` free-text escape hatch
 *  (see `NUMERIC_PICKER_AWAITING`) before they ever reach this handler, so any
 *  input arriving here is either digits or a nav word (`ביטול` etc.). */
async function handleMenuReply(user: ResolvedUser, trimmed: string): Promise<void> {
  // Resolve EMP_MENU_N list-tap payloads to digit.
  const resolved = /^EMP_MENU_(\d+)$/i.test(trimmed)
    ? trimmed.replace(/^EMP_MENU_/i, '')
    : trimmed;
  const items = menuItemsFor(user);
  const idx = parseInt(resolved, 10);
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
      // D2-T9: menu item 5 shortcut → same sub-menu (D5-T19k) as the
      // "חסר לי ציוד" button on the morning equipment reminder. Uses today's
      // Asia/Jerusalem local date so the office alert stamps the right day.
      await showMissingEquipmentChoice(user, localJerusalemDate());
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
    // D2-T16: item 7 — manager's own personal inspections today.
    case 'mgr_my_inspections_today':
      await showMyFieldInspectionsToday(user);
      return;
  }
}

// ── D2-T7: "Missing info for report" flow ────────────────────────────────────
// Menu item 6 or D5-T3 intent `report_missing_info` → prompt for the missing
// detail, capture it, write into TaskField, notify the office. Voice arrives
// as text via D5-T2 so no special path is needed for voice.

/**
 * Phase 1 parity — build the numbered "which inspection?" prompt shown when the
 * worker has more than one open TaskField. Includes customer + address + time
 * for each row and tells the worker they may reply with a number, a name, or
 * an address. Callers persist `items.map(i => i.taskFieldId)` into
 * `ConversationState.disambigTaskFieldIds` so a bare digit reply resolves
 * without another DB round-trip.
 */
function buildDisambigPrompt(items: OpenTaskFieldPreview[]): string {
  const rows = items
    .map((it, idx) => {
      const parts: string[] = [];
      const name = (it.customerName ?? '').trim();
      parts.push(name.length > 0 ? name : 'לקוח לא ידוע');
      const addrBits: string[] = [];
      if (it.siteAddress && it.siteAddress.trim()) addrBits.push(it.siteAddress.trim());
      if (it.siteCity && it.siteCity.trim()) addrBits.push(it.siteCity.trim());
      if (addrBits.length > 0) parts.push(addrBits.join(', '));
      let row = `${idx + 1}. ${parts.join(' — ')}`;
      if (it.scheduledStartAt) {
        const hhmm = new Intl.DateTimeFormat('he-IL', {
          timeZone: 'Asia/Jerusalem',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(it.scheduledStartAt);
        row += ` · ${hhmm}`;
      }
      return row;
    })
    .join('\n');
  return (
    `יש לך ${items.length} בדיקות פתוחות:\n` +
    rows +
    '\n\nהשב במספר, בשם הלקוח, או בכתובת האתר. "ביטול" לחזרה.'
  );
}

async function startMissingInfoFlow(user: ResolvedUser): Promise<void> {
  const found = await findOpenTaskFieldForWorker(user.id);
  if (found === null) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'אין לך כרגע בדיקות פתוחות.' });
    return;
  }
  if ('ambiguous' in found) {
    await setContext(user.phone, {
      awaiting: 'missing_info_disambig',
      disambigTaskFieldIds: found.items.map((i) => i.taskFieldId),
    });
    await sendTextMessage({
      to: user.phone,
      text: buildDisambigPrompt(found.items),
    });
    return;
  }
  // D5-T19j: structured sub-menu of common missing-info items before the
  // free-text prompt. Option 7 ("אחר") falls through to missing_info_note.
  await setContext(user.phone, {
    awaiting: 'missing_info_choice',
    taskFieldId: found.taskFieldId,
  });
  await sendTextMessage({ to: user.phone, text: renderMissingInfoMenu() });
}

/** State: missing_info_choice — worker picks a preset item (1-6) or "אחר" (7). */
async function handleMissingInfoChoiceReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (!ctx.taskFieldId) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const items = missingInfoMenu();
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    // Invalid — resend the menu, keep the awaiting state.
    await sendTextMessage({ to: user.phone, text: renderMissingInfoMenu() });
    return;
  }
  const chosen = items[idx - 1];
  if (chosen.presetNote === null) {
    // "אחר" — fall through to the existing free-text capture.
    await setContext(user.phone, { awaiting: 'missing_info_note', taskFieldId: ctx.taskFieldId });
    await sendTextMessage({ to: user.phone, text: 'מה חסר לדוח?' });
    return;
  }
  await writeMissingInfo({ taskFieldId: ctx.taskFieldId, note: chosen.presetNote, updatedBy: user.id });
  const sent = await notifyOfficeMissingInfo(ctx.taskFieldId);
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'office') });
}

/**
 * D5-T19a: honest office-alert confirmation. `notifyOffice*` / `notifyOfficeMissingEquipment`
 * return `Promise<boolean>` — true only if the WhatsApp message actually
 * reached at least one manager. Never tell the worker "the manager/office
 * was notified" without checking this first (e.g. every manager may be
 * outside the 24h WhatsApp window, or none may be configured).
 */
function officeNotifiedText(sent: boolean, kind: 'manager' | 'office'): string {
  if (sent) {
    return kind === 'manager' ? 'עדכנתי. המנהל קיבל התראה.' : 'עדכנתי. המשרד קיבל התראה.';
  }
  return 'עדכנתי במערכת, אך לא הצלחתי להתריע כרגע — כדאי לוודא ידנית מול המשרד.';
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
  const sent = await notifyOfficeMissingInfo(ctx.taskFieldId);
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'office') });
}

/** Direct dispatch used by the D5-T3 free-text intent — no menu step. */
async function runMissingInfoDirect(user: ResolvedUser, note: string): Promise<void> {
  const found = await findOpenTaskFieldForWorker(user.id);
  if (found === null) {
    await sendTextMessage({ to: user.phone, text: 'אין לך כרגע בדיקות פתוחות.' });
    return;
  }
  if ('ambiguous' in found) {
    await setContext(user.phone, {
      awaiting: 'missing_info_disambig',
      disambigTaskFieldIds: found.items.map((i) => i.taskFieldId),
    });
    await sendTextMessage({
      to: user.phone,
      text: buildDisambigPrompt(found.items),
    });
    return;
  }
  await writeMissingInfo({ taskFieldId: found.taskFieldId, note, updatedBy: user.id });
  const sent = await notifyOfficeMissingInfo(found.taskFieldId);
  await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'office') });
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
    await setContext(user.phone, {
      awaiting: 'problem_disambig',
      disambigTaskFieldIds: found.items.map((i) => i.taskFieldId),
    });
    await sendTextMessage({
      to: user.phone,
      text: buildDisambigPrompt(found.items),
    });
    return;
  }
  await setContext(user.phone, {
    awaiting: 'problem_type_choice',
    taskFieldId: found.taskFieldId,
  });
  await sendProblemTypeMenu(user.phone);
}

/** Send the status-update sub-menu as a List Message (fallback: numbered text).
 *  Worker menu item 3 → 3 transitions (יצאתי / הגעתי / סיימתי). */
async function sendStatusUpdateMenu(phone: string): Promise<void> {
  const items = statusUpdateMenu();
  try {
    await sendListMessage({
      to: phone,
      body: 'עדכון סטטוס בדיקה:',
      buttonLabel: 'בחר סטטוס',
      sections: [{
        rows: items.map((i) => ({ id: `STATUS_UPD_${i.n}`, title: i.label })),
      }],
    });
  } catch (err) {
    log.warn({ err }, 'sendListMessage failed for status_choice menu — falling back to text');
    await sendTextMessage({ to: phone, text: renderStatusUpdateMenu() });
  }
}

/** Send the problem-type sub-menu as a List Message (fallback: numbered text). */
async function sendProblemTypeMenu(phone: string): Promise<void> {
  const items = problemTypeMenu();
  try {
    await sendListMessage({
      to: phone,
      body: 'בחר סוג בעיה:',
      buttonLabel: 'סוג בעיה',
      sections: [{
        rows: items.map((i) => ({ id: `PROBLEM_TYPE_${i.n}`, title: i.label })),
      }],
    });
  } catch (err) {
    log.warn({ err }, 'sendListMessage failed for problem_type menu — falling back to text');
    await sendTextMessage({ to: phone, text: renderProblemTypeMenu() });
  }
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
  // Resolve PROBLEM_TYPE_N list-tap payloads to digit.
  const resolved = /^PROBLEM_TYPE_(\d+)$/i.test(trimmed)
    ? trimmed.replace(/^PROBLEM_TYPE_/i, '')
    : trimmed;
  const items = problemTypeMenu();
  const idx = parseInt(resolved, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    // Invalid — resend the menu, keep the awaiting state.
    await sendProblemTypeMenu(user.phone);
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
  const sent = await notifyOfficeProblem(ctx.taskFieldId);
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'manager') });
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
  const sent = await notifyOfficeProblem(ctx.taskFieldId);
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'manager') });
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
    await setContext(user.phone, {
      awaiting: 'problem_disambig',
      disambigTaskFieldIds: found.items.map((i) => i.taskFieldId),
    });
    await sendTextMessage({
      to: user.phone,
      text: buildDisambigPrompt(found.items),
    });
    return;
  }
  await writeProblem({
    taskFieldId: found.taskFieldId,
    problemType,
    note,
    updatedBy: user.id,
  });
  const sent = await notifyOfficeProblem(found.taskFieldId);
  await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'manager') });
}

// ── D2-T5 / D2-T6: on-demand status transitions + finished follow-up ────────
// Menu item 3 → 3-item status sub-menu → DEPARTED/ARRIVED/FINISHED write.
// A FINISHED write ALWAYS opens the 4-option follow-up (spec §7 / D2-T6).
// The D5-T3 `set_field_status` intent gets a direct entry point via
// `runAdvanceStatusDirect`. When the worker has >1 open TaskField, we hold
// the requested transition in `pendingTransition` on the awaiting state and
// resolve via `resolveOpenTaskFieldByHint`.

const STATUS_HE_LABEL: Record<AdvanceTransition, string> = {
  CONFIRM:  'אושרה',
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
    await setContext(user.phone, {
      awaiting: 'status_disambig',
      disambigTaskFieldIds: found.items.map((i) => i.taskFieldId),
    });
    await sendTextMessage({
      to: user.phone,
      text: buildDisambigPrompt(found.items),
    });
    return;
  }
  await setContext(user.phone, { awaiting: 'status_choice', taskFieldId: found.taskFieldId });
  await sendStatusUpdateMenu(user.phone);
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
  // Resolve STATUS_UPD_N list-tap payload to digit.
  const resolved = /^STATUS_UPD_(\d+)$/i.test(trimmed)
    ? trimmed.replace(/^STATUS_UPD_/i, '')
    : trimmed;
  const items = statusUpdateMenu();
  const idx = parseInt(resolved, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    await sendStatusUpdateMenu(user.phone);
    return;
  }
  const chosen = items[idx - 1];
  await performTransition(user, ctx.taskFieldId, chosen.transition);
}

/** The binding travel-ETA prompt shown right after "יצאתי". */
function departedEtaPrompt(): string {
  return (
    'עדכנתי שיצאת לדרך 🚗\n' +
    'כמה זמן נסיעה משוער עד הלקוח? (למשל: 20 דקות)\n' +
    'חשוב לדייק — הזמן מחייב ויוצג ללקוח.'
  );
}

/**
 * Shared write + reply path.
 *  - FINISHED  → 4-option follow-up (`finished_followup`), drops the active pointer.
 *  - DEPARTED  → stores the active-task pointer (source of truth for follow-ups)
 *               and asks for the binding travel ETA (`status_eta_prompt`).
 *  - ARRIVED   → refreshes the active pointer (window re-anchored), goes idle.
 *  - CONFIRM   → clears context (no pointer).
 */
async function performTransition(
  user: ResolvedUser,
  taskFieldId: string,
  transition: AdvanceTransition,
): Promise<void> {
  if (transition === 'DEPARTED') {
    // Live-tracking (migration 016): open the tracking session BEFORE
    // advanceFieldStatus so the customer EN_ROUTE notification (fired inside
    // advanceFieldStatus) can already resolve the session token for the
    // tracking link. A tracking failure must never block the status write.
    // openTrackingSession transactionally supersedes any prior ACTIVE|ARRIVED
    // session this worker still owns.
    try {
      await openTrackingSession({ taskFieldId, workerUserId: user.id });
    } catch (err) {
      log.error({ err, taskFieldId, workerUserId: user.id }, 'openTrackingSession failed (continuing)');
    }
  }
  await advanceFieldStatus({ taskFieldId, transition, updatedBy: user.id });
  if (transition === 'FINISHED') {
    // finished_followup carries no activeInspection → the pointer is dropped.
    await setContext(user.phone, { awaiting: 'finished_followup', taskFieldId });
    // Live-tracking (migration 016): close the customer-facing session.
    // Best-effort — a tracking failure MUST NOT block the finished-followup menu.
    void closeTrackingSession(taskFieldId, 'FINISHED').catch((err) => {
      log.error({ err, taskFieldId }, 'closeTrackingSession(FINISHED) failed');
    });
    await sendFinishedFollowUpMenu(user.phone);
    // If this was the worker's LAST open field visit today, remind them they can
    // close the tracking app (the only way to stop tracking — there's no remote
    // off switch). advanceFieldStatus already flipped this row to FINISHED_FIELD,
    // so it's excluded from the open count. Gated on active provisioning (never
    // nudge an untracked worker) and best-effort — must never block the follow-up.
    try {
      const remaining = await countOpenInspectionsForWorkerOnDate(user.id, localJerusalemDate());
      if (remaining === 0 && (await hasActiveProvisioning(user.id))) {
        await sendTextMessage({ to: user.phone, text: 'סיימת להיום 👏\n📍 אפשר לסגור את אפליקציית המעקב.' });
      }
    } catch (err) {
      log.error({ err, workerUserId: user.id }, 'close-app reminder check failed — continuing');
    }
    return;
  }
  if (transition === 'DEPARTED') {
    // Store the exact TaskField as the worker's active pointer IMMEDIATELY — this
    // is the source of truth for the next "הגעתי"/"סיימתי", independent of the ETA.
    await setActiveInspection(user.phone, taskFieldId, new Date().toISOString(), {
      awaiting: 'status_eta_prompt',
    });
    // Append the idempotent OwnTracks config link — the DEPARTED reply is the
    // ONLY message that carries it. Tapping the link opens the tracking app on
    // the worker's phone and applies MOVE mode; the worker MUST keep the app
    // running in the background during the drive for the location to update.
    // Omitted silently when the worker has no active provisioning (never a
    // broken link). Best-effort — must never block the ETA prompt.
    let departedBody = departedEtaPrompt();
    try {
      const link = await buildInlineConfigLink(user.id);
      if (link) {
        departedBody +=
          '\n\n📍 פתח את אפליקציית המעקב:\n' +
          link +
          '\nחשוב: השאר את האפליקציה פועלת ברקע במהלך הנסיעה — כך המיקום שלך מתעדכן ללקוח.';
      }
    } catch (err) {
      log.error({ err, workerUserId: user.id }, 'buildInlineConfigLink (DEPARTED) failed — continuing');
    }
    const wamid = await sendTextMessage({ to: user.phone, text: departedBody });
    // Phase 2: quoted-reply context ref (best-effort). A reply to the ETA prompt
    // with "הגעתי"/"סיימתי" resolves back to this TaskField.
    await recordTaskFieldRef(wamid, taskFieldId, user.id, 'eta_prompt');
    return;
  }
  if (transition === 'ARRIVED') {
    // Keep the pointer (re-anchor its window to arrival) so "סיימתי" resolves to
    // the same TaskField; go idle (neutral holder, not a live await).
    await setActiveInspection(user.phone, taskFieldId, new Date().toISOString(), {
      awaiting: 'idle_active_inspection',
    });
    // Live-tracking (migration 016): mark the session ARRIVED. Fire-and-forget.
    void markTrackingArrived(taskFieldId).catch((err) => {
      log.error({ err, taskFieldId }, 'markTrackingArrived failed');
    });
    const wamid = await sendTextMessage({ to: user.phone, text: `עדכנתי — סטטוס: ${STATUS_HE_LABEL[transition]}.` });
    await recordTaskFieldRef(wamid, taskFieldId, user.id, 'status_confirm');
    return;
  }
  // CONFIRM (and any other non-pointer transition).
  await clearContext(user.phone);
  const wamid = await sendTextMessage({ to: user.phone, text: `עדכנתי — סטטוס: ${STATUS_HE_LABEL[transition]}.` });
  await recordTaskFieldRef(wamid, taskFieldId, user.id, 'status_confirm');
}

/**
 * Handle the worker's reply to the travel-ETA prompt (`status_eta_prompt`).
 * The ETA is OPTIONAL and must NEVER trap the worker or weaken the active
 * context:
 *  - a status keyword ("הגעתי"/"סיימתי") → dispatch it on the pointer's TaskField;
 *  - a parseable duration → store it (TaskField columns), keep the pointer, go idle;
 *  - anything else → go idle (keep the pointer) and re-process as a fresh message.
 */
async function handleStatusEtaReply(
  user: ResolvedUser,
  text: string,
  ctx: ConversationState,
  quotedWamid?: string,
): Promise<void> {
  const taskFieldId = ctx.activeInspection?.taskFieldId ?? ctx.taskFieldId;
  if (!taskFieldId) {
    await clearContext(user.phone);
    await handleAIMessage(user, text, quotedWamid);
    return;
  }
  const departedAt = ctx.activeInspection?.departedAt ?? new Date().toISOString();

  // 1. Status keyword → advance now (short drives / "כבר הגעתי").
  const kw = extractDirectStatusKeyword(text);
  if (kw) {
    await performTransition(user, taskFieldId, kw);
    return;
  }

  // 2. Parseable travel time → store it (optional data), keep the pointer, idle.
  const minutes = parseTravelMinutes(text);
  if (minutes !== null) {
    await writeTravelEta({ taskFieldId, minutes, updatedBy: user.id });
    await setActiveInspection(user.phone, taskFieldId, departedAt, {
      awaiting: 'idle_active_inspection',
      etaMinutes: minutes,
    });
    await sendTextMessage({
      to: user.phone,
      text: `מעולה, רשמתי זמן נסיעה משוער: ${minutes} דק׳. עדכן אותי כשתגיע.`,
    });
    return;
  }

  // 3. Neither → don't trap: keep the pointer, go idle, and handle the message
  //    fresh (so an unrelated request isn't swallowed by the ETA prompt).
  await setActiveInspection(user.phone, taskFieldId, departedAt, {
    awaiting: 'idle_active_inspection',
  });
  await handleAIMessage(user, text, quotedWamid);
}

/** Send the finished follow-up menu as a List Message (fallback: numbered text). */
async function sendFinishedFollowUpMenu(phone: string): Promise<void> {
  const items = finishedFollowUpMenu();
  try {
    await sendListMessage({
      to: phone,
      body: 'סיימת את הבדיקה. משהו נוסף?',
      buttonLabel: 'בחר',
      sections: [{
        rows: items.map((i) => ({ id: `FIN_FUP_${i.n}`, title: i.label })),
      }],
    });
  } catch (err) {
    log.warn({ err }, 'sendListMessage failed for finished_followup menu — falling back to text');
    await sendTextMessage({ to: phone, text: renderFinishedFollowUpMenu() });
  }
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
  // Resolve FIN_FUP_N list-tap payloads to digit.
  const resolved = /^FIN_FUP_(\d+)$/i.test(trimmed)
    ? trimmed.replace(/^FIN_FUP_/i, '')
    : trimmed;
  const items = finishedFollowUpMenu();
  const idx = parseInt(resolved, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    await sendFinishedFollowUpMenu(user.phone);
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
      await sendProblemTypeMenu(user.phone);
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
  quotedContext?: QuotedContext | null,
): Promise<void> {
  // ── Phase 2: quoted-message context — STRONGEST signal ─────────────────────
  // The worker swipe-replied to a specific TaskField message. That outranks the
  // active pointer AND the free-text hint, for ANY transition. (The bare-keyword
  // case is already handled in handleAIMessage's fast path; this covers verbose
  // phrasing the LLM classified as set_field_status.)
  if (quotedContext?.entityType === 'task_field' && quotedContext.taskFieldId) {
    const v = await validateWorkerTaskField(user.id, quotedContext.taskFieldId);
    if (v.ok) {
      await performTransition(user, quotedContext.taskFieldId, transition);
      return;
    }
    // Quoted TaskField unusable → fall through to the Phase-1 pointer / normal flow.
  }

  // ── Active-task context (Phase 1) ──────────────────────────────────────────
  // For "continue the active inspection" transitions (ARRIVED/FINISHED) with no
  // explicit hint, the SOURCE OF TRUTH is the stored activeTaskFieldId set on
  // "יצאתי" — NOT a status search. DEPARTED/CONFIRM identify a (fresh) inspection
  // and keep the existing open-inspection resolution below.
  if (!hint && (transition === 'ARRIVED' || transition === 'FINISHED')) {
    // 1. PRIMARY: the stored pointer, if still valid + owned + not closed.
    const active = await getActiveInspection(user.phone);
    if (active) {
      const v = await validateWorkerTaskField(user.id, active.taskFieldId);
      if (v.ok) {
        await performTransition(user, active.taskFieldId, transition);
        return;
      }
      // Pointer no longer usable (closed/reassigned) → fall through to fallback.
    }
    // 2. FALLBACK: live in-progress (EN_ROUTE/ARRIVED) within the window.
    const inProg = await findActiveInProgressTaskFieldForWorker(user.id);
    if (inProg !== null && !('ambiguous' in inProg)) {
      await performTransition(user, inProg.taskFieldId, transition);
      return;
    }
    if (inProg !== null && 'ambiguous' in inProg) {
      await setContext(user.phone, {
        awaiting: 'status_disambig',
        pendingTransition: transition,
        disambigTaskFieldIds: inProg.items.map((i) => i.taskFieldId),
      });
      await sendTextMessage({ to: user.phone, text: buildDisambigPrompt(inProg.items) });
      return;
    }
    // 3. No pointer and nothing in-progress → fall through to the generic
    //    open-inspection resolution below (single→apply, ≥2→ask, 0→"no open").
  }

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
    // The hint (if any) matched multiple open TaskFields, OR no hint was given
    // and the worker has >1 open. Fall back to the full open list so the worker
    // sees a numbered picker instead of a bare count.
    const fullList = await findOpenTaskFieldForWorker(user.id);
    const items =
      fullList !== null && 'ambiguous' in fullList ? fullList.items : [];
    await setContext(user.phone, {
      awaiting: 'status_disambig',
      pendingTransition: transition,
      disambigTaskFieldIds: items.map((i) => i.taskFieldId),
    });
    await sendTextMessage({
      to: user.phone,
      text:
        items.length > 0
          ? buildDisambigPrompt(items)
          : `יש לך ${found.count} בדיקות פתוחות. כתוב את שם הלקוח או כתובת האתר כדי לציין את הבדיקה.`,
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
  disambigTaskFieldIds?: string[],
): Promise<void> {
  if (/^ביטול$/.test(trimmed)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }
  if (!trimmed) {
    await sendTextMessage({
      to: user.phone,
      text: 'לא הצלחתי לזהות. נסה שוב, השב במספר, או כתוב "ביטול".',
    });
    return;
  }

  // Phase 1 parity — numeric pick. If the caller stashed the ordered TaskField
  // IDs in the awaiting state (all 4 disambig entry points do), a bare digit
  // 1..N picks the corresponding row without a DB round-trip.
  let taskFieldId: string | null = null;
  const idx = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
  if (
    Number.isInteger(idx) &&
    disambigTaskFieldIds &&
    idx >= 1 &&
    idx <= disambigTaskFieldIds.length
  ) {
    taskFieldId = disambigTaskFieldIds[idx - 1];
  }

  if (taskFieldId === null) {
    const found = await resolveOpenTaskFieldByHint(user.id, trimmed);
    if (found === null || 'ambiguous' in found) {
      await sendTextMessage({
        to: user.phone,
        text: 'לא הצלחתי לזהות. נסה שוב, השב במספר, או כתוב "ביטול".',
      });
      return;
    }
    taskFieldId = found.taskFieldId;
  }

  if (flow === 'status') {
    // If a pendingTransition was pre-stored (free-text set_field_status path),
    // perform it directly. Otherwise open the 3-item status sub-menu.
    if (pendingTransition === 'CONFIRM' || pendingTransition === 'DEPARTED' || pendingTransition === 'ARRIVED' || pendingTransition === 'FINISHED') {
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
      await sendProblemTypeMenu(user.phone);
      return;
    }
    await setContext(user.phone, { awaiting: 'status_choice', taskFieldId });
    await sendStatusUpdateMenu(user.phone);
    return;
  }
  if (flow === 'missing_info') {
    await setContext(user.phone, { awaiting: 'missing_info_note', taskFieldId });
    await sendTextMessage({ to: user.phone, text: 'מה חסר לדוח?' });
    return;
  }
  // flow === 'problem'
  await setContext(user.phone, { awaiting: 'problem_type_choice', taskFieldId });
  await sendProblemTypeMenu(user.phone);
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
  // "חסר לי ציוד" — D5-T19k: show the structured sub-menu first.
  await showMissingEquipmentChoice(user, localDate);
}

/**
 * D5-T19k: shared entry point for "what equipment is missing?" — shows a
 * structured sub-menu of common items before the free-text prompt. Option
 * 6 ("אחר") falls through to the existing free-text capture
 * (equipment_missing_note). Mirrors the D5-T19j pattern for missing-info.
 */
async function showMissingEquipmentChoice(user: ResolvedUser, localDate: string): Promise<void> {
  await setContext(user.phone, {
    awaiting: 'missing_equipment_choice',
    equipmentLocalDate: localDate,
  });
  await sendTextMessage({ to: user.phone, text: renderMissingEquipmentMenu() });
}

/** State: missing_equipment_choice — worker picks a preset item (1-5) or "אחר" (6). */
async function handleMissingEquipmentChoiceReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  const localDate = ctx.equipmentLocalDate ?? localJerusalemDate();
  const items = missingEquipmentMenu();
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    // Invalid — resend the menu, keep the awaiting state.
    await sendTextMessage({ to: user.phone, text: renderMissingEquipmentMenu() });
    return;
  }
  const chosen = items[idx - 1];
  if (chosen.presetNote === null) {
    // "אחר" — fall through to the existing free-text capture.
    await setContext(user.phone, { awaiting: 'equipment_missing_note', equipmentLocalDate: localDate });
    await sendTextMessage({ to: user.phone, text: 'איזה ציוד חסר לך?' });
    return;
  }
  const sent = await notifyOfficeMissingEquipment({
    userId: user.id,
    userName: user.name,
    note: chosen.presetNote,
    localDate,
  });
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'office') });
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
  const sent = await notifyOfficeMissingEquipment({
    userId: user.id,
    userName: user.name,
    note,
    localDate,
  });
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'office') });
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
  // Live-tracking (migration 016): close any ACTIVE|ARRIVED session on this
  // TaskField as CANCELED — worker won't be arriving. Fire-and-forget.
  void closeTrackingSession(ctx.taskFieldId, 'CANCELED').catch((err) => {
    log.error({ err, taskFieldId: ctx.taskFieldId }, 'closeTrackingSession(CANCELED) failed');
  });
  const sent = await notifyOfficeDeclined(ctx.taskFieldId, reason);
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'office') });
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
  const sent = await notifyOfficeNeedsMoreInfo(ctx.taskFieldId, note);
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'office') });
}

// ── D2-T15: pre-inspection 60-minute reminder button taps ──────────────────
// PREREMIND_DEPART_<taskFieldId>    → advance fieldStatus to EN_ROUTE
// PREREMIND_NEED_INFO_<taskFieldId> → set awaiting pre_reminder_need_info_note
// PREREMIND_PROBLEM_<taskFieldId>   → route to the problem-reporting flow

type PreReminderTapKind = 'DEPART' | 'NEED_INFO' | 'PROBLEM';

/** Parse an inbound message that IS a pre-reminder tap payload. Returns null
 *  for anything else so the caller falls through untouched. */
function matchPreReminderTap(
  raw: string,
): { kind: PreReminderTapKind; taskFieldId: string } | null {
  const m = raw.trim().match(
    /^PREREMIND_(DEPART|NEED_INFO|PROBLEM)_([0-9a-f-]{36})$/i,
  );
  if (!m) return null;
  const token = m[1].toUpperCase() as PreReminderTapKind;
  return { kind: token, taskFieldId: m[2] };
}

/** Hebrew status labels used in the DEPART guard message. */
const STATUS_HE_LABEL_PRE: Record<string, string> = {
  EN_ROUTE:       'בדרך',
  ARRIVED:        'הגיע לאתר',
  FINISHED_FIELD: 'סיים שטח',
};

async function handlePreReminderTap(
  user: ResolvedUser,
  kind: PreReminderTapKind,
  taskFieldId: string,
): Promise<void> {
  switch (kind) {
    case 'DEPART': {
      // Guard: do NOT advance if the worker is already EN_ROUTE, ARRIVED, or
      // FINISHED_FIELD. A prior tap, a voice update, or the menu may have already
      // advanced the status; silently advancing again would corrupt the timeline.
      const { rows } = await pool.query<{ fieldStatus: string }>(
        `SELECT "fieldStatus" FROM "TaskField" WHERE id = $1`,
        [taskFieldId],
      );
      if (rows.length === 0) {
        await clearContext(user.phone);
        await sendTextMessage({ to: user.phone, text: 'לא נמצאה הבדיקה. נסה שוב.' });
        return;
      }
      const current = rows[0].fieldStatus;
      if (current === 'EN_ROUTE' || current === 'ARRIVED' || current === 'FINISHED_FIELD') {
        await clearContext(user.phone);
        await sendTextMessage({
          to: user.phone,
          text: `הסטטוס כבר מתקדם (${STATUS_HE_LABEL_PRE[current] ?? current}). אין צורך לעדכן שוב.`,
        });
        return;
      }
      // Route through the shared status-transition path so DEPARTED stores the
      // active-inspection pointer and prompts for the travel ETA — identical to a
      // typed "יצאתי". This keeps follow-up "הגעתי"/"סיימתי" anchored to THIS
      // TaskField instead of falling back to a status search.
      await performTransition(user, taskFieldId, 'DEPARTED');
      return;
    }
    case 'NEED_INFO':
      await setContext(user.phone, {
        awaiting: 'pre_reminder_need_info_note',
        taskFieldId,
      });
      await sendTextMessage({ to: user.phone, text: 'אילו פרטים חסרים? כתוב מה צריך.' });
      return;
    case 'PROBLEM':
      // Route to the existing problem-reporting flow — same entry point as
      // menu item 4 and the D2-T8 finished follow-up option 3 (reuses
      // problem_type_choice state + sendProblemTypeMenu).
      await setContext(user.phone, { awaiting: 'problem_type_choice', taskFieldId });
      await sendProblemTypeMenu(user.phone);
      return;
  }
}

/**
 * Enhanced due-date reminder — respond to the "פרטים נוספים" button tap or the
 * "פרטים" / "פרטים נוספים" text trigger with the extended task-detail message.
 * Read-only (no writes to Task.status). Distinct from the pre-inspection flow.
 */
async function handleTaskDetailsRequest(user: ResolvedUser, taskId: string): Promise<void> {
  const details = await getTaskDetailsForReminder(taskId);
  if (!details) {
    await sendTextMessage({ to: user.phone, text: 'לא הצלחתי למצוא את פרטי המשימה. נסה שוב או פנה למנהל.' });
    return;
  }
  const crmUrl = buildCrmTaskUrl(taskId);
  const body = formatTaskDetailsExtended(details, crmUrl);
  await sendTextMessage({ to: user.phone, text: body });
}

async function handlePreReminderNeedInfoNoteReply(
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
  const extracted = await extractNote(rawTrimmed, 'missing_info_note');
  const note = extracted ?? rawTrimmed;
  await requestMoreInfo({ taskFieldId: ctx.taskFieldId, note, updatedBy: user.id });
  const sent = await notifyOfficeNeedsMoreInfo(ctx.taskFieldId, note);
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'office') });
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
  await sendDaySummaryFollowUpMenu(user.phone);
}

/** Send the day-summary follow-up menu as a List Message (fallback: numbered text). */
async function sendDaySummaryFollowUpMenu(phone: string): Promise<void> {
  const items = daySummaryFollowUpMenu();
  try {
    await sendListMessage({
      to: phone,
      body: 'יש מה להשלים?',
      buttonLabel: 'בחר',
      sections: [{
        rows: items.map((i) => ({ id: `DAY_FUP_${i.n}`, title: i.label })),
      }],
    });
  } catch (err) {
    log.warn({ err }, 'sendListMessage failed for day_summary_choice menu — falling back to text');
    await sendTextMessage({ to: phone, text: renderDaySummaryFollowUpMenu() });
  }
}

async function handleDaySummaryChoiceReply(user: ResolvedUser, trimmed: string): Promise<void> {
  // Resolve DAY_FUP_N list-tap payloads to digit.
  const resolved = /^DAY_FUP_(\d+)$/i.test(trimmed)
    ? trimmed.replace(/^DAY_FUP_/i, '')
    : trimmed;
  const items = daySummaryFollowUpMenu();
  const idx = parseInt(resolved, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > items.length) {
    await sendDaySummaryFollowUpMenu(user.phone);
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
  const sent = await notifyOfficeCallbackRequest({ userId: user.id, userName: user.name, note });
  await clearContext(user.phone);
  await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'office') });
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

// ── CAL-WA: Outlook calendar helpers ─────────────────────────────────────────

/** Human Hebrew date+time for a calendar event start ("יום ב׳, 20/07 15:00"). */
function fmtCalendarWhen(dt: string | null): string {
  if (!dt) return 'ללא מועד';
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return dt;
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'short', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(d);
}

/** Friendly Hebrew mapping for the "not connected" error the CRM returns. */
function calendarErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('מחובר') || msg.includes('Outlook')
    ? 'חשבון ה-Outlook שלך עדיין לא מחובר. יש להתחבר פעם אחת דרך ה-CRM (הגדרות → Outlook).'
    : msg || 'הפעולה מול היומן נכשלה.';
}

/**
 * Resolve which calendar event an update/delete targets. Mirrors the voice
 * assistant's `resolveCalendarEvent` (voiceTools.ts): explicit event_id →
 * fuzzy subject match over the user's events (7 days back, 60 ahead).
 * On ambiguity / miss it returns a ready-to-send Hebrew message string.
 */
async function resolveCalendarEventForRouter(
  userId: string,
  params: Record<string, unknown> | undefined,
): Promise<
  | { ok: true; eventId: string; subject: string }
  | { ok: false; message: string }
> {
  const explicitId = typeof params?.event_id === 'string' ? params.event_id.trim() : '';
  const match = typeof params?.match === 'string' ? params.match.trim() : '';

  let events: CrmCalendarEvent[];
  try {
    const now = Date.now();
    events = await listCrmCalendarEvents(userId, {
      startIso: new Date(now - 7 * 86_400_000).toISOString(),
      endIso: new Date(now + 60 * 86_400_000).toISOString(),
      top: 50,
    });
  } catch (err) {
    return { ok: false, message: calendarErrorText(err) };
  }

  if (explicitId) {
    const found = events.find((e) => e.id === explicitId);
    return { ok: true, eventId: explicitId, subject: found?.subject ?? 'האירוע' };
  }
  if (!match) {
    return { ok: false, message: 'לאיזה אירוע להתייחס? אפשר לומר חלק מהנושא.' };
  }

  const q = match.toLowerCase();
  const hits = events.filter((e) => (e.subject ?? '').toLowerCase().includes(q));
  if (hits.length === 0) {
    return { ok: false, message: `לא מצאתי ביומן אירוע שמתאים ל"${match}".` };
  }
  if (hits.length > 1) {
    const lines = hits.slice(0, 6).map((e, i) =>
      `${i + 1}. ${e.subject ?? 'ללא נושא'} — ${fmtCalendarWhen(e.start?.dateTime ?? null)}`);
    return {
      ok: false,
      message: `יש כמה אירועים שמתאימים ל"${match}". איזה מהם? אפשר לנסח מדויק יותר:\n${lines.join('\n')}`,
    };
  }
  return { ok: true, eventId: hits[0].id, subject: hits[0].subject ?? 'האירוע' };
}

/**
 * CAL-WA — handle the yes/no reply after a `calendar_delete` confirmation.
 * "כן"/"yes"/"אישור" → delete; anything else → cancel. Clears context either way.
 */
async function handleCalendarDeleteConfirmReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  await clearContext(user.phone);
  const eventId = ctx.calendarDeleteEventId;
  const subject = ctx.calendarDeleteSubject ?? 'האירוע';
  const yes = /^(כן|yes|אישור|מחק|למחוק|בטוח)\b/i.test(trimmed);
  if (!yes) {
    await sendTextMessage({ to: user.phone, text: `בוטל — "${subject}" נשאר ביומן.` });
    return;
  }
  if (!eventId) {
    await sendTextMessage({ to: user.phone, text: 'משהו השתבש — נסה שוב לבקש למחוק את האירוע.' });
    return;
  }
  try {
    await deleteCrmCalendarEvent(user.id, eventId);
    await sendTextMessage({ to: user.phone, text: `🗑️ האירוע "${subject}" נמחק מהיומן.` });
  } catch (err) {
    await sendTextMessage({ to: user.phone, text: calendarErrorText(err) });
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
// Auth: canAssignLeads(user) — isLeadsViewer (Sasha + dev observers) OR isElevated (ADMIN/MANAGER, D5-T19i). Others get a rejection.
// After assignLead() the D3-T3 poller picks up the new ownerId automatically.

const AUTH_REJECT_MSG =
  'אין הרשאה לשייך לידים. אם אתה חושב שזה נחוץ, פנה למנהל המערכת.';

/**
 * Phase 6 — pre-populate the assign-lead flow when the LLM extracted both a
 * lead hint AND a worker name from a single manager sentence. Best-effort:
 * if either lookup is empty or ambiguous, returns `false` and the caller
 * falls back to the normal multi-step flow. On success sets the state to
 * `assign_lead_confirm` so Sasha only types "אישור" / "ביטול".
 */
async function tryPrePopulateAssignLead(
  user: ResolvedUser,
  leadRef: string,
  assigneeName: string,
): Promise<boolean> {
  if (!canAssignLeads(user)) {
    await sendTextMessage({ to: user.phone, text: AUTH_REJECT_MSG });
    return true;
  }
  const leads = await findUnassignedLeadsForAssignment(50);
  if (leads.length === 0) return false;

  // Match lead by substring on fromName / subject.
  const leadRefLower = leadRef.toLowerCase();
  const matchingLeads = leadRef
    ? leads.filter((l) => {
        const name = (l.fromName ?? '').toLowerCase();
        const subj = (l.subject ?? '').toLowerCase();
        return name.includes(leadRefLower) || subj.includes(leadRefLower);
      })
    : [];
  if (leadRef && matchingLeads.length !== 1) return false;

  // Match worker: self-reference ("אלי"/"לי"/"אותי"/"עצמי"/"לעצמי") is checked
  // FIRST (UX-T1) so "לשייך את הליד של X אלי" resolves to the speaker without
  // requiring the speaker's own name to appear in the sentence; otherwise fall
  // back to the existing substring match on name.
  const candidates = await findActiveInspectors();
  const selfWorkerId = resolveSelfReference(assigneeName, user);
  const selfCandidate = selfWorkerId ? candidates.find((c) => c.id === selfWorkerId) ?? null : null;
  const assigneeLower = assigneeName.toLowerCase();
  const matchingWorkers = selfCandidate
    ? [selfCandidate]
    : assigneeName
      ? candidates.filter((c) => c.name.toLowerCase().includes(assigneeLower))
      : [];
  if (assigneeName && matchingWorkers.length !== 1) return false;

  // Both hints must resolve to exactly one row for a straight-to-confirm jump.
  if (!(leadRef && assigneeName && matchingLeads.length === 1 && matchingWorkers.length === 1)) {
    return false;
  }

  const lead = matchingLeads[0];
  const worker = matchingWorkers[0];
  const leadName = lead.fromName ?? '—';

  await setContext(user.phone, {
    awaiting: 'assign_lead_confirm',
    assignLeadSelectedLeadId: lead.id,
    assignLeadSelectedLeadName: leadName,
    assignLeadSelectedWorkerId: worker.id,
    assignLeadSelectedWorkerName: worker.name,
  });
  await sendTextMessage({
    to: user.phone,
    text: `לשייך את הליד של ${leadName} לעובד ${worker.name}? השב "אישור" או "ביטול".`,
  });
  return true;
}

/** Entry-point: triggered by the `assign_lead` AI intent or a direct call. */
async function startAssignLeadFlow(user: ResolvedUser): Promise<void> {
  if (!canAssignLeads(user)) {
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
  if (!canAssignLeads(user)) {
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

  // UX-T1: a worker may already be pinned via the smart-picker merge
  // (mergeAssignLead) when the user free-texted a worker name while still
  // choosing a lead. Skip the worker-pick step and jump straight to confirm.
  if (ctx.assignLeadSelectedWorkerId) {
    const workerId = ctx.assignLeadSelectedWorkerId;
    const workerName = ctx.assignLeadSelectedWorkerName ?? '—';
    await setContext(user.phone, {
      awaiting: 'assign_lead_confirm',
      assignLeadSelectedLeadId: leadId,
      assignLeadSelectedLeadName: leadName,
      assignLeadSelectedWorkerId: workerId,
      assignLeadSelectedWorkerName: workerName,
    });
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
    return;
  }

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
  if (!canAssignLeads(user)) {
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
  if (!canAssignLeads(user)) {
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

// ── UX-T1: Smart Picker Escape (Wave 2 router wiring) ────────────────────────
//
// Replaces the old "clearContext + handleAIMessage" escape hatch for numeric
// picker states (see NUMERIC_PICKER_AWAITING) with a context-preserving flow:
// classify the free-text reply via `classifySmartPickerEscape`
// (smartPickerEscape.ts) and either merge it into the in-progress flow, ask
// to confirm a pivot to a different flow, re-prompt on low-confidence noise,
// or fall through to the legacy net.
//
// Agent D (this wave) builds the scaffolding + the assign_lead merge handler.
// Agents E/F (same wave, serial after D) ONLY add cases to
// `mergeIntoCurrentFlow` and entries to `FLOW_LABELS` for their own flows
// (schedule/reassign/correct, then manager list flows) — the assign_lead
// case/handler here is not theirs to touch.

/** Bound parseIntent used ONLY for classifying a picker-state escape. Returns
 *  null (→ passthrough/redisplay) on any failure so a broken parse never
 *  throws out of the router. */
async function boundParseIntentForEscape(user: ResolvedUser, text: string): Promise<AIIntentResult | null> {
  if (!getProvider()) return null;
  try {
    const [allowedTypes, allowedPriorities, history] = await Promise.all([
      getAllowedTaskTypes(), safePriorities(), getHistory(user.phone),
    ]);
    return await parseIntent(text, { user, allowedTypes, allowedPriorities, history });
  } catch {
    return null;
  }
}

const SMART_ESCAPE_REDISPLAY_HINT =
  'לא הבנתי אם זו בחירה מהרשימה או בקשה חדשה. אפשר להשיב במספר מהרשימה שלמעלה, לנסח מחדש, או "ביטול".';

/** Hebrew labels for the pivot-confirm prompt ("אתה באמצע X. לצאת ולעבור ל-Y?"). */
const FLOW_LABELS: Record<string, string> = {
  assign_lead: 'שיוך ליד',
  schedule_task_field: 'תזמון ביקור',
  reassign_task: 'שיוך משימה מחדש',
  correct_task_field_site: 'תיקון פרטי אתר',
  correct_inspection_type: 'תיקון סוג בדיקה',
  list_today_field_inspections: 'בדיקות שטח להיום',
  list_my_inspections: 'הבדיקות שלי',
  list_open_exceptions: 'חריגים ודיווחים',
  list_pending_leads: 'לידים ממתינים',
  workers_day_overview: 'עובדים וסיכומי יום',
  search_task: 'חיפוש',
};

/**
 * Called from the NUMERIC_PICKER_AWAITING escape hatch when the user's reply
 * doesn't look like a number/nav word. Returns true when the reply was fully
 * handled (merge / pivot-prompt / redisplay-hint) — false means "passthrough"
 * and the caller runs its own legacy net (clearContext + handleAIMessage).
 */
async function trySmartPickerEscape(user: ResolvedUser, text: string, ctx: ConversationState): Promise<boolean> {
  const decision = await classifySmartPickerEscape(text, ctx, {
    parseIntent: (t) => boundParseIntentForEscape(user, t),
    confHigh: CONF_HIGH,
  });
  switch (decision.kind) {
    case 'passthrough':
      return false;                                                 // caller runs legacy net
    case 'redisplay':
      await sendTextMessage({ to: user.phone, text: SMART_ESCAPE_REDISPLAY_HINT });
      return true;                                                  // keep state as-is
    case 'pivot':
      await promptPivotConfirm(user, ctx, decision.intent);
      return true;
    case 'merge':
      return await mergeIntoCurrentFlow(user, text, ctx, decision.intent);
  }
}

// Dispatch by the flow that owns the current picker (== decision.intent.intent).
// D implements assign_lead. E adds schedule/reassign/correct. F adds mgr_*.
// Any flow without a merge handler returns false → caller's legacy net fires.
async function mergeIntoCurrentFlow(
  user: ResolvedUser,
  text: string,
  ctx: ConversationState,
  intent: AIIntentResult,
): Promise<boolean> {
  switch (intent.intent) {
    case 'assign_lead':
      return await mergeAssignLead(user, text, ctx, intent);
    case 'schedule_task_field':
      return await mergeSchedule(user, text, ctx, intent);
    case 'reassign_task':
      return await mergeReassign(user, text, ctx, intent);
    case 'correct_task_field_site':
      return await mergeCorrectSite(user, text, ctx, intent);
    case 'correct_inspection_type':
      return await mergeCorrectType(user, text, ctx, intent);
    case 'workers_day_overview':
      return await mergeMgrWorkersPick(user, text, ctx, intent);
    case 'list_pending_leads':
      return await mergeMgrLeadsPick(user, text, ctx, intent);
    default:
      return false;
  }
}

async function promptPivotConfirm(user: ResolvedUser, ctx: ConversationState, pendingIntent: AIIntentResult): Promise<void> {
  const fromKey = FLOW_INTENT_BY_STATE[ctx.awaiting] ?? '';
  const fromLabel = FLOW_LABELS[fromKey] ?? 'הפעולה הנוכחית';
  const toLabel = FLOW_LABELS[pendingIntent.intent] ?? 'הפעולה החדשה';
  await setContext(user.phone, { ...ctx, awaiting: 'pivot_confirm', pendingIntent, pivotPrevAwaiting: ctx.awaiting });
  await sendTextMessage({ to: user.phone, text: `אתה באמצע ${fromLabel}. לצאת ולעבור ל${toLabel}?\n1. כן\n2. לא` });
}

async function handlePivotConfirmReply(user: ResolvedUser, trimmed: string, ctx: ConversationState): Promise<void> {
  const pending = ctx.pendingIntent;
  const isYes = trimmed === '1' || YES_RE.test(trimmed);
  const isNo  = trimmed === '2' || NO_RE.test(trimmed);
  if (isYes && pending) {
    await clearContext(user.phone);
    await appendTurn(user.phone, 'user', trimmed);
    await routeIntent(user, pending, '');
    return;
  }
  if (isNo || !pending) {
    const prev = ctx.pivotPrevAwaiting;
    if (prev) {
      const restored: ConversationState = { ...ctx, awaiting: prev };
      delete restored.pendingIntent;
      delete restored.pivotPrevAwaiting;
      await setContext(user.phone, restored);
      await sendTextMessage({ to: user.phone, text: 'בסדר, נמשיך. השב במספר מהרשימה (או "ביטול").' });
    } else {
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    }
    return;
  }
  await sendTextMessage({ to: user.phone, text: 'השב 1 כדי לעבור, או 2 כדי להישאר.' });
}

/**
 * Merge handler for the assign_lead flow — the reference implementation the
 * Wave-2 merge handlers (E/F) mirror. Extracts whatever the LLM pulled out of
 * the free text (`leadRef` / `assigneeName`), resolves it against on-screen
 * candidates (falling back to the wider pool only when nothing was shown
 * yet), keeps anything already resolved in `ctx`, and advances to the
 * furthest state that is now resolvable — never wiping a selection the user
 * already made.
 */
async function mergeAssignLead(
  user: ResolvedUser,
  text: string,
  ctx: ConversationState,
  intent: AIIntentResult,
): Promise<boolean> {
  if (!canAssignLeads(user)) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: AUTH_REJECT_MSG });
    return true;
  }

  const leadRef = typeof intent.params?.leadRef === 'string' ? intent.params.leadRef.trim() : '';
  const assigneeName = typeof intent.params?.assigneeName === 'string' ? intent.params.assigneeName.trim() : '';

  // ── Resolve worker: self-reference → active-inspector validation → name
  // fragment match. Anything already chosen in ctx is kept as-is.
  let workerId = ctx.assignLeadSelectedWorkerId ?? null;
  let workerName = ctx.assignLeadSelectedWorkerName ?? null;
  if (!workerId) {
    const selfId = resolveSelfReference(assigneeName || text, user);
    if (selfId) {
      const inspectors = await findActiveInspectors();
      const self = inspectors.find((c) => c.id === selfId);
      if (self) {
        workerId = self.id;
        workerName = self.name;
      }
    } else if (assigneeName) {
      const inspectors = await findActiveInspectors();
      const match = resolveWorkerName(assigneeName, inspectors);
      if (match.status === 'unique') {
        workerId = match.id;
        workerName = match.name;
      }
    }
  }

  // ── Resolve lead: on-screen candidates first, else the wider unassigned
  // pool. Anything already chosen in ctx is kept as-is.
  let leadId = ctx.assignLeadSelectedLeadId ?? null;
  let leadName = ctx.assignLeadSelectedLeadName ?? null;
  if (!leadId && leadRef) {
    const onScreenIds = ctx.assignLeadCandidateIds ?? [];
    let candidates: { id: string; name: string; subject?: string | null }[];
    if (onScreenIds.length > 0) {
      const names = ctx.assignLeadCandidateNames ?? [];
      candidates = onScreenIds.map((id, i) => ({ id, name: names[i] ?? '—' }));
    } else {
      const leads = await findUnassignedLeadsForAssignment(50);
      candidates = leads.map((l) => ({ id: l.id, name: l.fromName ?? '—', subject: l.subject ?? null }));
    }
    const match = resolveLeadReference(leadRef, candidates);
    if (match.status === 'unique') {
      leadId = match.id;
      leadName = match.name;
    }
  }

  // ── Both resolved → jump straight to confirm (reuse the existing wording).
  if (leadId && workerId) {
    await setContext(user.phone, {
      awaiting: 'assign_lead_confirm',
      assignLeadSelectedLeadId: leadId,
      assignLeadSelectedLeadName: leadName ?? '—',
      assignLeadSelectedWorkerId: workerId,
      assignLeadSelectedWorkerName: workerName ?? '—',
    });
    const assignConfirmBody = `לשייך את הליד של ${leadName ?? '—'} ל-${workerName ?? '—'}?`;
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
      log.warn({ err }, 'sendButtonMessage failed for assign_lead merge confirm — falling back to text');
      await sendTextMessage({ to: user.phone, text: `${assignConfirmBody}\n1. אישור\n2. ביטול` });
    }
    return true;
  }

  // ── Lead only → replicate handleAssignLeadPickLeadReply's "lead chosen"
  // branch: fetch inspectors + AI suggestion, show the numbered worker list.
  if (leadId && !workerId) {
    const candidates = await findActiveInspectors();
    if (candidates.length === 0) {
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'לא נמצאו עובדים פעילים לשיוך.' });
      return true;
    }
    const suggestion = await suggestWorkerForLead({ customerName: leadName ?? '—' }, candidates);
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
      assignLeadSelectedLeadName: leadName ?? '—',
      assignLeadWorkerIds: candidates.map((c) => c.id),
      assignLeadWorkerNames: candidates.map((c) => c.name),
    });
    await sendTextMessage({
      to: user.phone,
      text: `${suggestionLine}בחר עובד לשיוך הליד של ${leadName ?? '—'}:\n${lines.join('\n')}\n\nהשב במספר (או "ביטול").`,
    });
    return true;
  }

  // ── Worker only → keep the lead picker open, but remember the worker so
  // handleAssignLeadPickLeadReply can jump straight to confirm once a lead
  // number comes in.
  if (workerId && !leadId) {
    const candidateIds = ctx.assignLeadCandidateIds ?? [];
    if (candidateIds.length > 0) {
      await setContext(user.phone, {
        ...ctx,
        awaiting: 'assign_lead_pick_lead',
        assignLeadSelectedWorkerId: workerId,
        assignLeadSelectedWorkerName: workerName ?? '—',
      });
      await sendTextMessage({
        to: user.phone,
        text: `בחר ליד מהרשימה ואשייך אותו ל-${workerName ?? '—'}.`,
      });
      return true;
    }
    // No on-screen lead list to reuse (defensive — shouldn't normally happen
    // from these states) — start the lead list fresh with the worker pinned.
    const leads = await findUnassignedLeadsForAssignment(20);
    if (leads.length === 0) {
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'אין כרגע לידים לא משויכים.' });
      return true;
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
      assignLeadSelectedWorkerId: workerId,
      assignLeadSelectedWorkerName: workerName ?? '—',
    });
    await sendTextMessage({
      to: user.phone,
      text: `בחר ליד מהרשימה ואשייך אותו ל-${workerName ?? '—'}:\n\n${lines.join('\n\n')}\n\nהשב במספר.`,
    });
    return true;
  }

  // ── Neither resolved → keep state, ask for clarity.
  await sendTextMessage({ to: user.phone, text: SMART_ESCAPE_REDISPLAY_HINT });
  return true;
}

/**
 * Merge handler for the schedule_task_field flow (Wave-2 E). Only applies at
 * the two task-pick states (`schedule_intake_pick_task` /
 * `schedule_pick_from_search`) — the states where `ctx.scheduleTaskCandidates`
 * is the on-screen list. Resolves `intent.task_reference` against that list
 * (reusing `resolveWorkerName`'s generic {id,name} fragment matcher — a Task
 * candidate is just another named candidate here) and, on a unique match,
 * advances via the SAME `scheduleProcessChosenTask` the numeric-pick handler
 * uses — threading any `params.scheduledStartAt` / `durationMinutes` the LLM
 * already extracted so a one-shot "לתזמן ביקור מחר ב-10 לכהן" skips the
 * time prompt too. Never touches `schedule_confirm` (out of scope for this
 * handler — falls through to the caller's legacy net).
 */
async function mergeSchedule(
  user: ResolvedUser,
  text: string,
  ctx: ConversationState,
  intent: AIIntentResult,
): Promise<boolean> {
  if (ctx.awaiting !== 'schedule_intake_pick_task' && ctx.awaiting !== 'schedule_pick_from_search') {
    return false;
  }
  const taskCandidates = ctx.scheduleTaskCandidates ?? [];
  if (taskCandidates.length === 0) {
    return false;
  }

  const ref = typeof intent.task_reference === 'string' ? intent.task_reference.trim() : '';
  if (!ref) {
    await sendTextMessage({ to: user.phone, text: SMART_ESCAPE_REDISPLAY_HINT });
    return true;
  }

  const named = taskCandidates.map((t) => ({ id: t.id, name: t.customerName ?? t.title }));
  const match = resolveWorkerName(ref, named);
  const chosen = match.status === 'unique' ? taskCandidates.find((t) => t.id === match.id) : undefined;
  if (!chosen) {
    // 'none' or 'ambiguous' — keep the picker open, ask for clarity.
    await sendTextMessage({ to: user.phone, text: SMART_ESCAPE_REDISPLAY_HINT });
    return true;
  }

  // Thread any time/duration the LLM already extracted from this same message
  // (mirrors the `startScheduleTaskFieldFlow` prefill path at intent-trigger).
  const paramStartAt = typeof intent.params?.scheduledStartAt === 'string'
    ? intent.params.scheduledStartAt.trim() : '';
  const paramDuration = typeof intent.params?.durationMinutes === 'number'
    ? intent.params.durationMinutes : undefined;
  const paramSpecialInstructions = typeof intent.params?.specialInstructions === 'string'
    ? intent.params.specialInstructions.trim() : '';
  const effectiveCtx: ConversationState = {
    ...ctx,
    scheduleStartAt: paramStartAt || ctx.scheduleStartAt,
    scheduleDurationMinutes: paramDuration ?? ctx.scheduleDurationMinutes,
    scheduleSpecialInstructions: paramSpecialInstructions || ctx.scheduleSpecialInstructions,
  };
  await scheduleProcessChosenTask(user, effectiveCtx, chosen);
  return true;
}

/**
 * Merge handler for the reassign_task flow (Wave-2 E) — HIGHEST VALUE per the
 * contract. Applies at `reassign_pick_worker` (the only state this flow
 * actually reaches in the current code; `reassign_confirm` is a reserved
 * AwaitingKind not currently wired to any handler). `ctx.candidateUserIds`
 * holds ONLY worker ids (see `showWorkerListForReassign`), so we re-fetch
 * `findUsersByName('')` — the exact same source that built the on-screen
 * list — to recover names for matching. Mirrors
 * `handleReassignPickWorkerReply`'s write+audit exactly (that flow has no
 * separate confirm step, so neither does this merge).
 */
async function mergeReassign(
  user: ResolvedUser,
  text: string,
  ctx: ConversationState,
  intent: AIIntentResult,
): Promise<boolean> {
  if (!user.isElevated) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'אין הרשאה — רק מנהל יכול לשייך מחדש.' });
    return true;
  }

  const taskId = ctx.candidateTaskIds?.[0];
  const onScreenWorkerIds = ctx.candidateUserIds ?? [];
  if (!taskId || onScreenWorkerIds.length === 0) {
    await sendTextMessage({ to: user.phone, text: SMART_ESCAPE_REDISPLAY_HINT });
    return true;
  }

  const newWorkerName = typeof intent.params?.newWorkerName === 'string'
    ? intent.params.newWorkerName.trim() : '';

  // Re-fetch the SAME worker source `showWorkerListForReassign` used, then
  // narrow to the ids actually shown on screen (ctx stores ids only).
  const allWorkers = await findUsersByName('');
  const onScreenWorkers = onScreenWorkerIds
    .map((id) => allWorkers.find((w) => w.id === id))
    .filter((w): w is { id: string; name: string } => Boolean(w));

  let workerId: string | null = null;

  const selfId = resolveSelfReference(newWorkerName || text, user);
  if (selfId && onScreenWorkers.some((w) => w.id === selfId)) {
    workerId = selfId;
  } else if (newWorkerName) {
    const match = resolveWorkerName(newWorkerName, onScreenWorkers, allWorkers);
    // Confirm the resolved id was actually one of the ids offered on screen —
    // a wider-tier match on a worker who wasn't shown is not a valid pick.
    if (match.status === 'unique' && onScreenWorkers.some((w) => w.id === match.id)) {
      workerId = match.id;
    }
  }

  if (!workerId) {
    await sendTextMessage({ to: user.phone, text: SMART_ESCAPE_REDISPLAY_HINT });
    return true;
  }

  const result = await reassignTask(taskId, workerId, user.id);
  await clearContext(user.phone);
  let msg = `המשימה שויכה מחדש. ${result.resetCount} שורות בדיקה אופסו.`;
  if (result.hadInProgressRows) msg += ' (שורות שכבר בביצוע לא שונו.)';
  await sendTextMessage({ to: user.phone, text: msg });
  await auditEvent(user, 'reassign_task', taskId, 'SUCCESS');
  return true;
}

/**
 * Merge handler for correct_task_field_site (Wave-2 E) — CONSERVATIVE per the
 * contract: only re-resolves when the LLM extracted a fresh `task_reference`,
 * routing it through the SAME `resolveAndShowSiteFieldMenu` entry point the
 * fresh-intent path uses (so ambiguous/no-match handling stays identical). No
 * value-extraction is attempted here — that path already exists at
 * `correct_site_await_value` / `correct_site_confirm_extracted`. No task
 * reference in the parsed intent → `false` (legacy net).
 */
async function mergeCorrectSite(
  user: ResolvedUser,
  text: string,
  ctx: ConversationState,
  intent: AIIntentResult,
): Promise<boolean> {
  const ref = typeof intent.task_reference === 'string' ? intent.task_reference.trim() : '';
  if (!ref) return false;
  await resolveAndShowSiteFieldMenu(user, ctx.intent ?? intent, ref);
  return true;
}

/**
 * Merge handler for correct_inspection_type (Wave-2 E) — same conservative
 * shape as `mergeCorrectSite`: a fresh `task_reference` re-runs
 * `resolveAndShowTypeList`; otherwise `false` (legacy net).
 */
async function mergeCorrectType(
  user: ResolvedUser,
  text: string,
  ctx: ConversationState,
  intent: AIIntentResult,
): Promise<boolean> {
  const ref = typeof intent.task_reference === 'string' ? intent.task_reference.trim() : '';
  if (!ref) return false;
  await resolveAndShowTypeList(user, ctx.intent ?? intent, ref);
  return true;
}

/**
 * Merge handler for the workers_day_overview flow (Wave-2 F) — mirrors
 * `handleMgrWorkersPickWorkerReply`'s "worker chosen" branch. Only acts at
 * `mgr_workers_pick_worker` — the one state where `ctx.mgrWorkerIds` /
 * `ctx.mgrWorkerNames` hold the on-screen numbered worker list (`mgr_workers_sub`
 * has no name to pick against, so the default:false legacy net handles it, same
 * as the task-id-only manager pickers per the contract).
 *
 * Name resolution checks whatever the parser filled — `params.workerName` (the
 * documented param for this intent), `params.assigneeName` (defensive, mirrors
 * assign_lead's slot naming), then the generic `task_reference` — and tries
 * `resolveSelfReference` first. Candidates passed to the resolvers are ONLY the
 * on-screen pair (no wider table exists for this flow), so any 'unique' match
 * is inherently on-screen; the explicit `ids.includes(...)` checks below are
 * kept anyway for defense/consistency with `mergeReassign`'s validation style.
 * Not unique / not resolvable → redisplay hint, keep state.
 */
async function mergeMgrWorkersPick(
  user: ResolvedUser,
  text: string,
  ctx: ConversationState,
  intent: AIIntentResult,
): Promise<boolean> {
  if (ctx.awaiting !== 'mgr_workers_pick_worker') return false;

  const ids = ctx.mgrWorkerIds ?? [];
  const names = ctx.mgrWorkerNames ?? [];
  if (ids.length === 0) return false;

  const candidates = ids.map((id, i) => ({ id, name: names[i] ?? '—' }));

  const paramWorkerName = typeof intent.params?.workerName === 'string' ? intent.params.workerName.trim() : '';
  const paramAssigneeName = typeof intent.params?.assigneeName === 'string' ? intent.params.assigneeName.trim() : '';
  const paramTaskRef = typeof intent.task_reference === 'string' ? intent.task_reference.trim() : '';
  const nameHint = paramWorkerName || paramAssigneeName || paramTaskRef;

  let workerId: string | null = null;
  let workerName: string | null = null;

  const selfId = resolveSelfReference(nameHint || text, user);
  if (selfId && ids.includes(selfId)) {
    workerId = selfId;
    workerName = candidates.find((c) => c.id === selfId)?.name ?? null;
  } else if (nameHint) {
    const match = resolveWorkerName(nameHint, candidates);
    if (match.status === 'unique' && ids.includes(match.id)) {
      workerId = match.id;
      workerName = match.name;
    }
  }

  if (!workerId) {
    await sendTextMessage({ to: user.phone, text: SMART_ESCAPE_REDISPLAY_HINT });
    return true;
  }

  // From here mirrors handleMgrWorkersPickWorkerReply's "worker chosen" branch exactly.
  const localDate = localJerusalemDate();
  const detail = await getWorkerDayDetail(workerId, localDate);

  if (detail.total === 0) {
    await setContext(user.phone, { awaiting: 'mgr_workers_sub' });
    await sendTextMessage({ to: user.phone, text: `אין בדיקות היום עבור ${workerName ?? '—'}.\n\n${renderMgrWorkersSub()}` });
    return true;
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

  // Layer 1 fix (same as the numeric-pick handler): restore mgr_menu_root so
  // the next bare digit picks the right item.
  await setContext(user.phone, { awaiting: 'mgr_menu_root' });
  await sendChunked(user.phone,
    `${workerName ?? '—'} — היום (${fmtDDMM(localDate)}):\n\n${lines.join('\n\n')}\n\n${summary}`,
  );
  return true;
}

/**
 * Merge handler for the list_pending_leads flow (Wave-2 F) — mirrors
 * `handleMgrLeadsPickRowReply`'s "lead chosen" branch. Only acts at
 * `mgr_leads_pick_row` — the one state where `ctx.mgrLeadIds` / `ctx.mgrLeadNames`
 * hold the on-screen numbered lead list (`mgr_leads_sub` has no row to pick
 * against, so the default:false legacy net handles it).
 *
 * `list_pending_leads` has no dedicated "which lead" param in the current
 * intent-parser prompt (owner/name scoping for this intent is documented as
 * "not yet supported"), so this checks a few plausible param slots defensively
 * (`params.leadRef`, `params.customerName`) before falling back to the generic
 * `task_reference` — whichever the parser actually fills for a named follow-up
 * like "תראה לי את הליד של דנה". Matches only against the on-screen pair (no
 * wider pool for this flow); ambiguous/no match → redisplay hint, keep state.
 */
async function mergeMgrLeadsPick(
  user: ResolvedUser,
  text: string,
  ctx: ConversationState,
  intent: AIIntentResult,
): Promise<boolean> {
  if (ctx.awaiting !== 'mgr_leads_pick_row') return false;

  const ids = ctx.mgrLeadIds ?? [];
  const names = ctx.mgrLeadNames ?? [];
  if (ids.length === 0) return false;

  const candidates = ids.map((id, i) => ({ id, name: names[i] ?? '—' }));

  const paramLeadRef = typeof intent.params?.leadRef === 'string' ? intent.params.leadRef.trim() : '';
  const paramCustomerName = typeof intent.params?.customerName === 'string' ? intent.params.customerName.trim() : '';
  const paramTaskRef = typeof intent.task_reference === 'string' ? intent.task_reference.trim() : '';
  const nameHint = paramLeadRef || paramCustomerName || paramTaskRef;

  if (!nameHint) {
    await sendTextMessage({ to: user.phone, text: SMART_ESCAPE_REDISPLAY_HINT });
    return true;
  }

  const match = resolveLeadReference(nameHint, candidates);
  if (match.status !== 'unique' || !ids.includes(match.id)) {
    await sendTextMessage({ to: user.phone, text: SMART_ESCAPE_REDISPLAY_HINT });
    return true;
  }

  // From here mirrors handleMgrLeadsPickRowReply's "lead chosen" branch exactly.
  const lead = await getLeadById(match.id);
  if (!lead) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'לא נמצא ליד. נסה שוב.' });
    return true;
  }
  const enrichment = await enrichLead(lead);
  const detailText = formatLeadDetailCompact(lead, enrichment);
  // Keep state in mgr_leads_pick_row so "חזרה" resends the sub-menu and typing
  // another number/name re-picks a lead from the same list.
  await setContext(user.phone, {
    awaiting: 'mgr_leads_pick_row',
    mgrLeadIds: ctx.mgrLeadIds,
    mgrLeadNames: ctx.mgrLeadNames,
  });
  await sendTextMessage({ to: user.phone, text: detailText });
  return true;
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
  try {
    await sendListMessage({
      to: user.phone,
      body: 'מה לתקן? בחר שדה ואז שלח את הערך החדש.',
      buttonLabel: 'בחר שדה',
      sections: [{
        rows: [
          { id: 'SITE_FIELD_1', title: 'כתובת אתר' },
          { id: 'SITE_FIELD_2', title: 'עיר' },
          { id: 'SITE_FIELD_3', title: 'שם איש קשר' },
          { id: 'SITE_FIELD_4', title: 'טלפון איש קשר' },
        ],
      }],
    });
  } catch (err) {
    log.warn({ err }, 'sendListMessage failed for site field menu — falling back to text');
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

// Map SITE_FIELD_N payload id → field label for the colon-split path.
const SITE_FIELD_PAYLOAD_MAP: Record<string, string> = {
  SITE_FIELD_1: 'כתובת אתר',
  SITE_FIELD_2: 'עיר',
  SITE_FIELD_3: 'שם איש קשר',
  SITE_FIELD_4: 'טלפון איש קשר',
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

  // ── SITE_FIELD_N list-tap → prompt the user to type the new value ──
  const siteFieldLabel = SITE_FIELD_PAYLOAD_MAP[text.toUpperCase()];
  if (siteFieldLabel) {
    // User tapped a field row — ask them to type the new value.
    await sendTextMessage({
      to: user.phone,
      text: `הזן את הערך החדש עבור "${siteFieldLabel}":`,
    });
    // Keep the same context (correct_site_await_value) — next message is the value.
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

  // UX-T1 single-shot: if the user named the target worker in the same message
  // ("להעביר לאורי את הבדיקה של כהן"), resolve it and jump straight to a single
  // confirmation instead of showing the full numbered worker list. A destructive
  // write (reassignTask resets inspection rows) always goes through a confirm on
  // this free-text path, since the user never saw the candidate list.
  const newWorkerName = typeof intent.params?.newWorkerName === 'string'
    ? intent.params.newWorkerName.trim() : '';
  if (newWorkerName) {
    let resolvedId: string | null = null;
    let resolvedName = '';
    const selfId = resolveSelfReference(newWorkerName, user);
    if (selfId && workers.some((w) => w.id === selfId)) {
      resolvedId = selfId;
      resolvedName = workers.find((w) => w.id === selfId)?.name ?? '';
    } else {
      const match = resolveWorkerName(newWorkerName, workers);
      if (match.status === 'unique') { resolvedId = match.id; resolvedName = match.name; }
    }
    if (resolvedId) {
      await setContext(user.phone, {
        awaiting: 'reassign_confirm',
        intent,
        candidateTaskIds: [taskId],
        candidateUserIds: [resolvedId],
      });
      const body = `לשייך מחדש את המשימה ל-${resolvedName}?`;
      try {
        await sendButtonMessage({
          to: user.phone,
          body,
          buttons: [
            { id: 'CONFIRM_YES_REASSIGN', title: 'אישור' },
            { id: 'CONFIRM_NO_REASSIGN',  title: 'ביטול' },
          ],
        });
      } catch (err) {
        log.warn({ err }, 'sendButtonMessage failed for reassign confirm — falling back to text');
        await sendTextMessage({ to: user.phone, text: `${body}\n1. אישור\n2. ביטול` });
      }
      return;
    }
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

/** State: reassign_confirm — single-shot reassign confirmation (UX-T1). The
 *  numbered-pick reassign flow writes on pick with no confirm, but the free-text
 *  single-shot path never showed the worker list, so it confirms first. */
async function handleReassignConfirmReply(
  user: ResolvedUser,
  trimmed: string,
  ctx: ConversationState,
): Promise<void> {
  if (!user.isElevated) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'אין הרשאה — רק מנהל יכול לשייך מחדש.' });
    return;
  }
  const taskId = ctx.candidateTaskIds?.[0];
  const newOwnerId = ctx.candidateUserIds?.[0];
  if (!taskId || !newOwnerId) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  const isYes = trimmed === '1' || /^CONFIRM_YES_REASSIGN/i.test(trimmed) || YES_RE.test(trimmed);
  const isNo  = trimmed === '2' || /^CONFIRM_NO_REASSIGN/i.test(trimmed)  || NO_RE.test(trimmed);
  if (isNo) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    return;
  }
  if (!isYes) {
    await sendTextMessage({ to: user.phone, text: 'השב 1 לאישור או 2 לביטול.' });
    return;
  }
  const result = await reassignTask(taskId, newOwnerId, user.id);
  await clearContext(user.phone);
  let msg = `המשימה שויכה מחדש. ${result.resetCount} שורות בדיקה אופסו.`;
  if (result.hadInProgressRows) msg += ' (שורות שכבר בביצוע לא שונו.)';
  await sendTextMessage({ to: user.phone, text: msg });
  await auditEvent(user, 'reassign_task', taskId, 'SUCCESS');
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

// ── PROV-T5 (TASKS §4.20): enable OwnTracks tracking for a worker ────────────
//
// Intent: `enable_worker_location_tracking`. MANAGER / ADMIN only.
//
// Flow:
//   1. Manager triggers via free text ("הפעל מעקב מיקום לדני") or menu-adjacent.
//   2. Resolve the worker hint (`intent.task_reference` / `intent.params.workerHint`)
//      → `User.id + name + phone`.
//   3. Call `createProvisioning` — issues a one-time token, returns a magic
//      https link `/o/:token` that OwnTracks opens.
//   4. Send the worker a WhatsApp message (freeform in-window, template
//      out-of-window via `notify`) with the link + a short permissions checklist.
//   5. Confirm to the manager.

async function startEnableWorkerLocationTracking(
  user: ResolvedUser,
  intent: AIIntentResult,
): Promise<void> {
  if (!isManagerMenuUser(user)) {
    await sendTextMessage({ to: user.phone, text: 'אין הרשאה.' });
    return;
  }
  const hintRaw =
    (typeof intent.params?.workerHint === 'string' && intent.params.workerHint) ||
    intent.task_reference ||
    '';
  const hint = hintRaw.trim();
  if (!hint) {
    // Set a context so the next inbound text is treated as the worker name —
    // otherwise the LLM would re-parse "גיא" as a fresh intent and misfire.
    await setContext(user.phone, { awaiting: 'enable_tracking_pick_worker', intent });
    await sendTextMessage({
      to: user.phone,
      text: 'לאיזה עובד להפעיל מעקב מיקום? השב עם שם העובד.',
    });
    return;
  }

  await resolveAndTriggerEnableTracking(user, hint);
}

/**
 * Second half of the enable-tracking flow. Extracted so the initial free-text
 * entry and the `enable_tracking_pick_worker` follow-up can share it. Given the
 * worker name hint, resolves to a single `User`, provisions, sends the magic
 * link, and confirms to the manager.
 */
async function resolveAndTriggerEnableTracking(
  user: ResolvedUser,
  hint: string,
): Promise<void> {
  const matches = await findUsersByName(hint);
  if (matches.length === 0) {
    await sendTextMessage({
      to: user.phone,
      text: `לא נמצא עובד בשם "${hint}".`,
    });
    return;
  }
  if (matches.length > 1) {
    const lines = matches.map((w, i) => `${i + 1}. ${w.name}`).join('\n');
    await sendTextMessage({
      to: user.phone,
      text: `נמצאו מספר עובדים תואמים. פרט שם מדויק יותר:\n${lines}`,
    });
    return;
  }
  const workerId = matches[0].id;
  const workerName = matches[0].name;

  // Fetch phone separately — findUsersByName does not return it.
  const phoneRes = await pool.query<{ phone: string | null }>(
    `SELECT phone FROM "User" WHERE id = $1`,
    [workerId],
  );
  const workerPhone = phoneRes.rows[0]?.phone ?? null;
  if (!workerPhone) {
    await sendTextMessage({
      to: user.phone,
      text: `לעובד "${workerName}" לא רשום מספר טלפון. הוסף בטבלת המשתמשים ונסה שוב.`,
    });
    return;
  }

  let provResult;
  try {
    provResult = await createProvisioning(workerId);
  } catch (err) {
    log.error({ err, workerId }, 'PROV-T5: createProvisioning failed');
    const msg = err instanceof Error && err.message.includes('PUBLIC_BASE_URL')
      ? 'שרת לא מוגדר: PUBLIC_BASE_URL חסר.'
      : 'שגיאה ביצירת קישור הפרוביז\'נינג. נסה שוב.';
    await sendTextMessage({ to: user.phone, text: msg });
    return;
  }

  const permissionsChecklist =
    'לאחר לחיצה על הקישור, אשר בבקשה:\n' +
    '• iPhone: הרשאות מיקום → "תמיד" (Always) + Precise Location פעיל\n' +
    '• Android: הרשאות מיקום → "אפשר תמיד" + בטל אופטימיזציית סוללה';

  const workerBody =
    `שלום ${workerName}, להפעלת מעקב מיקום לצורך מעקב הגעה ללקוח:\n\n` +
    `${provResult.magicUrl}\n\n` +
    `${permissionsChecklist}\n\n` +
    `הקישור בתוקף ל-48 שעות.`;

  try {
    await notify({
      to: workerPhone,
      key: 'OWNTRACKS_PROVISIONING',
      bodyParams: [workerName, provResult.magicUrl],
      fallbackText: workerBody,
    });
  } catch (err) {
    log.error({ err, workerId, workerPhone }, 'PROV-T5: WhatsApp send to worker failed');
    await sendTextMessage({
      to: user.phone,
      text: `יצרתי קישור אבל שליחת ההודעה לעובד ${workerName} נכשלה. הקישור:\n${provResult.magicUrl}`,
    });
    return;
  }

  const expiryLocal = provResult.expiresAt.toLocaleString('he-IL', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  });
  await sendTextMessage({
    to: user.phone,
    text: `נשלח לעובד ${workerName} קישור להפעלת מעקב מיקום. תוקף עד ${expiryLocal}.`,
  });
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
  customerRef: string | null = null,
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

  // UX-T1 single-shot: if the user named a customer/task in the same message
  // ("לתזמן ביקור מחר ב-10 ללקוח לוי"), auto-select it when it resolves to
  // exactly one open task and advance straight to the time/confirm step —
  // no list-pick needed. Falls through to the numbered list on none/ambiguous.
  if (customerRef && customerRef.trim()) {
    const named = taskCandidates.map((t) => ({ id: t.id, name: t.customerName ?? t.title }));
    const match = resolveWorkerName(customerRef.trim(), named);
    if (match.status === 'unique') {
      const chosen = taskCandidates.find((t) => t.id === match.id);
      if (chosen) {
        const effectiveCtx: ConversationState = {
          awaiting: 'schedule_intake_pick_task',
          scheduleTaskCandidates: taskCandidates,
          scheduleStartAt: prefilledStartAt ?? undefined,
          scheduleDurationMinutes: prefilledDuration ?? undefined,
          scheduleSpecialInstructions: prefilledSpecialInstructions ?? undefined,
        };
        await scheduleProcessChosenTask(user, effectiveCtx, chosen);
        return;
      }
    }
  }

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

/**
 * Extract and validate a dateRange from an arbitrary `params.dateRange` value
 * emitted by the LLM.
 *
 * Validation rules (D5-T11 Phase 4):
 *  - Must be an object with string `from` and `to`.
 *  - Both must match YYYY-MM-DD.
 *  - `from` must be <= `to` (otherwise invalid → return null, fall back to today).
 * Returns null when absent or invalid — callers fall back to today behavior.
 */
function extractDateRange(
  raw: unknown,
): import('../services/managerViews').DateRangeParam | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const from = obj['from'];
  const to   = obj['to'];
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  // Basic YYYY-MM-DD format check.
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoRe.test(from) || !isoRe.test(to)) return null;
  // from must be <= to (half-open window: from=to means empty range, which is valid but useless).
  if (from > to) return null;
  return { from, to };
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

/**
 * D5-T19g: optional `dateRange` widens the org-wide field-inspections list
 * beyond "today" — same half-open-window pattern as list_open_exceptions /
 * list_pending_leads / workers_day_overview. Absent → existing today-only
 * behavior, unchanged (still used by manager menu item 2).
 */
async function showMgrTodayInspections(
  user: ResolvedUser,
  dateRange?: import('../services/managerViews').DateRangeParam,
): Promise<void> {
  const localDate = localJerusalemDate();
  const rows = await getTodayFieldInspections(localDate, dateRange);
  const label = dateRange ? `${fmtDDMM(dateRange.from)}–${fmtDDMM(dateRange.to)}` : `היום (${fmtDDMM(localDate)})`;

  if (rows.length === 0) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: `אין בדיקות שטח משובצות ${label}.` });
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
      dateStr: dateRange ? dateRange.from : localDate,
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
    `בדיקות שטח — ${label} (${rows.length}):\n\n${lines.join('\n\n')}\n\nבחר מספר לפרטים ופעולות, או "חזרה" לתפריט.`,
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

// ── 7. My field inspections today (D2-T16) ───────────────────────────────────
//
// Personal counterpart of item 2 (org-wide). Shows only TaskFields where
// Task.ownerId = current user AND scheduledStartAt is today (Asia/Jerusalem).
// Uses formatInspectionListRow(row, false) — worker column suppressed because
// every row belongs to the requesting user.

async function showMyFieldInspectionsToday(user: ResolvedUser): Promise<void> {
  const localDate = localJerusalemDate();
  const rows = await getMyFieldInspectionsToday(user.id, localDate);

  if (rows.length === 0) {
    await sendTextMessage({ to: user.phone, text: 'אין לך בדיקות שטח להיום.' });
    // Return to menu context so the user can pick another item without re-opening.
    await setContext(user.phone, { awaiting: 'mgr_menu_root' });
    return;
  }

  const ddmm = fmtDDMM(localDate);
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
    // showWorker=false: every row belongs to the requesting user, no need to repeat the name.
    return `${i + 1}. ${formatInspectionListRow(rowData, false)}`;
  });

  await setContext(user.phone, {
    awaiting: 'mgr_my_today_pick_task',
    mgrTaskFieldIds: rows.map((r) => r.taskFieldId),
    mgrTaskIds: rows.map((r) => r.taskId),
  });

  await sendChunked(user.phone,
    `הבדיקות שלי להיום — ${ddmm} (${rows.length}):\n\n${lines.join('\n\n')}\n\nבחר מספר לפרטים ופעולות, או "חזרה" לתפריט.\n\nאפשר גם לכתוב:\n"הבדיקות שלי השבוע"\n"הבדיקות שלי בין 1/7 ל-10/7"`,
  );
}

/**
 * Free-text "הבדיקות שלי …" fast path.
 *
 * Bare "הבדיקות שלי" (empty suffix) defaults to TODAY.
 * A non-empty suffix that the parser can't understand → Hebrew hint.
 * A parseable range → query + render + set the same numeric-pick context that
 * the menu-item-7 flow uses (so numeric replies drill into the detail view via
 * the existing `handleMgrMyTodayPickTaskReply` handler).
 */
async function handleMyInspectionsFreeText(user: ResolvedUser, text: string): Promise<void> {
  const m = text.match(MY_INSPECTIONS_RE);
  const suffix = (m?.[2] ?? '').trim();

  // "all time" shortcut inside the fast-path — matches "כל הזמנים",
  // "מכל הזמנים", "הכל", "בלי הגבלה", "מאז ומעולם", "מהתחלה".
  if (/^(?:מ?כל\s+הזמנים|הכל|בלי\s+הגבלה|מאז\s+ומעולם|מהתחלה)$/.test(suffix)) {
    await handleMyInspectionsAllTime(user);
    return;
  }

  const now = new Date();
  let range: { fromLocalDate: string; toLocalDate: string; label: string };
  if (suffix.length === 0) {
    // Default to today.
    const today = localJerusalemDate(now);
    const tomorrow = addLocalDay(today, 1);
    range = { fromLocalDate: today, toLocalDate: tomorrow, label: `היום ${fmtDDMM(today)}` };
  } else {
    const parsed = parseHebrewInspectionRange(suffix, now);
    if (!parsed) {
      // The user's suffix wasn't a recognized Hebrew range ("מהזמן", "לא ברור" —
      // things like "מכל הזמנים" already handled above). Instead of erroring,
      // hand off to the AI parser — the LLM has a broader vocabulary
      // (list_my_inspections with `dateScope: "all"` etc.). This is the
      // "AI-first" fallback the product owner asked for.
      await routeToAIParserFor(user, text);
      return;
    }
    range = parsed;
  }

  await renderMyInspectionsRange(user, range);
}

/**
 * QA-FIX-7: shared render/context/send block for a resolved
 * `{ fromLocalDate, toLocalDate, label }` window — used by both the
 * deterministic fast path (`handleMyInspectionsFreeText`) and the LLM
 * free-`dateRange` channel (`case 'list_my_inspections'` → `params.dateRange`).
 * `toLocalDate` is EXCLUSIVE (half-open window), matching every other
 * dateRange consumer in this file.
 */
async function renderMyInspectionsRange(
  user: ResolvedUser,
  range: { fromLocalDate: string; toLocalDate: string; label: string },
): Promise<void> {
  const items = await getMyInspectionsInRange(user.id, range.fromLocalDate, range.toLocalDate);

  if (items.length === 0) {
    await sendTextMessage({
      to: user.phone,
      text: `אין לך בדיקות שטח בטווח שבחרת (${range.label}).`,
    });
    return;
  }

  // Detect whether the range spans more than one calendar day → include DD/MM
  // in each row's time line. Half-open window: > 1 day means multi-day.
  const isMultiDay = daysBetween(range.fromLocalDate, range.toLocalDate) > 1;
  const body = formatMyInspectionsRange(items, range.label, isMultiDay);

  await setContext(user.phone, {
    awaiting: 'mgr_my_today_pick_task', // reuse existing pick handler
    mgrTaskFieldIds: items.map((r) => r.taskFieldId),
    mgrTaskIds: items.map((r) => r.taskId),
  });

  await sendChunked(user.phone, body);
}

/**
 * "All time" variant of `handleMyInspectionsFreeText` — no date filter, up to
 * 200 most-recent TaskFields. Used when the user asks
 * "תציג את כל הבדיקות שלי מכל הזמנים" / "הכל" / "בלי הגבלה" — either from
 * the LLM (`list_my_inspections` intent with `dateScope='all'`) or via the
 * fast-path regex + suffix normalization inside `handleMyInspectionsFreeText`.
 */
async function handleMyInspectionsAllTime(user: ResolvedUser): Promise<void> {
  const items = await getAllMyInspections(user.id);
  if (items.length === 0) {
    await sendTextMessage({
      to: user.phone,
      text: 'אין לך שום בדיקות שטח משויכות (כל הזמנים).',
    });
    return;
  }
  const body = formatMyInspectionsRange(items, `כל הזמנים · ${items.length} בדיקות`, /* isMultiDay */ true);
  await setContext(user.phone, {
    awaiting: 'mgr_my_today_pick_task', // reuse the same numbered-picker handler
    mgrTaskFieldIds: items.map((r) => r.taskFieldId),
    mgrTaskIds: items.map((r) => r.taskId),
  });
  await sendChunked(user.phone, body);
}

/**
 * Fast-path recovery: when `MY_INSPECTIONS_RE` matched but the suffix isn't a
 * recognized range (e.g. "בין הזמנים", "לפני חודש"), delegate to the AI parser
 * so the LLM can emit `list_my_inspections` with a broader `dateScope`. Uses
 * the same rolling history + provider path as `handleAIMessage`.
 */
async function routeToAIParserFor(user: ResolvedUser, text: string): Promise<void> {
  if (!getProvider()) {
    await sendTextMessage({
      to: user.phone,
      text: 'לא הצלחתי להבין את הטווח. נסה "הבדיקות שלי היום", "הבדיקות שלי השבוע", "הכל", או "הבדיקות שלי בין 1/7 ל-10/7".',
    });
    return;
  }
  let intent: AIIntentResult;
  try {
    const [allowedTypes, allowedPriorities, history] = await Promise.all([
      getAllowedTaskTypes(),
      safePriorities(),
      getHistory(user.phone),
    ]);
    intent = await parseIntent(text, { user, allowedTypes, allowedPriorities, history });
  } catch (err) {
    log.error({ err }, 'AI fallback parse failed inside handleMyInspectionsFreeText');
    await sendTextMessage({ to: user.phone, text: 'שגיאה בעיבוד הבקשה. נסה שוב.' });
    return;
  }
  await appendTurn(user.phone, 'user', text);
  await routeIntent(user, intent, text);
}

/** Format the multi-row range list for `handleMyInspectionsFreeText`. */
function formatMyInspectionsRange(
  items: MyInspectionRangeItem[],
  label: string,
  isMultiDay: boolean,
): string {
  const lines = items.map((r, i) => {
    const rowData: InspectionListRowData = {
      taskTitle: r.taskTitle,
      typeLabelHe: r.typeLabelHe,
      timeHm: formatHmJerusalem(r.scheduledStartAt),
      siteCity: r.siteCity,
      fieldStatus: r.fieldStatus,
      // In multi-day view, include per-row date via `scheduledStartAt` so the
      // formatter emits a "תאריך: DD/MM" line. In single-day view, suppress it
      // (the header already communicates the day) — pass a dateStr matching the
      // single day so the row doesn't repeat it.
      scheduledStartAt: isMultiDay ? r.scheduledStartAt : null,
      dateStr: isMultiDay ? null : localJerusalemDateOf(r.scheduledStartAt),
    };
    return `${i + 1}. ${formatInspectionListRow(rowData, false)}`;
  });

  return (
    `הבדיקות שלי — ${label} (${items.length}):\n\n` +
    `${lines.join('\n\n')}\n\n` +
    `אפשר גם לכתוב:\n"הבדיקות שלי השבוע"\n"הבדיקות שלי בין 1/7 ל-10/7"\n\n` +
    `בחר מספר לפרטים, או "חזרה".`
  );
}

/** Format a timestamptz as "HH:MM" in Asia/Jerusalem. */
function formatHmJerusalem(d: Date): string {
  const parts = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(d));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('hour')}:${get('minute')}`;
}

/** Format a timestamptz as 'YYYY-MM-DD' in Asia/Jerusalem. */
function localJerusalemDateOf(d: Date): string {
  return localJerusalemDate(new Date(d));
}

/** Add `n` days to a 'YYYY-MM-DD' local date (no TZ shift). */
function addLocalDay(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map((x) => parseInt(x, 10));
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + n);
  const yy = anchor.getUTCFullYear();
  const mm = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(anchor.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Integer day count between two 'YYYY-MM-DD' local dates (half-open). */
function daysBetween(fromIso: string, toIso: string): number {
  const parse = (s: string) => {
    const [y, m, d] = s.split('-').map((x) => parseInt(x, 10));
    return Date.UTC(y, m - 1, d, 12, 0, 0);
  };
  return Math.round((parse(toIso) - parse(fromIso)) / 86400000);
}

async function handleMgrMyTodayPickTaskReply(
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
  // Reuse the same detail view and action handler as item 2 (mgr_today_action).
  // The detail formatter and action dispatcher are identical — no duplication.
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
  try {
    await sendListMessage({
      to: user.phone,
      body: 'חריגים ודיווחים — בחר:',
      buttonLabel: 'בחר',
      sections: [{
        rows: [
          { id: 'MGR_EXC_1', title: 'חריגים פתוחים' },
          { id: 'MGR_EXC_2', title: 'משימות לא אושרו' },
          { id: 'MGR_EXC_3', title: 'משימות עם בעיה' },
          { id: 'MGR_EXC_4', title: 'ממתינות למידע' },
          { id: 'MGR_EXC_5', title: 'לא סגרו יום' },
          { id: 'MGR_EXC_6', title: 'חזרה' },
        ],
      }],
    });
  } catch (err) {
    log.warn({ err }, 'sendListMessage failed for mgr_exceptions_sub — falling back to text');
    await sendTextMessage({ to: user.phone, text: renderMgrExceptionsSub() });
  }
}

async function handleMgrExceptionsSubReply(user: ResolvedUser, trimmed: string): Promise<void> {
  // Resolve MGR_EXC_N list-tap to digit.
  const resolved = /^MGR_EXC_(\d+)$/i.test(trimmed)
    ? trimmed.replace(/^MGR_EXC_/i, '')
    : trimmed;
  const idx = parseInt(resolved, 10);
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
  try {
    await sendListMessage({
      to: user.phone,
      body: 'לידים ממתינים לטיפול — בחר:',
      buttonLabel: 'בחר',
      sections: [{
        rows: [
          { id: 'MGR_LEADS_1', title: 'לידים לא משויכים' },
          { id: 'MGR_LEADS_2', title: 'לידים שעברו שעה ללא שיוך' },
          { id: 'MGR_LEADS_3', title: 'שיוך ליד לעובד' },
          { id: 'MGR_LEADS_4', title: 'חזרה' },
        ],
      }],
    });
  } catch (err) {
    log.warn({ err }, 'sendListMessage failed for mgr_leads_sub — falling back to text');
    await sendTextMessage({ to: user.phone, text: renderMgrLeadsSub() });
  }
}

async function handleMgrLeadsSubReply(user: ResolvedUser, trimmed: string): Promise<void> {
  // Resolve MGR_LEADS_N list-tap to digit.
  const resolved = /^MGR_LEADS_(\d+)$/i.test(trimmed)
    ? trimmed.replace(/^MGR_LEADS_/i, '')
    : trimmed;
  const idx = parseInt(resolved, 10);
  if (idx === 4 || /^חזרה$/.test(trimmed)) {
    await showMenu(user);
    return;
  }

  if (idx === 3) {
    // Assign lead — requires canAssignLeads (D5-T19i: isLeadsViewer OR isElevated)
    if (!canAssignLeads(user)) {
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
    const enrichments = await Promise.all(leads.map(enrichLead));
    const lines = leads.map((l, i) => `${i + 1}.\n${formatLeadListRowCompact(l, enrichments[i])}`);
    await setContext(user.phone, {
      awaiting: 'mgr_leads_pick_row',
      mgrLeadIds: leads.map((l) => l.id),
      mgrLeadNames: leads.map((l) => l.fromName ?? '—'),
    });
    await sendChunked(user.phone, `לידים ממתינים לטיפול (${leads.length}):\n\n${lines.join('\n\n')}\n\nבחר מספר לפרטים, או "חזרה".`);
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
    const enrichments = await Promise.all(leads.map(enrichLead));
    const lines = leads.map((l, i) => `${i + 1}.\n${formatLeadListRowCompact(l, enrichments[i])}`);
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
  const idx = parseInt(trimmed, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > ids.length) {
    await sendTextMessage({ to: user.phone, text: `אנא השב במספר בין 1 ל-${ids.length} או "חזרה".` });
    return;
  }
  const leadId = ids[idx - 1];
  // Fetch and display the lead detail.
  const lead = await getLeadById(leadId);
  if (!lead) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'לא נמצא ליד. נסה שוב.' });
    return;
  }
  const enrichment = await enrichLead(lead);
  const detailText = formatLeadDetailCompact(lead, enrichment);
  // Keep state in mgr_leads_pick_row so "חזרה" resends the sub-menu and
  // typing another number re-picks a lead from the same list.
  await setContext(user.phone, {
    awaiting: 'mgr_leads_pick_row',
    mgrLeadIds: ctx.mgrLeadIds,
    mgrLeadNames: ctx.mgrLeadNames,
  });
  await sendTextMessage({ to: user.phone, text: detailText });
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
  try {
    await sendListMessage({
      to: user.phone,
      body: 'עובדים וסיכומי יום — בחר:',
      buttonLabel: 'בחר',
      sections: [{
        rows: [
          { id: 'MGR_WRK_1', title: 'סיכום יום — כל העובדים' },
          { id: 'MGR_WRK_2', title: 'בחר עובד לסיכום שלו' },
          { id: 'MGR_WRK_3', title: 'חזרה' },
        ],
      }],
    });
  } catch (err) {
    log.warn({ err }, 'sendListMessage failed for mgr_workers_sub — falling back to text');
    await sendTextMessage({ to: user.phone, text: renderMgrWorkersSub() });
  }
}

async function handleMgrWorkersSubReply(
  user: ResolvedUser,
  trimmed: string,
  _ctx: ConversationState,
): Promise<void> {
  // Resolve MGR_WRK_N list-tap to digit.
  const resolved = /^MGR_WRK_(\d+)$/i.test(trimmed)
    ? trimmed.replace(/^MGR_WRK_/i, '')
    : trimmed;
  const idx = parseInt(resolved, 10);
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
  try {
    await sendListMessage({
      to: user.phone,
      body: 'מה לחפש?',
      buttonLabel: 'בחר',
      sections: [{
        rows: [
          { id: 'MGR_SRC_1', title: 'לפי לקוח' },
          { id: 'MGR_SRC_2', title: 'לפי עובד' },
          { id: 'MGR_SRC_3', title: 'לפי מק"ט' },
          { id: 'MGR_SRC_4', title: 'חזרה' },
        ],
      }],
    });
  } catch (err) {
    log.warn({ err }, 'sendListMessage failed for mgr_search_sub — falling back to text');
    await sendTextMessage({ to: user.phone, text: renderMgrSearchSub() });
  }
}

async function handleMgrSearchSubReply(user: ResolvedUser, trimmed: string): Promise<void> {
  // Resolve MGR_SRC_N list-tap to digit.
  const resolved = /^MGR_SRC_(\d+)$/i.test(trimmed)
    ? trimmed.replace(/^MGR_SRC_/i, '')
    : trimmed;
  const idx = parseInt(resolved, 10);
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
    results = await searchTasksByCustomerName(searchQuery);
  } else if (kind === 'worker') {
    results = await searchTasksByWorkerName(searchQuery);
  } else if (kind === 'product') {
    results = await searchTasksByProductCode(searchQuery);
  }

  if (results.length === 0) {
    await setContext(user.phone, { awaiting: 'mgr_search_await_query', mgrSearchKind: kind });
    // Same distinction as the free-text search path: person exists but has no
    // field inspections vs. no such person. See the `search_task` handler.
    if (kind === 'worker') {
      const matchingUsers = await findUsersByName(searchQuery);
      if (matchingUsers.length === 1) {
        await sendTextMessage({ to: user.phone, text: `${matchingUsers[0].name} קיים במערכת, אך אין לו בדיקות שטח משובצות. נסה שם אחר או "חזרה".` });
        return;
      }
      if (matchingUsers.length > 1) {
        const list = matchingUsers.map((u) => `"${u.name}"`).join(', ');
        await sendTextMessage({ to: user.phone, text: `נמצאו ${matchingUsers.length} עובדים תואמים (${list}), אך לאף אחד מהם אין בדיקות שטח משובצות. נסה שם אחר או "חזרה".` });
        return;
      }
      await sendTextMessage({ to: user.phone, text: `לא נמצא עובד בשם "${searchQuery}". נסה שם אחר או "חזרה".` });
      return;
    }
    if (kind === 'customer') {
      const matchingCustomers = await findCustomersByName(searchQuery, 10);
      if (matchingCustomers.length === 1) {
        await sendTextMessage({ to: user.phone, text: `${matchingCustomers[0].name} קיים במערכת, אך אין לו בדיקות שטח משובצות. נסה שם אחר או "חזרה".` });
        return;
      }
      if (matchingCustomers.length > 1) {
        const list = matchingCustomers.map((c) => `"${c.name}"`).join(', ');
        await sendTextMessage({ to: user.phone, text: `נמצאו ${matchingCustomers.length} לקוחות תואמים (${list}), אך לאף אחד מהם אין בדיקות שטח משובצות. נסה שם אחר או "חזרה".` });
        return;
      }
      await sendTextMessage({ to: user.phone, text: `לא נמצא לקוח בשם "${searchQuery}". נסה שם אחר או "חזרה".` });
      return;
    }
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
    const detailWamid = await sendTextMessage({ to: user.phone, text: detailBody.trim() });
    // Phase 2: record the detail card as a task_field ref so a swipe-reply on
    // it (with "יצאתי"/"הגעתי"/"סיימתי") resolves back to THIS TaskField,
    // deterministically, before the AI runs. Best-effort; never throws.
    await recordTaskFieldRef(detailWamid, taskFieldId, user.id, 'detail_view');
    await sendListMessage({
      to: user.phone,
      body: 'מה תרצה לעשות?',
      buttonLabel: 'בחר פעולה',
      sections: MGR_ACTION_LIST_SECTIONS,
    });
  } catch (err) {
    log.warn({ err }, 'sendListMessage failed for action prompt — falling back to text');
    const fallbackWamid = await sendTextMessage({
      to: user.phone,
      text: `${detailBody.trim()}\n\nמה תרצה לעשות?\n${MGR_TASK_INLINE_ACTIONS}`,
    });
    await recordTaskFieldRef(fallbackWamid, taskFieldId, user.id, 'detail_view');
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
 * D5-T16 — Universal AI-first pivot detector for TEXT-CAPTURE / non-numeric
 * awaiting states (missing_info_note, equipment_missing_note, decline_reason,
 * schedule/correction value prompts, notes fields, etc.).
 *
 * Runs `parseIntent` and, when the LLM returns a HIGH-confidence top-level
 * intent from the curated allow-list below, clears the current context and
 * dispatches through the fresh AI path — letting the user pivot mid-flow
 * without needing to type "ביטול" first. Returns `true` when the pivot was
 * consumed (caller must not run the state's own capture handler).
 *
 * The allow-list is narrow ON PURPOSE. It only includes intents that a user
 * could not plausibly be typing as an ANSWER to any current capture prompt:
 *   - open_manager_menu — "תפריט" (already caught by MENU_TRIGGER_RE, kept
 *     here for completeness / voice-transcribed variants).
 *   - management_snapshot / list_today_field_inspections /
 *     list_open_exceptions / list_pending_leads / workers_day_overview /
 *     search_task — top-level manager dashboards. A worker capturing "טופס
 *     דגימה" as their missing-info note would never accidentally match these.
 *   - list_my_inspections — "הבדיקות שלי היום".
 *   - set_field_status with an explicit transition (DEPARTED / ARRIVED /
 *     FINISHED) — the classic pivot ("יצאתי" / "הגעתי" / "סיימתי").
 *   - report_problem with a decisive problem_type — a clear worker pivot.
 *   - schedule_task_field / assign_lead — top-level office actions.
 *
 * Notes-esque intents (report_missing_info, set_field_status without a
 * transition, help, unknown) are DELIBERATELY excluded because they overlap
 * with legitimate capture data. The confidence threshold is 0.85 (the
 * router's `CONF_HIGH`) so borderline phrasings stay in the capture.
 */
async function tryPivotToAIIntent(
  user: ResolvedUser,
  text: string,
  ctx: ConversationState,
): Promise<boolean> {
  if (!getProvider()) return false;

  // Cheap guard: obviously very short "answer" tokens (single word ≤6 chars)
  // are almost never a top-level intent — skip the AI call to keep capture
  // latency low.
  const trimmed = text.trim();
  if (trimmed.length <= 6 && !/\s/.test(trimmed)) return false;

  let intent: AIIntentResult | undefined;
  try {
    const [allowedTypes, allowedPriorities, history] = await Promise.all([
      getAllowedTaskTypes(),
      safePriorities(),
      getHistory(user.phone),
    ]);
    intent = await parseIntent(text, { user, allowedTypes, allowedPriorities, history });
  } catch {
    // parseIntent may transiently fail (no provider, network, etc.). We do
    // NOT log here because this path fires on EVERY text-capture message —
    // logging every miss would flood stderr. Silently fall back to the
    // capture-state handler.
    return false;
  }

  if (!intent || typeof intent.confidence !== 'number') return false;
  if (intent.confidence < CONF_HIGH) return false;

  const PIVOT_INTENTS: readonly string[] = [
    'open_manager_menu',
    'management_snapshot',
    'list_today_field_inspections',
    'list_open_exceptions',
    'list_pending_leads',
    'workers_day_overview',
    'search_task',
    'list_my_inspections',
    'schedule_task_field',
    'assign_lead',
  ];
  const isTopLevelPivot = PIVOT_INTENTS.includes(intent.intent);
  const isStatusPivot =
    intent.intent === 'set_field_status' &&
    (intent.transition === 'CONFIRM' ||
     intent.transition === 'DEPARTED' ||
     intent.transition === 'ARRIVED' ||
     intent.transition === 'FINISHED');
  // D5-T19b: while the worker is elaborating a problem type they ALREADY
  // picked explicitly from the numbered sub-menu (problem_type_note), their
  // reply can never legitimately be a "new" report_problem — it's the note
  // for the problem they're already mid-report on. Without this guard, an
  // elaboration note that itself describes a problem (extremely common —
  // that's the whole point of the note) gets high-confidence classified as
  // report_problem by the AI, silently discarding the explicitly-chosen
  // PROFESSIONAL_ISSUE/OTHER type and the note text itself (see TASKS.md
  // D5-T19b). Genuine escapes (menu, "my inspections", status changes) are
  // untouched — only this one narrow, always-false-positive case is excluded.
  const isProblemPivot =
    intent.intent === 'report_problem' &&
    intent.problem_type !== null &&
    ctx.awaiting !== 'problem_type_note';

  if (!isTopLevelPivot && !isStatusPivot && !isProblemPivot) return false;

  log.info(
    { fromState: ctx.awaiting, toIntent: intent.intent, confidence: intent.confidence },
    'tryPivotToAIIntent: user pivoted mid-flow — clearing capture and dispatching',
  );
  await clearContext(user.phone);
  // We already parsed the intent — don't re-parse. Skip the entry-point
  // guards and route the parsed intent directly through `routeIntent`.
  await appendTurn(user.phone, 'user', text);
  await routeIntent(user, intent, text);
  return true;
}

/**
 * D5-T15 — worker-intent inline dispatcher used INSIDE the detail-view
 * (`mgr_*_action` states) BEFORE the correction/reassign extractor runs.
 *
 * The user is viewing a specific TaskField (its id is passed in). If they
 * typed a worker-style intent — `set_field_status` (DEPARTED/ARRIVED/FINISHED/
 * WAITING_FOR_INFO/HAS_PROBLEM), `report_problem`, or `report_missing_info` —
 * we execute it against the currently-viewed TaskField (no disambig needed —
 * we already know which one). Returns `true` when consumed; `false` means the
 * caller should fall through to `extractInspectionActions` for
 * corrections/reassign/reschedule.
 *
 * Rationale (per the product owner): worker free-text intents must be
 * understood in ANY state, not just top-level. This eliminates the
 * "לא זוהתה פעולה ברורה" trap when a user types "יצאתי" from a detail view.
 */
/**
 * Keyword fast-path for the 4 unambiguous worker-transition phrasings, run
 * BEFORE the LLM in the detail-view context. Bypasses LLM misclassifications
 * of phrases like "שנה סטטוס ל יצאתי" (which the intent parser sometimes
 * routes to a non-worker intent with clarification="לא ציינת לאיזו משימה...",
 * even though the taskFieldId is clearly known from context).
 *
 * Only matches strong, unambiguous verbs — "יצאתי", "הגעתי", "סיימתי",
 * "אישרתי" — with negation guards ("לא יצאתי", "עוד לא הגעתי"). Ambiguous
 * transitions (WAITING_FOR_INFO / HAS_PROBLEM) are intentionally NOT matched
 * here — they need the LLM to extract the associated note / problem_type.
 */
function extractDirectStatusKeyword(
  text: string,
): 'CONFIRM' | 'DEPARTED' | 'ARRIVED' | 'FINISHED' | null {
  const t = text.trim();
  const matches = (positives: string[], negations: string[]): boolean => {
    for (const neg of negations) if (t.includes(neg)) return false;
    return positives.some((p) => t.includes(p));
  };
  if (matches(['יצאתי', 'יוצא לדרך', 'יוצא בזמן'], ['לא יצאתי', 'עוד לא יצאתי'])) return 'DEPARTED';
  if (matches(['הגעתי', 'הגענו לאתר'],             ['לא הגעתי', 'עוד לא הגעתי'])) return 'ARRIVED';
  if (matches(['סיימתי', 'סיימנו את הבדיקה'],       ['לא סיימתי', 'עוד לא סיימתי'])) return 'FINISHED';
  if (matches(['אישרתי', 'מאשר את', 'אושר לי'],    ['לא אישרתי', 'לא אושר'])) return 'CONFIRM';
  return null;
}

async function tryDispatchWorkerIntentInline(
  user: ResolvedUser,
  text: string,
  taskFieldId: string,
): Promise<boolean> {
  // Fast-path: unambiguous worker-transition keyword in the raw text — dispatch
  // directly on the currently-viewed TaskField. Fixes the case where the LLM
  // misclassifies phrases like "שנה סטטוס ל יצאתי" as a non-worker intent and
  // asks for task disambiguation even though the target is obvious from context.
  const keywordTransition = extractDirectStatusKeyword(text);
  if (keywordTransition) {
    await performTransition(user, taskFieldId, keywordTransition);
    return true;
  }

  if (!getProvider()) return false;
  let intent: AIIntentResult;
  try {
    const [allowedTypes, allowedPriorities, history] = await Promise.all([
      getAllowedTaskTypes(),
      safePriorities(),
      getHistory(user.phone),
    ]);
    intent = await parseIntent(text, { user, allowedTypes, allowedPriorities, history });
  } catch (err) {
    log.warn({ err }, 'tryDispatchWorkerIntentInline: parseIntent failed — falling back to extractor');
    return false;
  }

  // D5-T15 policy — AI-driven, not regex. Inside the detail view we bias
  // heavily toward the worker intent path. The LLM knows the user's intent
  // even for vague phrases; when it's uncertain it must return a clarification
  // and we surface it, letting the AI drive the conversation. We only give up
  // on the worker path when the LLM confidence is very low (<0.4).
  const CONF_WORKER_INLINE = 0.4;
  if (intent.confidence < CONF_WORKER_INLINE) return false;

  // Helper: surface an LLM clarification when the intent is recognized but a
  // required sub-field (transition / problem_type / note) is missing.
  const showAIClarification = async (defaultMsg: string): Promise<void> => {
    const msg = (intent.clarification && intent.clarification.trim().length > 0)
      ? intent.clarification.trim()
      : defaultMsg;
    // Keep the awaiting state so the user's next reply lands back in
    // handleMgrActionFreeText with the same TaskField context.
    await setContext(user.phone, {
      awaiting: 'mgr_today_action',
      mgrSelectedTaskFieldId: taskFieldId,
      mgrSelectedTaskId: intent.task_reference ?? undefined,
    });
    await sendTextMessage({ to: user.phone, text: msg });
  };

  // set_field_status — DEPARTED/ARRIVED/FINISHED are direct; WAITING_FOR_INFO
  // and HAS_PROBLEM open the note / problem-type prompt on the current TF.
  if (intent.intent === 'set_field_status') {
    const transition = intent.transition ?? null;
    if (transition === 'CONFIRM' || transition === 'DEPARTED' || transition === 'ARRIVED' || transition === 'FINISHED') {
      await performTransition(user, taskFieldId, transition);
      return true;
    }
    // No specific transition named. AI-first policy: prefer the LLM's own
    // clarification ("לאיזה סטטוס לעדכן?"). If the LLM didn't provide one,
    // fall back to a helpful default that names the three options.
    if (transition === null) {
      await showAIClarification(
        'לאיזה סטטוס לעדכן את הבדיקה? כתוב "יצאתי", "הגעתי", או "סיימתי".',
      );
      return true;
    }
    if (transition === 'WAITING_FOR_INFO') {
      const note = typeof intent.params?.note === 'string' ? intent.params.note.trim() : '';
      if (note) {
        await writeMissingInfo({ taskFieldId, note, updatedBy: user.id });
        const sent = await notifyOfficeMissingInfo(taskFieldId);
        await clearContext(user.phone);
        await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'office') });
      } else {
        await setContext(user.phone, { awaiting: 'missing_info_note', taskFieldId });
        await sendTextMessage({ to: user.phone, text: 'מה חסר לדוח?' });
      }
      return true;
    }
    if (transition === 'HAS_PROBLEM') {
      const problemType = intent.problem_type ?? null;
      const note = typeof intent.params?.note === 'string' ? intent.params.note.trim() : '';
      if (problemType) {
        await writeProblem({ taskFieldId, problemType, note: note || null, updatedBy: user.id });
        const sent = await notifyOfficeProblem(taskFieldId);
        await clearContext(user.phone);
        await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'manager') });
      } else {
        await setContext(user.phone, { awaiting: 'problem_type_choice', taskFieldId });
        await sendProblemTypeMenu(user.phone);
      }
      return true;
    }
  }

  // report_problem — direct write against the current TF; if no problem_type,
  // open the 7-item sub-menu on the current TF.
  if (intent.intent === 'report_problem') {
    const problemType = intent.problem_type ?? null;
    const note = typeof intent.params?.note === 'string' ? intent.params.note.trim() : '';
    if (problemType) {
      await writeProblem({ taskFieldId, problemType, note: note || null, updatedBy: user.id });
      const sent = await notifyOfficeProblem(taskFieldId);
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'manager') });
    } else {
      await setContext(user.phone, { awaiting: 'problem_type_choice', taskFieldId });
      await sendProblemTypeMenu(user.phone);
    }
    return true;
  }

  // report_missing_info — direct write against the current TF.
  if (intent.intent === 'report_missing_info') {
    const note = typeof intent.params?.note === 'string' ? intent.params.note.trim() : '';
    if (note) {
      await writeMissingInfo({ taskFieldId, note, updatedBy: user.id });
      const sent = await notifyOfficeMissingInfo(taskFieldId);
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: officeNotifiedText(sent, 'office') });
    } else {
      await setContext(user.phone, { awaiting: 'missing_info_note', taskFieldId });
      await sendTextMessage({ to: user.phone, text: 'מה חסר לדוח?' });
    }
    return true;
  }

  return false;
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
  // Nav-word fast path — before hitting the AI. The user might type "תפריט" /
  // "menu" / "היי" / "שלום" while browsing details expecting to jump back to
  // the main menu; and "חזרה" / "אחורה" to step back. Handle these locally so
  // we never bother the LLM with them.
  const trimmedNav = text.trim();
  if (MENU_TRIGGER_RE.test(trimmedNav)) {
    await showMenu(user);
    return;
  }
  if (/^(חזרה|אחורה|back|למעלה)$/i.test(trimmedNav)) {
    await showMenu(user);
    return;
  }

  // ── D5-T15: worker-intent short-circuit inside the detail view ────────────
  // Before invoking the correction/reassign extractor, run the general AI
  // intent parser. If the user typed a WORKER intent ("יצאתי", "הגעתי",
  // "סיימתי", "הלקוח לא ענה", "חסר לי X"), dispatch it directly against the
  // currently-viewed TaskField without disambiguation. This makes free-text
  // status updates work in ANY state, matching the user's expectation that
  // the AI understands intent everywhere, not just at menu top-level.
  const workerIntentConsumed = await tryDispatchWorkerIntentInline(user, text, taskFieldId);
  if (workerIntentConsumed) return;

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
        // QA-FIX-3: expose the current scheduled time to the LLM so a
        // time-only reschedule ("עדכן שעה ל-21:00") can default the date.
        currentScheduledStartAtIL: snapshot.scheduledStartAt
          ? formatScheduledStartForPrompt(snapshot.scheduledStartAt)
          : null,
        currentDurationMinutes: snapshot.durationMinutes,
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
    // D5-T15 (AI-first): if the correction extractor rejected the message,
    // give the LLM a second chance to interpret it as a WORKER intent
    // (set_field_status / report_problem / report_missing_info) — the same
    // path used in `tryDispatchWorkerIntentInline`. The extractor is
    // intentionally narrow (only corrections); the general parser is
    // broader.
    const consumedAsWorkerIntent = await tryDispatchWorkerIntentInline(user, text, taskFieldId);
    if (consumedAsWorkerIntent) return;

    // Fully unrecognized — surface the extractor's clarification (which is
    // often descriptive of what the user meant, e.g. "ההודעה מתייחסת לשינוי
    // סטטוס"). Keep the action state alive so the user can rephrase.
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
  // QA-FIX-4.b: any LLM-inferred field on a destructive action must be
  // confirmed by the user before it's written. Explicit-only actions still
  // execute immediately (fast path preserved).
  if (actions.length === 1) {
    const only = actions[0];
    const inferred = only.inferredFields ?? [];
    const isDestructive =
      only.action === 'correct_site' || only.action === 'correct_type' ||
      only.action === 'reassign'     || only.action === 'reschedule';
    if (inferred.length > 0 && isDestructive) {
      await promptSingleActionConfirmation(user, ctx, taskFieldId, taskId, only, confidence);
      return;
    }
    await dispatchSingleAction(user, ctx, taskFieldId, taskId, only, confidence, clarification);
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
    } else if (act.action === 'reschedule') {
      if (act.newScheduledStartAt) {
        const d = new Date(act.newScheduledStartAt);
        if (!isNaN(d.getTime())) {
          const durNote = act.newDurationMinutes ? ` (${act.newDurationMinutes} דק')` : '';
          lines.push(`תאריך ושעה → ${formatShortDateTimeIL(d)}${durNote}`);
        } else {
          lines.push(`תאריך ושעה → ${act.newScheduledStartAt}`);
        }
      } else {
        lines.push('תאריך ושעה → (לא צוין)');
      }
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
 * QA-FIX-4.b: Hebrew labels for the raw inferred-field property names
 * returned by extractInspectionActions. Used to explain to the user WHICH
 * fields the LLM filled in from context (as opposed to explicit user text).
 */
const HEB_INFERRED_LABEL: Record<string, string> = {
  newScheduledStartAt: 'תאריך ושעה',
  newDurationMinutes: 'משך',
  newSiteAddress: 'כתובת האתר',
  newSiteCity: 'עיר',
  newContactName: 'שם איש קשר',
  newContactPhone: 'טלפון איש קשר',
  newInspectionTypeQuery: 'סוג בדיקה',
  newWorkerName: 'עובד',
};

/**
 * QA-FIX-4.b: prompt the user to confirm a single AI-extracted action when
 * the LLM inferred one or more fields from context (rather than the user
 * explicitly stating them). Reuses the existing `mgr_multi_action_confirm`
 * state with a 1-element `pendingMultiActions` array so the existing confirm
 * handler executes the action unchanged on "אישור".
 */
async function promptSingleActionConfirmation(
  user: ResolvedUser,
  ctx: ConversationState,
  taskFieldId: string,
  taskId: string,
  act: NonNullable<ConversationState['pendingMultiActions']>[number],
  confidence: number,
): Promise<void> {
  void ctx; // reserved — the confirm state is fully rebuilt below.
  void confidence; // signalled to caller but not shown in the single-action prompt.

  // ── One-line summary of the planned change ────────────────────────────────
  let summary = '';
  if (act.action === 'reschedule') {
    if (act.newScheduledStartAt) {
      const d = new Date(act.newScheduledStartAt);
      const durNote = act.newDurationMinutes ? ` (${act.newDurationMinutes} דק')` : '';
      if (!isNaN(d.getTime())) {
        summary = `תאריך ושעה → ${formatShortDateTimeIL(d)}${durNote}`;
      } else {
        summary = `תאריך ושעה → ${act.newScheduledStartAt}${durNote}`;
      }
    } else {
      summary = 'תאריך ושעה → (לא צוין)';
    }
  } else if (act.action === 'correct_site') {
    const parts: string[] = [];
    if (act.newSiteAddress)  parts.push(`כתובת → ${act.newSiteAddress}`);
    if (act.newSiteCity)     parts.push(`עיר → ${act.newSiteCity}`);
    if (act.newContactName)  parts.push(`שם איש קשר → ${act.newContactName}`);
    if (act.newContactPhone) parts.push(`טלפון איש קשר → ${act.newContactPhone}`);
    summary = parts.join(', ');
  } else if (act.action === 'correct_type') {
    summary = `סוג בדיקה → ${act.newInspectionTypeQuery ?? '(לא צוין)'}`;
  } else if (act.action === 'reassign') {
    summary = `עובד → ${act.newWorkerName ?? '(לא צוין)'}`;
  }

  const inferred = act.inferredFields ?? [];
  const inferredLabels = inferred.map((k) => HEB_INFERRED_LABEL[k] ?? k);

  const confirmBody =
    `הבנתי — נקבע:\n\n${summary}\n\n` +
    `השלמתי מההקשר: ${inferredLabels.join(', ')}\n` +
    `אישור לביצוע?`;

  await setContext(user.phone, {
    awaiting: 'mgr_multi_action_confirm',
    mgrSelectedTaskFieldId: taskFieldId,
    mgrSelectedTaskId: taskId,
    pendingMultiActions: [act],
  });

  // Buttons preferred; fall back to text prompt on send failure (mirror of the
  // pattern used elsewhere in this file for confirm-state prompts).
  try {
    await sendButtonMessage({
      to: user.phone,
      body: confirmBody,
      buttons: [
        { id: CONFIRM_YES_MULTI, title: 'אישור' },
        { id: CONFIRM_NO_MULTI,  title: 'ביטול' },
      ],
    });
  } catch (err) {
    log.warn({ err }, 'sendButtonMessage failed for single-action inferred confirm — falling back to text');
    await sendTextMessage({
      to: user.phone,
      text: `${confirmBody}\nהשב 'כן' לאישור או 'לא' לביטול.`,
    });
  }
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

  if (action === 'reschedule') {
    // Auth: MANAGER/ADMIN only.
    if (!user.isElevated) {
      await setContext(user.phone, {
        awaiting: ctx.awaiting,
        mgrSelectedTaskFieldId: taskFieldId,
        mgrSelectedTaskId: taskId,
      });
      await sendTextMessage({
        to: user.phone,
        text: 'אין הרשאה — רק מנהל יכול להזיז זמן בדיקה.\n\n' + MGR_TASK_INLINE_ACTIONS,
      });
      return;
    }

    const isoStr = item.newScheduledStartAt?.trim() ?? null;
    if (!isoStr) {
      await setContext(user.phone, {
        awaiting: ctx.awaiting,
        mgrSelectedTaskFieldId: taskFieldId,
        mgrSelectedTaskId: taskId,
      });
      await sendTextMessage({
        to: user.phone,
        text: 'לא הצלחתי לזהות את התאריך והשעה. נסה שוב: "תזמן מחדש ל-11/7 בשעה 14:00".',
      });
      return;
    }

    const newStart = new Date(isoStr);
    if (isNaN(newStart.getTime())) {
      await setContext(user.phone, {
        awaiting: ctx.awaiting,
        mgrSelectedTaskFieldId: taskFieldId,
        mgrSelectedTaskId: taskId,
      });
      await sendTextMessage({
        to: user.phone,
        text: `תאריך לא תקין: "${isoStr}". נסה שוב.`,
      });
      return;
    }

    try {
      await updateTaskFieldSchedule(taskFieldId, user.id, {
        scheduledStartAt: newStart,
        durationMinutes: item.newDurationMinutes,
      });
      await clearContext(user.phone);
      await sendTextMessage({
        to: user.phone,
        text: `עודכן — תאריך ושעה: ${formatShortDateTimeIL(newStart)}`,
      });
    } catch (err) {
      const errMsg = err instanceof ClosedInspectionError
        ? 'לא ניתן לקבוע מחדש בדיקה שהסתיימה או בוטלה.'
        : 'שגיאה בעדכון תזמון. נסה שוב.';
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: errMsg });
    }
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

    } else if (act.action === 'reschedule') {
      const isoStr = act.newScheduledStartAt?.trim() ?? '';
      const label = `תאריך ושעה${isoStr ? ': ' + isoStr : ''}`;
      if (!user.isElevated) {
        results.push({ label, ok: false, note: 'אין הרשאה — רק מנהל יכול להזיז זמן בדיקה' });
        continue;
      }
      if (!isoStr) {
        results.push({ label: 'תאריך ושעה', ok: false, note: 'לא צוין תאריך' });
        continue;
      }
      const newStart = new Date(isoStr);
      if (isNaN(newStart.getTime())) {
        results.push({ label, ok: false, note: `תאריך לא תקין: "${isoStr}"` });
        continue;
      }
      try {
        await updateTaskFieldSchedule(taskFieldId, user.id, {
          scheduledStartAt: newStart,
          durationMinutes: act.newDurationMinutes,
        });
        results.push({ label: `תאריך ושעה: ${formatShortDateTimeIL(newStart)}`, ok: true });
      } catch (err) {
        const errMsg = err instanceof ClosedInspectionError
          ? 'לא ניתן לקבוע מחדש בדיקה שהסתיימה או בוטלה'
          : 'שגיאה בעדכון תזמון';
        log.error({ err }, 'multi-action: updateTaskFieldSchedule failed');
        results.push({ label, ok: false, note: errMsg });
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
