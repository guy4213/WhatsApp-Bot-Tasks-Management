import { pool } from '../src/db/connection';

async function main() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
  const localHm = new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit',
  });
  console.log(`Today (Asia/Jerusalem): ${today}   Now: ${localHm}`);
  console.log();

  console.log('=== Digest send log for TODAY (all users, all types) ===');
  const a = await pool.query<{ name: string; type: string; localDate: string; status: string; sentAt: Date }>(
    `SELECT u.name,
            l."digestType"::text AS type,
            l."localDate"::text  AS "localDate",
            l.status::text       AS status,
            l."sentAt"           AS "sentAt"
       FROM "WhatsappDigestSendLog" l
       JOIN "User" u ON u.id = l."userId"
      WHERE l."localDate" = $1
      ORDER BY l."sentAt" DESC`,
    [today],
  );
  if (a.rows.length === 0) {
    console.log('  (NO rows — no digests fired yet today)');
  } else {
    for (const r of a.rows) {
      const iso = r.sentAt ? new Date(r.sentAt).toISOString() : '(no time)';
      console.log(`  ${r.name.padEnd(18)} | ${r.type.padEnd(18)} | ${r.status.padEnd(8)} | ${iso}`);
    }
  }
  console.log();

  console.log('=== YESTERDAY (2026-07-05) for comparison ===');
  const y = await pool.query<{ name: string; type: string; localDate: string; status: string; sentAt: Date }>(
    `SELECT u.name,
            l."digestType"::text AS type,
            l."localDate"::text  AS "localDate",
            l.status::text       AS status,
            l."sentAt"           AS "sentAt"
       FROM "WhatsappDigestSendLog" l
       JOIN "User" u ON u.id = l."userId"
      WHERE l."localDate" = '2026-07-05'
      ORDER BY l."sentAt" DESC`,
  );
  for (const r of y.rows) {
    const iso = r.sentAt ? new Date(r.sentAt).toISOString() : '(no time)';
    console.log(`  ${r.name.padEnd(18)} | ${r.type.padEnd(18)} | ${r.status.padEnd(8)} | ${iso}`);
  }

  await pool.end();
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
