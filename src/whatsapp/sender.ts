/**
 * WhatsApp outbound message sender — Meta Cloud API.
 * All business logic calls this module; swapping providers means
 * only changing this file.
 *
 * Two message kinds:
 *  - sendTextMessage     — free-form text. Allowed ONLY inside the 24h
 *                          customer-service window (i.e. in reply to the user).
 *  - sendTemplateMessage — pre-approved template. Required for business-initiated
 *                          / out-of-window messages (reminders, alerts, summaries).
 *
 * Shared: retry with exponential back-off, per-request timeout, DLQ logging.
 */
import https from 'https';
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';
import { normalizeIsraeliPhone } from '../auth/phoneNormalizer';

const log = moduleLogger('whatsapp');

const PHONE_NUMBER_ID  = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const ACCESS_TOKEN     = process.env.WHATSAPP_ACCESS_TOKEN ?? '';
const API_VERSION      = process.env.WHATSAPP_API_VERSION ?? 'v19.0';
const REQUEST_TIMEOUT  = 10_000; // 10 s per attempt
const MAX_ATTEMPTS     = 3;

// Fail fast in production when credentials are absent.
if (process.env.NODE_ENV === 'production' && (!PHONE_NUMBER_ID || !ACCESS_TOKEN)) {
  throw new Error(
    'Missing WhatsApp credentials: set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN',
  );
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface TextMessage {
  to: string;   // E.164 without +, e.g. "972501234567"
  text: string;
}

export async function sendTextMessage({ to, text }: TextMessage): Promise<void> {
  const recipient = normalizeRecipient(to);
  await deliver(
    recipient,
    { messaging_product: 'whatsapp', to: recipient, type: 'text', text: { body: text } },
    text,
  );
}

export interface ButtonMessage {
  to: string;
  body: string;
  /** Up to 3 reply buttons. `id` is echoed back on tap; `title` ≤ 20 chars. */
  buttons: Array<{ id: string; title: string }>;
}

/**
 * Interactive reply-button message (in-session only). The tapped button's `id`
 * is returned by Meta as interactive.button_reply.id — we set it to a text
 * command (e.g. "כן <uuid>") so the same handler path as a typed reply runs.
 *
 * D5-T4 policy: v2 uses this ONLY for the §6 inspection card (D2-T2) and the
 * §10 equipment reminder (D2-T9). Every other menu (7-item main menu, 7-item
 * problem sub-menu, 4-item finished follow-up, 4-item day summary) stays as
 * numbered text via `renderMenu` / `renderProblemTypeMenu`. Meta caps a reply-
 * button message at 3 buttons — most v2 menus exceed that.
 */
export async function sendButtonMessage({ to, body, buttons }: ButtonMessage): Promise<void> {
  const recipient = normalizeRecipient(to);
  await deliver(
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

export interface ListMessage {
  to: string;
  body: string;           // main body text shown above the button
  buttonLabel: string;    // ≤ 20 chars — the label on the "open list" button
  sections: Array<{
    title?: string;       // section header (≤ 24 chars)
    rows: Array<{
      id: string;         // unique payload — the router matches on this
      title: string;      // ≤ 24 chars — line 1 of each row
      description?: string; // ≤ 72 chars — line 2 (optional)
    }>;
  }>;
}

/**
 * Interactive list message (in-session only). The selected row's `id` is returned
 * by Meta as interactive.list_reply.id and routed to the router as plain text.
 *
 * Supports up to 10 rows total. Do NOT use for dynamic-count lists (search
 * results, inspection lists) that may exceed 10 rows — use sendTextMessage with
 * numbered text for those. Appropriate for: static menus (6-item manager menu),
 * 4-item action prompt.
 *
 * Falls back silently to numbered text on send failure when caller wraps in try/catch.
 */
export async function sendListMessage({ to, body, buttonLabel, sections }: ListMessage): Promise<void> {
  const recipient = normalizeRecipient(to);
  await deliver(
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

export interface TemplateMessage {
  to: string;
  /** Template name as registered/approved in Meta WhatsApp Manager. */
  name: string;
  /** BCP-47 language code of the template, e.g. "he" or "en_US". */
  languageCode: string;
  /** Ordered body variables filling {{1}}, {{2}}, … (no newlines/tabs — sanitized). */
  bodyParams?: string[];
}

export async function sendTemplateMessage({ to, name, languageCode, bodyParams }: TemplateMessage): Promise<void> {
  const recipient = normalizeRecipient(to);
  const params = (bodyParams ?? []).map(sanitizeParam);

  const template: Record<string, unknown> = {
    name,
    language: { code: languageCode },
  };
  if (params.length > 0) {
    template.components = [{
      type: 'body',
      parameters: params.map((text) => ({ type: 'text', text })),
    }];
  }

  await deliver(
    recipient,
    { messaging_product: 'whatsapp', to: recipient, type: 'template', template },
    `template:${name}(${params.join(' | ')})`,
  );
}

/**
 * WhatsApp requires the recipient in E.164 without '+', e.g. "972534271418".
 * "User".phone may be stored in any local format ("053-4271418"), so normalize
 * every outbound recipient here — one choke point for all senders (AI router,
 * scheduler, webhook). Falls back to digits-only for non-Israeli numbers.
 */
function normalizeRecipient(to: string): string {
  return normalizeIsraeliPhone(to) ?? to.replace(/\D/g, '');
}

// ── Shared delivery (credential check → retry loop → DLQ) ─────────────────────

async function deliver(to: string, payload: Record<string, unknown>, dlqText: string): Promise<void> {
  // Guard against empty recipients (e.g. a User row with no phone) — Meta returns
  // a 400 "parameter to is required" and we'd needlessly retry + DLQ it.
  if (!to) {
    log.warn({ preview: dlqText.slice(0, 80) }, 'Empty recipient — message skipped');
    return;
  }
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    log.warn({ to, preview: dlqText.slice(0, 80) }, 'Missing credentials — message not sent');
    return;
  }

  const url  = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const body = JSON.stringify(payload);

  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await post(url, body);
      return;
    } catch (err) {
      lastErr = err as Error;
      const httpStatus = parseStatus((err as Error).message);

      // 4xx (except 429) are not retryable
      if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) break;

      if (attempt < MAX_ATTEMPTS) {
        const delayMs = httpStatus === 429 ? 60_000 : Math.min(1_000 * 2 ** (attempt - 1), 30_000);
        await sleep(delayMs);
      }
    }
  }

  await writeSendFailure(to, dlqText, lastErr);
  throw lastErr;
}

// ── Low-level HTTP ────────────────────────────────────────────────────────────

function post(url: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`WhatsApp API error ${res.statusCode}: ${data.slice(0, 300)}`));
          } else {
            resolve();
          }
        });
      },
    );

    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy(new Error(`WhatsApp API request timed out after ${REQUEST_TIMEOUT}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Dead-letter log ───────────────────────────────────────────────────────────

async function writeSendFailure(to: string, text: string, err: Error | undefined): Promise<void> {
  const errorMessage = err?.message ?? 'unknown';
  log.error({ to, errorMessage }, 'Send failed after all retries');
  try {
    await pool.query(
      `INSERT INTO "WhatsappAuditLog"
         ("userId", "whatsappNumber", "executionStatus", "errorMessage", "managerNotified")
       VALUES (NULL, $1, 'FAILED', $2, false)`,
      [to, `Send failure: ${errorMessage} — ${text.slice(0, 200)}`],
    );
  } catch (logErr) {
    log.error({ err: logErr }, 'Failed to write send-failure to audit log');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseStatus(message: string): number {
  const m = (message ?? '').match(/error (\d+):/);
  return m ? parseInt(m[1], 10) : 0;
}

/** Meta rejects template params containing newlines, tabs, or >4 spaces. */
function sanitizeParam(value: string): string {
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
