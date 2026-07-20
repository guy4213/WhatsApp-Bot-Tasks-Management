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
  /**
   * Phase 2: when the inbound message is a swipe-reply (quote), the resolved
   * context of the quoted bot message. Structurally compatible with
   * `QuotedContext` from `services/messageRefs`. Injected into the prompt so the
   * AI interprets the reply relative to the original message.
   */
  quotedContext?: {
    entityType: string;
    kind: string;
    entityId?: string | null;
    taskFieldId?: string | null;
    payload?: Record<string, unknown> | null;
  } | null;
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
  '- list_my_inspections: user wants to see THEIR OWN inspection list. Any phrasing asking for their inspections/day/list. Use params.dateScope: "today" (default), "tomorrow", "week", "next_week", or "all" (for "כל הזמנים" / "הכל" / "מכל הזמנים" / "בלי הגבלה" / "מאז ומעולם" / "מהתחלה" / "כל הבדיקות שלי" — any phrasing implying no date filter). Omit for today. If a Hebrew date range appears ("בין 1/7 ל-10/7", "מיום ראשון עד חמישי", "בחודש הקרוב", "לחודש הבא"), copy the raw suffix into params.rangeExpr so the backend parser resolves it. FOR ANY TIME EXPRESSION NOT COVERED BY dateScope — ESPECIALLY PAST ONES ("אתמול", "שלשום", "שבוע שעבר", "לפני שבועיים", "בחודש שעבר", or an explicit past date) — resolve it YOURSELF to params.dateRange={from:"YYYY-MM-DD", to:"YYYY-MM-DD"} (Asia/Jerusalem, half-open: from inclusive, to exclusive) relative to the Today stated above. dateScope stays for the simple named scopes; when both dateScope and dateRange could apply, dateRange wins. This is the go-to intent when a worker just wants to see what they have — do NOT use get_task for that.',
  '- get_task: user wants details of ONE SPECIFIC task, naming the customer or address. Set task_reference. Do NOT use this for a general "show me my list" request — that is list_my_inspections.',
  '- set_field_status: a FIELD INSPECTOR reports that they are advancing an inspection to a new operational status. Set the top-level "transition" field to one of: ' + FIELD_STATUS_TRANSITIONS.join(', ') + '. Map: "אישרתי"/"אושרה"/"מאשר"/"אני מאשר"/"אני מאשר את הבדיקה"/"אישור"/"מאשר את השיבוץ"→CONFIRM; "יצאתי"/"בדרך"/"בדרכי"/"נסעתי"/"אני עוזב"/"יצאתי בדרך"→DEPARTED; "הגעתי"/"אני באתר"/"אני כבר בשטח"/"הגעתי לאתר"→ARRIVED; "סיימתי"/"גמרתי"/"סיימתי הכל"/"סיימתי את הבדיקה"→FINISHED; "אני מחכה למידע"/"צריך עוד פרטים לפני שאוכל לסיים"→WAITING_FOR_INFO; "יש לי בעיה"/"יש בעיה בבדיקה"→HAS_PROBLEM. Note: "התחלתי" is NOT a valid transition (STARTED was retired) — treat it as ARRIVED if context implies on-site arrival, else set intent=unknown with a clarification. VAGUE STATUS PHRASES: if the user asks to update/change status without naming which one ("שנה סטטוס", "עדכן סטטוס", "אני רוצה לשנות סטטוס", "צריך לעדכן סטטוס", "נכון תשנה סטטוס"), emit intent=set_field_status with transition=null and a Hebrew clarification like "לאיזה סטטוס לעדכן? כתוב \'יצאתי\', \'הגעתי\', או \'סיימתי\'." Do NOT return unknown for these — the intent is clear even if the target transition isn\'t. If the worker names a specific customer/address ("יצאתי ללקוח כהן", "הגעתי לרעננה") put that in task_reference; otherwise leave task_reference=null and the backend disambiguates. Do NOT put the transition in params.',
  '- report_problem: a FIELD INSPECTOR reports a problem with an inspection. If their phrasing maps cleanly to one of the 7 declared problem types, set the top-level "problem_type" field to it: ' + FIELD_PROBLEM_TYPES.join(', ') + '. Map: "הלקוח לא ענה"/"לא עונה בטלפון"/"אין תשובה"/"הלקוח מתחמק"→CUSTOMER_NOT_ANSWERING; "אין גישה"/"אין גישה לאתר"/"אין מפתח"/"השער סגור"→NO_ACCESS; "הלקוח לא נמצא"/"אין אף אחד"/"אין אף אחד בבית"→CUSTOMER_NOT_PRESENT; "חסר ציוד"/"אין לי את המכשיר"/"חסר לי בטריות"/"אין חשמל"→MISSING_EQUIPMENT; "אי אפשר לבצע"/"לא ניתן לבצע"/"לא הצלחתי לבצע"→CANNOT_PERFORM; "בעיה מקצועית"→PROFESSIONAL_ISSUE; anything else on a "problem" phrasing→OTHER. If the phrasing does NOT map cleanly, leave problem_type=null (the router will show the 7-item sub-menu). Free-text elaboration goes in params.note. Optional inline customer/address ref → task_reference.',
  '- report_missing_info: a FIELD INSPECTOR reports that information is missing before the final report can be written ("חסר לי טופס דגימה", "חסר מספר היתר בנייה", "צריך שם מתכנן", "שכחתי את המדד"). Put the specific missing item in params.note. Optional inline customer/address ref → task_reference. NOTE: this is different from set_field_status transition=WAITING_FOR_INFO — that one is a bare status update; report_missing_info specifies WHAT is missing.',
  '- day_summary_query: worker asks for their own day summary via free text. Phrases: "מה עשיתי היום", "תן לי סיכום", "סיכום היום שלי", "סיכום". No params required. Route to the same handler as menu item 7 (day_summary).',
  '- missing_equipment_free: worker reports missing equipment BEFORE going out (general, not scoped to a specific TaskField). Phrases: "אין לי בטריות", "חסר לי מזרן", "לא לקחתי את המכשיר", "חסר לי ציוד". Put the missing item in params.note. This is different from `report_problem` with problem_type=MISSING_EQUIPMENT — that one is scoped to a specific TaskField in the field.',
  '- help: user asks what you can do.',
  '- unknown: you cannot tell what they want, OR the request is out of scope. Set a Hebrew "clarification" so the user gets a clear answer.',
  // UX-T1: self-reference guidance so the AI never invents a Hebrew name for "me"/"myself".
  'SELF-REFERENCE: When the user says "אלי" / "לי" / "אותי" / "עצמי" / "לעצמי" in the context of an assignee/owner/worker (e.g. "שייך את הליד אלי", "תעביר לי את הבדיקה"), keep the LITERAL string "אלי" in params.assigneeName — do NOT invent a Hebrew name. Code-side logic detects this token and substitutes the current user identity.',
].join('\n');

