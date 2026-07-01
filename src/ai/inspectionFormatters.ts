/**
 * Shared display helpers for manager-menu inspection list rows and detail views.
 *
 * Bug 2 fix: replaces the old dense pipe-separated format with a cleaner
 * 2-line list row and a structured detail block.
 *
 * Rules:
 *  - hebrewShortLabel   — strips emoji prefix + CRM trailing " — <name> — <date>"
 *                         from Task.title; falls back to InspectionType.labelHe.
 *  - formatHebrewDateTime — returns "א׳ 01/07/2026, 09:00" (Hebrew DOW + IL tz).
 *  - formatInspectionListRow — returns the 2-line row for a numbered list.
 *  - formatInspectionDetail  — returns the full detail block.
 *  - formatLeadListRow       — returns the 2-line row for a lead in a numbered list.
 */

// ── Hebrew day-of-week abbreviations ─────────────────────────────────────────

const HE_DOW: Record<number, string> = {
  0: 'א׳',  // Sunday
  1: 'ב׳',  // Monday
  2: 'ג׳',  // Tuesday
  3: 'ד׳',  // Wednesday
  4: 'ה׳',  // Thursday
  5: 'ו׳',  // Friday
  6: 'ש׳',  // Saturday
};

// ── Hebrew field-status labels ────────────────────────────────────────────────

export const FIELD_STATUS_HE: Record<string, string> = {
  ASSIGNED:        'משובצת',
  CONFIRMED:       'אושרה',
  EN_ROUTE:        'בדרך',
  ARRIVED:         'באתר',
  WAITING_FOR_INFO:'ממתין למידע',
  HAS_PROBLEM:     'עם בעיה',
  NEEDS_MORE_INFO: 'צריך פרטים',
  FINISHED_FIELD:  'הסתיים בשטח',
  DECLINED:        'דחה',
  CANCELED:        'בוטל',
};

export function fieldStatusHe(status: string): string {
  return FIELD_STATUS_HE[status] ?? status;
}

// ── hebrewShortLabel ──────────────────────────────────────────────────────────

// Emoji prefix: one or more emoji/variant-selector/ZWJ chars
const EMOJI_PREFIX_RE = /^[\p{Emoji}️‍︎]+\s*/u;

// CRM trailing suffix: " — <name> — <YYYY-MM-DD>" (Hebrew em-dash "—" or ASCII "--")
// The CRM appends exactly this pattern to auto-generated Task titles.
const CRM_SUFFIX_RE = /\s*[—\-]{1,2}\s*[^—\-]+\s*[—\-]{1,2}\s*\d{4}-\d{2}-\d{2}\s*$/u;

/**
 * Derive a clean, FULL inspection label from the raw Task.title.
 *
 * Product owner: show the full inspection type text — do NOT truncate.
 *
 * Steps:
 *   1. Strip leading emoji characters (CRM adds e.g. "🧪" prefix).
 *   2. Strip trailing CRM auto-suffix " — <worker> — <yyyy-mm-dd>".
 *   3. If the remaining string is empty or only whitespace, fall back to
 *      `inspectionTypeLabelHe` (the InspectionType.labelHe field).
 *   4. Return the full text verbatim — NO truncation.
 */
export function hebrewShortLabel(
  taskTitle: string | null | undefined,
  inspectionTypeLabelHe: string,
): string {
  if (!taskTitle || !taskTitle.trim()) return inspectionTypeLabelHe;

  let label = taskTitle.trim();
  label = label.replace(EMOJI_PREFIX_RE, '').trim();
  label = label.replace(CRM_SUFFIX_RE, '').trim();

  return label || inspectionTypeLabelHe;
}

// ── formatHebrewDateTime ──────────────────────────────────────────────────────

/**
 * Format a timestamp as Hebrew day-of-week abbreviation + "DD/MM/YYYY, HH:MM"
 * in Asia/Jerusalem timezone.
 *
 * Example: "א׳ 01/07/2026, 09:00"
 */
export function formatHebrewDateTime(d: Date | string): string {
  const date = new Date(d);

  // Day of week (0=Sun)
  const dowNum = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'short',
  }).formatToParts(date).find((p) => p.type === 'weekday');
  // Use numeric DOW via a fixed-order trick
  const dow = HE_DOW[getDowJerusalem(date)] ?? '';

  const parts = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const dd   = get('day');
  const mm   = get('month');
  const yyyy = get('year');
  const hh   = get('hour');
  const min  = get('minute');

  // Suppress the unused variable warning
  void dowNum;

  return `${dow} ${dd}/${mm}/${yyyy}, ${hh}:${min}`;
}

/** Returns 0 (Sun)…6 (Sat) for a Date in Asia/Jerusalem. */
function getDowJerusalem(d: Date): number {
  // Use en-CA (YYYY-MM-DD) to get the local date string, then compute DOW
  const localDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  // Build a date at noon UTC so getDay() matches the local day
  const localDate = new Date(localDateStr + 'T12:00:00Z');
  return localDate.getDay();
}

