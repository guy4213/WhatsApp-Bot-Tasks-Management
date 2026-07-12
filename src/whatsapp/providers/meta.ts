/**
 * WhatsApp outbound sender — Meta Cloud API provider.
 *
 * Implements the WhatsAppProvider interface against Meta's Graph API. This is
 * the original sender.ts implementation, moved behind the provider seam
 * unchanged. Shared delivery mechanics (retry + back-off, timeout, DLQ) live in
 * ./httpDelivery.
 *
 * Two message kinds:
 *  - sendText     — free-form text. Allowed ONLY inside the 24h customer-service
 *                   window (i.e. in reply to the user).
 *  - sendTemplate — pre-approved template. Required for business-initiated /
 *                   out-of-window messages (reminders, alerts, summaries).
 *
 * Credentials are read from the environment. A missing credential degrades each
 * send to a warn + null (never a throw at send time); boot-time fail-fast for
 * production lives in config/preflight.ts.
 */
import type {
  WhatsAppProvider, TextMessage, ButtonMessage, ListMessage, TemplateMessage,
} from '../provider';
import { moduleLogger } from '../../utils/logger';
import { normalizeIsraeliPhone } from '../../auth/phoneNormalizer';
import { postJson, runWithRetry } from './httpDelivery';

const log = moduleLogger('whatsapp');

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN ?? '';
const API_VERSION     = process.env.WHATSAPP_API_VERSION ?? 'v19.0';

// ── Senders ───────────────────────────────────────────────────────────────────

async function sendText({ to, text }: TextMessage): Promise<string | null> {
  const recipient = normalizeRecipient(to);
  return await deliver(
    recipient,
    { messaging_product: 'whatsapp', to: recipient, type: 'text', text: { body: text } },
    text,
  );
}

/**
 * Interactive reply-button message (in-session only). The tapped button's `id`
 * is returned by Meta as interactive.button_reply.id — callers set it to a text
 * command (e.g. "כן <uuid>") so the same handler path as a typed reply runs.
 * Meta caps a reply-button message at 3 buttons.
 */
async function sendButton({ to, body, buttons }: ButtonMessage): Promise<string | null> {
  const recipient = normalizeRecipient(to);
  return await deliver(
    recipient,
    {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    },
    body,
  );
}

/**
 * Interactive list message (in-session only). The selected row's `id` is returned
 * by Meta as interactive.list_reply.id and routed to the router as plain text.
 * Supports up to 10 rows total.
 */
async function sendList({ to, body, buttonLabel, sections }: ListMessage): Promise<string | null> {
  const recipient = normalizeRecipient(to);
  return await deliver(
    recipient,
    {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: buttonLabel.slice(0, 20),
          sections: sections.map((s) => ({
            ...(s.title ? { title: s.title.slice(0, 24) } : {}),
            rows: s.rows.map((r) => ({
              id: r.id,
              title: r.title.slice(0, 24),
              ...(r.description ? { description: r.description.slice(0, 72) } : {}),
            })),
          })),
        },
      },
    },
    body,
  );
}

async function sendTemplate({ to, name, languageCode, bodyParams, buttonParams }: TemplateMessage): Promise<string | null> {
  const recipient = normalizeRecipient(to);
  const params = (bodyParams ?? []).map(sanitizeParam);

  const template: Record<string, unknown> = {
    name,
    language: { code: languageCode },
  };

  const components: Array<Record<string, unknown>> = [];
  if (params.length > 0) {
    components.push({
      type: 'body',
      parameters: params.map((text) => ({ type: 'text', text })),
    });
  }
  for (const b of buttonParams ?? []) {
    components.push({
      type: 'button',
      sub_type: b.subType,
      index: b.index,
      parameters: [
        b.subType === 'quick_reply'
          ? { type: 'payload', payload: b.payload }
          : { type: 'text', text: sanitizeParam(b.payload) },
      ],
    });
  }
  // Only attach `components` when there is at least one — preserves the exact
  // body-only shape (and the no-components shape) used by existing templates.
  if (components.length > 0) {
    template.components = components;
  }

  return await deliver(
    recipient,
    { messaging_product: 'whatsapp', to: recipient, type: 'template', template },
    `template:${name}(${params.join(' | ')})`,
  );
}

// ── Recipient normalization ───────────────────────────────────────────────────

/**
 * WhatsApp requires the recipient in E.164 without '+', e.g. "972534271418".
 * "User".phone may be stored in any local format ("053-4271418"), so normalize
 * every outbound recipient here. Falls back to digits-only for non-Israeli numbers.
 */
function normalizeRecipient(to: string): string {
  return normalizeIsraeliPhone(to) ?? to.replace(/\D/g, '');
}

// ── Shared delivery (credential check → retry loop → DLQ) ─────────────────────

async function deliver(to: string, payload: Record<string, unknown>, dlqText: string): Promise<string | null> {
  // Guard against empty recipients (e.g. a User row with no phone) — Meta returns
  // a 400 "parameter to is required" and we'd needlessly retry + DLQ it.
  if (!to) {
    log.warn({ preview: dlqText.slice(0, 80) }, 'Empty recipient — message skipped');
    return null;
  }
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    log.warn({ to, preview: dlqText.slice(0, 80) }, 'Missing credentials — message not sent');
    return null;
  }

  const url  = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const body = JSON.stringify(payload);

  return await runWithRetry(to, dlqText, async () => {
    // Returns the outbound wamid (messages[0].id) on success, or null if Meta's
    // response can't be parsed — the send still succeeded either way.
    const raw = await postJson(
      url,
      { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body,
    );
    try {
      const parsed = JSON.parse(raw) as { messages?: Array<{ id?: string }> };
      return parsed?.messages?.[0]?.id ?? null;
    } catch {
      return null;
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Meta rejects template params containing newlines, tabs, or >4 spaces. */
function sanitizeParam(value: string): string {
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
}

// ── Provider ───────────────────────────────────────────────────────────────────

export const metaProvider: WhatsAppProvider = {
  name: 'meta',
  supportsTemplates: true,  // Meta-approved templates work out-of-window.
  paced: false,             // Meta is not globally rate-paced; no send coalescing needed.
  sendText,
  sendButton,
  sendList,
  sendTemplate,
};
