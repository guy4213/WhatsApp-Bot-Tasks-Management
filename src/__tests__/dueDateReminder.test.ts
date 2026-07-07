/**
 * dueDateReminder.ts tests.
 *
 * Two concerns:
 *  1. "mark before send" regression (D5-T20): the WhatsappReminderLog row is
 *     inserted only AFTER a successful send; a failed send is retried next tick.
 *  2. Enhanced reminder (TASK_ENHANCED_DUE_REMINDER.md): the body is
 *     `formatTaskReminderBody`, notify() carries the button + templateButtonParams,
 *     and setActiveTask fires after a successful send.
 *
 * `getTaskDetailsForReminder` and `setActiveTask` are mocked so the pool.query
 * queue stays [due-tasks SELECT, dedup check, INSERT] and the pure formatter
 * output can be asserted directly.
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

const getTaskDetailsForReminder = vi.fn();
vi.mock('../services/tasks', () => ({
  getTaskDetailsForReminder: (...a: unknown[]) => getTaskDetailsForReminder(...a),
}));

const setActiveTask = vi.fn();
vi.mock('../services/taskContext', () => ({
  setActiveTask: (...a: unknown[]) => setActiveTask(...a),
}));

import { runDueDateReminder } from '../scheduler/jobs/dueDateReminder';
import {
  type TaskDetailForReminder,
  formatTaskReminderBody,
  reminderTemplateParams,
} from '../services/taskDetailFormatter';

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
    due_date: new Date('2026-07-06T11:00:00Z').toISOString(),
    ...overrides,
  };
}

function makeDetails(overrides: Partial<TaskDetailForReminder> = {}): TaskDetailForReminder {
  return {
    taskId: 't-1',
    taskTitle: 'תיקון מזגן',
    customerName: 'משה כהן',
    customerPhone: '03-1234567',
    contactName: 'דנה',
    contactPhone: '050-1112222',
    dueDate: new Date('2026-07-06T11:00:00Z'),
    assignedTo: 'דני',
    description: 'תיאור',
    processNotes: 'הערה',
    address: 'הרצל 10',
    city: 'תל אביב',
    status: 'OPEN',
    ...overrides,
  };
}

beforeEach(() => {
  poolQuery.mockReset();
  notify.mockReset();
  notify.mockResolvedValue(undefined);
  getTaskDetailsForReminder.mockReset();
  getTaskDetailsForReminder.mockResolvedValue(makeDetails());
  setActiveTask.mockReset();
  delete process.env.CRM_TASK_URL_TEMPLATE;
  delete process.env.WHATSAPP_TEMPLATE_DUE_REMINDER;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('runDueDateReminder — mark-before-send regression (D5-T20)', () => {
  it('short-circuits when no tasks are due', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await runDueDateReminder();
    expect(notify).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('checks dedup, sends, then records as reminded (success path)', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] }) // due-tasks SELECT
      .mockResolvedValueOnce(NOT_REMINDED)                       // dedup check
      .mockResolvedValueOnce(INSERTED);                          // INSERT after send

    await runDueDateReminder();

    expect(notify).toHaveBeenCalledTimes(1);
    const checkCall = poolQuery.mock.calls[1];
    expect(checkCall[0]).toMatch(/SELECT 1 FROM "WhatsappReminderLog"/);
    const insertCall = poolQuery.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO "WhatsappReminderLog"/);
    expect(insertCall[1]).toEqual(['t-1']);
  });

  it('skips the send when already reminded (dedup)', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] })
      .mockResolvedValueOnce(ALREADY_REMINDED);
    await runDueDateReminder();
    expect(notify).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });

  it('does NOT record as reminded when the WhatsApp send fails (retry next tick)', async () => {
    notify.mockRejectedValueOnce(new Error('WhatsApp API error'));
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] })
      .mockResolvedValueOnce(NOT_REMINDED);
    await runDueDateReminder();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(poolQuery).toHaveBeenCalledTimes(2); // no INSERT after a failed send
    expect(setActiveTask).not.toHaveBeenCalled();
  });

  it('continues the batch when one task fails and another succeeds', async () => {
    const rowA = makeRow({ task_id: 't-a' });
    const rowB = makeRow({ task_id: 't-b', owner_phone: '972502222222' });
    getTaskDetailsForReminder
      .mockResolvedValueOnce(makeDetails({ taskId: 't-a' }))
      .mockResolvedValueOnce(makeDetails({ taskId: 't-b' }));
    notify.mockRejectedValueOnce(new Error('A failed')).mockResolvedValueOnce(undefined);
    poolQuery
      .mockResolvedValueOnce({ rowCount: 2, rows: [rowA, rowB] }) // SELECT
      .mockResolvedValueOnce(NOT_REMINDED) // dedup A
      .mockResolvedValueOnce(NOT_REMINDED) // dedup B
      .mockResolvedValueOnce(INSERTED);    // INSERT B (A failed → no insert)
    await runDueDateReminder();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe('runDueDateReminder — enhanced reminder body + button + context', () => {
  it('always sends the full enriched fallbackText + buttons (freeform/in-window path is unconditional)', async () => {
    const details = makeDetails();
    getTaskDetailsForReminder.mockResolvedValue(details);
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] })
      .mockResolvedValueOnce(NOT_REMINDED)
      .mockResolvedValueOnce(INSERTED);

    await runDueDateReminder();

    expect(getTaskDetailsForReminder).toHaveBeenCalledWith('t-1');
    const call = notify.mock.calls[0][0];
    expect(call.to).toBe('972501111111');
    expect(call.key).toBe('DUE_REMINDER');
    expect(call.fallbackText).toBe(formatTaskReminderBody(details, null));
    expect(call.buttons).toEqual([{ id: 'TASK_DETAILS_t-1', title: 'פרטים נוספים' }]);
  });

  it('REGRESSION: without WHATSAPP_TEMPLATE_DUE_REMINDER override, uses the legacy 2-var/no-button template contract (the still-approved v1 template cannot accept 10 vars + a button)', async () => {
    const details = makeDetails();
    getTaskDetailsForReminder.mockResolvedValue(details);
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] })
      .mockResolvedValueOnce(NOT_REMINDED)
      .mockResolvedValueOnce(INSERTED);

    await runDueDateReminder();

    const call = notify.mock.calls[0][0];
    expect(call.bodyParams).toEqual([details.taskTitle, expect.any(String)]);
    expect(call.bodyParams).toHaveLength(2);
    expect(call.templateButtonParams).toBeUndefined();
  });

  it('once WHATSAPP_TEMPLATE_DUE_REMINDER=due_reminder_v2 is configured, sends the enriched 10-var bodyParams + templateButtonParams', async () => {
    process.env.WHATSAPP_TEMPLATE_DUE_REMINDER = 'due_reminder_v2';
    const details = makeDetails();
    getTaskDetailsForReminder.mockResolvedValue(details);
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] })
      .mockResolvedValueOnce(NOT_REMINDED)
      .mockResolvedValueOnce(INSERTED);

    await runDueDateReminder();

    expect(notify).toHaveBeenCalledWith({
      to: '972501111111',
      key: 'DUE_REMINDER',
      bodyParams: reminderTemplateParams(details, null),
      fallbackText: formatTaskReminderBody(details, null),
      buttons: [{ id: 'TASK_DETAILS_t-1', title: 'פרטים נוספים' }],
      templateButtonParams: [{ subType: 'quick_reply', index: 0, payload: 'TASK_DETAILS_t-1' }],
    });
  });

  it('calls setActiveTask(phone, taskId, title) after a successful send', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] })
      .mockResolvedValueOnce(NOT_REMINDED)
      .mockResolvedValueOnce(INSERTED);

    await runDueDateReminder();

    expect(setActiveTask).toHaveBeenCalledWith('972501111111', 't-1', 'תיקון מזגן');
  });

  it('skips the row (no send, no INSERT) when task details are not found', async () => {
    getTaskDetailsForReminder.mockResolvedValue(null);
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] }) // SELECT
      .mockResolvedValueOnce(NOT_REMINDED);                      // dedup check

    await runDueDateReminder();

    expect(notify).not.toHaveBeenCalled();
    expect(setActiveTask).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledTimes(2); // no INSERT
  });

  it('a setActiveTask failure does not throw or block the reminder', async () => {
    setActiveTask.mockImplementation(() => { throw new Error('ctx store down'); });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] })
      .mockResolvedValueOnce(NOT_REMINDED)
      .mockResolvedValueOnce(INSERTED);

    await expect(runDueDateReminder()).resolves.not.toThrow();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
