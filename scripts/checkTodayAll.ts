import { pool } from '../src/db/connection';

async function main() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
  const localHm = new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit',
  });
  console.log(`Today (Asia/Jerusalem): ${today}   Now: ${localHm}\n`);

  console.log('=== Digest sends TODAY ===');
  const d = await pool.query<{ name: string; type: string; status: string; sentAt: Date }>(
    `SELECT u.name, l."digestType"::text AS type, l.status::text AS status, l."sentAt"
       FROM "WhatsappDigestSendLog" l
       JOIN "User" u ON u.id = l."userId"
      WHERE l."localDate" = $1
      ORDER BY l."sentAt" DESC`,
    [today],
  );
  if (d.rows.length === 0) console.log('  (none)');
  else for (const r of d.rows) {
    console.log(`  ${r.name.padEnd(18)} | ${r.type.padEnd(18)} | ${r.status.padEnd(8)} | ${new Date(r.sentAt).toISOString()}`);
  }

  console.log('\n=== Customer notification attempts (last 24h) ===');
  const c = await pool.query<{ taskFieldId: string; type: string; status: string; err: string | null; sentAt: Date }>(
    `SELECT "taskFieldId"::text AS "taskFieldId", "notificationType" AS type, status,
            "errorMessage" AS err, "sentAt"
       FROM "WhatsappCustomerNotification"
      WHERE "sentAt" >= now() - interval '24 hours'
      ORDER BY "sentAt" DESC LIMIT 10`,
  );
  if (c.rows.length === 0) console.log('  (none in the last 24h)');
  else for (const r of c.rows) {
    console.log(`  ${r.type} | ${r.status} | ${new Date(r.sentAt).toISOString()} | tf=${r.taskFieldId}`);
    if (r.err) console.log(`     err: ${r.err.slice(0, 200)}`);
  }

  console.log('\n=== Recent digest-related audit entries (last 24h) ===');
  const a = await pool.query<{ name: string; intent: string; status: string; err: string | null; createdAt: Date }>(
    `SELECT u.name, a."detectedIntent" AS intent, a."executionStatus" AS status,
            a."errorMessage" AS err, a."createdAt"
       FROM "WhatsappAuditLog" a
       JOIN "User" u ON u.id = a."userId"
      WHERE a."createdAt" >= now() - interval '24 hours'
        AND a."detectedIntent"::text ILIKE 'digest_%'
      ORDER BY a."createdAt" DESC LIMIT 20`,
  );
  if (a.rows.length === 0) console.log('  (none)');
  else for (const r of a.rows) {
    console.log(`  ${r.name.padEnd(18)} | ${r.intent.padEnd(20)} | ${r.status.padEnd(8)} | ${new Date(r.createdAt).toISOString()}`);
    if (r.err) console.log(`     err: ${r.err.slice(0, 200)}`);
  }

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
