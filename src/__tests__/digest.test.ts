import { describe, it, expect } from 'vitest';
import { parseTimeInput } from '../services/digestPreferences';
import { minutesOfDay, isDigestDue } from '../scheduler/jobs/digestDispatcher';
import {
  digestTemplateKey,
  formatEmployeeMorning,
  formatManagerMorning,
  formatEmployeeEndOfDay,
  formatManagerEndOfDay,
} from '../whatsapp/digestContent';
import { DIGEST_PAYLOAD_IDS } from '../ai/digestCommands';
import type {
  EmployeeMorningCounts, EmployeeEndOfDay, CompanyMorning, CompanyEndOfDay,
} from '../services/tasks';

// ── parseTimeInput ──────────────────────────────────────────────────────────────

describe('parseTimeInput', () => {
  it('accepts bare hour, H:MM and HH:MM, normalizing to HH:MM', () => {
    expect(parseTimeInput('8')).toBe('08:00');
    expect(parseTimeInput('8:30')).toBe('08:30');
    expect(parseTimeInput('08:00')).toBe('08:00');
    expect(parseTimeInput('17')).toBe('17:00');
    expect(parseTimeInput('8:5')).toBe('08:05');
    expect(parseTimeInput('  9 ')).toBe('09:00');
    expect(parseTimeInput('00:00')).toBe('00:00');
    expect(parseTimeInput('23:59')).toBe('23:59');
  });

  it('rejects out-of-range / malformed / empty input', () => {
    expect(parseTimeInput('25:00')).toBeNull();
    expect(parseTimeInput('8:99')).toBeNull();
    expect(parseTimeInput('24:00')).toBeNull();
    expect(parseTimeInput('abc')).toBeNull();
    expect(parseTimeInput('')).toBeNull();
    expect(parseTimeInput('   ')).toBeNull();
    expect(parseTimeInput('8:30am')).toBeNull();
    expect(parseTimeInput(undefined)).toBeNull();
    expect(parseTimeInput(830)).toBeNull();
  });
});

// ── minutesOfDay / isDigestDue ──────────────────────────────────────────────────

describe('minutesOfDay', () => {
  it('converts HH:MM to minutes-since-midnight', () => {
    expect(minutesOfDay('00:00')).toBe(0);
    expect(minutesOfDay('08:00')).toBe(480);
    expect(minutesOfDay('17:30')).toBe(1050);
  });
  it('returns NaN on malformed input', () => {
    expect(Number.isNaN(minutesOfDay('nope'))).toBe(true);
    expect(Number.isNaN(minutesOfDay('99:99'))).toBe(true);
  });
});

describe('isDigestDue (5-minute window)', () => {
  it('fires only inside [configured, configured+5min)', () => {
    expect(isDigestDue('08:00', '08:00')).toBe(true);   // exact
    expect(isDigestDue('08:00', '08:04')).toBe(true);   // within window
    expect(isDigestDue('08:00', '08:05')).toBe(false);  // window exclusive upper bound
    expect(isDigestDue('08:00', '07:59')).toBe(false);  // before
    expect(isDigestDue('08:00', '08:06')).toBe(false);  // after
    expect(isDigestDue('17:00', '17:02')).toBe(true);
    expect(isDigestDue('17:00', '16:58')).toBe(false);
  });
  it('returns false on malformed times', () => {
    expect(isDigestDue('bad', '08:00')).toBe(false);
    expect(isDigestDue('08:00', 'bad')).toBe(false);
  });
});

// ── digestTemplateKey ───────────────────────────────────────────────────────────

describe('digestTemplateKey', () => {
  it('maps role × type to the four keys', () => {
    expect(digestTemplateKey({ isElevated: false }, 'MORNING')).toBe('EMPLOYEE_MORNING_DIGEST');
    expect(digestTemplateKey({ isElevated: false }, 'EVENING')).toBe('EMPLOYEE_END_OF_DAY_REPORT');
    expect(digestTemplateKey({ isElevated: true }, 'MORNING')).toBe('MANAGER_MORNING_DIGEST');
    expect(digestTemplateKey({ isElevated: true }, 'EVENING')).toBe('MANAGER_END_OF_DAY_REPORT');
  });
});

// ── Morning formatters ──────────────────────────────────────────────────────────

describe('formatEmployeeMorning', () => {
  it('renders own due-today / overdue / open and has NO per-employee data', () => {
    const counts: EmployeeMorningCounts = { dueToday: 3, overdue: 1, open: 5 };
    const { text, params } = formatEmployeeMorning('דנה', counts);
    expect(params).toEqual(['דנה', '3', '1', '5']);
    expect(text).toContain('בוקר טוב דנה');
    expect(text).toContain('3 משימות להיום');
    expect(text).toContain('1 באיחור');
    expect(text).toContain('5 פתוחות');
    // An employee morning must never include a per-employee breakdown.
    expect(text).not.toContain('פירוט לפי עובד');
  });

  it('attaches the employee-today + free-text quick-reply buttons', () => {
    const { buttons } = formatEmployeeMorning('דנה', { dueToday: 1, overdue: 0, open: 2 });
    expect(buttons.map((b) => b.id)).toEqual([DIGEST_PAYLOAD_IDS.EMP_TODAY, DIGEST_PAYLOAD_IDS.FREE_TEXT]);
    for (const b of buttons) expect(b.title.length).toBeLessThanOrEqual(20);
  });
});

