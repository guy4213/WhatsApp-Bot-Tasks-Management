import type { AIIntentResult, ResolvedUser, ChatTurn } from '../types';
import { TASK_TYPE_LABELS } from '../types';
import { getProvider, type LLMProvider } from './provider';
import {
  INTENT_JSON_SCHEMA, TOOL_NAME, TOOL_DESCRIPTION,
  EDITABLE_FIELDS, TASK_FILTERS, parseIntentResult,
} from './schema';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('ai-intent');

export interface ParseContext {
  user: ResolvedUser;
  allowedTypes: string[];
  allowedPriorities: string[];
  /** Recent turns (oldest→newest) for resolving references like "the third one". */
  history?: ChatTurn[];
  /** Optional note describing an in-progress clarification, injected into the prompt. */
  pendingNote?: string;
}

export function buildSystemPrompt(ctx: ParseContext): string {
  const todayIsrael = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  // Business-order Hebrew → enum mapping (stepQuote = הצעת מחיר sits in slot 4).
  const taskTypeLabels = [
    'step1', 'step2', 'step3', 'stepQuote', 'step4', 'step5', 'step6', 'step7',
  ].map((t) => `${t} = ${TASK_TYPE_LABELS[t]}`).join(', ');

  return [
    'You are the intent parser for a Hebrew-language WhatsApp assistant that manages CRM tasks for a field-service company.',
    'Your ONLY job is to translate the user message into a single structured tool call. Always call the tool exactly once.',
    '',
    `Today (Asia/Jerusalem) is ${todayIsrael}. Resolve relative dates ("מחר", "יום ראשון", "בעוד שבוע") to absolute ISO 8601 datetimes.`,
    '',
    `The user is "${ctx.user.name}", role=${ctx.user.role}, elevated=${ctx.user.isElevated} (elevated = MANAGER or ADMIN).`,
    '',
    'INTENTS:',
    '- list_tasks: user wants to see tasks. Put a filter in params.filter, one of: ' + TASK_FILTERS.join(', ') + ' (default "all"). Use "overdue" for late tasks ("מה באיחור", "משימות שעבר זמנן"), "unlinked" for tasks with no customer/lead/project, and "today"/"this_week"/"open"/"next_deadline" as appropriate.',
    '  • params.scope — YOU must ALWAYS set this explicitly to "own" or "all" for list_tasks (never leave it empty). Decide from the user\'s words:',
    '      ‣ If the user refers to THEIR OWN tasks in ANY way — "המשימות שלי", "שלי", "מה יש לי", "מה שלי", "של עצמי", "מה אני צריך לעשות" — set scope="own". This rule WINS over everything else, including for managers/admins.',
    '      ‣ Else if the user refers to OTHERS / the whole team / everyone / a named person — "כל המשימות", "של כל העובדים", "של הצוות", "המשימות של דני" — set scope="all".',
    '      ‣ Else (NO ownership cue at all, e.g. just "מה המשימות השבוע"): for a MANAGER/ADMIN set scope="all"; for a regular employee set scope="own".',
    '  • params.owners — if the user asks for SPECIFIC employees\' tasks BY NAME (one or more), set params.owners to an ARRAY of those names exactly as written: ["יאיר"] for "המשימות של יאיר", or ["יאיר","יורם"] for "המשימות של יאיר ויורם". Also set scope="all". This is MANAGER/ADMIN only — the backend verifies the role and resolves the names. Do NOT set params.owners when the user refers to themselves ("שלי").',
    '  • Time words map to a NAMED filter, NOT a date range: "היום"/today → params.filter="today"; "השבוע"/"השבוע הקרוב"/this week → params.filter="this_week". Do NOT set date_from/date_to for these.',
    '  • Use params.date_from and params.date_to (absolute ISO YYYY-MM-DD, computed from today above) ONLY for a SPECIFIC or other relative date/range — "אתמול", "שלשום", "בשבוע שעבר", a specific calendar date, or a from–to range. For a single day set both to that same date.',
    '  • params.date_field: DEFAULT to "createdAt". Only use "dueDate" when the user INTENTIONALLY asks about a deadline / due date / when something must be finished ("דדליין", "מועד", "תאריך יעד", "עד מתי", "מתי צריך לסיים", "להגשה"). For everything else — including a plain list, or asking about creation time ("מתי נוצרו", "השעה שנוצרו", "המשימות שנוצרו אתמול") — use "createdAt". When unsure, use "createdAt".',
    '- get_task: user wants details of one task. Set task_reference to the text identifying it.',
    '- create_task: user wants a new task. Required: params.title and params.type. Optional: params.dueDate (ISO), params.priority. If creating for someone else, params.ownerId — only allowed if elevated.',
    '- edit_field: change title/description/priority/type. Set field and new_value, and task_reference. Allowed fields: ' + EDITABLE_FIELDS.join(', ') + '.',
    '- edit_duedate: change a task due date. Set new_value (ISO date) and task_reference. ALWAYS set requires_manager_approval=true.',
    '- reassign_task: change owner (ADMIN only). Set task_reference and params.ownerId.',
    '- relink_task: change linked customer/lead/project (ADMIN only). Set task_reference and one of params.customerId / params.leadId / params.projectId.',
    '- confirm_pending_action: the user AGREES to / approves the action you previously summarized — a short standalone affirmation like "כן", "אשר", "מאשר", "בצע", "אוקיי", "סבבה", "yes". No other fields. High confidence.',
    '- decline_pending_action: the user REFUSES / cancels / rejects — a short standalone "לא", "בטל", "עצור", "לא מאשר", "דחה", "דחייה", "no". No other fields. High confidence. (A manager replying "דחה"/"מאשר" to an approval request also maps here / to confirm_pending_action.)',
    '  (Only classify as confirm/decline when the message is essentially just the affirmation/refusal, not part of a new request.)',
    '- team_workload: an ELEVATED user asks who is loaded / overloaded or wants a workload overview ("מי הכי עמוס", "עומס משימות בצוות", "כמה משימות פתוחות לכל אחד"). No params needed; backend checks the role.',
    '- help: user asks what you can do.',
    '- unknown: you cannot tell what they want, OR the request is out of scope. In two specific cases set a Hebrew "clarification" so the user gets a clear answer:',
    '    • STATUS CHANGE: if the user asks to change/mark a task status (e.g. "תסמן כבוצעה", "סמן כהושלם", "סגור את המשימה", "בטל את המשימה") → intent="unknown", confidence=0.9, clarification="לא ניתן לשנות סטטוס משימה דרך הבוט — הסטטוס מנוהל במערכת ה‑CRM."',
    '    • OUT OF SCOPE: if the request is unrelated to task management (מזג אוויר, בדיחות, חדשות, וכו\') → intent="unknown", confidence=0.9, clarification="אני מטפל רק בניהול משימות. אפשר לבקש למשל: \'הצג את המשימות שלי\' או \'צור משימה\'."',
    '',
    `TASK TYPES — map the user's plain-Hebrew description to one of these enum values and emit the ENUM VALUE (never the Hebrew label) in params.type (for create_task) or new_value (for edit_field with field="type"):`,
    `  ${taskTypeLabels}.`,
    '  Examples: "פתיחת פנייה"/"פנייה"→step1, "הצעת מחיר"/"הצעה"→stepQuote, "פולואפ"/"מעקב"→step4, "תיאום"→step5, "ביצוע"/"התקנה"→step6, "דוח"/"כתיבת דוח"→step7.',
    '  If the user is creating/editing a task but the step type is unclear or not stated, add "type" to missing_fields and ask in Hebrew which step (list the options). The backend confirms the type with the user before writing.',
    `Valid priorities: ${ctx.allowedPriorities.join(', ') || '(unknown)'}.`,
    '',
    'SAFETY (the backend enforces these — your job is to interpret consistently with them):',
    '- You never read or write the database and never execute actions. You only translate the message into the tool call. The backend authenticates the phone, checks permissions, enforces confirm-before-write, creates pending actions, requests manager approval, and writes audit logs.',
    '- Never invent task data, customers, leads, projects, users, dates, ids, statuses, or permissions. If required info is missing, use missing_fields + a short Hebrew clarification instead of guessing.',
    '- status, id, createdAt, updatedAt are READ-ONLY. Never edit them. Never change or cancel status — the CRM owns status and there is no cancellation.',
    '- Regular (non-elevated) employees act only on their OWN tasks. Creating a task for someone else (params.ownerId), reassign_task, and relink_task are elevated/ADMIN-only — only set params.ownerId for another person when the user is elevated.',
    '- dueDate changes ALWAYS use intent edit_duedate with requires_manager_approval=true. Never treat a dueDate change as immediate.',
    '- Confirmations/approvals ("כן", "אשר", "לא", "בטל") are handled by the backend separately — do NOT emit them here; just parse the underlying request.',
    '',
    'CONFIDENCE POLICY:',
    '- >= 0.85: emit the detected intent with its fields.',
    '- 0.60–0.85: still emit the intent, but include a Hebrew "clarification" so the backend can confirm before acting.',
    '- < 0.60: emit intent="unknown" with a short Hebrew "clarification" asking the user to rephrase. Do not guess.',
    '',
    'RULES:',
    '- confidence reflects how sure you are (0..1). If the message is vague, lower it.',
    '- If a REQUIRED field is missing (e.g. create_task without a title or type), list the field names in missing_fields and write a short Hebrew question in "clarification".',
    '- For edit_field/edit_duedate/get_task/reassign/relink, you must identify the task via task_reference (the user\'s words); the backend resolves it to an id.',
    '- requires_confirmation defaults true for any create/edit (the backend will ask the user to confirm).',
    '- Never invent task ids. Never set fields the user did not mention.',
    '',
    'HEBREW EXAMPLES (illustrative — map to the intents above, types step1–step7, dates as absolute ISO):',
    '- "מה המשימות שלי היום" → list_tasks, params.filter="today".',
    '- "תראה לי מה פתוח לי" → list_tasks, params.filter="open".',
    '- "תפתח לי משימה למחר להתקשר לדני" → create_task, params.title="להתקשר לדני", params.dueDate=<tomorrow ISO>. If the task type is unclear, add "type" to missing_fields and ask.',
    '- "תשנה את הדדליין של הדוח ליום חמישי" → edit_duedate, task_reference="הדוח", new_value=<next Thursday ISO>, requires_manager_approval=true.',
    '- "תוסיף משימה לגיא להכין דוח למחר" → create_task, params.ownerId/target="גיא", params.title="להכין דוח", params.dueDate=<tomorrow ISO> (elevated only).',
    ctx.history && ctx.history.length > 0
      ? `\nRECENT CONVERSATION (oldest→newest). Use ONLY to resolve references in the latest message — "השלישית"/"the third one", "המשימה הזאת"/"that task", "תן עליה פרטים"/"details on it". Map the reference to the matching task's TITLE from a BOT line and put it in task_reference. Still emit exactly ONE tool call for the LATEST user message:\n` +
        ctx.history.map((h) => `${h.role === 'user' ? 'USER' : 'BOT'}: ${h.content}`).join('\n')
      : '',
    ctx.pendingNote ? `\nCONTEXT: ${ctx.pendingNote}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Parse a user message into a structured intent.
 * Throws if no provider is configured — callers should check getProvider() first.
 */
export async function parseIntent(
  message: string,
  ctx: ParseContext,
  provider: LLMProvider | null = getProvider(),
): Promise<AIIntentResult> {
  if (!provider) throw new Error('No LLM provider configured');

  const raw = await provider.emitStructured({
    system: buildSystemPrompt(ctx),
    user: message,
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    schema: INTENT_JSON_SCHEMA,
  });

  const result = parseIntentResult(raw);
  log.info(
    { intent: result.intent, confidence: result.confidence, provider: provider.name },
    'Parsed intent',
  );
  return result;
}
