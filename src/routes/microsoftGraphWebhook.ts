/**
 * Microsoft Graph change-notification webhook handler (OUTLOOK-F).
 *
 * POST /webhook/microsoft-graph
 *
 * Two modes:
 *  1. Validation handshake — Graph POSTs with ?validationToken=... during
 *     subscription creation. We echo the token back as text/plain immediately.
 *  2. Notification batch — Graph POSTs a JSON body with an array of change
 *     notifications. We return 202 FIRST, then process each notification
 *     asynchronously so Graph's 3-second SLA is never breached.
 *
 * Security: no x-internal-secret gate. Graph does not sign payloads with HMAC.
 * Instead, we verify clientState using a constant-time compare against
 * MS_WEBHOOK_CLIENT_STATE (env). A mismatch logs a warning and drops the
 * notification (no event fetch) but still INSERT a log row for auditability.
 *
 * This route must NOT gate on req.user / JWT. It is public by design.
 */

import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';
import { getSubscriptionByGraphId } from '../services/graphSubscriptions';
import { getEventAsUser } from '../services/graphCalendar';

const log = moduleLogger('microsoft-graph-webhook');

// ── clientState helpers ───────────────────────────────────────────────────────

/**
 * Read MS_WEBHOOK_CLIENT_STATE from env.
 * Returns null (and logs an error) instead of throwing, so the webhook can
 * still return 202 and record the misconfiguration rather than crashing.
 */
function getClientStateEnv(): string | null {
  const cs = process.env.MS_WEBHOOK_CLIENT_STATE;
  if (!cs) {
    log.error('MS_WEBHOOK_CLIENT_STATE is not set — all notifications will be treated as clientState mismatch');
    return null;
  }
  return cs;
}

/**
 * Constant-time comparison of two strings.
 * crypto.timingSafeEqual requires same-length Buffers — if lengths differ we
 * return false WITHOUT calling it (it would throw a RangeError).
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── graphEventId extraction ───────────────────────────────────────────────────

/**
 * Extract the Graph event ID from a notification resource string.
 *
 * resource format: "Users/{oid}/Events/{eventId}"
 *
 * Falls back to resourceData['@odata.id'] or resourceData.id, then to null.
 */
function extractGraphEventId(resource: string, resourceData: unknown): string | null {
  // Primary: parse from resource path
  if (resource) {
    const segments = resource.split('/');
    const eventsIdx = segments.findIndex((s) => s.toLowerCase() === 'events');
    if (eventsIdx !== -1 && eventsIdx + 1 < segments.length) {
      const id = segments[eventsIdx + 1];
      if (id) return id;
    }
  }

  // Fallback: resourceData
  if (resourceData && typeof resourceData === 'object') {
    const rd = resourceData as Record<string, unknown>;
    const odataId = rd['@odata.id'];
    if (typeof odataId === 'string' && odataId) return odataId;
    const id = rd['id'];
    if (typeof id === 'string' && id) return id;
  }

  return null;
}

// ── Notification shape ────────────────────────────────────────────────────────

interface GraphNotification {
  subscriptionId: string;
  changeType: string;
  resource: string;
  clientState?: string;
  resourceData?: unknown;
  subscriptionExpirationDateTime?: string;
}

interface GraphNotificationBatch {
  value: GraphNotification[];
}

// ── Async processing loop ─────────────────────────────────────────────────────

/**
 * Process one batch of Graph notifications.
 * Called AFTER the 202 has been sent — errors must be swallowed here.
 */