const WORKER_FEW_SHOT = [
  'HEBREW EXAMPLES FOR WORKER (illustrative):',
  '',
  '// list_my_inspections — worker asks to SEE their inspection list',
  '- "הבדיקות שלי" / "הבדיקות שלי היום" → list_my_inspections, params.dateScope="today".',
  '- "הצג את הבדיקות שלי" → list_my_inspections, params.dateScope="today".',
  '- "תציג לי את הבדיקות שלי" → list_my_inspections, params.dateScope="today". [voice "תציג לי" prefix]',
  '- "תראה לי את הבדיקות שלי היום" → list_my_inspections, params.dateScope="today".',
  '- "תן לי את הבדיקות שלי" → list_my_inspections, params.dateScope="today".',
  '- "מה יש לי היום" → list_my_inspections, params.dateScope="today".',
  '- "מה על הפרק היום" → list_my_inspections, params.dateScope="today".',
  '- "מה מחכה לי היום" → list_my_inspections, params.dateScope="today".',
  '- "רשימת הבדיקות שלי" → list_my_inspections, params.dateScope="today".',
  '- "היום שלי" / "מה היום שלי" → list_my_inspections, params.dateScope="today".',
  '- "הבדיקות שלי למחר" → list_my_inspections, params.dateScope="tomorrow".',
  '- "מה יש לי מחר" → list_my_inspections, params.dateScope="tomorrow".',
  '- "הבדיקות שלי השבוע" → list_my_inspections, params.dateScope="week".',
  '- "הבדיקות שלי בשבוע הבא" → list_my_inspections, params.dateScope="next_week".',
  '- "בבקשה תראה לי מה יש לי" → list_my_inspections, params.dateScope="today". [voice "בבקשה" prefix]',
  '- "אני רוצה לראות את הבדיקות שלי" → list_my_inspections, params.dateScope="today". [voice prefix]',
  '- "הבדיקות שלי בין 1/7 ל-10/7" → list_my_inspections, params.rangeExpr="בין 1/7 ל-10/7".',
  '- "תציג את כל הבדיקות שלי מכל הזמנים" → list_my_inspections, params.dateScope="all".',
  '- "כל הבדיקות שלי" → list_my_inspections, params.dateScope="all".',
  '- "תראה לי הכל" → list_my_inspections, params.dateScope="all".',
  '- "הבדיקות שלי בלי הגבלה" → list_my_inspections, params.dateScope="all".',
  '- "כל מה שיש לי" → list_my_inspections, params.dateScope="all".',
  '- "הבדיקות שלי מאז ומעולם" → list_my_inspections, params.dateScope="all".',
  '- "מהתחלה את כל הבדיקות שלי" → list_my_inspections, params.dateScope="all".',
  '',
  '// set_field_status — CONFIRM variants (worker confirms the assignment)',
  '- "אישרתי" → set_field_status, transition="CONFIRM", task_reference=null.',
  '- "אושרה" → set_field_status, transition="CONFIRM", task_reference=null. [passive form still means the worker is confirming]',
  '- "אני מאשר" / "מאשר" → set_field_status, transition="CONFIRM", task_reference=null.',
  '- "אני מאשר את הבדיקה" → set_field_status, transition="CONFIRM", task_reference=null.',
  '- "אישור לבדיקה" / "מאשר את השיבוץ" → set_field_status, transition="CONFIRM".',
  '- "שנה סטטוס לאושרה" / "עדכן סטטוס לאושרה" → set_field_status, transition="CONFIRM". [explicit status name in the instruction]',
  '- "שנה סטטוס לאישרתי" → set_field_status, transition="CONFIRM".',
  '- "אישרתי את הבדיקה של יוסי" → set_field_status, transition="CONFIRM", task_reference="יוסי".',
  '',
  '// set_field_status — explicit-status-name instructions (map to the transition itself, not to a vague clarification)',
  '- "שנה סטטוס ליצאתי" / "עדכן סטטוס לבדרך" → set_field_status, transition="DEPARTED".',
  '- "שנה סטטוס להגעתי" / "עדכן סטטוס לבאתר" → set_field_status, transition="ARRIVED".',
  '- "שנה סטטוס לסיימתי" / "עדכן סטטוס להסתיים" → set_field_status, transition="FINISHED".',
  '',
  '// set_field_status — DEPARTED variants',
  '- "יצאתי לרעננה" → set_field_status, transition="DEPARTED", task_reference="רעננה".',
  '- "בדרך" / "נסעתי" / "בדרכי" / "אני עוזב" (no destination named) → set_field_status, transition="DEPARTED", task_reference=null.',
  '- "יצאתי כבר" / "יצאתי בדרך" / "נסעתי לעבודה" → set_field_status, transition="DEPARTED", task_reference=null.',
  '',
  '// set_field_status — ARRIVED variants',
  '- "הגעתי" / "אני באתר" → set_field_status, transition="ARRIVED", task_reference=null.',
  '- "אני כבר בשטח" / "הגעתי לאתר" / "הגעתי כבר" / "הנה אני" → set_field_status, transition="ARRIVED", task_reference=null.',
  '',
  '// set_field_status — FINISHED variants',
  '- "סיימתי" / "גמרתי" → set_field_status, transition="FINISHED", task_reference=null.',
  '- "סיימתי הכל" / "סיימתי את הבדיקה" / "גמרתי את הכל" / "הסתיים" → set_field_status, transition="FINISHED", task_reference=null.',
  '',
  '// set_field_status — STARTED is retired',
  '- "התחלתי את הבדיקה" → STARTED is NOT a valid transition. If context implies the worker is on-site (e.g. they arrived and started), treat as ARRIVED: set_field_status, transition="ARRIVED", clarification="הבנתי שהגעת לאתר — עדכנתי כ\'הגעתי\'. STARTED אינו פעיל יותר.".',
  '',
  '- "אני מחכה למידע" / "צריך עוד פרטים לפני שאוכל לסיין" → set_field_status, transition="WAITING_FOR_INFO".',
  '- "יש לי בעיה" / "יש בעיה בבדיקה" → set_field_status, transition="HAS_PROBLEM" (the router shows the 7-item sub-menu to pick problem_type).',
  '',
  '// Vague status phrases — transition=null triggers AI clarification (NEVER fall back to "לא הבנתי")',
  '- "שנה סטטוס" → set_field_status, transition=null, clarification="לאיזה סטטוס לעדכן? כתוב \'יצאתי\', \'הגעתי\', או \'סיימתי\'.".',
  '- "עדכן סטטוס" → set_field_status, transition=null, clarification="לאיזה סטטוס לעדכן?".',
  '- "אני רוצה לשנות סטטוס" → set_field_status, transition=null, clarification="לאיזה סטטוס לעדכן?".',
  '- "נכון תשנה סטטוס" → set_field_status, transition=null, clarification="לאיזה סטטוס לעדכן?". [confirmation + vague intent — the confirmation reinforces the intent but does NOT resolve the missing transition]',
  '- "אפשר לעדכן סטטוס" → set_field_status, transition=null, clarification="לאיזה סטטוס לעדכן?".',
  '- "צריך לעדכן סטטוס" → set_field_status, transition=null, clarification="לאיזה סטטוס לעדכן?".',
  '',
  '// report_problem — the 7 declared problem types',
  '// CUSTOMER_NOT_ANSWERING',
  '- "הלקוח לא ענה" / "לא עונה בטלפון" / "אין תשובה" / "אף אחד לא עונה" → report_problem, problem_type="CUSTOMER_NOT_ANSWERING".',
  '- "הלקוח מתחמק" → report_problem, problem_type="CUSTOMER_NOT_ANSWERING".',
  '// NO_ACCESS',
  '- "אין גישה לאתר" / "אין מפתח" / "השער סגור" → report_problem, problem_type="NO_ACCESS".',
  '- "לא נותנים לי להיכנס" / "הבניין נעול" → report_problem, problem_type="NO_ACCESS".',
  '// CUSTOMER_NOT_PRESENT',
  '- "הלקוח לא נמצא" / "אין אף אחד בבית" → report_problem, problem_type="CUSTOMER_NOT_PRESENT".',
  '- "הלקוח לא נמצא באתר" / "לא הגיע אף אחד" → report_problem, problem_type="CUSTOMER_NOT_PRESENT".',
  '// MISSING_EQUIPMENT (scoped to a specific TaskField — use report_problem, NOT missing_equipment_free)',
  '- "חסר לי בטריות" (while at a site) / "אין חשמל באתר" / "המכשיר שלי לא עובד" → report_problem, problem_type="MISSING_EQUIPMENT". NOTE: if said BEFORE going out (general morning complaint), use missing_equipment_free instead.',
  '// CANNOT_PERFORM',
  '- "לא הצלחתי לבצע" / "אי אפשר לבצע כאן" / "לא ניתן לבצע במקום הזה" → report_problem, problem_type="CANNOT_PERFORM".',
  '// null problem_type — router asks',
  '- "יש בעיה, לא מצליח למדוד" → report_problem, problem_type=null, params.note="לא מצליח למדוד" (router asks which type).',
  '',
  '// report_missing_info — the worker is missing INFORMATION/DATA needed to',
  '// WRITE UP the report: a number, a name, a reading, a filled-in form to',
  '// retrieve, a permit. NEVER a physical tool/device/material — that is',
  '// missing_equipment_free (see below). If in doubt: can you photograph or',
  '// hand over the missing thing? Yes → equipment. No (it is a fact/document',
  '// you need to obtain or a number/measurement) → missing_info.',
  '- "חסר לי טופס דגימה" → report_missing_info, params.note="טופס דגימה".',
  '- "שכחתי את המדד" → report_missing_info, params.note="המדד".',
  '- "שכחתי לרשום את המדד" → report_missing_info, params.note="המדד".',
  '- "חסר לי מספר היתר בנייה" / "חסר מספר Y" → report_missing_info, params.note="מספר היתר בנייה / מספר Y".',
  '- "צריך שם מתכנן" / "צריך שם Z" → report_missing_info, params.note="שם מתכנן / שם Z".',
  '- "חסר לי טופס X" / "אין לי את הפרטים של X" → report_missing_info, params.note="X".',
  '',
  '// day_summary_query — worker asks for their day summary via free text',
  '- "מה עשיתי היום" → day_summary_query. No params.',
  '- "תן לי סיכום" → day_summary_query. No params.',
  '- "סיכום היום שלי" → day_summary_query. No params.',
  '- "סיכום" → day_summary_query. No params.',
  '- "איך הסתיים היום שלי" → day_summary_query. No params.',
  '',
  '// missing_equipment_free — worker reports a missing PHYSICAL TOOL/DEVICE/',
  '// MATERIAL needed to physically perform the inspection, said BEFORE going',
  '// out (general, not at a specific inspection). NEVER use this for missing',
  '// information/data/documents (numbers, names, readings, forms to retrieve)',
  '// — that is report_missing_info, even if the Hebrew word is "טופס" (a form',
  '// can be either — a PHYSICAL blank form/checklist the worker forgot to',
  '// bring is equipment; a form/number/reading needed to WRITE the report is',
  '// missing_info).',
  '- "אין לי בטריות" (morning, before departure) → missing_equipment_free, params.note="בטריות".',
  '- "חסר לי מזרן" → missing_equipment_free, params.note="מזרן".',
  '- "לא לקחתי את המכשיר" → missing_equipment_free, params.note="המכשיר".',
  '- "חסר לי ציוד" → missing_equipment_free, params.note="ציוד" (generic, note is "ציוד").',
  '- "שכחתי את הכפפות" / "שכחתי את הקסדה" / "שכחתי את המצלמה" → missing_equipment_free, params.note is the item.',
  '',
  '// Voice / polite prefixes for the worker (backport from manager quirks)',
  '- "בבקשה תראה לי את הבדיקות שלי" → list_my_inspections, params.dateScope="today". [voice "בבקשה תראה לי" prefix]',
  '- "אני רוצה לראות את הבדיקות שלי" → list_my_inspections, params.dateScope="today". [voice prefix]',
  '- "אנא סיים את הבדיקה" → set_field_status, transition="FINISHED". ["אנא" is polite noise]',
  '- "כן, יצאתי" → set_field_status, transition="DEPARTED". [confirmation + status]',
  '- "אה, יש לי בעיה" → set_field_status, transition="HAS_PROBLEM". [filler prefix]',
  '- "אוקיי, סיימתי" → set_field_status, transition="FINISHED". [filler prefix]',
  '- "בבקשה, יצאתי" → set_field_status, transition="DEPARTED". ["בבקשה" is polite noise]',
  '- "כן, הגעתי" → set_field_status, transition="ARRIVED". [confirmation + status]',
  '',
  '// Bare customer name / address without a verb — intentional unknown',
  '- "יוסי כהן" alone (no verb, no context) → unknown, clarification="האם התכוונת לבדיקה של יוסי כהן? כתוב \'הבדיקות שלי\' לרשימה, או שם עם פועל (למשל: \'יצאתי לכהן\')." Do NOT auto-treat bare customer names as get_task.',
  '- "רחוב הרצל 5" alone (no verb, no context) → unknown, clarification="האם התכוונת לבדיקה ברחוב הרצל 5? כתוב \'הבדיקות שלי\' לרשימה, או כתובת עם פועל (למשל: \'הגעתי להרצל 5\').".',
  '',
  '// Inline customer references + corrections',
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
  // PROV-T5 (TASKS §4.20) — MANAGER-only. The router double-checks the guard,
  // so no requires_manager_approval flag here. IMPORTANT: task_reference must
  // carry the WORKER NAME including the family name when present. A partial
  // name still resolves via the ILIKE lookup, but passing the full name gives
  // a unique match on the first try.
  '- "הפעל מעקב מיקום לדני" → enable_worker_location_tracking, task_reference="דני".',
  '- "הפעל מעקב מיקום לגיא פרנסס" → enable_worker_location_tracking, task_reference="גיא פרנסס".',
  '- "הפעל מעקב מיקום ל<פרטי> <משפחה>" → enable_worker_location_tracking, task_reference="<פרטי> <משפחה>". Include the family name in task_reference when the user typed one.',
  '- "לחבר את דני ל-OwnTracks" / "לחבר את דני למעקב" / "provision X" → enable_worker_location_tracking, task_reference="<full worker name as typed>".',
  '- "שלח לדני קישור למעקב מיקום" → enable_worker_location_tracking, task_reference="דני".',
].join('\n');

