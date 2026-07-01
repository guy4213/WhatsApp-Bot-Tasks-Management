/**
 * Pure WhatsApp digest formatters.
 *
 * Each formatter returns `{ text, params }`:
 *   - `params` — the ordered template body variables (compact COUNTS only). These
 *     are what an approved out-of-window template renders.
 *   - `text`   — the RICH in-window free-form message (counts + per-employee
 *     breakdown + unfinished titles), used by notify()'s fallback path while
 *     templates are disabled.
 *
 * No DB / network imports — kept pure so it is trivially unit-testable.
 *
 * Morning = "opening day plan" (what's ahead today).
 * Evening = "end-of-day report" — current end-of-day STATUS, not a "completed
 * today" historical claim (V1 has no reliable completedAt). The evening messages
 * are explicitly labelled "סטטוס נוכחי לסוף היום".
 */
import type { NotificationKey } from './templateNames';
import type {
  EmployeeMorningCounts,
  EmployeeEndOfDay,
  CompanyMorning,
  CompanyEndOfDay,
} from '../services/tasks';
import type { InspectionListItem } from '../services/inspectionsQueries';
import type {
  FieldExceptionCounts,
  OpenFieldException,
} from '../services/exceptionsQueries';
import { problemTypeMenu } from '../ai/menu';
import { DIGEST_PAYLOAD_IDS } from '../ai/digestCommands';

/** One WhatsApp quick-reply button. `id` is a stable digest payload id. */
export interface DigestButton {
  id: string;
  title: string; // ≤ 20 chars (Meta limit)
}

export interface DigestContent {
  text: string;            // rich free-form (in-window)
  params: string[];        // ordered template vars (compact counts)
  buttons: DigestButton[]; // quick-reply buttons (in-window); also the template's quick replies
}

// Shared button labels (each ≤ 20 chars).
const BTN_FREE_TEXT: DigestButton = { id: DIGEST_PAYLOAD_IDS.FREE_TEXT, title: 'כתיבה חופשית' };
const BTN_EMP_TODAY: DigestButton = { id: DIGEST_PAYLOAD_IDS.EMP_TODAY, title: 'משימות להיום' };
const BTN_EMP_EOD: DigestButton = { id: DIGEST_PAYLOAD_IDS.EMP_EOD, title: 'דוח סוף יום שלי' };
const BTN_TEAM_TODAY: DigestButton = { id: DIGEST_PAYLOAD_IDS.TEAM_TODAY, title: 'משימות להיום בצוות' };
const BTN_TEAM_EOD: DigestButton = { id: DIGEST_PAYLOAD_IDS.TEAM_EOD, title: 'דוח סוף יום צוות' };

/** CTA line — tap a button, or type the exact command / free text. */
const cta = (cmd: string) => `👇 לחץ על הכפתור לפירוט, או כתוב "${cmd}" / "כתיבה חופשית".`;

export type DigestType = 'MORNING' | 'EVENING';

/** Current end-of-day status label — reused so the wording stays consistent. */
const EOD_STATUS_LABEL = 'סטטוס נוכחי לסוף היום';

/**
 * Map a user's role + digest type to its template key. ADMIN reuses the MANAGER
 * templates (company-wide scope in V1).
 */
export function digestTemplateKey(
  user: { isElevated: boolean },
  type: DigestType,
): NotificationKey {
  if (type === 'MORNING') {
    return user.isElevated ? 'MANAGER_MORNING_DIGEST' : 'EMPLOYEE_MORNING_DIGEST';
  }
  return user.isElevated ? 'MANAGER_END_OF_DAY_REPORT' : 'EMPLOYEE_END_OF_DAY_REPORT';
}

// ── Morning ("opening day plan") ──────────────────────────────────────────────

