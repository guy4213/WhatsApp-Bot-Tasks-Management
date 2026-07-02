/**
 * D2-T12 + D2-T13 + D2-T14 — service-layer tests for taskFieldCorrections.ts
 *
 * Coverage:
 *  - updateSiteMetadata: correct SQL shape (SET clause includes supplied fields
 *    + updatedByUserId + updatedAt), correct parameterization, rejects empty.
 *  - reassignTask: transactional structure (BEGIN/COMMIT), Task.ownerId update,
 *    TaskField.workerNotifiedAt reset for ASSIGNED/CONFIRMED rows only,
 *    hadInProgressRows flag, ROLLBACK on failure.
 *  - correctInspectionType: pre-checks (closed status → ClosedInspectionError,
 *    missing type → Error), transactional write (TaskField + Task), notification
 *    phones, audit log call shape.
 *  - listInspectionTypes: returns rows from InspectionType.
 *  - getTaskFieldForCorrection: returns null on miss, maps row on hit.
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

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage:   (...args: unknown[]) => sendTextMessage(...args),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
  sendListMessage:   vi.fn().mockResolvedValue(undefined),
}));

const writeAuditLog = vi.fn().mockResolvedValue('audit-id');
vi.mock('../utils/auditLog', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
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
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue(undefined);
  writeAuditLog.mockReset();
  writeAuditLog.mockResolvedValue('audit-id');
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  updateSiteMetadata,
  reassignTask,
  correctInspectionType,
  ClosedInspectionError,
  listInspectionTypes,
  getTaskFieldForCorrection,
} from '../services/taskFieldCorrections';

// ─────────────────────────────────────────────────────────────────────────────
// D2-T12: updateSiteMetadata
// ─────────────────────────────────────────────────────────────────────────────

describe('updateSiteMetadata', () => {
  it('throws when no fields supplied', async () => {
    await expect(
      updateSiteMetadata('tf-1', 'actor-1', {}),
    ).rejects.toThrow('no fields supplied');
  });

  it('builds SQL with only the supplied fields and executes pool.query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await updateSiteMetadata('tf-1', 'actor-1', { siteAddress: 'רוטשילד 10' });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // SQL must update only siteAddress + updatedByUserId + updatedAt
    expect(sql).toContain('"siteAddress"');
    expect(sql).toContain('"updatedByUserId"');
    expect(sql).toContain('"updatedAt"');
    // params: $1=taskFieldId, $2=actorId, $3=siteAddress value
    expect(params[0]).toBe('tf-1');
    expect(params[1]).toBe('actor-1');
    expect(params[2]).toBe('רוטשילד 10');
  });

  it('includes multiple supplied fields in SET clause', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await updateSiteMetadata('tf-2', 'actor-2', {
      siteAddress: 'הרצל 5',
      siteCity: 'ת"א',
    });

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"siteAddress"');
    expect(sql).toContain('"siteCity"');
  });

  it('does NOT include Customer or Task in the SQL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await updateSiteMetadata('tf-3', 'actor-3', { fieldContactName: 'ישראל' });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('"Customer"');
    expect(sql).not.toContain('"Task"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2-T13: reassignTask
// ─────────────────────────────────────────────────────────────────────────────

describe('reassignTask', () => {
  it('runs in a transaction (BEGIN, UPDATE Task, count in-progress, reset TaskField, COMMIT)', async () => {
    const client = makeClient([
      { rows: [], rowCount: 0 },                          // BEGIN
      { rows: [], rowCount: 1 },                          // UPDATE Task.ownerId
      { rows: [{ count: '0' }], rowCount: 1 },            // count in-progress rows
      { rows: [{ count: '2' }], rowCount: 1 },            // WITH updated CTE → count=2
      { rows: [], rowCount: 0 },                          // COMMIT
    ]);
    mockConnect.mockResolvedValueOnce(client);

    const result = await reassignTask('task-1', 'worker-new', 'actor-1');

    // BEGIN and COMMIT were called.
    const calls = client.query.mock.calls.map((c) => (c[0] as string).trim().toUpperCase());
    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 1]).toBe('COMMIT');

    // Task.ownerId update was called with correct params.
    const taskUpdate = client.query.mock.calls[1];
    expect(taskUpdate[0]).toContain('"Task"');
    expect(taskUpdate[0]).toContain('"ownerId"');
    expect(taskUpdate[1]).toEqual(['worker-new', 'task-1']);

    // Result shape.
    expect(result.resetCount).toBe(2);
    expect(result.hadInProgressRows).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  it('sets hadInProgressRows=true when EN_ROUTE/ARRIVED/FINISHED_FIELD rows exist', async () => {
    const client = makeClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      { rows: [{ count: '1' }], rowCount: 1 }, // in-progress count = 1
      { rows: [{ count: '0' }], rowCount: 1 }, // reset count = 0
      { rows: [], rowCount: 0 },
    ]);
    mockConnect.mockResolvedValueOnce(client);

    const result = await reassignTask('task-2', 'worker-new', 'actor-1');
    expect(result.hadInProgressRows).toBe(true);
  });

  it('rolls back on failure and re-throws', async () => {
    const client = makeClient([
      { rows: [], rowCount: 0 }, // BEGIN
      // Task update throws
    ]);
    client.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockRejectedValueOnce(new Error('DB error'))     // Task UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    mockConnect.mockResolvedValueOnce(client);

    await expect(reassignTask('task-3', 'w-new', 'actor-1')).rejects.toThrow('DB error');

    const calls = client.query.mock.calls.map((c) => (c[0] as string).trim().toUpperCase());
    expect(calls).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('only resets ASSIGNED/CONFIRMED rows (not EN_ROUTE/ARRIVED/FINISHED_FIELD)', async () => {
    const client = makeClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      { rows: [{ count: '0' }], rowCount: 1 },
      { rows: [{ count: '1' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    mockConnect.mockResolvedValueOnce(client);
    await reassignTask('task-4', 'w-new', 'actor-1');

    // Third call (after BEGIN + Task UPDATE): the CTE reset query must reference ASSIGNED/CONFIRMED
    const resetCall = client.query.mock.calls[3];
    const resetSql = resetCall[0] as string;
    expect(resetSql).toMatch(/ASSIGNED/);
    expect(resetSql).toMatch(/CONFIRMED/);
    // Must NOT include EN_ROUTE in the reset WHERE clause
    expect(resetSql).not.toContain("'EN_ROUTE'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2-T14: correctInspectionType
// ─────────────────────────────────────────────────────────────────────────────

describe('correctInspectionType', () => {
  function makePrefetchRow(overrides: Partial<{
    taskId: string;
    fieldStatus: string;
    taskOwnerId: string;
    oldProductName: string | null;
    oldLabelHe: string | null;
  }> = {}) {
    return {
      taskId: 'task-1',
      fieldStatus: 'ASSIGNED',
      taskOwnerId: 'worker-1',
      oldProductName: '73',
      oldLabelHe: 'רעש – בדיקת רעש סביבתית',
      ...overrides,
    };
  }

  it('throws ClosedInspectionError when fieldStatus is FINISHED_FIELD', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makePrefetchRow({ fieldStatus: 'FINISHED_FIELD' })],
      rowCount: 1,
    });

    await expect(
      correctInspectionType('tf-1', 'type-new', 'actor-1', 'דני'),
    ).rejects.toBeInstanceOf(ClosedInspectionError);
  });

  it('throws ClosedInspectionError when fieldStatus is CANCELED', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [makePrefetchRow({ fieldStatus: 'CANCELED' })],
      rowCount: 1,
    });

    await expect(
      correctInspectionType('tf-2', 'type-new', 'actor-1', 'דני'),
    ).rejects.toBeInstanceOf(ClosedInspectionError);
  });

  it('throws when InspectionType not found', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makePrefetchRow()], rowCount: 1 }) // prefetch
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                  // type lookup — not found

    await expect(
      correctInspectionType('tf-3', 'type-missing', 'actor-1', 'דני'),
    ).rejects.toThrow('not found or inactive');
  });

  it('throws when TaskField not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // prefetch returns empty

    await expect(
      correctInspectionType('tf-notexist', 'type-new', 'actor-1', 'דני'),
    ).rejects.toThrow('not found');
  });

  it('writes TaskField + Task in a single transaction and returns old/new productName', async () => {
    const prefetchRow = makePrefetchRow();
    const newType = { code: '62', labelHe: 'גהות – בדיקת רעש תעסוקתית', family: 'occupational' };

    // pool.query calls: prefetch, type lookup, notification phones
    mockQuery
      .mockResolvedValueOnce({ rows: [prefetchRow], rowCount: 1 })           // prefetch
      .mockResolvedValueOnce({ rows: [newType], rowCount: 1 })                // type lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                      // notification phones

    // pool.connect for transaction
    const client = makeClient([
      { rows: [], rowCount: 0 },  // BEGIN
      { rows: [], rowCount: 1 },  // UPDATE TaskField
      { rows: [], rowCount: 1 },  // UPDATE Task
      { rows: [], rowCount: 0 },  // COMMIT
    ]);
    mockConnect.mockResolvedValueOnce(client);

    const result = await correctInspectionType('tf-4', 'type-new-id', 'actor-1', 'דני');

    expect(result.oldProductName).toBe('73');
    expect(result.newProductName).toBe('62');

    // TaskField update must reference inspectionTypeId and family.
    const tfUpdate = client.query.mock.calls[1];
    expect(tfUpdate[0]).toContain('"TaskField"');
    expect(tfUpdate[0]).toContain('"inspectionTypeId"');
    expect(tfUpdate[0]).toContain('family');

    // Task update must reference productName.
    const taskUpdate = client.query.mock.calls[2];
    expect(taskUpdate[0]).toContain('"Task"');
    expect(taskUpdate[0]).toContain('"productName"');
    expect(taskUpdate[1]).toContain('62'); // new code

    expect(client.release).toHaveBeenCalled();
  });

  it('calls writeAuditLog after successful write', async () => {
    const prefetchRow = makePrefetchRow();
    const newType = { code: '62', labelHe: 'גהות', family: 'occupational' };

    mockQuery
      .mockResolvedValueOnce({ rows: [prefetchRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [newType], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // phones

    const client = makeClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    mockConnect.mockResolvedValueOnce(client);

    await correctInspectionType('tf-5', 'type-new-id', 'actor-1', 'דני');

    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const entry = writeAuditLog.mock.calls[0][0];
    expect(entry.detectedIntent).toBe('correct_inspection_type');
    expect(entry.executionStatus).toBe('SUCCESS');
    expect(entry.confirmationStatus).toBe('CONFIRMED');
    expect(entry.oldValues).toMatchObject({ productName: '73' });
    expect(entry.newValues).toMatchObject({ productName: '62' });
  });

  it('sends WhatsApp notifications to Yoram + Sasha after write', async () => {
    const prefetchRow = makePrefetchRow();
    const newType = { code: '62', labelHe: 'גהות', family: 'occupational' };

    mockQuery
      .mockResolvedValueOnce({ rows: [prefetchRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [newType], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ phone: '972501111111' }, { phone: '972502222222' }],
        rowCount: 2,
      }); // notification phones

    const client = makeClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    mockConnect.mockResolvedValueOnce(client);

    await correctInspectionType('tf-6', 'type-new-id', 'actor-1', 'דני');

    // One sendTextMessage per phone.
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    for (const t of texts) {
      expect(t).toContain('תיקון סוג בדיקה');
      expect(t).toContain('דני');
    }
  });

  it('rolls back and re-throws on transaction failure', async () => {
    const prefetchRow = makePrefetchRow();
    const newType = { code: '62', labelHe: 'גהות', family: 'occupational' };

    mockQuery
      .mockResolvedValueOnce({ rows: [prefetchRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [newType], rowCount: 1 });

    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
        .mockRejectedValueOnce(new Error('TX fail'))        // TaskField UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),  // ROLLBACK
      release: vi.fn(),
    };
    mockConnect.mockResolvedValueOnce(client);

    await expect(
      correctInspectionType('tf-7', 'type-new-id', 'actor-1', 'דני'),
    ).rejects.toThrow('TX fail');

    const rollbackCall = client.query.mock.calls.find(
      (c) => (c[0] as string).trim().toUpperCase() === 'ROLLBACK',
    );
    expect(rollbackCall).toBeDefined();
    expect(client.release).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listInspectionTypes
// ─────────────────────────────────────────────────────────────────────────────

describe('listInspectionTypes', () => {
  it('returns rows from InspectionType ordered by family + sortOrder', async () => {
    const mockRows = [
      { id: 'a', code: '73', labelHe: 'רעש – ...', family: 'noise' },
      { id: 'b', code: '66', labelHe: 'אוויר – ...', family: 'air' },
    ];
    mockQuery.mockResolvedValueOnce({ rows: mockRows, rowCount: 2 });

    const result = await listInspectionTypes();

    expect(result).toHaveLength(2);
    expect(result[0].code).toBe('73');
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"InspectionType"');
    expect(sql).toContain('isActive');
    expect(sql).toContain('ORDER BY');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getTaskFieldForCorrection
// ─────────────────────────────────────────────────────────────────────────────

describe('getTaskFieldForCorrection', () => {
  it('returns null when TaskField not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getTaskFieldForCorrection('tf-missing');
    expect(result).toBeNull();
  });

  it('returns a mapped row on hit', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'tf-1',
        taskId: 'task-1',
        taskOwnerId: 'worker-1',
        fieldStatus: 'ASSIGNED',
        inspectionTypeId: 'itype-1',
        labelHe: 'רעש – ...',
      }],
      rowCount: 1,
    });

    const result = await getTaskFieldForCorrection('tf-1');
    expect(result).not.toBeNull();
    expect(result!.taskFieldId).toBe('tf-1');
    expect(result!.taskId).toBe('task-1');
    expect(result!.taskOwnerId).toBe('worker-1');
    expect(result!.fieldStatus).toBe('ASSIGNED');
    expect(result!.currentInspectionTypeId).toBe('itype-1');
    expect(result!.currentLabelHe).toBe('רעש – ...');
  });
});
