/**
 * Diagnostic: dump digest preferences for all active users + audit trail for
 * a specific one. Answers "why did user X get the EVENING digest at 11:30?"
 *
 * Run: npx tsx src/scripts/checkDigestPrefs.ts
 */
import { pool } from '../db/connection';

async function main() {
  console.log('═══ 1. All active users + digest prefs (effective) ═══\n');
  const { rows: prefs } = await pool.query<{
    userId: string;
    name: string;
    phone: string | null;
    role: string;
    morningEnabled: boolean | null;
    morningTime: string | null;
    eveningEnabled: boolean | null;
    eveningTime: string | null;
    timezone: string | null;
    localHm: string;
    prefUpdatedAt: Date | null;
  }>(
    `SELECT
       u.id::text                                       AS "userId",
       u.name                                           AS name,
       u.phone                                          AS phone,
       u.role::text                                     AS role,
       p."morningEnabled"                               AS "morningEnabled",
       p."morningTime"                                  AS "morningTime",
       p."eveningEnabled"                               AS "eveningEnabled",
       p."eveningTime"                                  AS "eveningTime",
       p.timezone                                       AS timezone,
       to_char(now() AT TIME ZONE COALESCE(p.timezone, 'Asia/Jerusalem'), 'HH24:MI') AS "localHm",
       p."updatedAt"                                    AS "prefUpdatedAt"
     FROM "User" u
     LEFT JOIN "UserDigestPreference" p ON p."userId" = u.id
     WHERE upper(u.status::text) = 'ACTIVE'
       AND u.phone IS NOT NULL
     ORDER BY u.name`,
  );

  console.log(
    'name                     | role        | morningTime | eveningTime | morningEn | eveningEn | prefUpdatedAt',
  );
  console.log('-'.repeat(140));
  for (const r of prefs) {
    const name = (r.name ?? '(null)').padEnd(24);
    const role = (r.role ?? '').padEnd(11);
    const mt = (r.morningTime ?? '(default 08:00)').padEnd(11);
    const et = (r.eveningTime ?? '(default 17:00)').padEnd(11);
    const me = String(r.morningEnabled ?? '(default true)').padEnd(9);
    const ee = String(r.eveningEnabled ?? '(default true)').padEnd(9);
    const upd = r.prefUpdatedAt ? new Date(r.prefUpdatedAt).toISOString() : '(no row)';
    console.log(`${name} | ${role} | ${mt} | ${et} | ${me} | ${ee} | ${upd}`);
  }
  console.log(`\nCurrent local time (Asia/Jerusalem): ${prefs[0]?.localHm ?? '?'}\n`);

  console.log('═══ 2. Recent EVENING digest sends today ═══\n');
  const { rows: sends } = await pool.query<{
    userId: string;
    name: string;
    digestType: string;
    localDate: string;
    sentAt: Date;
    status: string;
  }>(
    `SELECT
       u.id::text                                       AS "userId",
       u.name                                           AS name,
       l."digestType"::text                             AS "digestType",
       l."localDate"                                    AS "localDate",
       l."sentAt"                                    AS "createdAt",
       l."status"::text                                 AS status
     FROM "WhatsappDigestSendLog" l
     JOIN "User" u ON u.id = l."userId"
     WHERE l."sentAt" >= (now() - interval '24 hours')
     ORDER BY l."sentAt" DESC
     LIMIT 30`,
  );

  console.log('name                     | digestType         | localDate  | status  | createdAt (UTC)');
  console.log('-'.repeat(120));
  for (const r of sends) {
    console.log(
      `${(r.name ?? '').padEnd(24)} | ${r.digestType.padEnd(18)} | ${r.localDate} | ${(r.status ?? '').padEnd(7)} | ${new Date(r.sentAt).toISOString()}`,
    );
  }
  console.log();

  console.log('═══ 3. WhatsappAuditLog for digest events (last 24h) ═══\n');
  const { rows: audits } = await pool.query<{
    userId: string;
    name: string;
    detectedAction: string;
    sentAt: Date;
    newValues: unknown;
  }>(
    `SELECT
       u.id::text        AS "userId",
       u.name            AS name,
       a."detectedAction"::text AS "detectedAction",
       a."createdAt"     AS "createdAt",
       a."newValues"     AS "newValues"
     FROM "WhatsappAuditLog" a
     JOIN "User" u ON u.id = a."userId"
     WHERE a."createdAt" >= (now() - interval '24 hours')
       AND (
         a."detectedAction"::text ILIKE '%digest%'
         OR a."detectedAction"::text ILIKE '%SUMMARY%'
       )
     ORDER BY a."createdAt" DESC
     LIMIT 30`,
  );

  if (audits.length === 0) {
    console.log('(no digest-related audit entries in the last 24h)\n');
  } else {
    console.log('name                     | detectedAction               | createdAt (UTC)          | newValues');
    console.log('-'.repeat(160));
    for (const r of audits) {
      console.log(
        `${(r.name ?? '').padEnd(24)} | ${r.detectedAction.padEnd(28)} | ${new Date(r.sentAt).toISOString()} | ${JSON.stringify(r.newValues)}`,
      );
    }
    console.log();
  }

  await pool.end();
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
