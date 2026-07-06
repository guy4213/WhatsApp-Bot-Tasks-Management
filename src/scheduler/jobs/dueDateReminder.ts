import { pool } from '../../db/connection';
import { notify } from '../../whatsapp/templates';
import { moduleLogger } from '../../utils/logger';

const log = moduleLogger('dueDateReminder');

/**
 * Runs every 5 minutes.
 * Reminds the owner ~1 hour before a task's due time. Running every 5 min with a
 * 10-minute look-ahead window ([now+55min, now+65min]) guarantees every due time
 * is covered (not just those near the top of the hour). Each reminder is guarded
 * by a row in "WhatsappReminderLog" (kind 'DUE_1H') — but the row is only
 * INSERTed AFTER the WhatsApp send actually succeeds, so a task is reminded
 * at most once, and a failed send is retried on the next tick instead of
 * being silently marked as handled.
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
      // Read-only dedup check FIRST — do not mark as reminded until the send
      // actually succeeds below.
      const already = await pool.query(
        `SELECT 1 FROM "WhatsappReminderLog" WHERE "taskId" = $1 AND kind = 'DUE_1H'`,
        [row.task_id],
      );
      if ((already.rowCount ?? 0) > 0) return; // already reminded

      const dueTime = new Date(row.due_date).toLocaleTimeString('he-IL', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jerusalem',
      });

      try {
        await notify({
          to: row.owner_phone,
          key: 'DUE_REMINDER',
          bodyParams: [row.title, dueTime],
          fallbackText: `⏰ תזכורת: המשימה "${row.title}" מגיעה למועדה בעוד כשעה (${dueTime}).`,
        });
      } catch (err) {
        log.error(
          { err, taskId: row.task_id, phone: row.owner_phone },
          'Due-date reminder WhatsApp send FAILED — will retry next tick (not marked as sent)',
        );
        return;
      }

      // Mark as reminded ONLY after the WhatsApp send actually succeeded.
      await pool.query(
        `INSERT INTO "WhatsappReminderLog" ("taskId", "kind") VALUES ($1, 'DUE_1H')
         ON CONFLICT DO NOTHING`,
        [row.task_id],
      ).catch((err) => {
        log.error(
          { err, taskId: row.task_id },
          'Failed to record due-date reminder as sent after a successful WhatsApp send — risk of a duplicate on the next tick',
        );
      });
    }),
  );
}
