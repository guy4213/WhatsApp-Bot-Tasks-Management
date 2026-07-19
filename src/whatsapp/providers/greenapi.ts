/**
 * WhatsApp outbound sender — Green API provider (temporary WhatsApp-Web transport).
 *
 * Implements the WhatsAppProvider interface against Green API's REST endpoint.
 * Selected by WHATSAPP_PROVIDER=greenapi (the PR#2 default). Business logic never
 * imports this file — it goes through sender.ts, exactly as with Meta.
 *
 * Differences from Meta, all confined to this file:
 *  - No native interactive messages. `sendButton` / `sendList` degrade to NUMBERED
 *    TEXT and persist the number→command mapping in PendingChoice, so the inbound
 *    numeric reply is translated back to the router's command in the webhook.
 *  - `supportsTemplates = false` — notify() always takes the free-form fallback
 *    path, so Meta templates are never attempted (and `sendTemplate` is unreached
 *    in practice; it degrades defensively rather than dropping a message).
 *  - `paced = true` — Green API paces outbound itself via the console setting
 *    `delaySendMessagesMilliseconds` (a 24h server-side queue). There is NO local
 *    throttling here; callers coalesce consecutive sends where they can.
 *
 * Delivery mechanics (retry/back-off/timeout/DLQ) are the SHARED httpDelivery
 * helpers — identical to Meta — providing resilience against Green API's REST
 * layer (network / 5xx / 429) only.
 */
import type {
  WhatsAppProvider, TextMessage, ButtonMessage, ListMessage, TemplateMessage,
} from '../provider';
import { moduleLogger } from '../../utils/logger';
import { normalizeIsraeliPhone } from '../../auth/phoneNormalizer';
import { postJson, runWithRetry } from './httpDelivery';
import { savePendingChoice } from '../../services/pendingChoice';
import { checkOutboundHealth } from '../../services/greenapiPreflight';

const log = moduleLogger('greenapi');

const API_URL     = (process.env.GREENAPI_API_URL ?? 'https://api.green-api.com').replace(/\/+$/, '');
const ID_INSTANCE = process.env.GREENAPI_ID_INSTANCE ?? '';
const API_TOKEN   = process.env.GREENAPI_API_TOKEN_INSTANCE ?? '';

// ── Senders ───────────────────────────────────────────────────────────────────

async function sendText({ to, text, bypassGuards }: TextMessage): Promise<string | null> {
  return await deliver(normalizeRecipient(to), text, { bypassPreflight: bypassGuards === true });
}

/**
 * Reply buttons have no Green API analogue → render as numbered text and persist
 * the number→id mapping. The tapped-button `id` (a text command like "כן <uuid>")
 * becomes the mapped value, so a "1"/"2" reply routes through the same handler a
 * Meta button tap would.
 */
async function sendButton({ to, body, buttons }: ButtonMessage): Promise<string | null> {
  return await sendNumbered(
    normalizeRecipient(to),
    body,
    buttons.map((b) => ({ id: b.id, label: b.title })),
  );
}

/**
 * List rows have no Green API analogue → flatten every section's rows into one
 * numbered list (the `buttonLabel` and section titles carry no meaning in plain
 * text) and persist the number→row-id mapping.
 */
async function sendList({ to, body, sections }: ListMessage): Promise<string | null> {
  const options = sections.flatMap((s) =>
    s.rows.map((r) => ({
      id: r.id,
      label: r.description ? `${r.title} — ${r.description}` : r.title,
    })),
  );
  return await sendNumbered(normalizeRecipient(to), body, options);
}

/**
 * Green API cannot deliver Meta-approved templates. Because supportsTemplates is
 * false, notify() always takes the free-form fallback path and never calls this,
 * so it is effectively unreachable in the running app. It stays defensive: if a
 * caller invokes sendTemplateMessage DIRECTLY it degrades to plain text (the body
 * params joined) rather than silently dropping the message.
 */
async function sendTemplate({ to, name, bodyParams }: TemplateMessage): Promise<string | null> {
  log.warn({ name }, 'sendTemplate under Green API — templates unsupported; sending text fallback');
  const text = (bodyParams ?? []).map((p) => String(p)).filter((p) => p.trim()).join(' — ');
  return await deliver(normalizeRecipient(to), text || `הודעה: ${name}`);
}

