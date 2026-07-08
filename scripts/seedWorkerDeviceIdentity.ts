/**
 * Seed one row in "WorkerDeviceIdentity" mapping an OwnTracks basic-auth
 * username → an existing "User".id. Safe by design:
 *  - verifies migration 016 has been applied (table exists) — otherwise aborts.
 *  - looks up the User by phone (digits-only + Israeli-E164 forms) — refuses
 *    to write if 0 or >1 users match.
 *  - performs UPSERT ON CONFLICT ("workerKey"); uses xmax=0 to distinguish
 *    INSERT from UPDATE for the summary log.
 *
 * Hard-coded parameters for THIS seed:
 *   workerKey    = 'guy'
 *   userPhone    = '0534271418'
 *   deviceLabel  = 'OwnTracks test phone'
 *
 * Nothing else is touched. Idempotent.
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const WORKER_KEY   = 'guy';
const USER_PHONE   = '0534271418';
const DEVICE_LABEL = 'OwnTracks test phone';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    options: '-c timezone=Asia/Jerusalem',
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Step 1: verify migration 016 has been applied.
    const reg = await client.query<{ oid: string | null }>(
      `SELECT to_regclass('"WorkerDeviceIdentity"') AS oid`,
    );
    if (!reg.rows[0].oid) {
      throw new Error(
        'Table "WorkerDeviceIdentity" does not exist — apply migration 016 first.',
      );
    }
    console.log('[1/5] Table "WorkerDeviceIdentity" — OK.');

    // Step 2: find matching User rows (digits-only + Israeli-E164).
    const stripped = USER_PHONE.replace(/[^0-9]/g, '');
    const e164     = '972' + stripped.replace(/^0/, '');
    const users = await client.query<{
      id: string; name: string; phone: string; role: string; status: string;
    }>(
      `SELECT id, name, phone, role, status
         FROM "User"
        WHERE regexp_replace(phone, '[^0-9]', '', 'g') IN ($1, $2)`,
      [stripped, e164],
    );
    console.log(`[2/5] User matches for phone ${USER_PHONE} — found ${users.rowCount}:`);
    for (const u of users.rows) {
      console.log(`      · id=${u.id}  name="${u.name}"  phone=${u.phone}  role=${u.role}  status=${u.status}`);
    }

    if (users.rowCount === 0) {
      throw new Error(`No User matches phone ${USER_PHONE} (digits: ${stripped} or ${e164}).`);
    }
    if ((users.rowCount ?? 0) > 1) {
      throw new Error(`Ambiguous: ${users.rowCount} Users match phone ${USER_PHONE} — refusing to upsert.`);
    }
    const targetUser = users.rows[0];

    // Step 3: UPSERT + RETURNING with xmax to know insert vs update.
    // In PostgreSQL: after an INSERT, xmax is 0; after ON CONFLICT DO UPDATE, xmax != 0.
    const upserted = await client.query<{
      id: string; workerKey: string; workerUserId: string; deviceLabel: string;
      isActive: boolean; createdAt: string; updatedAt: string; is_update: boolean;
    }>(
      `INSERT INTO "WorkerDeviceIdentity"
         ("workerKey", "workerUserId", "deviceLabel", "isActive")
       VALUES ($1, $2, $3, true)
       ON CONFLICT ("workerKey") DO UPDATE
         SET "workerUserId" = EXCLUDED."workerUserId",
             "deviceLabel"  = EXCLUDED."deviceLabel",
             "isActive"     = true,
             "updatedAt"    = now()
       RETURNING id, "workerKey", "workerUserId", "deviceLabel", "isActive",
                 "createdAt", "updatedAt", (xmax <> 0) AS is_update`,
      [WORKER_KEY, targetUser.id, DEVICE_LABEL],
    );
    const row = upserted.rows[0];
    const action = row.is_update ? 'UPDATE' : 'INSERT';
    console.log(`[3/5] ${action} workerKey=${row.workerKey} → workerUserId=${row.workerUserId}`);

    // Step 4: verifying SELECT (independent read, not the RETURNING).
    const verify = await client.query(
      `SELECT id, "workerKey", "workerUserId", "deviceLabel", "isActive",
              "createdAt", "updatedAt"
         FROM "WorkerDeviceIdentity"
        WHERE "workerKey" = $1`,
      [WORKER_KEY],
    );
    console.log('[4/5] Verify SELECT:');
    console.log(verify.rows[0]);

    await client.query('COMMIT');
    console.log('[5/5] Committed.');

    console.log('\n─── Summary ───');
    console.log(`workerKey        = ${row.workerKey}`);
    console.log(`workerUserId     = ${row.workerUserId}  (name="${targetUser.name}", role=${targetUser.role})`);
    console.log(`action           = ${action}`);
    console.log(`deviceLabel      = ${row.deviceLabel}`);
    console.log(`isActive         = ${row.isActive}`);
    console.log(`createdAt        = ${row.createdAt}`);
    console.log(`updatedAt        = ${row.updatedAt}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* best-effort */ });
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n[FAIL]', err instanceof Error ? err.message : err);
  process.exit(1);
});
