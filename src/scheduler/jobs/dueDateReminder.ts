import { pool } from '../../db/connection';
import { notify } from '../../whatsapp/templates';
import { moduleLogger } from '../../utils/logger';

const log = moduleLogger('dueDateReminder');

/**
 * Runs every 5 minutes.
 * Reminds the owner ~1 hour before a task's due time. Running every 5 min with a
 * 10-minute look-ahead window ([now+55min, now+65min]) guarantees every due time
 * is covered (not just those near the top of the hour). Each reminder is guarded
 * by an INSERT-first into "WhatsappReminderLog" (kind 'DUE_1H'), so a task is
 * reminded at most once even across overlapping runs or restarts.
 */
export async function runDueDateReminder(): Promise<void> {
  const result = await pool.query<{
    task_id: string;
    owner_name: string;
    owner_phone: string;
    title: string;
    due_date: string;
  }>(
    `SELECT
       t.id    AS task_id,
       u.name  AS owner_name,
       u.phone AS owner_phone,
       t.title,
       t."dueDate" AS due_date
     FROM "Task" t
     JOIN "User" u ON u.id = t."ownerId"
     WHERE t.status != 'DONE'
       AND t."dueDate" IS NOT NULL
       AND t."dueDate" BETWEEN now() + interval '55 minutes'
                           AND now() + interval '65 minutes'
       AND upper(u.status::text) = 'ACTIVE'`,
  );

  if (result.rowCount === 0) return;

  log.info({ count: result.rowCount }, 'Due-date reminders');

  await Promise.allSettled(
    result.rows.map(async (row) => {
      // INSERT-first dedup — only the run that actually inserts sends the reminder.
      const inserted = await pool.query(
        `INSERT INTO "WhatsappReminderLog" ("taskId", "kind") VALUES ($1, 'DUE_1H')
         ON CONFLICT DO NOTHING`,
        [row.task_id],
      );
      if ((inserted.rowCount ?? 0) === 0) return; // already reminded

      const dueTime = new Date(row.due_date).toLocaleTimeString('he-IL', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jerusalem',
      });
      await notify({
        to: row.owner_phone,
        key: 'DUE_REMINDER',
        bodyParams: [row.title, dueTime],
        fallbackText: `⏰ תזכורת: המשימה "${row.title}" מגיעה למועדה בעוד כשעה (${dueTime}).`,
      });
    }),
  );
}