/** Employee morning — own due-today / overdue / open. Template vars: name + 3 counts. */
export function formatEmployeeMorning(name: string, c: EmployeeMorningCounts): DigestContent {
  const params = [name, String(c.dueToday), String(c.overdue), String(c.open)];
  const text =
    `☀️ בוקר טוב ${name}!\n` +
    `תוכנית היום שלך:\n` +
    `📋 ${c.dueToday} משימות להיום\n` +
    `⚠️ ${c.overdue} באיחור\n` +
    `🔄 ${c.open} פתוחות\n\n` +
    cta('משימות להיום');
  return { text, params, buttons: [BTN_EMP_TODAY, BTN_FREE_TEXT] };
}

// ── Inspector morning (D2-T4) ────────────────────────────────────────────────
//
// Galit v2 §7 "morning reminder" — inspectors get a numbered list of today's
// field inspections with a status-update CTA. Non-ADMIN users are routed here
// by the dispatcher (per K1: `user.role !== 'ADMIN'` == inspector). No
// per-role emoji noise — the v2 spec calls for clean output.

/** Hebrew labels for `TaskField.fieldStatus` — spec §4 / migration 009 values. */
const FIELD_STATUS_HE: Record<string, string> = {
  ASSIGNED: 'משובצת',
  CONFIRMED: 'אושרה',
  EN_ROUTE: 'בדרך',
  ARRIVED: 'באתר',
  WAITING_FOR_INFO: 'ממתין למידע',
  HAS_PROBLEM: 'עם בעיה',
  NEEDS_MORE_INFO: 'צריך פרטים',
  FINISHED_FIELD: 'הסתיים בשטח',
};

/** Localize a `fieldStatus` code — falls back to the raw code if unknown. */
function fieldStatusLabelHe(status: string): string {
  return FIELD_STATUS_HE[status] ?? status;
}

/**
 * Inspector morning — numbered list of today's field inspections + a CTA to
 * update status by number or free text/voice. Empty list → a one-line "no
 * inspections today" note (spec §7). Template vars: name + count (compact
 * template render uses just the count; the rich in-window text carries the
 * full list). Missing `customerName` / `siteAddress` degrade to Hebrew
 * placeholders — DO NOT invent data.
 */
export function formatInspectorMorning(
  items: InspectionListItem[],
  user: { name: string | null },
): DigestContent {
  const name = user.name ?? '';
  const params = [name, String(items.length)];

  if (items.length === 0) {
    const text =
      `בוקר טוב ${name},\n` +
      `אין בדיקות משובצות להיום.`;
    return { text, params, buttons: [] };
  }

  const lines = items.map((item, i) => {
    const customer = item.customerName ?? 'לקוח לא ידוע';
    const address = item.siteAddress ?? 'כתובת לא ידועה';
    const city = item.siteCity ? `, ${item.siteCity}` : '';
    const statusHe = fieldStatusLabelHe(item.fieldStatus);
    return `${i + 1}. ${customer} — ${address}${city} (${item.typeLabelHe})\n` +
           `   סטטוס: ${statusHe}`;
  });

  const text =
    `בוקר טוב ${name},\n` +
    `הבדיקות שלך להיום:\n\n` +
    `${lines.join('\n')}\n\n` +
    `בחר מספר לעדכון סטטוס, או כתוב חופשי (למשל: יצאתי / הגעתי / סיימתי).`;

  return { text, params, buttons: [] };
}

/** Manager/Admin morning — company totals + per-employee breakdown. Template vars: name + 4 counts. */
export function formatManagerMorning(name: string, co: CompanyMorning): DigestContent {
  const params = [
    name,
    String(co.dueToday),
    String(co.overdue),
    String(co.open),
    String(co.employeesWithOverdue),
  ];

  const lines = co.employees.map((e) => {
    const flag = e.overdue > 0 ? ' ⚠️' : '';
    return `• ${e.ownerName}: ${e.dueToday} להיום, ${e.overdue} באיחור, ${e.open} פתוחות${flag}`;
  });

  const breakdown = lines.length
    ? `\n\nפירוט לפי עובד:\n${lines.join('\n')}`
    : '';

  const text =
    `☀️ בוקר טוב ${name}!\n` +
    `תמונת בוקר לצוות:\n` +
    `📋 ${co.dueToday} להיום · ⚠️ ${co.overdue} באיחור · 🔄 ${co.open} פתוחות\n` +
    `👥 ${co.employeesWithOverdue} עובדים עם משימות באיחור` +
    breakdown +
    `\n\n${cta('משימות להיום בצוות')}`;

  return { text, params, buttons: [BTN_TEAM_TODAY, BTN_FREE_TEXT] };
}

