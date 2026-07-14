/**
 * Green API inbound webhook (temporary WhatsApp-Web transport).
 *
 * POST /greenapi/webhook
 *
 * Security & reliability:
 *  - Auth: `Authorization: Bearer <GREENAPI_WEBHOOK_TOKEN>`, timing-safe. ANY
 *    failure — header missing, malformed, wrong token, or the env var unset —
 *    returns 404 (not 401/403), so the endpoint is invisible to a probe.
 *  - Only `typeWebhook === 'incomingMessageReceived'` is acted on. Every other
 *    webhook type (outgoing status, instance state, …) → 200 + ignore.
 *  - Durability + dedup reuse the SHARED WhatsappInboundQueue: the queue key is
 *    `greenapi:${idMessage}`, persisted BEFORE the 200 ACK. A blank idMessage is
 *    acked 200 + warned and NEVER stored under an empty primary key.
 *  - A numeric reply is translated back to its command via PendingChoice BEFORE
 *    enqueue, so the STORED payload already carries the text the router expects.
 *    The message is then processed by the SAME processInbound the Meta webhook
 *    uses — the router never learns which transport delivered it.
 */
import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import { enqueueInbound, type InboundMessage } from '../services/inboundQueue';
import { processInbound } from './webhook';
import { resolvePendingChoice } from '../services/pendingChoice';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('greenapi-webhook');

// ── Auth ────────────────────────────────────────────────────────────────────

/**
 * Timing-safe `Authorization: Bearer <token>` check against GREENAPI_WEBHOOK_TOKEN.
 * Fails closed: an unset token, a missing/malformed header, or a length/value
 * mismatch all return false (→ the route replies 404).
 */
export function verifyGreenApiAuth(authHeader: string | undefined): boolean {
  const expected = process.env.GREENAPI_WEBHOOK_TOKEN ?? '';
  if (!expected) return false;                       // unconfigured → reject
  if (!authHeader) return false;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const exp = Buffer.from(expected);
  if (got.length !== exp.length) return false;       // timingSafeEqual needs equal length
  return crypto.timingSafeEqual(got, exp);
}

// ── Payload extraction ────────────────────────────────────────────────────────

interface Extracted {
  kind: 'text' | 'audio';
  text?: string;
  downloadUrl?: string;
  /** stanzaId of the message the user swipe-replied to, when present. */
  quotedStanzaId?: string;
}

/** Sender phone in digits (no @c.us / @g.us suffix). */
function extractFrom(body: Record<string, unknown>): string {
  const sd = body.senderData as Record<string, unknown> | undefined;
  const chatId = (sd?.chatId ?? sd?.sender ?? '') as string;
  return String(chatId).replace(/@[cg]\.us$/i, '');
}

/** Normalize Green API messageData into our text/audio shape, or null if unsupported. */
function extractMessage(body: Record<string, unknown>): Extracted | null {
  const md = body.messageData as Record<string, unknown> | undefined;
  if (!md) return null;
  const type = md.typeMessage as string;

  if (type === 'textMessage') {
    const t = (md.textMessageData as Record<string, unknown> | undefined)?.textMessage;
    return { kind: 'text', text: (t as string) ?? '' };
  }
  if (type === 'extendedTextMessage') {
    const t = (md.extendedTextMessageData as Record<string, unknown> | undefined)?.text;
    return { kind: 'text', text: (t as string) ?? '' };
  }
  // A WhatsApp swipe-reply / long-press → Reply arrives with typeMessage='quotedMessage'.
  // The reply text lives in extendedTextMessageData.text (older schema variants use
  // textMessageData.textMessage), and the original message's id is in
  // quotedMessage.stanzaId. Threading stanzaId through as `context.id` restores parity
  // with Meta (where the same UX arrives as a plain text with context.id) so
  // messageRefs — and every await/quoted-reply flow built on it (ETA prompt,
  // finished_followup, active-inspection routing) — keeps working under Green API.
  if (type === 'quotedMessage') {
    const t =
      (md.extendedTextMessageData as Record<string, unknown> | undefined)?.text ??
      (md.textMessageData as Record<string, unknown> | undefined)?.textMessage;
    const qm = md.quotedMessage as Record<string, unknown> | undefined;
    const stanzaId = (qm?.stanzaId as string) || undefined;
    return { kind: 'text', text: (t as string) ?? '', quotedStanzaId: stanzaId };
  }
  if (type === 'audioMessage' || type === 'voiceMessage') {
    const fd = (md.fileMessageData as Record<string, unknown> | undefined) ?? {};
    return { kind: 'audio', downloadUrl: (fd.downloadUrl as string) ?? '' };
  }
  return null; // images, locations, contacts, etc. — unsupported (acked + ignored)
}

