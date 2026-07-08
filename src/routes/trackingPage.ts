/**
 * Customer-facing tracking page — `GET /t/:token`.
 *
 * Reads the same session as `GET /tracking/:token` via `getPublicView`, then
 * server-renders the Hebrew RTL page (`renderTrackingPage`) with the initial
 * state embedded so the customer sees content in one round-trip. The page's
 * own JavaScript then polls `GET /tracking/:token` for updates.
 *
 * Contract mirrors the JSON route:
 *   - Same token regex whitelist — bogus paths never touch the DB.
 *   - Unknown / malformed / expired-with-no-terminal-status → 404 HTML,
 *     no distinction between "never existed" and "revoked".
 *   - `Cache-Control: no-store` — status can change any second.
 *
 * Explicitly separate from `routes/tracking.ts`: we do NOT flip that JSON
 * endpoint to HTML — anything that already consumes the JSON (QA tools,
 * debug scripts) keeps working unchanged.
 */
import type { FastifyInstance } from 'fastify';
import { getPublicView } from '../services/tracking';
import { renderTrackingPage, renderNotFound } from './trackingPage.template';

// Same whitelist as `routes/tracking.ts` — reject malformed tokens before the DB.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export async function trackingPageRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string } }>('/t/:token', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/html; charset=utf-8');

    const token = req.params.token ?? '';
    if (!TOKEN_RE.test(token)) {
      return reply.code(404).send(renderNotFound());
    }
    const view = await getPublicView(token);
    if (!view) {
      return reply.code(404).send(renderNotFound());
    }
    return reply.send(renderTrackingPage(token, view));
  });
}
