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
    // The old CRM employee kinds are not emitted here.
    expect(items.some((i) => i.action.kind === 'list_tasks')).toBe(false);
    expect(items.some((i) => i.action.kind === 'free_text')).toBe(false);
    expect(items.some((i) => i.action.kind === 'guide')).toBe(false);
  });

  it('MANAGER users now see the unified 6-item manager menu (updated from K1 v1 behavior)', () => {
    // Updated: MANAGER now gets the same unified manager menu as ADMIN.
    // This replaced the K1 v2 behavior where only ADMIN got the (legacy) manager menu.
    const managerItems = menuItemsFor(manager);
    const adminItems   = menuItemsFor(admin);
    expect(managerItems.map((i) => i.action.kind)).toEqual(adminItems.map((i) => i.action.kind));
  });

  it('ADMIN gets the new unified 6-item manager menu (mgr_ action kinds)', () => {
    const items = menuItemsFor(admin);
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(items[0].action.kind).toBe('mgr_snapshot');
    expect(items[1].action.kind).toBe('mgr_today_inspections');
    expect(items[2].action.kind).toBe('mgr_exceptions_sub');
    expect(items[3].action.kind).toBe('mgr_leads_sub');
    expect(items[4].action.kind).toBe('mgr_workers_sub');
    expect(items[5].action.kind).toBe('mgr_search_sub');
    // No legacy list_tasks / guide / free_text / digest_settings in the new manager menu.
    const kinds = items.map((i) => i.action.kind);
    expect(kinds).not.toContain('guide');
    expect(kinds).not.toContain('list_tasks');
    expect(kinds).not.toContain('free_text');
    expect(kinds).not.toContain('digest_settings');
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
