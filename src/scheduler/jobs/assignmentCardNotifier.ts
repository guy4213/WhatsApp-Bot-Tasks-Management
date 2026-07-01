/**
 * D5-T6 — polling job: detect unsent `TaskField` assignment cards and send them.
 *
 * The bot doesn't own the CRM field scheduling form; instead it polls for
 * `TaskField` rows created with `workerNotifiedAt IS NULL`, sends the §6 card,
 * and stamps `workerNotifiedAt`. Concurrency is guarded by the scheduler's
 * advisory lock (see `src/scheduler/index.ts`) so a per-row claim isn't needed.
 *
 * Send + stamp for one row is implemented in
 * `src/services/inspectionAssignment.ts sendAndStampAssignmentCard`; the batch
 * loop is `runInspectionAssignmentPoll`. This job is a thin wrapper so the
 * scheduler registration in `index.ts` stays consistent with the other jobs.
 */
import { runInspectionAssignmentPoll } from '../../services/inspectionAssignment';

export async function runAssignmentCardNotifier(): Promise<void> {
  await runInspectionAssignmentPoll();
}
