/**
 * Hour-of-day load multiplier — Conservative ETA fallback ONLY.
 *
 * When we do NOT have a worker-provided calibration (Waze reading) and we do
 * NOT have a countdown source (`expectedArrivalAt` set at "יצאתי"), the last
 * line of defense against showing raw ORS/OSRM free-flow duration in a
 * customer-facing ETA is this per-hour scaling factor.
 *
 * Numbers reflect Israeli / Gush Dan driving reality (Sun 2025 — the current
 * calibration point):
 *  - Weekday morning peak Ayalon ~30 km/h vs ~90 km/h free-flow.
 *  - Weekday evening peak Ayalon ~14 km/h — the day's worst window.
 *  - Traffic no longer has clean start/end; there is a low-grade "all-day"
 *    baseline everyone is stuck in.
 *  - Friday afternoon: shopping / weekend errands drive elevated load.
 *  - Saturday daytime: near-empty roads (Shabbat).
 *  - Motzash Saturday evening: elevated as the country returns to the road.
 *  - Sunday morning: highest weekly peak — return from the weekend collides
 *    with the start of the workweek.
 *
 * IMPORTANT: this is NOT a live traffic model. Do NOT call it "traffic-aware"
 * anywhere in code, comments, or logs. It is a Conservative ETA fallback.
 *
 * Tunability: the table lives here in code deliberately (per the "minimal ENV"
 * decision). Field-calibrated changes = one commit; env-driven overrides can
 * be added later if a specific slot needs live tuning.
 */

/**
 * Multiplier the caller applies to a base (free-flow) route duration to get a
 * conservative estimate for the given local moment. Result is always ≥ 1.0.
 *
 * @param now Wall-clock moment for the estimate (typically `new Date()`).
 *            The function resolves it to Asia/Jerusalem local time internally.
 */
export function getHourlyLoadMultiplier(now: Date): number {
  const { dayOfWeek, hourFloat } = extractJerusalemDayHour(now);

  // Sunday — return-from-weekend + start-of-workweek stack.
  if (dayOfWeek === 0) {
    if (hourFloat >= 6.0 && hourFloat < 7.0)  return 1.60;
    if (hourFloat >= 7.0 && hourFloat < 9.5)  return 2.00;
    // Rest of Sunday flows into the standard weekday table below.
  }

  // Friday — half work day into weekend prep.
  if (dayOfWeek === 5) {
    if (hourFloat >= 6.0  && hourFloat < 10.0) return 1.30;
    if (hourFloat >= 10.0 && hourFloat < 15.0) return 1.60;
    if (hourFloat >= 15.0 && hourFloat < 18.0) return 1.30;
    // 18:00 onwards: Shabbat effectively in.
    return 1.00;
  }

  // Saturday — Shabbat by day, motzash surge after 20:00.
  if (dayOfWeek === 6) {
    if (hourFloat >= 20.0 && hourFloat < 24.0) return 1.40;
    return 1.05;
  }

  // Sunday–Thursday standard hourly table (also serves Sunday post-09:30).
  if (hourFloat < 6.0)   return 1.00;
  if (hourFloat < 6.5)   return 1.15;
  if (hourFloat < 7.0)   return 1.40;
  if (hourFloat < 9.5)   return 1.80;
  if (hourFloat < 12.0)  return 1.20;
  if (hourFloat < 15.0)  return 1.25;
  if (hourFloat < 19.0)  return 2.00;
  if (hourFloat < 21.0)  return 1.30;
  return 1.10;
}

// ── Internals ────────────────────────────────────────────────────────────

/**
 * Resolve a `Date` to Asia/Jerusalem day-of-week + fractional hour.
 *
 * Uses `Intl.DateTimeFormat` with the tz baked in — sidesteps host-timezone
 * portability issues (Render / CI / macOS may all disagree on the process TZ).
 */
function extractJerusalemDayHour(now: Date): { dayOfWeek: number; hourFloat: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const weekdayStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const rawHour   = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const rawMinute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');

  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dayOfWeek = dayMap[weekdayStr] ?? 0;

  // `hourCycle: 'h23'` should give 0..23, but defend against 24 just in case.
  const hourNormalized = rawHour >= 24 ? rawHour - 24 : rawHour;
  const minuteNormalized = Number.isFinite(rawMinute) ? rawMinute : 0;
  const hourFloat = hourNormalized + minuteNormalized / 60;

  return { dayOfWeek, hourFloat };
}
