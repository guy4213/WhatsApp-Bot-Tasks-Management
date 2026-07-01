/**
 * D3-T2 — formatSashaLeadsMorning pure formatter.
 */
import { describe, expect, it } from 'vitest';
import {
  formatSashaLeadsMorning,
  type LeadDigestRow,
  type LeadDigestSuggestion,
} from '../whatsapp/digestContent';

function makeLead(overrides: Partial<LeadDigestRow> = {}): LeadDigestRow {
  return {
    id: 'lead-1',
    fromName: 'דוד לוי',
    fromEmail: 'david@example.com',
    subject: 'בדיקת קרינה בנתניה',
    body: 'שלום, אנחנו גרים...',
    receivedAt: new Date('2026-07-01T06:00:00Z'),
    ...overrides,
  };
}

describe('formatSashaLeadsMorning', () => {
  it('renders header and numbered lead with suggestion', () => {
    const leads = [makeLead()];
    const suggestions: LeadDigestSuggestion[] = [
      { leadId: 'lead-1', workerName: 'דני', reason: 'מתמחה בקרינה' },
    ];
    const { text, params } = formatSashaLeadsMorning(leads, suggestions, { name: 'שי' });

    expect(text).toContain('בוקר טוב שי');
    expect(text).toContain('סיכום לידים');
    expect(text).toContain('שולח: דוד לוי (david@example.com)');
    expect(text).toContain('נושא: בדיקת קרינה בנתניה');
    expect(text).toContain('תוכן: שלום, אנחנו גרים...');
    expect(text).toContain('הצעת שיבוץ: דני — מתמחה בקרינה');
    expect(text).toContain('לשיבוץ ב-CRM');
    expect(params).toEqual(['שי', '1']);
  });

  it('renders "no match" suggestion when workerName is null', () => {
    const leads = [makeLead()];
    const suggestions: LeadDigestSuggestion[] = [
      { leadId: 'lead-1', workerName: null, reason: 'לא נמצאה התאמה' },
    ];
    const { text } = formatSashaLeadsMorning(leads, suggestions, { name: 'שי' });
    expect(text).toContain('הצעת שיבוץ: לא נמצאה התאמה');
  });

  it('omits suggestion block when no suggestion for lead', () => {
    const leads = [makeLead()];
    const { text } = formatSashaLeadsMorning(leads, [], { name: 'שי' });
    expect(text).not.toMatch(/הצעת שיבוץ/);
  });

  it('renders empty-leads message', () => {
    const { text, params } = formatSashaLeadsMorning([], [], { name: 'שי' });
    expect(text).toContain('לא התקבלו לידים ממתינים');
    expect(params).toEqual(['שי', '0']);
  });

  it('omits null optional fields (email, subject, body)', () => {
    const leads = [makeLead({ fromEmail: null, subject: null, body: null })];
    const { text } = formatSashaLeadsMorning(leads, [], { name: 'שי' });
    expect(text).toContain('שולח: דוד לוי');
    expect(text).not.toMatch(/נושא:/);
    expect(text).not.toMatch(/תוכן:/);
    expect(text).not.toMatch(/undefined/);
  });

  it('truncates long body', () => {
    const longBody = 'א'.repeat(500);
    const leads = [makeLead({ body: longBody })];
    const { text } = formatSashaLeadsMorning(leads, [], { name: 'שי' });
    expect(text).toContain('...');
    expect(text.indexOf('...')).toBeLessThan(text.length);
  });

  it('handles multiple leads with separate numbering and "שולח:" label', () => {
    const leads = [
      makeLead({ id: 'l1', fromName: 'ראשון' }),
      makeLead({ id: 'l2', fromName: 'שני' }),
    ];
    const { text } = formatSashaLeadsMorning(leads, [], { name: 'שי' });
    expect(text).toContain('1. שולח: ראשון');
    expect(text).toContain('2. שולח: שני');
  });

  it('returns empty buttons array (no CTA)', () => {
    const { buttons } = formatSashaLeadsMorning([], [], { name: 'שי' });
    expect(buttons).toEqual([]);
  });

  it('gracefully handles null user name', () => {
    const { text } = formatSashaLeadsMorning([], [], { name: null });
    expect(text).toContain('בוקר טוב');
    expect(text).not.toMatch(/null/);
  });
});
