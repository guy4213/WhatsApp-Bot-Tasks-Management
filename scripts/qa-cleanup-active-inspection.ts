/**
 * QA cleanup: deletes ALL Task + TaskField rows whose title/appointmentTitle
 * begins with "[QA_TEST]". Safe to re-run; deletes only the QA rows we created.
 *
 * Order:
 *   1. Delete TaskField rows for QA tasks (and any orphan [QA_TEST] TaskFields).
 *   2. Delete Task rows tagged [QA_TEST].
 *
 * Everything runs in a transaction. Prints counts so you can eyeball the result.
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tasks = await client.query(
      `SELECT id, title FROM "Task" WHERE title LIKE '[QA_TEST]%'`,
    );
    console.log(`Found ${tasks.rowCount} [QA_TEST] Task row(s):`);
    for (const r of tasks.rows) console.log(`  - ${r.id}  ${r.title}`);

    if (tasks.rowCount && tasks.rowCount > 0) {
      const taskIds = tasks.rows.map((r) => r.id);

      const tf = await client.query(
        `DELETE FROM "TaskField" WHERE "taskId" = ANY($1::text[]) RETURNING id`,
        [taskIds],
      );
      console.log(`Deleted ${tf.rowCount} TaskField row(s) belonging to those tasks.`);

      const tfExtra = await client.query(
        `DELETE FROM "TaskField" WHERE "appointmentTitle" LIKE '[QA_TEST]%' RETURNING id`,
      );
      console.log(`Deleted ${tfExtra.rowCount} additional [QA_TEST] TaskField row(s) (if any).`);

      const t = await client.query(
        `DELETE FROM "Task" WHERE id = ANY($1::text[]) RETURNING id`,
        [taskIds],
      );
      console.log(`Deleted ${t.rowCount} Task row(s).`);
    } else {
      console.log('Nothing to delete.');
    }

    await client.query('COMMIT');
    console.log('\n✓ Cleanup complete.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ERROR:', (e as Error).message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
