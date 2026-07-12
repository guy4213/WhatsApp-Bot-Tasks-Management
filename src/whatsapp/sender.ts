/**
 * WhatsApp outbound sender — provider-agnostic facade.
 *
 * All business logic calls this module; swapping providers means changing only
 * the provider layer (see provider.ts, selected by WHATSAPP_PROVIDER). This
 * file's exported surface — function names, message interfaces, signatures —
 * never changes, so the ~13 importers across ai/, routes/, auth/, utils/,
 * scheduler/ and scripts/ stay untouched.
 *
 * Message kinds:
 *  - sendTextMessage     — free-form text (in-window / reply to the user).
 *  - sendButtonMessage   — interactive reply buttons; the tapped `id` is a text
 *                          command so the same handler path as a typed reply runs.
 *  - sendListMessage     — interactive list; the selected row `id` routes as text.
 *  - sendTemplateMessage — pre-approved template for business-initiated /
 *                          out-of-window messages.
 */
import {
  getProvider,
  type TextMessage,
  type ButtonMessage,
  type ListMessage,
  type TemplateMessage,
  type TemplateButtonParam,
} from './provider';

// Re-export the message shapes so existing importers of these types from this
// module (e.g. templates.ts imports `type TemplateButtonParam`) keep working.
export type { TextMessage, ButtonMessage, ListMessage, TemplateMessage, TemplateButtonParam };

export function sendTextMessage(msg: TextMessage): Promise<string | null> {
  return getProvider().sendText(msg);
}

/**
 * D5-T4 policy (v2): interactive reply buttons are reserved for exactly two
 * surfaces — the §6 inspection card (D2-T2) and the §10 equipment reminder
 * (D2-T9). Every other menu stays as numbered text via `renderMenu` /
 * `renderProblemTypeMenu`, because Meta caps a reply-button message at 3 buttons
 * and most v2 menus exceed that. The button `id` is set to a text command so a
 * tap and a typed reply run the same handler path.
 */
export function sendButtonMessage(msg: ButtonMessage): Promise<string | null> {
  return getProvider().sendButton(msg);
}

/**
 * Interactive list message (in-session only). Supports up to 10 rows total. Do
 * NOT use for dynamic-count lists (search results, inspection lists) that may
 * exceed 10 rows — use sendTextMessage with numbered text for those. Callers
 * that wrap this in try/catch fall back to numbered text on send failure.
 */
export function sendListMessage(msg: ListMessage): Promise<string | null> {
  return getProvider().sendList(msg);
}

export function sendTemplateMessage(msg: TemplateMessage): Promise<string | null> {
  return getProvider().sendTemplate(msg);
}
