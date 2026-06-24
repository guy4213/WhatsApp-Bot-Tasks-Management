import { describe, it, expect } from 'vitest';
import {
  matchDigestCommand, planDigestCommand, DIGEST_PAYLOAD_IDS,
} from '../ai/digestCommands';

const emp = { isElevated: false };
const manager = { isElevated: true };
const admin = { isElevated: true };

describe('matchDigestCommand — button payload IDs', () => {
  it('maps each stable payload id to its command', () => {
    expect(matchDigestCommand(DIGEST_PAYLOAD_IDS.EMP_TODAY)).toBe('EMP_TODAY');
    expect(matchDigestCommand(DIGEST_PAYLOAD_IDS.EMP_EOD)).toBe('EMP_EOD');
    expect(matchDigestCommand(DIGEST_PAYLOAD_IDS.TEAM_TODAY)).toBe('TEAM_TODAY');
    expect(matchDigestCommand(DIGEST_PAYLOAD_IDS.TEAM_EOD)).toBe('TEAM_EOD');
    expect(matchDigestCommand(DIGEST_PAYLOAD_IDS.FREE_TEXT)).toBe('FREE_TEXT');
  });
});

describe('matchDigestCommand — exact text fallbacks', () => {
  it('maps each exact Hebrew command (and tolerates trailing punctuation)', () => {
    expect(matchDigestCommand('משימות להיום')).toBe('EMP_TODAY');
    expect(matchDigestCommand('דוח סוף יום שלי')).toBe('EMP_EOD');
    expect(matchDigestCommand('משימות להיום בצוות')).toBe('TEAM_TODAY');
    expect(matchDigestCommand('דוח סוף יום צוות')).toBe('TEAM_EOD');
    expect(matchDigestCommand('כתיבה חופשית')).toBe('FREE_TEXT');
    expect(matchDigestCommand('  משימות להיום!  ')).toBe('EMP_TODAY');
  });

  it('disambiguates the team variant from the employee one (exact match, not prefix)', () => {
    // "משימות להיום בצוות" must NOT collapse to the employee "משימות להיום".
    expect(matchDigestCommand('משימות להיום בצוות')).toBe('TEAM_TODAY');
    expect(matchDigestCommand('משימות להיום')).toBe('EMP_TODAY');
  });

  it('returns null for real free text so it falls back to AI/NLU', () => {
    expect(matchDigestCommand('הצג את המשימות שלי')).toBeNull();
    expect(matchDigestCommand('משימות להיום בבקשה')).toBeNull(); // partial, not exact
    expect(matchDigestCommand('צור משימה תיאום ללקוח X')).toBeNull();
    expect(matchDigestCommand('שלום')).toBeNull();
  });
});

describe('planDigestCommand — deterministic routing + elevated guard', () => {
  it('employee morning button → my today + overdue carry-over (own)', () => {
    expect(planDigestCommand('EMP_TODAY', emp)).toEqual({ kind: 'list', filter: 'today_overdue', scope: 'own' });
  });

  it('employee end-of-day button → employee end-of-day report', () => {
    expect(planDigestCommand('EMP_EOD', emp)).toEqual({ kind: 'employee_eod' });
  });

  it('manager/admin morning button → team today + overdue carry-over (company-wide)', () => {
    expect(planDigestCommand('TEAM_TODAY', manager)).toEqual({ kind: 'list', filter: 'today_overdue', scope: 'all' });
    expect(planDigestCommand('TEAM_TODAY', admin)).toEqual({ kind: 'list', filter: 'today_overdue', scope: 'all' });
  });

  it('manager/admin end-of-day button → team end-of-day report', () => {
    expect(planDigestCommand('TEAM_EOD', manager)).toEqual({ kind: 'team_eod' });
    expect(planDigestCommand('TEAM_EOD', admin)).toEqual({ kind: 'team_eod' });
  });

  it('"כתיבה חופשית" → free text (clears context / normal AI flow)', () => {
    expect(planDigestCommand('FREE_TEXT', emp)).toEqual({ kind: 'free_text' });
    expect(planDigestCommand('FREE_TEXT', manager)).toEqual({ kind: 'free_text' });
  });

  it('employee CANNOT reach team views — team commands are denied for non-elevated', () => {
    expect(planDigestCommand('TEAM_TODAY', emp)).toEqual({ kind: 'denied' });
    expect(planDigestCommand('TEAM_EOD', emp)).toEqual({ kind: 'denied' });
  });
});
