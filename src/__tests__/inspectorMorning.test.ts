/**
 * D2-T4 — inspector morning reminder tests (pure formatter).
 *
 * Coverage:
 *  - formatInspectorMorning: 0 items (empty-day message), 1 item, N items
 *    (numbered list + correct Hebrew status labels), missing customerName /
 *    siteAddress / siteCity degradation, all 8 actionable fieldStatus labels.
 *
 * Dispatcher-branch routing (non-ADMIN → inspector, ADMIN → legacy) is tested
 * in `inspectorMorningDispatcher.test.ts` — kept in a separate file because
 * `vi.mock('../whatsapp/digestContent', ...)` is hoisted for the whole file
 * and would otherwise replace the real formatter under test here.
 */
import { describe, expect, it } from 'vitest';
import { formatInspectorMorning, formatInspectorDayList } from '../whatsapp/digestContent';
import type { InspectionListItem } from '../services/inspectionsQueries';

describe('formatInspectorMorning', () => {
  it('renders a one-line empty-day message when there are no inspections', () => {
    const { text, params, buttons } = formatInspectorMorning([], { name: 'דני' });
    expect(text).toContain('בוקר טוב דני');
    expect(text).toContain('אין בדיקות משובצות להיום');
    // Numbered list markers must not appear on the empty path.
    expect(text).not.toContain('1.');
    expect(text).not.toContain('בחר מספר לעדכון סטטוס');
    expect(params).toEqual(['דני', '0']);
    expect(buttons).toEqual([]);
  });

  it('renders a single item with the numbered list + status-update CTA', () => {
    const items: InspectionListItem[] = [
      {
        taskFieldId: 'tf-1',
        customerName: 'משה כהן',
        siteAddress: 'אחוזה 100',
        siteCity: 'רעננה',
        fieldStatus: 'ASSIGNED',
        family: 'radiation',
        typeLabelHe: 'בדיקת קרינה',
      },
    ];
    const { text, params } = formatInspectorMorning(items, { name: 'דני' });
    expect(text).toContain('בוקר טוב דני');
    expect(text).toContain('הבדיקות שלך להיום:');
    expect(text).toContain('1. משה כהן — אחוזה 100, רעננה (בדיקת קרינה)');
    expect(text).toContain('סטטוס: משובצת');
    expect(text).toContain('בחר מספר לעדכון סטטוס');
    expect(text).toContain('יצאתי / הגעתי / סיימתי');
    expect(params).toEqual(['דני', '1']);
  });

  it('renders N items numbered in order with per-status Hebrew labels', () => {
    const items: InspectionListItem[] = [
      {
        taskFieldId: 'tf-1', customerName: 'לקוח א', siteAddress: 'רחוב 1',
        siteCity: 'תל אביב', fieldStatus: 'CONFIRMED', family: 'noise',
        typeLabelHe: 'בדיקת רעש',
      },
      {
        taskFieldId: 'tf-2', customerName: 'לקוח ב', siteAddress: 'רחוב 2',
        siteCity: 'הרצליה', fieldStatus: 'EN_ROUTE', family: 'radiation',
        typeLabelHe: 'בדיקת קרינה',
      },
      {
        taskFieldId: 'tf-3', customerName: 'לקוח ג', siteAddress: 'רחוב 3',
        siteCity: 'רעננה', fieldStatus: 'ARRIVED', family: 'air',
        typeLabelHe: 'איכות אוויר',
      },
    ];
    const { text, params } = formatInspectorMorning(items, { name: 'יוסי' });
    // Numbering + status label per row.
    expect(text).toContain('1. לקוח א — רחוב 1, תל אביב (בדיקת רעש)');
    expect(text).toContain('סטטוס: אושרה');
    expect(text).toContain('2. לקוח ב — רחוב 2, הרצליה (בדיקת קרינה)');
    expect(text).toContain('סטטוס: בדרך');
    expect(text).toContain('3. לקוח ג — רחוב 3, רעננה (איכות אוויר)');
    expect(text).toContain('סטטוס: באתר');
    expect(params).toEqual(['יוסי', '3']);
    // Order preservation: item 1 must appear before item 2 which must appear
    // before item 3 in the rendered text.
    const idx1 = text.indexOf('1. לקוח א');
    const idx2 = text.indexOf('2. לקוח ב');
    const idx3 = text.indexOf('3. לקוח ג');
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it('localizes all 8 actionable fieldStatus values to Hebrew', () => {
    const statuses: Array<[string, string]> = [
      ['ASSIGNED', 'משובצת'],
      ['CONFIRMED', 'אושרה'],
      ['EN_ROUTE', 'בדרך'],
      ['ARRIVED', 'באתר'],
      ['WAITING_FOR_INFO', 'ממתין למידע'],
      ['HAS_PROBLEM', 'עם בעיה'],
      ['NEEDS_MORE_INFO', 'צריך פרטים'],
      ['FINISHED_FIELD', 'הסתיים בשטח'],
    ];
    for (const [code, he] of statuses) {
      const items: InspectionListItem[] = [
        {
          taskFieldId: 't', customerName: 'ל', siteAddress: 'א',
          siteCity: 'ר', fieldStatus: code, family: 'general', typeLabelHe: 'ט',
        },
      ];
      const { text } = formatInspectorMorning(items, { name: 'ד' });
      expect(text).toContain(`סטטוס: ${he}`);
    }
  });

  it('degrades gracefully when customerName / siteAddress / siteCity are null', () => {
    const items: InspectionListItem[] = [
      {
        taskFieldId: 'tf-x', customerName: null, siteAddress: null, siteCity: null,
        fieldStatus: 'ASSIGNED', family: 'general', typeLabelHe: 'טיפוס',
      },
    ];
    const { text } = formatInspectorMorning(items, { name: 'דני' });
    expect(text).toContain('לקוח לא ידוע');
    expect(text).toContain('כתובת לא ידועה');
    // No comma-then-empty artifact from the city — the city segment is
    // omitted entirely when siteCity is null.
    expect(text).not.toContain(', (טיפוס)');
    expect(text).toContain('(טיפוס)');
  });
});

describe('formatInspectorDayList (menu items 1+2 — on-demand)', () => {
  it('empty list → friendly one-liner without "בוקר טוב"', () => {
    const todayText = formatInspectorDayList([], { when: 'today' });
    expect(todayText).toBe('אין בדיקות משובצות להיום.');
    expect(todayText).not.toContain('בוקר טוב');

    const tomorrowText = formatInspectorDayList([], { when: 'tomorrow' });
    expect(tomorrowText).toBe('אין בדיקות משובצות למחר.');
  });

  it('single item → numbered list with today header', () => {
    const items: InspectionListItem[] = [
      {
        taskFieldId: 'tf-1', customerName: 'לקוח א', siteAddress: 'רח\' הרצל 1',
        siteCity: 'תל אביב', fieldStatus: 'ASSIGNED', family: 'noise',
        typeLabelHe: 'בדיקת רעש',
      },
    ];
    const text = formatInspectorDayList(items, { when: 'today' });
    expect(text).toContain('הבדיקות שלך להיום:');
    expect(text).toContain('1. לקוח א — רח\' הרצל 1, תל אביב (בדיקת רעש)');
    expect(text).toContain('סטטוס: משובצת');
    expect(text).not.toContain('בוקר טוב');
    expect(text).not.toContain('בחר מספר לעדכון סטטוס');
  });

  it('tomorrow header + null fields degrade to placeholders', () => {
    const items: InspectionListItem[] = [
      {
        taskFieldId: 'tf-y', customerName: null, siteAddress: null, siteCity: null,
        fieldStatus: 'CONFIRMED', family: 'general', typeLabelHe: 'טיפוס',
      },
    ];
    const text = formatInspectorDayList(items, { when: 'tomorrow' });
    expect(text).toContain('הבדיקות שלך למחר:');
    expect(text).toContain('לקוח לא ידוע');
    expect(text).toContain('כתובת לא ידועה');
    expect(text).toContain('סטטוס: אושרה');
    expect(text).not.toContain(', (טיפוס)');
  });
});
