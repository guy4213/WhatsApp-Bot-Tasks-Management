/**
 * QA seed: creates ONE fictitious IncomingLead row (status='NEW', unassigned)
 * for testing the D3-T3 lead-assignment-alert flow end-to-end.
 *
 * Usage:
 *   npx tsx scripts/qa-seed-fictitious-lead.ts
 *
 * The script:
 *   1. Inserts a new IncomingLead row with `[QA_TEST]` subject prefix, so
 *      cleanup is trivial (`DELETE FROM "IncomingLead" WHERE subject LIKE
 *      '[QA_TEST]%';`).
 *   2. Looks up Guy Franses's User.id + phone so the printed instructions
 *      are copy-pasteable.
 *   3. Prints two next-step options:
 *        (a) Direct SQL — assign via UPDATE inside Supabase SQL Editor.
 *        (b) Via WhatsApp bot — a free-text message that the assign_lead
 *            intent handles (multi-step: pick lead → pick worker → confirm).
 *   4. Does NOT assign the lead — that is the whole point of the manual
 *      test. Assignment is what fires the trigger.
 *
 * Idempotency: each run creates a NEW lead. Old QA_TEST rows are safe to
 * leave in place; they show up in the Sasha pending-leads list until
 * assigned or manually deleted.
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const GUY_NAME = 'גיא פרנסס';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    options: '-c timezone=Asia/Jerusalem',
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Look up Guy Franses so the follow-up SQL is copy-pasteable.
    const userRes = await client.query<{ id: string; role: string; phone: string | null }>(
      `SELECT id::text AS id, role, phone FROM "User" WHERE name = $1 LIMIT 1`,
      [GUY_NAME],
    );
    if (userRes.rowCount === 0) {
      throw new Error(`User "${GUY_NAME}" not found in the User table`);
    }
    const guy = userRes.rows[0]!;

    // 2. Placeholder initial owner. The CRM schema constrains
    //    `IncomingLead.ownerId text NOT NULL` (SCHEMA_CRM.md L1086) even
    //    though the app treats "null-owner" as the pending state — a
    //    schema mismatch we inherit and cannot fight from a seed script.
    //    Sasha is the natural initial owner (leads land in her inbox);
    //    fall back to Guy if the DB has no user by that name.
    const sashaRes = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM "User" WHERE name = 'סשה' LIMIT 1`,
    );
    const initialOwnerId = sashaRes.rowCount ? sashaRes.rows[0]!.id : guy.id;

    // 3. Insert the fictitious IncomingLead in the pending state.
    //    - status='NEW' — the trigger fires on NEW→ACTIVE, which is what
    //      the next assign step will produce.
    //    - messageId is a random-ish string; the CRM uses graph message IDs
    //      here, but any unique value satisfies the NOT NULL constraint.
    //    - updatedAt matches receivedAt on insert (the CRM's own convention).
    //    - id is text-typed on the CRM side; a UUID cast to text works.
    const insertRes = await client.query<{ id: string }>(
      `INSERT INTO "IncomingLead"
         (id, "messageId", subject, body, "fromName", "fromEmail",
          "receivedAt", status, "ownerId", "taskId", "updatedAt")
       VALUES
         (gen_random_uuid()::text,
          'qa-test-' || gen_random_uuid()::text,
          '[QA_TEST] בדיקת קרינה — ליד פיקטיבי',
          'לקוח דמה מבקש בדיקת קרינה. זהו ליד פיקטיבי שנוצר על-ידי qa-seed-fictitious-lead.ts לצורך בדיקת מסלול ההתראה על שיוך ליד.',
          'לקוח ניסוי',
          'qa-test@example.com',
          now(),
          'NEW',
          $1,
          NULL,
          now())
       RETURNING id::text AS id`,
      [initialOwnerId],
    );
    const leadId = insertRes.rows[0]!.id;

    await client.query('COMMIT');

    // 3. Print copy-pasteable next steps. Written to stdout (not the logger)
    //    so the operator can pipe / grep the ID out cleanly.
    console.log('');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('  QA fictitious lead created ✓');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('');
    console.log(`  Lead ID:      ${leadId}`);
    console.log(`  Assignee:     ${GUY_NAME}`);
    console.log(`  User ID:      ${guy.id}`);
    console.log(`  User role:    ${guy.role}`);
    console.log(`  User phone:   ${guy.phone ?? '(none)'}`);
    console.log('');
    console.log('────────────────────────────────────────────────────────────────');
    console.log('  Option A — assign via SQL (Supabase SQL Editor):');
    console.log('────────────────────────────────────────────────────────────────');
    console.log('');
    console.log(`  UPDATE "IncomingLead"`);
    console.log(`  SET status = 'ACTIVE', "ownerId" = '${guy.id}'`);
    console.log(`  WHERE id = '${leadId}';`);
    console.log('');
    console.log(`  -- Then verify the trigger fired:`);
    console.log(`  SELECT status_code, created FROM net._http_response`);
    console.log(`  ORDER BY created DESC LIMIT 3;`);
    console.log('');
    console.log('────────────────────────────────────────────────────────────────');
    console.log('  Option B — assign via WhatsApp bot:');
    console.log('────────────────────────────────────────────────────────────────');
    console.log('');
    console.log(`  Send to the bot from your WhatsApp:`);
    console.log(`    לשייך את הליד של לקוח ניסוי אלי`);
    console.log('');
    console.log('  The bot will look up the lead by "לקוח ניסוי" and offer to');
    console.log('  confirm. Reply "אישור" and the assignment writes to the DB,');
    console.log('  the trigger fires, and you receive the WhatsApp alert.');
    console.log('');
    console.log('────────────────────────────────────────────────────────────────');
    console.log('  Cleanup after the test:');
    console.log('────────────────────────────────────────────────────────────────');
    console.log('');
    console.log(`  DELETE FROM "WhatsappLeadNotification" WHERE "leadId" = '${leadId}';`);
    console.log(`  DELETE FROM "Task" WHERE "incomingLeadId" = '${leadId}';`);
    console.log(`  DELETE FROM "IncomingLead" WHERE id = '${leadId}';`);
    console.log('');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('qa-seed-fictitious-lead FAILED:', err);
  process.exit(1);
});
