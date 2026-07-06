import { pool } from '../src/db/connection';

async function main() {
  console.log('=== Today\'s digest FAILED audit entries with error messages ===');
  const rows = await pool.query<{ name: string; intent: string; status: string; error: string | null; createdAt: Date }>(
    `SELECT u.name,
            a."detectedIntent"::text  AS intent,
            a."executionStatus"::text AS status,
            a."errorMessage"          AS error,
            a."createdAt"             AS "createdAt"
       FROM "WhatsappAuditLog" a
       JOIN "User" u ON u.id = a."userId"
      WHERE a."createdAt" >= (now() - interval '4 hours')
        AND a."detectedIntent"::text ILIKE 'digest_%'
      ORDER BY a."createdAt" DESC
      LIMIT 40`,
  );
  for (const r of rows.rows) {
    console.log(`── ${r.name} | ${r.intent} | ${r.status} | ${new Date(r.createdAt).toISOString()}`);
    if (r.error) console.log(`   err: ${r.error.slice(0, 500)}`);
  }
  await pool.end();
}
main().catch((e) => { console.error('FAILED', e); process.exit(1); });
