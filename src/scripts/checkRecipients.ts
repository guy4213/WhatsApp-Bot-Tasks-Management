/**
 * Diagnostic: who would (and would NOT) receive the daily summary, and why.
 * Lists active users that have open tasks, flagging any with a missing/blank phone
 * (those are silently skipped by the sender — "Empty recipient").
 *
 *   npx ts-node src/scripts/checkRecipients.ts   (or)  npm run check:recipients
 */
import { pool } from '../db/connection';

async function main(): Promise<void> {
  const { rows } = await pool.query<{
    name: string;
    phone: string | null;
    status: string;
    open_tasks: string;
  }>(
    `SELECT u.name, u.phone, u.status::text AS status,
            COUNT(*) FILTER (WHERE t.status IN ('OPEN','IN_PROGRESS')) AS open_tasks
     FROM "User" u
     LEFT JOIN "Task" t ON t."ownerId" = u.id
     GROUP BY u.id, u.name, u.phone, u.status
     ORDER BY u.name`,
  );

  console.log('\n=== Daily-summary recipient check ===\n');
  for (const r of rows) {
    const hasPhone = !!(r.phone && r.phone.trim());
    const active = r.status.toUpperCase() === 'ACTIVE';
    const open = parseInt(r.open_tasks, 10);
    const willReceive = active && open > 0 && hasPhone;
    const reasons: string[] = [];
    if (!active) reasons.push('inactive');
    if (open === 0) reasons.push('no open tasks');
    if (!hasPhone) reasons.push('NO PHONE');
    const mark = willReceive ? '✅' : '❌';
    console.log(
      `${mark} ${r.name.padEnd(20)} phone=${(r.phone ?? '(blank)').padEnd(16)} status=${r.status.padEnd(8)} open=${open}` +
      (willReceive ? '' : `   → skipped: ${reasons.join(', ')}`),
    );
  }
  console.log('\n(✅ = would receive; ❌ = would NOT. Note: ✅ still requires the user to be inside their 24h WhatsApp window while templates are disabled.)\n');

  await pool.end();
}

main().catch((err) => {
  console.error('[check] FAILED:', err);
  process.exit(1);
});
