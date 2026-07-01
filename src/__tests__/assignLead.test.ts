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
  it('queries IncomingLead WHERE ownerId IS NULL ordered by receivedAt DESC', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await findUnassignedLeadsForAssignment();
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"IncomingLead"/);
    expect(sql).toMatch(/"ownerId"\s+IS\s+NULL/);
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
  it('issues a parameterized UPDATE with workerId and leadId in correct order', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await assignLead('lead-abc', 'worker-xyz', 'actor-id', '972500000001');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE\s+"IncomingLead"/i);
    expect(sql).toMatch(/"ownerId"\s*=\s*\$1/);
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$2/);
    // Param order: $1 = workerId, $2 = leadId.
    expect(params).toEqual(['worker-xyz', 'lead-abc']);
  });

  it('writes audit log with actor, lead, and worker captured in newValues', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await assignLead('lead-abc', 'worker-xyz', 'actor-id', '972500000001');

    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const entry = writeAuditLog.mock.calls[0][0];
    expect(entry.userId).toBe('actor-id');
    expect(entry.whatsappNumber).toBe('972500000001');
    expect(entry.detectedIntent).toBe('assign_lead');
    expect(entry.targetTaskId).toBe('lead-abc');
    expect(entry.newValues).toMatchObject({ leadId: 'lead-abc', ownerId: 'worker-xyz' });
    expect(entry.executionStatus).toBe('SUCCESS');
    expect(entry.confirmationStatus).toBe('CONFIRMED');
  });

  it('calls writeAuditLog even if it is the second call (not skipped)', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await assignLead('lead-x', 'worker-y', 'actor-z', '972509999');
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });
});
