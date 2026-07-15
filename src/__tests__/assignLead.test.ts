/**
 * D3-T6 — assignLead service tests.
 *
 * Verifies:
 *  - findUnassignedLeadsForAssignment SQL shape and parameter binding
 *  - assignLead transactional flow: BEGIN / snapshot SELECT / guarded UPDATE
 *    (ownerId + status=ACTIVE) / Task INSERT (mirrors CRM
 *    `createTaskForClaimedLead`) / IncomingLead.taskId link / COMMIT
 *  - Race guard: guarded UPDATE affects 0 rows → ROLLBACK, throw, no Task
 *  - audit-log call shape (actor, lead, target worker, new taskId), written
 *    only after COMMIT
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
const poolConnect = vi.fn();
vi.mock('../db/connection', () => ({
  pool: {
    query: (...args: unknown[]) => poolQuery(...args),
    connect: (...args: unknown[]) => poolConnect(...args),
  },
}));

const writeAuditLog = vi.fn().mockResolvedValue('audit-id');
vi.mock('../utils/auditLog', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
  updateTranscribedMessage: vi.fn().mockResolvedValue(undefined),
}));

// Build a fake pooled client that returns pre-canned responses in order.
// The transaction issues, in order:
//   1. BEGIN
//   2. SELECT ownerId snapshot
//   3. UPDATE IncomingLead ... RETURNING body
//   4. INSERT INTO Task ... RETURNING id      (skipped when UPDATE affects 0 rows)
//   5. UPDATE IncomingLead SET taskId         (skipped when UPDATE affects 0 rows)
//   6. COMMIT                                  (or ROLLBACK on failure)
function makeClient(responses: Array<{ rows: unknown[]; rowCount: number }>) {
  let i = 0;
  const query = vi.fn((..._args: unknown[]) => {
    const r = responses[i] ?? { rows: [], rowCount: 0 };
    i++;
    return Promise.resolve(r);
  });
  return { query, release: vi.fn() };
}

beforeEach(() => {
  poolQuery.mockReset();
  poolConnect.mockReset();
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
  // Success-path client response sequence (see makeClient() header):
  //   BEGIN, SELECT snapshot, UPDATE claim, INSERT Task, UPDATE taskId, COMMIT.
  function successClient(prevOwnerId: string | null, body: string | null, newTaskId: string) {
    return makeClient([
      { rows: [], rowCount: 0 },                                          // BEGIN
      { rows: [{ ownerId: prevOwnerId }], rowCount: 1 },                  // SELECT snapshot
      { rows: [{ body, prevOwnerId: 'worker-xyz' }], rowCount: 1 },       // UPDATE claim (RETURNING body)
      { rows: [{ id: newTaskId }], rowCount: 1 },                         // INSERT Task
      { rows: [], rowCount: 1 },                                          // UPDATE taskId
      { rows: [], rowCount: 0 },                                          // COMMIT
    ]);
  }

  it('runs the full BEGIN → snapshot → guarded UPDATE → Task INSERT → taskId UPDATE → COMMIT sequence', async () => {
    const client = successClient(null, 'lead body text', 'task-new-1');
    poolConnect.mockResolvedValueOnce(client);

    await assignLead('lead-abc', 'worker-xyz', 'actor-id', '972500000001');

    const sqls = client.query.mock.calls.map((c) => (c[0] as string).trim());
    const params = client.query.mock.calls.map((c) => c[1]);

    // Ordered call trace.
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/^SELECT\s+"ownerId"::text\s+AS\s+"ownerId"\s+FROM\s+"IncomingLead"/);
    expect(params[1]).toEqual(['lead-abc']);

    // Guarded UPDATE — same predicate as before + RETURNING body for the Task.
    expect(sqls[2]).toMatch(/UPDATE\s+"IncomingLead"/);
    expect(sqls[2]).toMatch(/"ownerId"\s*=\s*\$1/);
    expect(sqls[2]).toMatch(/status\s*=\s*'ACTIVE'/);
    expect(sqls[2]).toMatch(/WHERE\s+id\s*=\s*\$2\s+AND\s+status\s*=\s*'NEW'/);
    expect(sqls[2]).toMatch(/RETURNING\s+body/);
    expect(params[2]).toEqual(['worker-xyz', 'lead-abc']);

    // Task INSERT — must match CRM createTaskForClaimedLead exactly.
    expect(sqls[3]).toMatch(/INSERT\s+INTO\s+"Task"/);
    expect(sqls[3]).toMatch(/gen_random_uuid\(\)/);
    expect(sqls[3]).toMatch(/'ליד חדש נכנס'/);
    expect(sqls[3]).toMatch(/'step1'/);
    expect(sqls[3]).toMatch(/'OPEN'/);
    expect(sqls[3]).toMatch(/'HIGH'/);
    expect(sqls[3]).toMatch(/"currentStage"/);
    expect(sqls[3]).toMatch(/"incomingLeadId"/);
    expect(sqls[3]).toMatch(/"updatedAt"/);
    expect(sqls[3]).toMatch(/RETURNING\s+id::text\s+AS\s+id/);
    // Params: $1 = body, $2 = workerId, $3 = leadId.
    expect(params[3]).toEqual(['lead body text', 'worker-xyz', 'lead-abc']);

    // Link the new task back onto the lead.
    expect(sqls[4]).toMatch(/UPDATE\s+"IncomingLead"\s+SET\s+"taskId"\s*=\s*\$1\s+WHERE\s+id\s*=\s*\$2/);
    expect(params[4]).toEqual(['task-new-1', 'lead-abc']);

    expect(sqls[5]).toBe('COMMIT');

    // Client always released.
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('writes audit log AFTER commit, with pre-UPDATE ownerId and the new taskId captured', async () => {
    const client = successClient(null, null, 'task-new-2');
    poolConnect.mockResolvedValueOnce(client);

    await assignLead('lead-abc', 'worker-xyz', 'actor-id', '972500000001');

    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const entry = writeAuditLog.mock.calls[0][0];
    expect(entry.userId).toBe('actor-id');
    expect(entry.whatsappNumber).toBe('972500000001');
    expect(entry.detectedIntent).toBe('assign_lead');
    expect(entry.targetTaskId).toBe('lead-abc');
    // Status pre-UPDATE is guaranteed 'NEW' by the WHERE guard, so it's
    // recorded literally rather than re-read.
    expect(entry.oldValues).toEqual({ ownerId: null, status: 'NEW' });
    expect(entry.newValues).toMatchObject({
      leadId: 'lead-abc',
      ownerId: 'worker-xyz',
      status: 'ACTIVE',
      taskId: 'task-new-2',
    });
    expect(entry.executionStatus).toBe('SUCCESS');
    expect(entry.confirmationStatus).toBe('CONFIRMED');
  });

  it('rolls back and throws "הליד כבר שויך" without INSERTing a Task when the guarded UPDATE affects 0 rows (race)', async () => {
    // A parallel manager assigned this lead microseconds earlier — status is
    // already ACTIVE, so the WHERE status='NEW' guard filters us out.
    const client = makeClient([
      { rows: [], rowCount: 0 },                                    // BEGIN
      { rows: [{ ownerId: 'previous-worker' }], rowCount: 1 },      // SELECT snapshot
      { rows: [], rowCount: 0 },                                    // UPDATE claim → 0 rows
      { rows: [], rowCount: 0 },                                    // ROLLBACK
    ]);
    poolConnect.mockResolvedValueOnce(client);

    await expect(
      assignLead('lead-abc', 'worker-xyz', 'actor-id', '972500000001'),
    ).rejects.toThrow('הליד כבר שויך');

    const sqls = client.query.mock.calls.map((c) => (c[0] as string).trim());
    // Must not have attempted the Task INSERT.
    expect(sqls.some((s) => /INSERT\s+INTO\s+"Task"/.test(s))).toBe(false);
    // Must have rolled back and released the client.
    expect(sqls).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);

    // Audit is intentionally skipped for the losing side of a race — nothing
    // was actually committed.
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it('rolls back and does NOT audit when the Task INSERT fails mid-transaction', async () => {
    // Simulate a downstream failure after the guarded UPDATE succeeds — e.g.
    // Task table constraint violation. The transaction must roll back cleanly
    // and no audit row can be written.
    let i = 0;
    const responses = [
      { rows: [], rowCount: 0 },                                          // BEGIN
      { rows: [{ ownerId: null }], rowCount: 1 },                         // SELECT snapshot
      { rows: [{ body: 'x', prevOwnerId: 'worker-xyz' }], rowCount: 1 }, // UPDATE claim
    ];
    const query = vi.fn((...args: unknown[]) => {
      if (i < responses.length) {
        const r = responses[i]; i++;
        return Promise.resolve(r);
      }
      // Fourth call = INSERT INTO "Task" — blow up.
      const sql = String(args[0] ?? '');
      if (/INSERT\s+INTO\s+"Task"/.test(sql)) {
        i++;
        return Promise.reject(new Error('boom'));
      }
      // ROLLBACK afterwards.
      i++;
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const client = { query, release: vi.fn() };
    poolConnect.mockResolvedValueOnce(client);

    await expect(
      assignLead('lead-abc', 'worker-xyz', 'actor-id', '972500000001'),
    ).rejects.toThrow('boom');

    const sqls = query.mock.calls.map((c) => (c[0] as string).trim());
    expect(sqls).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
