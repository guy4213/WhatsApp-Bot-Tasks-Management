/**
 * Preflight for the OwnTracks auto-provisioning flow (TASKS §4.20).
 *
 * Verifies for a given phone number:
 *   1. `PUBLIC_BASE_URL` / `TRACKING_PUBLIC_BASE_URL` env var is set.
 *   2. `WHATSAPP_PROVIDER` is understood (meta / greenapi).
 *   3. A `User` row exists for the phone and role is manager-eligible
 *      (ADMIN / MANAGER — or that the user maps to a special-user role like
 *      Yoram / Sasha which also passes `isManagerMenuUser`).
 *   4. An existing `WorkerDeviceIdentity` row (if any), and whether it will be
 *      updated in place by the next `createProvisioning`.
 *   5. The migration 018 columns are present.
 *
 * Reports what's ready and what's blocking — nothing is written.
 *
 * Usage:
 *   npx ts-node scripts/checkOwnTracksProvisioningReadiness.ts <phone>
 *   npx ts-node scripts/checkOwnTracksProvisioningReadiness.ts 0534271418
 */
import * as dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

const PHONE_ARG = process.argv[2];

function normalizeIsraeli(phone: string): { digits: string; e164: string } {
  const digits = phone.replace(/\D/g, '');
  const e164 = digits.startsWith('972') ? digits : '972' + digits.replace(/^0/, '');
  return { digits, e164 };
}

