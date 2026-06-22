import { describe, it, expect } from 'vitest';
import { similarity } from '../ai/taskResolver';

describe('similarity', () => {
  it('returns 1 for an exact match', () => {
    expect(similarity('דוח ראש העין', 'דוח ראש העין')).toBe(1);
  });

  it('returns 1 when reference is a substring of the candidate', () => {
    expect(similarity('ראש העין', 'דוח בדיקה ראש העין 2026')).toBe(1);
  });

  it('scores partial token overlap between 0 and 1', () => {
    const s = similarity('דוח ראש העין', 'דוח חיפה');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it('returns 0 for completely unrelated strings', () => {
    expect(similarity('דוח ראש העין', 'תיאום פגישה מחר')).toBe(0);
  });

  it('ranks the better candidate higher', () => {
    const ref = 'תיאום ביקור חיפה';
    const good = similarity(ref, 'תיאום ביקור חיפה צפון');
    const bad  = similarity(ref, 'דוח שנתי תל אביב');
    expect(good).toBeGreaterThan(bad);
  });

  it('handles empty input safely', () => {
    expect(similarity('', 'משהו')).toBe(0);
    expect(similarity('משהו', '')).toBe(0);
  });
});
