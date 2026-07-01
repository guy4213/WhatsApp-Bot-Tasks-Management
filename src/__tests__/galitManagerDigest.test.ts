/**
 * D4-T1 — Yoram (Galit v2) manager exceptions digest — FIELD + LEADS portions.
 *
 * Pure formatter tests. Coverage:
 *  - formatGalitManagerMorning / formatGalitManagerEndOfDay:
 *      empty-exceptions single-liner, N exceptions numbered list,
 *      all-null worker/customer fallbacks, problemType-only note fallback,
 *      counts row formatting, leads line rendered with real counts.
 *
 * Dispatcher routing (YORAM_PHONE match vs. legacy paths) lives in
 * `galitManagerDispatcher.test.ts` — kept in a separate file because
 * `vi.mock('../whatsapp/digestContent', ...)` is hoisted for the whole file
 * and would otherwise replace the real formatter under test here.
 */
import { describe, expect, it } from 'vitest';
import {
  formatGalitManagerMorning,
  formatGalitManagerEndOfDay,
} from '../whatsapp/digestContent';
import type {
  FieldExceptionCounts,
  OpenFieldException,
} from '../services/exceptionsQueries';
import type { YoramLeadCounts } from '../services/incomingLeads';

const ZERO_COUNTS: FieldExceptionCounts = {
  finishedFieldToday:  0,
  notConfirmedToday:   0,
  hasProblemToday:     0,
  waitingForInfoToday: 0,
  notClosedDayToday:   0,
};

const SAMPLE_COUNTS: FieldExceptionCounts = {
  finishedFieldToday:  8,
  notConfirmedToday:   1,
  hasProblemToday:     2,
  waitingForInfoToday: 3,
  notClosedDayToday:   1,
};

const ZERO_LEADS: YoramLeadCounts = { overnight: 0, unassigned: 0 };
const SAMPLE_LEADS: YoramLeadCounts = { overnight: 5, unassigned: 3 };

function makeException(overrides: Partial<OpenFieldException> = {}): OpenFieldException {
  return {
    taskFieldId:       'tf-x',
    workerName:        'דני',
    customerName:      'לקוח א',
    siteAddress:       'רחוב 1',
    kind:              'problem',
    note:              'לקוח לא היה במקום',
    problemType:       'CUSTOMER_NOT_PRESENT',
    managerNotifiedAt: null,
    ...overrides,
  };
}

