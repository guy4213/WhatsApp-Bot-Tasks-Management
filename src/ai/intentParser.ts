import type { AIIntentResult, ResolvedUser, ChatTurn } from '../types';
import { TASK_TYPE_LABELS } from '../types';
import { getProvider, type LLMProvider } from './provider';
import {
  INTENT_JSON_SCHEMA, TOOL_NAME, TOOL_DESCRIPTION,
  FIELD_STATUS_TRANSITIONS, FIELD_PROBLEM_TYPES,
  parseIntentResult,
} from './schema';
import { isExceptionsViewer, isLeadsViewer } from '../services/specialUsers';
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

/** True when the user qualifies for the unified manager menu and manager intents. */
function isManagerLevel(user: ResolvedUser): boolean {
  return (
    user.role === 'ADMIN' ||
    user.role === 'MANAGER' ||
    isExceptionsViewer(user.name) ||
    isLeadsViewer(user.name)
  );
}

// ── Prompt blocks ─────────────────────────────────────────────────────────────

const WORKER_INTENT_LIST = [
  'WORKER-SIDE INTENTS (use for non-manager users):',
  '- get_task: user wants details of one task. Set task_reference to the text identifying it.',
  '- set_field_status: a FIELD INSPECTOR reports that they are advancing an inspection to a new operational status. Set the top-level "transition" field to one of: ' + FIELD_STATUS_TRANSITIONS.join(', ') + '. Map: "יצאתי"/"בדרך"/"נסעתי"→DEPARTED; "הגעתי"/"אני באתר"→ARRIVED; "סיימתי"/"גמרתי"→FINISHED; "אני מחכה למידע"/"צריך עוד פרטים לפני שאוכל לסיים"→WAITING_FOR_INFO; "יש לי בעיה"/"יש בעיה בבדיקה"→HAS_PROBLEM. If the worker names a specific customer/address ("יצאתי ללקוח כהן", "הגעתי לרעננה") put that in task_reference; otherwise leave task_reference=null and the backend disambiguates. Do NOT put the transition in params.',
  '- report_problem: a FIELD INSPECTOR reports a problem with an inspection. If their phrasing maps cleanly to one of the 7 declared problem types, set the top-level "problem_type" field to it: ' + FIELD_PROBLEM_TYPES.join(', ') + '. Map: "הלקוח לא ענה"/"לא עונה בטלפון"→CUSTOMER_NOT_ANSWERING; "אין גישה"/"אין גישה לאתר"→NO_ACCESS; "הלקוח לא נמצא"/"אין אף אחד"→CUSTOMER_NOT_PRESENT; "חסר ציוד"/"אין לי את המכשיר"→MISSING_EQUIPMENT; "אי אפשר לבצע"/"לא ניתן לבצע"→CANNOT_PERFORM; "בעיה מקצועית"→PROFESSIONAL_ISSUE; anything else on a "problem" phrasing→OTHER. If the phrasing does NOT map cleanly, leave problem_type=null (the router will show the 7-item sub-menu). Free-text elaboration goes in params.note. Optional inline customer/address ref → task_reference.',
  '- report_missing_info: a FIELD INSPECTOR reports that information is missing before the final report can be written ("חסר לי טופס דגימה", "חסר מספר היתר בנייה", "צריך שם מתכנן"). Put the specific missing item in params.note. Optional inline customer/address ref → task_reference. NOTE: this is different from set_field_status transition=WAITING_FOR_INFO — that one is a bare status update; report_missing_info specifies WHAT is missing.',
  '- help: user asks what you can do.',
  '- unknown: you cannot tell what they want, OR the request is out of scope. Set a Hebrew "clarification" so the user gets a clear answer.',
].join('\n');

