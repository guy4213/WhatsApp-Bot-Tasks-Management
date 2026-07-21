/**
 * AI-native agent tool registry tests.
 *
 * Coverage:
 *  - toolsForUser / findToolForUser permission gates
 *  - the "forbidden CRM writes" invariant (§6.6): no tool writes Task.status,
 *    prices, or creates customers/tasks — verified by the tool-name allowlist
 *  - set_field_status: ownership gate blocks a not-owned inspection; resolves a
 *    customer hint; advances via the service on the happy path
 *  - calendar_delete_event is marked destructive
 *  - list_my_inspections pulls from the DB service and formats rows
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedUser } from '../types';

// ── Service mocks ─────────────────────────────────────────────────────────────
const getInspectionsForWorkerOnDate = vi.fn();
vi.mock('../services/inspectionsQueries', () => ({
  getInspectionsForWorkerOnDate: (...a: unknown[]) => getInspectionsForWorkerOnDate(...a),
}));

const advanceFieldStatus = vi.fn();
const resolveOpenTaskFieldByHint = vi.fn();
const validateWorkerTaskField = vi.fn();
const writeProblem = vi.fn();
const writeMissingInfo = vi.fn();
vi.mock('../services/inspections', () => ({
  advanceFieldStatus: (...a: unknown[]) => advanceFieldStatus(...a),
  resolveOpenTaskFieldByHint: (...a: unknown[]) => resolveOpenTaskFieldByHint(...a),
  validateWorkerTaskField: (...a: unknown[]) => validateWorkerTaskField(...a),
  writeProblem: (...a: unknown[]) => writeProblem(...a),
  writeMissingInfo: (...a: unknown[]) => writeMissingInfo(...a),
}));

const listTasks = vi.fn();
const getTaskById = vi.fn();
vi.mock('../services/tasks', () => ({
  listTasks: (...a: unknown[]) => listTasks(...a),
  getTaskById: (...a: unknown[]) => getTaskById(...a),
}));

const listEventsAsUser = vi.fn();
const createEventAsUser = vi.fn();
const updateEventAsUser = vi.fn();
const deleteEventAsUser = vi.fn();
vi.mock('../services/graphCalendar', () => ({
  listEventsAsUser: (...a: unknown[]) => listEventsAsUser(...a),
  createEventAsUser: (...a: unknown[]) => createEventAsUser(...a),
  updateEventAsUser: (...a: unknown[]) => updateEventAsUser(...a),
  deleteEventAsUser: (...a: unknown[]) => deleteEventAsUser(...a),
}));

import {
  toolsForUser,
  findToolForUser,
  __allToolsForTest,
} from '../ai/agent/tools';

function worker(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u-worker',
    name: 'דני',
    phone: '972500000001',
    role: 'TECHNICIAN',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

function manager(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return worker({ id: 'u-mgr', name: 'מנהל', role: 'MANAGER', isElevated: true, canViewAllRecords: true, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('tool registry — permission gates & invariants', () => {
  it('exposes the read/status/calendar tools to a worker', () => {
    const names = toolsForUser(worker()).map((t) => t.name);
    expect(names).toContain('list_my_inspections');
    expect(names).toContain('set_field_status');
    expect(names).toContain('calendar_list_events');
  });

  it('NEVER exposes a tool that writes Task.status / prices / creates customers (§6.6)', () => {
    const names = __allToolsForTest.map((t) => t.name);
    // Forbidden write surfaces must simply not exist as tools.
    for (const forbidden of [
      'set_task_status',
      'update_task_status',
      'set_price',
      'update_price',
      'create_customer',
      'create_task',
      'delete_task',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('findToolForUser returns null for an unknown tool', () => {
    expect(findToolForUser(worker(), 'no_such_tool')).toBeNull();
  });

  it('marks calendar_delete_event as destructive and nothing else', () => {
    const destructive = __allToolsForTest.filter((t) => t.destructive).map((t) => t.name);
    expect(destructive).toEqual(['calendar_delete_event']);
  });
});

describe('list_my_inspections', () => {
  it('pulls rows from the DB service and formats them', async () => {
    getInspectionsForWorkerOnDate.mockResolvedValueOnce([
      {
        taskFieldId: 'tf-1',
        customerName: 'כהן',
        siteAddress: 'הרצל 5',
        siteCity: 'רעננה',
        fieldStatus: 'ASSIGNED',
        family: 'RADON',
        typeLabelHe: 'בדיקת ראדון',
      },
    ]);
    const tool = findToolForUser(worker(), 'list_my_inspections')!;
    const out = await tool.handler(worker(), {});
    expect(getInspectionsForWorkerOnDate).toHaveBeenCalledOnce();
    expect(out).toContain('כהן');
    expect(out).toContain('הרצל 5');
    expect(out).toContain('tf-1');
  });

  it('returns a friendly empty-state string when there are no inspections', async () => {
    getInspectionsForWorkerOnDate.mockResolvedValueOnce([]);
    const tool = findToolForUser(worker(), 'list_my_inspections')!;
    const out = await tool.handler(worker(), { dateScope: 'today' });
    expect(out).toContain('אין בדיקות');
  });
});

describe('set_field_status', () => {
  it('blocks a status write on an inspection the user does not own', async () => {
    validateWorkerTaskField.mockResolvedValueOnce({ ok: false, reason: 'not_owner' });
    const tool = findToolForUser(worker(), 'set_field_status')!;
    const out = await tool.handler(worker(), { transition: 'ARRIVED', taskFieldId: 'tf-x' });
    expect(advanceFieldStatus).not.toHaveBeenCalled();
    expect(out).toContain('אינה משויכת אליך');
  });

  it('resolves a customer hint then advances the status', async () => {
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ taskFieldId: 'tf-2', customerName: 'לוי', taskTitle: null });
    validateWorkerTaskField.mockResolvedValueOnce({ ok: true, customerName: 'לוי', taskTitle: null, fieldStatus: 'CONFIRMED' });
    const tool = findToolForUser(worker(), 'set_field_status')!;
    const out = await tool.handler(worker(), { transition: 'DEPARTED', customerHint: 'לוי' });
    expect(resolveOpenTaskFieldByHint).toHaveBeenCalledWith('u-worker', 'לוי');
    expect(advanceFieldStatus).toHaveBeenCalledWith({ taskFieldId: 'tf-2', transition: 'DEPARTED', updatedBy: 'u-worker' });
    expect(out).toContain('יצאת לדרך');
  });

  it('asks for specifics when the hint is ambiguous', async () => {
    resolveOpenTaskFieldByHint.mockResolvedValueOnce({ ambiguous: true, count: 3 });
    const tool = findToolForUser(worker(), 'set_field_status')!;
    const out = await tool.handler(worker(), { transition: 'ARRIVED', customerHint: 'א' });
    expect(advanceFieldStatus).not.toHaveBeenCalled();
    expect(out).toContain('3');
  });
});

describe('list_tasks scope gating', () => {
  it('downgrades scope=all to own for a non-manager', async () => {
    listTasks.mockResolvedValueOnce({ tasks: [], truncated: false });
    const tool = findToolForUser(worker(), 'list_tasks')!;
    await tool.handler(worker(), { scope: 'all', filter: 'open' });
    const call = listTasks.mock.calls[0][1];
    expect(call.scope).toBe('own');
  });

  it('honors scope=all for a manager', async () => {
    listTasks.mockResolvedValueOnce({ tasks: [], truncated: false });
    const tool = findToolForUser(manager(), 'list_tasks')!;
    await tool.handler(manager(), { scope: 'all', filter: 'open' });
    const call = listTasks.mock.calls[0][1];
    expect(call.scope).toBe('all');
  });
});

describe('calendar tools', () => {
  it('calendar_delete_event calls the delete service with the event id', async () => {
    deleteEventAsUser.mockResolvedValueOnce(undefined);
    const tool = findToolForUser(worker(), 'calendar_delete_event')!;
    const out = await tool.handler(worker(), { eventId: 'evt-9' });
    expect(deleteEventAsUser).toHaveBeenCalledWith('u-worker', 'evt-9');
    expect(out).toContain('נמחק');
  });

  it('calendar_create_event forwards subject + times to the service', async () => {
    createEventAsUser.mockResolvedValueOnce({
      id: 'evt-new',
      subject: 'פגישה',
      start: { dateTime: '2026-07-22T10:00:00', timeZone: 'Asia/Jerusalem' },
      isAllDay: false,
      location: null,
    });
    const tool = findToolForUser(worker(), 'calendar_create_event')!;
    const out = await tool.handler(worker(), {
      subject: 'פגישה',
      startDateTime: '2026-07-22T10:00:00',
      endDateTime: '2026-07-22T11:00:00',
    });
    expect(createEventAsUser).toHaveBeenCalledOnce();
    // Tool input uses startDateTime/endDateTime; the canonical service takes
    // startIso/endIso — assert the mapping so it can't silently regress.
    const [, createInput] = createEventAsUser.mock.calls[0];
    expect(createInput).toMatchObject({
      subject: 'פגישה',
      startIso: '2026-07-22T10:00:00',
      endIso: '2026-07-22T11:00:00',
    });
    expect(out).toContain('נוצר');
    expect(out).toContain('פגישה');
  });
});
