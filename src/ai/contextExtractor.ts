/**
 * Context-aware free-text extractor for awaiting states.
 *
 * Used by every "free-text await" state in router.ts when the user's input
 * does not match the rigid template (e.g. voice-transcribed Hebrew, polite
 * prefixes, natural phrasing).
 *
 * Contract:
 * - Never throws. On any error returns { values: {}, confidence: 0, clarification: null }.
 * - Confidence >= 0.85  → auto-apply (router decides; extractor just reports)
 * - Confidence 0.60-0.85 → show extracted values and ask user to confirm
 * - Confidence < 0.60    → fall back to rigid rejection message
 * - Uses the SAME LLM provider seam (getProvider()) — no new API keys.
 * - Provider param is injectable for testing (same pattern as leadSuggester.ts).
 */
import { getProvider, type LLMProvider } from './provider';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('context-extractor');

// ── Public types ──────────────────────────────────────────────────────────────

export interface ExtractionField {
  key: string;         // e.g. 'fieldContactPhone'
  labelHe: string;     // e.g. 'טלפון איש קשר'
  kind: 'string' | 'phone' | 'address' | 'number' | 'datetime' | 'text';
  required?: boolean;
}

/**
 * A single action extracted from a multi-action inspection_action intent.
 * Fields not relevant to the action are absent/undefined.
 */
export interface InspectionActionExtractionItem {
  action: 'correct_site' | 'correct_type' | 'reassign' | 'reschedule' | 'back' | 'cancel' | null;
  newSiteAddress?: string;
  newSiteCity?: string;
  newContactName?: string;
  newContactPhone?: string;
  newInspectionTypeQuery?: string;
  newWorkerName?: string;
  newScheduledStartAt?: string;   // ISO 8601 datetime
  newDurationMinutes?: number;
}

/**
 * Result of extracting multi-action from inspection_action intent.
 * actions: 0..N (ordered as the user requested them).
 * confidence: overall (min of per-action confidence, or 0 on failure).
 */
export interface InspectionActionExtraction {
  actions: InspectionActionExtractionItem[];
  confidence: number;
  clarification: string | null;
}

export type ExtractionIntent =
  | 'correct_site'
  | 'correct_type_search'
  | 'schedule_time'
  | 'schedule_duration'
  | 'search_query'
  | 'decline_reason'
  | 'missing_info_note'
  | 'equipment_missing_note'
  | 'problem_note'
  | 'field_notes'
  | 'inspection_action';

/** Current TaskField values passed to the 'inspection_action' extractor so the
 *  LLM can recognise references to existing contact/address values. */
export interface TaskFieldContextValues {
  customerName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  inspectionTypeLabel: string | null;
  workerName: string | null;
  // QA-FIX-3: current scheduled start of the TaskField the user is viewing.
  // Pre-formatted "YYYY-MM-DD HH:MM" in Asia/Jerusalem — used by the LLM to
  // default the date when a reschedule mentions only a time ("ל-21:00").
  currentScheduledStartAtIL?: string | null;
  currentDurationMinutes?: number | null;
}

export interface ExtractionRequest {
  /** Human message (possibly voice-transcribed). */
  message: string;
  /** What flow are we in? Used in system prompt to focus the LLM. */
  intent: ExtractionIntent;
  /** The fields the extractor should try to populate. */
  fields: ExtractionField[];
  /** Optional recent turns for reference resolution (oldest→newest). */
  history?: Array<{ role: 'user' | 'bot'; content: string }>;
  /** Optional current date to help resolve relative times ("מחר", "ראשון"). */
  todayIsoDate?: string;
  /**
   * Current TaskField field values — only relevant for intent='inspection_action'.
   * Passed so the LLM can recognise "מרונית לוי" as referring to the current
   * contact rather than treating it as a search term.
   */
  currentTaskFieldValues?: TaskFieldContextValues;
}

export interface ExtractionResult {
  /** Extracted values keyed by ExtractionRequest.fields[].key. Missing = not extracted. */
  values: Record<string, string | number | null>;
  /** Confidence in the extraction (0–1). */
  confidence: number;
  /** Hebrew clarification message if confidence is low (< 0.7). */
  clarification: string | null;
}

