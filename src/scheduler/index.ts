import cron from 'node-cron';
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';
import { runExpireActions }             from './jobs/expireActions';
import { runDailySummary }              from './jobs/dailySummary';
import { runDueDateReminder }           from './jobs/dueDateReminder';
import { runDeadlineExceededAlert,
         runDeadlineApproachingAlert }  from './jobs/deadlineAlerts';
import { runCompletionNotifier }        from './jobs/completionNotifier';
import { recoverInboundQueue }          from '../routes/webhook';

const log = moduleLogger('scheduler');
const TZ = 'Asia/Jerusalem';

// ── Distributed lock via Postgres advisory locks ──────────────────────────────
// Each job acquires a session-level advisory lock before running; if another
// instance holds it, this instance skips. Prevents N× runs in multi-instance.

const JOB_LOCK_IDS = {
  expireActions:        1001,
  dueDateReminder:      1002,
  deadlineExceeded:     1003,
  deadlineApproaching:  1004,
  dailySummary:         1005,
  completionNotifier:   1006,
  queueRecovery:        1007,
} as const;

async function withJobLock(lockId: number, name: string, fn: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [lockId],
    );
    if (!rows[0].acquired) {
      log.debug({ job: name }, 'Job already running on another instance — skipped');
      return;
    }
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    }
  } finally {
    client.release();
  }
}

function safe(name: string, lockId: number, fn: () => Promise<void>) {
  return async () => {
    try {
      await withJobLock(lockId, name, fn);
    } catch (err) {
      log.error({ err, job: name }, 'Scheduled job failed');
    }
  };
}

export function startScheduler(): void {
  cron.schedule('*/5 * * * *', safe('expireActions',       JOB_LOCK_IDS.expireActions,      runExpireActions),            { timezone: TZ });
  cron.schedule('*/5 * * * *', safe('dueDateReminder',     JOB_LOCK_IDS.dueDateReminder,    runDueDateReminder),          { timezone: TZ });
  cron.schedule('0 8 * * *',   safe('deadlineExceeded',    JOB_LOCK_IDS.deadlineExceeded,   runDeadlineExceededAlert),    { timezone: TZ });
  cron.schedule('0 9 * * *',   safe('deadlineApproaching', JOB_LOCK_IDS.deadlineApproaching, runDeadlineApproachingAlert), { timezone: TZ });
  // TEMPORARY (testing): daily summary moved 17:00 → 13:00. Revert to '0 17 * * *' when done.
  cron.schedule('0 13 * * *',  safe('dailySummary',        JOB_LOCK_IDS.dailySummary,       runDailySummary),             { timezone: TZ });
  cron.schedule('*/2 * * * *', safe('completionNotifier',  JOB_LOCK_IDS.completionNotifier, runCompletionNotifier),       { timezone: TZ });

  // Every 5 minutes — reprocess any inbound messages left pending by a crash
  cron.schedule('*/5 * * * *', safe('queueRecovery', JOB_LOCK_IDS.queueRecovery, recoverInboundQueue), { timezone: TZ });

  log.info('All scheduler jobs registered (timezone: Asia/Jerusalem, distributed locks: enabled)');
}
