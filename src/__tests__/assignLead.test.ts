/**
 * D3-T6 — assignLead service tests.
 *
 * Verifies:
 *  - findUnassignedLeadsForAssignment SQL shape and parameter binding
 *  - assignLead UPDATE SQL parameterization
 *  - assignLead audit-log call shape (actor, lead, target worker)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

const writeAuditLog = vi.fn().mockResolvedValue('audit-id');
vi.mock('../utils/auditLog', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
  updateTranscribedMessage: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  poolQuery.mockReset();
  writeAuditLog.mockReset();
  writeAuditLog.mockResolvedValue('audit-id');
});
afterEach(() => { vi.restoreAllMocks(); });

import {
  findUnassignedLeadsForAssignment,
  assignLead,
} from '../services/incomingLeads';

const EMPTY = { rowCount: 0, rows: [] };

// ── findUnassignedLeadsForAssignment ─────────────────────────────────────────

describe('findUnassignedLeadsForAssignment', () => {
  // Pending = status='NEW' (product truth: status wins over ownerId).
  // Ownerless-but-not-NEW rows (e.g. status=ACTIVE with a stale null) are
  // deliberately excluded; status is the single source of "still pending".
  it('queries IncomingLead WHERE status=NEW ordered by receivedAt DESC', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await findUnassignedLeadsForAssignment();
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"IncomingLead"/);
    expect(sql).toMatch(/status\s*=\s*'NEW'/);
    // No ownerId predicate — status is the whole filter.
    expect(sql).not.toMatch(/"ownerId"\s+IS\s+NULL/);
    expect(sql).toMatch(/ORDER BY\s+"receivedAt"\s+DESC/);
    expect(sql).toMatch(/LIMIT\s+\$1/);
    // Default limit is 20.
    expect(params).toEqual([20]);
  });

  it('accepts a custom limit', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await findUnassignedLeadsForAssignment(5);
    expect(poolQuery.mock.calls[0][1]).toEqual([5]);
  });

  it('returns mapped rows', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        id: 'lead-1', subject: 'בדיקת קרינה', body: null,
        fromName: 'ישראל ישראלי', fromEmail: 'il@example.com',
        receivedAt: new Date('2026-07-01T09:00:00Z'),
        status: null, ownerId: null, taskId: null,
      }],
    });
    const result = await findUnassignedLeadsForAssignment();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('lead-1');
    expect(result[0].fromName).toBe('ישראל ישראלי');
  });
});

// ── assignLead ───────────────────────────────────────────────────────────────

describe('assignLead', () => {
  // Two pool.query calls now: a SELECT snapshot (for audit oldValues + race
  // detection) and then the guarded UPDATE. Both must be mocked in order.
  const SNAPSHOT_ROW = (ownerId: string | null, status: string | null) => ({
    rowCount: 1,
    rows: [{ ownerId, status }],
  });

  it('issues a guarded UPDATE that sets ownerId AND status=ACTIVE, only when status=NEW', async () => {
    poolQuery
      .mockResolvedValueOnce(SNAPSHOT_ROW(null, 'NEW'))   // SELECT snapshot
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });   // UPDATE
    await assignLead('lead-abc', 'worker-xyz', 'actor-id', '972500000001');
    const [updateSql, updateParams] = poolQuery.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE\s+"IncomingLead"/i);
    expect(updateSql).toMatch(/"ownerId"\s*=\s*\$1/);
    expect(updateSql).toMatch(/status\s*=\s*'ACTIVE'/);
    expect(updateSql).toMatch(/WHERE\s+id\s*=\s*\$2\s+AND\s+status\s*=\s*'NEW'/);
    // Param order: $1 = workerId, $2 = leadId (unchanged from the
    // ownerId-only version).
    expect(updateParams).toEqual(['worker-xyz', 'lead-abc']);
  });

  it('writes audit log with old status/ownerId snapshotted and new status=ACTIVE captured', async () => {
    poolQuery
      .mockResolvedValueOnce(SNAPSHOT_ROW(null, 'NEW'))
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await assignLead('lead-abc', 'worker-xyz', 'actor-id', '972500000001');

    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const entry = writeAuditLog.mock.calls[0][0];
    expect(entry.userId).toBe('actor-id');
    expect(entry.whatsappNumber).toBe('972500000001');
    expect(entry.detectedIntent).toBe('assign_lead');
    expect(entry.targetTaskId).toBe('lead-abc');
    expect(entry.oldValues).toEqual({ ownerId: null, status: 'NEW' });
    expect(entry.newValues).toMatchObject({
      leadId: 'lead-abc',
      ownerId: 'worker-xyz',
      status: 'ACTIVE',
    });
    expect(entry.executionStatus).toBe('SUCCESS');
    expect(entry.confirmationStatus).toBe('CONFIRMED');
  });

  it('throws "הליד כבר שויך" and does NOT audit when the guarded UPDATE affects 0 rows (race)', async () => {
    // A parallel manager assigned this lead microseconds earlier — status is
    // already ACTIVE, so the WHERE status='NEW' guard filters us out.
    poolQuery
      .mockResolvedValueOnce(SNAPSHOT_ROW('previous-worker', 'ACTIVE'))
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(
      assignLead('lead-abc', 'worker-xyz', 'actor-id', '972500000001'),
    ).rejects.toThrow('הליד כבר שויך');

    // Audit is intentionally skipped for the losing side of a race — we did
    // not actually write anything, so nothing to record.
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
