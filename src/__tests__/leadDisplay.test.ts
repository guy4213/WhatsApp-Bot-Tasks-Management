/**
 * Tests for the lead display formatters (formatLeadListRowCompact / formatLeadDetailCompact).
 *
 * Pure unit tests — no DB, no mocks needed.
 */
import { describe, expect, it } from 'vitest';
import { formatLeadListRowCompact, formatLeadDetailCompact } from '../whatsapp/leadDisplay';
import type { IncomingLeadRow } from '../services/incomingLeads';
import type { LeadEnrichment } from '../services/leadCategorizer';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeLead(overrides: Partial<IncomingLeadRow> = {}): IncomingLeadRow {
  return {
    id: 'lead-uuid-1234',
    subject: 'בדיקת קרינה',
    body: 'צריך בדיקת קרינה בדירה.',
    fromName: 'ישראל ישראלי',
    fromEmail: 'israel@example.com',
    receivedAt: new Date('2026-07-01T10:00:00Z'), // 13:00 IL (UTC+3)
    status: null,
    ownerId: null,
    taskId: 'task-uuid-5678',
    ...overrides,
  };
}

function makeEnrichment(overrides: Partial<LeadEnrichment> = {}): LeadEnrichment {
  return {
    category: 'radiation',
    categoryHe: 'קרינה',
    inspectionType: { id: 'it-1', code: '9', labelHe: 'קרינה – בדיקת קרינה אלקטרומגנטית מרשת החשמל' },
    location: 'תל אביב',
    ...overrides,
  };
}

/** Jerusalem UTC+3 (standard time) — 2026-07-01 13:00 local */
const NOW_SAME_DAY = new Date('2026-07-01T14:30:00Z'); // 17:30 IL, same day

// ── formatLeadListRowCompact ───────────────────────────────────────────────────

