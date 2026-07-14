/**
 * OUTLOOK-D — Microsoft Graph change-notification subscription lifecycle.
 *
 * Manages the creation, renewal, and deletion of Graph /subscriptions for
 * calendar event notifications (resource: me/events). Rows are persisted in
 * "MicrosoftGraphSubscription" (migration 020).
 *
 * Design constraints:
 *  - Never log tokens or raw Graph response bodies.
 *  - MS_WEBHOOK_CLIENT_STATE is checked lazily (at first use) and throws when absent.
 *  - getPublicBaseUrl() is reused from owntracksProvisioning — no duplicate env lookup.
 *  - getAccessToken(userId) is imported from microsoftAuth (written by Agent B).
 *  - All DB columns are quoted camelCase per migration 020 convention.
 */

import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';
import { getAccessToken } from './microsoftAuth';
import { getPublicBaseUrl } from './owntracksProvisioning';

const log = moduleLogger('graph-subscriptions');

// Graph max expiration for /me/events subscriptions is ~4230 minutes.
// We use 4225 minutes (5 min under the limit) to stay safely within bounds.
const SUBSCRIPTION_LIFETIME_MS = 4225 * 60_000;

// Threshold: if an existing subscription expires more than 1 hour from now,
// treat it as still-valid and return it without creating a duplicate.
const EXPIRY_BUFFER_MS = 60 * 60_000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SubscriptionRow {
  id: string;
  userId: string;
  subscriptionId: string;
  resource: string;
  changeType: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Resolves and validates MS_WEBHOOK_CLIENT_STATE at first use.
 * Throws if the env var is absent or empty.
 */
function getClientState(): string {
  const cs = process.env.MS_WEBHOOK_CLIENT_STATE;
  if (!cs) {
    throw new Error('MS_WEBHOOK_CLIENT_STATE env var is required but not set');
  }
  return cs;
}

/**
 * Computes a new expirationDateTime ISO string for the Graph API.
 * Graph requires the ISO 8601 format with milliseconds: YYYY-MM-DDTHH:mm:ss.mmmZ
 */
function computeExpirationDateTime(): string {
  return new Date(Date.now() + SUBSCRIPTION_LIFETIME_MS).toISOString();
}

/**
 * Look up a local subscription row by userId (first match).
 * Returns null when no row exists.
 */
async function getSubscriptionByUserId(userId: string): Promise<SubscriptionRow | null> {
  const { rows } = await pool.query<{
    id: string;
    userId: string;
    subscriptionId: string;
    resource: string;
    changeType: string;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT id, "userId", "subscriptionId", resource, "changeType",
            "expiresAt", "createdAt", "updatedAt"
     FROM "MicrosoftGraphSubscription"
     WHERE "userId" = $1
     LIMIT 1`,
    [userId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    userId: r.userId,
    subscriptionId: r.subscriptionId,
    resource: r.resource,
    changeType: r.changeType,
    expiresAt: new Date(r.expiresAt),
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  };
}

/**
 * Delete the local DB row for a given Graph subscriptionId.
 * Does not throw if the row doesn't exist.
 */
async function deleteLocalRow(subscriptionId: string): Promise<void> {
  await pool.query(
    `DELETE FROM "MicrosoftGraphSubscription" WHERE "subscriptionId" = $1`,
    [subscriptionId],
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates a new /me/events subscription for this userId. If one already exists
 * and is NOT expired, returns the existing row instead of creating a duplicate.
 * If one exists but has expired, delete the local row (best-effort DELETE at
 * Graph too but ignore 404) and create a fresh one.
 */
export async function createEventsSubscription(userId: string): Promise<{
  subscriptionId: string;
  expiresAt: Date;
}> {
  // 1. Check for existing, still-valid subscription.
  const existing = await getSubscriptionByUserId(userId);
  if (existing) {
    const validUntil = new Date(existing.expiresAt.getTime() - EXPIRY_BUFFER_MS);
    if (validUntil > new Date()) {
      log.debug(
        { userId, subscriptionId: existing.subscriptionId, expiresAt: existing.expiresAt },
        'Returning existing non-expired subscription',
      );
      return { subscriptionId: existing.subscriptionId, expiresAt: existing.expiresAt };
    }

    // 2. Expired-ish — best-effort delete, then create fresh.
    log.info(
      { userId, subscriptionId: existing.subscriptionId },
      'Existing subscription is expired or near-expiry — deleting and recreating',
    );
    try {
      await deleteSubscription(existing.subscriptionId);
    } catch (err) {
      log.warn(
        { err, userId, subscriptionId: existing.subscriptionId },
        'Best-effort delete of expired subscription failed — proceeding with creation anyway',
      );
    }
  }

  // 3. Compute expiration.
  const expirationDateTime = computeExpirationDateTime();

  // 4. Get access token.
  const token = await getAccessToken(userId);

  // 5. POST to Graph.
  const clientState = getClientState();
  const publicBaseUrl = getPublicBaseUrl();
  const notificationUrl = `${publicBaseUrl}/webhook/microsoft-graph`;

  const body = JSON.stringify({
    changeType: 'created,updated,deleted',
    notificationUrl,
    resource: 'me/events',
    expirationDateTime,
    clientState,
  });

  const response = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (!response.ok) {
    // Log status only — never log the body (may contain our URL or token info).
    log.error(
      { userId, status: response.status },
      'Graph POST /subscriptions failed',
    );
    throw new Error(`Failed to create Graph subscription: status ${response.status}`);
  }

  // 6. Parse 201 response.
  const data = (await response.json()) as { id: string; expirationDateTime: string };
  const graphSubscriptionId = data.id;
  const expiresAt = new Date(data.expirationDateTime);

  // Insert row into DB.
  await pool.query(
    `INSERT INTO "MicrosoftGraphSubscription"
       ("userId", "subscriptionId", resource, "changeType", "expiresAt")
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ("subscriptionId") DO UPDATE
       SET "expiresAt"  = EXCLUDED."expiresAt",
           "updatedAt"  = now()`,
    [userId, graphSubscriptionId, 'me/events', 'created,updated,deleted', expiresAt.toISOString()],
  );

  log.info(
    { userId, subscriptionId: graphSubscriptionId, expiresAt },
    'Graph subscription created',
  );

  return { subscriptionId: graphSubscriptionId, expiresAt };
}

/**
 * PATCH /subscriptions/{id} with a new expirationDateTime = now + 4225 min.
 * Update the DB row.
 * If Graph returns 404, delete the stale local row and throw.
 */
export async function renewSubscription(subscriptionId: string): Promise<{ expiresAt: Date }> {
  // 1. Look up local row.
  const local = await getSubscriptionByGraphId(subscriptionId);
  if (!local) {
    throw new Error('Subscription not tracked locally');
  }

  // 2. Get access token.
  const token = await getAccessToken(local.userId);

  // 3. Compute new expiration.
  const expirationDateTime = computeExpirationDateTime();

  // 4. PATCH Graph.
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expirationDateTime }),
    },
  );

  // 5. Handle 200.
  if (response.ok) {
    const data = (await response.json()) as { expirationDateTime: string };
    const expiresAt = new Date(data.expirationDateTime);

    await pool.query(
      `UPDATE "MicrosoftGraphSubscription"
          SET "expiresAt"  = $1,
              "updatedAt"  = now()
        WHERE "subscriptionId" = $2`,
      [expiresAt.toISOString(), subscriptionId],
    );

    log.info({ subscriptionId, expiresAt }, 'Graph subscription renewed');
    return { expiresAt };
  }

  // 6. Handle 404 — subscription no longer exists on Graph.
  if (response.status === 404) {
    log.warn({ subscriptionId }, 'Graph subscription not found on renewal — deleting local row');
    await deleteLocalRow(subscriptionId);
    throw new Error('Subscription no longer exists on Graph — recreate it');
  }

  // 7. Other non-2xx.
  log.error({ subscriptionId, status: response.status }, 'Graph PATCH /subscriptions failed');
  throw new Error(`Failed to renew Graph subscription: status ${response.status}`);
}

/**
 * DELETE /subscriptions/{id}. Ignore Graph 404 (already gone). Delete local row.
 */
export async function deleteSubscription(subscriptionId: string): Promise<void> {
  // 1. Look up local row for its userId (needed for token).
  const local = await getSubscriptionByGraphId(subscriptionId);

  if (local) {
    // 2. Get token and DELETE from Graph.
    try {
      const token = await getAccessToken(local.userId);
      const response = await fetch(
        `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      // 204 = deleted, 404 = already gone — both are success.
      if (!response.ok && response.status !== 404) {
        log.warn(
          { subscriptionId, status: response.status },
          'Graph DELETE /subscriptions returned unexpected status — continuing anyway (best-effort)',
        );
      }
    } catch (err) {
      log.warn(
        { err, subscriptionId },
        'Graph DELETE /subscriptions call failed — continuing to delete local row (best-effort)',
      );
    }
  } else {
    // No local row — nothing to look up for token. Return silently.
    log.debug({ subscriptionId }, 'deleteSubscription: no local row found — nothing to do');
    return;
  }

  // 3. Delete local row unconditionally.
  await deleteLocalRow(subscriptionId);
  log.info({ subscriptionId }, 'Graph subscription deleted (local row removed)');
}

/**
 * Read a subscription row by its Graph subscriptionId. Returns null if none found.
 * Used by the webhook handler to map notification → userId.
 */
export async function getSubscriptionByGraphId(
  subscriptionId: string,
): Promise<SubscriptionRow | null> {
  const { rows } = await pool.query<{
    id: string;
    userId: string;
    subscriptionId: string;
    resource: string;
    changeType: string;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `SELECT id, "userId", "subscriptionId", resource, "changeType",
            "expiresAt", "createdAt", "updatedAt"
     FROM "MicrosoftGraphSubscription"
     WHERE "subscriptionId" = $1`,
    [subscriptionId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    userId: r.userId,
    subscriptionId: r.subscriptionId,
    resource: r.resource,
    changeType: r.changeType,
    expiresAt: new Date(r.expiresAt),
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  };
}
