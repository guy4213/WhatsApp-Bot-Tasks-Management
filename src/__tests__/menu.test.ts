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
  it('employee menu: 7 items in the expected order, ending with free text', () => {
    const items = menuItemsFor(employee);
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Employees see their OWN tasks only (never company-wide).
    const listScopes = items
      .filter((i) => i.action.kind === 'list_tasks')
      .map((i) => (i.action.kind === 'list_tasks' ? i.action.scope : null));
    expect(listScopes.every((s) => s === 'own')).toBe(true);
    // Item 6 is digest settings, item 7 is free text.
    expect(items[5].action.kind).toBe('digest_settings');
    expect(items[6].action.kind).toBe('free_text');
    // No team_workload / pending_approvals for a regular employee.
    expect(items.some((i) => i.action.kind === 'team_workload')).toBe(false);
    expect(items.some((i) => i.action.kind === 'pending_approvals')).toBe(false);
  });

  it('manager menu: 8 items including team workload + pending approvals, company-wide lists', () => {
    const items = menuItemsFor(manager);
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(items[0].action.kind).toBe('team_workload');
    expect(items.some((i) => i.action.kind === 'pending_approvals')).toBe(true);
    expect(items[6].action.kind).toBe('digest_settings');
    expect(items[7].action.kind).toBe('free_text');
    // Manager lists are company-wide (scope 'all').
    const listScopes = items
      .filter((i) => i.action.kind === 'list_tasks')
      .map((i) => (i.action.kind === 'list_tasks' ? i.action.scope : null));
    expect(listScopes.length).toBeGreaterThan(0);
    expect(listScopes.every((s) => s === 'all')).toBe(true);
  });

  it('admin gets the same company-wide menu as manager (V1 scope)', () => {
    expect(menuItemsFor(admin)).toEqual(menuItemsFor(manager));
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
