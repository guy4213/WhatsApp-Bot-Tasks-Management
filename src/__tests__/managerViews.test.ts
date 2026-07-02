/**
 * managerViews.ts — query shape assertions for the manager-menu read helpers.
 * All tests mock pool.query; no real DB is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

beforeEach(() => { poolQuery.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

import {
  getManagementSnapshot,
  getTodayFieldInspections,
  getFieldExceptionRows,
  getAllWorkersDayOverview,
  getWorkerDayDetail,
  searchTasksByWorkerName,
  searchTasksByProductCode,
  getTaskFieldDetail,
} from '../services/managerViews';

const EMPTY = { rowCount: 0, rows: [] };
const LOCAL_DATE = '2026-07-01';

// ── getManagementSnapshot ─────────────────────────────────────────────────────

describe('getManagementSnapshot', () => {
  function mockAllThreeQueries() {
    // field counts
    poolQuery.mockResolvedValueOnce({
      rows: [{ total: '5', finished: '2', inProgress: '1', pending: '2' }],
    });
    // open exceptions
    poolQuery.mockResolvedValueOnce({ rows: [{ cnt: '3' }] });
    // lead counts
    poolQuery.mockResolvedValueOnce({
      rows: [{ totalOpen: '4', overnight: '2', escalated: '1' }],
    });
  }

  it('issues 3 separate queries (field / exceptions / leads)', async () => {
    mockAllThreeQueries();
    await getManagementSnapshot(LOCAL_DATE);
    expect(poolQuery).toHaveBeenCalledTimes(3);
  });

  it('first query filters TaskField by scheduledStartAt today (AT TIME ZONE)', async () => {
    mockAllThreeQueries();
    await getManagementSnapshot(LOCAL_DATE);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"TaskField"/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(sql).toMatch(/scheduledStartAt/);
    expect(sql).toMatch(/finished/i);
    expect(sql).toMatch(/inProgress|"inProgress"/i);
    expect(params).toContain(LOCAL_DATE);
  });

  it('second query counts open exceptions on TaskField scoped by scheduledStartAt today', async () => {
    mockAllThreeQueries();
    await getManagementSnapshot(LOCAL_DATE);
    const [sql, params] = poolQuery.mock.calls[1];
    expect(sql).toMatch(/"TaskField"/);
    expect(sql).toMatch(/hasOpenProblem/);
    expect(sql).toMatch(/missingReportInfo/);
    expect(sql).toMatch(/WAITING_FOR_INFO/);
    // "Today" = scheduledStartAt in the local Asia/Jerusalem day.
    expect(sql).toMatch(/scheduledStartAt/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(params).toContain(LOCAL_DATE);
    // Must NOT re-introduce assignedAt/finishedAt as day-scoping columns.
    expect(sql).not.toMatch(/tf\."assignedAt"\s*(>=|<)/);
    expect(sql).not.toMatch(/tf\."finishedAt"\s*(>=|<)/);
  });

  it('third query aggregates IncomingLead counts including escalation', async () => {
    mockAllThreeQueries();
    await getManagementSnapshot(LOCAL_DATE);
    const [sql, params] = poolQuery.mock.calls[2];
    expect(sql).toMatch(/"IncomingLead"/);
    expect(sql).toMatch(/ownerId/i);
    expect(sql).toMatch(/ESCALATED_1H/);
    expect(sql).toMatch(/overnight/i);
    expect(params).toContain(LOCAL_DATE);
    // Regression: leads keep using `receivedAt` (per spec, leads filtering was
    // NOT part of the scheduledStartAt alignment). Do not swap this to
    // scheduledStartAt — IncomingLead has no such column.
    expect(sql).toMatch(/"receivedAt"/);
    expect(sql).not.toMatch(/scheduledStartAt/);
  });

  it('returns parsed numeric values', async () => {
    mockAllThreeQueries();
    const snap = await getManagementSnapshot(LOCAL_DATE);
    expect(snap.today.total).toBe(5);
    expect(snap.today.finished).toBe(2);
    expect(snap.today.inProgress).toBe(1);
    expect(snap.today.pending).toBe(2);
    expect(snap.openExceptions).toBe(3);
    expect(snap.leads.totalOpen).toBe(4);
    expect(snap.leads.overnight).toBe(2);
    expect(snap.leads.escalated).toBe(1);
  });

  it('returns zeros when DB rows are empty', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    poolQuery.mockResolvedValueOnce({ rows: [] });
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const snap = await getManagementSnapshot(LOCAL_DATE);
    expect(snap.today.total).toBe(0);
    expect(snap.openExceptions).toBe(0);
    expect(snap.leads.totalOpen).toBe(0);
  });
});

// ── getTodayFieldInspections ──────────────────────────────────────────────────

describe('getTodayFieldInspections', () => {
  it('queries TaskField filtered by scheduledStartAt today, org-wide (no ownerId filter)', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await getTodayFieldInspections(LOCAL_DATE);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"TaskField"/);
    expect(sql).toMatch(/scheduledStartAt/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(params).toContain(LOCAL_DATE);
    // Must NOT filter by ownerId (org-wide)
    expect(sql).not.toMatch(/t\."ownerId"\s*=\s*\$1/);
  });

  it('joins User, Customer, InspectionType', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await getTodayFieldInspections(LOCAL_DATE);
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/JOIN.*"User"/i);
    expect(sql).toMatch(/JOIN.*"Customer".*c|LEFT JOIN.*"Customer"/i);
    expect(sql).toMatch(/JOIN.*"InspectionType"/i);
  });

  it('returns rows with expected shape', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{
        taskFieldId: 'tf1', taskId: 't1', workerName: 'דני', customerName: 'משה',
        timeHm: '09:00', siteCity: 'רעננה', fieldStatus: 'CONFIRMED',
        family: 'radiation', typeLabelHe: 'בדיקת קרינה',
      }],
    });
    const rows = await getTodayFieldInspections(LOCAL_DATE);
    expect(rows).toHaveLength(1);
    expect(rows[0].taskFieldId).toBe('tf1');
    expect(rows[0].workerName).toBe('דני');
    expect(rows[0].fieldStatus).toBe('CONFIRMED');
  });
});

// ── getFieldExceptionRows ─────────────────────────────────────────────────────

describe('getFieldExceptionRows', () => {
  it('open_exceptions: filters by hasOpenProblem / missingReportInfo AND scheduledStartAt today', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await getFieldExceptionRows(LOCAL_DATE, 'open_exceptions');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/hasOpenProblem/);
    expect(sql).toMatch(/missingReportInfo/);
    expect(sql).toMatch(/WAITING_FOR_INFO/);
    // Daily menu context — must be scoped by scheduledStartAt in Asia/Jerusalem.
    expect(sql).toMatch(/scheduledStartAt/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(params).toContain(LOCAL_DATE);
  });

  it('not_confirmed: filters fieldStatus = ASSIGNED and scheduledStartAt today', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await getFieldExceptionRows(LOCAL_DATE, 'not_confirmed');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/'ASSIGNED'/);
    expect(sql).toMatch(/scheduledStartAt/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(params).toContain(LOCAL_DATE);
  });

  it('has_problem: filters fieldStatus = HAS_PROBLEM AND scheduledStartAt today', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await getFieldExceptionRows(LOCAL_DATE, 'has_problem');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/'HAS_PROBLEM'/);
    // Daily menu context — must be scoped by scheduledStartAt in Asia/Jerusalem.
    expect(sql).toMatch(/scheduledStartAt/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(params).toContain(LOCAL_DATE);
  });

  it('waiting_for_info: filters fieldStatus = WAITING_FOR_INFO AND scheduledStartAt today', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await getFieldExceptionRows(LOCAL_DATE, 'waiting_for_info');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/'WAITING_FOR_INFO'/);
    expect(sql).toMatch(/scheduledStartAt/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(params).toContain(LOCAL_DATE);
  });

  it('not_closed: filters scheduledStartAt today and excludes FINISHED_FIELD/CANCELED/DECLINED', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await getFieldExceptionRows(LOCAL_DATE, 'not_closed');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/NOT IN/i);
    expect(sql).toMatch(/FINISHED_FIELD/);
    expect(sql).toMatch(/CANCELED/);
    expect(sql).toMatch(/DECLINED/);
    expect(sql).toMatch(/scheduledStartAt/);
    expect(params).toContain(LOCAL_DATE);
  });

  it('returns rows with expected shape', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{
        taskFieldId: 'tf2', taskId: 't2', workerName: 'יוסי', customerName: 'רונן',
        siteCity: 'תל אביב', fieldStatus: 'HAS_PROBLEM', description: 'הלקוח לא ענה',
      }],
    });
    const rows = await getFieldExceptionRows(LOCAL_DATE, 'has_problem');
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('הלקוח לא ענה');
  });
});

// ── getAllWorkersDayOverview ───────────────────────────────────────────────────

describe('getAllWorkersDayOverview', () => {
  it('groups by worker with finished/total/exceptions counts', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [
        { workerId: 'u1', workerName: 'דני', finished: '2', total: '3', exceptions: '1' },
        { workerId: 'u2', workerName: 'יוסי', finished: '1', total: '1', exceptions: '0' },
      ],
    });
    const rows = await getAllWorkersDayOverview(LOCAL_DATE);
    expect(rows).toHaveLength(2);
    expect(rows[0].finished).toBe(2);
    expect(rows[0].total).toBe(3);
    expect(rows[0].exceptions).toBe(1);
    expect(rows[1].exceptions).toBe(0);
  });

  it('queries TaskField with AT TIME ZONE filter and groups by User', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await getAllWorkersDayOverview(LOCAL_DATE);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"TaskField"/);
    expect(sql).toMatch(/GROUP BY/i);
    expect(sql).toMatch(/u\.id/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(params).toContain(LOCAL_DATE);
  });
});

// ── getWorkerDayDetail ────────────────────────────────────────────────────────

describe('getWorkerDayDetail', () => {
  it('filters by workerId and localDate', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await getWorkerDayDetail('worker-uuid', LOCAL_DATE);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/t\."ownerId"\s*=\s*\$1/);
    expect(params[0]).toBe('worker-uuid');
    expect(params[1]).toBe(LOCAL_DATE);
  });

  it('returns finished count and open exceptions count', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [
        { taskFieldId: 'tf1', taskId: 't1', workerName: 'דני', customerName: 'א',
          timeHm: '09:00', siteCity: 'X', fieldStatus: 'FINISHED_FIELD', family: 'noise',
          typeLabelHe: 'רעש', hasOpenProblem: false, missingReportInfo: false },
        { taskFieldId: 'tf2', taskId: 't2', workerName: 'דני', customerName: 'ב',
          timeHm: '11:00', siteCity: 'Y', fieldStatus: 'HAS_PROBLEM', family: 'noise',
          typeLabelHe: 'רעש', hasOpenProblem: true, missingReportInfo: false },
      ],
    });
    const detail = await getWorkerDayDetail('worker-uuid', LOCAL_DATE);
    expect(detail.total).toBe(2);
    expect(detail.finished).toBe(1);
    expect(detail.openExceptions).toBe(1);
    expect(detail.inspections).toHaveLength(2);
  });
});

// ── searchTasksByWorkerName ───────────────────────────────────────────────────

describe('searchTasksByWorkerName', () => {
  it('uses ILIKE fuzzy match on User.name', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await searchTasksByWorkerName('דני');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/ILIKE/i);
    expect(sql).toMatch(/%.*\|\|.*\$1.*\|\|.*%|%.*\$1.*%/);
    expect(params[0]).toBe('דני');
  });

  it('returns rows with TaskField shape', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{
        taskFieldId: 'tf3', taskId: 't3', workerName: 'דני כהן', customerName: 'לקוח',
        timeHm: '10:00', siteCity: 'רמת גן', fieldStatus: 'ASSIGNED',
        family: 'radiation', typeLabelHe: 'קרינה',
      }],
    });
    const rows = await searchTasksByWorkerName('דני');
    expect(rows).toHaveLength(1);
    expect(rows[0].workerName).toBe('דני כהן');
  });
});

// ── searchTasksByProductCode ──────────────────────────────────────────────────

describe('searchTasksByProductCode', () => {
  it('uses exact match on Task.productName', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await searchTasksByProductCode('9');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/t\."productName"\s*=\s*\$1/);
    expect(params[0]).toBe('9');
    // Must NOT use ILIKE for product code (exact match)
    expect(sql).not.toMatch(/ILIKE/i);
  });
});

// ── getTaskFieldDetail ────────────────────────────────────────────────────────

describe('getTaskFieldDetail', () => {
  it('queries by TaskField.id and returns full detail', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{
        taskFieldId: 'tf1', taskId: 't1', workerName: 'דני', customerName: 'לקוח',
        siteAddress: 'רחוב 1', siteCity: 'עיר', fieldContactName: 'איש קשר',
        fieldContactPhone: '050', fieldStatus: 'CONFIRMED',
        scheduledStartAt: new Date('2026-07-01T06:00:00Z'), family: 'noise',
        typeLabelHe: 'רעש', specialInstructions: null, problemNote: null,
        problemType: null, missingReportInfoNote: null, hasOpenProblem: false,
        missingReportInfo: false,
      }],
    });
    const detail = await getTaskFieldDetail('tf1');
    expect(detail).not.toBeNull();
    expect(detail!.taskFieldId).toBe('tf1');
    expect(detail!.workerName).toBe('דני');

    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/tf\.id\s*=\s*\$1/);
    expect(params[0]).toBe('tf1');
  });

  it('returns null when not found', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const detail = await getTaskFieldDetail('nonexistent');
    expect(detail).toBeNull();
  });
});
