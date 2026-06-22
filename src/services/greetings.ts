import { pool } from '../db/connection';

/**
 * Returns true at most ONCE per calendar day (Asia/Jerusalem) per phone — used to
 * greet the user on their first message of the day. Atomic: the conditional upsert
 * means two concurrent messages can't both "win" the greeting.
 *
 * CURRENT_DATE uses the session timezone, which the pool pins to Asia/Jerusalem.
 */
export async function claimDailyGreeting(phone: string): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO "WhatsappUserGreeting" (phone, "lastGreetedOn")
       VALUES ($1, CURRENT_DATE)
     ON CONFLICT (phone) DO UPDATE
       SET "lastGreetedOn" = CURRENT_DATE
       WHERE "WhatsappUserGreeting"."lastGreetedOn" < CURRENT_DATE
     RETURNING phone`,
    [phone],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * A formal, time-of-day-aware Hebrew greeting addressed by first name.
 * e.g. "בוקר טוב, גיא. כיצד אוכל לסייע לך היום?"
 */
export function buildGreeting(fullName: string): string {
  const first = (fullName || '').trim().split(/\s+/)[0] || '';
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23',
    }).format(new Date()),
    10,
  );

  let part = 'שלום';
  if (hour >= 5 && hour < 12) part = 'בוקר טוב';
  else if (hour >= 12 && hour < 18) part = 'צהריים טובים';
  else if (hour >= 18 && hour < 22) part = 'ערב טוב';

  return first
    ? `${part}, ${first}. כיצד אוכל לסייע לך היום?`
    : `${part}. כיצד אוכל לסייע לך היום?`;
}
