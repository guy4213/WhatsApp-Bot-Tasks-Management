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
  getContext, setContext, clearContext, type ConversationState,
} from '../services/conversationContext';
import { setViewOwners, getViewOwners, clearViewOwners } from '../services/viewContext';
import { setActiveTask, getActiveTask } from '../services/taskContext';
import { getHistory, appendTurn } from '../services/chatHistory';
import {
  listTasks, getTaskById, getAllowedTaskTypes, getAllowedPriorities, getTeamWorkload, findUsersByName,
  findCustomersByName, findLeadsByName, findProjectsByName,
} from '../services/tasks';
import { getLatestPendingForUser, getPendingApprovals } from '../services/pendingActions';
import { dispatchInternal } from '../utils/internalApi';
import { sendTextMessage } from '../whatsapp/sender';
import { writeAuditLog } from '../utils/auditLog';
import { moduleLogger } from '../utils/logger';
import {
  MENU_TRIGGER_RE, menuItemsFor, renderMenu, type MenuRoute,
  problemTypeMenu, renderProblemTypeMenu,
  statusUpdateMenu, renderStatusUpdateMenu,
  finishedFollowUpMenu, renderFinishedFollowUpMenu,
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
  type AdvanceTransition,
} from '../services/inspections';
import {
  matchDigestCommand, planDigestCommand, type DigestCommand,
} from './digestCommands';
import {
  getEffectiveDigestPreference, upsertDigestPreference, parseTimeInput,
  type DigestPreference,
} from '../services/digestPreferences';
import { getEmployeeEndOfDay, getCompanyEndOfDay } from '../services/tasks';
import { formatEmployeeEndOfDay, formatManagerEndOfDay } from '../whatsapp/digestContent';

const log = moduleLogger('ai-router');

const CONF_HIGH = parseFloat(process.env.AI_CONFIDENCE_HIGH ?? '0.85');
const CONF_LOW  = parseFloat(process.env.AI_CONFIDENCE_LOW  ?? '0.60');

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

  await routeIntent(user, intent);
}

// ── Threshold routing ──────────────────────────────────────────────────────────

