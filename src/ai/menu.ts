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
import type { ResolvedUser, TaskFilter } from '../types';

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
  | { kind: 'guide'; guide: string };

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

function employeeMenu(): MenuRoute[] {
  return [
    { n: 1, label: 'המשימות שלי',                         action: { kind: 'list_tasks', filter: 'all',           scope: 'own', dateField: 'createdAt' } },
    { n: 2, label: 'משימות להיום',                        action: { kind: 'list_tasks', filter: 'today_overdue', scope: 'own', dateField: 'dueDate' } },
    { n: 3, label: 'משימות באיחור',                       action: { kind: 'list_tasks', filter: 'overdue',       scope: 'own', dateField: 'dueDate' } },
    { n: 4, label: 'דיווח על השלמת משימה',                action: { kind: 'guide', guide: GUIDE_REPORT_COMPLETION } },
    { n: 5, label: 'בקשת שינוי מועד יעד',                 action: { kind: 'guide', guide: GUIDE_DUEDATE_CHANGE } },
    { n: 6, label: DIGEST_SETTINGS_LABEL,                 action: { kind: 'digest_settings' } },
    { n: 7, label: FREE_TEXT_LABEL,                       action: { kind: 'free_text' } },
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

/** The numbered routes for a user, by role. Manager == Admin (company-wide) in V1. */
export function menuItemsFor(user: ResolvedUser): MenuRoute[] {
  return user.isElevated ? managerMenu() : employeeMenu();
}

/** Render the role-based menu as numbered Hebrew text. */
export function renderMenu(user: ResolvedUser): string {
  const items = menuItemsFor(user);
  const header = user.isElevated ? '📋 תפריט ניהול — בחר מספר:' : '📋 תפריט — בחר מספר:';
  const lines = items.map((r) => `${r.n}. ${r.label}`);
  return `${header}\n${lines.join('\n')}\n\nאפשר גם פשוט לכתוב בקשה חופשית בכל עת.`;
}
