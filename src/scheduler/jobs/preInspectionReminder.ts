/**
 * D2-T15 — Scheduler job: 60-minute pre-inspection reminder.
 *
 * Polls every 2 minutes (same cadence as the assignment card notifier and
 * lead assignment notifier). Finds `TaskField` rows where `preReminderSentAt
 * IS NULL` and `scheduledStartAt` falls within the next 60 minutes, then
 * sends the reminder card and stamps `preReminderSentAt`.
 *
 * Advisory lock id 1011 (`preInspectionReminder`) prevents concurrent runs
 * across instances — see `src/scheduler/index.ts`.
 */
import { runPreInspectionReminderPoll } from '../../services/preInspectionReminder';

export async function runPreInspectionReminderJob(): Promise<void> {
  await runPreInspectionReminderPoll();
}