const WORKER_FEW_SHOT = [
  'HEBREW EXAMPLES FOR WORKER (illustrative):',
  '- "יצאתי לרעננה" → set_field_status, transition="DEPARTED", task_reference="רעננה".',
  '- "בדרך" / "נסעתי" (no destination named) → set_field_status, transition="DEPARTED", task_reference=null.',
  '- "הגעתי" / "אני באתר" → set_field_status, transition="ARRIVED", task_reference=null.',
  '- "סיימתי" / "גמרתי את הבדיקה" → set_field_status, transition="FINISHED", task_reference=null.',
  '- "אני מחכה למידע" / "צריך עוד פרטים לפני שאוכל לסיים" → set_field_status, transition="WAITING_FOR_INFO".',
  '- "יש לי בעיה" / "יש בעיה בבדיקה" → set_field_status, transition="HAS_PROBLEM" (the router shows the 7-item sub-menu to pick problem_type).',
  '- "הלקוח לא ענה" → report_problem, problem_type="CUSTOMER_NOT_ANSWERING".',
  '- "אין גישה לאתר" → report_problem, problem_type="NO_ACCESS".',
  '- "יש בעיה, לא מצליח למדוד" → report_problem, problem_type=null, params.note="לא מצליח למדוד" (router asks which type).',
  '- "חסר לי טופס דגימה" → report_missing_info, params.note="טופס דגימה".',
  '- "יצאתי ללקוח כהן" → set_field_status, transition="DEPARTED", task_reference="כהן".',
  '- "הכתובת שגויה" / "לתקן את הכתובת" / "הכתובת לא נכונה" → correct_task_field_site.',
  '- "איש קשר לא נכון" / "פרטי קשר שגויים" / "לעדכן פרטי קשר" → correct_task_field_site.',
  '- "לשייך משימה מחדש" / "להעביר משימה לעובד אחר" / "לשנות שיוך" → reassign_task (requires_manager_approval=true).',
  '- "לשנות את העובד המשויך" / "תשייך את זה ל..." → reassign_task (requires_manager_approval=true).',
  '- "סוג בדיקה שגוי" / "לתקן את סוג הבדיקה" / "מק"ט לא נכון" → correct_inspection_type (requires_confirmation=true).',
  '- "הזנתי סוג בדיקה לא נכון" / "צריך לשנות את המק"ט" → correct_inspection_type (requires_confirmation=true).',
  '- "לתזמן ביקור" / "לתזמן בדיקה" → schedule_task_field, params.scheduledStartAt=null (router will ask).',
  '- "לקבוע ביקור חדש" / "לקבוע בדיקה חדשה" → schedule_task_field, params.scheduledStartAt=null.',
  '- "לתזמן ביקור מחר ב-10" → schedule_task_field, params.scheduledStartAt="<resolved ISO datetime for tomorrow 10:00 Asia/Jerusalem>".',
  '- "לשייך ליד" / "לשייך את הליד" → assign_lead (router will show the lead list).',
  '- "להקצות ליד לעובד" / "שיוך ליד לעובד" → assign_lead.',
].join('\n');

const MANAGER_INTENT_LIST = [
  'MANAGER-SIDE INTENTS (use for manager-level users):',
  '- open_manager_menu: user wants to open or see the manager menu. Triggered by "תפריט", "מה יש כאן", "מה אפשר לעשות", "עזרה", "תראה לי את התפריט".',
  '- management_snapshot: user wants a high-level org-wide snapshot/overview. Triggered by "מה יש להיום", "מה קורה", "תמונת מצב", "מה המצב", "סיכום ניהולי", "מה קורה בשטח", "תן לי תמונת מצב".',
  '- list_today_field_inspections: user wants to see ALL field inspections scheduled for today (org-wide). Triggered by "רשימת בדיקות היום", "בדיקות שטח להיום", "מה יש היום", "בדיקות של היום", "כמה בדיקות היום", "תציג לי את בדיקות השטח להיום", "הבדיקות היום".',
  '- list_open_exceptions: user wants to see exceptions or deviations. Triggered by "תציג את החריגים", "יש חריגים?", "מה בעיות פתוחות", "משימות עם בעיה". Use params.filter: "open" (default), "has_problem" (when user says "בעיה"), "not_confirmed" (when "לא אושרו"), "waiting_for_info" (when "ממתין למידע" / "חסר מידע"), "not_closed" (when "לא סגרו יום").',
  '- list_pending_leads: user wants to see leads. Triggered by "לידים ממתינים", "מה יש לידים", "כמה לידים לא שויכו", "לידים פתוחים". Use params.filter: "unassigned" (default), "escalated" (when "שעברו שעה" / "באיחור" / "לידים שעברו שעה").',
  '- workers_day_overview: user wants a summary of what workers did today. Triggered by "סיכום עובדים", "מה כל עובד עשה", "עובדים היום", "ביצועי עובדים", "מי עשה מה". If the user names a specific worker ("סיכום של דני", "מה דני עשה היום") set params.workerName to that name; else leave params.workerName absent for the all-workers view.',
  '- search_task: user wants to search for a specific inspection/task. Set params.searchBy to "customer" / "worker" / "product" and params.query to the search term. Triggered by "חפש בדיקה של כהן" (searchBy=customer, query=כהן), "בדיקות של יוסי" (searchBy=worker, query=יוסי), "בדיקות מק"ט 10156" (searchBy=product, query=10156). If only intent is clear but neither dimension nor query: leave params empty and the router shows the search sub-menu.',
  '',
  'For managers, ALSO support these worker intents (managers can also schedule, assign leads, and correct):',
  '- schedule_task_field, assign_lead, correct_task_field_site, reassign_task, correct_inspection_type',
  '- help, unknown',
].join('\n');

