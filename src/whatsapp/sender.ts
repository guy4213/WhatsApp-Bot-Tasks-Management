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
 *
 * Kill switch (added after 2026-07-19 incident):
 *   WHATSAPP_OUTBOUND_SUPPRESSED=true → every outbound entry point becomes a
 *   no-op that returns null without contacting the provider or writing any
 *   dedup row. Operator escape hatch to stop the bot from sending in real time
 *   without a deploy — complement of GREENAPI_INBOUND_SUPPRESSED on the
 *   webhook side. A throttled `log.warn` fires at most once per minute so the
 *   suppression is visible in Render logs without spamming.
 *
 * Ops-alert bypass:
 *   `sendOpsAlertText` is the ONE entry that skips both the kill switch AND
 *   the Green-API preflight (`checkOutboundHealth`). Rationale: the alerts
 *   that warn humans about the outbound path being blocked must never
 *   themselves be blocked, or the mechanism is blind to itself. Reserved for
 *   `services/greenapiHealth.ts`; do NOT wire from router / dispatchers.
 */
import {
  getProvider,
  type TextMessage,
  type ButtonMessage,
  type ListMessage,
  type TemplateMessage,
  type TemplateButtonParam,
} from './provider';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('sender');

// Re-export the message shapes so existing importers of these types from this
// module (e.g. templates.ts imports `type TemplateButtonParam`) keep working.
export type { TextMessage, ButtonMessage, ListMessage, TemplateMessage, TemplateButtonParam };

// ── Kill switch ────────────────────────────────────────────────────────────────

/** How often the "outbound suppressed" warn log is allowed to fire per process. */
const SUPPRESS_WARN_INTERVAL_MS = 60_000;
let lastSuppressWarnAt = 0;

function outboundSuppressed(): boolean {
  return process.env.WHATSAPP_OUTBOUND_SUPPRESSED === 'true';
}

function logSuppressedThrottled(to: string, preview: string): void {
  const now = Date.now();
  if (now - lastSuppressWarnAt < SUPPRESS_WARN_INTERVAL_MS) return;
  lastSuppressWarnAt = now;
  log.warn(
    { to, preview: preview.slice(0, 80) },
    'WHATSAPP_OUTBOUND_SUPPRESSED — outbound skipped (throttled to 1/min)',
  );
}

/** Test-only: reset the throttle so a repeated test observes the first warn. */
export function __resetSuppressThrottleForTests(): void {
  lastSuppressWarnAt = 0;
}

// ── Send entrypoints ──────────────────────────────────────────────────────────

export function sendTextMessage(msg: TextMessage): Promise<string | null> {
  // bypassGuards is honored here for the ops-alert path (see sendOpsAlertText).
  if (!msg.bypassGuards && outboundSuppressed()) {
    logSuppressedThrottled(msg.to, msg.text);
    return Promise.resolve(null);
  }
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
  if (outboundSuppressed()) {
    logSuppressedThrottled(msg.to, msg.body);
    return Promise.resolve(null);
  }
  return getProvider().sendButton(msg);
}

/**
 * Interactive list message (in-session only). Supports up to 10 rows total. Do
 * NOT use for dynamic-count lists (search results, inspection lists) that may
 * exceed 10 rows — use sendTextMessage with numbered text for those. Callers
 * that wrap this in try/catch fall back to numbered text on send failure.
 */
export function sendListMessage(msg: ListMessage): Promise<string | null> {
  if (outboundSuppressed()) {
    logSuppressedThrottled(msg.to, msg.body);
    return Promise.resolve(null);
  }
  return getProvider().sendList(msg);
}

export function sendTemplateMessage(msg: TemplateMessage): Promise<string | null> {
  if (outboundSuppressed()) {
    logSuppressedThrottled(msg.to, `[template:${msg.name}]`);
    return Promise.resolve(null);
  }
  return getProvider().sendTemplate(msg);
}

/**
 * Ops-alert text send — bypasses WHATSAPP_OUTBOUND_SUPPRESSED and the Green-API
 * preflight (`checkOutboundHealth`). Reserved for `services/greenapiHealth.ts`
 * — the one path that must warn humans that the outbound is blocked. Do NOT
 * wire from router or dispatchers.
 */
export function sendOpsAlertText(msg: TextMessage): Promise<string | null> {
  return getProvider().sendText({ ...msg, bypassGuards: true });
}
