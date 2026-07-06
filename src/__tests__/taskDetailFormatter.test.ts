/**
 * Pure unit tests for the enhanced due-date reminder formatters.
 * (TASK_ENHANCED_DUE_REMINDER.md — src/services/taskDetailFormatter.ts)
 */
import { describe, it, expect } from 'vitest';
import { formatShortDateTimeIL } from '../ai/inspectionFormatters';
import {
  type TaskDetailForReminder,
  DUE_REMINDER_V2_TEMPLATE_BODY,
  formatTaskReminderBody,
  reminderTemplateParams,
  formatTaskDetailsExtended,
  truncateForTemplate,
  buildCrmTaskUrl,
} from '../services/taskDetailFormatter';

const DUE = new Date('2026-07-06T11:00:00Z');

function makeDetails(overrides: Partial<TaskDetailForReminder> = {}): TaskDetailForReminder {
  return {
    taskId: 'task-abc123',
    taskTitle: 'בדיקת מעלית שנתית',
    customerName: 'משה כהן',
    customerPhone: '03-1234567',
    contactName: 'דנה לוי',
    contactPhone: '050-7654321',
    dueDate: DUE,
    assignedTo: 'יוסי אחראי',
    description: 'לבדוק את מערכת הבלמים',
    processNotes: 'הלקוח ביקש להתקשר לפני',
    address: 'הרצל 10',
    city: 'תל אביב',
    status: 'OPEN',
    ...overrides,
  };
}

/** Independent substitution — deliberately NOT the formatter's own, so this is
 *  a real regression guard for the freeform/template consistency invariant. */
function substituteTemplate(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? '');
}

describe('formatTaskReminderBody — short reminder body', () => {
  it('renders all 10 short-body fields with real values', () => {
    const text = formatTaskReminderBody(makeDetails(), 'https://crm/tasks/task-abc123');
    expect(text).toContain('🔔 תזכורת משימה');
    expect(text).toContain('כותרת: בדיקת מעלית שנתית');
    expect(text).toContain('לקוח: משה כהן');
    expect(text).toContain('טלפון לקוח: 03-1234567');
    expect(text).toContain('איש קשר: דנה לוי');
    expect(text).toContain('טלפון איש קשר: 050-7654321');
    expect(text).toContain(`תאריך/שעה: ${formatShortDateTimeIL(DUE)}`);
    expect(text).toContain('אחראי: יוסי אחראי');
    expect(text).toContain('תיאור קצר:\nלבדוק את מערכת הבלמים');
    expect(text).toContain('הערות:\nהלקוח ביקש להתקשר לפני');
    expect(text).toContain('📋 לפתיחת המשימה ב-CRM:\nhttps://crm/tasks/task-abc123');
    // static trailing line (satisfies Meta's no-trailing-variable rule)
    expect(text).toContain('יום עבודה טוב.');
  });

  it('renders — for every empty optional field, including crmUrl', () => {
    const text = formatTaskReminderBody(
      makeDetails({
        customerName: null, customerPhone: null, contactName: null,
        contactPhone: null, assignedTo: null, description: null, processNotes: null,
      }),
      null,
    );
    expect(text).toContain('לקוח: —');
    expect(text).toContain('טלפון לקוח: —');
    expect(text).toContain('איש קשר: —');
    expect(text).toContain('טלפון איש קשר: —');
    expect(text).toContain('אחראי: —');
    expect(text).toContain('תיאור קצר:\n—');
    expect(text).toContain('הערות:\n—');
    expect(text).toContain('📋 לפתיחת המשימה ב-CRM:\n—');
  });

  it('treats whitespace-only fields as empty (—)', () => {
    const text = formatTaskReminderBody(makeDetails({ customerName: '   ', contactName: '\t' }), null);
    expect(text).toContain('לקוח: —');
    expect(text).toContain('איש קשר: —');
  });
});

describe('truncateForTemplate + reminder truncation', () => {
  it('truncates to 200 chars appending …', () => {
    const long = 'א'.repeat(250);
    const out = truncateForTemplate(long, 200);
    expect([...out]).toHaveLength(201); // 200 chars + the … char
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves short strings unchanged', () => {
    expect(truncateForTemplate('קצר', 200)).toBe('קצר');
  });

  it('renders — for null/empty', () => {
    expect(truncateForTemplate(null, 200)).toBe('—');
    expect(truncateForTemplate('   ', 200)).toBe('—');
  });

  it('reminder body truncates a long description with …', () => {
    const long = 'ב'.repeat(300);
    const text = formatTaskReminderBody(makeDetails({ description: long }), null);
    expect(text).toContain('…');
    expect(text).not.toContain('ב'.repeat(300));
  });
});

