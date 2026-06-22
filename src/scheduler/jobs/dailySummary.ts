import { pool } from '../../db/connection';
import { notify } from '../../whatsapp/templates';
import { moduleLogger } from '../../utils/logger';

const log = moduleLogger('dailySummary');

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  timeZone: 'Asia/Jerusalem',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
};

interface UserTaskSummary {
  userId: string;
  userName: string;
  userPhone: string;
  tasks: Array<{
    title: string;
    dueDate: string | null;
    status: string;
    type: string;
  }>;
}

export async function runDailySummary(): Promise<void> {
  const result = await pool.query<{
    user_id: string;
    user_name: string;
    user_phone: string;
    title: string;
    due_date: string | null;
    status: string;
    type: string;
  }>(
    `SELECT
       u.id    AS user_id,
       u.name  AS user_name,
       u.phone AS user_phone,
       t.title,
       t."dueDate" AS due_date,
       t.status,
       t.type
     FROM "Task" t
     JOIN "User" u ON u.id = t."ownerId"
     WHERE t.status IN ('OPEN', 'IN_PROGRESS')
       AND upper(u.status::text) = 'ACTIVE'
     ORDER BY u.id, t."dueDate" ASC NULLS LAST`,
  );

  if (result.rowCount === 0) return;

  const byUser = new Map<string, UserTaskSummary>();
  for (const row of result.rows) {
    if (!byUser.has(row.user_id)) {
      byUser.set(row.user_id, {
        userId: row.user_id,
        userName: row.user_name,
        userPhone: row.user_phone,
        tasks: [],
      });
    }
    byUser.get(row.user_id)!.tasks.push({
      title: row.title,
      dueDate: row.due_date,
      status: row.status,
      type: row.type,
    });
  }

  log.info({ users: byUser.size }, 'Daily summary: sending');

  await Promise.allSettled(
    Array.from(byUser.values()).map(async ({ userName, userPhone, tasks }) => {
      const lines = tasks.map((t) => {
        const due = t.dueDate
          ? `עד ${new Date(t.dueDate).toLocaleDateString('he-IL', DATE_FORMAT)}`
          : 'ללא מועד';
        const icon = t.status === 'IN_PROGRESS' ? '🔄' : '📋';
        return `${icon} ${t.title} (${due})`;
      });

      const text =
        `שלום ${userName}! סיכום יומי — המשימות הפתוחות שלך:\n\n` +
        lines.join('\n') +
        `\n\nסה"כ ${tasks.length} משימות פתוחות.`;

      await notify({
        to: userPhone,
        key: 'DAILY_SUMMARY',
        bodyParams: [userName, String(tasks.length)],
        fallbackText: text,
      });
    }),
  );
}
