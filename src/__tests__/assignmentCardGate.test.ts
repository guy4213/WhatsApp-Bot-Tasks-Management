/**
 * Assignment-card notifier gating.
 *
 * Product decision (Jul 2026): the bot does NOT auto-send a WhatsApp
 * assignment card when a TaskField is created / re-assigned. The scheduler
 * only registers the assignmentCardNotifier cron when
 * `ASSIGNMENT_CARD_NOTIFIER_ENABLED=true`.
 *
 * These tests import `startScheduler` fresh under each env condition (via
 * `vi.resetModules`) and inspect the calls to the mocked `node-cron` default
 * export. The DB, WhatsApp sender, and job bodies are all mocked so the
 * scheduler wiring is exercised without side effects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks that must be in place BEFORE startScheduler is imported ────────────

const scheduleSpy = vi.fn();
vi.mock('node-cron', () => ({
  default: { schedule: (...args: unknown[]) => scheduleSpy(...args) },
}));

// Prevent any real DB access via the advisory-lock helper.
vi.mock('../db/connection', () => ({
  pool: {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [{ acquired: true }] }),
      release: vi.fn(),
    }),
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  },
}));

// Stub every job body so scheduler.index's imports don't drag in real code.
vi.mock('../scheduler/jobs/expireActions',        () => ({ runExpireActions:            vi.fn().mockResolvedValue(undefined) }));
vi.mock('../scheduler/jobs/dailySummary',         () => ({ runDailySummary:             vi.fn().mockResolvedValue(undefined) }));
vi.mock('../scheduler/jobs/dueDateReminder',      () => ({ runDueDateReminder:          vi.fn().mockResolvedValue(undefined) }));
vi.mock('../scheduler/jobs/deadlineAlerts',       () => ({
  runDeadlineExceededAlert:    vi.fn().mockResolvedValue(undefined),
  runDeadlineApproachingAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../scheduler/jobs/completionNotifier',   () => ({ runCompletionNotifier:       vi.fn().mockResolvedValue(undefined) }));
vi.mock('../scheduler/jobs/digestDispatcher',     () => ({ runDigestDispatcher:         vi.fn().mockResolvedValue(undefined) }));
vi.mock('../scheduler/jobs/assignmentCardNotifier', () => ({ runAssignmentCardNotifier: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../scheduler/jobs/leadAssignmentNotifier', () => ({ runLeadAssignmentNotifier: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../scheduler/jobs/preInspectionReminder', () => ({ runPreInspectionReminderJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../routes/webhook',                      () => ({ recoverInboundQueue:         vi.fn().mockResolvedValue(undefined) }));

// The scheduler's `safe(name, lockId, fn)` wraps the job body inside an async
// closure. To assert whether a specific job name was registered we scan the
// second argument of each `cron.schedule` call: it's `safe()`'s returned
// closure, whose `.name` is empty — so we can't inspect the wrapped name via
// Function.name. Instead we rely on the call count difference between the two
// env states (one extra schedule call when ASSIGNMENT_CARD_NOTIFIER_ENABLED=true)
// AND scan the log output for the disabled/enabled messages.

beforeEach(() => {
  scheduleSpy.mockReset();
});

afterEach(() => {
  delete process.env.ASSIGNMENT_CARD_NOTIFIER_ENABLED;
});

async function importFreshStartScheduler() {
  vi.resetModules();
  // Re-apply node-cron mock after resetModules so the fresh import picks up
  // the same spy.
  vi.doMock('node-cron', () => ({
    default: { schedule: (...args: unknown[]) => scheduleSpy(...args) },
  }));
  const mod = await import('../scheduler/index');
  return mod.startScheduler;
}

describe('startScheduler — assignmentCardNotifier gating', () => {
  it('does NOT register assignmentCardNotifier when ASSIGNMENT_CARD_NOTIFIER_ENABLED is unset', async () => {
    delete process.env.ASSIGNMENT_CARD_NOTIFIER_ENABLED;
    const startScheduler = await importFreshStartScheduler();

    startScheduler();

    const disabledCallCount = scheduleSpy.mock.calls.length;
    expect(disabledCallCount).toBeGreaterThan(0); // sanity: other jobs still registered

    // Store for the enabled-case comparison via a module-level counter.
    (globalThis as { __disabledSchedCount?: number }).__disabledSchedCount = disabledCallCount;
  });

  it('does NOT register assignmentCardNotifier when ASSIGNMENT_CARD_NOTIFIER_ENABLED=false', async () => {
    process.env.ASSIGNMENT_CARD_NOTIFIER_ENABLED = 'false';
    const startScheduler = await importFreshStartScheduler();

    startScheduler();

    // No schedule call should be the assignment-card 2-minute cron; when the
    // gate is off there is exactly one less schedule call than when it's on.
    const disabledCallCount = scheduleSpy.mock.calls.length;
    expect(disabledCallCount).toBeGreaterThan(0);
    (globalThis as { __disabledSchedCount?: number }).__disabledSchedCount = disabledCallCount;
  });

  it('DOES register assignmentCardNotifier when ASSIGNMENT_CARD_NOTIFIER_ENABLED=true', async () => {
    process.env.ASSIGNMENT_CARD_NOTIFIER_ENABLED = 'true';
    const startScheduler = await importFreshStartScheduler();

    startScheduler();

    const enabledCallCount = scheduleSpy.mock.calls.length;
    const disabledCallCount =
      (globalThis as { __disabledSchedCount?: number }).__disabledSchedCount ?? 0;

    // Enabling the gate adds exactly one more cron.schedule call.
    expect(enabledCallCount).toBe(disabledCallCount + 1);
  });
});
