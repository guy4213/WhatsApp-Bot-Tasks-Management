/**
 * Pure formatters for the enhanced CRM due-date reminder (TASK_ENHANCED_DUE_REMINDER.md).
 *
 * NO database or network access here — trivially unit-testable. The only import
 * is `formatShortDateTimeIL` (pure, Intl-based) for the due-date rendering.
 *
 * ── Single source of truth / consistency invariant ──────────────────────────
 * The reminder must render byte-identically on both delivery paths:
 *   • Freeform (in 24h window) → `formatTaskReminderBody(d, crmUrl)` as text.
 *   • Template  (out of window) → Meta renders `DUE_REMINDER_V2_TEMPLATE_BODY`
 *     with the params from `reminderTemplateParams(d, crmUrl)`.
 * To make this impossible to drift, `formatTaskReminderBody` is DEFINED as the
 * substitution of `reminderTemplateParams(...)` into `DUE_REMINDER_V2_TEMPLATE_BODY`.
 * Both the submission script and the tests reference the same frozen body.
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
// Meta rejects a body that starts or ends with a variable, so it ends with the
// static "יום עבודה טוב." line AFTER {{10}}. `formatTaskReminderBody` shares this
// exact structure (including that trailing line) so both delivery paths match.
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
  '📋 לפתיחת המשימה ב-CRM:\n{{10}}\n\n' +
  'יום עבודה טוב.';

/** Number of body variables the template expects. */
export const DUE_REMINDER_V2_PARAM_COUNT = 10;

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
 * The 10 body params for `due_reminder_v2`, in template order. Substituting
 * these into `DUE_REMINDER_V2_TEMPLATE_BODY` yields exactly
 * `formatTaskReminderBody(d, crmUrl)` — the two are mechanically linked below.
 *
 * `description` and `processNotes` are truncated to 200 chars so the assembled
 * template body stays well under Meta's ~1024-char limit. `crmUrl` becomes `—`
 * when null (Meta rejects empty template variables).
 */
export function reminderTemplateParams(d: TaskDetailForReminder, crmUrl: string | null): string[] {
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
    orDash(crmUrl),                              // {{10}}
  ];
}

/**
 * Short reminder body — identical text on both delivery paths. Defined as the
 * substitution of `reminderTemplateParams` into the frozen template body, so it
 * can never drift from what Meta renders.
 */
export function formatTaskReminderBody(d: TaskDetailForReminder, crmUrl: string | null): string {
  return substitute(DUE_REMINDER_V2_TEMPLATE_BODY, reminderTemplateParams(d, crmUrl));
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
