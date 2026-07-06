/**
 * deadlineAlerts.ts — runDeadlineExceededAlert "mark before send" regression
 * coverage.
 *
 * Each overdue task is marked alerted (WhatsappReminderLog, kind
 * 'DEADLINE_EXCEEDED') ONLY after at least one manager actually receives the
 * WhatsApp message — never before. If every manager send fails, no task is
 * marked, so the whole batch retries on the next tick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

const notify = vi.fn();
vi.mock('../whatsapp/templates', () => ({
  notify: (...args: unknown[]) => notify(...args),
}));

beforeEach(() => {
  poolQuery.mockReset();
  notify.mockReset();
  notify.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

import { runDeadlineExceededAlert } from '../scheduler/jobs/deadlineAlerts';

const EMPTY = { rowCount: 0, rows: [] };
const INSERTED = { rowCount: 1, rows: [] };

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    task_id: 't-1',
    task_title: 'בדיקת מעלית',
    owner_name: 'דני',
    overdue_since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeManager(overrides: Record<string, unknown> = {}) {
  return { phone: '972509999999', name: 'מנהל', ...overrides };
}

describe('runDeadlineExceededAlert', () => {
  it('short-circuits when there are no overdue tasks', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY); // overdue-tasks SELECT
    await runDeadlineExceededAlert();
    expect(notify).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('short-circuits when there are no active managers', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeTask()] }) // overdue-tasks SELECT
      .mockResolvedValueOnce(EMPTY);                              // managers SELECT
    await runDeadlineExceededAlert();
    expect(notify).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });

  it('sends to every manager, then marks the task as alerted (success path)', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeTask()] })      // overdue-tasks SELECT
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeManager()] })   // managers SELECT
      .mockResolvedValueOnce(INSERTED);                                // INSERT after successful send

    await runDeadlineExceededAlert();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ to: '972509999999', key: 'DEADLINE_EXCEEDED' }),
    );
    const insertCall = poolQuery.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO "WhatsappReminderLog"/);
    expect(insertCall[1]).toEqual(['t-1']);
  });

  it('does NOT mark the task as alerted when every manager send fails (retry next tick)', async () => {
    notify.mockRejectedValue(new Error('WhatsApp API error'));
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeTask()] })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [makeManager({ phone: '972501111111' }), makeManager({ phone: '972502222222' })],
      });

    await runDeadlineExceededAlert();

    expect(notify).toHaveBeenCalledTimes(2);
    // No third pool.query call — no INSERT after every send failed.
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });

  it('marks the task as alerted when at least ONE manager receives it (partial delivery)', async () => {
    notify
      .mockRejectedValueOnce(new Error('manager A unreachable'))
      .mockResolvedValueOnce(undefined);
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeTask()] })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [makeManager({ phone: '972501111111' }), makeManager({ phone: '972502222222' })],
      })
      .mockResolvedValueOnce(INSERTED);

    await runDeadlineExceededAlert();

    expect(notify).toHaveBeenCalledTimes(2);
    const insertCall = poolQuery.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO "WhatsappReminderLog"/);
  });

  it('a fully-failed batch followed by a successful retry eventually marks the task as alerted', async () => {
    const task = makeTask();

    // First tick: every manager send fails.
    notify.mockRejectedValueOnce(new Error('transient'));
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [task] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeManager()] });
    await runDeadlineExceededAlert();
    expect(poolQuery).toHaveBeenCalledTimes(2); // no INSERT

    // Second tick (retry): the task is still selected (never marked), send succeeds.
    poolQuery.mockReset();
    notify.mockReset();
    notify.mockResolvedValue(undefined);
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [task] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeManager()] })
      .mockResolvedValueOnce(INSERTED);
    await runDeadlineExceededAlert();

    const insertCall = poolQuery.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO "WhatsappReminderLog"/);
  });

  it('sends one combined message per manager listing all fresh overdue tasks', async () => {
    const taskA = makeTask({ task_id: 't-a', task_title: 'בדיקה א' });
    const taskB = makeTask({ task_id: 't-b', task_title: 'בדיקה ב' });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 2, rows: [taskA, taskB] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeManager()] })
      .mockResolvedValueOnce(INSERTED) // taskA
      .mockResolvedValueOnce(INSERTED); // taskB

    await runDeadlineExceededAlert();

    expect(notify).toHaveBeenCalledTimes(1); // one message per manager, not per task
    const call = notify.mock.calls[0][0];
    expect(call.fallbackText).toContain('בדיקה א');
    expect(call.fallbackText).toContain('בדיקה ב');
    // Both tasks get their own INSERT after the shared successful send.
    expect(poolQuery).toHaveBeenCalledTimes(4);
  });
});
