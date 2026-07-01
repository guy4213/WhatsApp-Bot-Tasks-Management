/**
 * D4-T1 — Yoram (Galit v2) manager exceptions digest — FIELD portion only.
 *
 * Pure formatter tests. Coverage:
 *  - formatGalitManagerMorning / formatGalitManagerEndOfDay:
 *      empty-exceptions single-liner, N exceptions numbered list,
 *      all-null worker/customer fallbacks, problemType-only note fallback,
 *      counts row formatting, leads TODO placeholder present in both.
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
  it('renders header + counts row + leads TODO + empty-exceptions one-liner when no open exceptions', () => {
    const { text, params, buttons } = formatGalitManagerMorning({
      counts: ZERO_COUNTS,
      exceptions: [],
      user: { name: 'יורם' },
    });
    // Header (Hebrew, no emoji).
    expect(text).toContain('סיכום גלית');
    expect(text).toContain('יורם');
    // Counts row per §13.
    expect(text).toContain('שטח: בוצעו 0');
    expect(text).toContain('לא אושרו 0');
    expect(text).toContain('עם בעיה 0');
    expect(text).toContain('ממתינות למידע 0');
    expect(text).toContain('לא סגרו יום 0');
    // Leads B2 TODO placeholder — must be visually distinct.
    expect(text).toContain('לידים:');
    expect(text).toContain('B2');
    // Empty state.
    expect(text).toContain('אין חריגים פתוחים');
    expect(text).not.toContain('פתוחים:');
    expect(text).not.toContain('1.');
    // Template params: name + 5 counts, in the declared order.
    expect(params).toEqual(['יורם', '0', '0', '0', '0', '0']);
    // No CTA button — Yoram reacts in the CRM.
    expect(buttons).toEqual([]);
  });

  it('renders N exceptions as a numbered "פתוחים:" list with counts and leads TODO', () => {
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
    });

    // Counts populated from SAMPLE_COUNTS.
    expect(text).toContain('שטח: בוצעו 8 · לא אושרו 1 · עם בעיה 2 · ממתינות למידע 3 · לא סגרו יום 1');
    expect(text).toContain('לידים:');
    expect(text).toContain('B2');
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
    // Template params reflect the 5 counts.
    expect(params).toEqual(['יורם', '8', '1', '2', '3', '1']);
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
    });
    expect(text).toContain('1. עובד — לקוח: —');
  });

  it('handles null name on the user without crashing', () => {
    const { text, params } = formatGalitManagerMorning({
      counts: ZERO_COUNTS,
      exceptions: [],
      user: { name: null },
    });
    expect(text).toContain('סיכום גלית');
    expect(params[0]).toBe('');
  });
});

describe('formatGalitManagerEndOfDay', () => {
  it('renders end-of-day header + counts + leads TODO + empty exceptions one-liner', () => {
    const { text, params, buttons } = formatGalitManagerEndOfDay({
      counts: ZERO_COUNTS,
      exceptions: [],
      user: { name: 'יורם' },
    });
    expect(text).toContain('סיכום סוף יום');
    expect(text).toContain('יורם');
    expect(text).toContain('שטח: בוצעו 0');
    expect(text).toContain('לידים:');
    expect(text).toContain('B2');
    expect(text).toContain('אין חריגים פתוחים');
    expect(params).toEqual(['יורם', '0', '0', '0', '0', '0']);
    expect(buttons).toEqual([]);
  });

  it('renders N exceptions numbered with counts and leads TODO', () => {
    const exceptions: OpenFieldException[] = [
      makeException({ workerName: 'דני', customerName: 'ק', note: 'ל לא היה' }),
      makeException({ workerName: 'חיים', customerName: 'י', note: 'חסר טופס' }),
    ];
    const { text, params } = formatGalitManagerEndOfDay({
      counts: SAMPLE_COUNTS,
      exceptions,
      user: { name: 'יורם' },
    });
    expect(text).toContain('סיכום סוף יום — יורם');
    expect(text).toContain('שטח: בוצעו 8');
    expect(text).toContain('לידים:');
    expect(text).toContain('1. דני — ק: ל לא היה');
    expect(text).toContain('2. חיים — י: חסר טופס');
    expect(params).toEqual(['יורם', '8', '1', '2', '3', '1']);
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
    });
    // From problemTypeMenu()[3].label.
    expect(text).toContain('חסר ציוד');
  });
});
