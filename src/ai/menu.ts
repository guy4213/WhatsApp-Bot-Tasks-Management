/**
 * Role-based numbered WhatsApp menu (V1).
 *
 * V1 is a NUMBERED TEXT menu only — no WhatsApp interactive list messages. The
 * menu opens on a small set of trigger words; everything else continues to the
 * existing AI/NLU free-text path untouched.
 *
 * This module is pure (no DB / network) so the menu shape + trigger are unit-
 * testable. The router (ai/router.ts) maps each route's `action` to existing
 * behavior and owns all messaging / context.
 */
import type { FieldProblemType, ResolvedUser, TaskFilter } from '../types';

/**
 * Opens the menu when the WHOLE message is one of: menu / תפריט / עזרה / היי / שלום
 * (optionally followed by punctuation). Anchored to the full trimmed string, so
 * real free text like "הצג את המשימות שלי" or "שלום לכולם" does NOT match and
 * flows to the AI parser exactly as before.
 */
export const MENU_TRIGGER_RE = /^\s*(menu|תפריט|עזרה|היי|שלום)\s*[!?.,]*\s*$/i;

/** What a menu number does. The router translates each into existing behavior. */
export type MenuAction =
  | { kind: 'list_tasks'; filter: TaskFilter; scope: 'own' | 'all'; dateField: 'dueDate' | 'createdAt' }
  | { kind: 'team_workload' }
  | { kind: 'pending_approvals' }
  | { kind: 'digest_settings' }
  | { kind: 'free_text' }
  | { kind: 'guide'; guide: string }
  // v2 inspector (field-worker) menu — the 7 items from SPEC_FIELD_V2 §5.
  // Kept typed alongside the legacy kinds; the legacy kinds are still legally
  // valid until the X-series dismantle tasks remove them.
  | { kind: 'list_inspections_today' }
  | { kind: 'list_inspections_tomorrow' }
  | { kind: 'update_inspection_status' }
  | { kind: 'report_problem' }
  | { kind: 'missing_equipment' }
  | { kind: 'missing_report_info' }
  | { kind: 'day_summary' };

export interface MenuRoute {
  n: number;       // displayed number (1-based)
  label: string;   // Hebrew menu label
  action: MenuAction;
}

// Guide texts (explain-only — V1 must NOT let the bot change CRM task status).
const GUIDE_REPORT_COMPLETION =
  'דיווח על השלמת משימה: כתוב בלשון חופשית מה בוצע, למשל "סיימתי את המשימה תיאום ללקוח X". ' +
  'הבוט לא משנה סטטוס משימה במערכת — עדכון הסטטוס מתבצע ב-CRM. אפשר לפרט מה הושלם ואצרף זאת להיסטוריית השיחה.';
const GUIDE_DUEDATE_CHANGE =
  'בקשת שינוי מועד: כתוב למשל "שנה מועד למשימה Y ל-מחר". בקשה כזו דורשת אישור מנהל לפני ביצוע.';
const GUIDE_TASKS_BY_EMPLOYEE =
  'משימות לפי עובד: כתוב למשל "הצג את המשימות של דנה" או "המשימות של יאיר ויורם".';
const GUIDE_CREATE_FOR_EMPLOYEE =
  'יצירת משימה לעובד: כתוב למשל "צור משימה תיאום ללקוח X עבור דנה למחר".';

const DIGEST_SETTINGS_LABEL = 'הגדרות סיכום בוקר / דוח סוף יום';
const FREE_TEXT_LABEL = 'בקשה בטקסט חופשי';

/**
 * v2 inspector (field-worker) menu — the 7 items from SPEC_FIELD_V2 §5, in order.
 * Per K5, the digest-settings sub-menu is a hidden capability and does NOT appear
 * here. Free-text and voice are always available without going through the menu.
 */
function employeeMenu(): MenuRoute[] {
  return [
    { n: 1, label: 'הבדיקות שלי להיום',    action: { kind: 'list_inspections_today' } },
    { n: 2, label: 'הבדיקות שלי למחר',     action: { kind: 'list_inspections_tomorrow' } },
    { n: 3, label: 'עדכון סטטוס בדיקה',    action: { kind: 'update_inspection_status' } },
    { n: 4, label: 'דיווח על בעיה',        action: { kind: 'report_problem' } },
    { n: 5, label: 'חסר ציוד',             action: { kind: 'missing_equipment' } },
    { n: 6, label: 'חסר מידע לדוח',        action: { kind: 'missing_report_info' } },
    { n: 7, label: 'סיכום יום',            action: { kind: 'day_summary' } },
  ];
}

function managerMenu(): MenuRoute[] {
  return [
    { n: 1, label: 'סקירת צוות יומית',                    action: { kind: 'team_workload' } },
    { n: 2, label: 'משימות לפי עובד',                     action: { kind: 'guide', guide: GUIDE_TASKS_BY_EMPLOYEE } },
    { n: 3, label: 'משימות באיחור',                       action: { kind: 'list_tasks', filter: 'overdue',       scope: 'all', dateField: 'dueDate' } },
    { n: 4, label: 'משימות להיום',                        action: { kind: 'list_tasks', filter: 'today_overdue', scope: 'all', dateField: 'dueDate' } },
    { n: 5, label: 'יצירת משימה לעובד',                   action: { kind: 'guide', guide: GUIDE_CREATE_FOR_EMPLOYEE } },
    { n: 6, label: 'אישורים ממתינים',                     action: { kind: 'pending_approvals' } },
    { n: 7, label: DIGEST_SETTINGS_LABEL,                 action: { kind: 'digest_settings' } },
    { n: 8, label: FREE_TEXT_LABEL,                       action: { kind: 'free_text' } },
  ];
}

