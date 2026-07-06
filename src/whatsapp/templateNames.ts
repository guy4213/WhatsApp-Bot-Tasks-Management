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
  | 'REQUEST_EXPIRED_MANAGER'
  // Per-user scheduled digests (V1). Names only — these templates are NOT yet
  // submitted to Meta and stay disabled (WHATSAPP_TEMPLATES_ENABLED=false), so
  // digests deliver in-window free-form until the templates are approved.
  | 'EMPLOYEE_MORNING_DIGEST'
  | 'MANAGER_MORNING_DIGEST'
  | 'EMPLOYEE_END_OF_DAY_REPORT'
  | 'MANAGER_END_OF_DAY_REPORT'
  // Customer-facing template — the customer is notified when the assigned
  // worker flips TaskField.fieldStatus to EN_ROUTE. Body: "שלום {{1}}, {{2}}
  // מ־גלית ... יצא לדרך ... לביצוע {{3}}. לפניות ישירות לבודק: {{4}}. בהצלחה!"
  | 'CUSTOMER_WORKER_EN_ROUTE';

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
  EMPLOYEE_MORNING_DIGEST:     'employee_morning_digest',
  MANAGER_MORNING_DIGEST:      'manager_morning_digest',
  EMPLOYEE_END_OF_DAY_REPORT:  'employee_end_of_day_report',
  MANAGER_END_OF_DAY_REPORT:   'manager_end_of_day_report',
  CUSTOMER_WORKER_EN_ROUTE:    'customer_worker_en_route',
};

/** Resolved template name for a key — overridable via WHATSAPP_TEMPLATE_<KEY>. */
export function templateName(key: NotificationKey): string {
  return process.env[`WHATSAPP_TEMPLATE_${key}`] ?? DEFAULT_TEMPLATE_NAMES[key];
}

/** Template language (BCP-47), default Hebrew. */
export function templateLang(): string {
  return process.env.WHATSAPP_TEMPLATE_LANG ?? 'he';
}
