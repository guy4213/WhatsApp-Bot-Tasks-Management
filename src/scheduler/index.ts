import cron from 'node-cron';
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';
import { runExpireActions }             from './jobs/expireActions';
import { runDailySummary }              from './jobs/dailySummary';
import { runDueDateReminder }           from './jobs/dueDateReminder';
import { runDeadlineExceededAlert,
         runDeadlineApproachingAlert }  from './jobs/deadlineAlerts';
import { runCompletionNotifier }        from './jobs/completionNotifier';
import { runDigestDispatcher }          from './jobs/digestDispatcher';
import { runAssignmentCardNotifier }    from './jobs/assignmentCardNotifier';
import { runLeadAssignmentNotifier }    from './jobs/leadAssignmentNotifier';
import { runPreInspectionReminderJob }  from './jobs/preInspectionReminder';
import { runGraphSubscriptionRenewalJob } from './jobs/graphSubscriptionRenewal';
import { runGreenApiHealthCheck }       from './jobs/greenapiHealthCheck';
import { recoverInboundQueue }          from '../routes/webhook';

const log = moduleLogger('scheduler');
const TZ = 'Asia/Jerusalem';

// ── Distributed lock via Postgres advisory locks ──────────────────────────────
// Each job acquires a session-level advisory lock before running; if another
// instance holds it, this instance skips. Prevents N× runs in multi-instance.

