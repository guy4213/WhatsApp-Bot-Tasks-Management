/**
 * Canonical WhatsApp template name registry — intentionally dependency-free
 * (no DB / network / sender imports) so BOTH the runtime sender (templates.ts)
 * and the offline submission script (scripts/create-whatsapp-templates.ts) can
 * share one source of truth for template names + language without dragging in
 * the database layer.
 */

// The logical notifications the bot can send proactively.
export type NotificationKey =
  | 'DUEDATE_APPROVAL_REQUEST'
  | 'DUEDATE_APPROVED'
  | 'DUEDATE_REJECTED'
  | 'DUE_REMINDER'
  | 'DEADLINE_EXCEEDED'
  | 'DEADLINE_APPROACHING'
  | 'DAILY_SUMMARY'
  | 'TASK_COMPLETED'
  | 'REQUEST_EXPIRED'
  | 'REQUEST_EXPIRED_MANAGER';

// Default Meta template names (override individually via WHATSAPP_TEMPLATE_<KEY>).
export const DEFAULT_TEMPLATE_NAMES: Record<NotificationKey, string> = {
  DUEDATE_APPROVAL_REQUEST: 'duedate_approval_request',
  DUEDATE_APPROVED:         'duedate_approved',
  DUEDATE_REJECTED:         'duedate_rejected',
  DUE_REMINDER:             'due_reminder',
  DEADLINE_EXCEEDED:        'deadline_exceeded',
  DEADLINE_APPROACHING:     'deadline_approaching',
  DAILY_SUMMARY:            'daily_summary',
  TASK_COMPLETED:           'task_completed',
  REQUEST_EXPIRED:          'request_expired',
  REQUEST_EXPIRED_MANAGER:  'request_expired_manager',
};

/** Resolved template name for a key — overridable via WHATSAPP_TEMPLATE_<KEY>. */
export function templateName(key: NotificationKey): string {
  return process.env[`WHATSAPP_TEMPLATE_${key}`] ?? DEFAULT_TEMPLATE_NAMES[key];
}

/** Template language (BCP-47), default Hebrew. */
export function templateLang(): string {
  return process.env.WHATSAPP_TEMPLATE_LANG ?? 'he';
}