// ── Label vocabulary (used across this file and by importers) ────────────────

/** Standard Hebrew label vocabulary — use these exact strings everywhere. */
export const LABELS = {
  TYPE:          'סוג בדיקה',
  WORKER:        'שם עובד',
  CUSTOMER:      'שם לקוח',
  ADDRESS:       'כתובת האתר',
  CITY:          'עיר',
  CONTACT:       'איש קשר',
  CONTACT_PHONE: 'טלפון איש קשר',
  CONTACT_NAME:  'שם איש קשר',
  DATE:          'תאריך',
  TIME:          'שעה',
  DATETIME:      'תאריך ושעה',
  DURATION:      'משך',
  STATUS:        'סטטוס',
  PRIORITY:      'דחיפות',
  NOTES:         'הערות',
  NAV:           'ניווט',
  EQUIPMENT:     'ציוד נדרש',
} as const;

/** Standard null-value placeholders for DETAIL views. */
export const PLACEHOLDERS = {
  CUSTOMER:      'אין פרטי לקוח',
  CONTACT:       'אין פרטי איש קשר',
  CONTACT_NAME:  'אין שם איש קשר',
  CONTACT_PHONE: 'אין טלפון איש קשר',
  ADDRESS:       'אין כתובת רשומה',
  CITY:          'אין עיר רשומה',
  DEFAULT:       'לא צוין',
} as const;

/**
 * Return `value` if non-null/non-empty, else `placeholder`.
 * Used in detail views to show an explicit Hebrew "no info" sentence.
 */
export const withPlaceholder = (
  value: string | null | undefined,
  placeholder: string,
): string => (value != null && value.trim().length > 0) ? value : placeholder;

// ── formatInspectionListRow ───────────────────────────────────────────────────

export interface InspectionListRowData {
  taskTitle: string | null;
  typeLabelHe: string;
  timeHm: string | null;          // "HH:MM" already in Jerusalem time
  siteCity: string | null;
  fieldStatus: string;
  workerName?: string | null;     // included only when the search is NOT by worker
  scheduledStartAt?: Date | string | null;  // for DD/MM when timeHm is unavailable
  dateStr?: string | null;        // "YYYY-MM-DD" already in local tz (from today's list)
}

/**
 * Format an inspection list row with ONE FIELD PER LINE (product owner UX rule):
 *
 *   סוג בדיקה: בדיקת רעש ממעלית
 *   תאריך: 01/07
 *   שעה: 09:00
 *   עיר: רמת גן
 *   סטטוס: משובצת
 *
 * The row does NOT include the leading "N. " numbering — the caller prepends
 * that before "סוג בדיקה" and joins rows with a blank line between them.
 *
 * Blank line between rows is NOT inserted here — the caller joins with "\n\n".
 *
 * @param row           row data
 * @param showWorker    if true, add a "שם עובד" line (for product/customer searches)
 */
export function formatInspectionListRow(
  row: InspectionListRowData,
  showWorker = false,
): string {
  const label = hebrewShortLabel(row.taskTitle, row.typeLabelHe);

  // Date part: prefer dateStr ("YYYY-MM-DD" → "DD/MM"), else derive from scheduledStartAt
  let ddmm = '';
  if (row.dateStr) {
    const m = row.dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) ddmm = `${m[3]}/${m[2]}`;
  } else if (row.scheduledStartAt) {
    const d = new Date(row.scheduledStartAt);
    const parts = new Intl.DateTimeFormat('he-IL', {
      timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit',
    }).formatToParts(d);
    const day   = parts.find((p) => p.type === 'day')?.value ?? '';
    const month = parts.find((p) => p.type === 'month')?.value ?? '';
    if (day && month) ddmm = `${day}/${month}`;
  }

  // One field per line, no indent inside the row (caller controls the numbering)
  const lines: string[] = [`${LABELS.TYPE}: ${label}`];
  if (ddmm) lines.push(`${LABELS.DATE}: ${ddmm}`);
  lines.push(`${LABELS.TIME}: ${row.timeHm ?? '--:--'}`);
  if (row.siteCity) lines.push(`${LABELS.CITY}: ${row.siteCity}`);
  lines.push(`${LABELS.STATUS}: ${fieldStatusHe(row.fieldStatus)}`);
  if (showWorker && row.workerName) lines.push(`${LABELS.WORKER}: ${row.workerName}`);

  return lines.join('\n');
}

// ── formatInspectionDetail ────────────────────────────────────────────────────

export interface InspectionDetailData {
  taskTitle: string | null;
  typeLabelHe: string;
  workerName: string | null;
  customerName: string | null;
  siteAddress: string | null;
  siteCity: string | null;
  fieldContactName: string | null;
  fieldContactPhone: string | null;
  fieldStatus: string;
  scheduledStartAt: Date | string | null;
  specialInstructions: string | null;
  fieldNotes: string | null;
  problemNote: string | null;
}

