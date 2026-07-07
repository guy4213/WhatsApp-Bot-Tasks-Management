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
import { sendTextMessage, sendTemplateMessage, sendButtonMessage, type TemplateButtonParam } from './sender';
import { type NotificationKey, templateName, templateLang } from './templateNames';

// Re-export so existing importers of NotificationKey from this module keep working.
export type { NotificationKey };

// Interactive button-message bodies are capped (Meta limit ~1024). Above this we
// send the full text first, then a short message that carries the buttons.
const BUTTON_BODY_MAX = 1000;

function templatesEnabled(): boolean {
  return process.env.WHATSAPP_TEMPLATES_ENABLED === 'true';
}

export interface NotifyArgs {
  to: string;
  key: NotificationKey;
  bodyParams: string[];   // ordered template variables
  fallbackText: string;   // sent when templates are disabled / no name configured
  /**
   * Optional quick-reply buttons for the IN-WINDOW (fallback) free-form path. When
   * the approved template is used instead, its own quick-reply buttons apply (these
   * are ignored), so the template definition must declare matching button payloads.
   */
  buttons?: Array<{ id: string; title: string }>;
  /**
   * Optional dynamic button parameters for the OUT-OF-WINDOW template path (e.g.
   * a quick-reply button's per-send payload). Ignored on the freeform path,
   * where `buttons` is used instead.
   */
  templateButtonParams?: TemplateButtonParam[];
}

/**
 * Send a proactive notification. Uses the approved template when templates are
 * enabled; otherwise sends free-form text (dev, or when the recipient is in-window).
 * When `buttons` are supplied and we're on the free-form path, the message is sent
 * as an interactive reply-button message so the user can act without typing.
 */
export async function notify({ to, key, bodyParams, fallbackText, buttons, templateButtonParams }: NotifyArgs): Promise<string | null> {
  const name = templateName(key);
  if (templatesEnabled() && name) {
    // Template path: the button's static text lives in the approved template;
    // any dynamic per-send button payload is passed via `templateButtonParams`.
    return await sendTemplateMessage({ to, name, languageCode: templateLang(), bodyParams, buttonParams: templateButtonParams });
  }

  if (buttons && buttons.length > 0) {
    if (fallbackText.length <= BUTTON_BODY_MAX) {
      return await sendButtonMessage({ to, body: fallbackText, buttons });
    }
    // Body too long for an interactive message — send the full text, then the
    // buttons on a compact follow-up so nothing is truncated. Return the
    // actionable (buttons) message's wamid.
    await sendTextMessage({ to, text: fallbackText });
    return await sendButtonMessage({ to, body: 'בחר פעולה:', buttons });
  }

  return await sendTextMessage({ to, text: fallbackText });
}
