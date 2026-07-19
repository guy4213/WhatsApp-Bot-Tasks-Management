/**
 * TEMPORARY read-only — inspect the 3 leads the user asked about (2026-07-19).
 * Delete after use.
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    options: '-c timezone=Asia/Jerusalem',
  });
  try {
    // Grab the leads shown in the manager menu today.
    const { rows } = await pool.query(
      `SELECT id, "fromName", "fromEmail", subject, body,
              to_char("receivedAt" AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') AS "receivedIL",
              "ownerId"
       FROM "IncomingLead"
       WHERE "receivedAt" >= '2026-07-17 18:00:00+00'
         AND "receivedAt" <  '2026-07-19 08:00:00+00'
       ORDER BY "receivedAt" DESC`,
    );

    for (const r of rows) {
      console.log('\n═══════════════════════════════════════════════════════════');
      console.log(`id           : ${r.id}`);
      console.log(`receivedIL   : ${r.receivedIL}`);
      console.log(`fromName     : ${JSON.stringify(r.fromName)}`);
      console.log(`fromEmail    : ${JSON.stringify(r.fromEmail)}`);
      console.log(`subject      : ${JSON.stringify(r.subject)}`);
      console.log(`ownerId      : ${r.ownerId ?? '(unassigned)'}`);
      console.log(`bodyLen      : ${(r.body ?? '').length}`);
      console.log(`bodyPreview  :`);
      const body = r.body ?? '';
      const preview = body.length > 500 ? body.slice(0, 500) + '…' : body;
      console.log(preview);
    }

    console.log('\n───── InspectionType catalog (family + labelHe) ─────');
    const { rows: types } = await pool.query(
      `SELECT family, "labelHe", code FROM "InspectionType"
       WHERE "isActive" = true AND "isFieldInspection" = true
       ORDER BY family, "labelHe"`,
    );
    // Group by family for readability.
    const byFamily: Record<string, string[]> = {};
    for (const t of types) {
      (byFamily[t.family] ??= []).push(`${t.labelHe} [${t.code}]`);
    }
    for (const [fam, labels] of Object.entries(byFamily)) {
      console.log(`\n${fam}:`);
      for (const l of labels) console.log(`  • ${l}`);
    }
  } finally { await pool.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
