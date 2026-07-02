/**
 * exceptionsQueries.ts — query-shape assertions for Yoram's daily field
 * exceptions digest.
 *
 * Focused on the "today" scoping contract (2026-07-02 alignment): every daily
 * count and the open-exceptions numbered list is scoped by
 * `TaskField.scheduledStartAt` in the local Asia/Jerusalem day. Neither
 * `assignedAt` nor `finishedAt` is a valid day-scoping column.
 *
 * All tests mock pool.query — no real DB is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

beforeEach(() => { poolQuery.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

import {
  getFieldExceptionCounts,
  getOpenFieldExceptions,
} from '../services/exceptionsQueries';

const LOCAL_DATE = '2026-07-02';

// ── getFieldExceptionCounts ──────────────────────────────────────────────────

describe('getFieldExceptionCounts — scheduledStartAt is the "today" column', () => {
  it('issues one aggregated query parameterized on localDate', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{
      finishedFieldToday: '0', notConfirmedToday: '0', hasProblemToday: '0',
      waitingForInfoToday: '0', notClosedDayToday: '0',
    }] });
    await getFieldExceptionCounts(LOCAL_DATE);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [, params] = poolQuery.mock.calls[0];
    expect(params).toEqual([LOCAL_DATE]);
  });

  it('WHERE clause scopes to scheduledStartAt inside the Asia/Jerusalem local day', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{
      finishedFieldToday: '0', notConfirmedToday: '0', hasProblemToday: '0',
      waitingForInfoToday: '0', notClosedDayToday: '0',
    }] });
    await getFieldExceptionCounts(LOCAL_DATE);
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(sql).toMatch(/tf\."scheduledStartAt"\s*>=/);
    expect(sql).toMatch(/tf\."scheduledStartAt"\s*</);
  });

  it('does NOT use assignedAt or finishedAt as a day-scoping column', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{
      finishedFieldToday: '0', notConfirmedToday: '0', hasProblemToday: '0',
      waitingForInfoToday: '0', notClosedDayToday: '0',
    }] });
    await getFieldExceptionCounts(LOCAL_DATE);
    const [sql] = poolQuery.mock.calls[0];
    // No range comparison on assignedAt or finishedAt anywhere in the query.
    expect(sql).not.toMatch(/tf\."assignedAt"\s*>=/);
    expect(sql).not.toMatch(/tf\."assignedAt"\s*</);
    expect(sql).not.toMatch(/tf\."finishedAt"\s*>=/);
    expect(sql).not.toMatch(/tf\."finishedAt"\s*</);
  });

  it('all 5 counts are named as expected (spec §13)', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{
      finishedFieldToday: '3', notConfirmedToday: '2', hasProblemToday: '1',
      waitingForInfoToday: '4', notClosedDayToday: '5',
    }] });
    const counts = await getFieldExceptionCounts(LOCAL_DATE);
    expect(counts).toEqual({
      finishedFieldToday: 3,
      notConfirmedToday: 2,
      hasProblemToday: 1,
      waitingForInfoToday: 4,
      notClosedDayToday: 5,
    });
  });

  it('each count filters by its own fieldStatus / hasOpenProblem predicate', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{
      finishedFieldToday: '0', notConfirmedToday: '0', hasProblemToday: '0',
      waitingForInfoToday: '0', notClosedDayToday: '0',
    }] });
    await getFieldExceptionCounts(LOCAL_DATE);
    const [sql] = poolQuery.mock.calls[0];
    // finished
    expect(sql).toMatch(/"fieldStatus"\s*=\s*'FINISHED_FIELD'/);
    // not confirmed
    expect(sql).toMatch(/"fieldStatus"\s*=\s*'ASSIGNED'/);
    // has problem
    expect(sql).toMatch(/"hasOpenProblem"\s*=\s*true/);
    // waiting for info
    expect(sql).toMatch(/"fieldStatus"\s*=\s*'WAITING_FOR_INFO'/);
    // not closed
    expect(sql).toMatch(/NOT IN \('FINISHED_FIELD','CANCELED','DECLINED'\)/);
  });

  it('returns zeros when the DB row is empty', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const counts = await getFieldExceptionCounts(LOCAL_DATE);
    expect(counts).toEqual({
      finishedFieldToday: 0, notConfirmedToday: 0, hasProblemToday: 0,
      waitingForInfoToday: 0, notClosedDayToday: 0,
    });
  });
});

// ── getOpenFieldExceptions ───────────────────────────────────────────────────

describe('getOpenFieldExceptions — scheduled today only', () => {
  it('binds localDate as $1 and scopes by scheduledStartAt', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await getOpenFieldExceptions(LOCAL_DATE);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(params).toEqual([LOCAL_DATE]);
    expect(sql).toMatch(/tf\."scheduledStartAt"\s*>=/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
  });

  it('still filters "open" as hasOpenProblem OR (missingReportInfo AND WAITING_FOR_INFO)', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await getOpenFieldExceptions(LOCAL_DATE);
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/hasOpenProblem/);
    expect(sql).toMatch(/missingReportInfo/);
    expect(sql).toMatch(/WAITING_FOR_INFO/);
  });

  it('does not use assignedAt/finishedAt as day-scoping columns', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await getOpenFieldExceptions(LOCAL_DATE);
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).not.toMatch(/"assignedAt"\s*(>=|<)/);
    expect(sql).not.toMatch(/"finishedAt"\s*(>=|<)/);
  });

  it('orders by managerNotifiedAt ASC NULLS LAST', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await getOpenFieldExceptions(LOCAL_DATE);
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/ORDER BY tf\."managerNotifiedAt" ASC NULLS LAST/);
  });

  it('returns the DB rows verbatim', async () => {
    const row = {
      taskFieldId: 'tf-x', workerName: 'דני', customerName: 'משה',
      taskTitle: 'בדיקת קרינה', siteAddress: 'הרצל 1',
      kind: 'problem', note: 'הלקוח לא ענה', problemType: 'CUSTOMER_NOT_ANSWERING',
      managerNotifiedAt: null,
    };
    poolQuery.mockResolvedValueOnce({ rows: [row] });
    const rows = await getOpenFieldExceptions(LOCAL_DATE);
    expect(rows).toHaveLength(1);
    expect(rows[0].taskFieldId).toBe('tf-x');
    expect(rows[0].kind).toBe('problem');
  });
});
