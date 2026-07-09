/**
 * Pure formatters for the enhanced CRM due-date reminder (TASK_ENHANCED_DUE_REMINDER.md).
 *
 * NO database or network access here — trivially unit-testable. The only import
 * is `formatShortDateTimeIL` (pure, Intl-based) for the due-date rendering.
 *
 * ── Freeform ↔ template relationship ────────────────────────────────────────
 * The reminder must render consistently on both delivery paths:
 *   • Freeform (in 24h window) → `formatTaskReminderBody(d, crmUrl)` as text.
 *   • Template  (out of window) → Meta renders `DUE_REMINDER_V2_TEMPLATE_BODY`
 *     with the params from `reminderTemplateParams(d)`, PLUS a URL button that
 *     opens the CRM task.
 * The freeform path can't render buttons, so `formatTaskReminderBody` builds
 * the template body via substitution AND injects the CRM URL as a text section
 * before the trailing salutation — that's the equivalent of the URL button on
 * the template side. The template body itself has no {{10}} / CRM section.
 */
import { formatShortDateTimeIL } from '../ai/inspectionFormatters';

/** Em-dash rendered for every empty/null field. */
const EM_DASH = '—';

export interface TaskDetailForReminder {
  taskId: string;
  taskTitle: string;
  customerName: string | null;
  customerPhone: string | null;
  contactName: string | null;
  contactPhone: string | null;
  dueDate: Date;
  assignedTo: string | null;
  description: string | null;   // pre-truncation value; the reminder formatter truncates
  processNotes: string | null;  // pre-truncation value; the reminder formatter truncates
  address: string | null;
  city: string | null;
  status: string;               // Task.status raw value (e.g. 'OPEN')
}

// ── Frozen template body (must match the submitted due_reminder_v2 body) ──────
//
// The template has 9 body vars + a dynamic URL button that opens the CRM task.
// Meta rejects a body that ends with a variable, so it closes with the static
// "יום עבודה טוב." line. The CRM link is NOT in the body — it lives in the URL
// button component instead. The freeform path injects the URL as text before
// the trailing salutation (freeform can't render buttons).
export const DUE_REMINDER_V2_TEMPLATE_BODY =
  '🔔 תזכורת משימה\n\n' +
  'כותרת: {{1}}\n' +
  'לקוח: {{2}}\n' +
  'טלפון לקוח: {{3}}\n' +
  'איש קשר: {{4}}\n' +
  'טלפון איש קשר: {{5}}\n' +
  'תאריך/שעה: {{6}}\n' +
  'אחראי: {{7}}\n\n' +
  'תיאור קצר:\n{{8}}\n\n' +
  'הערות:\n{{9}}\n\n' +
  'יום עבודה טוב.';

/** Number of body variables the template expects. */
export const DUE_REMINDER_V2_PARAM_COUNT = 9;

/** The trailing static line — freeform injects the CRM URL section right before it. */
const REMINDER_TRAILING_LINE = '\n\nיום עבודה טוב.';

// ── Small helpers ─────────────────────────────────────────────────────────────

/** Trim; render `—` when the result is empty. */
function orDash(s: string | null | undefined): string {
  const v = (s ?? '').trim();
  return v === '' ? EM_DASH : v;
}

/**
 * Truncate a string to at most `max` UTF-8 characters, appending `…` when cut.
 * Empty/null renders as `—`. Char-counting uses the spread iterator so Hebrew
 * letters and emoji count as one character each. Exported for testability.
 */
export function truncateForTemplate(s: string | null, max: number): string {
  const v = (s ?? '').trim();
  if (v === '') return EM_DASH;
  const chars = [...v];
  if (chars.length <= max) return v;
  return chars.slice(0, max).join('') + '…';
}

/** Substitute {{1}}..{{n}} in a template body with the given ordered params. */
function substitute(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? '');
}

/** Task.status → Hebrew label; unknown values fall through to the raw string. */
const STATUS_HE: Record<string, string> = {
  OPEN: 'פתוחה',
  IN_PROGRESS: 'בטיפול',
  DONE: 'הושלמה',
  BLOCKED: 'חסום',
};
function translateStatus(raw: string): string {
  const v = (raw ?? '').trim();
  if (v === '') return EM_DASH;
  return STATUS_HE[v] ?? v;
}