async function main(): Promise<void> {
  if (!PHONE_ARG) {
    console.error('usage: ts-node scripts/checkOwnTracksProvisioningReadiness.ts <phone>');
    process.exit(2);
  }

  const problems: string[] = [];
  const ok: string[] = [];

  // ── 1. Env ─────────────────────────────────────────────────────────────────
  const publicBase = process.env.PUBLIC_BASE_URL ?? process.env.TRACKING_PUBLIC_BASE_URL ?? '';
  if (!publicBase.trim()) {
    problems.push('missing env: set PUBLIC_BASE_URL or TRACKING_PUBLIC_BASE_URL in .env');
  } else {
    ok.push(`env: publicBase = ${publicBase.replace(/\/+$/, '')}`);
  }

  const provider = process.env.WHATSAPP_PROVIDER ?? 'greenapi';
  if (provider !== 'meta' && provider !== 'greenapi') {
    problems.push(`WHATSAPP_PROVIDER="${provider}" unknown — expected "meta" or "greenapi"`);
  } else {
    ok.push(`env: WHATSAPP_PROVIDER = ${provider}`);
  }
  if (provider === 'meta' && process.env.WHATSAPP_TEMPLATES_ENABLED === 'true') {
    ok.push('templates enabled — Meta path will use owntracks_provisioning template');
  }
  if (provider === 'greenapi') {
    ok.push('Green API: freeform path always used (no template needed, no 24h window)');
  }

  // ── 2. DB ─────────────────────────────────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    problems.push('missing env: DATABASE_URL');
    printReport(ok, problems);
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    options: '-c timezone=Asia/Jerusalem',
  });

  try {
    // Migration 018 sanity — the new columns must exist.
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'WorkerDeviceIdentity'
          AND column_name IN ('passwordHash','trackerId','provisioningToken',
                              'provisioningExpiresAt','provisionedAt','revokedAt')`,
    );
    if (cols.rowCount !== 6) {
      problems.push(
        `migration 018 not fully applied — found ${cols.rowCount}/6 new columns on WorkerDeviceIdentity. ` +
        `Run: npx ts-node src/db/migrate.ts`,
      );
    } else {
      ok.push('migration 018 applied — WorkerDeviceIdentity has all provisioning columns');
    }

    // User lookup (digits + Israeli-E164 forms).
    const { digits, e164 } = normalizeIsraeli(PHONE_ARG);
    const users = await pool.query<{
      id: string; name: string; phone: string; role: string; status: string;
    }>(
      `SELECT id, name, phone, role, status
         FROM "User"
        WHERE regexp_replace(phone, '[^0-9]', '', 'g') IN ($1, $2)`,
      [digits, e164],
    );
    if (users.rowCount === 0) {
      problems.push(
        `no User found for phone ${PHONE_ARG} (digits ${digits} or ${e164}). ` +
        `Add the user in CRM first.`,
      );
      printReport(ok, problems);
      await pool.end();
      process.exit(1);
    }
    if ((users.rowCount ?? 0) > 1) {
      problems.push(`${users.rowCount} Users match phone ${PHONE_ARG} — ambiguous.`);
      for (const u of users.rows) {
        problems.push(`  - id=${u.id} name="${u.name}" role=${u.role} status=${u.status}`);
      }
      printReport(ok, problems);
      await pool.end();
      process.exit(1);
    }
    const user = users.rows[0];
    ok.push(
      `User: id=${user.id} name="${user.name}" phone=${user.phone} role=${user.role} status=${user.status}`,
    );

    if (user.status && user.status.toUpperCase() !== 'ACTIVE') {
      problems.push(`User.status="${user.status}" — findUsersByName only matches ACTIVE users.`);
    }
    const managerRoles = ['ADMIN', 'MANAGER'];
    if (!managerRoles.includes(user.role)) {
      // Could still be a special-user (Yoram/Sasha) via isManagerMenuUser — warn but not block.
      problems.push(
        `User.role="${user.role}" — must be ADMIN/MANAGER (or a named special-user) to trigger ` +
        `enable_worker_location_tracking. If you're not a manager, ask a manager to run the command for you.`,
      );
    }

    // Existing WorkerDeviceIdentity for this user.
    const wdi = await pool.query<{
      id: string; workerKey: string; passwordHash: string | null;
      isActive: boolean; revokedAt: string | null; provisioningToken: string | null;
      provisioningExpiresAt: string | null; provisionedAt: string | null; deviceLabel: string | null;
    }>(
      `SELECT id, "workerKey", "passwordHash", "isActive", "revokedAt",
              "provisioningToken", "provisioningExpiresAt", "provisionedAt", "deviceLabel"
         FROM "WorkerDeviceIdentity"
        WHERE "workerUserId" = $1
        LIMIT 1`,
      [user.id],
    );
    if (wdi.rowCount === 0) {
      ok.push('WorkerDeviceIdentity: no existing row — createProvisioning will INSERT a fresh one');
    } else {
      const r = wdi.rows[0];
      const line =
        `WorkerDeviceIdentity: workerKey="${r.workerKey}" isActive=${r.isActive} ` +
        `passwordHash=${r.passwordHash ? 'SET' : 'null'} ` +
        `provisioningToken=${r.provisioningToken ? 'PENDING' : 'null'} ` +
        `provisionedAt=${r.provisionedAt ?? 'never'} revokedAt=${r.revokedAt ?? 'null'} ` +
        `deviceLabel="${r.deviceLabel ?? ''}"`;
      ok.push(line);
      ok.push('  createProvisioning will UPDATE this row in place (workerKey preserved).');

      // Special note for the pre-provisioning POC row.
      if (r.workerKey === 'guy' && !r.passwordHash) {
        ok.push(
          '  detected legacy POC seed row (workerKey=guy, passwordHash=null) — ' +
          'your existing OwnTracks app is currently authenticating via POC_OWNTRACKS_USERS (ENV). ' +
          'After you consume the new magic link, both paths work: DB (new password) and ENV (old password).',
        );
      }
    }
  } finally {
    await pool.end();
  }

  printReport(ok, problems);
  process.exit(problems.length === 0 ? 0 : 1);
}

function printReport(ok: string[], problems: string[]): void {
  console.log('\n=== OwnTracks provisioning readiness ===\n');
  for (const line of ok) console.log(`  ok    ${line}`);
  if (problems.length === 0) {
    console.log('\n[READY] You can trigger the flow now.\n');
    console.log('  Send to the bot in WhatsApp:  הפעל מעקב מיקום ל<שם עצמך>\n');
  } else {
    console.log('');
    for (const p of problems) console.log(`  BLOCK ${p}`);
    console.log('\n[NOT READY] Fix the BLOCK items above and re-run.\n');
  }
}

main().catch((err) => {
  console.error('\n[FAIL]', err instanceof Error ? err.message : err);
  process.exit(1);
});