describe('formatGalitManagerMorning', () => {
  it('renders header + counts row + leads line + empty-exceptions one-liner when no open exceptions', () => {
    const { text, params, buttons } = formatGalitManagerMorning({
      counts: ZERO_COUNTS,
      exceptions: [],
      user: { name: 'יורם' },
      leadCounts: ZERO_LEADS,
    });
    // Header (Hebrew, no emoji).
    expect(text).toContain('סיכום גלית');
    expect(text).toContain('יורם');
    // Counts block (labeled multi-line format per product-owner UX update).
    expect(text).toContain('שטח:');
    expect(text).toContain('- בוצעו: 0');
    expect(text).toContain('- לא אושרו: 0');
    expect(text).toContain('- עם בעיה: 0');
    expect(text).toContain('- ממתין למידע: 0');
    expect(text).toContain('- לא סגרו יום: 0');
    // Leads block with real counts (no longer a B2 placeholder).
    expect(text).toContain('לידים:');
    expect(text).toContain('- מהלילה: 0');
    expect(text).toContain('- לא שויכו: 0');
    // No legacy B2 placeholder.
    expect(text).not.toContain('B2');
    // Empty state.
    expect(text).toContain('אין חריגים פתוחים');
    expect(text).not.toContain('פתוחים:');
    expect(text).not.toContain('1.');
    // Template params: name + 5 counts + 2 lead counts.
    expect(params).toEqual(['יורם', '0', '0', '0', '0', '0', '0', '0']);
    // No CTA button — Yoram reacts in the CRM.
    expect(buttons).toEqual([]);
  });

  it('renders lead counts correctly when non-zero', () => {
    const { text, params } = formatGalitManagerMorning({
      counts: ZERO_COUNTS,
      exceptions: [],
      user: { name: 'יורם' },
      leadCounts: SAMPLE_LEADS,
    });
    expect(text).toContain('לידים:');
    expect(text).toContain('- מהלילה: 5');
    expect(text).toContain('- לא שויכו: 3');
    // Params include the lead counts at positions 6 and 7.
    expect(params[6]).toBe('5');
    expect(params[7]).toBe('3');
  });

  it('renders N exceptions as a numbered "פתוחים:" list with counts and leads block', () => {
    const exceptions: OpenFieldException[] = [
      makeException({
        taskFieldId: 'tf-1', workerName: 'דני',  customerName: 'קוקה קולה',
        kind: 'problem',      note: 'לקוח לא היה במקום', problemType: 'CUSTOMER_NOT_PRESENT',
      }),
      makeException({
        taskFieldId: 'tf-2', workerName: 'חיים', customerName: 'ישקר',
        kind: 'missing_info', note: 'חסר טופס דגימה למעבדה', problemType: null,
      }),
      makeException({
        taskFieldId: 'tf-3', workerName: 'יוסי', customerName: 'אמדוקס',
        kind: 'missing_info', note: 'חסר מספר היתר לדוח',    problemType: null,
      }),
    ];

    const { text, params } = formatGalitManagerMorning({
      counts: SAMPLE_COUNTS,
      exceptions,
      user: { name: 'יורם' },
      leadCounts: SAMPLE_LEADS,
    });

    // Counts block (labeled multi-line format).
    expect(text).toContain('שטח:');
    expect(text).toContain('- בוצעו: 8');
    expect(text).toContain('- לא אושרו: 1');
    expect(text).toContain('- עם בעיה: 2');
    expect(text).toContain('- ממתין למידע: 3');
    expect(text).toContain('- לא סגרו יום: 1');
    expect(text).toContain('לידים:');
    expect(text).toContain('- מהלילה: 5');
    expect(text).toContain('- לא שויכו: 3');
    // Numbered list body.
    expect(text).toContain('פתוחים:');
    expect(text).toContain('1. דני — קוקה קולה: לקוח לא היה במקום');
    expect(text).toContain('2. חיים — ישקר: חסר טופס דגימה למעבדה');
    expect(text).toContain('3. יוסי — אמדוקס: חסר מספר היתר לדוח');
    // Order preservation.
    expect(text.indexOf('1. דני')).toBeLessThan(text.indexOf('2. חיים'));
    expect(text.indexOf('2. חיים')).toBeLessThan(text.indexOf('3. יוסי'));
    // Not the empty one-liner.
    expect(text).not.toContain('אין חריגים פתוחים');
    // Template params reflect the 5 field counts + 2 lead counts.
    expect(params).toEqual(['יורם', '8', '1', '2', '3', '1', '5', '3']);
  });

  it('degrades gracefully when workerName / customerName are null', () => {
    const exceptions: OpenFieldException[] = [
      makeException({
        taskFieldId: 'tf-a', workerName: null, customerName: null,
        kind: 'problem', note: 'אין גישה', problemType: 'NO_ACCESS',
      }),
    ];
    const { text } = formatGalitManagerMorning({
      counts: ZERO_COUNTS,
      exceptions,
      user: { name: 'יורם' },
      leadCounts: ZERO_LEADS,
    });
    expect(text).toContain('עובד לא ידוע');
    expect(text).toContain('לקוח לא ידוע');
    expect(text).toContain('אין גישה');
  });

  it('falls back to the problemType Hebrew label when note is null and problemType is set', () => {
    const exceptions: OpenFieldException[] = [
      makeException({
        taskFieldId: 'tf-p', workerName: 'עובד', customerName: 'לקוח',
        kind: 'problem', note: null, problemType: 'CUSTOMER_NOT_ANSWERING',
      }),
    ];
    const { text } = formatGalitManagerMorning({
      counts: ZERO_COUNTS,
      exceptions,
      user: { name: 'יורם' },
      leadCounts: ZERO_LEADS,
    });
    // From problemTypeMenu()[0].label — 'הלקוח לא ענה'.
    expect(text).toContain('הלקוח לא ענה');
  });

  it('uses "—" placeholder when note is null AND problemType is null', () => {
    const exceptions: OpenFieldException[] = [
      makeException({
        taskFieldId: 'tf-m', workerName: 'עובד', customerName: 'לקוח',
        kind: 'missing_info', note: null, problemType: null,
      }),
    ];
    const { text } = formatGalitManagerMorning({
      counts: ZERO_COUNTS,
      exceptions,
      user: { name: 'יורם' },
      leadCounts: ZERO_LEADS,
    });
    expect(text).toContain('1. עובד — לקוח: —');
  });

  it('handles null name on the user without crashing', () => {
    const { text, params } = formatGalitManagerMorning({
      counts: ZERO_COUNTS,
      exceptions: [],
      user: { name: null },
      leadCounts: ZERO_LEADS,
    });
    expect(text).toContain('סיכום גלית');
    expect(params[0]).toBe('');
  });
});

