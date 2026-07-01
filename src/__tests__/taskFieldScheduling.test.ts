/**
 * D2-T11 — service-layer tests for taskFieldScheduling.ts
 *
 * Coverage:
 *  - findOpenTasksForOwner: query shape (JOIN, WHERE ownerId, status filter, LIMIT)
 *  - findOpenTasksForAdmin: query shape (JOIN, no ownerId filter, LIMIT)
 *  - findCustomersByName: ILIKE pattern, open_task_count aggregation, empty input → []
 *  - findOpenTasksForCustomer: query shape (WHERE customerId, status filter)
 *  - scheduleTaskField: BEGIN/COMMIT wrapping, INSERT params (13 positional),
 *    workerNotifiedAt absent (i.e. not included in INSERT), ROLLBACK on failure,
 *    client.release() always called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockConnect = vi.fn();
vi.mock('../db/connection', () => ({
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: (...args: unknown[]) => mockConnect(...args),
  },
}));

vi.mock('../utils/logger', () => ({
  moduleLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Client mock builder ────────────────────────────────────────────────────────

function makeClient(queryResponses: Array<{ rows: unknown[]; rowCount: number }>) {
  let callIdx = 0;
  const clientQuery = vi.fn((..._args: unknown[]) => {
    const resp = queryResponses[callIdx] ?? { rows: [], rowCount: 0 };
    callIdx++;
    return Promise.resolve(resp);
  });
  return {
    query: clientQuery,
    release: vi.fn(),
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  mockQuery.mockReset();
  mockConnect.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  findOpenTasksForOwner,
  findOpenTasksForAdmin,
  findCustomersByName,
  findOpenTasksForCustomer,
  scheduleTaskField,
} from '../services/taskFieldScheduling';

// ─────────────────────────────────────────────────────────────────────────────
// findOpenTasksForOwner
// ─────────────────────────────────────────────────────────────────────────────

describe('findOpenTasksForOwner', () => {
  it('queries with ownerId and filters DONE/CANCELED status, maps rows correctly', async () => {
    const fakeRow = {
      id: 'task-1',
      title: 'בדיקה 1',
      productName: 'RADON',
      customerId: 'cust-1',
      customerName: 'כהן בע"מ',
      inspectionLabelHe: 'ראדון',
      inspectionFamily: 'RADON',
      inspectionTypeId: 'it-1',
      ownerId: 'u-1',
      siteAddress: 'הרצל 1',
      siteCity: 'תל אביב',
      fieldContactName: 'ישראל',
      fieldContactPhone: '0501111111',
      navigationUrl: 'https://waze.com/xyz',
    };
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow], rowCount: 1 });

    const result = await findOpenTasksForOwner('u-1', 5);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];

    // SQL must filter by ownerId.
    expect(sql).toContain('"ownerId" = $1');
    // Must exclude DONE and CANCELED.
    expect(sql).toContain("'DONE'");
    expect(sql).toContain("'CANCELED'");
    // Must join Customer and InspectionType.
    expect(sql).toContain('"Customer"');
    expect(sql).toContain('"InspectionType"');
    // Params: ownerId, limit.
    expect(params[0]).toBe('u-1');
    expect(params[1]).toBe(5);

    // Mapped output.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'task-1',
      title: 'בדיקה 1',
      customerName: 'כהן בע"מ',
      inspectionLabelHe: 'ראדון',
      inspectionTypeId: 'it-1',
      ownerId: 'u-1',
      siteAddress: 'הרצל 1',
      siteCity: 'תל אביב',
    });
  });

  it('returns [] when pool.query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB down'));
    const result = await findOpenTasksForOwner('u-1');
    expect(result).toEqual([]);
  });

  it('uses default limit 10 when not specified', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await findOpenTasksForOwner('u-2');
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findOpenTasksForAdmin
// ─────────────────────────────────────────────────────────────────────────────

describe('findOpenTasksForAdmin', () => {
  it('queries without ownerId filter, joins Customer + InspectionType, applies LIMIT', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await findOpenTasksForAdmin(7);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];

    // Must NOT filter by ownerId.
    expect(sql).not.toContain('"ownerId" = ');
    // Must exclude DONE/CANCELED.
    expect(sql).toContain("'DONE'");
    expect(sql).toContain("'CANCELED'");
    // Joins.
    expect(sql).toContain('"Customer"');
    expect(sql).toContain('"InspectionType"');
    // Only one param: the limit.
    expect(params).toHaveLength(1);
    expect(params[0]).toBe(7);
  });

  it('returns [] on DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('timeout'));
    const result = await findOpenTasksForAdmin();
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findCustomersByName
// ─────────────────────────────────────────────────────────────────────────────

describe('findCustomersByName', () => {
  it('returns [] immediately for blank query', async () => {
    const result = await findCustomersByName('   ');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('uses ILIKE with surrounding wildcards, aggregates open_task_count', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'c-1', name: 'כהן', open_task_count: '3' },
        { id: 'c-2', name: 'כהנמן', open_task_count: '0' },
      ],
      rowCount: 2,
    });

    const result = await findCustomersByName('כהן', 10);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];

    // ILIKE pattern.
    expect(sql.toLowerCase()).toContain('ilike');
    // The query param is the trimmed search term (wildcards in SQL).
    expect(params[0]).toBe('כהן');
    expect(params[1]).toBe(10);

    // open_task_count must be parsed as integer.
    expect(result[0]).toMatchObject({ id: 'c-1', name: 'כהן', openTaskCount: 3 });
    expect(result[1]).toMatchObject({ id: 'c-2', name: 'כהנמן', openTaskCount: 0 });
  });

  it('returns [] on DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));
    const result = await findCustomersByName('test');
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findOpenTasksForCustomer
// ─────────────────────────────────────────────────────────────────────────────

describe('findOpenTasksForCustomer', () => {
  it('filters by customerId and status NOT IN (DONE, CANCELED)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await findOpenTasksForCustomer('cust-99', 5);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"customerId" = $1');
    expect(sql).toContain("'DONE'");
    expect(sql).toContain("'CANCELED'");
    expect(params[0]).toBe('cust-99');
    expect(params[1]).toBe(5);
  });

  it('returns [] on DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('fail'));
    const result = await findOpenTasksForCustomer('c-1');
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scheduleTaskField
// ─────────────────────────────────────────────────────────────────────────────

const VALID_INPUT = {
  taskId: 'task-abc',
  inspectionTypeId: 'it-xyz',
  family: 'RADON',
  appointmentTitle: 'בדיקה נוספת ל-כהן',
  scheduledStartAt: '2026-08-01T10:00:00+03:00',
  durationMinutes: 60,
  siteAddress: 'הרצל 1',
  siteCity: 'תל אביב',
  fieldContactName: 'ישראל',
  fieldContactPhone: '0501111111',
  navigationUrl: 'https://waze.com/xyz',
  specialInstructions: 'להביא גז ניטרוגן',
  updatedByUserId: 'u-actor',
};

describe('scheduleTaskField', () => {
  it('wraps INSERT in BEGIN/COMMIT transaction and returns taskFieldId', async () => {
    const client = makeClient([
      { rows: [], rowCount: 0 },                                 // BEGIN
      { rows: [{ id: 'tf-new-123' }], rowCount: 1 },            // INSERT ... RETURNING id
      { rows: [], rowCount: 0 },                                 // COMMIT
    ]);
    mockConnect.mockResolvedValueOnce(client);

    const result = await scheduleTaskField(VALID_INPUT);

    // Transaction boundaries.
    const calls = client.query.mock.calls.map((c) => (c[0] as string).trim().toUpperCase());
    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 1]).toBe('COMMIT');

    // Returned ID.
    expect(result.taskFieldId).toBe('tf-new-123');

    // Release was called.
    expect(client.release).toHaveBeenCalled();
  });

  it('sends exactly 13 positional params to INSERT in the correct order', async () => {
    const client = makeClient([
      { rows: [], rowCount: 0 },
      { rows: [{ id: 'tf-param-check' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    mockConnect.mockResolvedValueOnce(client);

    await scheduleTaskField(VALID_INPUT);

    // INSERT is the second call (index 1, after BEGIN).
    const insertCall = client.query.mock.calls[1] as [string, unknown[]];
    const [sql, params] = insertCall;

    // SQL must target TaskField only.
    expect(sql).toContain('"TaskField"');
    expect(sql).not.toContain('"Task"');
    expect(sql).not.toContain('"Customer"');

    // 13 parameters.
    expect(params).toHaveLength(13);
    expect(params[0]).toBe(VALID_INPUT.taskId);           // $1
    expect(params[1]).toBe(VALID_INPUT.inspectionTypeId); // $2
    expect(params[2]).toBe(VALID_INPUT.family);           // $3
    expect(params[3]).toBe(VALID_INPUT.appointmentTitle); // $4
    expect(params[4]).toBe(VALID_INPUT.scheduledStartAt); // $5
    expect(params[5]).toBe(VALID_INPUT.durationMinutes);  // $6
    expect(params[6]).toBe(VALID_INPUT.siteAddress);      // $7
    expect(params[7]).toBe(VALID_INPUT.siteCity);         // $8
    expect(params[8]).toBe(VALID_INPUT.fieldContactName); // $9
    expect(params[9]).toBe(VALID_INPUT.fieldContactPhone);// $10
    expect(params[10]).toBe(VALID_INPUT.navigationUrl);   // $11
    expect(params[11]).toBe(VALID_INPUT.specialInstructions); // $12
    expect(params[12]).toBe(VALID_INPUT.updatedByUserId); // $13
  });

  it('inserts fieldStatus = ASSIGNED and uses gen_random_uuid()', async () => {
    const client = makeClient([
      { rows: [], rowCount: 0 },
      { rows: [{ id: 'tf-uuid' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    mockConnect.mockResolvedValueOnce(client);

    await scheduleTaskField(VALID_INPUT);

    const insertCall = client.query.mock.calls[1] as [string, unknown[]];
    const sql = insertCall[0];

    expect(sql).toContain("'ASSIGNED'");
    expect(sql).toContain('gen_random_uuid()');
  });

  it('does NOT include workerNotifiedAt in the INSERT column list', async () => {
    const client = makeClient([
      { rows: [], rowCount: 0 },
      { rows: [{ id: 'tf-notify-check' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    mockConnect.mockResolvedValueOnce(client);

    await scheduleTaskField(VALID_INPUT);

    const insertCall = client.query.mock.calls[1] as [string, unknown[]];
    const sql = insertCall[0];

    // workerNotifiedAt must NOT be set (NULL is the correct implicit default).
    expect(sql).not.toContain('workerNotifiedAt');
  });

  it('ROLLBACKs and rethrows on INSERT failure, always releases client', async () => {
    const dbError = new Error('unique constraint violation');
    const client = makeClient([
      { rows: [], rowCount: 0 }, // BEGIN — will succeed
    ]);
    // Override: second call (INSERT) throws.
    client.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
      .mockRejectedValueOnce(dbError);                   // INSERT → throws
    // ROLLBACK must succeed.
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    mockConnect.mockResolvedValueOnce(client);

    await expect(scheduleTaskField(VALID_INPUT)).rejects.toThrow('unique constraint violation');

    // ROLLBACK was called.
    const calls = client.query.mock.calls.map((c) => (c[0] as string).trim().toUpperCase());
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');

    // Client was released even though it threw.
    expect(client.release).toHaveBeenCalled();
  });

  it('throws if INSERT RETURNING returns no row', async () => {
    const client = makeClient([
      { rows: [], rowCount: 0 },   // BEGIN
      { rows: [], rowCount: 0 },   // INSERT returns nothing (unexpected)
    ]);
    // ROLLBACK after the missing-id error.
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockConnect.mockResolvedValueOnce(client);

    await expect(scheduleTaskField(VALID_INPUT)).rejects.toThrow('INSERT returned no id');
    expect(client.release).toHaveBeenCalled();
  });
});