const JOB_LOCK_IDS = {
  expireActions:          1001,
  dueDateReminder:        1002,
  deadlineExceeded:       1003,
  deadlineApproaching:    1004,
  dailySummary:           1005,
  completionNotifier:     1006,
  queueRecovery:          1007,
  digestDispatcher:       1008,
  assignmentCardNotifier:  1009,
  leadAssignmentNotifier:  1010,
  preInspectionReminder:   1011,
  graphSubscriptionRenewal: 1012,
  greenapiHealthCheck:      1013,
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

  // X-T7: completionNotifier retired — v2 bot NEVER writes Task.status (CRM owns
  // it). Reference implementation preserved at src/scheduler/jobs/completionNotifier.ts
  // as the template for the D5-T6 shared polling job (K2 = polling). Re-enable
  // only via COMPLETION_NOTIFIER_ENABLED=true.
  if (process.env.COMPLETION_NOTIFIER_ENABLED === 'true') {
    cron.schedule('*/2 * * * *', safe('completionNotifier', JOB_LOCK_IDS.completionNotifier, runCompletionNotifier), { timezone: TZ });
    log.warn('COMPLETION_NOTIFIER_ENABLED=true — completionNotifier is ACTIVE (v2 bot must NOT write Task.status; ensure runCompletionNotifier is read-only wrt Task.status)');
  } else {
    log.info('completionNotifier is DISABLED (COMPLETION_NOTIFIER_ENABLED!=true) — retired per X-T7 (v2: CRM owns Task.status)');
  }

  // Per-user scheduled digests — replaces the fixed 17:00 broadcast. Runs every
  // 5 minutes and fires each user's morning/evening digest when their local time
  // falls in the window (default ON for everyone; opt-out/retime via the menu).
  cron.schedule('*/5 * * * *', safe('digestDispatcher', JOB_LOCK_IDS.digestDispatcher, runDigestDispatcher), { timezone: TZ });

  // Product decision (Jul 2026): the bot does NOT auto-send a WhatsApp
  // assignment card just because a TaskField was created / re-assigned. The
  // D5-T6 poller (src/scheduler/jobs/assignmentCardNotifier.ts) and the
  // §6 inspection card sender (src/services/inspectionAssignment.ts) are
  // retained as reference for a future explicit manual command
  // ("שלח כרטיס בדיקה לעובד"), but the auto-fire cron is OFF by default.
  // Re-enable only via ASSIGNMENT_CARD_NOTIFIER_ENABLED=true.
  if (process.env.ASSIGNMENT_CARD_NOTIFIER_ENABLED === 'true') {
    cron.schedule('*/2 * * * *', safe('assignmentCardNotifier', JOB_LOCK_IDS.assignmentCardNotifier, runAssignmentCardNotifier), { timezone: TZ });
    log.warn('ASSIGNMENT_CARD_NOTIFIER_ENABLED=true — assignmentCardNotifier is ACTIVE (auto-sends WhatsApp assignment cards on TaskField creation; product decision Jul 2026 was to keep this OFF — confirm this is intentional)');
  } else {
    log.info('assignmentCardNotifier is DISABLED (ASSIGNMENT_CARD_NOTIFIER_ENABLED!=true) — auto-send on TaskField creation is intentionally off per product decision Jul 2026; enable via ASSIGNMENT_CARD_NOTIFIER_ENABLED=true for future manual-command flows');
  }

  // D3-T3 + D3-T4: every 15 minutes, poll IncomingLead for newly assigned rows
  // (alert the inspector) and daytime-unassigned >1h rows (escalate to Sasha).
  // Dedup via WhatsappLeadNotification (migration 010 + 022). The Supabase
  // Database Webhook (routes/supabaseLeadWebhook.ts) is now the primary
  // delivery path for ASSIGNED_TO_WORKER — it fires within ~1 second of the
  // CRM claim, regardless of channel. This poller is the SAFETY NET for
  // webhook delivery failures, which is why the frequency dropped from */2 to
  // */15: at */2 it burned quota for near-zero real work, at */15 it still
  // recovers any lost webhook within a coffee break. Advisory lock prevents
  // concurrent double-sends across instances; INSERT-first claim inside the
  // job prevents webhook × poller double-sends.
  cron.schedule('*/15 * * * *', safe('leadAssignmentNotifier', JOB_LOCK_IDS.leadAssignmentNotifier, runLeadAssignmentNotifier), { timezone: TZ });

  // OUTLOOK-D: every 12 hours, renew Microsoft Graph subscriptions expiring within 48h.
  // Advisory lock 1012 prevents concurrent double-renewals across instances.
  // Renew Microsoft Graph subscriptions that expire within 48h. Every 12h.
  cron.schedule('0 */12 * * *', safe('graphSubscriptionRenewal', JOB_LOCK_IDS.graphSubscriptionRenewal, runGraphSubscriptionRenewalJob), { timezone: TZ });

  // D2-T15: every 2 minutes, poll for TaskField rows with scheduledStartAt in
  // the next 60 minutes and preReminderSentAt IS NULL. Send the pre-inspection
  // reminder card (3 reply buttons: יוצא בזמן / צריך פרטים / יש בעיה) and
  // stamp preReminderSentAt. Advisory lock prevents duplicate sends.
  cron.schedule('*/2 * * * *', safe('preInspectionReminder', JOB_LOCK_IDS.preInspectionReminder, runPreInspectionReminderJob), { timezone: TZ });

  // Legacy fixed 17:00 daily summary — OFF by default. Its replacement is the
  // evening digest above. Re-enable only via LEGACY_DAILY_SUMMARY_ENABLED=true.
  if (process.env.LEGACY_DAILY_SUMMARY_ENABLED === 'true') {
    cron.schedule('0 17 * * *', safe('dailySummary', JOB_LOCK_IDS.dailySummary, runDailySummary), { timezone: TZ });
    log.warn('LEGACY_DAILY_SUMMARY_ENABLED=true — legacy 17:00 dailySummary is ACTIVE (may overlap the evening digest)');
  } else {
    log.info('Legacy 17:00 dailySummary is DISABLED (LEGACY_DAILY_SUMMARY_ENABLED!=true) — superseded by the evening digest');
  }

  // Every 5 minutes — reprocess any inbound messages left pending by a crash
  cron.schedule('*/5 * * * *', safe('queueRecovery', JOB_LOCK_IDS.queueRecovery, recoverInboundQueue), { timezone: TZ });

  // Green API instance-health poll — every 5 minutes GET /getStateInstance and
  // alert ops recipients (services/specialUsers.OPS_ALERT_NAMES) on transitions
  // out of `authorized`. No-op when WHATSAPP_PROVIDER!=greenapi. Advisory lock
  // 1013 keeps multi-instance deploys single-alerting. See services/greenapiHealth.ts.
  cron.schedule('*/5 * * * *', safe('greenapiHealthCheck', JOB_LOCK_IDS.greenapiHealthCheck, runGreenApiHealthCheck), { timezone: TZ });

  log.info('All scheduler jobs registered (timezone: Asia/Jerusalem, distributed locks: enabled)');
}
