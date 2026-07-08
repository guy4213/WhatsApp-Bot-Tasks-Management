/**
 * Hebrew free-text date-range parser for the "הבדיקות שלי …" intent.
 *
 * Pure — no DB, no clock singleton. Callers pass `nowJerusalem` (default: real
 * `new Date()`) so tests can pin behavior. All output dates are 'YYYY-MM-DD'
 * in the Asia/Jerusalem local calendar, half-open [from, to).
 *
 * Supported inputs (with or without the leading "הבדיקות שלי" phrase):
 *   • היום / מחר
 *   • אתמול / מאתמול / של אתמול
 *   • שלשום
 *   • השבוע / שבוע הבא  (Israeli work-week: Sunday → Saturday)
 *   • שבוע שעבר / בשבוע שעבר / השבוע שעבר / משבוע שעבר (previous work-week)
 *   • החודש / חודש הבא
 *   • חודש שעבר / בחודש שעבר / מהחודש שעבר (previous calendar month)
 *   • Named weekday: "יום ראשון" … "יום שישי", "שבת" — next occurrence incl. today
 *   • "בין DD/M ל-DD/M" / "בין DD/MM ל-DD/MM"
 *   • Single date "ב-DD/M" / "ב-DD/MM"
 *
 * Anything else → null (caller shows an error hint).
 */

export interface ParsedRange {
  /** Inclusive lower bound, YYYY-MM-DD in Asia/Jerusalem. */
  fromLocalDate: string;
  /** Exclusive upper bound, YYYY-MM-DD in Asia/Jerusalem. */
  toLocalDate: string;
  /** Short Hebrew label for the response header. */
  label: string;
}

// ── Time-zone-safe date helpers (mirrors router.ts:2272 idiom) ──────────────

/**
 * Return a 'YYYY-MM-DD' string of the given instant, as observed in
 * Asia/Jerusalem. Never use Date.getDate()/getDay() directly — those read the
 * server's process TZ and drift near midnight.
 */
export function localJerusalemDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value ?? '';
  const m = parts.find((p) => p.type === 'month')?.value ?? '';
  const d = parts.find((p) => p.type === 'day')?.value ?? '';
  return `${y}-${m}-${d}`;
}

/** Return {y, m, d} numbers for an instant, in Asia/Jerusalem. */
function localJerusalemParts(now: Date): { y: number; m: number; d: number } {
  const s = localJerusalemDate(now);
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
  return { y, m, d };
}