/**
 * Build the CRM task URL from the `CRM_TASK_URL_TEMPLATE` env var, substituting
 * `{taskId}`. Returns null when the env var is unset or lacks the placeholder —
 * callers then render `—` (Phase 2: product provides the URL structure).
 */
export function buildCrmTaskUrl(taskId: string): string | null {
  const template = process.env.CRM_TASK_URL_TEMPLATE;
  if (!template || !template.includes('{taskId}')) return null;
  return template.replace('{taskId}', encodeURIComponent(taskId));
}

// ── Public formatters ─────────────────────────────────────────────────────────

/**
 * The 9 body params for `due_reminder_v2`, in template order. Substituting
 * these into `DUE_REMINDER_V2_TEMPLATE_BODY` yields the template body text
 * (without the CRM link section — the link is a URL button on the template
 * side, added on send via `templateButtonParams`).
 *
 * `description` and `processNotes` are truncated to 200 chars so the assembled
 * template body stays well under Meta's ~1024-char limit.
 */
export function reminderTemplateParams(d: TaskDetailForReminder): string[] {
  return [
    orDash(d.taskTitle),                        // {{1}}
    orDash(d.customerName),                      // {{2}}
    orDash(d.customerPhone),                     // {{3}}
    orDash(d.contactName),                       // {{4}}
    orDash(d.contactPhone),                      // {{5}}
    formatShortDateTimeIL(d.dueDate),            // {{6}}
    orDash(d.assignedTo),                        // {{7}}
    truncateForTemplate(d.description, 200),     // {{8}}
    truncateForTemplate(d.processNotes, 200),    // {{9}}
  ];
}

/**
 * Short reminder body for the freeform (in-24h-window) path. Builds the shared
 * template body text via substitution, then injects the CRM URL section before
 * the trailing salutation — freeform can't render URL buttons, so the link is
 * surfaced as clickable text instead.
 */
export function formatTaskReminderBody(d: TaskDetailForReminder, crmUrl: string | null): string {
  const substituted = substitute(DUE_REMINDER_V2_TEMPLATE_BODY, reminderTemplateParams(d));
  const crmSection = `\n\n📋 לפתיחת המשימה ב-CRM:\n${orDash(crmUrl)}`;
  const idx = substituted.lastIndexOf(REMINDER_TRAILING_LINE);
  if (idx < 0) return substituted + crmSection;
  return substituted.slice(0, idx) + crmSection + substituted.slice(idx);
}

/**
 * Extended detail message — sent (freeform, no Meta template involved) when the
 * user taps "פרטים נוספים" or types "פרטים" / "פרטים נוספים". Shows the FULL
 * description / process notes (untruncated) — that is the point of "more
 * details" vs. the truncated teaser in the short reminder.
 */
export function formatTaskDetailsExtended(d: TaskDetailForReminder, crmUrl: string | null): string {
  const addressCity = [d.address, d.city]
    .map((s) => (s ?? '').trim())
    .filter((s) => s !== '')
    .join(', ');

  return (
    '🔍 פרטי המשימה\n\n' +
    `כותרת: ${orDash(d.taskTitle)}\n` +
    `לקוח: ${orDash(d.customerName)}\n` +
    `טלפון לקוח: ${orDash(d.customerPhone)}\n` +
    `איש קשר: ${orDash(d.contactName)}\n` +
    `טלפון איש קשר: ${orDash(d.contactPhone)}\n` +
    `כתובת/עיר: ${orDash(addressCity)}\n` +
    `אחראי: ${orDash(d.assignedTo)}\n` +
    `סטטוס: ${translateStatus(d.status)}\n` +
    `תאריך יעד: ${formatShortDateTimeIL(d.dueDate)}\n\n` +
    'תיאור מלא:\n' +
    `${orDash(d.description)}\n\n` +
    'הערות פנימיות / הערות תהליך:\n' +
    `${orDash(d.processNotes)}\n\n` +
    '📋 לפתיחת המשימה ב-CRM:\n' +
    `${orDash(crmUrl)}`
  );
}