/**
 * The numbered routes for a user, by role. Per K1: only `ADMIN` sees the (legacy
 * CRM) manager menu; everyone else — including MANAGER — sees the v2 inspector
 * menu. This is the deliberate v2 change from V1's isElevated split.
 */
export function menuItemsFor(user: ResolvedUser): MenuRoute[] {
  return user.role === 'ADMIN' ? managerMenu() : employeeMenu();
}

/** Render the role-based menu as numbered Hebrew text. */
export function renderMenu(user: ResolvedUser): string {
  const items = menuItemsFor(user);
  const header = user.role === 'ADMIN' ? '📋 תפריט ניהול — בחר מספר:' : '📋 תפריט — בחר מספר:';
  const lines = items.map((r) => `${r.n}. ${r.label}`);
  return `${header}\n${lines.join('\n')}\n\nאפשר גם פשוט לכתוב בקשה חופשית בכל עת.`;
}

// ── D2-T8 problem-type sub-menu ────────────────────────────────────────────────
// The 7 problem types from SPEC_FIELD_V2 §9. Labels are Hebrew; the
// `problemType` machine value MUST match the CHECK constraint on
// `TaskField.problemType` from migration 009 verbatim — otherwise the write
// would be rejected. Options 6 ("בעיה מקצועית") and 7 ("אחר") ask the router
// for a free-text elaboration before writing.

export interface ProblemTypeMenuItem {
  n: number;
  label: string;
  problemType: FieldProblemType;
}

/**
 * D5-T4 — Button-vs-numbered-text policy (v2).
 *
 * Numbered-text menus (this file, rendered via `renderMenu` / `renderProblemTypeMenu`)
 * are the DEFAULT. Reserve interactive `sendButtonMessage` (Meta's 3-button
 * reply-button messages) for exactly TWO surfaces:
 *
 *   1. The §6 inspection card (worker confirmation on assignment) — D2-T2.
 *   2. The §10 equipment reminder morning roll-up — D2-T9.
 *
 * Everything else — main worker menu (7 items), this problem sub-menu (7 items),
 * the §7 finished follow-up (4 items), the §11 day summary (4 items) — stays as
 * numbered text so we never hit Meta's 3-button ceiling and the same code path
 * handles typed numbers, taps, and free text uniformly. Cross-ref: the caveat
 * comment in `src/ai/router.ts:773-776` predates this policy and stays valid.
 */
export function problemTypeMenu(): ProblemTypeMenuItem[] {
  return [
    { n: 1, label: 'הלקוח לא ענה',   problemType: 'CUSTOMER_NOT_ANSWERING' },
    { n: 2, label: 'אין גישה',       problemType: 'NO_ACCESS' },
    { n: 3, label: 'הלקוח לא נמצא',  problemType: 'CUSTOMER_NOT_PRESENT' },
    { n: 4, label: 'חסר ציוד',       problemType: 'MISSING_EQUIPMENT' },
    { n: 5, label: 'לא ניתן לבצע',   problemType: 'CANNOT_PERFORM' },
    { n: 6, label: 'בעיה מקצועית',   problemType: 'PROFESSIONAL_ISSUE' },
    { n: 7, label: 'אחר',            problemType: 'OTHER' },
  ];
}

export function renderProblemTypeMenu(): string {
  const items = problemTypeMenu();
  return 'בחר סוג בעיה:\n' + items.map((i) => `${i.n}. ${i.label}`).join('\n');
}

// ── D2-T5 status-update sub-menu ─────────────────────────────────────────────
// Menu item 3 → 3-item numbered sub-menu (spec §7). Numbered text per D5-T4
// policy (see the JSDoc on `problemTypeMenu` above).

export interface StatusUpdateMenuItem {
  n: number;
  label: string;
  transition: 'DEPARTED' | 'ARRIVED' | 'FINISHED';
}

export function statusUpdateMenu(): StatusUpdateMenuItem[] {
  return [
    { n: 1, label: 'יצאתי (בדרך)', transition: 'DEPARTED' },
    { n: 2, label: 'הגעתי',        transition: 'ARRIVED'  },
    { n: 3, label: 'סיימתי',       transition: 'FINISHED' },
  ];
}

export function renderStatusUpdateMenu(): string {
  return 'עדכון סטטוס בדיקה:\n' + statusUpdateMenu().map((i) => `${i.n}. ${i.label}`).join('\n');
}

// ── D2-T6 finished follow-up 4-option menu ───────────────────────────────────
// After a FINISHED write we prompt for one of 4 follow-ups (spec §7): no
// notes / field notes / has problem / missing info. Options 3 and 4 hand off
// to the D2-T8 problem flow and the D2-T7 missing-info flow respectively.

export type FinishedFollowUpChoice = 'no_notes' | 'has_notes' | 'has_problem' | 'missing_info';

export interface FinishedFollowUpItem {
  n: number;
  label: string;
  choice: FinishedFollowUpChoice;
}

export function finishedFollowUpMenu(): FinishedFollowUpItem[] {
  return [
    { n: 1, label: 'אין הערות',       choice: 'no_notes'     },
    { n: 2, label: 'יש הערות מהשטח',  choice: 'has_notes'    },
    { n: 3, label: 'יש בעיה',         choice: 'has_problem'  },
    { n: 4, label: 'חסר מידע לדוח',   choice: 'missing_info' },
  ];
}

export function renderFinishedFollowUpMenu(): string {
  return (
    'סיימת את הבדיקה. משהו נוסף?\n' +
    finishedFollowUpMenu().map((i) => `${i.n}. ${i.label}`).join('\n')
  );
}
