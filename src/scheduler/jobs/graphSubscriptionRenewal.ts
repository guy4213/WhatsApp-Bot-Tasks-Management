/**
 * OUTLOOK-D — Scheduler job: Microsoft Graph subscription renewal.
 *
 * Finds all "MicrosoftGraphSubscription" rows expiring within the next 48 hours
 * and renews each one via PATCH /subscriptions/{id}. Failures on individual rows
 * are isolated — one failure does not abort the rest.
 *
 * Advisory lock id 1012 (`graphSubscriptionRenewal`) prevents concurrent runs
 * across instances — see `src/scheduler/index.ts`.
 *
 * Cron cadence: every 12 hours (`0 * /12 * * *`).
 * Graph subscriptions live ~70 hours, so 12-hourly renewal with a 48-hour
 * look-ahead means each subscription is always renewed at least once per window.
 */

import { pool } from '../../db/connection';
import { moduleLogger } from '../../utils/logger';
import { renewSubscription } from '../../services/graphSubscriptions';

const log = moduleLogger('graph-subscription-renewal');

export async function runGraphSubscriptionRenewalJob(): Promise<void> {
  // If the client state env var is absent we can still query and attempt renewal
  // (renewSubscription will throw per-row if the env is actually missing when
  // Graph is called). Log a warning here for early visibility.
  if (!process.env.MS_WEBHOOK_CLIENT_STATE) {
    log.warn(
      'MS_WEBHOOK_CLIENT_STATE is not set — subscription renewal calls will fail. ' +
        'Set the env var to enable Microsoft Graph notifications.',
    );
    // Don't return early — let the per-row catches surface the failures individually.
  }

  // 1. SELECT rows expiring within 48 hours.
  const { rows } = await pool.query<{
    subscriptionId: string;
    userId: string;
    expiresAt: Date;
  }>(
    `SELECT "subscriptionId", "userId", "expiresAt"
       FROM "MicrosoftGraphSubscription"
      WHERE "expiresAt" < now() + interval '48 hours'`,
  );

  if (rows.length === 0) {
    log.debug('No Graph subscriptions expiring within 48h — nothing to renew');
    return;
  }

  log.info({ count: rows.length }, 'Graph subscription renewal: subscriptions to renew');

  let renewed = 0;
  let failed = 0;

  // 2. Renew each row independently — one failure must NOT skip the rest.
  for (const row of rows) {
    try {
      const result = await renewSubscription(row.subscriptionId);
      log.info(
        { subscriptionId: row.subscriptionId, newExpiresAt: result.expiresAt },
        'Graph subscription renewed successfully',
      );
      renewed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { subscriptionId: row.subscriptionId, userId: row.userId, error: message },
        'Failed to renew Graph subscription',
      );
      failed += 1;
    }
  }

  // 3. Summary line.
  log.info(
    { scanned: rows.length, renewed, failed },
    'Graph subscription renewal job complete',
  );
}
