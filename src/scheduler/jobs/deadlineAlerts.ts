import { pool } from '../../db/connection';
import { notify } from '../../whatsapp/templates';
import { moduleLogger } from '../../utils/logger';

const log = moduleLogger('deadlineAlerts');

const DEADLINE_ALERT_HOURS = parseInt(process.env.DEADLINE_ALERT_HOURS ?? '24', 10);
const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  timeZone: 'Asia/Jerusalem',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
};

// ── Deadline EXCEEDED — tasks past due, not done ──────────────────────────────
// Each overdue task is alerted to managers ONCE (dedup via WhatsappReminderLog,
// kind 'DEADLINE_EXCEEDED'), so a task that stays overdue isn't re-alerted daily.

export async function runDeadlineExceededAlert(): Promise<void> {
  // 1. Overdue, not-done tasks not yet alerted.
  const tasks = await pool.query<{
    task_id: string;
    task_title: string;
    owner_name: string;
    overdue_since: string;
  }>(
    `SELECT t.id AS task_id, t.title AS task_title, u.name AS owner_name, t."dueDate" AS overdue_since
     FROM "Task" t
     JOIN "User" u ON u.id = t."ownerId"
     WHERE t.status != 'DONE'
       AND t."dueDate" IS NOT NULL
       AND t."dueDate" < now()
       AND NOT EXISTS (
         SELECT 1 FROM "WhatsappReminderLog" rl
         WHERE rl."taskId" = t.id AND rl.kind = 'DEADLINE_EXCEEDED'
       )
     ORDER BY t."dueDate" ASC
     LIMIT 100`,
  );

  if ((tasks.rowCount ?? 0) === 0) return;

  // 2. INSERT-first dedup — keep only the tasks this run actually claimed.
  const fresh: typeof tasks.rows = [];
  for (const t of tasks.rows) {
    const ins = await pool.query(
      `INSERT INTO "WhatsappReminderLog" ("taskId", "kind") VALUES ($1, 'DEADLINE_EXCEEDED')
       ON CONFLICT DO NOTHING`,
      [t.task_id],
    );
    if ((ins.rowCount ?? 0) === 1) fresh.push(t);
  }
  if (fresh.length === 0) return;

  // 3. Notify all active managers/admins (respecting opt-outs).
  const managers = await pool.query<{ phone: string; name: string }>(
    `SELECT m.phone, m.name
     FROM "User" m
     WHERE m.role IN ('MANAGER', 'ADMIN')
       AND m.status::text = 'ACTIVE'
       AND NOT EXISTS (
         SELECT 1 FROM "WhatsappNotificationRecipient" r
         WHERE r."userId" = m.id
           AND 'DEADLINE_EXCEEDED' = ANY(r."eventTypes")
           AND r."isActive" = false
       )`,
  );

  if ((managers.rowCount ?? 0) === 0) return;

  log.info({ managers: managers.rowCount, tasks: fresh.length }, 'Deadline-exceeded alerts');

  const lines = fresh.map((t) => {
    const since = new Date(t.overdue_since).toLocaleDateString('he-IL', DATE_FORMAT);
    return `• "${t.task_title}" (${t.owner_name}) — מועד היה: ${since}`;
  });

  await Promise.allSettled(
    managers.rows.map((m) => {
      const text =
        `שלום ${m.name}, התראה: ${fresh.length} משימות שעבר מועדן:\n\n` + lines.join('\n');
      return notify({
        to: m.phone,
        key: 'DEADLINE_EXCEEDED',
        bodyParams: [m.name, String(fresh.length)],
        fallbackText: text,
      });
    }),
  );
}

// ── Deadline APPROACHING — tasks due within DEADLINE_ALERT_HOURS ──────────────

export async function runDeadlineApproachingAlert(): Promise<void> {
  const result = await pool.query<{
    manager_phone: string;
    manager_name: string;
    task_title: string;
    owner_name: string;
    due_date: string;
  }>(
    `SELECT
       m.phone          AS manager_phone,
       m.name           AS manager_name,
       t.title          AS task_title,
       u.name           AS owner_name,
       t."dueDate"      AS due_date
     FROM "Task" t
     JOIN "User" u  ON u.id = t."ownerId"
     JOIN "User" m  ON m.role IN ('MANAGER', 'ADMIN')
                  AND upper(m.status::text) = 'ACTIVE'
     WHERE t.status != 'DONE'
       AND t."dueDate" IS NOT NULL
       AND t."dueDate" BETWEEN now() AND now() + make_interval(hours => $1)
       AND NOT EXISTS (
         SELECT 1 FROM "WhatsappNotificationRecipient" r
         WHERE r."userId" = m.id
           AND 'DEADLINE_APPROACHING' = ANY(r."eventTypes")
           AND r."isActive" = false
       )
     ORDER BY m.id, t."dueDate" ASC`,
    [DEADLINE_ALERT_HOURS],
  );

  if (result.rowCount === 0) return;

  const byManager = new Map<string, { name: string; tasks: typeof result.rows }>();
  for (const row of result.rows) {
    if (!byManager.has(row.manager_phone)) {
      byManager.set(row.manager_phone, { name: row.manager_name, tasks: [] });
    }
    byManager.get(row.manager_phone)!.tasks.push(row);
  }

  log.info({ managers: byManager.size }, 'Deadline-approaching alerts');

  await Promise.allSettled(
    Array.from(byManager.entries()).map(async ([phone, { name, tasks }]) => {
      const lines = tasks.map((t) => {
        const due = new Date(t.due_date).toLocaleDateString('he-IL', DATE_FORMAT);
        return `• "${t.task_title}" (${t.owner_name}) — מועד: ${due}`;
      });
      const text =
        `שלום ${name}, תזכורת: ${tasks.length} משימות מתקרבות למועד ב-${DEADLINE_ALERT_HOURS} שעות הקרובות:\n\n` +
        lines.join('\n');
      await notify({
        to: phone,
        key: 'DEADLINE_APPROACHING',
        bodyParams: [name, String(tasks.length), String(DEADLINE_ALERT_HOURS)],
        fallbackText: text,
      });
    }),
  );
}
