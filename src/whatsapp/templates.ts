/**
 * Notification templates registry.
 *
 * Proactive (business-initiated) messages must use a Meta-approved template when
 * sent outside the 24h customer-service window. This module maps each logical
 * notification to a template name + ordered body params, and provides notify(),
 * which sends the template when templates are ENABLED and a name is configured,
 * otherwise falls back to free-form text (works in dev / inside the 24h window).
 *
 * Enable in prod:  WHATSAPP_TEMPLATES_ENABLED=true
 * Template lang:   WHATSAPP_TEMPLATE_LANG=he   (default)
 * Override a name: WHATSAPP_TEMPLATE_DUE_REMINDER=my_due_reminder   (etc.)
 *
 * ── Body-variable contract (register these in Meta WhatsApp Manager, category UTILITY) ──
 *   DUEDATE_APPROVAL_REQUEST : {{1}} requester  {{2}} task title  {{3}} new date  {{4}} action id
 *   DUEDATE_APPROVED         : {{1}} task title  {{2}} new date   {{3}} manager
 *   DUEDATE_REJECTED         : {{1}} task title  {{2}} manager
 *   DUE_REMINDER             : {{1}} task title  {{2}} time
 *   DEADLINE_EXCEEDED        : {{1}} manager     {{2}} count
 *   DEADLINE_APPROACHING     : {{1}} manager     {{2}} count       {{3}} hours
 *   DAILY_SUMMARY            : {{1}} user        {{2}} count
 *   TASK_COMPLETED           : {{1}} task title  {{2}} owner
 *   REQUEST_EXPIRED          : {{1}} task title
 *   REQUEST_EXPIRED_MANAGER  : {{1}} requester   {{2}} task title
 */
import { sendTextMessage, sendTemplateMessage } from './sender';

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

// Default template names (override individually via WHATSAPP_TEMPLATE_<KEY>).
const DEFAULT_NAMES: Record<NotificationKey, string> = {
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

function templatesEnabled(): boolean {
  return process.env.WHATSAPP_TEMPLATES_ENABLED === 'true';
}

function templateLang(): string {
  return process.env.WHATSAPP_TEMPLATE_LANG ?? 'he';
}

function templateName(key: NotificationKey): string {
  return process.env[`WHATSAPP_TEMPLATE_${key}`] ?? DEFAULT_NAMES[key];
}

export interface NotifyArgs {
  to: string;
  key: NotificationKey;
  bodyParams: string[];   // ordered template variables
  fallbackText: string;   // sent when templates are disabled / no name configured
}

/**
 * Send a proactive notification. Uses the approved template when templates are
 * enabled; otherwise sends free-form text (dev, or when the recipient is in-window).
 */
export async function notify({ to, key, bodyParams, fallbackText }: NotifyArgs): Promise<void> {
  const name = templateName(key);
  if (templatesEnabled() && name) {
    await sendTemplateMessage({ to, name, languageCode: templateLang(), bodyParams });
  } else {
    await sendTextMessage({ to, text: fallbackText });
  }
}
