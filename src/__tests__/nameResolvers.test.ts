/**
 * Tests for src/ai/nameResolvers.ts
 *
 * Covers:
 *  - resolveSelfReference: whole-word Hebrew self-ref tokens (positive cases)
 *    and the critical negative case where a real name merely contains the
 *    same letters as a self-ref token (e.g. "אלירן" must NOT match "אלי").
 *  - resolveWorkerName: unique / ambiguous / none, on-screen-tier priority
 *    over userTable, and the >=2-char token-length guard.
 *  - resolveLeadReference: matching by name and by subject, tier priority
 *    over pendingQueue, ambiguous / none.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSelfReference,
  resolveWorkerName,
  resolveLeadReference,
  type NamedCandidate,
  type LeadCandidate,
} from '../ai/nameResolvers';

const USER = { id: 'user-1' };

describe('resolveSelfReference', () => {
  it('matches "אלי" ("assign it to me")', () => {
    expect(resolveSelfReference('שייך את הליד אלי', USER)).toBe('user-1');
  });

  it('matches "אליי" (double-yod variant)', () => {
    expect(resolveSelfReference('תעביר אליי בבקשה', USER)).toBe('user-1');
  });

  it('matches "לי" ("give it to me")', () => {
    expect(resolveSelfReference('תעביר לי את הבדיקה', USER)).toBe('user-1');
  });

  it('matches "אותי" ("assign me")', () => {
    expect(resolveSelfReference('תשייך אותי למשימה הזאת', USER)).toBe('user-1');
  });

  it('matches "עצמי" ("myself")', () => {
    expect(resolveSelfReference('אני אקח את זה על עצמי', USER)).toBe('user-1');
  });

  it('matches "לעצמי" ("to myself")', () => {
    expect(resolveSelfReference('אני משייך את זה לעצמי', USER)).toBe('user-1');
  });

  it('matches when the token is the entire message', () => {
    expect(resolveSelfReference('לי', USER)).toBe('user-1');
  });

  it('does NOT match a real name that merely contains the self-ref letters ("אלירן")', () => {
    expect(resolveSelfReference('שייך את הליד לאלירן', USER)).toBeNull();
    expect(resolveSelfReference('אלירן יטפל בזה', USER)).toBeNull();
  });

  it('does NOT match another real name containing the letters ("אליהו")', () => {
    expect(resolveSelfReference('שייך את זה לאליהו', USER)).toBeNull();
  });

  it('does NOT match a name containing "עצמי" letters as a substring ("עצמון")', () => {
    expect(resolveSelfReference('תעביר את זה לעצמון', USER)).toBeNull();
  });

  it('returns null for unrelated text with no self-reference token', () => {
    expect(resolveSelfReference('הבדיקה הושלמה בהצלחה', USER)).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(resolveSelfReference('', USER)).toBeNull();
  });
});

describe('resolveWorkerName', () => {
  const onScreen: NamedCandidate[] = [
    { id: 'w-1', name: 'דני כהן' },
    { id: 'w-2', name: 'משה לוי' },
  ];
  const userTable: NamedCandidate[] = [
    { id: 'w-1', name: 'דני כהן' },
    { id: 'w-2', name: 'משה לוי' },
    { id: 'w-3', name: 'דני אברהם' },
  ];

  it('returns unique when exactly one on-screen candidate matches (full name)', () => {
    const result = resolveWorkerName('תשייך את זה לדני כהן', onScreen);
    expect(result).toEqual({ status: 'unique', id: 'w-1', name: 'דני כהן' });
  });

  it('returns unique when exactly one on-screen candidate matches (single token)', () => {
    const result = resolveWorkerName('תעביר למשה', onScreen);
    expect(result).toEqual({ status: 'unique', id: 'w-2', name: 'משה לוי' });
  });

  it('returns ambiguous when the text fragment matches multiple on-screen candidates', () => {
    // "דני" alone matches only candidate w-1 in the on-screen set (no other
    // "דני" on screen) — use a fragment that hits both on-screen candidates
    // by using a token both names share.
    const bothMatch: NamedCandidate[] = [
      { id: 'a-1', name: 'רון דני' },
      { id: 'a-2', name: 'עידן דני' },
    ];
    const result = resolveWorkerName('שייך לדני', bothMatch);
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      const ids = result.matches.map((m) => m.id).sort();
      expect(ids).toEqual(['a-1', 'a-2']);
    }
  });

  it('returns none when nothing matches on-screen or in userTable', () => {
    const result = resolveWorkerName('תשייך לגורם שלא קיים', onScreen, userTable);
    expect(result).toEqual({ status: 'none' });
  });

  it('falls back to userTable when no on-screen candidate matches', () => {
    const result = resolveWorkerName('תשייך לאברהם', onScreen, userTable);
    expect(result).toEqual({ status: 'unique', id: 'w-3', name: 'דני אברהם' });
  });

  it('on-screen tier takes priority: unique on-screen match wins even if userTable would add more matches', () => {
    // "דני" would match BOTH w-1 ("דני כהן") on-screen AND w-3 ("דני אברהם")
    // in the wider userTable. Since exactly one on-screen candidate matches,
    // that on-screen match must win outright (no ambiguity raised).
    const result = resolveWorkerName('תשייך לדני', onScreen, userTable);
    expect(result).toEqual({ status: 'unique', id: 'w-1', name: 'דני כהן' });
  });

  it('does not match on single-letter fragments (min 2-char token guard)', () => {
    const singleLetterCandidates: NamedCandidate[] = [{ id: 'x-1', name: 'ד' }];
    const result = resolveWorkerName('ד', singleLetterCandidates);
    expect(result).toEqual({ status: 'none' });
  });

  it('is case-insensitive for latin names', () => {
    const latin: NamedCandidate[] = [{ id: 'l-1', name: 'John Smith' }];
    const result = resolveWorkerName('assign to JOHN please', latin);
    expect(result).toEqual({ status: 'unique', id: 'l-1', name: 'John Smith' });
  });
});

describe('resolveLeadReference', () => {
  const onScreenLeads: LeadCandidate[] = [
    { id: 'l-1', name: 'יוסי מזרחי', subject: 'בקשה לבדיקת קרינה' },
    { id: 'l-2', name: 'רותי בר', subject: 'ייעוץ התקנה' },
  ];
  const pendingQueue: LeadCandidate[] = [
    ...onScreenLeads,
    { id: 'l-3', name: 'אבי שרון', subject: 'בדיקת קרינה בבית' },
  ];

  it('matches a lead by name', () => {
    const result = resolveLeadReference('תשייך את יוסי מזרחי אליי', onScreenLeads);
    expect(result).toEqual({ status: 'unique', id: 'l-1', name: 'יוסי מזרחי' });
  });

  it('matches a lead by subject when name is not mentioned', () => {
    const result = resolveLeadReference('קח את הליד של ייעוץ התקנה', onScreenLeads);
    expect(result).toEqual({ status: 'unique', id: 'l-2', name: 'רותי בר' });
  });

  it('returns ambiguous when multiple on-screen leads match', () => {
    const bothMatch: LeadCandidate[] = [
      { id: 'q-1', name: 'ליד קרינה א', subject: 'בדיקת קרינה' },
      { id: 'q-2', name: 'ליד קרינה ב', subject: 'בדיקת קרינה' },
    ];
    const result = resolveLeadReference('שייך לי את בדיקת קרינה', bothMatch);
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      const ids = result.matches.map((m) => m.id).sort();
      expect(ids).toEqual(['q-1', 'q-2']);
    }
  });

  it('returns none when nothing matches on-screen or in pendingQueue', () => {
    const result = resolveLeadReference('שייך ליד שלא קיים בכלל', onScreenLeads, pendingQueue);
    expect(result).toEqual({ status: 'none' });
  });

  it('falls back to pendingQueue when no on-screen lead matches', () => {
    const result = resolveLeadReference('קח את אבי שרון', onScreenLeads, pendingQueue);
    expect(result).toEqual({ status: 'unique', id: 'l-3', name: 'אבי שרון' });
  });

  it('on-screen tier takes priority over pendingQueue even when both would match', () => {
    // "בדיקת קרינה" fragment appears in both l-1's subject (on-screen) and
    // l-3's subject (only in the wider pendingQueue). Since exactly one
    // on-screen lead matches, it wins outright.
    const result = resolveLeadReference('שייך לי את בדיקת קרינה', onScreenLeads, pendingQueue);
    expect(result).toEqual({ status: 'unique', id: 'l-1', name: 'יוסי מזרחי' });
  });
});