// ── Route ───────────────────────────────────────────────────────────────────

export async function greenapiWebhookRoutes(app: FastifyInstance) {
  app.post('/greenapi/webhook', async (req, reply) => {
    // 1. Auth — any failure is an opaque 404.
    if (!verifyGreenApiAuth(req.headers['authorization'] as string | undefined)) {
      log.warn('Green API webhook: auth failed — 404');
      return reply.code(404).send('Not Found');
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    // 2. Only inbound messages are processed; all other webhook types ack + ignore.
    if (body.typeWebhook !== 'incomingMessageReceived') {
      return reply.code(200).send('OK');
    }

    // 3. idMessage is the dedup key — never store an empty primary key.
    const idMessage = (body.idMessage as string) ?? '';
    if (!idMessage) {
      log.warn('Green API webhook: incomingMessageReceived with empty idMessage — ignored');
      return reply.code(200).send('OK');
    }

    const from = extractFrom(body);
    const extracted = extractMessage(body);
    if (!from || !extracted) {
      log.info({ idMessage }, 'Green API webhook: no supported message payload — ignored');
      return reply.code(200).send('OK');
    }

    // 4. Build the normalized (Meta-shaped) payload. For text, translate a numeric
    //    reply back to its command via PendingChoice BEFORE enqueue, so the STORED
    //    payload already carries the resolved text.
    let payload: Record<string, unknown>;
    if (extracted.kind === 'text') {
      const raw = extracted.text ?? '';
      let resolvedText = raw;
      try {
        const mapped = await resolvePendingChoice(from, raw);
        if (mapped) resolvedText = mapped;
      } catch (err) {
        log.error({ err, from }, 'PendingChoice resolve failed — using raw text');
      }
      payload = { type: 'text', from, text: { body: resolvedText } };
      // Preserve the quoted-message reference so processInbound can pass
      // it as `quotedWamid` (same shape Meta uses via `messages[].context.id`).
      if (extracted.quotedStanzaId) {
        payload.context = { id: extracted.quotedStanzaId };
      }
    } else {
      // Audio: Green API gives a direct, pre-authorized downloadUrl. voice.ts uses
      // it (bypassing the Meta two-step) via the additive line in processInbound.
      payload = { type: 'audio', from, audio: { id: idMessage, downloadUrl: extracted.downloadUrl ?? '' } };
    }

    const item: InboundMessage = { msgId: `greenapi:${idMessage}`, fromPhone: from, payload };

    // 5. Enqueue BEFORE the ACK (durable + dedup). DB down → process inline once,
    //    no durability (mirrors the Meta webhook's fallback).
    let isNew = false;
    try {
      isNew = await enqueueInbound(item);
    } catch (dbErr) {
      log.error({ err: dbErr, msgId: item.msgId }, 'Enqueue failed — processing inline (no durability)');
      item.msgId = `__fallback__${item.msgId}`;
      isNew = true;
    }

    // 6. ACK.
    reply.code(200).send('OK');

    // 7. Process only when newly enqueued (dedup: a re-delivered idMessage is skipped).
    if (isNew) await processInbound(item);
  });
}
