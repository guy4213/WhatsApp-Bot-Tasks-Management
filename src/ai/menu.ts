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
import { isExceptionsViewer, isLeadsViewer } from '../services/specialUsers';

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
  | { kind: 'digest_settings' }
  | { kind: 'free_text' }
  | { kind: 'guide'; guide: string }
  // v2 inspector (field-worker) menu — the 7 items from SPEC_FIELD_V2 §5.
  | { kind: 'list_inspections_today' }
  | { kind: 'list_inspections_tomorrow' }
  | { kind: 'update_inspection_status' }
  | { kind: 'report_problem' }
  | { kind: 'missing_equipment' }
  | { kind: 'missing_report_info' }
  | { kind: 'day_summary' }
  // Unified 6-item manager menu actions.
  | { kind: 'mgr_snapshot' }
  | { kind: 'mgr_today_inspections' }
  | { kind: 'mgr_exceptions_sub' }
  | { kind: 'mgr_leads_sub' }
  | { kind: 'mgr_workers_sub' }
  | { kind: 'mgr_search_sub' };

export interface MenuRoute {
  n: number;       // displayed number (1-based)
  label: string;   // Hebrew menu label
  action: MenuAction;
}

// Guide texts (explain-only).
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

/**
 * Unified 6-item manager menu (new implementation).
 * Shown to: ADMIN, MANAGER, exceptions viewers (יורם etc.), leads viewers (סשה etc.).
 */
function managerMenu(): MenuRoute[] {
  return [
    { n: 1, label: 'תמונת מצב ניהולית',           action: { kind: 'mgr_snapshot' } },
    { n: 2, label: 'בדיקות שטח להיום',             action: { kind: 'mgr_today_inspections' } },
    { n: 3, label: 'חריגים ודיווחים',              action: { kind: 'mgr_exceptions_sub' } },
    { n: 4, label: 'לידים ממתינים לטיפול',          action: { kind: 'mgr_leads_sub' } },
    { n: 5, label: 'עובדים וסיכומי יום',            action: { kind: 'mgr_workers_sub' } },
    { n: 6, label: 'חיפוש משימה / בדיקה',          action: { kind: 'mgr_search_sub' } },
  ];
}

/**
 * Returns true when the user should see the unified manager menu.
 * Criteria (OR):
 *  - role === 'ADMIN' OR role === 'MANAGER'
 *  - isExceptionsViewer(user.name)
 *  - isLeadsViewer(user.name)
 */
export function isManagerMenuUser(user: ResolvedUser): boolean {
  return (
    user.role === 'ADMIN' ||
    user.role === 'MANAGER' ||
    isExceptionsViewer(user.name) ||
    isLeadsViewer(user.name)
  );
}

/**
 * The numbered routes for a user, by role + special-user sets.
 * Manager-menu users (ADMIN, MANAGER, exceptions viewers, leads viewers) get
 * the 6-item unified manager menu. All others get the v2 inspector menu (§5).
 */
export function menuItemsFor(user: ResolvedUser): MenuRoute[] {
  return isManagerMenuUser(user) ? managerMenu() : employeeMenu();
}

/** Render the role-based menu as numbered Hebrew text. */
export function renderMenu(user: ResolvedUser): string {
  const items = menuItemsFor(user);
  const isManager = isManagerMenuUser(user);
  const header = isManager
    ? 'שלום, מה תרצה לעשות?'
    : '📋 תפריט — בחר מספר:';
  const lines = items.map((r) => `${r.n}. ${r.label}`);
  return `${header}\n\n${lines.join('\n')}`;
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

// ── D2-T10 day-summary 4-option follow-up menu ──────────────────────────────
// After the day summary (menu item 7) we prompt for one of 4 follow-ups
// (spec §11): everything done / missing info / need to call back / open
// problem. Options 2 and 4 hand off to the D2-T7 / D2-T8 flows (with
// disambig when the worker has multiple open TaskFields). Option 3 is a
// light "call-back reminder" — alert-only, no DB write per D2-T10 spec
// ("no persistence per D2-T10 spec — alert-only"). Option 1 acknowledges
// and clears without writing any DB row (NO FieldWorkerDayClose — deferred
// per §14).

export type DaySummaryFollowUpChoice =
  | 'all_done'
  | 'missing_info'
  | 'callback_customer'
  | 'open_problem';

export interface DaySummaryFollowUpItem {
  n: number;
  label: string;
  choice: DaySummaryFollowUpChoice;
}

export function daySummaryFollowUpMenu(): DaySummaryFollowUpItem[] {
  return [
    { n: 1, label: 'הכל בוצע',           choice: 'all_done'          },
    { n: 2, label: 'חסר מידע לדוח',      choice: 'missing_info'      },
    { n: 3, label: 'צריך לחזור ללקוח',   choice: 'callback_customer' },
    { n: 4, label: 'בעיה פתוחה',         choice: 'open_problem'      },
  ];
}

export function renderDaySummaryFollowUpMenu(): string {
  return (
    'יש מה להשלים?\n' +
    daySummaryFollowUpMenu().map((i) => `${i.n}. ${i.label}`).join('\n')
  );
}