// ── Tool schemas ──────────────────────────────────────────────────────────────

/** Schema for multi-action inspection_action extraction. */
const EXTRACT_MULTI_ACTION_TOOL_NAME = 'extract_inspection_actions';
const EXTRACT_MULTI_ACTION_TOOL_DESCRIPTION =
  'Extract one or more structured actions from a free-text Hebrew message about an inspection. Return an array of actions (order = user request order), overall confidence, and optional clarification.';

const INSPECTION_ACTION_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: ['string', 'null'],
      enum: ['correct_site', 'correct_type', 'reassign', 'reschedule', 'back', 'cancel', null],
      description: 'The action type.',
    },
    newSiteAddress:         { type: ['string', 'null'], description: 'New site address (for correct_site).' },
    newSiteCity:            { type: ['string', 'null'], description: 'New site city (for correct_site).' },
    newContactName:         { type: ['string', 'null'], description: 'New contact name (for correct_site).' },
    newContactPhone:        { type: ['string', 'null'], description: 'New contact phone (for correct_site).' },
    newInspectionTypeQuery: { type: ['string', 'null'], description: 'Inspection type search query (for correct_type).' },
    newWorkerName:          { type: ['string', 'null'], description: 'New worker name (for reassign).' },
    newScheduledStartAt:    { type: ['string', 'null'], description: 'New scheduled start time ISO 8601 (for reschedule). Include timezone offset +03:00 for Israel.' },
    newDurationMinutes:     { type: ['number', 'null'], description: 'New duration in minutes (for reschedule, optional).' },
  },
  required: ['action'],
};

const EXTRACT_MULTI_ACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    actions: {
      type: 'array',
      description: 'Ordered list of extracted actions (0..N).',
      items: INSPECTION_ACTION_ITEM_SCHEMA,
    },
    confidence: {
      type: 'number',
      description: 'Overall confidence (min of per-action confidence), 0–1.',
    },
    clarification: {
      type: ['string', 'null'],
      description: 'Hebrew clarification when confidence < 0.7. null otherwise.',
    },
  },
  required: ['actions', 'confidence', 'clarification'],
};

const EXTRACT_TOOL_NAME = 'extract_context_fields';
const EXTRACT_TOOL_DESCRIPTION =
  'Extract structured field values from a free-text Hebrew message (possibly voice-transcribed). Return confidence 0–1 and the extracted values.';

const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    values: {
      type: 'object',
      description: 'Map of field key → extracted value (string, number, or null if not found).',
      additionalProperties: {
        oneOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'null' },
        ],
      },
    },
    confidence: {
      type: 'number',
      description: 'Confidence in the overall extraction, between 0 and 1.',
    },
    clarification: {
      type: ['string', 'null'],
      description: 'Hebrew clarification message when confidence < 0.7. null when confident.',
    },
  },
  required: ['values', 'confidence', 'clarification'],
};

// ── System prompts per intent ─────────────────────────────────────────────────

const BASE_SYSTEM_PREFIX = [
  'אתה עוזר לחלץ מידע מובנה מהודעה בעברית שנשלחה על ידי עובד שטח.',
  'ההודעה עשויה להיות תמלול של הודעה קולית — כלומר: ייתכנו קידומות מנומסות כמו "בבקשה", "אני רוצה", "תעדכן", "אפשר", "אני מבקש", "תוכל". התעלם מהן ומצא את הערך הרצוי.',
  'החזר רק את הערכים שזוהו בוודאות גבוהה. אם ערך לא זוהה, החזר null עבור אותו מפתח.',
  'רמת הביטחון (confidence): 0.0–1.0. 0.85+ = בטוח. 0.60–0.85 = ייתכן (הצג ואשר). מתחת ל-0.60 = לא זוהה.',
].join('\n');

