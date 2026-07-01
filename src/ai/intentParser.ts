import type { AIIntentResult, ResolvedUser, ChatTurn } from '../types';
import { TASK_TYPE_LABELS } from '../types';
import { getProvider, type LLMProvider } from './provider';
import {
  INTENT_JSON_SCHEMA, TOOL_NAME, TOOL_DESCRIPTION,
  FIELD_STATUS_TRANSITIONS, FIELD_PROBLEM_TYPES,
  parseIntentResult,
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
    'You are the intent parser for a Hebrew-language WhatsApp assistant for field-service inspectors.',
    'Your ONLY job is to translate the user message into a single structured tool call. Always call the tool exactly once.',
    '',
    `Today (Asia/Jerusalem) is ${todayIsrael}. Resolve relative dates ("מחר", "יום ראשון", "בעוד שבוע") to absolute ISO 8601 datetimes.`,
    '',
    `The user is "${ctx.user.name}", role=${ctx.user.role}, elevated=${ctx.user.isElevated} (elevated = MANAGER or ADMIN).`,
    '',
    'INTENTS:',
    '- get_task: user wants details of one task. Set task_reference to the text identifying it.',
    '- set_field_status: a FIELD INSPECTOR reports that they are advancing an inspection to a new operational status. Set the top-level "transition" field to one of: ' + FIELD_STATUS_TRANSITIONS.join(', ') + '. Map: "יצאתי"/"בדרך"/"נסעתי"→DEPARTED; "הגעתי"/"אני באתר"→ARRIVED; "סיימתי"/"גמרתי"→FINISHED; "אני מחכה למידע"/"צריך עוד פרטים לפני שאוכל לסיים"→WAITING_FOR_INFO; "יש לי בעיה"/"יש בעיה בבדיקה"→HAS_PROBLEM. If the worker names a specific customer/address ("יצאתי ללקוח כהן", "הגעתי לרעננה") put that in task_reference; otherwise leave task_reference=null and the backend disambiguates. Do NOT put the transition in params.',
    '- report_problem: a FIELD INSPECTOR reports a problem with an inspection. If their phrasing maps cleanly to one of the 7 declared problem types, set the top-level "problem_type" field to it: ' + FIELD_PROBLEM_TYPES.join(', ') + '. Map: "הלקוח לא ענה"/"לא עונה בטלפון"→CUSTOMER_NOT_ANSWERING; "אין גישה"/"אין גישה לאתר"→NO_ACCESS; "הלקוח לא נמצא"/"אין אף אחד"→CUSTOMER_NOT_PRESENT; "חסר ציוד"/"אין לי את המכשיר"→MISSING_EQUIPMENT; "אי אפשר לבצע"/"לא ניתן לבצע"→CANNOT_PERFORM; "בעיה מקצועית"→PROFESSIONAL_ISSUE; anything else on a "problem" phrasing→OTHER. If the phrasing does NOT map cleanly, leave problem_type=null (the router will show the 7-item sub-menu). Free-text elaboration goes in params.note. Optional inline customer/address ref → task_reference.',
    '- report_missing_info: a FIELD INSPECTOR reports that information is missing before the final report can be written ("חסר לי טופס דגימה", "חסר מספר היתר בנייה", "צריך שם מתכנן"). Put the specific missing item in params.note. Optional inline customer/address ref → task_reference. NOTE: this is different from set_field_status transition=WAITING_FOR_INFO — that one is a bare status update; report_missing_info specifies WHAT is missing.',
    '- help: user asks what you can do.',
    '- unknown: you cannot tell what they want, OR the request is out of scope. Set a Hebrew "clarification" so the user gets a clear answer.',
    '',
    `TASK TYPES — map the user's plain-Hebrew description to one of these enum values: ${taskTypeLabels}.`,
    `Valid priorities: ${ctx.allowedPriorities.join(', ') || '(unknown)'}.`,
    '',
    'SAFETY:',
    '- You never read or write the database and never execute actions. You only translate the message into the tool call.',
    '- status, id, createdAt, updatedAt are READ-ONLY. Never edit them.',
    '',
    'CONFIDENCE POLICY:',
    '- >= 0.85: emit the detected intent with its fields.',
    '- 0.60–0.85: still emit the intent, but include a Hebrew "clarification" so the backend can confirm before acting.',
    '- < 0.60: emit intent="unknown" with a short Hebrew "clarification" asking the user to rephrase. Do not guess.',
    '',
    'RULES:',
    '- confidence reflects how sure you are (0..1). If the message is vague, lower it.',
    '- For get_task you MUST identify the task via task_reference. If the user did NOT say which task, set task_reference=null, add "task_reference" to missing_fields, and write a Hebrew clarification.',
    '- Never invent task ids.',
    '',
    'HEBREW EXAMPLES (illustrative):',
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
    ctx.history && ctx.history.length > 0
      ? `\nRECENT CONVERSATION (oldest→newest). Use it to resolve references. Emit exactly ONE tool call for the LATEST user message:\n` +
        ctx.history.map((h) => `${h.role === 'user' ? 'USER' : 'BOT'}: ${h.content}`).join('\n')
      : '',
    ctx.pendingNote ? `\nCONTEXT: ${ctx.pendingNote}` : '',
    // D2-T12/T13/T14: few-shot examples for correction intents.
    '',
    '- "הכתובת שגויה" / "לתקן את הכתובת" / "הכתובת לא נכונה" → correct_task_field_site.',
    '- "איש קשר לא נכון" / "פרטי קשר שגויים" / "לעדכן פרטי קשר" → correct_task_field_site.',
    '- "לשייך משימה מחדש" / "להעביר משימה לעובד אחר" / "לשנות שיוך" → reassign_task (requires_manager_approval=true).',
    '- "לשנות את העובד המשויך" / "תשייך את זה ל..." → reassign_task (requires_manager_approval=true).',
    '- "סוג בדיקה שגוי" / "לתקן את סוג הבדיקה" / "מק"ט לא נכון" → correct_inspection_type (requires_confirmation=true).',
    '- "הזנתי סוג בדיקה לא נכון" / "צריך לשנות את המק"ט" → correct_inspection_type (requires_confirmation=true).',
    // D2-T11: few-shot examples for schedule_task_field intent (HANDOFF §4).
    '- "לתזמן ביקור" / "לתזמן בדיקה" → schedule_task_field, params.scheduledStartAt=null (router will ask).',
    '- "לקבוע ביקור חדש" / "לקבוע בדיקה חדשה" → schedule_task_field, params.scheduledStartAt=null.',
    '- "לפתוח תיזמון" → schedule_task_field.',
    '- "בדיקה נוספת" → schedule_task_field.',
    '- "לתזמן ביקור מחר ב-10" → schedule_task_field, params.scheduledStartAt="<resolved ISO datetime for tomorrow 10:00 Asia/Jerusalem>".',
    '- "לקבוע בדיקה ראשון בעשר בבוקר" → schedule_task_field, params.scheduledStartAt="<resolved ISO datetime for next Sunday 10:00>".',
    '- "לתזמן בדיקה, משך שעה וחצי" → schedule_task_field, params.durationMinutes=90.',
    // D3-T6: few-shot examples for lead-assignment intent.
    '- "לשייך ליד" / "לשייך את הליד" → assign_lead (router will show the lead list).',
    '- "להקצות ליד לעובד" / "שיוך ליד לעובד" → assign_lead.',
    '- "תשייך ליד לדני" / "תעביר את הליד לטכנאי" → assign_lead.',
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