describe('formatGalitManagerEndOfDay', () => {
  it('renders end-of-day header + counts + leads line + empty exceptions one-liner', () => {
    const { text, params, buttons } = formatGalitManagerEndOfDay({
      counts: ZERO_COUNTS,
      exceptions: [],
      user: { name: 'יורם' },
      leadCounts: ZERO_LEADS,
    });
    expect(text).toContain('סיכום סוף יום');
    expect(text).toContain('יורם');
    expect(text).toContain('שטח:');
    expect(text).toContain('- בוצעו: 0');
    expect(text).toContain('לידים:');
    expect(text).toContain('- מהלילה: 0');
    expect(text).toContain('- לא שויכו: 0');
    expect(text).not.toContain('B2');
    expect(text).toContain('אין חריגים פתוחים');
    expect(params).toEqual(['יורם', '0', '0', '0', '0', '0', '0', '0']);
    expect(buttons).toEqual([]);
  });

  it('renders lead counts correctly when non-zero', () => {
    const { text, params } = formatGalitManagerEndOfDay({
      counts: ZERO_COUNTS,
      exceptions: [],
      user: { name: 'יורם' },
      leadCounts: SAMPLE_LEADS,
    });
    expect(text).toContain('לידים:');
    expect(text).toContain('- מהלילה: 5');
    expect(text).toContain('- לא שויכו: 3');
    expect(params[6]).toBe('5');
    expect(params[7]).toBe('3');
  });

  it('renders N exceptions numbered with counts and leads block', () => {
    const exceptions: OpenFieldException[] = [
      makeException({ workerName: 'דני', customerName: 'ק', note: 'ל לא היה' }),
      makeException({ workerName: 'חיים', customerName: 'י', note: 'חסר טופס' }),
    ];
    const { text, params } = formatGalitManagerEndOfDay({
      counts: SAMPLE_COUNTS,
      exceptions,
      user: { name: 'יורם' },
      leadCounts: SAMPLE_LEADS,
    });
    expect(text).toContain('סיכום סוף יום — יורם');
    expect(text).toContain('שטח:');
    expect(text).toContain('- בוצעו: 8');
    expect(text).toContain('לידים:');
    expect(text).toContain('- מהלילה: 5');
    expect(text).toContain('- לא שויכו: 3');
    expect(text).toContain('1. דני — ק: ל לא היה');
    expect(text).toContain('2. חיים — י: חסר טופס');
    expect(params).toEqual(['יורם', '8', '1', '2', '3', '1', '5', '3']);
  });

  it('degrades on null worker/customer/note+problemType', () => {
    const exceptions: OpenFieldException[] = [
      makeException({
        workerName: null, customerName: null, kind: 'missing_info',
        note: null, problemType: null,
      }),
    ];
    const { text } = formatGalitManagerEndOfDay({
      counts: ZERO_COUNTS,
      exceptions,
      user: { name: 'יורם' },
      leadCounts: ZERO_LEADS,
    });
    expect(text).toContain('עובד לא ידוע');
    expect(text).toContain('לקוח לא ידוע');
    expect(text).toContain(': —');
  });

  it('falls back to problemType Hebrew label when note is null and problemType is set', () => {
    const exceptions: OpenFieldException[] = [
      makeException({
        workerName: 'עובד', customerName: 'לקוח', kind: 'problem',
        note: null, problemType: 'MISSING_EQUIPMENT',
      }),
    ];
    const { text } = formatGalitManagerEndOfDay({
      counts: ZERO_COUNTS,
      exceptions,
      user: { name: 'יורם' },
      leadCounts: ZERO_LEADS,
    });
    // From problemTypeMenu()[3].label.
    expect(text).toContain('חסר ציוד');
  });
});
