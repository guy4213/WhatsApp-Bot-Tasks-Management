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
});
