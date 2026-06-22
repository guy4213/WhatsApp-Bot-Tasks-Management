import { pool } from '../../db/connection';
import { notify } from '../../whatsapp/templates';
import { moduleLogger } from '../../utils/logger';

const log = moduleLogger('completionNotifier');

/**
 * Polls every 2 minutes for tasks newly set to DONE by the CRM.
 * Uses whatsapp_completion_notifications as a dedup table so each task
 * is announced at most once, regardless of how many times the cron runs.
 *
 * Atomicity: the INSERT is done before the send. If the INSERT succeeds
 * (rowCount === 1) we send; if it was already inserted by a concurrent
 * instance (rowCount === 0 via ON CONFLICT DO NOTHING) we skip.
 */
export async function runCompletionNotifier(): Promise<void> {
  // Find DONE tasks not yet in our notification log
  const doneTasks = await pool.query<{
    task_id: string;
    task_title: string;
    owner_name: string;
  }>(
    `SELECT t.id AS task_id, t.title AS task_title, u.name AS owner_name
     FROM "Task" t
     JOIN "User" u ON u.id = t."ownerId"
     WHERE t.status = 'DONE'
       AND NOT EXISTS (
         SELECT 1 FROM "WhatsappCompletionNotification" n
         WHERE n."taskId" = t.id
       )
     ORDER BY t."updatedAt" DESC
     LIMIT 50`,
  );

  if ((doneTasks.rowCount ?? 0) === 0) return;

  log.info({ count: doneTasks.rowCount }, 'Completion notifier: newly-done tasks');

  // Fetch managers once for the whole batch
  const managers = await pool.query<{ name: string; phone: string }>(
    `SELECT u.name, u.phone
     FROM "User" u
     WHERE u.role IN ('MANAGER', 'ADMIN')
       AND upper(u.status::text) = 'ACTIVE'
       AND NOT EXISTS (
         SELECT 1 FROM "WhatsappNotificationRecipient" r
         WHERE r."userId" = u.id
           AND 'TASK_COMPLETED' = ANY(r."eventTypes")
           AND r."isActive" = false
       )`,
  );

  for (const task of doneTasks.rows) {
    // INSERT first — only the instance that actually inserts (rowCount === 1) sends.
    // ON CONFLICT DO NOTHING means a concurrent instance gets rowCount === 0 and skips.
    const inserted = await pool.query(
      `INSERT INTO "WhatsappCompletionNotification" ("taskId") VALUES ($1) ON CONFLICT DO NOTHING`,
      [task.task_id],
    );

    if ((inserted.rowCount ?? 0) === 0) continue; // another instance already handled this

    if ((managers.rowCount ?? 0) === 0) continue;

    const text = `✅ המשימה "${task.task_title}" (${task.owner_name}) סומנה כ"בוצע" במערכת.`;

    await Promise.allSettled(
      managers.rows.map((m) =>
        notify({
          to: m.phone,
          key: 'TASK_COMPLETED',
          bodyParams: [task.task_title, task.owner_name],
          fallbackText: text,
        }),
      ),
    );
  }
}
