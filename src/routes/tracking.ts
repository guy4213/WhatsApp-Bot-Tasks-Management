/**
 * Live-tracking public + debug endpoints (migration 016).
 *
 * Routes:
 *   GET /tracking/:token           — PUBLIC. Customer-facing view of one
 *                                    tracking session. JSON only in this
 *                                    iteration (no UI page). Returns a small
 *                                    whitelist of fields (status, taskField
 *                                    status, last location, ETA, updatedAt).
 *                                    404 on unknown/malformed token — no
 *                                    distinction between "revoked" and
 *                                    "never existed" (do not leak).
 *
 *   GET /tracking/debug/sessions   — INTERNAL. `x-internal-secret` guarded
 *                                    (mirrors `routes/tasks.ts` and the
 *                                    OwnTracks POC debug). Returns all
 *                                    ACTIVE|ARRIVED sessions with full ids
 *                                    for operations visibility.
 *
 * This plugin does NOT touch OwnTracks — the ingestion path lives in
 * `routes/owntracksPoc.ts`. The DEPARTED / ARRIVED / FINISHED hooks live in
 * the router (`ai/router.ts::performTransition`), not here.
 */
import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import { getPublicView, listActiveSessions } from '../services/tracking';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('tracking-route');

// Same shape as the OwnTracks POC debug guard — an empty INTERNAL_API_SECRET
// falls open in dev; production must set it.
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? '';
function verifyInternalSecret(provided: string): boolean {
  if (!INTERNAL_SECRET) return true;
  if (!provided || provided.length !== INTERNAL_SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(INTERNAL_SECRET));
}

// Tokens are `crypto.randomBytes(24).toString('base64url')` — 32 chars from
// [A-Za-z0-9_-]. Reject anything else up front so bogus paths never hit the DB.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export async function trackingRoutes(app: FastifyInstance) {
  // GET /tracking/:token — public JSON view.
  app.get<{ Params: { token: string } }>('/tracking/:token', async (req, reply) => {
    const token = req.params.token ?? '';
    if (!TOKEN_RE.test(token)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    const view = await getPublicView(token);
    if (!view) {
      return reply.code(404).send({ error: 'Not found' });
    }
    // No caching — status can change any second.
    reply.header('Cache-Control', 'no-store');
    return reply.send(view);
  });

  // GET /tracking/debug/sessions — internal snapshot of all live sessions.
  app.get('/tracking/debug/sessions', async (req, reply) => {
    const provided = (req.headers['x-internal-secret'] as string) ?? '';
    if (!verifyInternalSecret(provided)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const sessions = await listActiveSessions();
    log.debug({ count: sessions.length }, 'debug/sessions served');
    return reply.send({ now: new Date().toISOString(), count: sessions.length, sessions });
  });
}
