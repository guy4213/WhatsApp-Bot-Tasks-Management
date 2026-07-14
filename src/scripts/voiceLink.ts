/**
 * Mint a personal voice-assistant link for one bot user and print it.
 *
 * The link opens the Hebrew voice page (GET /voice?u=<token>) — the token is
 * personal, expiring (default 90 days) and revocable. Run in an environment
 * with DATABASE_URL + PUBLIC_BASE_URL (e.g. Render shell, or locally with the
 * prod env), exactly like owntracks:link.
 *
 *   npm run voice:link -- <userId | phone | name> [ttlDays]
 *
 * Examples:
 *   npm run voice:link -- 0501234567
 *   npm run voice:link -- "אורי" 180
 */
import { pool } from '../db/connection';
import { createVoiceToken } from '../services/voiceAccess';
import { getPublicBaseUrl } from '../services/owntracksProvisioning';
import { normalizeIsraeliPhone } from '../auth/phoneNormalizer';

async function main(): Promise<void> {
  const arg = process.argv[2];
  const ttlDays = process.argv[3] ? Number(process.argv[3]) : undefined;
  if (!arg) {
    console.error('Usage: npm run voice:link -- <userId | phone | name> [ttlDays]');
    process.exit(1);
  }

  // Resolve the user: exact id → normalized phone → name (ILIKE).
  let row:
    | { id: string; name: string; phone: string | null; role: string; status: string }
    | undefined;

  const byId = await pool.query(
    `SELECT id, name, phone, role, status FROM "User" WHERE id = $1 LIMIT 1`,
    [arg],
  );
  row = byId.rows[0];

  if (!row) {
    const canonical = normalizeIsraeliPhone(arg);
    if (canonical) {
      const byPhone = await pool.query(
        `SELECT id, name, phone, role, status FROM "User"
          WHERE regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') IN ($1, $2)
          LIMIT 2`,
        [canonical, canonical.replace(/^972/, '0')],
      );
      if (byPhone.rows.length > 1) {
        console.error('More than one user matches that phone — pass the userId instead.');
        process.exit(2);
      }
      row = byPhone.rows[0];
    }
  }

  if (!row) {
    const byName = await pool.query(
      `SELECT id, name, phone, role, status FROM "User"
        WHERE name ILIKE '%' || $1 || '%' AND status IN ('ACTIVE', 'active')
        ORDER BY name LIMIT 5`,
      [arg],
    );
    if (byName.rows.length > 1) {
      console.error('More than one user matches that name:');
      for (const r of byName.rows) console.error(`  ${r.id}  ${r.name}  ${r.phone ?? ''}`);
      console.error('Re-run with the exact userId.');
      process.exit(2);
    }
    row = byName.rows[0];
  }

  if (!row) {
    console.error(`No user found for "${arg}".`);
    process.exit(2);
  }
  if (row.status !== 'ACTIVE' && row.status !== 'active') {
    console.error(`User ${row.name} is not ACTIVE (status=${row.status}).`);
    process.exit(2);
  }

  const { token, expiresAt } = await createVoiceToken(row.id, {
    ttlDays,
    label: `קישור של ${row.name}`,
  });
  const base = getPublicBaseUrl();

  console.log(`\n=== קישור עוזרת קולית עבור ${row.name} (${row.role}) ===\n`);
  console.log(`${base}/voice?u=${token}\n`);
  console.log(`תוקף עד: ${expiresAt.toISOString()}`);
  console.log('הקישור אישי — לשלוח רק למשתמש הזה (וואטסאפ/מייל).\n');

  await pool.end();
}

main().catch((err) => {
  console.error('[voice:link] FAILED:', err);
  process.exit(1);
});