async function routeIntent(user: ResolvedUser, intent: AIIntentResult): Promise<void> {
  // 0. Approval/decline of a pending action — resolve to the user's latest pending
  //    action and act immediately (no confirm gate; this IS the confirmation).
  if (intent.intent === 'confirm_pending_action' || intent.intent === 'decline_pending_action') {
    await executeIntent(user, intent);
    return;
  }

  // 1. Unknown or very low confidence → use the model's Hebrew clarification when it
  //    provided one (status-change / out-of-scope answers), else ask to rephrase.
  //    Either way, record the event in the audit log.
  if (intent.intent === 'unknown' || intent.confidence < CONF_LOW) {
    await auditEvent(user, 'unknown', null, 'SKIPPED', intent.clarification ?? 'unrecognized request');
    await sendTextMessage({
      to: user.phone,
      text: intent.clarification
        ?? 'לא הצלחתי להבין את הבקשה. נסה לנסח מחדש, למשל: "צור משימה תיאום ללקוח X" או "הצג את המשימות שלי להיום".',
    });
    return;
  }

  // 2. Missing required info → ask for the first missing field.
  // But if the only thing missing is WHICH task, and the user just acted on one,
  // reuse that active task instead of asking again (resolveOrAsk picks it up).
  const TASK_TARGETING = new Set(['edit_field', 'edit_duedate', 'reassign_task', 'relink_task', 'get_task']);
  if (
    TASK_TARGETING.has(intent.intent) &&
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

  if (ctx.awaiting === 'read_confirm') {
    if (YES_RE.test(trimmed)) {
      await clearContext(user.phone);
      await runListTasks(user, resolveListQuery(user, ctxIntent));
    } else if (NO_RE.test(trimmed)) {
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'בוטל.' });
    } else {
      // Treat as a new request
      await clearContext(user.phone);
      await handleAIMessage(user, text);
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

  if (ctx.awaiting === 'owner_disambig' && ctx.candidateUserIds) {
    const idx = parseInt(trimmed, 10);
    if (!Number.isInteger(idx) || idx < 1 || idx > ctx.candidateUserIds.length) {
      await sendTextMessage({ to: user.phone, text: `אנא השב במספר בין 1 ל-${ctx.candidateUserIds.length}.` });
      return;
    }
    const intent = ctxIntent;
    intent.params.ownerId = ctx.candidateUserIds[idx - 1];
    intent.params._ownerResolved = true;   // concrete id now — skip re-resolution
    await clearContext(user.phone);
    await executeIntent(user, intent);
    return;
  }

  if (ctx.awaiting === 'link_disambig' && ctx.candidateLinkIds && ctx.linkField) {
    const idx = parseInt(trimmed, 10);
    if (!Number.isInteger(idx) || idx < 1 || idx > ctx.candidateLinkIds.length) {
      await sendTextMessage({ to: user.phone, text: `אנא השב במספר בין 1 ל-${ctx.candidateLinkIds.length}.` });
      return;
    }
    const intent = ctxIntent;
    intent.params[ctx.linkField] = ctx.candidateLinkIds[idx - 1];
    intent.params._linkResolved = true;    // concrete id now — skip re-resolution
    await clearContext(user.phone);
    await executeIntent(user, intent);
    return;
  }

  if (ctx.awaiting === 'create_date') {
    await clearContext(user.phone);
    const intent = ctxIntent;
    const title = String(intent.params.title ?? 'משימה');

    // Resolve the reply to an ISO date via the AI ("מחר"/"יום ראשון ב-3" → ISO).
    // If nothing date-like is found (e.g. "ללא תאריך"), create without a due date.
    try {
      const [allowedTypes, allowedPriorities] = await Promise.all([getAllowedTaskTypes(), safePriorities()]);
      const probe = await parseIntent(`צור משימה ${title} ל${trimmed}`, { user, allowedTypes, allowedPriorities });
      if (probe.intent === 'create_task' && typeof probe.params.dueDate === 'string') {
        intent.params.dueDate = probe.params.dueDate;
      }
    } catch (err) {
      log.error({ err }, 'create_date re-parse failed (creating without date)');
    }

    await executeIntent(user, intent); // _dateAsked already true → no re-ask loop
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
    case 'confirm_pending_action':
    case 'decline_pending_action': {
      const approve = intent.intent === 'confirm_pending_action';

      // Always act on the single MOST-RECENT pending action this user can resolve —
      // their own action awaiting confirmation, or (for managers) an employee request
      // awaiting approval. Latest wins; older ones are ignored. No "which one?" prompts.
      const own = await getLatestPendingForUser(user.id);
      const approvals = user.isElevated ? await getPendingApprovals() : [];

      const candidates = [
        ...(own ? [{ kind: 'own' as const, action: own }] : []),
        ...approvals.map((a) => ({ kind: 'approval' as const, action: a })),
      ];
      if (candidates.length === 0) {
        await sendTextMessage({ to: user.phone, text: 'אין כרגע פעולה הממתינה לאישור.' });
        return;
      }

      candidates.sort(
        (a, b) => new Date(b.action.createdAt).getTime() - new Date(a.action.createdAt).getTime(),
      );
      const latest = candidates[0];

      if (latest.kind === 'own') {
        const decision = approve ? 'CONFIRM' : 'CANCEL';
        await dispatchInternal(user.phone, '/tasks/confirm', { pendingActionId: latest.action.id, decision }, 'POST');
      } else {
        const decision = approve ? 'APPROVE' : 'REJECT';
        await dispatchInternal(user.phone, '/tasks/approve', { pendingActionId: latest.action.id, decision }, 'POST');
      }
      return;
    }

    case 'help':
      await sendTextMessage({ to: user.phone, text: helpText() });
      return;

    case 'team_workload':
      await doTeamWorkload(user);
      return;

    case 'list_tasks':
      await doListTasks(user, intent);
      return;

    case 'get_task': {
      const id = await resolveOrAsk(user, intent, resolvedTaskId);
      if (!id) return;
      await doGetTask(user, id);
      return;
    }

    case 'create_task':
      // Creating a task asks for a date/time first when none was given. The user
      // can answer with a date, or explicitly opt out ("ללא תאריך").
      if (!intent.params.dueDate && !intent.params._dateAsked) {
        intent.params._dateAsked = true;
        await setContext(user.phone, { awaiting: 'create_date', intent });
        await sendTextMessage({
          to: user.phone,
          text: 'לאיזה תאריך ושעה לפתוח את המשימה? (אפשר לכתוב "ללא תאריך")',
        });
        return;
      }
      // Resolve a named assignee (params.ownerId) to a concrete user id, asking
      // the user to choose when several active employees match the name. Skips
      // when no assignee was named (defaults to the caller in POST /tasks).
      if (!(await resolveOwnerReference(user, intent))) return;
      await dispatchInternal(user.phone, '/tasks', buildCreateBody(intent), 'POST');
      return;

    case 'edit_field': {
      const id = await resolveOrAsk(user, intent, resolvedTaskId);
      if (!id) return;
      await dispatchInternal(user.phone, `/tasks/${id}/field`, { field: intent.field, value: intent.new_value }, 'PATCH');
      await noteWorkingTask(user.phone);
      return;
    }

    case 'edit_duedate': {
      const id = await resolveOrAsk(user, intent, resolvedTaskId);
      if (!id) return;
      await dispatchInternal(user.phone, `/tasks/${id}/field`, { field: 'dueDate', value: intent.new_value }, 'PATCH');
      await noteWorkingTask(user.phone);
      return;
    }

    case 'reassign_task': {
      // Carry the resolved task id through a possible owner-disambiguation
      // round-trip (re-entry calls executeIntent without resolvedTaskId).
      const id = await resolveOrAsk(user, intent, resolvedTaskId ?? (intent.params._taskId as string | undefined));
      if (!id) return;
      intent.params._taskId = id;
      // Resolve the target owner NAME → user id (with disambiguation); the ownerId
      // column is an FK, so a raw name would fail the update. Stops here (returns
      // false) when it has asked the user to pick among several matches.
      if (!(await resolveOwnerReference(user, intent))) return;
      await dispatchInternal(user.phone, `/tasks/${id}/field`, { field: 'ownerId', value: intent.params.ownerId }, 'PATCH');
      await noteWorkingTask(user.phone);
      return;
    }

    case 'relink_task': {
      // Carry the resolved task id through a possible link-disambiguation
      // round-trip (re-entry calls executeIntent without resolvedTaskId).
      const id = await resolveOrAsk(user, intent, resolvedTaskId ?? (intent.params._taskId as string | undefined));
      if (!id) return;
      intent.params._taskId = id;
      const linkField = (['customerId', 'leadId', 'projectId'] as const).find((f) => intent.params[f] !== undefined);
      if (!linkField) {
        await sendTextMessage({ to: user.phone, text: 'לא צוין לקוח/ליד/פרויקט לקישור.' });
        return;
      }
      // Resolve the target entity NAME → its id (with disambiguation); the link
      // columns are FKs, so a raw name would fail the update. Stops here (returns
      // false) when it has asked the user to pick among several matches.
      if (!(await resolveLinkReference(user, intent))) return;
      await dispatchInternal(user.phone, `/tasks/${id}/field`, { field: linkField, value: intent.params[linkField] }, 'PATCH');
      await noteWorkingTask(user.phone);
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

/**
 * Resolve a named-employee filter on intent.params.owners (one or more names) to
 * user ids stored back on intent.params.owner_ids/owner_names. Returns false when it
 * has already replied to the user (denied / not-found / ambiguous) and routing should stop.
 */
async function resolveOwnerFilter(user: ResolvedUser, intent: AIIntentResult): Promise<boolean> {
  const p = intent.params;
  if (Array.isArray(p.owner_ids)) return true; // already resolved (read_confirm re-entry)

  const raw = Array.isArray(p.owners) ? p.owners : typeof p.owner === 'string' ? [p.owner] : [];
  const refs = raw.map((s) => String(s).trim()).filter(Boolean);
  if (refs.length === 0) return true; // no employee filter requested

  // Viewing another employee's tasks is open to everyone (read-only). Writes stay
  // gated downstream (canEditTask / canCreateForOthers), so no role check here.

  const ids: string[] = [];
  const names: string[] = [];
  const notFound: string[] = [];
  let ambiguous: { ref: string; options: string[] } | null = null;

  for (const ref of refs) {
    const matches = await findUsersByName(ref);
    if (matches.length === 0) notFound.push(ref);
    else if (matches.length > 1 && !ambiguous) ambiguous = { ref, options: matches.map((m) => m.name) };
    else if (matches.length === 1) { ids.push(matches[0].id); names.push(matches[0].name); }
  }

  if (notFound.length > 0) {
    await sendTextMessage({ to: user.phone, text: `לא מצאתי עובד פעיל בשם: ${notFound.join(', ')}.` });
    return false;
  }
  if (ambiguous) {
    await sendTextMessage({
      to: user.phone,
      text: `נמצאו כמה עובדים בשם "${ambiguous.ref}":\n${ambiguous.options.map((n) => `• ${n}`).join('\n')}\nציין שם מלא יותר.`,
    });
    return false;
  }

  p.owner_ids = ids;
  p.owner_names = names;
  return true;
}

/** Resolve the AI params into a concrete, validated list query. */
function resolveListQuery(user: ResolvedUser, intent: AIIntentResult): ListQuery {
  const p = intent.params;
  const validFilters = ['today', 'this_week', 'open', 'next_deadline', 'overdue', 'unlinked', 'all'];
  const filterRaw = String(p.filter ?? 'all');
  const filter = (validFilters.includes(filterRaw) ? filterRaw : 'all') as ListQuery['filter'];

  // Scope: managers/admins default to TEAM-WIDE; own-only when they intentionally ask
  // ("שלי"). Non-elevated users are always own-scoped (the service re-clamps anyway).
  const rawScope = p.scope == null ? undefined : String(p.scope);
  const scope: 'own' | 'all' =
    rawScope === 'own' ? 'own'
    : rawScope === 'all' ? 'all'
    : user.isElevated ? 'all' : 'own';

  // Default to createdAt — only use dueDate when the user intentionally asked about deadlines.
  const dateField = String(p.date_field ?? 'createdAt') === 'dueDate' ? 'dueDate' : 'createdAt';

  const strOrUndef = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const dateFrom = strOrUndef(p.date_from);
  let dateTo = strOrUndef(p.date_to);
  if (dateFrom && !dateTo) dateTo = dateFrom; // single explicit day

  // Employee filter already resolved to ids (see doListTasks) — persists across a
  // read_confirm round-trip because it lives in intent.params.
  const ownerIds = Array.isArray(p.owner_ids) ? p.owner_ids.map(String) : undefined;
  const ownerNames = Array.isArray(p.owner_names) ? p.owner_names.map(String) : undefined;

  return { filter, scope, dateField, dateFrom, dateTo, ownerIds, ownerNames };
}

async function doListTasks(user: ResolvedUser, intent: AIIntentResult): Promise<void> {
  // Resolve a named-employee filter ("המשימות של יאיר ויורם") to user ids once,
  // baking them into intent.params so they survive a read_confirm round-trip.
  if (!(await resolveOwnerFilter(user, intent))) return;

  const q = resolveListQuery(user, intent);

  // Date-scoped reads: describe the action in plain Hebrew and wait for approval.
  if (q.dateFrom || q.dateTo) {
    await setContext(user.phone, { awaiting: 'read_confirm', intent });
    await sendTextMessage({ to: user.phone, text: `${describeListQuery(q)}\nלהציג? השב "כן" או "לא".` });
    return;
  }

  await runListTasks(user, q);
}

/** Actually fetch + render the list (called directly, or after read_confirm approval). */
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

/** Team workload view (manager/admin): open-task load per employee. */
async function doTeamWorkload(user: ResolvedUser): Promise<void> {
  if (!user.isElevated) {
    await auditEvent(user, 'team_workload', null, 'SKIPPED', 'not elevated');
    await sendTextMessage({ to: user.phone, text: 'התצוגה הזו זמינה למנהלים בלבד.' });
    return;
  }

  const rows = await getTeamWorkload();
  await auditEvent(user, 'team_workload', null, 'SUCCESS');

  if (rows.length === 0) {
    await sendTextMessage({ to: user.phone, text: 'אין כרגע משימות פתוחות לאף עובד.' });
    return;
  }

  const lines = rows.map((r) => {
    const flags: string[] = [];
    if (r.overdueCount)  flags.push(`⚠️ ${r.overdueCount} באיחור`);
    if (r.dueTodayCount) flags.push(`🔴 ${r.dueTodayCount} להיום`);
    const extra = flags.length ? ` (${flags.join(', ')})` : '';
    return `👤 ${r.ownerName}: ${r.openCount} פתוחות${extra}`;
  });

  await sendTextMessage({ to: user.phone, text: `📊 עומס משימות בצוות:\n${lines.join('\n')}` });
  await appendTurn(user.phone, 'assistant', `הצגתי עומס משימות בצוות (${rows.length} עובדים).`);
}

// ── Role-based numbered menu ────────────────────────────────────────────────────
// V1 is a numbered TEXT menu only (no WhatsApp interactive list messages). It is
// opened ONLY by an exact trigger word; all other free text still goes straight to
// the AI parser, so the existing NLU behavior is unchanged.

/** Open the role-based menu and remember that we're awaiting a numeric choice. */
async function showMenu(user: ResolvedUser): Promise<void> {
  await setContext(user.phone, { awaiting: 'menu' });
  await sendTextMessage({ to: user.phone, text: renderMenu(user) });
}

/** Handle a reply while the main menu is open: a valid number routes, else re-prompt. */
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
    case 'team_workload':
      await clearContext(user.phone);
      await doTeamWorkload(user);
      return;
    case 'pending_approvals':
      await clearContext(user.phone);
      await doPendingApprovals(user);
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

    // ── v2 inspector menu (SPEC_FIELD_V2 §5) — STUB handlers ─────────────────
    // Real behavior lands in D2-T2 through D2-T10. Each stub sends a Hebrew
    // placeholder plus the internal task IDs where the flow will be implemented.
    case 'list_inspections_today':
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'פונקציה זו בפיתוח (D2-T4/T5).' });
      return;
    case 'list_inspections_tomorrow':
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'פונקציה זו בפיתוח (D2-T4/T5).' });
      return;
    case 'update_inspection_status':
      await startStatusUpdateFlow(user);
      return;
    case 'report_problem':
      await startReportProblemFlow(user);
      return;
    case 'missing_equipment':
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'פונקציה זו בפיתוח (D2-T9).' });
      return;
    case 'missing_report_info':
      await startMissingInfoFlow(user);
      return;
    case 'day_summary':
      await clearContext(user.phone);
      await sendTextMessage({ to: user.phone, text: 'פונקציה זו בפיתוח (D2-T10).' });
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
  const note = raw.trim();
  if (!ctx.taskFieldId) {
    // Corrupt state — reset and bail politely.
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  if (!note) {
    await sendTextMessage({ to: user.phone, text: 'מה חסר לדוח?' });
    return;
  }
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
  const note = raw.trim();
  if (!ctx.taskFieldId || !ctx.problemType) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  if (!note) {
    await sendTextMessage({ to: user.phone, text: 'פרט בבקשה:' });
    return;
  }
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
  const notes = raw.trim();
  if (!ctx.taskFieldId) {
    await clearContext(user.phone);
    await sendTextMessage({ to: user.phone, text: 'שגיאה פנימית. נסה שוב.' });
    return;
  }
  if (!notes) {
    await sendTextMessage({ to: user.phone, text: 'מה ההערות מהשטח?' });
    return;
  }
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

/** Pending dueDate-change approvals (manager/admin) — confirm via "אשר <id>" / "דחה <id>". */
async function doPendingApprovals(user: ResolvedUser): Promise<void> {
  if (!user.isElevated) {
    await sendTextMessage({ to: user.phone, text: 'אישורים ממתינים זמינים למנהלים בלבד.' });
    return;
  }
  const approvals = await getPendingApprovals();
  if (approvals.length === 0) {
    await sendTextMessage({ to: user.phone, text: 'אין כרגע אישורים ממתינים.' });
    return;
  }
  const lines = approvals.map((a, i) => {
    const title = typeof a.payload?.taskTitle === 'string' ? a.payload.taskTitle : '';
    const nv = a.payload?.new_value;
    const what = title ? `"${title}"` : (a.targetTaskId ?? a.id);
    const detail = nv != null ? ` → ${String(nv)}` : '';
    return `${i + 1}. ${what}${detail}\n   לאישור: "אשר ${a.id}" · לדחייה: "דחה ${a.id}"`;
  });
  await sendTextMessage({ to: user.phone, text: `⏳ אישורים ממתינים (${approvals.length}):\n${lines.join('\n')}` });
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
function describeListQuery(q: ListQuery): string {
  const scopeTxt = q.scope === 'all' ? 'של כל המשתמשים' : 'שלך';
  const fieldTxt = q.dateField === 'createdAt' ? 'שנוצרו' : 'עם תאריך יעד';
  const timeTxt  = q.dateField === 'createdAt' ? ' (כולל שעת יצירה)' : ' (כולל שעה)';
  const statusTxt = q.filter === 'open' ? ' (פתוחות בלבד)' : '';

  let dateTxt: string;
  if (q.dateFrom && q.dateTo && q.dateFrom === q.dateTo) dateTxt = `בתאריך ${fmtDateStr(q.dateFrom)}`;
  else if (q.dateFrom && q.dateTo) dateTxt = `בין ${fmtDateStr(q.dateFrom)} ל-${fmtDateStr(q.dateTo)}`;
  else if (q.dateFrom) dateTxt = `מתאריך ${fmtDateStr(q.dateFrom)}`;
  else dateTxt = `עד תאריך ${fmtDateStr(q.dateTo as string)}`;

  return `אציג את המשימות ${scopeTxt} ${fieldTxt} ${dateTxt}${statusTxt}${timeTxt}.`;
}

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

/**
 * Resolve the named owner on intent.params.ownerId (used by create_task and
 * reassign_task) to a concrete user id. Uses substring matching over ACTIVE
 * employees (findUsersByName), so a partial name like "גיא" finds "גיא פרנסס".
 * When several match, asks the user to pick by number (awaiting: 'owner_disambig')
 * and returns false so routing stops until they reply. Returns true when
 * resolution is complete (or no owner was named — create then defaults to the
 * caller). Resolving here is required: the ownerId column is an FK, so passing a
 * raw name to the DB update would fail.
 */
async function resolveOwnerReference(user: ResolvedUser, intent: AIIntentResult): Promise<boolean> {
  const p = intent.params;
  if (p._ownerResolved) return true;                 // already a concrete id (disambig re-entry)
  const ref = typeof p.ownerId === 'string' ? p.ownerId.trim() : '';
  if (!ref) return true;                              // no owner named → caller owns it

  const matches = await findUsersByName(ref);
  if (matches.length === 0) {
    await sendTextMessage({ to: user.phone, text: `לא מצאתי עובד פעיל בשם "${ref}".` });
    return false;
  }
  if (matches.length === 1) {
    p.ownerId = matches[0].id;
    p._ownerResolved = true;
    return true;
  }

  // Several active employees match → ask the user to choose by number.
  const lines = matches.map((m, i) => `${i + 1}. ${m.name}`);
  await setContext(user.phone, {
    awaiting: 'owner_disambig',
    intent,
    candidateUserIds: matches.map((m) => m.id),
  });
  await sendTextMessage({
    to: user.phone,
    text: `נמצאו כמה עובדים בשם "${ref}":\n${lines.join('\n')}\nהשב במספר.`,
  });
  return false;
}

// The link fields are FKs, so each must be resolved from a NAME to a concrete id
// before the relink update — keyed by which param the AI populated.
const LINK_RESOLVERS = {
  customerId: { finder: findCustomersByName, kind: 'לקוח' },
  leadId:     { finder: findLeadsByName,     kind: 'ליד' },
  projectId:  { finder: findProjectsByName,  kind: 'פרויקט' },
} as const;

/**
 * Resolve the named link target on intent.params (one of customerId / leadId /
 * projectId, set by relink_task) from a NAME to a concrete entity id. Uses
 * substring matching (findCustomersByName / findLeadsByName / findProjectsByName),
 * so a partial name finds the full record. When several match, asks the user to
 * pick by number (awaiting: 'link_disambig') and returns false so routing stops
 * until they reply. Returns true when resolution is complete (or no link field
 * was set). Resolving here is required: the customerId/leadId/projectId columns
 * are FKs, so passing a raw name to the DB update would fail.
 */
async function resolveLinkReference(user: ResolvedUser, intent: AIIntentResult): Promise<boolean> {
  const p = intent.params;
  if (p._linkResolved) return true;                  // already a concrete id (disambig re-entry)

  // Exactly one link field is set for a relink — find which.
  const field = (Object.keys(LINK_RESOLVERS) as Array<keyof typeof LINK_RESOLVERS>)
    .find((f) => p[f] !== undefined);
  if (!field) return true;                           // nothing to resolve

  const { finder, kind } = LINK_RESOLVERS[field];
  const ref = typeof p[field] === 'string' ? (p[field] as string).trim() : '';
  if (!ref) return true;

  const matches = await finder(ref);
  if (matches.length === 0) {
    await sendTextMessage({ to: user.phone, text: `לא מצאתי ${kind} בשם "${ref}".` });
    return false;
  }
  if (matches.length === 1) {
    p[field] = matches[0].id;
    p._linkResolved = true;
    return true;
  }

  // Several entities match → ask the user to choose by number.
  const lines = matches.map((m, i) => `${i + 1}. ${m.label}`);
  await setContext(user.phone, {
    awaiting: 'link_disambig',
    intent,
    candidateLinkIds: matches.map((m) => m.id),
    linkField: field,
  });
  await sendTextMessage({
    to: user.phone,
    text: `נמצאו כמה רשומות מסוג ${kind} בשם "${ref}":\n${lines.join('\n')}\nהשב במספר.`,
  });
  return false;
}

function buildCreateBody(intent: AIIntentResult): Record<string, unknown> {
  const p = intent.params;
  const body: Record<string, unknown> = { title: p.title, type: p.type };
  if (p.dueDate)  body.dueDate  = p.dueDate;
  if (p.priority) body.priority = p.priority;
  if (p.ownerId)  body.ownerId  = p.ownerId;
  return body;
}

function applyFieldValue(intent: AIIntentResult, field: string, value: string): AIIntentResult {
  if (field === 'new_value') intent.new_value = value;
  else if (field === 'task_reference') intent.task_reference = value;
  else intent.params[field] = value;
  return intent;
}

function describeIntent(intent: AIIntentResult): string {
  switch (intent.intent) {
    case 'create_task':   return `הבנתי שברצונך ליצור משימה "${intent.params.title ?? ''}" (סוג: ${intent.params.type ?? '?'}).`;
    case 'edit_field':    return `הבנתי שברצונך לעדכן את השדה "${intent.field}" למשימה "${intent.task_reference ?? ''}".`;
    case 'edit_duedate':  return `הבנתי שברצונך לשנות את מועד המשימה "${intent.task_reference ?? ''}".`;
    case 'reassign_task': return `הבנתי שברצונך להעביר בעלות על המשימה "${intent.task_reference ?? ''}".`;
    case 'relink_task':   return `הבנתי שברצונך לשנות את הקישור של המשימה "${intent.task_reference ?? ''}".`;
    case 'list_tasks':    return 'הבנתי שברצונך לראות את רשימת המשימות.';
    case 'team_workload': return 'הבנתי שברצונך לראות את עומס המשימות בצוות.';
    case 'get_task':      return `הבנתי שברצונך לראות פרטי משימה "${intent.task_reference ?? ''}".`;
    default:              return 'הבנתי את בקשתך.';
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
    'אני עוזר לנהל משימות. אפשר לבקש למשל:',
    '• "הצג את המשימות שלי" / "מה המשימות להיום"',
    '• "מה באיחור?" — משימות שעבר זמנן',
    '• "צור משימה תיאום ללקוח X למחר"',
    '• "שנה את הכותרת של משימה Y ל..."',
    '• "שנה מועד למשימה Y ל..." (דורש אישור מנהל)',
    '• למנהלים: "כל המשימות" / "עומס משימות בצוות"',
  ].join('\n');
}

async function safePriorities(): Promise<string[]> {
  try {
    return await getAllowedPriorities();
  } catch {
    return [];
  }
}