/** Build the dynamic system-prompt block for intent='inspection_action'. */
function buildInspectionActionBlock(values?: TaskFieldContextValues): string {
  const currentValues = values
    ? [
        'ערכי הבדיקה הנוכחיים (לפני השינוי):',
        `- לקוח: ${values.customerName ?? '—'}`,
        `- שם איש קשר: ${values.contactName ?? '—'}`,
        `- טלפון איש קשר: ${values.contactPhone ?? '—'}`,
        `- כתובת אתר: ${values.siteAddress ?? '—'}`,
        `- עיר: ${values.siteCity ?? '—'}`,
        `- סוג בדיקה: ${values.inspectionTypeLabel ?? '—'}`,
        `- עובד משויך: ${values.workerName ?? '—'}`,
        `- תאריך ושעה נוכחיים (Asia/Jerusalem): ${values.currentScheduledStartAtIL ?? '—'}`,
        `- משך נוכחי (דקות): ${values.currentDurationMinutes ?? '—'}`,
      ].join('\n')
    : '';

  return [
    'המשתמש צופה בפרטי בדיקה ספציפית ושולח הודעה חופשית (כולל קולית).',
    'מטרתך: לזהות איזו פעולה (או פעולות) המשתמש רוצה לבצע על הבדיקה הנוכחית, ואילו ערכים חדשים הוא מספק.',
    '',
    'פעולות אפשריות (שדה "action"):',
    '- correct_site  → שינוי פרטי אתר: כתובת, עיר, שם איש קשר, טלפון איש קשר',
    '- correct_type  → שינוי סוג הבדיקה',
    '- reassign      → שיוך מחדש לעובד אחר',
    '- reschedule    → שינוי תאריך ושעה (ואופציונלית משך) של הבדיקה',
    '- back          → חזרה לרשימה הקודמת',
    '- cancel        → ביטול / עצור',
    '',
    'פעולות שאינן זמינות מהבוט (שדות שרק ב-CRM ניתן לערוך):',
    '- כותרת המשימה (title)',
    '- תיאור/הערות המשימה (description)',
    '- הערות מיוחדות של בדיקת שטח (TaskField.specialInstructions)',
    '- סטטוס משימה (Task.status) — הבוט מנהל רק את fieldStatus של הבדיקה',
    '- שדות מסחריים (מחיר, תשלום)',
    '- לקוח / ליד / פרויקט של המשימה (שיוך FK)',
    'אם המשתמש מבקש לערוך אחד מהשדות הללו ("עדכן הערות", "שנה כותרת", "שנה תיאור", "עדכן סטטוס משימה", "החלף לקוח"), החזר action=null, confidence < 0.60, ובשדה clarification הסבר בעברית ידידותי מדוע זה לא זמין ומה כן ניתן לעשות מכאן. דוגמה: "עדכון ההערות/כותרת/תיאור של המשימה זמין רק ב-CRM ולא מהבוט. מכאן אפשר לתקן פרטי אתר, לשנות סוג בדיקה, לשייך מחדש, או לשנות תאריך/שעה." — התאם את הנוסח לפי מה שהמשתמש ביקש.',
    '',
    currentValues,
    '',
    'כללים חשובים — פעולה יחידה:',
    '- אם המשתמש מזכיר שם/טלפון של איש קשר קיים (כפי שמופיע בערכים הנוכחיים) — זה הקשר לאישור, לא מונח חיפוש לזיהוי המשימה. המשתמש כבר מסתכל על הבדיקה הנכונה.',
    '- "החלף את איש הקשר מ-X ל-Y" → action=correct_site, newContactName=Y (ו-newContactPhone אם ניתן טלפון).',
    '- "שנה את הכתובת ל..." → action=correct_site, newSiteAddress=<הערך>, newSiteCity=<עיר אם צוינה>.',
    '- "לשייך מחדש ל..." → action=reassign, newWorkerName=<השם>.',
    '- "שנה סוג בדיקה ל..." → action=correct_type, newInspectionTypeQuery=<הערך>.',
    '- "תשנה תאריך ושעה ל-11/7 14:00" → action=reschedule, newScheduledStartAt="2026-07-11T14:00:00+03:00".',
    '- "לתזמן מחדש למחר בעשר" → action=reschedule, newScheduledStartAt=<מחר T10:00:00+03:00>.',
    '- "להזיז את הבדיקה ל-..." / "לדחות ל-..." / "תעביר ל-..." → action=reschedule.',
    '- "שעה וחצי" / "90 דקות" / "שעתיים" → newDurationMinutes (60/90/120 וכו\').',
    '- תאריך יחסי: "מחר" = יום הבא, "יום ראשון" = ראשון הבא, "ב-10" / "בעשר" = 10:00.',
    '- אם ניתן תאריך בלבד ללא שעה — confidence < 0.60 (בקש הבהרה).',
    // QA-FIX-3: time-only reschedule must default the date to the current TF's date.
    '- **אם ניתנה שעה בלבד ללא תאריך** (למשל "עדכן שעה ל-21:00", "תעביר ל-9:30", "תזמן ל-14:00") →',
    '    action=reschedule, newScheduledStartAt = **אותו התאריך של הבדיקה הנוכחית** (השדה "תאריך ושעה נוכחיים" למעלה) עם השעה החדשה, offset +03:00.',
    '    זו פעולה תקינה עם confidence >= 0.85 — אל תבקש הבהרה.',
    '    דוגמה: אם הבדיקה הנוכחית ב-2026-07-07 22:00 והמשתמש כותב "עדכן שעה ל-21:00" → newScheduledStartAt="2026-07-07T21:00:00+03:00".',
    '    אם הבדיקה הנוכחית ריקה/לא ידועה — השתמש בתאריך היום.',
    '- "חזרה" / "תחזור" / "4" → action=back.',
    '- "ביטול" / "עצור" → action=cancel.',
    '- אם אינך בטוח מה הפעולה — החזר confidence נמוך מ-0.60.',
    '- לא ניתן לזהות פעולה ברורה — החזר action=null, confidence < 0.60.',
    '',
    'כללים חשובים — מספר פעולות בהודעה אחת:',
    'המשתמש יכול לבקש מספר שינויים בהודעה אחת. במקרה כזה, החזר מערך של פעולות לפי סדר הבקשה.',
    'דוגמאות:',
    '"תשנה את הכתובת לרוטשילד 15 ותשייך את זה לדני" →',
    '  actions: [{ action: "correct_site", newSiteAddress: "רוטשילד 15" }, { action: "reassign", newWorkerName: "דני" }]',
    '"תשנה את סוג הבדיקה לקרינה ואת איש הקשר לגל, 050-XXX" →',
    '  actions: [{ action: "correct_type", newInspectionTypeQuery: "קרינה" }, { action: "correct_site", newContactName: "גל", newContactPhone: "050-XXX" }]',
    '',
    'אם הפעולות זהות עם שדות שונים באותה קטגוריה (למשל: כתובת + איש קשר) — אחד את השדות באותה פעולה אחת:',
    '"תשנה את הכתובת לרוטשילד 15 ואת איש הקשר לגל" →',
    '  actions: [{ action: "correct_site", newSiteAddress: "רוטשילד 15", newContactName: "גל" }]',
    '',
    'אל תפרק פעולה אחת ל-2 בגלל שיש כמה שדות —',
    '"תשנה את איש הקשר לגל ואת הטלפון ל-050-XXX" זו פעולה אחת (correct_site עם 2 שדות).',
  ].join('\n');
}

