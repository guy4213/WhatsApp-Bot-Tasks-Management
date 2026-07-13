import { pool } from '../../db/connection';
import { notify } from '../../whatsapp/templates';
import { templateName, DEFAULT_TEMPLATE_NAMES } from '../../whatsapp/templateNames';
import { moduleLogger } from '../../utils/logger';
import { getTaskDetailsForReminder } from '../../services/tasks';
import { setActiveTask } from '../../services/taskContext';
import {
  formatTaskReminderBody,
  reminderTemplateParams,
  buildCrmTaskUrl,
} from '../../services/taskDetailFormatter';

const log = moduleLogger('dueDateReminder');

// ── Task-details button payload (TASK_ENHANCED_DUE_REMINDER.md) ───────────────

/** Quick-reply payload id carried by the "פרטים נוספים" button. */
export function taskDetailsPayloadId(taskId: string): string {
  return `TASK_DETAILS_${taskId}`;
}

/**
 * Parse a `TASK_DETAILS_<taskId>` payload. `Task.id` is `text` (not a UUID), so
 * the id part is matched permissively. Exact-prefix match, so it never collides
 * with `PREREMIND_*` (preInspectionReminder) payloads.
 */
export function matchTaskDetailsPayload(raw: string): { taskId: string } | null {
  const m = raw.trim().match(/^TASK_DETAILS_([0-9a-zA-Z_-]{6,})$/);
  return m ? { taskId: m[1] } : null;
}

/**
 * Runs every 5 minutes.
 * Reminds the owner ~1 hour before a task's due time. The pick window is
 * OPEN LOWER-BOUND: any Task with `dueDate` in the future and within the next
 * 65 minutes qualifies. This covers two cases with a single query:
 *   1. The steady-state ~1h-ahead reminder (the historical intent).
 *   2. A "short-lead-time" Task created LESS THAN 65 min before its dueDate —
 *      previously invisible to the poll (the old `BETWEEN now+55 AND now+65`
 *      only matched tasks that entered the window 65 min ahead, so a task
 *      created 30 min before due never fired at all). Now it fires on the
 *      next 5-min tick, which is close enough to "one reminder before due"
 *      given the natural 5-minute grain.
 *
 * A task is still reminded AT MOST ONCE — `WhatsappReminderLog(taskId, kind='DUE_1H')`
 * is inserted AFTER a successful send, and the dedup SELECT prunes subsequent
 * ticks. A failed send leaves the log row absent so the next tick retries.
 *
 * The reminder body is enriched (customer/contact/description + a "פרטים נוספים"
 * quick-reply button + a URL button opening the task in the CRM):
 *  - in-window recipients always get the full freeform body (`fallbackText`) + button
 *    — the CRM URL is baked into the fallback text since freeform can't render buttons;
 *  - out-of-window recipients get the enriched `due_reminder_v2` template (9 body
 *    vars + URL button + quick-reply button) ONLY once an operator points
 *    WHATSAPP_TEMPLATE_DUE_REMINDER at it (after Meta approval). Until then, the
 *    still-approved `due_reminder` v1 template (2 vars: title, time; no button) is
 *    used for the template path, so out-of-window sends keep working today instead
 *    of being rejected by Meta for a param/component mismatch.
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
       AND t."dueDate" > now()
       AND t."dueDate" <= now() + interval '65 minutes'
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

      // Fetch the full detail row. If the task vanished (deleted / not found),
      // skip WITHOUT stamping so we don't send an empty reminder.
      const details = await getTaskDetailsForReminder(row.task_id);
      if (!details) {
        log.warn({ taskId: row.task_id }, 'Due-date reminder skipped — task detail not found');
        return;
      }

      const dueTime = new Date(row.due_date).toLocaleTimeString('he-IL', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jerusalem',
      });
      const crmUrl = buildCrmTaskUrl(row.task_id);
      const body = formatTaskReminderBody(details, crmUrl);
      const payloadId = taskDetailsPayloadId(row.task_id);

      // The still-approved `due_reminder` template (v1) is body-only: 2 vars
      // (title, time), no button. Until an operator explicitly points
      // WHATSAPP_TEMPLATE_DUE_REMINDER at the new `due_reminder_v2` (9 vars +
      // URL button + quick-reply button) once Meta approves it, the
      // OUT-OF-WINDOW template path must keep sending the legacy 2-var/no-button
      // shape — otherwise Meta rejects the send (param-count / component
      // mismatch) on every out-of-window reminder. The in-window freeform path
      // always gets the full enriched body regardless, since it never goes
      // through template validation.
      //
      // v2 button layout (Meta requires URL/PHONE buttons before QUICK_REPLY):
      //   index 0 → URL button (dynamic suffix = URL-encoded row.task_id, fills
      //             {{1}} in the approved URL template
      //             `https://crm.galit.co.il/dashboard?taskid={{1}}`). Encode so
      //             an id with `&`/`?`/`#` can't break the URL.
      //   index 1 → QUICK_REPLY button carrying the details-request payload
      const usingLegacyTemplate = templateName('DUE_REMINDER') === DEFAULT_TEMPLATE_NAMES.DUE_REMINDER;
      const bodyParams = usingLegacyTemplate
        ? [details.taskTitle, dueTime]
        : reminderTemplateParams(details);
      const templateButtonParams = usingLegacyTemplate
        ? undefined
        : [
            { subType: 'url' as const, index: 0, payload: encodeURIComponent(row.task_id) },
            { subType: 'quick_reply' as const, index: 1, payload: payloadId },
          ];

      try {
        await notify({
          to: row.owner_phone,
          key: 'DUE_REMINDER',
          bodyParams,
          fallbackText: body,
          buttons: [{ id: payloadId, title: 'פרטים נוספים' }],
          templateButtonParams,
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

      // Fire-and-forget: remember the task so text triggers "פרטים" work. A
      // failure here must never block or duplicate the reminder.
      try {
        setActiveTask(row.owner_phone, row.task_id, row.title);
      } catch (err) {
        log.error({ err, taskId: row.task_id }, 'setActiveTask failed after due-date reminder (non-fatal)');
      }
    }),
  );
}