// ── Evening ("end-of-day report" — current status) ────────────────────────────

/** Employee end-of-day — current status of own tasks + unfinished titles. Template vars: name + 5 counts. */
export function formatEmployeeEndOfDay(name: string, e: EmployeeEndOfDay): DigestContent {
  const params = [
    name,
    String(e.dueToday),
    String(e.completed),
    String(e.notCompleted),
    String(e.overdue),
    String(e.openCarry),
  ];

  const unfinished = e.unfinishedTitles.length
    ? `\n\nמשימות שטרם הושלמו:\n${e.unfinishedTitles.map((t) => `• ${t}`).join('\n')}`
    : '';

  const text =
    `🌆 ערב טוב ${name}!\n` +
    `דוח סוף יום — ${EOD_STATUS_LABEL}:\n` +
    `מתוך ${e.dueToday} משימות להיום: ✅ ${e.completed} בוצעו · ❌ ${e.notCompleted} לא בוצעו\n` +
    `⚠️ ${e.overdue} באיחור · 🔄 ${e.openCarry} פתוחות שעוברות למחר` +
    unfinished +
    `\n\n${cta('דוח סוף יום שלי')}`;

  return { text, params, buttons: [BTN_EMP_EOD, BTN_FREE_TEXT] };
}

/** Manager/Admin end-of-day — company current status + per-employee breakdown. Template vars: name + 6 counts. */
export function formatManagerEndOfDay(name: string, co: CompanyEndOfDay): DigestContent {
  const params = [
    name,
    String(co.dueToday),
    String(co.completed),
    String(co.notCompleted),
    String(co.overdue),
    String(co.openCarry),
    String(co.employeesWithUnfinishedOrOverdue),
  ];

  const lines = co.employees.map((e) => {
    const flag = e.notCompleted > 0 || e.overdue > 0 ? ' ⚠️' : '';
    return `• ${e.ownerName}: ${e.dueToday} להיום, ✅ ${e.completed} בוצעו, ❌ ${e.notCompleted} לא בוצעו, ${e.overdue} באיחור${flag}`;
  });

  const breakdown = lines.length
    ? `\n\nפירוט לפי עובד:\n${lines.join('\n')}`
    : '';

  const text =
    `🌆 ערב טוב ${name}!\n` +
    `דוח סוף יום (צוות) — ${EOD_STATUS_LABEL}:\n` +
    `מתוך ${co.dueToday} להיום: ✅ ${co.completed} בוצעו · ❌ ${co.notCompleted} לא בוצעו\n` +
    `⚠️ ${co.overdue} באיחור · 🔄 ${co.openCarry} פתוחות למחר\n` +
    `👥 ${co.employeesWithUnfinishedOrOverdue} עובדים עם משימות פתוחות/באיחור` +
    breakdown +
    `\n\n${cta('דוח סוף יום צוות')}`;

  return { text, params, buttons: [BTN_TEAM_EOD, BTN_FREE_TEXT] };
}

// ── Galit v2 manager (Yoram) — D4-T1 ─────────────────────────────────────────
//
// SPEC_FIELD_V2 §13 — Yoram gets a compact exceptions digest (morning +
// evening). The FIELD portion (5 counts + numbered "פתוחים:" list) is what this
// module renders. The LEADS portion is B2-blocked (columns of `lead incoming`
// not resolved yet); a visually distinct TODO placeholder line stands in until
// B2 lands.
//
// Content style follows the spec verbatim — no emojis, no CTA button (Yoram
// reads and reacts in the CRM, not the bot).