describe('formatManagerMorning', () => {
  it('adds per-employee breakdown + #employees-with-overdue', () => {
    const co: CompanyMorning = {
      dueToday: 6, overdue: 2, open: 9, employeesWithOverdue: 1,
      employees: [
        { ownerId: 'a', ownerName: 'אבי', dueToday: 4, overdue: 2, open: 6 },
        { ownerId: 'b', ownerName: 'בני', dueToday: 2, overdue: 0, open: 3 },
      ],
    };
    const { text, params, buttons } = formatManagerMorning('מנהל', co);
    expect(params).toEqual(['מנהל', '6', '2', '9', '1']);
    expect(text).toContain('פירוט לפי עובד');
    expect(text).toContain('אבי');
    expect(text).toContain('בני');
    expect(text).toContain('עובדים עם משימות באיחור');
    // Team-today + free-text quick replies.
    expect(buttons.map((b) => b.id)).toEqual([DIGEST_PAYLOAD_IDS.TEAM_TODAY, DIGEST_PAYLOAD_IDS.FREE_TEXT]);
  });
});

// ── End-of-day formatters ───────────────────────────────────────────────────────

describe('formatEmployeeEndOfDay', () => {
  const eod: EmployeeEndOfDay = {
    dueToday: 4, completed: 3, notCompleted: 1, overdue: 2, openCarry: 5,
    unfinishedTitles: ['משימה א', 'משימה ב'],
  };

  it('completed + notCompleted === dueToday, and renders overdue + carry-over', () => {
    expect(eod.completed + eod.notCompleted).toBe(eod.dueToday);
    const { text, params } = formatEmployeeEndOfDay('דנה', eod);
    expect(params).toEqual(['דנה', '4', '3', '1', '2', '5']);
    expect(text).toContain('2 באיחור');
    expect(text).toContain('5 פתוחות שעוברות למחר');
  });

  it('lists own unfinished titles (in-window detail)', () => {
    const { text } = formatEmployeeEndOfDay('דנה', eod);
    expect(text).toContain('משימה א');
    expect(text).toContain('משימה ב');
  });

  it('attaches the employee-EOD + free-text quick-reply buttons', () => {
    const { buttons } = formatEmployeeEndOfDay('דנה', eod);
    expect(buttons.map((b) => b.id)).toEqual([DIGEST_PAYLOAD_IDS.EMP_EOD, DIGEST_PAYLOAD_IDS.FREE_TEXT]);
  });

  it('is labelled "current end-of-day status" — no false "completed today" claim', () => {
    const { text } = formatEmployeeEndOfDay('דנה', eod);
    expect(text).toContain('סטטוס נוכחי לסוף היום');
    // Must not assert tasks were completed *today* as a historical fact.
    expect(text).not.toContain('בוצעו היום');
    expect(text).not.toContain('הושלמו היום');
  });
});

describe('formatManagerEndOfDay', () => {
  const co: CompanyEndOfDay = {
    dueToday: 7, completed: 4, notCompleted: 3, overdue: 2, openCarry: 8,
    employeesWithUnfinishedOrOverdue: 1,
    employees: [
      { ownerId: 'a', ownerName: 'אבי', dueToday: 5, completed: 2, notCompleted: 3, overdue: 2, openCarry: 5 },
      { ownerId: 'b', ownerName: 'בני', dueToday: 2, completed: 2, notCompleted: 0, overdue: 0, openCarry: 3 },
    ],
  };

  it('includes per-employee breakdown + highlights behind employees, labelled current status', () => {
    const { text, params, buttons } = formatManagerEndOfDay('מנהל', co);
    expect(params).toEqual(['מנהל', '7', '4', '3', '2', '8', '1']);
    expect(text).toContain('סטטוס נוכחי לסוף היום');
    expect(text).toContain('פירוט לפי עובד');
    expect(text).toContain('אבי');
    expect(text).toContain('בני');
    expect(text).toContain('עובדים עם משימות פתוחות/באיחור');
    expect(text).not.toContain('בוצעו היום');
    // Team-EOD + free-text quick replies.
    expect(buttons.map((b) => b.id)).toEqual([DIGEST_PAYLOAD_IDS.TEAM_EOD, DIGEST_PAYLOAD_IDS.FREE_TEXT]);
  });
});
