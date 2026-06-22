/**
 * Manual one-off trigger for the daily summary — fires the SAME job the scheduler
 * runs at 13:00, but right now, without waiting for cron or restarting the server.
 *
 *   npx ts-node src/scripts/sendDailySummary.ts
 *   (or)  npm run summary:now
 *
 * Reminder: this sends REAL WhatsApp messages. Only active users with at least one
 * OPEN/IN_PROGRESS task are messaged, and (with templates disabled) delivery still
 * requires each recipient to be inside their 24h WhatsApp window.
 */
import { pool } from '../db/connection';
import { runDailySummary } from '../scheduler/jobs/dailySummary';

async function main(): Promise<void> {
  try {
    await pool.query('SELECT 1');
    console.log('[summary] Connected to DB ✓');
  } catch (err) {
    console.error('[summary] Cannot connect to DB. Check DATABASE_URL in .env:', err);
    process.exit(1);
  }

  console.log('[summary] Running daily summary now…');
  await runDailySummary();
  console.log('[summary] Done — check the logs above for the recipient count and any send errors.');

  await pool.end();
}

main().catch((err) => {
  console.error('[summary] FAILED:', err);
  process.exit(1);
});
