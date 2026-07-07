import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { pool } from './db/connection';
import { logger } from './utils/logger';
import { taskRoutes }    from './routes/tasks';
import { webhookRoutes } from './routes/webhook';
import { owntracksPocRoutes } from './routes/owntracksPoc';
import { startScheduler } from './scheduler';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function buildApp() {
  // Use the shared pino instance so request logs and module logs are unified.
  // Fastify v5 takes an existing instance via `loggerInstance` (not `logger`).
  const app = Fastify({ loggerInstance: logger });

  // HTTP-layer rate limit (per IP). Internal localhost calls from the webhook
  // handler are allow-listed so they're never throttled.
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    allowList: ['127.0.0.1', '::1'],
  });

  // Capture raw body for HMAC webhook signature verification.
  app.addContentTypeParser<Buffer>(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      req.rawBody = body;
      try {
        done(null, JSON.parse(body.toString()) as Record<string, unknown>);
      } catch (err) {
        done(err as Error);
      }
    },
  );

  await app.register(taskRoutes);
  await app.register(webhookRoutes);
  await app.register(owntracksPocRoutes);

  // ── Liveness probe ────────────────────────────────────────────────────────
  app.get('/health/live', async () => ({ status: 'ok' }));

  // ── Readiness probe (checks DB) ───────────────────────────────────────────
  app.get('/health/ready', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return reply.send({ status: 'ok', db: 'connected' });
    } catch (err) {
      app.log.error({ err }, '[health] DB connectivity check failed');
      return reply.code(503).send({ status: 'error', db: 'unreachable' });
    }
  });

  // Legacy alias — liveness only
  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}

export function buildAndStartScheduler(): void {
  startScheduler();
}
