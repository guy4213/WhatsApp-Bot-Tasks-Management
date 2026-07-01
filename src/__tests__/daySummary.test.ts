/**
 * D2-T10 — day summary (menu item 7) tests.
 *
 * Coverage:
 *  - getFieldSummaryForWorkerOnDate: partitions FINISHED_FIELD (list) vs.
 *    WAITING_FOR_INFO (count), parameterized SQL, half-open Jerusalem window.
 *  - formatDayFieldSummary: 0/1/N finished, 0/N waiting-for-info,
 *    null-tolerant customer + type label.
 *  - renderDaySummaryFollowUpMenu: 4 numbered options in the exact spec §11
 *    order, Hebrew prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Query test ──────────────────────────────────────────────────────────────

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

import { getFieldSummaryForWorkerOnDate } from '../services/inspectionsQueries';
import { formatDayFieldSummary } from '../whatsapp/digestContent';
import {
  daySummaryFollowUpMenu,
  renderDaySummaryFollowUpMenu,
} from '../ai/menu';
import type { InspectionListItem } from '../services/inspectionsQueries';

describe('getFieldSummaryForWorkerOnDate', () => {
  it('partitions FINISHED_FIELD into `finished` list and counts WAITING_FOR_INFO', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 3,
      rows: [
        {
          taskFieldId: 'tf-1', customerName: 'משה כהן', siteAddress: 'רחוב 1',
          siteCity: 'רעננה', fieldStatus: 'FINISHED_FIELD', family: 'radiation',
          typeLabelHe: 'בדיקת קרינה',
        },
        {
          taskFieldId: 'tf-2', customerName: 'לקוח ב', siteAddress: 'רחוב 2',
          siteCity: 'הרצליה', fieldStatus: 'WAITING_FOR_INFO', family: 'noise',
          typeLabelHe: 'בדיקת רעש',
        },
        {
          taskFieldId: 'tf-3', customerName: 'לקוח ג', siteAddress: 'רחוב 3',
          siteCity: 'תל אביב', fieldStatus: 'FINISHED_FIELD', family: 'air',
          typeLabelHe: 'איכות אוויר',
        },
      ],
    });

    const result = await getFieldSummaryForWorkerOnDate('u-1', '2026-07-01');
    expect(result.finished).toHaveLength(2);
    expect(result.finished.map((r) => r.taskFieldId)).toEqual(['tf-1', 'tf-3']);
    expect(result.waitingForInfoCount).toBe(1);
  });

  it('empty result → { finished: [], waitingForInfoCount: 0 }', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const result = await getFieldSummaryForWorkerOnDate('u-1', '2026-07-01');
    expect(result.finished).toEqual([]);
    expect(result.waitingForInfoCount).toBe(0);
  });

  it('uses parameterized SQL + AT TIME ZONE Asia/Jerusalem half-open window; filters to FINISHED_FIELD + WAITING_FOR_INFO', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await getFieldSummaryForWorkerOnDate('u-42', '2026-07-01');
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/FROM\s+"TaskField"\s+tf/);
    expect(sql).toMatch(/JOIN\s+"Task"\s+t/);
    expect(sql).toMatch(/LEFT\s+JOIN\s+"Customer"\s+c/);
    expect(sql).toMatch(/JOIN\s+"InspectionType"\s+it/);
    expect(sql).toMatch(/t\."ownerId"\s*=\s*\$1/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(sql).toMatch(/tf\."scheduledStartAt"\s*>=/);
    expect(sql).toMatch(/tf\."scheduledStartAt"\s*</);
    expect(sql).toMatch(/'FINISHED_FIELD'/);
    expect(sql).toMatch(/'WAITING_FOR_INFO'/);
    expect(params).toEqual(['u-42', '2026-07-01']);
    // No string interpolation of user id / date into the SQL.
    expect(sql).not.toContain('u-42');
    expect(sql).not.toContain('2026-07-01');
  });
});

// ── Formatter test ──────────────────────────────────────────────────────────

describe('formatDayFieldSummary', () => {
  it('empty finished + zero waiting → "בוצעו: אין", no waiting line', () => {
    const text = formatDayFieldSummary([], 0, 'דני');
    expect(text).toContain('סיכום יום');
    expect(text).toContain('דני');
    expect(text).toContain('בוצעו: אין');
    expect(text).not.toContain('ממתינות למידע');
  });

  it('one finished + zero waiting', () => {
    const items: InspectionListItem[] = [
      {
        taskFieldId: 'tf-1', customerName: 'משה כהן', siteAddress: 'א', siteCity: 'רעננה',
        fieldStatus: 'FINISHED_FIELD', family: 'radiation', typeLabelHe: 'בדיקת קרינה',
      },
    ];
    const text = formatDayFieldSummary(items, 0, 'דני');
    expect(text).toContain('בוצעו: משה כהן (בדיקת קרינה)');
    expect(text).not.toContain('ממתינות למידע');
  });

  it('N finished + N waiting → comma-separated finished list + waiting line', () => {
    const items: InspectionListItem[] = [
      {
        taskFieldId: 'tf-1', customerName: 'משה', siteAddress: 'א', siteCity: 'רעננה',
        fieldStatus: 'FINISHED_FIELD', family: 'radiation', typeLabelHe: 'קרינה',
      },
      {
        taskFieldId: 'tf-2', customerName: 'יוסי', siteAddress: 'ב', siteCity: 'הרצליה',
        fieldStatus: 'FINISHED_FIELD', family: 'noise', typeLabelHe: 'רעש',
      },
      {
        taskFieldId: 'tf-3', customerName: 'שרה', siteAddress: 'ג', siteCity: 'תל אביב',
        fieldStatus: 'FINISHED_FIELD', family: 'air', typeLabelHe: 'איכות אוויר',
      },
    ];
    const text = formatDayFieldSummary(items, 2, 'דני');
    expect(text).toContain('בוצעו: משה (קרינה), יוסי (רעש), שרה (איכות אוויר)');
    expect(text).toContain('ממתינות למידע: 2');
  });

  it('null customer / empty type degrade to Hebrew placeholders', () => {
    const items: InspectionListItem[] = [
      {
        taskFieldId: 'tf-x', customerName: null, siteAddress: null, siteCity: null,
        fieldStatus: 'FINISHED_FIELD', family: 'general', typeLabelHe: '',
      },
    ];
    const text = formatDayFieldSummary(items, 0, 'דני');
    expect(text).toContain('לקוח לא ידוע');
    expect(text).toContain('(בדיקה)');
  });

  it('null user name → header omits the "— <name>" segment', () => {
    const text = formatDayFieldSummary([], 0, null);
    expect(text).toContain('סיכום יום');
    expect(text).not.toContain('—');
  });
});

// ── Menu render test ────────────────────────────────────────────────────────

describe('renderDaySummaryFollowUpMenu', () => {
  it('shows the 4 spec-§11 options in order with the Hebrew prompt', () => {
    const items = daySummaryFollowUpMenu();
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.label)).toEqual([
      'הכל בוצע',
      'חסר מידע לדוח',
      'צריך לחזור ללקוח',
      'בעיה פתוחה',
    ]);
    expect(items.map((i) => i.choice)).toEqual([
      'all_done',
      'missing_info',
      'callback_customer',
      'open_problem',
    ]);
    const text = renderDaySummaryFollowUpMenu();
    expect(text).toContain('יש מה להשלים?');
    for (const item of items) {
      expect(text).toContain(`${item.n}. ${item.label}`);
    }
  });
});
