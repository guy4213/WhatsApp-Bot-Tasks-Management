/**
 * routerManagerDisplay.test.ts — unit tests for the manager-menu display helpers
 * defined in src/ai/inspectionFormatters.ts.
 *
 * Covers:
 *  - hebrewShortLabel: emoji stripping, CRM suffix removal, fallback, truncation
 *  - formatHebrewDateTime: Hebrew DOW + Asia/Jerusalem timezone formatting
 *  - formatInspectionListRow: 2-line row shape, with/without worker/date
 *  - formatInspectionDetail: structured detail block, notes section, null omission
 *  - formatLeadListRow: 2-line lead row
 */
import { describe, expect, it } from 'vitest';
import {
  hebrewShortLabel,
  formatHebrewDateTime,
  formatInspectionListRow,
  formatInspectionDetail,
  formatLeadListRow,
  type InspectionListRowData,
  type InspectionDetailData,
  type LeadListRowData,
} from '../ai/inspectionFormatters';

// ── hebrewShortLabel ──────────────────────────────────────────────────────────

describe('hebrewShortLabel', () => {
  it('strips emoji prefix from task title', () => {
    expect(hebrewShortLabel('🧪בדיקת רעש', 'רעש')).toBe('בדיקת רעש');
  });

  it('strips CRM trailing suffix with em-dash', () => {
    const title = '🧪בדיקת-שדה — רעש – בדיקת רעש ממעלית — יאיר — 2026-07-01';
    const result = hebrewShortLabel(title, 'רעש');
    expect(result).not.toMatch(/2026-07-01/);
    expect(result).not.toMatch(/יאיר/);
    expect(result.trim()).toBeTruthy();
  });

  it('falls back to inspectionTypeLabelHe when taskTitle is null', () => {
    expect(hebrewShortLabel(null, 'בדיקת קרינה')).toBe('בדיקת קרינה');
  });

  it('falls back to inspectionTypeLabelHe when taskTitle is undefined', () => {
    expect(hebrewShortLabel(undefined, 'בדיקת קרינה')).toBe('בדיקת קרינה');
  });

  it('falls back to inspectionTypeLabelHe when taskTitle is empty string', () => {
    expect(hebrewShortLabel('', 'בדיקת קרינה')).toBe('בדיקת קרינה');
  });

  it('falls back to inspectionTypeLabelHe when taskTitle is only whitespace', () => {
    expect(hebrewShortLabel('   ', 'בדיקת קרינה')).toBe('בדיקת קרינה');
  });

  it('returns the FULL text — no truncation (product owner UX rule)', () => {
    const longTitle = 'א'.repeat(200);
    const result = hebrewShortLabel(longTitle, 'fallback');
    expect(result).toBe(longTitle);
    expect(result.length).toBe(200);
    expect(result.endsWith('…')).toBe(false);
  });

  it('uses the label when taskTitle is just an emoji', () => {
    expect(hebrewShortLabel('🔍', 'קרינה')).toBe('קרינה');
  });

  it('strips emoji and retains the text portion', () => {
    const result = hebrewShortLabel('📋 בדיקת רעש ממעלית', 'fallback');
    expect(result).toBe('בדיקת רעש ממעלית');
  });
});

// ── formatHebrewDateTime ──────────────────────────────────────────────────────

describe('formatHebrewDateTime', () => {
  // 2026-07-01 is a Wednesday (in UTC and Jerusalem)
  it('formats a Date object with Hebrew DOW and Jerusalem timezone', () => {
    // 2026-07-01T06:00:00Z = 09:00 Jerusalem time (UTC+3 in summer)
    const d = new Date('2026-07-01T06:00:00Z');
    const result = formatHebrewDateTime(d);
    // Should contain the date parts
    expect(result).toContain('01/07/2026');
    expect(result).toContain('09:00');
    // Hebrew DOW for Wednesday = ד׳
    expect(result).toContain('ד׳');
  });

  it('accepts an ISO string', () => {
    const result = formatHebrewDateTime('2026-07-01T06:00:00Z');
    expect(result).toContain('2026');
    expect(result).toContain('09:00');
  });

  it('returns format "DOW DD/MM/YYYY, HH:MM"', () => {
    const d = new Date('2026-07-05T07:00:00Z'); // Sunday July 5 = 10:00 Jerusalem
    const result = formatHebrewDateTime(d);
    // Sunday = א׳
    expect(result).toContain('א׳');
    expect(result).toContain('05/07/2026');
    expect(result).toContain('10:00');
  });
});