/**
 * Format the full detail block for a single TaskField, including the action prompt.
 *
 * Output (all fields always shown in detail view; null → Hebrew placeholder):
 *
 *   בדיקת רעש ממעלית
 *
 *   סוג בדיקה:    בדיקת רעש ממעלית
 *   שם עובד:      יאיר
 *   שם לקוח:      משה כהן
 *   כתובת האתר:   רחוב ביאליק 5, רמת גן
 *   איש קשר:      משה כהן, 050-1234567
 *   תאריך ושעה:   א׳ 01/07/2026, 09:00
 *   סטטוס:        משובצת
 *
 *   הערות:        ← only when notes exist
 *   ...
 *
 *   מה תרצה לעשות?
 *   1. תיקון פרטי ביקור
 *   ...
 */
export function formatInspectionDetail(
  row: InspectionDetailData,
  actionsPrompt: string,
): string {
  const label = hebrewShortLabel(row.taskTitle, row.typeLabelHe);

  // No unlabeled hero title — every value gets a descriptive label per the
  // "label everything" rule. The first line is the labeled "סוג בדיקה:".
  const lines: string[] = [];

  // Labeled fields — right-pad label+colon to 14 chars for visual alignment
  const pad = (lbl: string) => `${lbl}:`.padEnd(14);

  lines.push(`${pad(LABELS.TYPE)}${label}`);

  if (row.workerName) {
    lines.push(`${pad(LABELS.WORKER)}${row.workerName}`);
  }

  // Customer — always shown in detail view; null → explicit placeholder
  lines.push(`${pad(LABELS.CUSTOMER)}${withPlaceholder(row.customerName, PLACEHOLDERS.CUSTOMER)}`);

  // Address — always shown; null → explicit placeholder
  const address = [row.siteAddress, row.siteCity].filter(Boolean).join(', ');
  lines.push(`${pad(LABELS.ADDRESS)}${address || PLACEHOLDERS.ADDRESS}`);

  // Contact — always shown; null → explicit placeholder
  const contact = [row.fieldContactName, row.fieldContactPhone].filter(Boolean).join(', ');
  lines.push(`${pad(LABELS.CONTACT)}${contact || PLACEHOLDERS.CONTACT}`);

  if (row.scheduledStartAt) {
    lines.push(`${pad(LABELS.DATETIME)}${formatHebrewDateTime(row.scheduledStartAt)}`);
  }

  lines.push(`${pad(LABELS.STATUS)}${fieldStatusHe(row.fieldStatus)}`);

  // Notes section — combine specialInstructions + fieldNotes + problemNote
  // Omit entire block when there are no notes (inherently optional)
  const noteParts = [
    row.specialInstructions,
    row.fieldNotes,
    row.problemNote,
  ].filter(Boolean) as string[];

  if (noteParts.length > 0) {
    lines.push('', `${LABELS.NOTES}:\n${noteParts.join(' | ')}`);
  }

  lines.push('', actionsPrompt);

  return lines.join('\n');
}

// ── formatLeadListRow ─────────────────────────────────────────────────────────

export interface LeadListRowData {
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  receivedAt: Date | string | null;
}

/** Lead vocabulary labels */
export const LEAD_LABELS = {
  SENDER:     'שולח',
  SUBJECT:    'נושא',
  BODY:       'תוכן',
  SUGGESTION: 'הצעת שיבוץ',
  RECEIVED:   'התקבל',
} as const;

/**
 * Format a lead list row with ONE FIELD PER LINE (product owner UX rule):
 *
 *   שולח: משפחת כהן (david@example.com)
 *   נושא: בדיקת קרינה בנתניה
 *   התקבל: 06/07, 21:03
 */
export function formatLeadListRow(row: LeadListRowData): string {
  const name  = row.fromName ?? '—';
  const email = row.fromEmail ? ` (${row.fromEmail})` : '';
  const subj  = row.subject ?? '(ללא נושא)';

  let when = '';
  if (row.receivedAt) {
    const d = new Date(row.receivedAt);
    const parts = new Intl.DateTimeFormat('he-IL', {
      timeZone: 'Asia/Jerusalem',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const day   = parts.find((p) => p.type === 'day')?.value ?? '';
    const month = parts.find((p) => p.type === 'month')?.value ?? '';
    const hh    = parts.find((p) => p.type === 'hour')?.value ?? '';
    const min   = parts.find((p) => p.type === 'minute')?.value ?? '';
    if (day && month) when = `${day}/${month}, ${hh}:${min}`;
  }

  const lines: string[] = [
    `${LEAD_LABELS.SENDER}: ${name}${email}`,
    `${LEAD_LABELS.SUBJECT}: ${subj}`,
  ];
  if (when) lines.push(`${LEAD_LABELS.RECEIVED}: ${when}`);
  return lines.join('\n');
}