const MANAGER_FEW_SHOT = [
  'HEBREW EXAMPLES FOR MANAGER (illustrative — including voice-transcribed quirks):',
  '',
  '// Management snapshot',
  '- "מה יש להיום" → management_snapshot.',
  '- "מה קורה" → management_snapshot.',
  '- "תמונת מצב" → management_snapshot.',
  '- "תן לי תמונת מצב" → management_snapshot.',
  '- "מה המצב כרגע" → management_snapshot.',
  '- "סיכום ניהולי" → management_snapshot.',
  '- "בבקשה תראה לי מה קורה" → management_snapshot. [voice prefix "בבקשה" is noise]',
  '',
  '// Today field inspections',
  '- "רשימת בדיקות היום" → list_today_field_inspections.',
  '- "בדיקות שטח להיום" → list_today_field_inspections.',
  '- "מה יש היום בשטח" → list_today_field_inspections.',
  '- "כמה בדיקות יש היום" → list_today_field_inspections.',
  '- "תציג לי את בדיקות השטח להיום" → list_today_field_inspections. [voice "תציג לי" prefix]',
  '- "הבדיקות שמשובצות להיום" → list_today_field_inspections.',
  '- "אני רוצה לראות בדיקות של היום" → list_today_field_inspections. [voice prefix "אני רוצה לראות"]',
  '- "תראה לי מי בשטח היום" → list_today_field_inspections.',
  '',
  '// Open exceptions',
  '- "תציג את החריגים" → list_open_exceptions, params.filter="open".',
  '- "יש חריגים?" → list_open_exceptions, params.filter="open".',
  '- "מה בעיות פתוחות" → list_open_exceptions, params.filter="has_problem".',
  '- "משימות עם בעיה" → list_open_exceptions, params.filter="has_problem".',
  '- "אילו בדיקות לא אושרו" → list_open_exceptions, params.filter="not_confirmed".',
  '- "לא אושרו" → list_open_exceptions, params.filter="not_confirmed".',
  '- "ממתינות למידע" → list_open_exceptions, params.filter="waiting_for_info".',
  '- "חסר מידע" → list_open_exceptions, params.filter="waiting_for_info".',
  '- "מי לא סגר יום" → list_open_exceptions, params.filter="not_closed".',
  '- "לא סגרו יום" → list_open_exceptions, params.filter="not_closed".',
  '',
  '// Pending leads',
  '- "לידים ממתינים" → list_pending_leads, params.filter="unassigned".',
  '- "מה יש לידים" → list_pending_leads, params.filter="unassigned".',
  '- "כמה לידים לא שויכו" → list_pending_leads, params.filter="unassigned".',
  '- "לידים פתוחים" → list_pending_leads, params.filter="unassigned".',
  '- "לידים שעברו שעה" → list_pending_leads, params.filter="escalated".',
  '- "לידים באיחור" → list_pending_leads, params.filter="escalated".',
  '- "אני רוצה לראות לידים שלא שויכו" → list_pending_leads, params.filter="unassigned". [voice prefix]',
  '',
  '// Workers day overview',
  '- "סיכום עובדים" → workers_day_overview.',
  '- "מה כל עובד עשה" → workers_day_overview.',
  '- "עובדים היום" → workers_day_overview.',
  '- "ביצועי עובדים" → workers_day_overview.',
  '- "מי עשה מה היום" → workers_day_overview.',
  '- "סיכום של דני" → workers_day_overview, params.workerName="דני".',
  '- "מה דני עשה היום" → workers_day_overview, params.workerName="דני".',
  '- "ביצועי יוסי" → workers_day_overview, params.workerName="יוסי".',
  '- "בבקשה תראה לי מה דני עשה" → workers_day_overview, params.workerName="דני". [voice prefix]',
  '',
  '// Search task',
  '- "חפש בדיקה של כהן" → search_task, params.searchBy="customer", params.query="כהן".',
  '- "חפש לפי לקוח כהן" → search_task, params.searchBy="customer", params.query="כהן".',
  '- "בדיקות של יוסי" → search_task, params.searchBy="worker", params.query="יוסי".',
  '- "תחפש לי בדיקות של יוסי" → search_task, params.searchBy="worker", params.query="יוסי". [voice prefix]',
  '- "בדיקות מק"ט 10156" → search_task, params.searchBy="product", params.query="10156".',
  '- "חפש לפי מקט" → search_task. [no dimension or query → leave params empty, router shows sub-menu]',
  '',
  '// Manager menu',
  '- "תפריט" → open_manager_menu.',
  '- "מה יש כאן" → open_manager_menu.',
  '- "מה אפשר לעשות" → open_manager_menu.',
  '- "עזרה" → open_manager_menu.',
  '- "תן לי את התפריט" → open_manager_menu.',
  '',
  '// Manager also supports worker-style intents',
  '- "לתזמן ביקור" → schedule_task_field, params.scheduledStartAt=null.',
  '- "לשייך ליד" / "לשייך את הליד" → assign_lead.',
  '- "לשייך מחדש" → reassign_task (requires_manager_approval=true).',
  '- "לתקן כתובת" → correct_task_field_site.',
  '- "לתקן סוג בדיקה" → correct_inspection_type (requires_confirmation=true).',
].join('\n');

