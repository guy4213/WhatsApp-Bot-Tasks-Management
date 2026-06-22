/**
 * Shared structured logger (pino).
 *
 * Used by services, scheduler jobs, and the WhatsApp sender — i.e. everywhere
 * outside the Fastify request lifecycle (request handlers use `req.log`/`app.log`,
 * which is the same pino instance configuration).
 *
 * Child loggers carry a `module` field so logs can be filtered by source.
 */
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export const logger = pino({
  level,
  // In production emit raw JSON (machine-parseable); in dev keep it compact.
  base: { service: 'whatsapp-task-bot' },
});

/** Create a child logger tagged with the given module name. */
export function moduleLogger(moduleName: string) {
  return logger.child({ module: moduleName });
}