function buildSystemPrompt(req: ExtractionRequest): string {
  const intentBlock = req.intent === 'inspection_action'
    ? buildInspectionActionBlock(req.currentTaskFieldValues)
    : (INTENT_SYSTEM_BLOCKS[req.intent] ?? '');
  const fieldList = req.fields.map((f) => `- ${f.key} (${f.labelHe}, סוג: ${f.kind})`).join('\n');
  const todayBlock = req.todayIsoDate ? `\nתאריך היום: ${req.todayIsoDate}` : '';

  return [
    BASE_SYSTEM_PREFIX,
    '',
    intentBlock,
    '',
    `שדות לחלץ:`,
    fieldList,
    todayBlock,
  ].join('\n');
}

const INTENT_SYSTEM_BLOCKS: Record<ExtractionIntent, string> = {
  correct_site: [
    'המשתמש מתקן נתוני אתר של בדיקת שטח (TaskField).',
    'השדות האפשריים: כתובת אתר (siteAddress), עיר (siteCity), שם איש קשר (fieldContactName), טלפון איש קשר (fieldContactPhone).',
    'דוגמאות לפרזות קוליות מקובלות:',
    '- "אני רוצה לעדכן את הטלפון של איש הקשר ל-050-1234567" → fieldContactPhone = "050-1234567"',
    '- "הכתובת האמיתית היא רוטשילד 15 תל אביב" → siteAddress = "רוטשילד 15 תל אביב"',
    '- "השם של איש הקשר הוא משה כהן" → fieldContactName = "משה כהן"',
    '- "העיר היא רעננה" → siteCity = "רעננה"',
    'אם ההודעה אינה מתייחסת לאף שדה מוכר (למשל "שלום"), החזר confidence נמוך מ-0.4.',
    'אם ברור מה המשתמש רוצה לעדכן אך לא ברור לאיזה שדה, החזר confidence 0.4–0.6.',
    'לטלפון: שמור את הספרות המקוריות כולל מקפים/רווחים אם יש.',
  ].join('\n'),

  correct_type_search: [
    'המשתמש מחפש סוג בדיקה לתיקון. חלץ את מונח החיפוש (שם מוצר, מק"ט, תיאור).',
    'הסר קידומות מנומסות ומשפטי הקדמה.',
    'דוגמה: "אני מחפש את בדיקת הקרינה" → search_query = "קרינה"',
  ].join('\n'),

  schedule_time: [
    'המשתמש מציין תאריך ושעה לתזמון בדיקה.',
    'חלץ תאריך + שעה כ-ISO 8601 (YYYY-MM-DDTHH:MM:SS+03:00).',
    'ביטויים יחסיים: "מחר" = מחר, "יום ראשון" = ראשון הבא, "ב-10" / "בעשר" = 10:00.',
    'אם חסר תאריך או שעה, החזר confidence נמוך.',
  ].join('\n'),

  schedule_duration: [
    'המשתמש מציין משך בדיקה (בדקות).',
    'חלץ מספר דקות שלם:',
    '- "שעה" → 60',
    '- "שעה וחצי" / "שעה ו-30" → 90',
    '- "שעתיים" → 120',
    '- "45 דקות" / "45" → 45',
    '- "שעה ו-45" → 105',
    '- "אישור" / "ברירת מחדל" → null (המשתמש מקבל את ברירת המחדל, confidence 1.0)',
    'דוגמה: "שעה וחצי" → duration_minutes = 90',
  ].join('\n'),

  search_query: [
    'המשתמש מזין שאילתת חיפוש (שם לקוח, שם עובד, קוד מוצר, וכו\').',
    'חלץ את מונח החיפוש הנקי לאחר הסרת קידומות מנומסות.',
    'דוגמה: "אני מחפש את כהן" → query = "כהן"',
  ].join('\n'),

  decline_reason: [
    'המשתמש נותן סיבה לדחיית בדיקה.',
    'כל תשובה שאינה ריקה מקובלת. הסר קידומות מנומסות בלבד.',
    'confidence תמיד >= 0.85 כאשר יש תוכן.',
    'דוגמה: "אני לא יכול להגיע בגלל חוסר ציוד" → reason = "לא יכול להגיע בגלל חוסר ציוד"',
  ].join('\n'),

  missing_info_note: [
    'המשתמש מתאר מה חסר לו לפני שיוכל לסיים את הבדיקה.',
    'כל תשובה שאינה ריקה מקובלת. הסר קידומות מנומסות.',
    'confidence תמיד >= 0.85 כאשר יש תוכן.',
  ].join('\n'),

  equipment_missing_note: [
    'המשתמש מתאר איזה ציוד חסר לו.',
    'כל תשובה שאינה ריקה מקובלת. הסר קידומות מנומסות.',
    'confidence תמיד >= 0.85 כאשר יש תוכן.',
  ].join('\n'),

  problem_note: [
    'המשתמש מתאר בעיה שנתקל בה בשטח.',
    'כל תשובה שאינה ריקה מקובלת. הסר קידומות מנומסות.',
    'confidence תמיד >= 0.85 כאשר יש תוכן.',
  ].join('\n'),

  field_notes: [
    'המשתמש כותב הערות שטח על הבדיקה שסיים.',
    'כל תשובה שאינה ריקה מקובלת. הסר קידומות מנומסות.',
    'confidence תמיד >= 0.85 כאשר יש תוכן.',
  ].join('\n'),

  inspection_action: '', // built dynamically via buildInspectionActionBlock()
};

