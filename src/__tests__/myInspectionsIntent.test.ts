/**
 * Regression tests for MY_INSPECTIONS_RE — the free-text fast-path regex that
 * detects "הבדיקות שלי …" and related phrases before the AI parser runs.
 *
 * Locks in two shape decisions:
 *   1. The generic "מה יש לי" phrase is NOT a fast-path match on its own — it
 *      only matches when followed by a Hebrew date-cue. Prevents false-positive
 *      routing on unrelated queries like "מה יש לי לעשות" / "מה יש לי בסופר".
 *   2. All explicit "inspections" alternatives ARE self-contained (empty suffix
 *      → suffix is empty → router defaults to today).
 *
 * The router imports and applies the regex; this file only tests the regex.
 */
import { describe, it, expect } from 'vitest';

// Pull only the regex — no DB, no router side effects.
import { MY_INSPECTIONS_RE } from '../ai/router';

function match(text: string): { matched: boolean; suffix: string } {
  const m = text.match(MY_INSPECTIONS_RE);
  if (!m) return { matched: false, suffix: '' };
  return { matched: true, suffix: (m[2] ?? '').trim() };
}

describe('MY_INSPECTIONS_RE — self-contained alternatives (empty suffix OK)', () => {
  it('matches bare "הבדיקות שלי" with empty suffix', () => {
    const r = match('הבדיקות שלי');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('');
  });

  it('matches "הבדיקות שלי היום" with "היום" as suffix', () => {
    const r = match('הבדיקות שלי היום');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('היום');
  });

  it('matches "בדיקות השטח שלי בין 1/7 ל-10/7"', () => {
    const r = match('בדיקות השטח שלי בין 1/7 ל-10/7');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('בין 1/7 ל-10/7');
  });

  it('matches "תראה לי את בדיקות השטח שלי לעוד שבוע" (user brief example)', () => {
    const r = match('תראה לי את בדיקות השטח שלי לעוד שבוע');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('לעוד שבוע');
  });

  it('matches "איזה בדיקות יש לי בחודש הבא"', () => {
    const r = match('איזה בדיקות יש לי בחודש הבא');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('בחודש הבא');
  });
});

describe('MY_INSPECTIONS_RE — "מה יש לי" requires a date-cue', () => {
  it('matches "מה יש לי היום"', () => {
    const r = match('מה יש לי היום');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('היום');
  });

  it('matches "מה יש לי ביום ראשון" (user brief example)', () => {
    const r = match('מה יש לי ביום ראשון');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('ביום ראשון');
  });

  it('matches "מה יש לי השבוע"', () => {
    const r = match('מה יש לי השבוע');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('השבוע');
  });

  it('does NOT match bare "מה יש לי" (ambiguous — could mean tasks)', () => {
    expect(match('מה יש לי').matched).toBe(false);
  });

  it('does NOT match "מה יש לי לעשות" (task question, not inspections)', () => {
    expect(match('מה יש לי לעשות').matched).toBe(false);
  });

  it('does NOT match "מה יש לי בסופר" (unrelated)', () => {
    expect(match('מה יש לי בסופר').matched).toBe(false);
  });
});

describe('MY_INSPECTIONS_RE — negative cases (do not misroute unrelated free text)', () => {
  it('does NOT match "מה קורה עם בדיקות"', () => {
    expect(match('מה קורה עם בדיקות').matched).toBe(false);
  });

  it('does NOT match "בדיקות" alone', () => {
    expect(match('בדיקות').matched).toBe(false);
  });

  it('does NOT match "שלי" alone', () => {
    expect(match('שלי').matched).toBe(false);
  });
});

// QA-FIX-6: a MANAGER asking "המשימות שלי" (using "משימות" instead of
// "בדיקות") must hit the same fast path so it stops falling through to the
// AI parser as an org-wide "today only" list or `unknown`.
describe('MY_INSPECTIONS_RE — "משימות" synonym (QA-FIX-6)', () => {
  it('matches "המשימות שלי" with empty suffix', () => {
    const r = match('המשימות שלי');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('');
  });

  it('matches "המשימות שלי למחר" with "למחר" as suffix', () => {
    const r = match('המשימות שלי למחר');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('למחר');
  });

  it('matches "תציג לי את המשימות שלי למחר" (display-verb prefix) with "למחר" as suffix', () => {
    const r = match('תציג לי את המשימות שלי למחר');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('למחר');
  });

  it('matches "משימות שלי השבוע" (no leading ה) with "השבוע" as suffix', () => {
    const r = match('משימות שלי השבוע');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('השבוע');
  });

  it('matches "רשימת המשימות שלי" with empty suffix', () => {
    const r = match('רשימת המשימות שלי');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('');
  });

  it('matches "איזה משימות יש לי" with empty suffix', () => {
    const r = match('איזה משימות יש לי');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('');
  });

  it('still matches the old "הבדיקות שלי למחר" form (no regression)', () => {
    const r = match('הבדיקות שלי למחר');
    expect(r.matched).toBe(true);
    expect(r.suffix).toBe('למחר');
  });

  it('does NOT match "משימות עם בעיה" (exceptions phrase, not "my inspections")', () => {
    expect(match('משימות עם בעיה').matched).toBe(false);
  });

  it('does NOT match "משימות" alone (no "שלי" suffix)', () => {
    expect(match('משימות').matched).toBe(false);
  });

  it('does NOT match "משימות השטח שלי" (no such variant — "השטח" only follows "בדיקות")', () => {
    expect(match('משימות השטח שלי').matched).toBe(false);
  });
});
