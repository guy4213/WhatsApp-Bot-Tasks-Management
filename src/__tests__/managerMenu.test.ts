/**
 * managerMenu.test.ts — menu rendering + menuItemsFor routing for the unified
 * 6-item manager menu and employee menu preservation.
 */
import { describe, it, expect } from 'vitest';
import { menuItemsFor, renderMenu, isManagerMenuUser } from '../ai/menu';
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

// ── Role-based users ──────────────────────────────────────────────────────────

const worker     = makeUser({ role: 'SALES' });
const technician = makeUser({ role: 'TECHNICIAN' });
const adminUser  = makeUser({ role: 'ADMIN', isElevated: true });
const managerUser = makeUser({ role: 'MANAGER', isElevated: true, name: 'מנהל' });

// Special-name users
const yoram      = makeUser({ name: 'יורם' });
const guyFranses = makeUser({ name: 'גיא פרנסס' });
const guyGabai   = makeUser({ name: 'גיא גבאי' });
const yair       = makeUser({ name: 'יאיר' });
const sasha      = makeUser({ name: 'סשה' });

// ── isManagerMenuUser ─────────────────────────────────────────────────────────

describe('isManagerMenuUser', () => {
  it('returns true for ADMIN role', () => {
    expect(isManagerMenuUser(adminUser)).toBe(true);
  });

  it('returns true for MANAGER role', () => {
    expect(isManagerMenuUser(managerUser)).toBe(true);
  });

  it('returns true for exceptions viewers (יורם, גיא פרנסס, גיא גבאי, יאיר)', () => {
    expect(isManagerMenuUser(yoram)).toBe(true);
    expect(isManagerMenuUser(guyFranses)).toBe(true);
    expect(isManagerMenuUser(guyGabai)).toBe(true);
    expect(isManagerMenuUser(yair)).toBe(true);
  });

  it('returns true for leads viewers (סשה, גיא פרנסס, יאיר)', () => {
    expect(isManagerMenuUser(sasha)).toBe(true);
    // גיא פרנסס and יאיר are both exceptions + leads viewers, already tested above
  });

  it('returns false for a regular SALES worker', () => {
    expect(isManagerMenuUser(worker)).toBe(false);
  });

  it('returns false for TECHNICIAN with a non-special name', () => {
    expect(isManagerMenuUser(technician)).toBe(false);
  });
});

// ── menuItemsFor — manager-menu users ────────────────────────────────────────

describe('menuItemsFor — manager-menu users', () => {
  const EXPECTED_LABELS = [
    'תמונת מצב ניהולית',
    'בדיקות שטח להיום',
    'חריגים ודיווחים',
    'לידים ממתינים לטיפול',
    'עובדים וסיכומי יום',
    'חיפוש משימה / בדיקה',
    'הבדיקות שלי להיום',
  ];

  const EXPECTED_ACTION_KINDS = [
    'mgr_snapshot',
    'mgr_today_inspections',
    'mgr_exceptions_sub',
    'mgr_leads_sub',
    'mgr_workers_sub',
    'mgr_search_sub',
    'mgr_my_inspections_today',
  ];

  for (const user of [adminUser, managerUser, yoram, guyFranses, guyGabai, yair, sasha]) {
    it(`shows 7-item manager menu for ${user.name} (${user.role})`, () => {
      const items = menuItemsFor(user);
      expect(items).toHaveLength(7);
      expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(items.map((i) => i.label)).toEqual(EXPECTED_LABELS);
      expect(items.map((i) => i.action.kind)).toEqual(EXPECTED_ACTION_KINDS);
    });
  }

  it('manager menu does NOT contain the old legacy CRM list_tasks/guide/free_text kinds', () => {
    const items = menuItemsFor(adminUser);
    const kinds = items.map((i) => i.action.kind);
    expect(kinds).not.toContain('list_tasks');
    expect(kinds).not.toContain('guide');
    expect(kinds).not.toContain('free_text');
    expect(kinds).not.toContain('digest_settings');
  });
});

// ── menuItemsFor — regular employees ─────────────────────────────────────────

describe('menuItemsFor — regular employees', () => {
  it('SALES worker sees 7-item employee menu (SPEC §5 unchanged)', () => {
    const items = menuItemsFor(worker);
    expect(items).toHaveLength(7);
    expect(items.map((i) => i.action.kind)).toEqual([
      'list_inspections_today',
      'list_inspections_tomorrow',
      'update_inspection_status',
      'report_problem',
      'missing_equipment',
      'missing_report_info',
      'day_summary',
    ]);
  });

  it('TECHNICIAN (non-special name) sees employee menu', () => {
    const items = menuItemsFor(technician);
    expect(items).toHaveLength(7);
  });

  it('employee menu does NOT contain mgr_ action kinds', () => {
    const items = menuItemsFor(worker);
    const kinds = items.map((i) => i.action.kind);
    expect(kinds.some((k) => k.startsWith('mgr_'))).toBe(false);
  });
});

// ── renderMenu ────────────────────────────────────────────────────────────────

describe('renderMenu', () => {
  it('manager gets "שלום, מה תרצה לעשות?" header (no emoji prefix)', () => {
    const text = renderMenu(adminUser);
    expect(text).toContain('שלום, מה תרצה לעשות?');
    expect(text).not.toContain('📋');
  });

  it('manager menu contains all 7 item labels', () => {
    const text = renderMenu(adminUser);
    expect(text).toContain('תמונת מצב ניהולית');
    expect(text).toContain('בדיקות שטח להיום');
    expect(text).toContain('חריגים ודיווחים');
    expect(text).toContain('לידים ממתינים לטיפול');
    expect(text).toContain('עובדים וסיכומי יום');
    expect(text).toContain('חיפוש משימה / בדיקה');
    expect(text).toContain('הבדיקות שלי להיום');
  });

  it('employee gets emoji-prefixed header', () => {
    const text = renderMenu(worker);
    expect(text).toContain('📋');
    expect(text).not.toContain('שלום, מה תרצה לעשות?');
  });

  it('employee menu renders numbered items', () => {
    const text = renderMenu(worker);
    const items = menuItemsFor(worker);
    for (const item of items) {
      expect(text).toContain(`${item.n}. ${item.label}`);
    }
  });

  it('special-name users (יורם) get manager menu header', () => {
    const text = renderMenu(yoram);
    expect(text).toContain('שלום, מה תרצה לעשות?');
  });
});

// ── Backward-compatibility guard ──────────────────────────────────────────────

describe('backward compatibility', () => {
  it('employeeMenu items are unchanged (no regression to worker flow)', () => {
    const items = menuItemsFor(worker);
    expect(items[0].label).toBe('הבדיקות שלי להיום');
    expect(items[6].label).toBe('סיכום יום');
  });
});
