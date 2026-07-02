/**
 * Diagnostic — pre-inspection reminder runtime check.
 *
 * Non-destructive. Prints:
 *   - whether migration 011 is recorded in schema_migrations
 *   - whether public."TaskField"."preReminderSentAt" column exists
 *   - DB now() (Asia/Jerusalem via pool timezone) and now() UTC
 *   - candidates in the query window (raw findDuePreReminders query)
 *   - for each candidate: id, scheduledStartAt, fieldStatus, preReminderSentAt,
 *     ownerId present, worker phone present (masked)
 *   - near-window rows (scheduledStartAt within +/- 3 hours) that were NOT
 *     selected, with the reason (fieldStatus, missing owner, missing phone,
 *     preReminderSentAt already stamped, or scheduledStartAt outside window)
 *
 * No writes. No secrets printed. Safe to run against production/staging.
 *
 * Run with: npx ts-node src/scripts/diagPreReminder.ts
 */
import { pool } from '../db/connection';

function maskPhone(p: string | null | undefined): string {
  if (!p) return '(none)';
  const s = String(p);
  if (s.length <= 4) return '****';
  return `${s.slice(0, 3)}****${s.slice(-2)}`;
}

async function main(): Promise<void> {
  console.log('=== pre-inspection reminder DB diagnostic ===');

  // 1. Migration recorded?
  const mig = await pool.query<{ name: string; applied_at: Date }>(
    `SELECT name, applied_at FROM schema_migrations WHERE name = '011_pre_reminder.sql'`,
  );
  console.log(
    `\n[1] migration 011_pre_reminder.sql applied: ${mig.rowCount ? 'YES' : 'NO'}`,
    mig.rowCount ? `(at ${mig.rows[0].applied_at.toISOString()})` : '',
  );

  // 2. Column present?
  const col = await pool.query<{ data_type: string; is_nullable: string }>(
    `SELECT data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'TaskField'
        AND column_name  = 'preReminderSentAt'`,
  );
  console.log(
    `[2] TaskField.preReminderSentAt column: ${col.rowCount ? 'PRESENT' : 'MISSING'}`,
    col.rowCount ? `(${col.rows[0].data_type}, nullable=${col.rows[0].is_nullable})` : '',
  );

  // 3. DB clock
  const clock = await pool.query<{
    now_local: string;
    now_utc: string;
    tz: string;
  }>(
    `SELECT
       to_char(now(), 'YYYY-MM-DD HH24:MI:SS TZ')                                AS now_local,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS "UTC"')          AS now_utc,
       current_setting('TIMEZONE')                                               AS tz`,
  );
  console.log(
    `[3] DB clock: local=${clock.rows[0].now_local} | utc=${clock.rows[0].now_utc} | session tz=${clock.rows[0].tz}`,
  );

  // 4. Run the exact findDuePreReminders query (candidates that WILL be sent).
  const due = await pool.query<{
    taskFieldId: string;
    scheduledStartAt: Date;
    fieldStatus: string;
    workerId: string | null;
    workerPhone: string | null;
    workerName: string | null;
    minutesUntil: string;
  }>(
    `SELECT
       tf.id                AS "taskFieldId",
       tf."scheduledStartAt",
       tf."fieldStatus"::text AS "fieldStatus",
       u.id                 AS "workerId",
       u.name               AS "workerName",
       u.phone              AS "workerPhone",
       to_char(EXTRACT(EPOCH FROM (tf."scheduledStartAt" - now())) / 60, 'FM990.0') AS "minutesUntil"
     FROM "TaskField" tf
     JOIN "Task" t          ON t.id = tf."taskId"
     LEFT JOIN "User" u     ON u.id = t."ownerId"
     WHERE tf."preReminderSentAt" IS NULL
       AND tf."scheduledStartAt" > now()
       AND tf."scheduledStartAt" <= now() + interval '60 minutes'
       AND tf."fieldStatus" IN ('ASSIGNED', 'CONFIRMED', 'NEEDS_MORE_INFO')
       AND t."ownerId" IS NOT NULL
       AND u.phone IS NOT NULL
       AND u.phone <> ''
     ORDER BY tf."scheduledStartAt" ASC`,
  );
  console.log(`\n[4] findDuePreReminders — matching rows: ${due.rowCount}`);
  for (const r of due.rows) {
    console.log(
      `    - id=${r.taskFieldId} scheduled=${r.scheduledStartAt.toISOString()} ` +
        `status=${r.fieldStatus} workerId=${r.workerId ?? '(none)'} ` +
        `phone=${maskPhone(r.workerPhone)} name=${r.workerName ?? '(none)'} ` +
        `minutesUntil=${r.minutesUntil}`,
    );
  }

  // 5. Near-window survey (broad look-back / look-ahead) with exclusion reason.
  const near = await pool.query<{
    taskFieldId: string;
    scheduledStartAt: Date;
    fieldStatus: string;
    preReminderSentAt: Date | null;
    ownerId: string | null;
    workerPhone: string | null;
    workerName: string | null;
    minutesUntil: string;
  }>(
    `SELECT
       tf.id                AS "taskFieldId",
       tf."scheduledStartAt",
       tf."fieldStatus"::text AS "fieldStatus",
       tf."preReminderSentAt",
       t."ownerId",
       u.phone              AS "workerPhone",
       u.name               AS "workerName",
       to_char(EXTRACT(EPOCH FROM (tf."scheduledStartAt" - now())) / 60, 'FM99990.0') AS "minutesUntil"
     FROM "TaskField" tf
     JOIN "Task" t          ON t.id = tf."taskId"
     LEFT JOIN "User" u     ON u.id = t."ownerId"
     WHERE tf."scheduledStartAt" BETWEEN now() - interval '3 hours' AND now() + interval '3 hours'
     ORDER BY tf."scheduledStartAt" ASC
     LIMIT 30`,
  );
  console.log(`\n[5] near-window survey (±3h) — rows: ${near.rowCount}`);
  for (const r of near.rows) {
    const reasons: string[] = [];
    if (r.preReminderSentAt) reasons.push(`preReminderSentAt=${r.preReminderSentAt.toISOString()}`);
    if (!['ASSIGNED', 'CONFIRMED', 'NEEDS_MORE_INFO'].includes(r.fieldStatus))
      reasons.push(`fieldStatus=${r.fieldStatus}`);
    if (!r.ownerId) reasons.push('Task.ownerId=NULL');
    if (!r.workerPhone) reasons.push('User.phone=NULL');
    // window
    const mins = parseFloat(r.minutesUntil);
    if (Number.isFinite(mins)) {
      if (mins <= 0) reasons.push(`past (${r.minutesUntil} min)`);
      else if (mins > 60) reasons.push(`>60min ahead (${r.minutesUntil} min)`);
    }
    console.log(
      `    - id=${r.taskFieldId} scheduled=${r.scheduledStartAt.toISOString()} ` +
        `status=${r.fieldStatus} owner=${r.ownerId ?? '(none)'} ` +
        `phone=${maskPhone(r.workerPhone)} name=${r.workerName ?? '(none)'} ` +
        `minutesUntil=${r.minutesUntil} ` +
        `${reasons.length ? `— NOT SELECTED: ${reasons.join('; ')}` : '— SELECTED'}`,
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[diag] FAILED:', err);
  process.exit(1);
});
