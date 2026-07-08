/**
 * Unit tests for `parseHebrewInspectionRange` — pure, deterministic behavior.
 *
 * `nowJerusalem` is pinned to 2026-07-02T09:00:00Z (12:00 Asia/Jerusalem —
 * Thursday, dow=4, weekday of week 2026-06-28..2026-07-04). Every case computes
 * expected dates from that pinned instant.
 */
import { describe, it, expect } from 'vitest';
import { parseHebrewInspectionRange } from '../ai/dateRangeParser';

// Thursday 2026-07-02 12:00 Asia/Jerusalem.
const NOW = new Date('2026-07-02T09:00:00Z');

// Sunday 2026-06-28 12:00 Asia/Jerusalem — edge case for "שבוע שעבר" when
// "today" itself is the first day of the work-week.
const NOW_SUNDAY = new Date('2026-06-28T09:00:00Z');

describe('parseHebrewInspectionRange', () => {
  it('"היום" → today [2026-07-02, 2026-07-03)', () => {
    const r = parseHebrewInspectionRange('היום', NOW);
    expect(r).not.toBeNull();
    expect(r!.fromLocalDate).toBe('2026-07-02');
    expect(r!.toLocalDate).toBe('2026-07-03');
    expect(r!.label).toContain('היום');
    expect(r!.label).toContain('02/07');
  });

  it('"מחר" → tomorrow [2026-07-03, 2026-07-04)', () => {
    const r = parseHebrewInspectionRange('מחר', NOW);
    expect(r).not.toBeNull();
    expect(r!.fromLocalDate).toBe('2026-07-03');
    expect(r!.toLocalDate).toBe('2026-07-04');
    expect(r!.label).toContain('מחר');
    expect(r!.label).toContain('03/07');
  });

  it('"השבוע" → Sunday..next Sunday (half-open); Thursday 2026-07-02 is in week 2026-06-28..2026-07-05', () => {
    const r = parseHebrewInspectionRange('השבוע', NOW);
    expect(r).not.toBeNull();
    // Sunday of this week: 2026-06-28
    expect(r!.fromLocalDate).toBe('2026-06-28');
    // Half-open upper bound: next Sunday 2026-07-05
    expect(r!.toLocalDate).toBe('2026-07-05');
    expect(r!.label).toContain('השבוע');
  });

  it('"שבוע הבא" → next Sunday..following Sunday', () => {
    const r = parseHebrewInspectionRange('שבוע הבא', NOW);
    expect(r).not.toBeNull();
    expect(r!.fromLocalDate).toBe('2026-07-05');
    expect(r!.toLocalDate).toBe('2026-07-12');
    expect(r!.label).toContain('שבוע הבא');
  });

  it('"בין 1/7 ל-10/7" → 2026-07-01..2026-07-11 (half-open)', () => {
    const r = parseHebrewInspectionRange('בין 1/7 ל-10/7', NOW);
    expect(r).not.toBeNull();
    expect(r!.fromLocalDate).toBe('2026-07-01');
    expect(r!.toLocalDate).toBe('2026-07-11');
  });

  it('"יום ראשון" → next Sunday 2026-07-05', () => {
    const r = parseHebrewInspectionRange('יום ראשון', NOW);
    expect(r).not.toBeNull();
    expect(r!.fromLocalDate).toBe('2026-07-05');
    expect(r!.toLocalDate).toBe('2026-07-06');
    expect(r!.label).toContain('יום ראשון');
  });

  it('"שבת" → next Saturday 2026-07-04', () => {
    const r = parseHebrewInspectionRange('שבת', NOW);
    expect(r).not.toBeNull();
    expect(r!.fromLocalDate).toBe('2026-07-04');
    expect(r!.toLocalDate).toBe('2026-07-05');
    expect(r!.label).toContain('שבת');
  });

  it('garbage input → null', () => {
    const r = parseHebrewInspectionRange('פלאבלה גיברש', NOW);
    expect(r).toBeNull();
  });

  it('"החודש" → 2026-07-01..2026-08-01', () => {
    const r = parseHebrewInspectionRange('החודש', NOW);
    expect(r).not.toBeNull();
    expect(r!.fromLocalDate).toBe('2026-07-01');
    expect(r!.toLocalDate).toBe('2026-08-01');
    expect(r!.label).toContain('החודש');
  });

  it('"חודש הבא" → 2026-08-01..2026-09-01', () => {
    const r = parseHebrewInspectionRange('חודש הבא', NOW);
    expect(r).not.toBeNull();
    expect(r!.fromLocalDate).toBe('2026-08-01');
    expect(r!.toLocalDate).toBe('2026-09-01');
    expect(r!.label).toContain('חודש הבא');
  });

  it('tolerates a leading "הבדיקות שלי " prefix', () => {
    const r = parseHebrewInspectionRange('הבדיקות שלי היום', NOW);
    expect(r).not.toBeNull();
    expect(r!.fromLocalDate).toBe('2026-07-02');
  });

  it('single day "ב-15/7" → 2026-07-15..2026-07-16', () => {
    const r = parseHebrewInspectionRange('ב-15/7', NOW);
    expect(r).not.toBeNull();
    expect(r!.fromLocalDate).toBe('2026-07-15');
    expect(r!.toLocalDate).toBe('2026-07-16');
  });

  it('unspecified past year bumps to next year (single date)', () => {
    // 1/1 relative to 2026-07-02 is in the past → bump to 2027-01-01
    const r = parseHebrewInspectionRange('ב-1/1', NOW);
    expect(r).not.toBeNull();
    expect(r!.fromLocalDate).toBe('2027-01-01');
  });

  it('unspecified past year bumps to next year (range)', () => {
    const r = parseHebrewInspectionRange('בין 1/1 ל-5/1', NOW);
    expect(r).not.toBeNull();
    expect(r!.fromLocalDate).toBe('2027-01-01');
    expect(r!.toLocalDate).toBe('2027-01-06');
  });

  // ── QA-FIX-7: past vocabulary ──────────────────────────────────────────

  describe('אתמול (QA-FIX-7)', () => {
    it('"אתמול" → yesterday [2026-07-01, 2026-07-02)', () => {
      const r = parseHebrewInspectionRange('אתמול', NOW);
      expect(r).not.toBeNull();
      expect(r!.fromLocalDate).toBe('2026-07-01');
      expect(r!.toLocalDate).toBe('2026-07-02');
      expect(r!.label).toContain('אתמול');
      expect(r!.label).toContain('01/07');
    });

    it('"מאתמול" → same as "אתמול"', () => {
      const r = parseHebrewInspectionRange('מאתמול', NOW);
      expect(r).not.toBeNull();
      expect(r!.fromLocalDate).toBe('2026-07-01');
      expect(r!.toLocalDate).toBe('2026-07-02');
    });

    it('"של אתמול" → same as "אתמול"', () => {
      const r = parseHebrewInspectionRange('של אתמול', NOW);
      expect(r).not.toBeNull();
      expect(r!.fromLocalDate).toBe('2026-07-01');
      expect(r!.toLocalDate).toBe('2026-07-02');
    });

    it('tolerates the "הבדיקות שלי" prefix', () => {
      const r = parseHebrewInspectionRange('הבדיקות שלי אתמול', NOW);
      expect(r).not.toBeNull();
      expect(r!.fromLocalDate).toBe('2026-07-01');
    });
  });

  it('"שלשום" → [2026-06-30, 2026-07-01)', () => {
    const r = parseHebrewInspectionRange('שלשום', NOW);
    expect(r).not.toBeNull();
    expect(r!.fromLocalDate).toBe('2026-06-30');
    expect(r!.toLocalDate).toBe('2026-07-01');
    expect(r!.label).toContain('שלשום');
    expect(r!.label).toContain('30/06');
  });

  describe('שבוע שעבר (QA-FIX-7)', () => {
    it('"שבוע שעבר" → previous work-week [2026-06-21, 2026-06-28) (from Thursday)', () => {
      const r = parseHebrewInspectionRange('שבוע שעבר', NOW);
      expect(r).not.toBeNull();
      expect(r!.fromLocalDate).toBe('2026-06-21');
      expect(r!.toLocalDate).toBe('2026-06-28');
      expect(r!.label).toContain('שבוע שעבר');
    });

    it('"בשבוע שעבר" variant', () => {
      const r = parseHebrewInspectionRange('בשבוע שעבר', NOW);
      expect(r).not.toBeNull();
      expect(r!.fromLocalDate).toBe('2026-06-21');
      expect(r!.toLocalDate).toBe('2026-06-28');
    });

    it('"השבוע שעבר" variant', () => {
      const r = parseHebrewInspectionRange('השבוע שעבר', NOW);
      expect(r).not.toBeNull();
      expect(r!.fromLocalDate).toBe('2026-06-21');
      expect(r!.toLocalDate).toBe('2026-06-28');
    });

    it('"משבוע שעבר" variant', () => {
      const r = parseHebrewInspectionRange('משבוע שעבר', NOW);
      expect(r).not.toBeNull();
      expect(r!.fromLocalDate).toBe('2026-06-21');
      expect(r!.toLocalDate).toBe('2026-06-28');
    });

    it('Sunday edge case: "today" is itself the first day of the work-week', () => {
      // NOW_SUNDAY = 2026-06-28 (Sunday). This week's Sunday == today, so
      // "שבוע שעבר" must resolve to the PRIOR week, not overlap today.
      const r = parseHebrewInspectionRange('שבוע שעבר', NOW_SUNDAY);
      expect(r).not.toBeNull();
      expect(r!.fromLocalDate).toBe('2026-06-21');
      expect(r!.toLocalDate).toBe('2026-06-28');
    });
  });

  describe('חודש שעבר (QA-FIX-7)', () => {
    it('"חודש שעבר" → previous calendar month [2026-06-01, 2026-07-01)', () => {
      const r = parseHebrewInspectionRange('חודש שעבר', NOW);
      expect(r).not.toBeNull();
      expect(r!.fromLocalDate).toBe('2026-06-01');
      expect(r!.toLocalDate).toBe('2026-07-01');
      expect(r!.label).toContain('חודש שעבר');
    });

    it('"בחודש שעבר" variant', () => {
      const r = parseHebrewInspectionRange('בחודש שעבר', NOW);
      expect(r).not.toBeNull();
      expect(r!.fromLocalDate).toBe('2026-06-01');
      expect(r!.toLocalDate).toBe('2026-07-01');
    });

    it('"מהחודש שעבר" variant', () => {
      const r = parseHebrewInspectionRange('מהחודש שעבר', NOW);
      expect(r).not.toBeNull();
      expect(r!.fromLocalDate).toBe('2026-06-01');
      expect(r!.toLocalDate).toBe('2026-07-01');
    });

    it('year rollover: January → previous month is December of the prior year', () => {
      // 15 Jan 2027, 12:00 Asia/Jerusalem → 09:00 UTC.
      const januaryNow = new Date('2027-01-15T09:00:00Z');
      const r = parseHebrewInspectionRange('חודש שעבר', januaryNow);
      expect(r).not.toBeNull();
      expect(r!.fromLocalDate).toBe('2026-12-01');
      expect(r!.toLocalDate).toBe('2027-01-01');
    });
  });
});
