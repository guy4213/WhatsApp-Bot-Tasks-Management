/**
 * OUTLOOK-E — Microsoft Calendar HTTP routes (Fastify plugin).
 *
 * Exposes:
 *   PUBLIC  GET  /microsoft/oauth/callback          — Microsoft browser redirect lands here
 *   INTERNAL GET  /microsoft/oauth/start             — build OAuth URL for a userId
 *   INTERNAL POST /microsoft/subscriptions/create    — create Graph subscription
 *   INTERNAL POST /microsoft/subscriptions/:id/renew — renew Graph subscription
 *   INTERNAL DELETE /microsoft/subscriptions/:id      — delete Graph subscription
 *   INTERNAL GET  /microsoft/calendar/events          — list calendar events
 *   INTERNAL GET  /microsoft/calendar/events/:id      — fetch single event
 *   INTERNAL GET  /microsoft/calendar/debug           — webhook-log + live-event inspector
 *
 * All internal routes are gated by the same x-internal-secret preHandler used
 * in src/routes/tasks.ts. The OAuth callback is public because the Microsoft
 * browser redirect cannot carry this header.
 *
 * Security rules that MUST NOT be violated:
 *   - Never log or return code, state, access_token, refresh_token.
 *   - Never log the body of any Graph API response.
 *   - Do not read req.user — this project has no such thing.
 *   - Do not introduce x-user-id as an identity source.
 */

import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';
import { startOAuth, completeOAuth } from '../services/microsoftAuth';
import { listEventsAsUser, getEventAsUser, normalizeEvent } from '../services/graphCalendar';
import {
  createEventsSubscription,
  renewSubscription,
  deleteSubscription,
} from '../services/graphSubscriptions';

const logger = moduleLogger('microsoft-calendar-routes');

// ── Internal-secret guard (copied verbatim from src/routes/tasks.ts lines 62-68) ──

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? '';

