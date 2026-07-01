import { describe, it, expect } from 'vitest';
import { MENU_TRIGGER_RE, menuItemsFor, renderMenu } from '../ai/menu';
import type { ResolvedUser } from '../types';

function makeUser(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u1',
    name: 'בודק',
    phone: '972501234567',
    role: 'SALES',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

const employee = makeUser();
const manager = makeUser({ role: 'MANAGER', isElevated: true });
const admin = makeUser({ role: 'ADMIN', isElevated: true });

describe('MENU_TRIGGER_RE', () => {
  it('matches each trigger word (menu / תפריט / עזרה / היי / שלום)', () => {
    for (const w of ['menu', 'MENU', 'תפריט', 'עזרה', 'היי', 'שלום']) {
      expect(MENU_TRIGGER_RE.test(w)).toBe(true);
    }
  });

  it('matches a trigger with surrounding whitespace / trailing punctuation', () => {
    expect(MENU_TRIGGER_RE.test('  תפריט  ')).toBe(true);
    expect(MENU_TRIGGER_RE.test('שלום!')).toBe(true);
    expect(MENU_TRIGGER_RE.test('menu.')).toBe(true);
  });

  it('does NOT match real free text (bypass preserved)', () => {
    expect(MENU_TRIGGER_RE.test('הצג את המשימות שלי')).toBe(false);
    expect(MENU_TRIGGER_RE.test('שלום לכולם')).toBe(false);
    expect(MENU_TRIGGER_RE.test('צור משימה תיאום ללקוח X')).toBe(false);
    expect(MENU_TRIGGER_RE.test('עזרה עם משימה')).toBe(false);
  });
});

describe('menuItemsFor', () => {
  it('inspector (non-ADMIN) menu: exactly the 7 v2 items from SPEC §5, in order, mapped to the new MenuAction kinds', () => {
    const items = menuItemsFor(employee);
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(items.map((i) => i.label)).toEqual([
      'הבדיקות שלי להיום',
      'הבדיקות שלי למחר',
      'עדכון סטטוס בדיקה',
      'דיווח על בעיה',
      'חסר ציוד',
      'חסר מידע לדוח',
      'סיכום יום',
    ]);
    expect(items.map((i) => i.action.kind)).toEqual([
      'list_inspections_today',
      'list_inspections_tomorrow',
      'update_inspection_status',
      'report_problem',
      'missing_equipment',
      'missing_report_info',
      'day_summary',
    ]);
    // K5: no digest-settings entry in the v2 inspector menu.
    expect(items.some((i) => i.action.kind === 'digest_settings')).toBe(false);
    // The old CRM employee kinds are not emitted here (they remain in the type
    // for other emitters until the X-series dismantle tasks remove them).
    expect(items.some((i) => i.action.kind === 'list_tasks')).toBe(false);
    expect(items.some((i) => i.action.kind === 'free_text')).toBe(false);
    expect(items.some((i) => i.action.kind === 'guide')).toBe(false);
    expect(items.some((i) => i.action.kind === 'team_workload')).toBe(false);
    expect(items.some((i) => i.action.kind === 'pending_approvals')).toBe(false);
  });

  it('K1: MANAGER users now see the inspector menu (only ADMIN gets the legacy manager menu)', () => {
    // Deliberate v2 behavior — see TASKS.md §0 K1 and the D2-T1 build brief.
    expect(menuItemsFor(manager)).toEqual(menuItemsFor(employee));
  });

  it('ADMIN gets the (unchanged) 8-item legacy manager menu until D4-T1 rewrites it', () => {
    const items = menuItemsFor(admin);
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(items[0].action.kind).toBe('team_workload');
    expect(items.some((i) => i.action.kind === 'pending_approvals')).toBe(true);
    expect(items[6].action.kind).toBe('digest_settings');
    expect(items[7].action.kind).toBe('free_text');
    // Legacy manager lists are company-wide (scope 'all').
    const listScopes = items
      .filter((i) => i.action.kind === 'list_tasks')
      .map((i) => (i.action.kind === 'list_tasks' ? i.action.scope : null));
    expect(listScopes.length).toBeGreaterThan(0);
    expect(listScopes.every((s) => s === 'all')).toBe(true);
  });
});

describe('renderMenu', () => {
  it('renders a numbered list with every item label', () => {
    const text = renderMenu(employee);
    for (const item of menuItemsFor(employee)) {
      expect(text).toContain(`${item.n}. ${item.label}`);
    }
  });
});