async function processNotificationBatch(notifications: GraphNotification[]): Promise<void> {
  const total = notifications.length;
  let ok = 0;
  let dropped = 0;
  let fetched = 0;
  let fetchFailed = 0;

  const expectedClientState = getClientStateEnv();

  for (const notification of notifications) {
    try {
      const subscriptionId = notification.subscriptionId ?? '';
      const changeType     = notification.changeType   ?? '';
      const resource       = notification.resource     ?? '';
      const resourceData   = notification.resourceData ?? null;

      const graphEventId = extractGraphEventId(resource, resourceData);

      // ── Look up local subscription row ────────────────────────────────────
      const sub = await getSubscriptionByGraphId(subscriptionId);

      let clientStateOk: boolean;

      if (!sub) {
        // Cannot verify — unknown subscription
        clientStateOk = false;
        log.warn(
          { subscriptionId },
          'Received notification for unknown subscriptionId — clientState unverifiable',
        );
      } else if (expectedClientState === null) {
        // Env misconfigured — already logged in getClientStateEnv()
        clientStateOk = false;
      } else {
        // Constant-time compare — safe even if Graph sends an empty string
        clientStateOk = timingSafeStringEqual(
          notification.clientState ?? '',
          expectedClientState,
        );
      }

      // ── INSERT log row ────────────────────────────────────────────────────
      const insertResult = await pool.query<{ id: string }>(
        `INSERT INTO "MicrosoftGraphEventLog"
           ("subscriptionId", "changeType", resource, "graphEventId",
            "clientStateOk", "rawNotification")
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          subscriptionId || null,
          changeType,
          resource,
          graphEventId,
          clientStateOk,
          JSON.stringify(notification),   // pg accepts a stringified JSON for jsonb
        ],
      );

      const notificationLogId: string = insertResult.rows[0]?.id ?? '';

      // ── Drop on clientState mismatch ──────────────────────────────────────
      if (!clientStateOk) {
        dropped++;
        log.warn(
          { subscriptionId, notificationLogId },
          'notification clientState mismatch — dropped',
        );
        continue;
      }

      ok++;

      // ── Skip fetch for deleted events ─────────────────────────────────────
      if (changeType === 'deleted') {
        // Event is gone — fetching would return 404
        continue;
      }

      // ── Fetch event snapshot (created / updated) ──────────────────────────
      if (!sub) {
        // sub is null when clientState could not be verified — but we already
        // continued above if !clientStateOk. This branch guards the TypeScript
        // narrowing: if we somehow reach here without sub, skip the fetch.
        log.warn({ subscriptionId, notificationLogId }, 'No sub row — cannot fetch event snapshot');
        continue;
      }

      if (!graphEventId) {
        log.warn({ subscriptionId, notificationLogId }, 'graphEventId is null — cannot fetch event snapshot');
        continue;
      }

      try {
        const evt = await getEventAsUser(sub.userId, graphEventId);
        // Store the original Graph object (evt.raw). Fall back to the full
        // normalized shape if raw is somehow absent.
        const snapshot = evt.raw !== undefined ? evt.raw : evt;

        await pool.query(
          `UPDATE "MicrosoftGraphEventLog"
              SET "rawEventSnapshot" = $1
            WHERE id = $2`,
          [JSON.stringify(snapshot), notificationLogId],
        );

        fetched++;
      } catch (err) {
        const message = (err as Error).message ?? 'unknown fetch error';

        // 404 race (deleted before we could fetch) — info level, not error
        if (message.includes('האירוע לא נמצא ביומן')) {
          log.info(
            { subscriptionId, notificationLogId, graphEventId },
            'Graph event not found (probable delete race) — recording fetchError',
          );
        } else {
          log.error(
            { err, subscriptionId, notificationLogId, graphEventId },
            'Failed to fetch event snapshot from Graph',
          );
        }

        await pool.query(
          `UPDATE "MicrosoftGraphEventLog"
              SET "fetchError" = $1
            WHERE id = $2`,
          [message, notificationLogId],
        );

        fetchFailed++;
      }
    } catch (err) {
      // One failing notification must never abort the rest
      log.error({ err }, 'Unhandled error processing Graph notification — skipping');
    }
  }

  log.info(
    { received: total, ok, dropped, fetched, fetchFailed },
    'Microsoft Graph notification batch processed',
  );
}

// ── Route registration ────────────────────────────────────────────────────────

export async function microsoftGraphWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Querystring: Record<string, string>;
    Body: unknown;
  }>('/webhook/microsoft-graph', async (req, reply) => {

    // ── Mode 1: Subscription validation handshake ─────────────────────────
    const validationToken = req.query['validationToken'];
    if (typeof validationToken === 'string' && validationToken.length > 0) {
      // DO NOT log the token value — only log that a handshake occurred.
      log.info({ handshake: true }, 'Microsoft Graph subscription validation handshake received');
      return reply
        .code(200)
        .header('Content-Type', 'text/plain; charset=ascii')
        .send(validationToken);
    }

    // ── Mode 2: Notification batch ────────────────────────────────────────

    const body = req.body as GraphNotificationBatch | null | undefined;

    // Guard: malformed / missing value array
    if (!body || !Array.isArray(body.value)) {
      log.warn({ bodyType: typeof body }, 'Microsoft Graph webhook: malformed body — no value array');
      return reply.code(202).send({ received: false, reason: 'malformed' });
    }

    const notifications = body.value as GraphNotification[];

    // Return 202 IMMEDIATELY so Graph is unblocked before its 3-second SLA.
    // The actual processing runs asynchronously in a resolved-promise continuation.
    // Errors inside the async block are caught and logged — never re-thrown to Fastify.
    reply.code(202).send({ received: true });

    Promise.resolve()
      .then(() => processNotificationBatch(notifications))
      .catch((err) => {
        // Safety net: processNotificationBatch already catches per-notification
        // errors internally. This outer catch guards against unexpected throws at
        // the batch level.
        log.error({ err }, 'Unexpected error in Microsoft Graph notification batch processor');
      });
  });
}
