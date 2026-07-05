/**
 * workerFewShotPhrasings.test.ts — Phase 2 regex-only sanity checks.
 *
 * Verifies:
 *  - MY_INSPECTIONS_RE still catches all the expected worker phrasings
 *    (no false-negatives introduced by Phase 2 changes).
 *  - MY_INSPECTIONS_RE does NOT false-positive on manager phrases
 *    (e.g. org-wide dashboard requests should stay out of the regex fast-path).
 *  - MENU_TRIGGER_RE Phase 2 expansions are correct.
 *  - MENU_TRIGGER_RE Phase 2 expansions do NOT catch mid-sentence mentions.
 */
import { describe, it, expect } from 'vitest';
import { MY_INSPECTIONS_RE } from '../ai/router';
import { MENU_TRIGGER_RE } from '../ai/menu';

// ── MY_INSPECTIONS_RE — worker phrasings that SHOULD match ───────────────────

describe('MY_INSPECTIONS_RE — worker phrasings (Phase 2 no-regression)', () => {
  const shouldMatch = [
    // Core direct forms
    'הבדיקות שלי',
    'הבדיקות שלי היום',
    'הבדיקות שלי למחר',
    'הבדיקות שלי השבוע',
    'הבדיקות שלי בשבוע הבא',
    // Display-verb prefixes
    'הצג את הבדיקות שלי',
    'הצג לי את הבדיקות שלי',
    'תציג לי את הבדיקות שלי',
    'תראה לי את הבדיקות שלי',
    'תן לי את הבדיקות שלי',
    'אני רוצה לראות את הבדיקות שלי',
    // List forms
    'רשימת הבדיקות שלי',
    'רשימה של הבדיקות שלי',
    'איזה בדיקות יש לי',
    // Open-day forms
    'היום שלי',
    'מה היום שלי',
    'מה על הפרק',
    'מה מחכה לי',
    // Date-cue required forms
    'מה יש לי היום',
    'מה יש לי מחר',
    'מה יש לי השבוע',
  ];

  it.each(shouldMatch)('matches worker phrase: "%s"', (phrase) => {
    expect(MY_INSPECTIONS_RE.test(phrase)).toBe(true);
  });
});

// ── MY_INSPECTIONS_RE — manager/org-wide phrases that MUST NOT match ─────────

describe('MY_INSPECTIONS_RE — must NOT false-positive on manager phrases', () => {
  const shouldNotMatch = [
    // Manager-side org-wide phrases
    'בדיקות שטח להיום',
    'רשימת בדיקות היום',
    'מה יש היום בשטח',
    'כמה בדיקות יש היום',
    'תציג לי את בדיקות השטח להיום',
    // Generic phrases that must NOT match (no date cue)
    'מה יש לי',             // ambiguous, no date cue → correctly not matched
    'מה קורה עם הבדיקות',  // general question, not "my inspections"
    'יצאתי לרעננה',         // status update
    'הלקוח לא ענה',         // problem report
    'כן',                   // bare affirmative
    'יש לי בעיה',           // problem report start
  ];

  it.each(shouldNotMatch)('does NOT match: "%s"', (phrase) => {
    expect(MY_INSPECTIONS_RE.test(phrase)).toBe(false);
  });
});

// ── MENU_TRIGGER_RE — Phase 2 new trigger phrases ────────────────────────────

describe('MENU_TRIGGER_RE — Phase 2 expanded triggers', () => {
  const shouldMatch = [
    // Existing triggers still work
    'menu',
    'תפריט',
    'עזרה',
    'היי',
    'שלום',
    // Phase 2 additions
    'תראה לי את התפריט',
    'תראה לי התפריט',
    'הצג לי את התפריט',
    'הצג לי התפריט',
    'תפריט בבקשה',
    'בבקשה תפריט',
    'יאללה תפריט',
    'אני רוצה תפריט',
    'אני רוצה לראות תפריט',
    // With trailing punctuation
    'תפריט בבקשה!',
    'בבקשה תפריט.',
  ];

  it.each(shouldMatch)('matches menu trigger: "%s"', (phrase) => {
    expect(MENU_TRIGGER_RE.test(phrase)).toBe(true);
  });
});

// ── MENU_TRIGGER_RE — mid-sentence mentions must NOT match ───────────────────

describe('MENU_TRIGGER_RE — does NOT false-positive on mid-sentence תפריט mentions', () => {
  const shouldNotMatch = [
    'מה יש בתפריט של המערכת?',
    'תסביר לי את התפריט בפירוט',
    'יש לי שאלה על התפריט',
    'עזרה עם משימה',   // "עזרה" followed by real content
    'שלום לכולם',      // "שלום" followed by real content
    'הצג את המשימות שלי',
    'צור משימה תיאום ללקוח X',
    // Manager phrase that just mentions "תפריט" in body
    'תראה לי את כל הבדיקות ולא רק התפריט',
  ];

  it.each(shouldNotMatch)('does NOT match: "%s"', (phrase) => {
    expect(MENU_TRIGGER_RE.test(phrase)).toBe(false);
  });
});