function verifyInternalSecret(provided: string): boolean {
  if (!INTERNAL_SECRET) return true; // Not configured — allow in dev
  if (!provided || provided.length !== INTERNAL_SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(INTERNAL_SECRET));
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

/**
 * Minimal HTML-entity escaper for user-supplied error strings returned in the
 * OAuth callback page. Does not depend on any external package.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const uuidSchema = z.object({ userId: z.string().uuid() });

const listEventsQuerySchema = z.object({
  userId: z.string().uuid(),
  start: z.string().optional(),
  end: z.string().optional(),
  top: z.coerce.number().int().min(1).max(200).optional(),
  search: z.string().optional(),
});

const debugQuerySchema = z.object({
  userId: z.string().uuid(),
  hours: z.coerce.number().int().min(1).max(168).default(24),
});

// ── MicrosoftGraphEventLog row type (migration 020) ───────────────────────────

interface EventLogRow {
  id: string;
  receivedAt: Date;
  subscriptionId: string | null;
  changeType: string;
  resource: string;
  graphEventId: string | null;
  clientStateOk: boolean;
  rawNotification: unknown;
  rawEventSnapshot: unknown;
  fetchError: string | null;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function microsoftCalendarRoutes(app: FastifyInstance): Promise<void> {

  // ── PUBLIC: OAuth callback ─────────────────────────────────────────────────
  // Microsoft's authorization server redirects the browser here after consent.
  // This route must remain public — no x-internal-secret is possible in a
  // browser redirect.
  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/microsoft/oauth/callback',
    async (req, reply) => {
      const { code, state } = req.query;

      if (!code) {
        return reply
          .code(400)
          .type('text/html; charset=utf-8')
          .send('<h1>Missing authorization code</h1>');
      }

      try {
        // state may be undefined — completeOAuth validates + throws on bad/missing state.
        await completeOAuth(code, state ?? '');
        return reply
          .code(200)
          .type('text/html; charset=utf-8')
          .send('<h1>חשבון Outlook חובר בהצלחה. ניתן לסגור את החלון.</h1>');
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        // NEVER log code or state — only the error message.
        logger.error({ err: err.message }, 'OAuth callback: completeOAuth failed');
        return reply
          .code(400)
          .type('text/html; charset=utf-8')
          .send(`<h1>שגיאה בחיבור החשבון</h1><p>${escapeHtml(err.message)}</p>`);
      }
    },
  );

  // ── INTERNAL sub-plugin: all other routes, gated by x-internal-secret ──────
  await app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', async (req, reply) => {
      const provided = (req.headers['x-internal-secret'] as string) ?? '';
      if (!verifyInternalSecret(provided)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    });

    // GET /microsoft/oauth/start?userId=<uuid>
    // Builds the Microsoft authorization URL for the given userId.
    // Returns { url } only — state is embedded in the URL and must not be
    // returned separately (it would be redundant noise and expose a signed token).
    protectedApp.get<{ Querystring: { userId?: string } }>(
      '/microsoft/oauth/start',
      async (req, reply) => {
        const parsed = uuidSchema.safeParse(req.query);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Invalid query: userId must be a valid UUID' });
        }

        const { userId } = parsed.data;
        const { url } = startOAuth(userId);
        return reply.code(200).send({ url });
      },
    );

    // POST /microsoft/subscriptions/create?userId=<uuid>
    // Creates (or returns existing non-expired) Graph subscription for userId.
    protectedApp.post<{ Querystring: { userId?: string } }>(
      '/microsoft/subscriptions/create',
      async (req, reply) => {
        const parsed = uuidSchema.safeParse(req.query);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Invalid query: userId must be a valid UUID' });
        }

        const { userId } = parsed.data;

        try {
          const result = await createEventsSubscription(userId);
          return reply.code(201).send({
            subscriptionId: result.subscriptionId,
            expiresAt: result.expiresAt,
          });
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          if (err.message === 'החשבון לא מחובר ל-Outlook') {
            return reply.code(409).send({ error: err.message });
          }
          logger.error({ err: err.message }, 'createEventsSubscription failed');
          return reply.code(500).send({ error: err.message });
        }
      },
    );

    // POST /microsoft/subscriptions/:id/renew
    // Renews the Graph subscription identified by its Graph subscription id.
    protectedApp.post<{ Params: { id: string } }>(
      '/microsoft/subscriptions/:id/renew',
      async (req, reply) => {
        const { id } = req.params;

        try {
          const result = await renewSubscription(id);
          return reply.code(200).send({ subscriptionId: id, expiresAt: result.expiresAt });
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          if (err.message === 'Subscription no longer exists on Graph — recreate it') {
            return reply.code(410).send({ error: err.message });
          }
          logger.error({ err: err.message }, 'renewSubscription failed');
          return reply.code(500).send({ error: err.message });
        }
      },
    );

    // DELETE /microsoft/subscriptions/:id
    // Deletes the Graph subscription (Graph + local DB row).
    protectedApp.delete<{ Params: { id: string } }>(
      '/microsoft/subscriptions/:id',
      async (req, reply) => {
        const { id } = req.params;

        try {
          await deleteSubscription(id);
          return reply.code(204).send();
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          logger.error({ err: err.message }, 'deleteSubscription failed');
          return reply.code(500).send({ error: err.message });
        }
      },
    );

    // GET /microsoft/calendar/events?userId&start&end&top&search
    // Lists calendar events for userId. Supports optional date range, result count,
    // and free-text search.
    protectedApp.get<{
      Querystring: {
        userId?: string;
        start?: string;
        end?: string;
        top?: string;
        search?: string;
      };
    }>(
      '/microsoft/calendar/events',
      async (req, reply) => {
        const parsed = listEventsQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Invalid query parameters' });
        }

        const { userId, start, end, top, search } = parsed.data;

        try {
          const events = await listEventsAsUser(userId, {
            startIso: start,
            endIso: end,
            top,
            search,
          });
          return reply.code(200).send({ events, count: events.length });
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          const msg = err.message;
          // Surface permission and not-found errors with appropriate status codes.
          if (msg.includes('אין הרשאת יומן')) {
            return reply.code(403).send({ error: msg });
          }
          if (msg.includes('לא נמצא')) {
            return reply.code(404).send({ error: msg });
          }
          logger.error({ err: msg }, 'listEventsAsUser failed');
          return reply.code(500).send({ error: msg });
        }
      },
    );

    // GET /microsoft/calendar/events/:id?userId=<uuid>
    // Fetches a single calendar event by its Graph event id.
    protectedApp.get<{ Params: { id: string }; Querystring: { userId?: string } }>(
      '/microsoft/calendar/events/:id',
      async (req, reply) => {
        const parsed = uuidSchema.safeParse(req.query);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Invalid query: userId must be a valid UUID' });
        }

        const { userId } = parsed.data;
        const { id: eventId } = req.params;

        try {
          const event = await getEventAsUser(userId, eventId);
          return reply.code(200).send({ event });
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          const msg = err.message;
          if (msg.includes('לא נמצא')) {
            return reply.code(404).send({ error: msg });
          }
          if (msg.includes('אין הרשאת יומן')) {
            return reply.code(403).send({ error: msg });
          }
          logger.error({ err: msg }, 'getEventAsUser failed');
          return reply.code(500).send({ error: msg });
        }
      },
    );

    // GET /microsoft/calendar/debug?userId&hours=24
    // Data-exploration endpoint. Joins recent MicrosoftGraphEventLog rows with
    // a live Graph event fetch for each row, plus a fresh upcoming-events list.
    // Capped at 100 log rows, max 168-hour window, per-row Graph errors are
    // caught individually so one bad row cannot nuke the whole response.
    protectedApp.get<{ Querystring: { userId?: string; hours?: string } }>(
      '/microsoft/calendar/debug',
      async (req, reply) => {
        const parsed = debugQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'Invalid query parameters' });
        }

        const { userId, hours } = parsed.data;

        try {
          // 1. Query recent event log rows.
          const { rows: logRows } = await pool.query<EventLogRow>(
            `SELECT id, "receivedAt", "subscriptionId", "changeType", resource,
                    "graphEventId", "clientStateOk", "rawNotification",
                    "rawEventSnapshot", "fetchError"
               FROM "MicrosoftGraphEventLog"
              WHERE "receivedAt" > now() - ($1 || ' hours')::interval
              ORDER BY "receivedAt" DESC
              LIMIT 100`,
            [hours],
          );

          // 2. For each log row that has a graphEventId, attempt a live Graph fetch.
          //    Any error is caught and attached as currentEventError — never let one
          //    bad row abort the entire response.
          const notifications = await Promise.all(
            logRows.map(async (row) => {
              const base = {
                id: row.id,
                receivedAt: row.receivedAt,
                subscriptionId: row.subscriptionId,
                changeType: row.changeType,
                resource: row.resource,
                graphEventId: row.graphEventId,
                clientStateOk: row.clientStateOk,
                rawNotification: row.rawNotification,
                rawEventSnapshot: row.rawEventSnapshot,
                fetchError: row.fetchError,
                currentEvent: null as ReturnType<typeof normalizeEvent> | null,
                currentEventError: null as string | null,
              };

              if (row.graphEventId) {
                try {
                  base.currentEvent = await getEventAsUser(userId, row.graphEventId);
                } catch (e) {
                  base.currentEventError = e instanceof Error ? e.message : String(e);
                }
              }

              return base;
            }),
          );

          // 3. Fetch upcoming events (no date filter — whatever Graph returns nearest).
          const upcomingEvents = await listEventsAsUser(userId, { top: 25 });

          return reply.code(200).send({
            hoursWindow: hours,
            notifications,
            upcomingEvents,
          });
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          logger.error({ err: err.message }, 'microsoft/calendar/debug top-level failure');
          return reply.code(500).send({ error: err.message });
        }
      },
    );
  });
}