const MANAGER_INTENT_LIST = [
  'MANAGER-SIDE INTENTS (use for manager-level users):',
  '',
  'QUANTITATIVE QUESTIONS: For questions asking HOW MANY ("כמה X", "כמה בדיקות היום", "כמה חריגים", "כמה לידים לא שויכו", "כמה עובדים בשטח"), set params.count_only=true on the appropriate list intent so the router returns a number rather than a full list.',
  '',
  '- open_manager_menu: user wants to open or see the manager menu. Triggered by "תפריט", "מה יש כאן", "מה אפשר לעשות", "עזרה", "תראה לי את התפריט".',
  '- management_snapshot: user wants a high-level org-wide snapshot/overview. Triggered by "מה יש להיום", "מה קורה", "תמונת מצב", "מה המצב", "סיכום ניהולי", "מה קורה בשטח", "תן לי תמונת מצב".',
  '- list_my_inspections: the MANAGER wants THEIR OWN assigned inspections/tasks (the manager can also be assigned field work), NOT the org-wide list. Triggered by phrases containing "שלי" / "לי" about their own list: "הבדיקות שלי", "המשימות שלי" (managers may say "משימות" instead of "בדיקות" — treat as the same intent), "מה יש לי", "תציג לי את המשימות שלי". Use params.dateScope: "today" (default), "tomorrow", "week", "next_week", or "all" (for "כל הזמנים" / "הכל" / "מכל הזמנים" / "בלי הגבלה" / "מאז ומעולם" / "מהתחלה"). Omit for today. If a Hebrew date range appears ("בין 1/7 ל-10/7", "מיום ראשון עד חמישי"), copy the raw suffix into params.rangeExpr so the backend parser resolves it. FOR ANY TIME EXPRESSION NOT COVERED BY dateScope — ESPECIALLY PAST ONES ("אתמול", "שלשום", "שבוע שעבר", "לפני שבועיים", "בחודש שעבר", or an explicit past date) — resolve it YOURSELF to params.dateRange={from:"YYYY-MM-DD", to:"YYYY-MM-DD"} (Asia/Jerusalem, half-open: from inclusive, to exclusive) relative to the Today stated above, same convention as the other list intents\' dateRange. dateScope stays for the simple named scopes; when both could apply, dateRange wins. DISAMBIGUATION: phrasing with "שלי" / "לי" (the manager\'s own personal list) → list_my_inspections; org-wide phrasing without "שלי" ("בדיקות שטח", "כל הבדיקות", "מי בשטח", "רשימת בדיקות היום") → list_today_field_inspections.',
  '- list_today_field_inspections: user wants to see ALL field inspections scheduled in a date window (org-wide, NOT scoped to the manager personally). Triggered by "רשימת בדיקות היום", "בדיקות שטח להיום", "מה יש היום", "בדיקות של היום", "תציג לי את בדיקות השטח להיום", "הבדיקות היום", "כל הבדיקות", "מי בשטח". If the user names a date range ("בדיקות של השבוע", "בדיקות של אתמול", "בין 1/7 ל-3/7"), resolve it to params.dateRange={from:YYYY-MM-DD, to:YYYY-MM-DD} in Asia/Jerusalem local dates (half-open: from inclusive, to exclusive). Default to today (omit dateRange) when no date range is mentioned. For "כמה בדיקות היום" (quantitative), also set params.count_only=true.',
  '- list_open_exceptions: user wants to see exceptions or deviations. Triggered by "תציג את החריגים", "יש חריגים?", "מה בעיות פתוחות", "משימות עם בעיה". Use params.filter: "open" (default), "has_problem" (when user says "בעיה"), "not_confirmed" (when "לא אושרו"), "waiting_for_info" (when "ממתין למידע" / "חסר מידע"), "not_closed" (when "לא סגרו יום"). If the user names a date range ("אתמול", "מאתמול", "של השבוע", "בשבוע שעבר", "בין 1/7 ל-3/7"), resolve it to params.dateRange={from:YYYY-MM-DD, to:YYYY-MM-DD} in Asia/Jerusalem local dates (half-open: from inclusive, to exclusive). Default to today (omit dateRange) when no date range is mentioned. For "כמה חריגים" (quantitative), also set params.count_only=true.',
  '- list_pending_leads: user wants to see leads. Triggered by "לידים ממתינים", "מה יש לידים", "לידים פתוחים". Use params.filter: "unassigned" (default), "escalated" (when "שעברו שעה" / "באיחור" / "לידים שעברו זמן" / "לידים בעיכוב" / "לידים עם עיכוב"). If the user asks for leads scoped to a specific person ("לידים שלי", "לידים של סשה") — owner scoping is NOT YET supported; emit list_pending_leads with params.filter="unassigned" and clarification="נכון לעכשיו אני מציג את כל הלידים הפתוחים. סינון לפי בעל טיפול טרם נתמך." If the user names a date range, resolve to params.dateRange={from, to} scoped on IncomingLead.receivedAt. Default (no dateRange) means all open leads regardless of receivedAt (existing behavior). For "כמה לידים לא שויכו" (quantitative), also set params.count_only=true.',
  '- workers_day_overview: user wants a summary of what workers did. Triggered by "סיכום עובדים", "מה כל עובד עשה", "עובדים היום", "ביצועי עובדים", "מי עשה מה". If the user names a specific worker ("סיכום של דני", "מה דני עשה היום") set params.workerName to that name; else leave params.workerName absent for the all-workers view. If the user names a date range ("השבוע", "אתמול", "מהשבוע שעבר", "בין 1/7 ל-3/7"), resolve to params.dateRange={from, to}. Default is today (omit dateRange). For "כמה עובדים בשטח היום" (quantitative), also set params.count_only=true.',
  '- search_task: user wants to search for a specific inspection/task. Set params.searchBy to one of: "customer" / "worker" / "product" / "address" / "phone" / "task_id" / "field_status", and params.query to the search term. Triggered by "חפש בדיקה של כהן" (searchBy=customer, query=כהן), "בדיקות של יוסי" (searchBy=worker, query=יוסי), "בדיקות מק"ט 10156" (searchBy=product, query=10156), "חפש לפי כתובת הרצל" (searchBy=address, query=הרצל), "בדיקות ברעננה" (searchBy=address, query=רעננה), "חפש לפי טלפון 054..." (searchBy=phone, query=054...), "מספר בדיקה 12345" (searchBy=task_id, query=12345), "בדיקות בסטטוס פתוח" (searchBy=field_status, query=ASSIGNED), "בדיקות שממתינות למידע" (searchBy=field_status, query=WAITING_FOR_INFO). If only intent is clear but neither dimension nor query: leave params empty and the router shows the search sub-menu.',
  // PROV-T5 (TASKS §4.20) — MANAGER-only. Enable OwnTracks GPS tracking for a worker.
  // IMPORTANT: task_reference MUST carry the worker name — including the family
  // name when the user typed one — so findUsersByName can resolve to a unique
  // User row without a follow-up question.
  '- enable_worker_location_tracking: manager enables live-location tracking for a worker by sending a magic link. Triggered by "הפעל מעקב מיקום ל<שם>", "לחבר את <שם> ל-OwnTracks", "לחבר את <שם> למעקב", "שלח ל<שם> קישור למעקב מיקום", "provision <שם>". ALWAYS put the worker\'s name as typed into task_reference (include family name when present). Example: "הפעל מעקב מיקום לגיא פרנסס" → task_reference="גיא פרנסס". If the user did not name a worker (e.g. plain "הפעל מעקב מיקום"), emit the intent with task_reference=null — the router will ask.',
  '',
  'For managers, ALSO support these worker intents (managers can also schedule, assign leads, correct, and view their own personal inspection list):',
  '- list_my_inspections, schedule_task_field, assign_lead, correct_task_field_site, reassign_task, correct_inspection_type, enable_worker_location_tracking',
  '- help, unknown',
  '',
  'ASSIGN_LEAD ONE-SHOT (Phase 6): For `assign_lead`, if the user names BOTH the source lead AND the target worker in one message (e.g. "לשייך את הליד של יוסי ללירן"), set params.leadRef="יוסי" (customer/subject substring) and params.assigneeName="לירן" (worker name substring). The router will pre-populate the flow with these hints and jump straight to the confirmation step when both look-ups resolve unambiguously. If only one hint is present, still emit it — the router will fall through to the normal multi-step flow.',
  // UX-T1: self-reference guidance so the AI never invents a Hebrew name for "me"/"myself".
  'SELF-REFERENCE: When the user says "אלי" / "לי" / "אותי" / "עצמי" / "לעצמי" in the context of an assignee/owner/worker (e.g. "שייך את הליד אלי", "תעביר לי את הבדיקה"), keep the LITERAL string "אלי" in params.assigneeName — do NOT invent a Hebrew name. Code-side logic detects this token and substitutes the current user identity.',
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
  '// My own inspections (manager\'s personal list) — "שלי"/"לי" phrasing, NOT org-wide',
  '- "המשימות שלי" → list_my_inspections, params.dateScope="today".',
  '- "הבדיקות שלי" → list_my_inspections, params.dateScope="today".',
  '- "הבדיקות שלי למחר" → list_my_inspections, params.dateScope="tomorrow".',
  '- "תציג לי את המשימות שלי למחר" → list_my_inspections, params.dateScope="tomorrow". [voice "תציג לי" prefix]',
  '- "המשימות שלי לשבוע הבא" → list_my_inspections, params.dateScope="next_week".',
  '- "המשימות שלי בין 1/7 ל-10/7" → list_my_inspections, params.rangeExpr="בין 1/7 ל-10/7".',
  '- "מה יש לי מחר" → list_my_inspections, params.dateScope="tomorrow".',
  '- "בדיקות שטח למחר" → list_today_field_inspections. [org-wide phrasing without "שלי" — contrast with the personal-list examples above; see the dynamic dateRange example in the date-range few-shot block below]',
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
  '// Search task — existing dimensions',
  '- "חפש בדיקה של כהן" → search_task, params.searchBy="customer", params.query="כהן".',
  '- "חפש לפי לקוח כהן" → search_task, params.searchBy="customer", params.query="כהן".',
  '- "בדיקות של יוסי" → search_task, params.searchBy="worker", params.query="יוסי".',
  '- "תחפש לי בדיקות של יוסי" → search_task, params.searchBy="worker", params.query="יוסי". [voice prefix]',
  '- "בדיקות מק"ט 10156" → search_task, params.searchBy="product", params.query="10156".',
  '- "חפש לפי מקט" → search_task. [no dimension or query → leave params empty, router shows sub-menu]',
  '',
  '// Search task — new dimensions (Phase 5)',
  '- "חפש לפי כתובת הרצל" → search_task, params.searchBy="address", params.query="הרצל".',
  '- "בדיקות ברעננה" → search_task, params.searchBy="address", params.query="רעננה".',
  '- "חפש לפי טלפון 054" → search_task, params.searchBy="phone", params.query="054".',
  '- "מספר בדיקה 12345" → search_task, params.searchBy="task_id", params.query="12345".',
  '- "בדיקות בסטטוס פתוח" → search_task, params.searchBy="field_status", params.query="ASSIGNED".',
  '- "בדיקות שממתינות למידע" → search_task, params.searchBy="field_status", params.query="WAITING_FOR_INFO".',
  '',
  '// count_only — quantitative questions (Phase 5)',
  '- "כמה בדיקות היום" → list_today_field_inspections, params.count_only=true.',
  '- "כמה חריגים" → list_open_exceptions, params.count_only=true, params.filter="open".',
  '- "כמה לידים לא שויכו" → list_pending_leads, params.count_only=true, params.filter="unassigned".',
  '- "כמה עובדים בשטח היום" → workers_day_overview, params.count_only=true.',
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
  '',
  '// PROV-T5 (TASKS §4.20) — enable OwnTracks tracking. task_reference MUST carry',
  '// the full worker name (including family) when the user typed it. Do NOT emit',
  '// with task_reference=null when the name IS present in the message.',
  '- "הפעל מעקב מיקום לדני" → enable_worker_location_tracking, task_reference="דני".',
  '- "הפעל מעקב מיקום לגיא פרנסס" → enable_worker_location_tracking, task_reference="גיא פרנסס". [full name — include the family name]',
  '- "הפעל מעקב מיקום לדני כהן" → enable_worker_location_tracking, task_reference="דני כהן". [full name — include the family name]',
  '- "לחבר את גיא פרנסס למעקב" → enable_worker_location_tracking, task_reference="גיא פרנסס".',
  '- "לחבר את דני ל-OwnTracks" → enable_worker_location_tracking, task_reference="דני".',
  '- "שלח לדני קישור למעקב מיקום" → enable_worker_location_tracking, task_reference="דני".',
  '- "provision דני" → enable_worker_location_tracking, task_reference="דני".',
  '- "הפעל מעקב מיקום" (no name) → enable_worker_location_tracking, task_reference=null. [router will ask]',
  '',
  '// Phase 6 — Voice colloquialisms + confirmation prefixes',
  '- "אה, תראה מה קורה" → management_snapshot. ["אה" is voice filler]',
  '- "יאללה תפריט" → open_manager_menu. [colloquial]',
  '- "כן, תראה חריגים" → list_open_exceptions, params.filter="open". [confirmation + intent]',
  '- "בטח תמונת מצב" → management_snapshot. [confirmation + intent]',
  '- "סליחה, חזור לתפריט" → open_manager_menu. [apology + command]',
  '- "אוקי, כמה בדיקות היום" → list_today_field_inspections, params.count_only=true.',
  '',
  '// Phase 6 — Exceptions filter synonyms',
  '- "בעיות שטח" → list_open_exceptions, params.filter="has_problem".',
  '- "בעייתיים" → list_open_exceptions, params.filter="has_problem".',
  '- "בדיקות בעייתיות" → list_open_exceptions, params.filter="has_problem".',
  '- "המתינות לאישור" → list_open_exceptions, params.filter="not_confirmed".',
  '- "בדיקות שלא אושרו" → list_open_exceptions, params.filter="not_confirmed".',
  '- "חסרות מידע" → list_open_exceptions, params.filter="waiting_for_info".',
  '- "עם חוסרים" → list_open_exceptions, params.filter="waiting_for_info".',
  '- "עדיין לא סגרו" → list_open_exceptions, params.filter="not_closed".',
  '',
  '// Phase 6 — Leads variants',
  '- "לידים בעיכוב" → list_pending_leads, params.filter="escalated".',
  '- "לידים עם עיכוב" → list_pending_leads, params.filter="escalated".',
  '- "לידים שעברו זמן" → list_pending_leads, params.filter="escalated".',
  '- "לידים חדשים" → list_pending_leads, params.filter="unassigned", clarification="לידים חדשים = לידים שלא שויכו לעובד. אם רצית משהו אחר, נסח שוב."',
  '- "לידים שלי" → list_pending_leads, params.filter="unassigned", clarification="נכון לעכשיו אני מציג את כל הלידים הפתוחים. סינון לפי בעל טיפול טרם נתמך."',
  '- "לידים של סשה" → list_pending_leads, params.filter="unassigned", clarification="נכון לעכשיו אני מציג את כל הלידים הפתוחים. סינון לפי בעל טיפול טרם נתמך."',
  '',
  '// Phase 6 — Structured assign_lead (one-shot: pre-populate both picks)',
  '- "לשייך את הליד של יוסי ללירן" → assign_lead, params.leadRef="יוסי", params.assigneeName="לירן".',
  '- "שיוך ליד של כהן לדני" → assign_lead, params.leadRef="כהן", params.assigneeName="דני".',
  '- "להקצות ליד לירדן" → assign_lead, params.assigneeName="ירדן". [no source hint → router falls back to normal flow]',
  '- "להעביר את הליד של אבנר ליוסי" → assign_lead, params.leadRef="אבנר", params.assigneeName="יוסי".',
  '',
  '// Phase 6 — Manager corrections richness',
  '- "להעביר לעובד יוסי את המשימה של כהן" → reassign_task, task_reference="כהן", params.newWorkerName="יוסי", requires_manager_approval=true.',
  '- "לתקן את הכתובת של רבקה" → correct_task_field_site, task_reference="רבקה".',
].join('\n');