// ── User message builder ──────────────────────────────────────────────────────

function buildUserMessage(req: ExtractionRequest): string {
  const historyBlock = req.history && req.history.length > 0
    ? [
        'היסטוריית שיחה (3-5 תורות אחרונות):',
        ...req.history.map((t) => `${t.role === 'bot' ? 'בוט' : 'משתמש'}: ${t.content}`),
        '',
      ].join('\n')
    : '';

  const fieldKeys = req.fields.map((f) => f.key).join(', ');

  return [
    historyBlock,
    `הודעת המשתמש: "${req.message}"`,
    '',
    `חלץ את השדות הבאים: ${fieldKeys}`,
    'החזר null עבור שדות שלא זוהו.',
  ].join('\n');
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Extract structured fields from a possibly-noisy Hebrew message.
 *
 * The `provider` param is injectable for tests (same pattern as leadSuggester).
 * Defaults to getProvider() so real callers pass just one arg.
 */
export async function extractFromContext(
  req: ExtractionRequest,
  provider: LLMProvider | null = getProvider(),
): Promise<ExtractionResult> {
  const empty: ExtractionResult = { values: {}, confidence: 0, clarification: null };

  if (!provider) {
    log.debug({ intent: req.intent }, 'context extractor: no provider configured — returning empty');
    return empty;
  }

  if (!req.message.trim()) {
    return empty;
  }

  let raw: Record<string, unknown>;
  try {
    raw = await provider.emitStructured({
      system: buildSystemPrompt(req),
      user: buildUserMessage(req),
      toolName: EXTRACT_TOOL_NAME,
      toolDescription: EXTRACT_TOOL_DESCRIPTION,
      schema: EXTRACT_SCHEMA,
    });
  } catch (err) {
    log.error({ err, intent: req.intent }, 'context extractor: provider call failed');
    return empty;
  }

  // Validate and coerce the raw response.
  const confidence = typeof raw.confidence === 'number'
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0;

  const rawValues = raw.values;
  if (typeof rawValues !== 'object' || rawValues === null || Array.isArray(rawValues)) {
    log.warn({ raw, intent: req.intent }, 'context extractor: invalid values shape');
    return empty;
  }

  const values: Record<string, string | number | null> = {};
  for (const field of req.fields) {
    const v = (rawValues as Record<string, unknown>)[field.key];
    if (v === null || v === undefined) {
      values[field.key] = null;
    } else if (typeof v === 'string') {
      values[field.key] = v.trim() || null;
    } else if (typeof v === 'number') {
      values[field.key] = v;
    } else {
      values[field.key] = null;
    }
  }

  const clarification =
    confidence < 0.7 && typeof raw.clarification === 'string' && raw.clarification.trim()
      ? raw.clarification.trim()
      : null;

  return { values, confidence, clarification };
}

// ── Multi-action extractor for inspection_action ──────────────────────────────

/** Build the system prompt for multi-action inspection_action extraction. */
function buildMultiActionSystemPrompt(currentTaskFieldValues?: TaskFieldContextValues): string {
  return [
    BASE_SYSTEM_PREFIX,
    '',
    buildInspectionActionBlock(currentTaskFieldValues),
  ].join('\n');
}

/** Build the user message for multi-action extraction. */
function buildMultiActionUserMessage(
  message: string,
  history?: Array<{ role: 'user' | 'bot'; content: string }>,
): string {
  const historyBlock = history && history.length > 0
    ? [
        'היסטוריית שיחה (3-5 תורות אחרונות):',
        ...history.map((t) => `${t.role === 'bot' ? 'בוט' : 'משתמש'}: ${t.content}`),
        '',
      ].join('\n')
    : '';

  return [
    historyBlock,
    `הודעת המשתמש: "${message}"`,
    '',
    'זהה את כל הפעולות המבוקשות. החזר מערך "actions" לפי סדר הבקשה.',
    'אם אין פעולה ברורה — החזר actions: [], confidence < 0.60.',
  ].join('\n');
}

/**
 * Extract zero or more inspection actions from a single free-text message.
 *
 * Returns an `InspectionActionExtraction` — never throws.
 * The `provider` param is injectable for tests.
 */
export async function extractInspectionActions(
  message: string,
  currentTaskFieldValues?: TaskFieldContextValues,
  history?: Array<{ role: 'user' | 'bot'; content: string }>,
  provider: LLMProvider | null = getProvider(),
): Promise<InspectionActionExtraction> {
  const empty: InspectionActionExtraction = { actions: [], confidence: 0, clarification: null };

  if (!provider) {
    log.debug('extractInspectionActions: no provider configured — returning empty');
    return empty;
  }

  if (!message.trim()) return empty;

  let raw: Record<string, unknown>;
  try {
    raw = await provider.emitStructured({
      system: buildMultiActionSystemPrompt(currentTaskFieldValues),
      user: buildMultiActionUserMessage(message, history),
      toolName: EXTRACT_MULTI_ACTION_TOOL_NAME,
      toolDescription: EXTRACT_MULTI_ACTION_TOOL_DESCRIPTION,
      schema: EXTRACT_MULTI_ACTION_SCHEMA,
    });
  } catch (err) {
    log.error({ err }, 'extractInspectionActions: provider call failed');
    return empty;
  }

  const confidence = typeof raw.confidence === 'number'
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0;

  const clarification =
    confidence < 0.7 && typeof raw.clarification === 'string' && raw.clarification.trim()
      ? raw.clarification.trim()
      : null;

  // Normalize the actions array — accept both array and legacy single-object shape.
  let rawActions: unknown[];
  if (Array.isArray(raw.actions)) {
    rawActions = raw.actions;
  } else if (raw.actions !== null && raw.actions !== undefined) {
    // Graceful: wrap a single object if the LLM returned one accidentally.
    rawActions = [raw.actions];
  } else {
    return { actions: [], confidence, clarification };
  }

  const actions: InspectionActionExtractionItem[] = [];
  for (const item of rawActions) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const action = (typeof obj.action === 'string' ? obj.action.trim() : null) as
      InspectionActionExtractionItem['action'];

    const str = (key: string): string | undefined => {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      return undefined;
    };

    const numVal = (key: string): number | undefined => {
      const v = obj[key];
      if (typeof v === 'number' && isFinite(v)) return v;
      return undefined;
    };

    actions.push({
      action,
      newSiteAddress:         str('newSiteAddress'),
      newSiteCity:            str('newSiteCity'),
      newContactName:         str('newContactName'),
      newContactPhone:        str('newContactPhone'),
      newInspectionTypeQuery: str('newInspectionTypeQuery'),
      newWorkerName:          str('newWorkerName'),
      newScheduledStartAt:    str('newScheduledStartAt'),
      newDurationMinutes:     numVal('newDurationMinutes'),
    });
  }

  return { actions, confidence, clarification };
}

// ── Convenience: extract a single "note" field from any free-text note intent ─
// Used by the "always accept" handlers (decline reason, notes, etc.).
// Returns the cleaned note string, or null when confidence < 0.4.

export async function extractNote(
  message: string,
  intent: Extract<
    ExtractionIntent,
    'decline_reason' | 'missing_info_note' | 'equipment_missing_note' | 'problem_note' | 'field_notes'
  >,
  provider: LLMProvider | null = getProvider(),
): Promise<string | null> {
  if (!message.trim()) return null;

  const result = await extractFromContext(
    {
      message,
      intent,
      fields: [{ key: 'note', labelHe: 'הערה', kind: 'text', required: true }],
    },
    provider,
  );

  if (result.confidence < 0.4) return null;
  const val = result.values.note;
  if (typeof val === 'string' && val.trim()) return val.trim();
  // Provider returned high confidence but no note — fall back to original message.
  return message.trim() || null;
}
