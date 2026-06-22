// Env vars are loaded by src/db/connection.ts (the earliest-evaluated module in
// the import graph), so no dotenv.config() is needed here — import hoisting would
// run it too late anyway.
import { buildApp, buildAndStartScheduler } from './app';
import { pool } from './db/connection';
import { recoverInboundQueue } from './routes/webhook';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    buildAndStartScheduler();

    // Reprocess any messages a previous crash left in the queue
    recoverInboundQueue().catch((err) => app.log.error({ err }, '[startup] Queue recovery failed'));
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    app.log.info(`[server] ${signal} received — shutting down gracefully`);
    try {
      await app.close();   // stops accepting requests; waits for in-flight; cron stops on exit
      await pool.end();     // drains and closes all DB connections
      app.log.info('[server] Shutdown complete');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, '[server] Error during shutdown');
      process.exit(1);
    }
  }

  process.once('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.once('SIGINT',  () => { shutdown('SIGINT').catch(() => process.exit(1)); });
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
