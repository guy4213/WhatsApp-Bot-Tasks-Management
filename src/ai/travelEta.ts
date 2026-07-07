/**
 * Parse a worker's free-text travel-time reply into minutes.
 *
 * Used by the "active-task context after יצאתי" flow (Phase 1): after the worker
 * reports "יצאתי" the bot asks "כמה זמן נסיעה משוער?" and the reply flows here.
 * The ETA is OPTIONAL — a null result simply means "no usable ETA", it never
 * blocks the active-task context.
 *
 * Handles the common Hebrew forms:
 *   "20", "20 דקות", "כ-20 דק'", "רבע שעה" (15), "חצי שעה" (30), "שעה" (60),
 *   "שעה וחצי" (90), "שעתיים" (120), "45 דק", "1.5 שעות".
 * Returns clamped minutes in [1, 600], or null when nothing usable is found.
 */
const MAX_MINUTES = 600; // 10h — generous upper guard against typos

function clamp(min: number): number | null {
  if (!Number.isFinite(min)) return null;
  const rounded = Math.round(min);
  if (rounded < 1) return null;
  return Math.min(rounded, MAX_MINUTES);
}

export function parseTravelMinutes(input: string): number | null {
  const t = input.trim();
  if (!t) return null;

  // ── Word-based hour fractions (check BEFORE bare numbers) ──────────────────
  // NB: JS `\b` is ASCII-only, so it never matches around Hebrew letters — use
  // plain substring alternation instead.
  const hasHour = /שעה|שעות|שעתיים/.test(t);

  // "שעה וחצי" → 90, "שעתיים וחצי" → 150
  if (/שעה\s*וחצי/.test(t)) return 90;
  if (/שעתיים\s*וחצי/.test(t)) return 150;
  if (/שעתיים/.test(t)) return 120;
  if (/רבע\s*שעה/.test(t)) return 15;
  if (/חצי\s*שעה/.test(t)) return 30;
  if (/שלושת\s*רבעי\s*שעה/.test(t)) return 45;

  // ── Numeric value + unit ───────────────────────────────────────────────────
  const numMatch = t.match(/(\d+(?:[.,]\d+)?)/);
  const num = numMatch ? parseFloat(numMatch[1].replace(',', '.')) : null;

  // Explicit hour unit with a number: "1.5 שעות", "2 שעות" → *60.
  if (num !== null && /שע(ה|ות)/.test(t)) {
    return clamp(num * 60);
  }
  // Bare "שעה" with no number → 60.
  if (num === null && hasHour) return 60;

  // Minutes (explicit "דקות"/"דק" or a bare number defaults to minutes).
  if (num !== null) return clamp(num);

  return null;
}
