/**
 * Print the REAL OwnTracks inline config link for one worker — for scanning on a
 * phone to verify OwnTracks opens in MOVE mode before rollout.
 *
 * Run in the PRODUCTION environment (needs DATABASE_URL + PUBLIC_BASE_URL +
 * OWNTRACKS_CONFIG_SECRET). The config secret NEVER leaves prod — that's why this
 * link can't be minted anywhere else.
 *
 *   npm run owntracks:link -- <workerUserId | workerKey>
 */
import { pool } from '../db/connection';
import { buildInlineConfigLink, otrcToInlineScheme } from '../services/owntracksProvisioning';

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npm run owntracks:link -- <workerUserId | workerKey>');
    process.exit(1);
  }

  // Accept either a workerUserId or a workerKey — resolve the key to its user id.
  let workerUserId = arg;
  const byKey = await pool.query<{ workerUserId: string }>(
    `SELECT "workerUserId" FROM "WorkerDeviceIdentity" WHERE "workerKey" = $1 LIMIT 1`,
    [arg],
  );
  if (byKey.rows[0]) workerUserId = byKey.rows[0].workerUserId;

  const link = await buildInlineConfigLink(workerUserId);
  if (!link) {
    console.error(
      `\nNo active, provisioned OwnTracks identity for "${arg}".\n` +
      `Requires: isActive + provisionedAt on WorkerDeviceIdentity, PUBLIC_BASE_URL, ` +
      `and OWNTRACKS_CONFIG_SECRET set.\n`,
    );
    await pool.end();
    process.exit(2);
  }

  // Decode the wrapper's blob → the .otrc (to confirm monitoring:2) + the raw scheme.
  const blob = link.split('?c=')[1] ?? '';
  const otrc = JSON.parse(Buffer.from(blob, 'base64url').toString('utf8')) as Record<string, unknown>;

  console.log(`\n=== OwnTracks link for "${arg}" ===`);
  console.log('\nHTTPS (send/scan this — WhatsApp-clickable):\n' + link);
  console.log('\nRaw scheme (direct, for a device that supports it):\n' + otrcToInlineScheme(otrc));
  console.log('\n.otrc (verify "monitoring": 2 = MOVE):');
  console.log(JSON.stringify(otrc, null, 2));
  console.log('');

  await pool.end();
}

main().catch((err) => {
  console.error('[owntracks:link] FAILED:', err);
  process.exit(1);
});