export function buildSystemPrompt(ctx: ParseContext, message?: string): string {
  const todayIsrael = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  // Business-order Hebrew → enum mapping (stepQuote = הצעת מחיר sits in slot 4).
  const taskTypeLabels = [
    'step1', 'step2', 'step3', 'stepQuote', 'step4', 'step5', 'step6', 'step7',
  ].map((t) => `${t} = ${TASK_TYPE_LABELS[t]}`).join(', ');

  const isMgr = isManagerLevel(ctx.user);

  const intro = [
    'You are the intent parser for a Hebrew-language WhatsApp assistant that serves',
    'BOTH field-service inspectors AND their managers / office staff. Different users',
    'share the same bot — determine the intended intent from BOTH the message content',
    'AND the user\'s role/name below.',
    '',
    'Your ONLY job is to translate the user message into a single structured tool call. Always call the tool exactly once.',
  ].join('\n');

  const currentUserBlock = [
    '',
    `Today (Asia/Jerusalem) is ${todayIsrael}. Resolve relative dates ("מחר", "יום ראשון", "בעוד שבוע") to absolute ISO 8601 datetimes.`,
    '',
    'CURRENT USER:',
    `- Name: ${ctx.user.name}`,
    `- Role: ${ctx.user.role}`,
    `- Manager-level: ${isMgr} (true = ADMIN, MANAGER, or one of the named special sets)`,
    '',
    isMgr
      ? 'This is a MANAGER-LEVEL user. Prefer the list/dashboard intents (management_snapshot, list_today_field_inspections, list_open_exceptions, list_pending_leads, workers_day_overview, search_task) when the message is ambiguous. Also support manager-menu intent (open_manager_menu).'
      : 'This is a WORKER (field inspector). Prefer the worker intents (set_field_status, report_problem, report_missing_info, get_task). Manager intents are not available.',
  ].join('\n');

  const taskTypesBlock = [
    '',
    `TASK TYPES — map the user's plain-Hebrew description to one of these enum values: ${taskTypeLabels}.`,
    `Valid priorities: ${ctx.allowedPriorities.join(', ') || '(unknown)'}.`,
  ].join('\n');

  const safetyBlock = [
    '',
    'SAFETY:',
    '- You never read or write the database and never execute actions. You only translate the message into the tool call.',
    '- status, id, createdAt, updatedAt are READ-ONLY. Never edit them.',
  ].join('\n');

  const confidenceBlock = [
    '',
    'CONFIDENCE POLICY:',
    '- >= 0.85: emit the detected intent with its fields.',
    '- 0.60–0.85: still emit the intent, but include a Hebrew "clarification" so the backend can confirm before acting.',
    '- < 0.60: emit intent="unknown" with a short Hebrew "clarification" asking the user to rephrase. Do not guess.',
  ].join('\n');

  const rulesBlock = [
    '',
    'RULES:',
    '- confidence reflects how sure you are (0..1). If the message is vague, lower it.',
    '- For get_task you MUST identify the task via task_reference. If the user did NOT say which task, set task_reference=null, add "task_reference" to missing_fields, and write a Hebrew clarification.',
    '- Never invent task ids.',
    '- CRITICAL — Do NOT recycle search terms, worker names, or customer names from prior',
    '  conversation history unless the CURRENT user message explicitly mentions them.',
    '  Short numeric messages like "1", "2", "3" are menu picks, NOT search queries.',
    '  If the current message is a bare digit or very short (≤3 chars) and there is no',
    '  clear search intent in the CURRENT message itself, return intent="unknown" with a',
    '  Hebrew clarification. Never map a bare digit to search_task using stale history.',
  ].join('\n');

  const helpUnknownBlock = [
    '- help: user asks what you can do.',
    '- unknown: you cannot tell what they want, OR the request is out of scope. Set a Hebrew "clarification".',
  ].join('\n');

  // Layer 3 fix: for very short messages (≤3 chars, e.g. a bare "2" or "כן"),
  // do NOT feed the full chat history to the LLM. The risk of the model
  // recycling a stale search query or worker name from a previous turn (e.g.
  // pulling "יאיר" out of context when the user just types "2") far outweighs
  // any benefit of reference resolution for such minimal input. We pass at most
  // the single most-recent BOT turn so the model has minimal conversational
  // anchor without the dangerous stale search terms.
  const isVeryShortMessage = message !== undefined && message.trim().length <= 3;
  const historyForPrompt = isVeryShortMessage
    ? (ctx.history ?? []).filter((h) => h.role === 'assistant').slice(-1)
    : (ctx.history ?? []);

  const historyBlock = historyForPrompt.length > 0
    ? `\nRECENT CONVERSATION (oldest→newest). Use it to resolve references. Emit exactly ONE tool call for the LATEST user message:\n` +
      historyForPrompt.map((h) => `${h.role === 'user' ? 'USER' : 'BOT'}: ${h.content}`).join('\n')
    : '';

  const pendingNoteBlock = ctx.pendingNote ? `\nCONTEXT: ${ctx.pendingNote}` : '';

  const sections = [
    intro,
    currentUserBlock,
    '',
    isMgr ? MANAGER_INTENT_LIST : WORKER_INTENT_LIST,
    '',
    isMgr ? MANAGER_FEW_SHOT : WORKER_FEW_SHOT,
    '',
    'help / unknown intents:',
    helpUnknownBlock,
    taskTypesBlock,
    safetyBlock,
    confidenceBlock,
    rulesBlock,
    historyBlock,
    pendingNoteBlock,
  ].filter((s) => s !== undefined && s !== null);

  return sections.join('\n');
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
    system: buildSystemPrompt(ctx, message),
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