// ── formatInspectionListRow ───────────────────────────────────────────────────

describe('formatInspectionListRow', () => {
  const baseRow: InspectionListRowData = {
    taskTitle: null,
    typeLabelHe: 'בדיקת רעש',
    timeHm: '09:00',
    siteCity: 'רמת גן',
    fieldStatus: 'CONFIRMED',
  };

  it('returns one field per line (product owner UX rule)', () => {
    const result = formatInspectionListRow(baseRow);
    const lines = result.split('\n');
    // At minimum: type + time + city + status = 4 lines. Date not present in baseRow.
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  it('line 1 is "סוג בדיקה: <label>" (standard vocabulary)', () => {
    const result = formatInspectionListRow(baseRow);
    expect(result.split('\n')[0]).toBe('סוג בדיקה: בדיקת רעש');
  });

  it('each field is on its own line — time, city, status separately', () => {
    const result = formatInspectionListRow(baseRow);
    expect(result).toContain('\nשעה: 09:00');
    expect(result).toContain('\nעיר: רמת גן');
    expect(result).toContain('\nסטטוס: אושרה'); // CONFIRMED → 'אושרה'
  });

  it('uses dateStr for DD/MM when provided', () => {
    const row: InspectionListRowData = { ...baseRow, dateStr: '2026-07-01' };
    const result = formatInspectionListRow(row);
    expect(result).toContain('01/07');
  });

  it('derives DD/MM from scheduledStartAt when dateStr is absent', () => {
    const row: InspectionListRowData = {
      ...baseRow,
      scheduledStartAt: new Date('2026-07-15T06:00:00Z'),
    };
    const result = formatInspectionListRow(row);
    expect(result).toContain('15/07');
  });

  it('shows worker name on its own line when showWorker=true', () => {
    const row: InspectionListRowData = { ...baseRow, workerName: 'דני' };
    const result = formatInspectionListRow(row, true);
    expect(result).toContain('\nשם עובד: דני');
  });

  it('does NOT show worker name when showWorker=false (default)', () => {
    const row: InspectionListRowData = { ...baseRow, workerName: 'דני' };
    const result = formatInspectionListRow(row);
    expect(result).not.toContain('דני');
  });

  it('shows "סוג בדיקה: <label>" derived from taskTitle (emoji + CRM suffix stripped)', () => {
    const row: InspectionListRowData = {
      ...baseRow,
      taskTitle: '🧪בדיקת קרינה — יאיר — 2026-07-01',
      typeLabelHe: 'fallback',
    };
    const result = formatInspectionListRow(row);
    expect(result.split('\n')[0]).toBe('סוג בדיקה: בדיקת קרינה');
  });

  it('falls back to "--:--" when timeHm is null', () => {
    const row: InspectionListRowData = { ...baseRow, timeHm: null };
    const result = formatInspectionListRow(row);
    expect(result).toContain('שעה: --:--');
  });

  it('omits city segment from line 2 when siteCity is null (no placeholder in list rows)', () => {
    const row: InspectionListRowData = { ...baseRow, siteCity: null };
    const result = formatInspectionListRow(row);
    // City is simply omitted from compact list rows; no "—" placeholder
    expect(result).not.toContain('עיר:');
    // Status is still present
    expect(result).toContain('סטטוס: אושרה');
  });
});

// ── formatInspectionDetail ────────────────────────────────────────────────────

describe('formatInspectionDetail', () => {
  const baseDetail: InspectionDetailData = {
    taskTitle: '🧪בדיקת רעש ממעלית — יאיר — 2026-07-01',
    typeLabelHe: 'רעש',
    workerName: 'יאיר',
    customerName: 'משה כהן',
    siteAddress: 'רחוב ביאליק 5',
    siteCity: 'רמת גן',
    fieldContactName: 'משה',
    fieldContactPhone: '050-1234567',
    fieldStatus: 'CONFIRMED',
    scheduledStartAt: new Date('2026-07-01T06:00:00Z'),
    specialInstructions: null,
    fieldNotes: null,
    problemNote: null,
  };

  it('first line is the stripped label (not raw CRM title)', () => {
    const result = formatInspectionDetail(baseDetail, 'actions');
    const lines = result.split('\n');
    // First line should be the cleaned label, not the raw CRM title
    expect(lines[0]).not.toContain('🧪');
    expect(lines[0]).not.toContain('2026-07-01');
    expect(lines[0]).not.toContain('יאיר — 2026');
  });

  it('includes worker name with descriptive label (שם עובד)', () => {
    const result = formatInspectionDetail(baseDetail, 'actions');
    expect(result).toContain('שם עובד:');
    expect(result).toContain('יאיר');
  });

  it('includes inspection type with descriptive label (סוג בדיקה)', () => {
    const result = formatInspectionDetail(baseDetail, 'actions');
    expect(result).toContain('סוג בדיקה:');
  });

  it('includes customer name with descriptive label (שם לקוח) when non-null', () => {
    const result = formatInspectionDetail(baseDetail, 'actions');
    expect(result).toContain('שם לקוח:');
    expect(result).toContain('משה כהן');
  });

  it('shows Hebrew placeholder "אין פרטי לקוח" when customerName is null (Rule 2)', () => {
    const detail: InspectionDetailData = { ...baseDetail, customerName: null };
    const result = formatInspectionDetail(detail, 'actions');
    expect(result).toContain('שם לקוח:');
    expect(result).toContain('אין פרטי לקוח');
  });

  it('includes address with descriptive label (כתובת האתר) combining siteAddress and siteCity', () => {
    const result = formatInspectionDetail(baseDetail, 'actions');
    expect(result).toContain('כתובת האתר:');
    expect(result).toContain('רחוב ביאליק 5');
    expect(result).toContain('רמת גן');
  });

  it('shows Hebrew placeholder "אין כתובת רשומה" when both siteAddress and siteCity are null', () => {
    const detail: InspectionDetailData = { ...baseDetail, siteAddress: null, siteCity: null };
    const result = formatInspectionDetail(detail, 'actions');
    expect(result).toContain('כתובת האתר:');
    expect(result).toContain('אין כתובת רשומה');
  });

  it('includes contact info with descriptive label (איש קשר) when both contact fields are present', () => {
    const result = formatInspectionDetail(baseDetail, 'actions');
    expect(result).toContain('איש קשר:');
    expect(result).toContain('משה');
    expect(result).toContain('050-1234567');
  });

  it('shows Hebrew placeholder "אין פרטי איש קשר" when both contact fields are null (Rule 2)', () => {
    const detail: InspectionDetailData = {
      ...baseDetail, fieldContactName: null, fieldContactPhone: null,
    };
    const result = formatInspectionDetail(detail, 'actions');
    expect(result).toContain('איש קשר:');
    expect(result).toContain('אין פרטי איש קשר');
  });

  it('includes status with descriptive label (סטטוס) in Hebrew', () => {
    const result = formatInspectionDetail(baseDetail, 'actions');
    expect(result).toContain('סטטוס:');
    expect(result).toContain('אושרה'); // CONFIRMED
  });

  it('combines specialInstructions + fieldNotes + problemNote under הערות', () => {
    const detail: InspectionDetailData = {
      ...baseDetail,
      specialInstructions: 'הנחיות מיוחדות',
      fieldNotes: 'הערות שטח',
      problemNote: 'יש בעיה',
    };
    const result = formatInspectionDetail(detail, 'actions');
    expect(result).toContain('הערות:');
    expect(result).toContain('הנחיות מיוחדות');
    expect(result).toContain('הערות שטח');
    expect(result).toContain('יש בעיה');
  });

  it('omits הערות section when all note fields are null', () => {
    const result = formatInspectionDetail(baseDetail, 'actions');
    expect(result).not.toContain('הערות:');
  });

  it('includes only non-null notes in הערות section', () => {
    const detail: InspectionDetailData = {
      ...baseDetail,
      specialInstructions: 'הנחיות',
      fieldNotes: null,
      problemNote: null,
    };
    const result = formatInspectionDetail(detail, 'actions');
    expect(result).toContain('הערות:');
    expect(result).toContain('הנחיות');
  });

  it('ends with the actionsPrompt string', () => {
    const actions = 'מה תרצה לעשות?\n1. תיקון\n2. חזרה';
    const result = formatInspectionDetail(baseDetail, actions);
    expect(result.endsWith(actions)).toBe(true);
  });

  it('includes the scheduled date+time with label "תאריך ושעה"', () => {
    const result = formatInspectionDetail(baseDetail, 'actions');
    expect(result).toContain('תאריך ושעה:');
    // The date 2026-07-01T06:00:00Z = 09:00 Jerusalem time
    expect(result).toContain('09:00');
  });

  it('omits תאריך ושעה line when scheduledStartAt is null', () => {
    const detail: InspectionDetailData = { ...baseDetail, scheduledStartAt: null };
    const result = formatInspectionDetail(detail, 'actions');
    expect(result).not.toContain('תאריך ושעה:');
  });
});

// ── formatLeadListRow ─────────────────────────────────────────────────────────

describe('formatLeadListRow', () => {
  const baseRow: LeadListRowData = {
    fromName: 'משפחת כהן',
    fromEmail: 'david@example.com',
    subject: 'בדיקת קרינה בנתניה',
    receivedAt: new Date('2026-07-06T18:03:00Z'), // 21:03 Jerusalem time
  };

  it('returns one field per line — sender + subject + received', () => {
    const result = formatLeadListRow(baseRow);
    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
  });

  it('line 1 contains "שולח:" label with name and email in parentheses', () => {
    const result = formatLeadListRow(baseRow);
    const line1 = result.split('\n')[0];
    expect(line1).toContain('שולח:');
    expect(line1).toContain('משפחת כהן');
    expect(line1).toContain('(david@example.com)');
  });

  it('each field is on its own line — subject and received time separately', () => {
    const result = formatLeadListRow(baseRow);
    expect(result).toContain('\nנושא: בדיקת קרינה בנתניה');
    expect(result).toMatch(/\nהתקבל: 06\/07, 21:03/);
  });

  it('falls back to "—" when fromName is null', () => {
    const row: LeadListRowData = { ...baseRow, fromName: null };
    const result = formatLeadListRow(row);
    expect(result.split('\n')[0]).toContain('—');
  });

  it('omits email parentheses when fromEmail is null', () => {
    const row: LeadListRowData = { ...baseRow, fromEmail: null };
    const result = formatLeadListRow(row);
    // The "(email)" part should not appear, but "שולח:" should
    expect(result.split('\n')[0]).toContain('שולח:');
    expect(result.split('\n')[0]).not.toContain('(david');
  });

  it('shows "(ללא נושא)" when subject is null', () => {
    const row: LeadListRowData = { ...baseRow, subject: null };
    const result = formatLeadListRow(row);
    expect(result).toContain('(ללא נושא)');
  });

  it('omits date/time when receivedAt is null', () => {
    const row: LeadListRowData = { ...baseRow, receivedAt: null };
    const result = formatLeadListRow(row);
    const line2 = result.split('\n')[1];
    // Subject still appears, but no date
    expect(line2).toContain('בדיקת קרינה בנתניה');
    expect(line2).not.toContain('/');
  });
});