/** Hebrew label for a `TaskField.problemType` code (7 CHECK values in migration 009). */
function problemTypeLabelHe(code: string): string {
  const item = problemTypeMenu().find((p) => p.problemType === code);
  return item?.label ?? code;
}

/** Compact single-line counts row per §13 (`שטח: בוצעו X · לא אושרו Y · …`). */
function formatCountsLine(c: FieldExceptionCounts): string {
  return (
    `שטח: בוצעו ${c.finishedFieldToday} · ` +
    `לא אושרו ${c.notConfirmedToday} · ` +
    `עם בעיה ${c.hasProblemToday} · ` +
    `ממתינות למידע ${c.waitingForInfoToday} · ` +
    `לא סגרו יום ${c.notClosedDayToday}`
  );
}

/**
 * Leads placeholder — B2-blocked. Visually distinct so a human reviewer sees
 * the TODO immediately (see brief). Do NOT compute/query any lead numbers here.
 */
const LEADS_TODO_LINE = 'לידים: (מחכה ל-B2 — טרם משולב)';

/** Render one row of the numbered "פתוחים:" list. */
function formatExceptionRow(ex: OpenFieldException, n: number): string {
  const worker   = ex.workerName   ?? 'עובד לא ידוע';
  const customer = ex.customerName ?? 'לקוח לא ידוע';
  const note =
    ex.note && ex.note.trim().length > 0
      ? ex.note.trim()
      : ex.problemType
        ? problemTypeLabelHe(ex.problemType)
        : '—';
  return `${n}. ${worker} — ${customer}: ${note}`;
}

/**
 * Yoram morning — §13 format.
 *
 * Template vars (compact): [name, 5 counts]. Rich text carries the full open-
 * exceptions list. Empty open-exceptions list renders a one-liner
 * "אין חריגים פתוחים." between the counts and leads blocks.
 */
export function formatGalitManagerMorning(input: {
  counts: FieldExceptionCounts;
  exceptions: OpenFieldException[];
  user: { name: string | null };
}): DigestContent {
  const { counts, exceptions, user } = input;
  const name = user.name ?? '';
  const params = [
    name,
    String(counts.finishedFieldToday),
    String(counts.notConfirmedToday),
    String(counts.hasProblemToday),
    String(counts.waitingForInfoToday),
    String(counts.notClosedDayToday),
  ];

  const openBlock = exceptions.length === 0
    ? 'אין חריגים פתוחים.'
    : `פתוחים:\n${exceptions.map((e, i) => formatExceptionRow(e, i + 1)).join('\n')}`;

  const text =
    `סיכום גלית — בוקר טוב ${name}\n` +
    `${formatCountsLine(counts)}\n` +
    `${LEADS_TODO_LINE}\n\n` +
    `${openBlock}`;

  return { text, params, buttons: [] };
}

/**
 * Yoram end-of-day — §13 format.
 *
 * Same shape as the morning; the header line switches to a "סיכום סוף יום"
 * label. Empty open-exceptions list renders the same one-liner.
 */
export function formatGalitManagerEndOfDay(input: {
  counts: FieldExceptionCounts;
  exceptions: OpenFieldException[];
  user: { name: string | null };
}): DigestContent {
  const { counts, exceptions, user } = input;
  const name = user.name ?? '';
  const params = [
    name,
    String(counts.finishedFieldToday),
    String(counts.notConfirmedToday),
    String(counts.hasProblemToday),
    String(counts.waitingForInfoToday),
    String(counts.notClosedDayToday),
  ];

  const openBlock = exceptions.length === 0
    ? 'אין חריגים פתוחים.'
    : `פתוחים:\n${exceptions.map((e, i) => formatExceptionRow(e, i + 1)).join('\n')}`;

  const text =
    `סיכום סוף יום — ${name}\n` +
    `${formatCountsLine(counts)}\n` +
    `${LEADS_TODO_LINE}\n\n` +
    `${openBlock}`;

  return { text, params, buttons: [] };
}