/** Add `days` to a 'YYYY-MM-DD' calendar date (TZ-safe, no time math). */
function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  // Use UTC-noon anchor so DST transitions don't flip the calendar day.
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  const yy = anchor.getUTCFullYear();
  const mm = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(anchor.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Return the day-of-week (0=Sunday..6=Saturday) for a 'YYYY-MM-DD'. */
function isoDayOfWeek(iso: string): number {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

/** Format "DD/MM" from a 'YYYY-MM-DD' (no TZ shift). */
function ddmm(iso: string): string {
  const [, mo, da] = iso.split('-');
  return `${da}/${mo}`;
}

/** Last day of the given (year, month) — month is 1-based. */
function lastDayOfMonth(y: number, month1: number): number {
  // Day-0 of next month == last day of this month.
  return new Date(Date.UTC(y, month1, 0, 12, 0, 0)).getUTCDate();
}

// ── Text normalization ─────────────────────────────────────────────────────

const PREFIX_RE =
  /^\s*(?:הבדיקות\s+שלי|בדיקות\s+השטח\s+שלי|תראה\s+לי\s+את\s+הבדיקות\s+שלי|איזה\s+בדיקות\s+יש\s+לי|מה\s+יש\s+לי)\s*/;

/** Strip a common Hebrew intro, punctuation, and normalize whitespace. */
function normalize(text: string): string {
  let s = text.trim();
  s = s.replace(PREFIX_RE, ''); // idempotent — safe if router already stripped it
  // Leading connector words that add nothing: "ל", "ב"
  s = s.replace(/[?!.,]+$/g, '').trim();
  return s;
}

// ── Weekday map ────────────────────────────────────────────────────────────

const WEEKDAYS: Record<string, number> = {
  'ראשון': 0,
  'שני': 1,
  'שלישי': 2,
  'רביעי': 3,
  'חמישי': 4,
  'שישי': 5,
  'שבת': 6,
};

const WEEKDAY_LABEL_HE: Record<number, string> = {
  0: 'יום ראשון',
  1: 'יום שני',
  2: 'יום שלישי',
  3: 'יום רביעי',
  4: 'יום חמישי',
  5: 'יום שישי',
  6: 'שבת',
};

// ── Main parser ─────────────────────────────────────────────────────────────

export function parseHebrewInspectionRange(
  text: string,
  nowJerusalem: Date = new Date(),
): ParsedRange | null {
  const todayIso = localJerusalemDate(nowJerusalem);
  const { y: curYear } = localJerusalemParts(nowJerusalem);

  const raw = normalize(text);
  const s = raw.toLowerCase();

  // Empty after stripping the prefix → not a range, defer to caller (today).
  if (!raw) return null;

  // ── היום ─────────────────────────────────────────────────────────────────
  if (/^ל?היום$/.test(s)) {
    const tomorrow = addDaysISO(todayIso, 1);
    return {
      fromLocalDate: todayIso,
      toLocalDate: tomorrow,
      label: `היום ${ddmm(todayIso)}`,
    };
  }

  // ── מחר ──────────────────────────────────────────────────────────────────
  if (/^ל?מחר$/.test(s)) {
    const tomorrow = addDaysISO(todayIso, 1);
    const dayAfter = addDaysISO(todayIso, 2);
    return {
      fromLocalDate: tomorrow,
      toLocalDate: dayAfter,
      label: `מחר ${ddmm(tomorrow)}`,
    };
  }

  // ── אתמול / מאתמול / של אתמול (QA-FIX-7) ────────────────────────────────
  if (/^(?:מ|של\s+)?אתמול$/.test(s)) {
    const yesterday = addDaysISO(todayIso, -1);
    return {
      fromLocalDate: yesterday,
      toLocalDate: todayIso,
      label: `אתמול ${ddmm(yesterday)}`,
    };
  }

  // ── שלשום (QA-FIX-7) ─────────────────────────────────────────────────────
  if (/^שלשום$/.test(s)) {
    const dayBeforeYesterday = addDaysISO(todayIso, -2);
    const yesterday = addDaysISO(todayIso, -1);
    return {
      fromLocalDate: dayBeforeYesterday,
      toLocalDate: yesterday,
      label: `שלשום ${ddmm(dayBeforeYesterday)}`,
    };
  }

  // ── השבוע / שבוע הבא ────────────────────────────────────────────────────
  //
  // Israeli work-week: Sunday (dow=0) → Saturday (dow=6) inclusive.
  // Half-open upper bound is next Sunday.
  if (/^(השבוע|שבוע הבא|לשבוע הבא)$/.test(s)) {
    const dow = isoDayOfWeek(todayIso);            // 0=Sun..6=Sat
    const thisSunday = addDaysISO(todayIso, -dow); // Sunday of the current week
    if (s === 'השבוע') {
      const nextSunday = addDaysISO(thisSunday, 7);
      const thisSat = addDaysISO(thisSunday, 6);
      return {
        fromLocalDate: thisSunday,
        toLocalDate: nextSunday,
        label: `השבוע (${ddmm(thisSunday)}–${ddmm(thisSat)})`,
      };
    }
    // שבוע הבא
    const nextSunday = addDaysISO(thisSunday, 7);
    const weekAfter = addDaysISO(nextSunday, 7);
    const nextSat = addDaysISO(nextSunday, 6);
    return {
      fromLocalDate: nextSunday,
      toLocalDate: weekAfter,
      label: `שבוע הבא (${ddmm(nextSunday)}–${ddmm(nextSat)})`,
    };
  }

  // ── שבוע שעבר (QA-FIX-7) ─────────────────────────────────────────────────
  //
  // Previous Israeli work-week: Sunday−7 → this Sunday (half-open).
  if (/^(?:ב|ה|מ)?שבוע\s+שעבר$/.test(s)) {
    const dow = isoDayOfWeek(todayIso);            // 0=Sun..6=Sat
    const thisSunday = addDaysISO(todayIso, -dow); // Sunday of the current week
    const prevSunday = addDaysISO(thisSunday, -7);
    const prevSat = addDaysISO(thisSunday, -1);
    return {
      fromLocalDate: prevSunday,
      toLocalDate: thisSunday,
      label: `שבוע שעבר (${ddmm(prevSunday)}–${ddmm(prevSat)})`,
    };
  }

  // ── "לעוד שבוע" / "לעוד חודש" — rolling window from today ────────────────
  if (/^לעוד\s+שבוע$/.test(s)) {
    const to = addDaysISO(todayIso, 7);
    return {
      fromLocalDate: todayIso,
      toLocalDate: to,
      label: `לעוד שבוע (${ddmm(todayIso)}–${ddmm(addDaysISO(to, -1))})`,
    };
  }
  if (/^לעוד\s+חודש$/.test(s)) {
    const to = addDaysISO(todayIso, 30);
    return {
      fromLocalDate: todayIso,
      toLocalDate: to,
      label: `לעוד חודש (${ddmm(todayIso)}–${ddmm(addDaysISO(to, -1))})`,
    };
  }

  // ── החודש / חודש הבא ────────────────────────────────────────────────────
  if (/^(החודש|חודש הבא|לחודש הבא)$/.test(s)) {
    const { y, m } = localJerusalemParts(nowJerusalem);
    if (s === 'החודש') {
      const first = `${y}-${String(m).padStart(2, '0')}-01`;
      const nextMonth1 = m === 12 ? 1 : m + 1;
      const nextMonthYear = m === 12 ? y + 1 : y;
      const nextFirst =
        `${nextMonthYear}-${String(nextMonth1).padStart(2, '0')}-01`;
      const last = lastDayOfMonth(y, m);
      return {
        fromLocalDate: first,
        toLocalDate: nextFirst,
        label: `החודש (${String(m).padStart(2, '0')}/${y}, 01–${String(last).padStart(2, '0')})`,
      };
    }
    // חודש הבא
    const nextMonth1 = m === 12 ? 1 : m + 1;
    const nextMonthYear = m === 12 ? y + 1 : y;
    const monthAfter1 = nextMonth1 === 12 ? 1 : nextMonth1 + 1;
    const monthAfterYear = nextMonth1 === 12 ? nextMonthYear + 1 : nextMonthYear;
    const first = `${nextMonthYear}-${String(nextMonth1).padStart(2, '0')}-01`;
    const nextFirst =
      `${monthAfterYear}-${String(monthAfter1).padStart(2, '0')}-01`;
    const last = lastDayOfMonth(nextMonthYear, nextMonth1);
    return {
      fromLocalDate: first,
      toLocalDate: nextFirst,
      label:
        `חודש הבא (${String(nextMonth1).padStart(2, '0')}/${nextMonthYear}, 01–${String(last).padStart(2, '0')})`,
    };
  }

  // ── חודש שעבר (QA-FIX-7) ─────────────────────────────────────────────────
  //
  // Previous calendar month: first of previous month → first of current month.
  if (/^(?:ב|מה)?חודש\s+שעבר$/.test(s)) {
    const { y, m } = localJerusalemParts(nowJerusalem);
    const prevMonth1 = m === 1 ? 12 : m - 1;
    const prevMonthYear = m === 1 ? y - 1 : y;
    const first = `${prevMonthYear}-${String(prevMonth1).padStart(2, '0')}-01`;
    const thisMonthFirst = `${y}-${String(m).padStart(2, '0')}-01`;
    const last = lastDayOfMonth(prevMonthYear, prevMonth1);
    return {
      fromLocalDate: first,
      toLocalDate: thisMonthFirst,
      label: `חודש שעבר (${String(prevMonth1).padStart(2, '0')}/${prevMonthYear}, 01–${String(last).padStart(2, '0')})`,
    };
  }

  // ── Named weekday: "יום ראשון" / … / "שבת" / "ביום ראשון" ───────────────
  //
  // Resolves to the NEXT occurrence including today if today matches.
  const weekdayMatch = raw.match(/^(?:ב?יום\s+)?(ראשון|שני|שלישי|רביעי|חמישי|שישי)$|^(שבת|בשבת|ליום שבת)$/);
  if (weekdayMatch) {
    let target: number;
    if (weekdayMatch[1]) target = WEEKDAYS[weekdayMatch[1]];
    else target = 6; // שבת
    if (target === undefined) return null;
    const dow = isoDayOfWeek(todayIso);
    const delta = (target - dow + 7) % 7; // include today
    const from = addDaysISO(todayIso, delta);
    const to = addDaysISO(from, 1);
    return {
      fromLocalDate: from,
      toLocalDate: to,
      label: `${WEEKDAY_LABEL_HE[target]} ${ddmm(from)}`,
    };
  }

  // ── "בין DD/M ל-DD/M" (range with dash / hyphen tolerated) ──────────────
  const rangeMatch =
    raw.match(/^ב?בין\s+(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?\s+ל[־\-]?\s*(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?$/);
  if (rangeMatch) {
    const [, d1s, m1s, y1s, d2s, m2s, y2s] = rangeMatch;
    const d1 = parseInt(d1s, 10);
    const m1 = parseInt(m1s, 10);
    const d2 = parseInt(d2s, 10);
    const m2 = parseInt(m2s, 10);
    if (!isValidMonthDay(m1, d1) || !isValidMonthDay(m2, d2)) return null;
    const y1 = y1s ? normalizeYear(parseInt(y1s, 10)) : curYear;
    const y2 = y2s ? normalizeYear(parseInt(y2s, 10)) : curYear;
    const fromIso = `${y1}-${String(m1).padStart(2, '0')}-${String(d1).padStart(2, '0')}`;
    const toInclusiveIso = `${y2}-${String(m2).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;
    if (fromIso > toInclusiveIso) return null; // inverted → user error
    // If both endpoints resolve entirely in the past (relative to today) AND no
    // explicit year was given, bump both by 1 year — the user meant "next 1/7"
    // rather than "1/7 of last year that already happened".
    let finalFrom = fromIso;
    let finalTo = toInclusiveIso;
    if (!y1s && !y2s && toInclusiveIso < todayIso) {
      const bumpedY = curYear + 1;
      finalFrom = `${bumpedY}-${String(m1).padStart(2, '0')}-${String(d1).padStart(2, '0')}`;
      finalTo = `${bumpedY}-${String(m2).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;
    }
    const exclusive = addDaysISO(finalTo, 1);
    return {
      fromLocalDate: finalFrom,
      toLocalDate: exclusive,
      label: `${ddmm(finalFrom)}–${ddmm(finalTo)}`,
    };
  }

  // ── Single date "ב-DD/M" / "ב DD/MM" / "DD/M" ─────────────────────────
  const singleMatch =
    raw.match(/^ב?[־\-]?\s*(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?$/);
  if (singleMatch) {
    const [, ds, ms, ys] = singleMatch;
    const d = parseInt(ds, 10);
    const m = parseInt(ms, 10);
    if (!isValidMonthDay(m, d)) return null;
    let y = ys ? normalizeYear(parseInt(ys, 10)) : curYear;
    let iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!ys && iso < todayIso) {
      y = curYear + 1;
      iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    const next = addDaysISO(iso, 1);
    return {
      fromLocalDate: iso,
      toLocalDate: next,
      label: ddmm(iso),
    };
  }

  return null;
}

// ── small helpers ──────────────────────────────────────────────────────────

function isValidMonthDay(month: number, day: number): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  // Use a leap year (2024) for month-length upper bound so 29/2 is accepted.
  const maxDay = lastDayOfMonth(2024, month);
  return day <= maxDay;
}

/** 2-digit year → 20xx; 3-digit invalid; 4-digit passthrough. */
function normalizeYear(y: number): number {
  if (y < 100) return 2000 + y;
  return y;
}
