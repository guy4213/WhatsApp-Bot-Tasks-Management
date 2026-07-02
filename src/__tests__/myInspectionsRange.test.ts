/**
 * Unit tests for `getMyInspectionsInRange` (src/services/myInspectionsRange.ts).
 *
 * Mocks `pool.query` and inspects SQL to guarantee:
 *  - the daily/range window is driven by `TaskField.scheduledStartAt` in
 *    Asia/Jerusalem (CLAUDE.md §6.1 — NEVER Task.createdAt / dueDate /
 *    TaskField.assignedAt / TaskField.finishedAt).
 *  - the whitelist excludes CANCELED / DECLINED.
 *  - INNER JOINs on Task and InspectionType (LEFT would leak orphan rows).
 *  - rows are mapped to `MyInspectionRangeItem` verbatim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

beforeEach(() => {
  poolQuery.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

import { getMyInspectionsInRange } from '../services/myInspectionsRange';

describe('getMyInspectionsInRange', () => {
  it('SQL filters by t."ownerId" = $1 and TaskField.scheduledStartAt half-open Asia/Jerusalem window', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await getMyInspectionsInRange('u-1', '2026-07-01', '2026-07-08');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/t\."ownerId"\s*=\s*\$1/);
    expect(sql).toMatch(/tf\."scheduledStartAt"\s*>=\s*\(\$2::date\)\s+AT\s+TIME\s+ZONE\s+'Asia\/Jerusalem'/);
    expect(sql).toMatch(/tf\."scheduledStartAt"\s*<\s*\(\$3::date\)\s+AT\s+TIME\s+ZONE\s+'Asia\/Jerusalem'/);
    expect(params).toEqual(['u-1', '2026-07-01', '2026-07-08']);
  });

  it('SQL excludes CANCELED and DECLINED via a whitelist', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await getMyInspectionsInRange('u-1', '2026-07-01', '2026-07-02');
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/AND\s+tf\."fieldStatus"\s+NOT\s+IN\s*\(\s*'CANCELED'\s*,\s*'DECLINED'\s*\)/);
  });

  it('SQL does NOT reference forbidden date columns (createdAt / dueDate / assignedAt / finishedAt)', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await getMyInspectionsInRange('u-1', '2026-07-01', '2026-07-02');
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).not.toMatch(/"createdAt"/);
    expect(sql).not.toMatch(/"dueDate"/);
    expect(sql).not.toMatch(/"assignedAt"/);
    expect(sql).not.toMatch(/"finishedAt"/);
  });

  it('SQL uses INNER JOIN for Task and InspectionType (not LEFT)', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await getMyInspectionsInRange('u-1', '2026-07-01', '2026-07-02');
    const [sql] = poolQuery.mock.calls[0];
    // INNER JOIN is expressed via "JOIN "Task"" (not "LEFT JOIN "Task"")
    expect(sql).toMatch(/(?<!LEFT\s)JOIN\s+"Task"\s+t/);
    expect(sql).toMatch(/(?<!LEFT\s)JOIN\s+"InspectionType"\s+it/);
    // Sanity: LEFT JOINs still exist for the 4 optional customer sources
    expect(sql).toMatch(/LEFT\s+JOIN\s+"Customer"\s+c/);
    expect(sql).toMatch(/LEFT\s+JOIN\s+"Lead"\s+l/);
    expect(sql).toMatch(/LEFT\s+JOIN\s+"Project"\s+p/);
    expect(sql).toMatch(/LEFT\s+JOIN\s+"IncomingLead"\s+il/);
  });

  it('SQL orders rows by scheduledStartAt ASC and selects taskId + scheduledStartAt', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await getMyInspectionsInRange('u-1', '2026-07-01', '2026-07-02');
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/ORDER\s+BY\s+tf\."scheduledStartAt"\s+ASC/);
    expect(sql).toMatch(/tf\."taskId"\s+AS\s+"taskId"/);
    expect(sql).toMatch(/tf\."scheduledStartAt"\s+AS\s+"scheduledStartAt"/);
  });

  it('maps returned rows verbatim to MyInspectionRangeItem', async () => {
    const dbRow = {
      taskFieldId: 'tf-1',
      taskId: 't-1',
      customerName: 'לקוח א',
      taskTitle: 'בדיקת רעש',
      siteAddress: 'הרצל 5',
      siteCity: 'תל אביב',
      fieldStatus: 'CONFIRMED',
      family: 'noise',
      typeLabelHe: 'רעש',
      scheduledStartAt: new Date('2026-07-01T06:00:00Z'),
    };
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [dbRow] });
    const rows = await getMyInspectionsInRange('u-1', '2026-07-01', '2026-07-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskFieldId: 'tf-1',
      taskId: 't-1',
      customerName: 'לקוח א',
      taskTitle: 'בדיקת רעש',
      siteAddress: 'הרצל 5',
      siteCity: 'תל אביב',
      fieldStatus: 'CONFIRMED',
      family: 'noise',
      typeLabelHe: 'רעש',
    });
    expect(rows[0].scheduledStartAt).toBeInstanceOf(Date);
  });
});
