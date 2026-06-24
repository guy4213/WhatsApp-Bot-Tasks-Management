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