// ── Numbered-choice rendering (buttons/lists → text + PendingChoice) ───────────

interface NumberedOption { id: string; label: string; }

async function sendNumbered(recipient: string, body: string, options: NumberedOption[]): Promise<string | null> {
  const lines = options.map((o, i) => `${i + 1}. ${o.label}`);
  const text  = lines.length > 0 ? `${body}\n\n${lines.join('\n')}` : body;

  // Persist number→command mapping so the inbound reply ("2") resolves back to
  // the exact id ("לא <uuid>") the router expects. Best-effort — a mapping write
  // failure must not drop the outbound prompt (the user can still reply in text).
  if (recipient && lines.length > 0) {
    const mapping: Record<string, string> = {};
    options.forEach((o, i) => { mapping[String(i + 1)] = o.id; });
    try {
      await savePendingChoice(recipient, mapping);
    } catch (err) {
      log.error({ err, to: recipient }, 'Failed to persist PendingChoice mapping (continuing)');
    }
  }

  return await deliver(recipient, text);
}

// ── Shared delivery (credential check → preflight → retry loop → DLQ) ─────────

/**
 * `recipient` is already normalized (digits, no @c.us).
 *
 * `opts.bypassPreflight` skips `checkOutboundHealth` — reserved for ops alerts
 * routed via `sender.sendOpsAlertText` (bypassGuards=true propagates here from
 * `sendText`). Buttons / lists / templates NEVER bypass (no ops-alert path
 * uses them).
 *
 * When preflight blocks:
 *   - no HTTP call is made (skip queueing to Green API's 24h server-side queue),
 *   - no dedup row is written (caller's INSERT-first pattern will retry on the
 *     next scheduler tick — implicit exponential retry via cron cadence),
 *   - no DLQ row is written (DLQ is reserved for real send failures after retries).
 */
async function deliver(
  recipient: string,
  text: string,
  opts: { bypassPreflight?: boolean } = {},
): Promise<string | null> {
  if (!recipient) {
    log.warn({ preview: text.slice(0, 80) }, 'Empty recipient — message skipped');
    return null;
  }
  if (!ID_INSTANCE || !API_TOKEN) {
    log.warn({ to: recipient, preview: text.slice(0, 80) }, 'Missing Green API credentials — message not sent');
    return null;
  }

  if (!opts.bypassPreflight) {
    const health = await checkOutboundHealth();
    if (!health.allow) {
      log.warn(
        {
          to: recipient,
          reason: health.reason,
          source: health.source,
          preview: text.slice(0, 80),
        },
        'Green API preflight blocked send — dropped (no dedup row; next tick will retry)',
      );
      return null;
    }
  }

  const chatId = `${recipient}@c.us`;
  const url    = `${API_URL}/waInstance${ID_INSTANCE}/sendMessage/${API_TOKEN}`;
  const body   = JSON.stringify({ chatId, message: text });

  return await runWithRetry(chatId, text, async () => {
    // Green API returns { idMessage } on success; treat an unparseable body as a
    // successful send with no id (the message went out either way).
    const raw = await postJson(url, { 'Content-Type': 'application/json' }, body);
    try {
      const parsed = JSON.parse(raw) as { idMessage?: string };
      return parsed?.idMessage ?? null;
    } catch {
      return null;
    }
  });
}

/**
 * Green API chatIds use the international format without '+', matching what
 * normalizeIsraeliPhone produces. Falls back to digits-only for non-Israeli
 * numbers (mirrors the Meta provider).
 */
function normalizeRecipient(to: string): string {
  return normalizeIsraeliPhone(to) ?? to.replace(/\D/g, '');
}

// ── Provider ──────────────────────────────────────────────────────────────────

export const greenapiProvider: WhatsAppProvider = {
  name: 'greenapi',
  supportsTemplates: false, // WhatsApp-Web transport — no Meta template delivery.
  paced: true,              // Green API paces outbound server-side; coalesce sends.
  sendText,
  sendButton,
  sendList,
  sendTemplate,
};