describe('formatLeadListRowCompact — structure', () => {
  it('contains all required labeled lines as separate lines', () => {
    const text = formatLeadListRowCompact(makeLead(), makeEnrichment(), NOW_SAME_DAY);
    const lines = text.split('\n');
    expect(lines.some((l) => l.startsWith('שם:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('קטגוריית בדיקה:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('סוג בדיקה:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('מיקום:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('התקבל:'))).toBe(true);
  });

  it('does NOT contain the word "משפחה"', () => {
    const text = formatLeadListRowCompact(makeLead(), makeEnrichment(), NOW_SAME_DAY);
    expect(text).not.toContain('משפחה');
  });

  it('does NOT contain the lead UUID', () => {
    const text = formatLeadListRowCompact(makeLead(), makeEnrichment(), NOW_SAME_DAY);
    expect(text).not.toContain('lead-uuid-1234');
  });

  it('does NOT contain the task UUID', () => {
    const text = formatLeadListRowCompact(makeLead(), makeEnrichment(), NOW_SAME_DAY);
    expect(text).not.toContain('task-uuid-5678');
  });

  it('does NOT contain the full body text', () => {
    const lead = makeLead({ body: 'שיטת הבדיקה המלאה היא ארוכה מאוד ומפורטת' });
    const text = formatLeadListRowCompact(lead, makeEnrichment(), NOW_SAME_DAY);
    // The list row should never show the body at all.
    expect(text).not.toContain('שיטת הבדיקה');
  });
});

describe('formatLeadListRowCompact — assigned lead', () => {
  it('shows "סטטוס: משויך" instead of "ממתין:" when ownerId is set', () => {
    const lead = makeLead({ ownerId: 'owner-u1' });
    const text = formatLeadListRowCompact(lead, makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('סטטוס: משויך');
    expect(text).not.toContain('ממתין:');
  });

  it('shows "ממתין:" when ownerId is null', () => {
    const text = formatLeadListRowCompact(makeLead(), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('ממתין:');
    expect(text).not.toContain('סטטוס: משויך');
  });
});

describe('formatLeadListRowCompact — waiting age', () => {
  it('shows "כרגע התקבל" when received less than 1 minute ago', () => {
    const receivedAt = new Date(NOW_SAME_DAY.getTime() - 30_000); // 30 seconds
    const text = formatLeadListRowCompact(makeLead({ receivedAt }), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('ממתין: כרגע התקבל');
  });

  it('shows "<M> דקות" for 20 minute wait', () => {
    const receivedAt = new Date(NOW_SAME_DAY.getTime() - 20 * 60_000);
    const text = formatLeadListRowCompact(makeLead({ receivedAt }), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('ממתין: 20 דקות');
  });

  it('shows "שעה ו־20 דקות" for 1h20min wait', () => {
    const receivedAt = new Date(NOW_SAME_DAY.getTime() - 80 * 60_000);
    const text = formatLeadListRowCompact(makeLead({ receivedAt }), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('ממתין: שעה ו־20 דקות');
  });

  it('shows "שעה" for exactly 1 hour', () => {
    const receivedAt = new Date(NOW_SAME_DAY.getTime() - 60 * 60_000);
    const text = formatLeadListRowCompact(makeLead({ receivedAt }), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('ממתין: שעה');
  });

  it('shows "<N> ימים" for multi-day wait', () => {
    const receivedAt = new Date(NOW_SAME_DAY.getTime() - 3 * 24 * 60 * 60_000);
    const text = formatLeadListRowCompact(makeLead({ receivedAt }), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('ממתין: 3 ימים');
  });

  it('shows "יום אחד" for exactly 1 day', () => {
    const receivedAt = new Date(NOW_SAME_DAY.getTime() - 24 * 60 * 60_000);
    const text = formatLeadListRowCompact(makeLead({ receivedAt }), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('ממתין: יום אחד');
  });
});

describe('formatLeadListRowCompact — received time format', () => {
  it('shows HH:MM for same-day lead', () => {
    // receivedAt = 13:00 IL (UTC+3 = 10:00 UTC), now = same day 17:30 IL
    const receivedAt = new Date('2026-07-01T10:00:00Z');
    const text = formatLeadListRowCompact(makeLead({ receivedAt }), makeEnrichment(), NOW_SAME_DAY);
    const line = text.split('\n').find((l) => l.startsWith('התקבל:')) ?? '';
    // Should be just HH:MM (no DD/MM prefix)
    expect(line).toMatch(/^התקבל: \d{2}:\d{2}$/);
  });

  it('shows "אתמול HH:MM" for yesterday', () => {
    // now = 2026-07-01 14:30 UTC (17:30 IL), receivedAt = 2026-06-30 10:00 UTC (13:00 IL yesterday)
    const receivedAt = new Date('2026-06-30T10:00:00Z');
    const text = formatLeadListRowCompact(makeLead({ receivedAt }), makeEnrichment(), NOW_SAME_DAY);
    const line = text.split('\n').find((l) => l.startsWith('התקבל:')) ?? '';
    expect(line).toMatch(/^התקבל: אתמול \d{2}:\d{2}$/);
  });

  it('shows "DD/MM HH:MM" for older lead', () => {
    const receivedAt = new Date('2026-06-25T10:00:00Z');
    const text = formatLeadListRowCompact(makeLead({ receivedAt }), makeEnrichment(), NOW_SAME_DAY);
    const line = text.split('\n').find((l) => l.startsWith('התקבל:')) ?? '';
    expect(line).toMatch(/^התקבל: \d{2}\/\d{2} \d{2}:\d{2}$/);
  });
});

describe('formatLeadListRowCompact — ambiguous type', () => {
  it('shows "לא זוהה בוודאות" when inspectionType is null', () => {
    const enrichment = makeEnrichment({ inspectionType: null });
    const text = formatLeadListRowCompact(makeLead(), enrichment, NOW_SAME_DAY);
    expect(text).toContain('סוג בדיקה: לא זוהה בוודאות');
  });
});

describe('formatLeadListRowCompact — null-safe', () => {
  it('shows "לא צוין" for missing fromName', () => {
    const lead = makeLead({ fromName: null });
    const text = formatLeadListRowCompact(lead, makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('שם: לא צוין');
  });

  it('shows "לא צוין" for missing location', () => {
    const enrichment = makeEnrichment({ location: null });
    const text = formatLeadListRowCompact(makeLead(), enrichment, NOW_SAME_DAY);
    expect(text).toContain('מיקום: לא צוין');
  });

  it('does not throw on empty enrichment', () => {
    const enrichment: LeadEnrichment = { category: null, categoryHe: 'לא זוהתה', inspectionType: null, location: null };
    expect(() => formatLeadListRowCompact(makeLead(), enrichment, NOW_SAME_DAY)).not.toThrow();
  });
});

// ── formatLeadDetailCompact ───────────────────────────────────────────────────

describe('formatLeadDetailCompact — structure', () => {
  it('starts with "פרטי ליד"', () => {
    const text = formatLeadDetailCompact(makeLead(), makeEnrichment(), NOW_SAME_DAY);
    expect(text.startsWith('פרטי ליד')).toBe(true);
  });

  it('contains all required labeled lines', () => {
    const text = formatLeadDetailCompact(makeLead(), makeEnrichment(), NOW_SAME_DAY);
    const lines = text.split('\n');
    expect(lines.some((l) => l.startsWith('שם:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('אימייל:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('קטגוריית בדיקה:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('סוג בדיקה:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('מיקום:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('התקבל:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('סטטוס:'))).toBe(true);
  });

  it('contains "תקציר הפנייה:" block', () => {
    const text = formatLeadDetailCompact(makeLead(), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('תקציר הפנייה:');
  });

  it('shows body preview (trimmed, ≤200 chars)', () => {
    const body = 'צריך בדיקת קרינה בדירה.';
    const text = formatLeadDetailCompact(makeLead({ body }), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain(body);
  });

  it('truncates body to 200 chars with "…" suffix', () => {
    const body = 'א'.repeat(250);
    const text = formatLeadDetailCompact(makeLead({ body }), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('…');
    // The preview should be exactly 200 chars + '…'
    const previewLine = text.split('תקציר הפנייה:\n')[1]?.split('\n')[0] ?? '';
    expect(previewLine.length).toBeLessThanOrEqual(202); // 200 + '…'
  });

  it('shows "אין תוכן" when body is null', () => {
    const text = formatLeadDetailCompact(makeLead({ body: null }), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('אין תוכן');
  });

  it('shows "אין תוכן" when body is empty after trim', () => {
    const text = formatLeadDetailCompact(makeLead({ body: '   ' }), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('אין תוכן');
  });

  it('does NOT contain the word "משפחה"', () => {
    const text = formatLeadDetailCompact(makeLead(), makeEnrichment(), NOW_SAME_DAY);
    expect(text).not.toContain('משפחה');
  });

  it('does NOT contain the lead UUID', () => {
    const text = formatLeadDetailCompact(makeLead(), makeEnrichment(), NOW_SAME_DAY);
    expect(text).not.toContain('lead-uuid-1234');
  });

  it('does NOT contain the task UUID', () => {
    const text = formatLeadDetailCompact(makeLead(), makeEnrichment(), NOW_SAME_DAY);
    expect(text).not.toContain('task-uuid-5678');
  });

  it('contains the action footer using non-numbered guidance (bare digits would collide with mgr_leads_pick_row indices)', () => {
    const text = formatLeadDetailCompact(makeLead(), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('מה תרצה לעשות?');
    // Non-numeric bullets: typing a bare digit at `mgr_leads_pick_row` re-picks
    // a lead from the list, so numbered actions here would be misleading.
    expect(text).toContain('כתוב "חזרה"');
    expect(text).toContain('לשיוך');
    expect(text).toContain('שיוך ליד לעובד');
    // The old numbered footer must not reappear.
    expect(text).not.toMatch(/^1\.\s+חזרה ללידים$/m);
    expect(text).not.toMatch(/^2\.\s+לשיוך ליד/m);
  });
});

describe('formatLeadDetailCompact — assigned lead', () => {
  it('shows "סטטוס: משויך" and NO "ממתין:" when ownerId set', () => {
    const lead = makeLead({ ownerId: 'owner-u1' });
    const text = formatLeadDetailCompact(lead, makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('סטטוס: משויך');
    expect(text).not.toContain('ממתין:');
  });

  it('shows "סטטוס: לא משויך" and "ממתין:" when unassigned', () => {
    const text = formatLeadDetailCompact(makeLead(), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('סטטוס: לא משויך');
    expect(text).toContain('ממתין:');
  });
});

describe('formatLeadDetailCompact — null-safe', () => {
  it('shows "שם: לא צוין" when fromName is null', () => {
    const text = formatLeadDetailCompact(makeLead({ fromName: null }), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('שם: לא צוין');
  });

  it('shows "אימייל: לא צוין" when fromEmail is null', () => {
    const text = formatLeadDetailCompact(makeLead({ fromEmail: null }), makeEnrichment(), NOW_SAME_DAY);
    expect(text).toContain('אימייל: לא צוין');
  });

  it('shows "מיקום: לא צוין" when location is null', () => {
    const enrichment = makeEnrichment({ location: null });
    const text = formatLeadDetailCompact(makeLead(), enrichment, NOW_SAME_DAY);
    expect(text).toContain('מיקום: לא צוין');
  });

  it('does not throw when all optional fields are null', () => {
    const lead = makeLead({ fromName: null, fromEmail: null, body: null });
    const enrichment: LeadEnrichment = { category: null, categoryHe: 'לא זוהתה', inspectionType: null, location: null };
    expect(() => formatLeadDetailCompact(lead, enrichment, NOW_SAME_DAY)).not.toThrow();
  });
});
