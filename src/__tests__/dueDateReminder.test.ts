/**
 * dueDateReminder.ts — "mark before send" regression coverage.
 *
 * Verifies the send → mark-only-on-success ordering: a WhatsApp send failure
 * must NOT insert the WhatsappReminderLog row (so the next tick can retry),
 * and a successful send must insert it (so the next tick skips it).
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

import { runDueDateReminder } from '../scheduler/jobs/dueDateReminder';

const EMPTY = { rowCount: 0, rows: [] };
const NOT_REMINDED = { rowCount: 0, rows: [] };
const ALREADY_REMINDED = { rowCount: 1, rows: [{ taskId: 't-1' }] };
const INSERTED = { rowCount: 1, rows: [] };

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    task_id: 't-1',
    owner_name: 'דני',
    owner_phone: '972501111111',
    title: 'תיקון מזגן',
    due_date: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('runDueDateReminder', () => {
  it('short-circuits when no tasks are due', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY); // due-tasks SELECT
    await runDueDateReminder();
    expect(notify).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('checks dedup, sends, then records as reminded (success path)', async () => {
    const row = makeRow();
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // due-tasks SELECT
      .mockResolvedValueOnce(NOT_REMINDED)                 // dedup check → not reminded
      .mockResolvedValueOnce(INSERTED);                    // INSERT after successful send

    await runDueDateReminder();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ to: '972501111111', key: 'DUE_REMINDER' }),
    );
    // Dedup check ran BEFORE the send; INSERT ran AFTER.
    const checkCall = poolQuery.mock.calls[1];
    expect(checkCall[0]).toMatch(/SELECT 1 FROM "WhatsappReminderLog"/);
    const insertCall = poolQuery.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO "WhatsappReminderLog"/);
    expect(insertCall[1]).toEqual(['t-1']);
  });

  it('skips the send when already reminded (dedup)', async () => {
    const row = makeRow();
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // due-tasks SELECT
      .mockResolvedValueOnce(ALREADY_REMINDED);            // dedup check → already reminded

    await runDueDateReminder();

    expect(notify).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledTimes(2); // no INSERT attempted
  });

  it('does NOT record as reminded when the WhatsApp send fails (retry next tick)', async () => {
    const row = makeRow();
    notify.mockRejectedValueOnce(new Error('WhatsApp API error'));
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // due-tasks SELECT
      .mockResolvedValueOnce(NOT_REMINDED);                // dedup check → not reminded

    await runDueDateReminder();

    expect(notify).toHaveBeenCalledTimes(1);
    // No third pool.query call — the failed send never reached the INSERT.
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });

  it('a failed send followed by a successful retry eventually records as reminded', async () => {
    const row = makeRow();

    // First tick: send fails.
    notify.mockRejectedValueOnce(new Error('transient error'));
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] })
      .mockResolvedValueOnce(NOT_REMINDED);
    await runDueDateReminder();
    expect(poolQuery).toHaveBeenCalledTimes(2); // no INSERT after the failure

    // Second tick (retry): send succeeds.
    poolQuery.mockReset();
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] })
      .mockResolvedValueOnce(NOT_REMINDED)
      .mockResolvedValueOnce(INSERTED);
    await runDueDateReminder();

    expect(notify).toHaveBeenCalledTimes(2);
    const insertCall = poolQuery.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO "WhatsappReminderLog"/);
  });

  it('continues the batch when one task fails and another succeeds', async () => {
    const rowA = makeRow({ task_id: 't-a', owner_phone: '972501111111' });
    const rowB = makeRow({ task_id: 't-b', owner_phone: '972502222222' });
    notify
      .mockRejectedValueOnce(new Error('A failed'))
      .mockResolvedValueOnce(undefined);
    poolQuery
      .mockResolvedValueOnce({ rowCount: 2, rows: [rowA, rowB] }) // due-tasks SELECT
      .mockResolvedValueOnce(NOT_REMINDED) // dedup check A
      .mockResolvedValueOnce(NOT_REMINDED) // dedup check B
      .mockResolvedValueOnce(INSERTED);    // INSERT for B (A's send failed, no INSERT for A)

    await runDueDateReminder();

    expect(notify).toHaveBeenCalledTimes(2);
  });
});
