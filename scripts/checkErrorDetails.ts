import { pool } from '../src/db/connection';

async function main() {
  const { rows } = await pool.query<{ name: string; intent: string; err: string; createdAt: Date }>(
    `SELECT u.name, a."detectedIntent"::text AS intent, a."errorMessage" AS err, a."createdAt"
       FROM "WhatsappAuditLog" a JOIN "User" u ON u.id = a."userId"
      WHERE a."createdAt" >= now() - interval '24 hours'
        AND a."detectedIntent"::text ILIKE 'digest_%'
        AND a."errorMessage" LIKE '%132001%'
      ORDER BY a."createdAt" DESC LIMIT 3`,
  );
  for (const r of rows) {
    console.log(`── ${r.name} | ${r.intent} | ${new Date(r.createdAt).toISOString()}`);
    console.log(r.err);
    console.log();
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