/** Add `days` (may be negative) to a YYYY-MM-DD string. Noon-UTC anchor avoids DST edge cases. */
function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** 0=Sunday..6=Saturday for a YYYY-MM-DD string. */
function isoDayOfWeek(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

/**
 * D5-T19f: the date-range few-shot examples used to hardcode a specific
 * illustrative "today" (e.g. "2026-07-05"). That silently goes stale on
 * every OTHER day — it then directly contradicts the dynamically-injected
 * "Today (Asia/Jerusalem) is ${todayIsrael}" statement elsewhere in the same
 * prompt, and the LLM would sometimes resolve "אתמול" against the stale
 * example's implied date instead of the real one, emitting a dateRange for
 * the wrong day → zero matching rows → the router falls back to the generic
 * exceptions menu instead of a filtered list. Compute every example
 * relative to the REAL `todayIsrael` so this can never drift again.
 */
function buildDateRangeFewShot(todayIsrael: string): string {
  const yesterday = addDaysISO(todayIsrael, -1);
  const dayBeforeYesterday = addDaysISO(todayIsrael, -2);
  const tomorrow = addDaysISO(todayIsrael, 1);
  const dayAfterTomorrow = addDaysISO(todayIsrael, 2);
  const thisWeekSunday = addDaysISO(todayIsrael, -isoDayOfWeek(todayIsrael));
  const nextSunday = addDaysISO(thisWeekSunday, 7);
  const prevSunday = addDaysISO(thisWeekSunday, -7);
  return [
    '// Date-range scoping examples — computed relative to the REAL "Today" stated above. NEVER invent or hardcode a date here; always derive from today.',
    '',
    '// list_today_field_inspections — with date range (D5-T19g)',
    `- "בדיקות שטח של השבוע" → list_today_field_inspections, params.dateRange={from:"${thisWeekSunday}", to:"${nextSunday}"}.`,
    `- "בדיקות של אתמול" → list_today_field_inspections, params.dateRange={from:"${yesterday}", to:"${todayIsrael}"}.`,
    `- "בדיקות שטח למחר" → list_today_field_inspections, params.dateRange={from:"${tomorrow}", to:"${dayAfterTomorrow}"}. [org-wide "מחר" — contrast with list_my_inspections "המשימות שלי למחר" above, which is the manager's OWN list]`,
    '- "בדיקות בין 1/7 ל-3/7" → list_today_field_inspections, params.dateRange={from:"2026-07-01", to:"2026-07-04"}. [explicit literal dates — resolve verbatim, do NOT relate to today]',
    '',
    '// list_open_exceptions — with date range',
    `- "חריגים של אתמול" → list_open_exceptions, params.filter="open", params.dateRange={from:"${yesterday}", to:"${todayIsrael}"}.`,
    `- "מה בעיות היו אתמול" → list_open_exceptions, params.filter="has_problem", params.dateRange={from:"${yesterday}", to:"${todayIsrael}"}.`,
    `- "חריגים של השבוע" → list_open_exceptions, params.filter="open", params.dateRange={from:"${thisWeekSunday}", to:"${nextSunday}"}.`,
    '- "חריגים בין 1/7 ל-3/7" → list_open_exceptions, params.filter="open", params.dateRange={from:"2026-07-01", to:"2026-07-04"}. [explicit literal dates in the message itself — resolve those verbatim, do NOT relate them to today. 3/7 is the last inclusive day → +1 for exclusive to]',
    `- "מה קרה שלשום" → list_open_exceptions, params.filter="open", params.dateRange={from:"${dayBeforeYesterday}", to:"${yesterday}"}.`,
    '',
    '// list_pending_leads — with date range',
    `- "לידים של השבוע" → list_pending_leads, params.filter="unassigned", params.dateRange={from:"${thisWeekSunday}", to:"${nextSunday}"}.`,
    `- "לידים מהשבוע שעבר" → list_pending_leads, params.filter="unassigned", params.dateRange={from:"${prevSunday}", to:"${thisWeekSunday}"}.`,
    '',
    '// workers_day_overview — with date range',
    `- "מה כולם עשו השבוע" → workers_day_overview, params.dateRange={from:"${thisWeekSunday}", to:"${nextSunday}"}. [no workerName = all-workers]`,
    `- "סיכום של דני מהשבוע" → workers_day_overview, params.workerName="דני", params.dateRange={from:"${thisWeekSunday}", to:"${nextSunday}"}.`,
  ].join('\n');
}

/**
 * QA-FIX-7: shared list_my_inspections PAST-expression few-shot, used for
 * BOTH workers and managers (unlike `buildDateRangeFewShot`, which is
 * manager-only — it references org-wide manager intents like
 * list_today_field_inspections that workers don't have, so it isn't safe to
 * hand to the worker prompt wholesale). This tiny block only ever emits
 * list_my_inspections, which both roles have — so it's safe to share.
 * Static examples with hardcoded dates are forbidden outside this
 * "compute-from-real-today" style (see D5-T19f note above `buildDateRangeFewShot`).
 */
function buildMyInspectionsPastFewShot(todayIsrael: string): string {
  const yesterday = addDaysISO(todayIsrael, -1);
  const thisWeekSunday = addDaysISO(todayIsrael, -isoDayOfWeek(todayIsrael));
  const prevSunday = addDaysISO(thisWeekSunday, -7);
  return [
    '// list_my_inspections — PAST time expressions not covered by dateScope: resolve to params.dateRange yourself (computed relative to the REAL "Today" stated above; never hardcode a date).',
    `- "הבדיקות שלי אתמול" → list_my_inspections, params.dateRange={from:"${yesterday}", to:"${todayIsrael}"}.`,
    `- "המשימות שלי אתמול" → list_my_inspections, params.dateRange={from:"${yesterday}", to:"${todayIsrael}"}.`,
    `- "הבדיקות שלי בשבוע שעבר" → list_my_inspections, params.dateRange={from:"${prevSunday}", to:"${thisWeekSunday}"}.`,
    `- "מה היה לי אתמול" → list_my_inspections, params.dateRange={from:"${yesterday}", to:"${todayIsrael}"}.`,
  ].join('\n');
}

// CAL-WA — Outlook calendar intents. Shown to BOTH workers and managers, since
// any connected user with a linked Outlook account can manage their own calendar
// over WhatsApp (parity with the voice assistant's calendar tools). Times are
// resolved to ISO 8601 LOCAL wall time (Asia/Jerusalem, no Z / no offset) — the
// backend attaches the timezone.
const CALENDAR_INTENT_LIST = [
  'CALENDAR INTENTS (Outlook calendar of the CURRENT user — available to every user):',
  '- calendar_list: user wants to SEE their own calendar / upcoming meetings ("מה יש לי ביומן", "הפגישות שלי מחר", "מה יש לי השבוע ביומן", "יומן"). Optional params.days_ahead (number, default 7). If the user names a specific window resolve it to params.from_iso / params.to_iso (ISO 8601 local, no Z). This reads the OUTLOOK calendar — it is DIFFERENT from list_my_inspections (which lists field-inspection tasks). Prefer calendar_list when the user says "יומן" / "פגישה" / "פגישות" / "פגישות ביומן"; prefer list_my_inspections when they say "בדיקות" / "משימות".',
  '- calendar_create: user wants to ADD an event to their Outlook calendar ("קבע פגישה עם דנה מחר ב-3", "תוסיף ליומן פגישה עם הלקוח ביום ראשון ב-10 בבוקר"). REQUIRED: params.subject (string) and params.start_iso (ISO 8601 LOCAL wall time, e.g. "2026-07-20T15:00:00"). Optional: params.end_iso, params.duration_minutes (default 60 when no end), params.location, params.notes. If the subject or the start time is missing, still emit calendar_create but add the missing key(s) to missing_fields and write a Hebrew clarification.',
  '- calendar_update: user wants to CHANGE an existing event ("תזיז את הפגישה עם דנה ל-4", "עדכן את המיקום של הפגישה עם הלקוח לתל אביב", "שנה את הנושא של הפגישה מחר"). Identify the target with params.match (free text from the event subject) OR params.event_id if the user is replying about a specific event. Put the changed fields in params: subject, start_iso, end_iso, location, notes. If you cannot tell WHICH event, set params.match to your best guess (the backend disambiguates / asks).',
  '- calendar_delete: user wants to REMOVE / CANCEL an event ("תבטל את הפגישה עם דנה", "מחק מהיומן את הפגישה מחר", "תבטל את הפגישה עם הלקוח"). Identify the target with params.match (subject text) or params.event_id. The backend ALWAYS asks the user to confirm ("כן/לא") before deleting — you do NOT need requires_confirmation, just emit the intent with the match.',
].join('\n');

const CALENDAR_FEW_SHOT = [
  'HEBREW EXAMPLES — CALENDAR (Outlook). Today is used to resolve relative dates.',
  '',
  '// calendar_list',
  '- "מה יש לי ביומן" → calendar_list, params.days_ahead=7.',
  '- "מה יש לי ביומן מחר" / "הפגישות שלי מחר" → calendar_list, params.days_ahead=1.',
  '- "מה יש לי היום ביומן" → calendar_list, params.days_ahead=1.',
  '- "הפגישות שלי השבוע" → calendar_list, params.days_ahead=7.',
  '- "תראה לי את היומן" → calendar_list, params.days_ahead=7.',
  '',
  '// calendar_create',
  '- "קבע פגישה עם דנה מחר בשלוש" → calendar_create, params.subject="פגישה עם דנה", params.start_iso="<tomorrow>T15:00:00".',
  '- "תוסיף ליומן פגישה עם הלקוח ביום ראשון ב-10 בבוקר בתל אביב" → calendar_create, params.subject="פגישה עם הלקוח", params.start_iso="<sunday>T10:00:00", params.location="תל אביב".',
  '- "קבע לי פגישה מחר ב-9 לשעתיים" → calendar_create, params.subject="פגישה", params.start_iso="<tomorrow>T09:00:00", params.duration_minutes=120.',
  '- "תקבע פגישה" (no subject/time) → calendar_create, missing_fields=["subject","start_iso"], clarification="עם מי הפגישה ומתי?".',
  '',
  '// calendar_update',
  '- "תזיז את הפגישה עם דנה ל-4" → calendar_update, params.match="דנה", params.start_iso="<same day>T16:00:00".',
  '- "עדכן את המיקום של הפגישה עם הלקוח לרעננה" → calendar_update, params.match="הלקוח", params.location="רעננה".',
  '',
  '// calendar_delete',
  '- "תבטל את הפגישה עם דנה" → calendar_delete, params.match="דנה".',
  '- "מחק מהיומן את הפגישה מחר" → calendar_delete, params.match="מחר".',
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
      : 'This is a WORKER (field inspector). Prefer the worker intents (list_my_inspections, set_field_status, report_problem, report_missing_info, get_task). Manager dashboard / snapshot / org-wide list intents are NOT available for workers — if a worker asks for a general list of inspections, always use list_my_inspections (scoped to their own tasks); never emit a manager-side org-wide list intent for a worker.',
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
    '- MULTI-INTENT DETECTION: If the user message contains TWO OR MORE independent instructions',
    '  ("do X AND do Y", e.g. "לתזמן ולתקן את הכתובת", "תראה חריגים וגם לידים"),',
    '  still emit exactly ONE tool call — pick the FIRST intent and set clarification to:',
    '  "יש לך יותר מבקשה אחת. אבצע קודם: <תיאור הבקשה הראשונה>. שלח את הבקשה השנייה בהודעה נפרדת אחרי."',
    '  Do NOT try to execute both in one turn.',
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

  // Phase 2: when the user swipe-replied to a bot message, interpret the reply in
  // that message's context. Guides the AI toward existing intents; never invents.
  const quotedContextBlock = ctx.quotedContext
    ? `\nQUOTED-REPLY CONTEXT: the user swipe-replied to a previous bot message ` +
      `of type "${ctx.quotedContext.entityType}" (kind "${ctx.quotedContext.kind}").` +
      (ctx.quotedContext.payload ? ` Original-message context: ${JSON.stringify(ctx.quotedContext.payload)}.` : '') +
      ` Interpret the reply IN THAT CONTEXT.` +
      ` If the original was a field inspection (task_field) and the user reports progress ("יצאתי"/"הגעתי"/"סיימתי"), emit set_field_status with the matching transition.` +
      ` If the original was an equipment reminder and the user names missing equipment (e.g. "חסר לי מד רעש"), emit missing_equipment_free with params.note = the equipment described.` +
      ` When the reply does not clearly map to an allowed intent, prefer a short Hebrew clarification (intent=unknown) over guessing — never invent an action outside the tool.`
    : '';

  const sections = [
    intro,
    currentUserBlock,
    '',
    isMgr ? MANAGER_INTENT_LIST : WORKER_INTENT_LIST,
    '',
    // CAL-WA: calendar intents are available to every connected user (both roles).
    CALENDAR_INTENT_LIST,
    '',
    isMgr ? MANAGER_FEW_SHOT : WORKER_FEW_SHOT,
    '',
    CALENDAR_FEW_SHOT,
    '',
    buildMyInspectionsPastFewShot(todayIsrael),
    '',
    isMgr ? buildDateRangeFewShot(todayIsrael) : undefined,
    '',
    'help / unknown intents:',
    helpUnknownBlock,
    taskTypesBlock,
    safetyBlock,
    confidenceBlock,
    rulesBlock,
    historyBlock,
    pendingNoteBlock,
    quotedContextBlock,
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