describe('formatTaskDetailsExtended — extended message', () => {
  it('renders all extended fields incl. address/city, status label, full description', () => {
    const text = formatTaskDetailsExtended(makeDetails(), 'https://crm/tasks/task-abc123');
    expect(text).toContain('🔍 פרטי המשימה');
    expect(text).toContain('כותרת: בדיקת מעלית שנתית');
    expect(text).toContain('לקוח: משה כהן');
    expect(text).toContain('טלפון לקוח: 03-1234567');
    expect(text).toContain('איש קשר: דנה לוי');
    expect(text).toContain('טלפון איש קשר: 050-7654321');
    expect(text).toContain('כתובת/עיר: הרצל 10, תל אביב');
    expect(text).toContain('אחראי: יוסי אחראי');
    expect(text).toContain('סטטוס: פתוחה');
    expect(text).toContain(`תאריך יעד: ${formatShortDateTimeIL(DUE)}`);
    expect(text).toContain('תיאור מלא:\nלבדוק את מערכת הבלמים');
    expect(text).toContain('הערות פנימיות / הערות תהליך:\nהלקוח ביקש להתקשר לפני');
    expect(text).toContain('📋 לפתיחת המשימה ב-CRM:\nhttps://crm/tasks/task-abc123');
  });

  it('shows FULL (untruncated) description — the point of "more details"', () => {
    const long = 'ג'.repeat(300);
    const text = formatTaskDetailsExtended(makeDetails({ description: long }), null);
    expect(text).toContain(long);       // full, not cut
    expect(text).not.toContain('…');
  });

  it('renders — under the CRM header when crmUrl is null', () => {
    const text = formatTaskDetailsExtended(makeDetails(), null);
    expect(text).toContain('📋 לפתיחת המשימה ב-CRM:\n—');
  });

  it('address/city both empty → —', () => {
    const text = formatTaskDetailsExtended(makeDetails({ address: null, city: null }), null);
    expect(text).toContain('כתובת/עיר: —');
  });

  it('only city present → shows just the city', () => {
    const text = formatTaskDetailsExtended(makeDetails({ address: null, city: 'חיפה' }), null);
    expect(text).toContain('כתובת/עיר: חיפה');
  });
});

describe('status translation', () => {
  it.each([
    ['OPEN', 'פתוחה'],
    ['IN_PROGRESS', 'בטיפול'],
    ['DONE', 'הושלמה'],
    ['BLOCKED', 'חסום'],
  ])('translates %s → %s', (raw, he) => {
    const text = formatTaskDetailsExtended(makeDetails({ status: raw }), null);
    expect(text).toContain(`סטטוס: ${he}`);
  });

  it('falls through to the raw value for an unknown status', () => {
    const text = formatTaskDetailsExtended(makeDetails({ status: 'ARCHIVED' }), null);
    expect(text).toContain('סטטוס: ARCHIVED');
  });

  it('empty status → —', () => {
    const text = formatTaskDetailsExtended(makeDetails({ status: '' }), null);
    expect(text).toContain('סטטוס: —');
  });
});

describe('buildCrmTaskUrl', () => {
  const KEY = 'CRM_TASK_URL_TEMPLATE';
  it('returns null when env unset', () => {
    delete process.env[KEY];
    expect(buildCrmTaskUrl('abc')).toBeNull();
  });
  it('returns null when the template lacks {taskId}', () => {
    process.env[KEY] = 'https://crm/tasks/fixed';
    expect(buildCrmTaskUrl('abc')).toBeNull();
    delete process.env[KEY];
  });
  it('substitutes {taskId} (URL-encoded) when set', () => {
    process.env[KEY] = 'https://crm/tasks/{taskId}';
    expect(buildCrmTaskUrl('a b/c')).toBe('https://crm/tasks/a%20b%2Fc');
    delete process.env[KEY];
  });
});

// ── The consistency invariant (100 % coverage requirement) ──────────────────
describe('freeform ↔ template consistency invariant', () => {
  it('substituting reminderTemplateParams into the template body === formatTaskReminderBody', () => {
    for (const d of [
      makeDetails(),
      makeDetails({ customerName: null, description: null, processNotes: null }),
      makeDetails({ description: 'ד'.repeat(400), processNotes: 'ה'.repeat(400) }),
    ]) {
      for (const crmUrl of ['https://crm/tasks/x', null]) {
        const params = reminderTemplateParams(d, crmUrl);
        const substituted = substituteTemplate(DUE_REMINDER_V2_TEMPLATE_BODY, params);
        expect(substituted).toBe(formatTaskReminderBody(d, crmUrl));
      }
    }
  });

  it('reminderTemplateParams returns exactly 10 params, none empty (Meta rejects empty vars)', () => {
    const params = reminderTemplateParams(
      makeDetails({ customerName: null, customerPhone: null, contactName: null, contactPhone: null, assignedTo: null, description: null, processNotes: null }),
      null,
    );
    expect(params).toHaveLength(10);
    for (const p of params) expect(p.length).toBeGreaterThan(0); // '—' for empties, never ''
  });
});
