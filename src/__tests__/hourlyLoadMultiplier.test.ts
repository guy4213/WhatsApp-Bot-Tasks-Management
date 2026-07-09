/**
 * Behavioral tests for `services/hourlyLoadMultiplier.ts` (pure function).
 *
 * All test dates are UTC — the function resolves them to Asia/Jerusalem
 * internally. The comment on each date shows the resolved local moment so
 * a reader can verify the table row against the plan.
 */
import { describe, expect, it } from 'vitest';
import { getHourlyLoadMultiplier } from '../services/hourlyLoadMultiplier';

/** Build a UTC date whose Asia/Jerusalem local wall-clock is `hour:minute`
 *  on the given (weekday, calendar) tuple. Israel is UTC+3 in July (IDT). */
function jerusalemAtIDT(month: number, day: number, hour: number, minute = 0): Date {
  // July = month 6 (0-indexed). IDT = UTC+3. Local hour X = UTC hour X-3.
  return new Date(Date.UTC(2026, month, day, hour - 3, minute));
}

describe('getHourlyLoadMultiplier — weekday Sun–Thu', () => {
  it('Sunday 08:00 IL → 2.00 (start-of-week peak)', () => {
    // 2026-07-05 is a Sunday.
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 5, 8, 0))).toBe(2.00);
  });

  it('Sunday 06:30 IL → 1.60 (return from weekend, early)', () => {
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 5, 6, 30))).toBe(1.60);
  });

  it('Sunday 10:00 IL → 1.20 (falls through to standard table)', () => {
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 5, 10, 0))).toBe(1.20);
  });

  it('Tuesday 08:00 IL → 1.80 (weekday morning peak)', () => {
    // 2026-07-07 is a Tuesday.
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 7, 8, 0))).toBe(1.80);
  });

  it('Tuesday 14:00 IL → 1.25 (afternoon baseline, not truly light)', () => {
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 7, 14, 0))).toBe(1.25);
  });

  it('Wednesday 17:00 IL → 2.00 (weekday evening peak)', () => {
    // 2026-07-08 is a Wednesday.
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 8, 17, 0))).toBe(2.00);
  });

  it('Wednesday 03:00 IL → 1.00 (pre-dawn empty roads)', () => {
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 8, 3, 0))).toBe(1.00);
  });

  it('Thursday 22:30 IL → 1.10 (late evening baseline)', () => {
    // 2026-07-09 is a Thursday.
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 9, 22, 30))).toBe(1.10);
  });
});

describe('getHourlyLoadMultiplier — Friday (weekend prep)', () => {
  it('Friday 12:00 IL → 1.60 (mid-day shopping / errands)', () => {
    // 2026-07-10 is a Friday.
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 10, 12, 0))).toBe(1.60);
  });

  it('Friday 08:00 IL → 1.30 (half work day)', () => {
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 10, 8, 0))).toBe(1.30);
  });

  it('Friday 20:00 IL → 1.00 (Shabbat effectively in)', () => {
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 10, 20, 0))).toBe(1.00);
  });
});

describe('getHourlyLoadMultiplier — Saturday (Shabbat)', () => {
  it('Saturday 12:00 IL → 1.05 (near-empty roads)', () => {
    // 2026-07-11 is a Saturday.
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 11, 12, 0))).toBe(1.05);
  });

  it('Saturday 21:00 IL → 1.40 (motzash surge)', () => {
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 11, 21, 0))).toBe(1.40);
  });

  it('Saturday 04:00 IL → 1.05 (empty pre-dawn)', () => {
    expect(getHourlyLoadMultiplier(jerusalemAtIDT(6, 11, 4, 0))).toBe(1.05);
  });
});

describe('getHourlyLoadMultiplier — edge cases', () => {
  it('never returns less than 1.0', () => {
    // Scan every hour across a full week.
    for (let day = 5; day <= 11; day++) {
      for (let hr = 0; hr < 24; hr++) {
        const v = getHourlyLoadMultiplier(jerusalemAtIDT(6, day, hr, 0));
        expect(v).toBeGreaterThanOrEqual(1.0);
      }
    }
  });

  it('is deterministic — same input, same output', () => {
    const d = jerusalemAtIDT(6, 5, 8, 15);
    expect(getHourlyLoadMultiplier(d)).toBe(getHourlyLoadMultiplier(d));
  });

  it('handles minute precision at boundaries — 09:29 IL is peak, 09:30 IL is not', () => {
    // Tuesday.
    const inside = getHourlyLoadMultiplier(jerusalemAtIDT(6, 7, 9, 29));
    const outside = getHourlyLoadMultiplier(jerusalemAtIDT(6, 7, 9, 30));
    expect(inside).toBe(1.80);
    expect(outside).toBe(1.20);
  });
});
