/**
 * Meta Cloud API webhook handler.
 *
 * GET  /webhook  — verification challenge (one-time setup)
 * POST /webhook  — inbound messages
 *
 * Security & reliability:
 *  - X-Hub-Signature-256 HMAC verified on every POST (requires WHATSAPP_APP_SECRET)
 *  - Per-phone rate limit (20 msg / 60 s) + HTTP-layer rate limit (see app.ts)
 *  - Durable inbound queue: every message is persisted BEFORE the 200 ACK, so a
 *    crash mid-processing never loses it (recovery sweep reprocesses pending rows).
 *    The queue's msg_id PK doubles as the dedup key.
 *  - Internal task routes protected with x-internal-secret header
 */
import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import { enqueueInbound, markDone, markFailed, claimPending, type InboundMessage } from '../services/inboundQueue';
import { dispatchInternal } from '../utils/internalApi';
import { writeAuditLog } from '../utils/auditLog';
import { moduleLogger } from '../utils/logger';
import type { ResolvedUser } from '../types';

const log = moduleLogger('webhook');
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? 'changeme';

// ── Signature / token verification ────────────────────────────────────────────

function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return true; // Skip if not configured (dev only)
  if (!signature) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function verifyTokenEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── Per-phone rate limiter (sliding window) ───────────────────────────────────

const phoneBuckets = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX       = 20;

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [phone, times] of phoneBuckets) {
    const fresh = times.filter((t) => t > cutoff);
    if (fresh.length === 0) phoneBuckets.delete(phone);
    else phoneBuckets.set(phone, fresh);
  }
}, 5 * 60_000).unref();

function checkRateLimit(phone: string): boolean {
  const now    = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const times  = (phoneBuckets.get(phone) ?? []).filter((t) => t > cutoff);
  if (times.length >= RATE_MAX) return false;
  times.push(now);
  phoneBuckets.set(phone, times);
  return true;
}

// In-memory dedup fallback for when the DB queue is unreachable
const fallbackSeen = new Set<string>();

// ── Route registration ────────────────────────────────────────────────────────

export async function webhookRoutes(app: FastifyInstance) {

  // Webhook verification — Meta calls this once during setup
  app.get<{ Querystring: Record<string, string> }>('/webhook', async (req, reply) => {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && verifyTokenEqual(token ?? '', VERIFY_TOKEN)) {
      log.info('Webhook verified');
      return reply.send(challenge);
    }
    return reply.code(403).send('Forbidden');
  });

  // Inbound messages
  app.post('/webhook', async (req, reply) => {
    // 1. Verify HMAC signature (rawBody captured by app.ts addContentTypeParser)
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!verifyWebhookSignature(req.rawBody ?? Buffer.alloc(0), signature)) {
      log.warn('Invalid webhook signature — request rejected');
      return reply.code(403).send('Forbidden');
    }

    // 2. Extract messages and persist them durably BEFORE acking
    const toProcess: InboundMessage[] = [];
    try {
      const body    = req.body as Record<string, unknown>;
      const entries = (body?.entry as unknown[]) ?? [];

      for (const entry of entries) {
        const changes = ((entry as Record<string, unknown>)?.changes as unknown[]) ?? [];
        for (const change of changes) {
          const value = (change as Record<string, unknown>)?.value as Record<string, unknown> | undefined;
          if (value?.statuses) continue; // delivery/read receipts — ignore

          const messages = (value?.messages as unknown[]) ?? [];
          for (const msg of messages) {
            const m     = msg as Record<string, unknown>;
            const item: InboundMessage = {
              msgId: m.id as string,
              fromPhone: m.from as string,
              payload: m,
            };

            try {
              const isNew = await enqueueInbound(item);
              if (isNew) toProcess.push(item);
            } catch (dbErr) {
              // DB unreachable — best-effort in-memory dedup, process inline (no durability)
              log.error({ err: dbErr, msgId: item.msgId }, 'Enqueue failed — falling back to in-memory');
              if (!fallbackSeen.has(item.msgId)) {
                fallbackSeen.add(item.msgId);
                if (fallbackSeen.size > 10_000) {
                  const first = fallbackSeen.values().next().value;
                  if (first !== undefined) fallbackSeen.delete(first);
                }
                toProcess.push({ ...item, msgId: `__fallback__${item.msgId}` });
              }
            }
          }
        }
      }
    } catch (err) {
      log.error({ err }, 'Failed to parse webhook body');
    }

    // 3. ACK immediately — Meta requires a 200 within ~20 s
    reply.code(200).send('EVENT_RECEIVED');

    // 4. Process the newly-queued messages
    for (const item of toProcess) {
      await processInbound(item);
    }
  });
}

// ── Processing ──────────────────────────────────────────────────────────────

/** Process one queued message and update its queue status. */
export async function processInbound(item: InboundMessage): Promise<void> {
  const isFallback = item.msgId.startsWith('__fallback__');
  try {
    const m    = item.payload;
    const type = m.type as string;

    // Phase 2: the wamid of the message this one is a swipe-reply to (if any).
    // Meta puts it in messages[].context.id. Threaded downstream so a quoted
    // reply can be resolved back to its original context.
    const quotedWamid = ((m.context as Record<string, unknown>)?.id as string) || undefined;

    if (type === 'text') {
      const text = ((m.text as Record<string, unknown>)?.body as string) ?? '';
      log.info({ from: item.fromPhone, msgId: item.msgId }, 'Inbound text message');
      await handleIncomingMessage(item.fromPhone, text, quotedWamid);
    } else if (type === 'interactive') {
      // A tapped reply button (or list item) — its `id` carries the text command
      // (e.g. "כן <uuid>"); fall back to the visible title for older clients.
      const interactive = m.interactive as Record<string, unknown> | undefined;
      const br = interactive?.button_reply as Record<string, unknown> | undefined;
      const lr = interactive?.list_reply as Record<string, unknown> | undefined;
      const payloadText = ((br?.id ?? lr?.id ?? br?.title ?? lr?.title) as string) ?? '';
      log.info({ from: item.fromPhone, msgId: item.msgId }, 'Inbound interactive reply');
      await handleIncomingMessage(item.fromPhone, payloadText);
    } else if (type === 'audio') {
      // D5-T2: download the Meta audio asset, transcribe via Whisper (K7),
      // persist the transcript into WhatsappAuditLog.transcribedMessage, then
      // fall through to the SAME text-routing path a typed message uses — the
      // downstream handler cannot tell the two apart. Missing OPENAI_API_KEY
      // or any download/transcription failure degrades to the fallback reply.
      const mediaId = ((m.audio as Record<string, unknown>)?.id as string) ?? '';
      // Provider seam: Green API carries a direct, pre-authorized media URL here;
      // Meta payloads never do (mediaId-only). voice.ts bypasses the Meta two-step
      // download when a downloadUrl is present.
      const downloadUrl = ((m.audio as Record<string, unknown>)?.downloadUrl as string) || undefined;
      log.info({ from: item.fromPhone, msgId: item.msgId, mediaId }, 'Inbound audio message');

      // Seed an audit-log row so the transcript has somewhere to land.
      const auditLogId = await writeAuditLog({
        userId: null,
        whatsappNumber: item.fromPhone,
        originalMessage: `[audio mediaId=${mediaId}]`,
        transcribedMessage: null,
        detectedIntent: null,
        detectedAction: null,
        confidence: null,
        targetTaskId: null,
        oldValues: null,
        newValues: null,
        confirmationStatus: null,
        approvalStatus: null,
        approverUserId: null,
        managerNotified: false,
        executionStatus: null,
        errorMessage: null,
        pendingActionId: null,
      });

      const { handleVoiceMessage } = await import('../whatsapp/voice');
      const transcript = await handleVoiceMessage({
        mediaId,
        downloadUrl,
        from: item.fromPhone,
        auditLogId: auditLogId ?? undefined,
      });

      if (transcript) {
        await handleIncomingMessage(item.fromPhone, transcript, quotedWamid);
      } else {
        const { sendTextMessage } = await import('../whatsapp/sender');
        await sendTextMessage({
          to: item.fromPhone,
          text: 'לא הצלחתי להבין את ההודעה הקולית, אנא נסה שוב או שלח טקסט',
        });
      }
    } else {
      const { sendTextMessage } = await import('../whatsapp/sender');
      await sendTextMessage({
        to: item.fromPhone,
        text: 'סוג ההודעה אינו נתמך כרגע. אנא שלח הודעת טקסט.',
      });
    }

    if (!isFallback) await markDone(item.msgId);
  } catch (err) {
    log.error({ err, msgId: item.msgId }, 'Failed to process inbound message');

    // Record the backend failure in the audit log (best-effort, never throws).
    await writeAuditLog({
      userId: null, whatsappNumber: item.fromPhone,
      originalMessage: null, transcribedMessage: null,
      detectedIntent: null, detectedAction: null, confidence: null,
      targetTaskId: null, oldValues: null, newValues: null,
      confirmationStatus: null, approvalStatus: null, approverUserId: null,
      managerNotified: false, executionStatus: 'FAILED',
      errorMessage: (err as Error).message ?? 'unknown processing error',
      pendingActionId: null,
    });

    // Graceful fallback: never leave the user hanging on an unexpected backend
    // failure. (Route-level 4xx/5xx already reply via dispatchInternal; this
    // covers throws above that layer — e.g. user resolution / DB errors.)
    try {
      const { sendTextMessage } = await import('../whatsapp/sender');
      await sendTextMessage({
        to: item.fromPhone,
        text: 'אירעה שגיאה זמנית בעיבוד ההודעה. אנא נסה שוב בעוד מספר דקות.',
      });
    } catch (replyErr) {
      log.error({ err: replyErr, msgId: item.msgId }, 'Failed to send fallback error reply');
    }

    if (!isFallback) {
      try {
        await markFailed(item.msgId, (err as Error).message ?? 'unknown');
      } catch (markErr) {
        log.error({ err: markErr, msgId: item.msgId }, 'Failed to mark queue row failed');
      }
    }
  }
}

/**
 * Startup / periodic recovery: reprocess any messages left 'pending' by a crash.
 * Safe to run on every instance — claimPending uses FOR UPDATE SKIP LOCKED.
 */
export async function recoverInboundQueue(): Promise<void> {
  try {
    const pending = await claimPending();
    for (const item of pending) {
      await processInbound(item);
    }
  } catch (err) {
    log.error({ err }, 'Inbound queue recovery failed');
  }
}

// ── Message router ────────────────────────────────────────────────────────────

async function handleIncomingMessage(from: string, text: string, quotedWamid?: string): Promise<void> {
  const { sendTextMessage } = await import('../whatsapp/sender');

  if (!checkRateLimit(from)) {
    await sendTextMessage({ to: from, text: 'יותר מדי הודעות. אנא המתן דקה ונסה שוב.' });
    return;
  }

  const normalized = text.trim().toLowerCase();
  const uuidPat = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

  const confirmMatch = normalized.match(new RegExp(`^(כן|yes)\\s+(${uuidPat})`, 'i'));
  const cancelMatch  = normalized.match(new RegExp(`^(לא|no)\\s+(${uuidPat})`, 'i'));
  const approveMatch = normalized.match(new RegExp(`^(אשר|approve)\\s+(${uuidPat})`, 'i'));
  const rejectMatch  = normalized.match(new RegExp(`^(דחה|reject)\\s+(${uuidPat})`, 'i'));

  if (confirmMatch) {
    await dispatchInternal(from, '/tasks/confirm', { pendingActionId: confirmMatch[2], decision: 'CONFIRM' });
    return;
  }
  if (cancelMatch) {
    await dispatchInternal(from, '/tasks/confirm', { pendingActionId: cancelMatch[2], decision: 'CANCEL' });
    return;
  }
  if (approveMatch) {
    await dispatchInternal(from, '/tasks/approve', { pendingActionId: approveMatch[2], decision: 'APPROVE' });
    return;
  }
  if (rejectMatch) {
    await dispatchInternal(from, '/tasks/approve', { pendingActionId: rejectMatch[2], decision: 'REJECT' });
    return;
  }

  // All other messages → AI intent parser (Phase 5)
  const { resolveUserByPhone } = await import('../auth/userResolver');
  const auth = await resolveUserByPhone(from);
  if (!auth.ok) {
    const text = auth.reason === 'INACTIVE_USER'
      ? 'המשתמש שלך אינו פעיל במערכת.\nיש לפנות למנהל המערכת לצורך הפעלת ההרשאה.'
      : 'המספר ממנו נשלחה ההודעה אינו מזוהה כעובד פעיל במערכת.\nיש לפנות למנהל המערכת לצורך פתיחת הרשאה.';
    await sendTextMessage({ to: from, text });
    return;
  }

  // First message of the day → greet by name + auto-open the v2 menu (K6 /
  // SPEC_FIELD_V2 §5 "שלום דני, מה תרצה לעשות?"). Coalesced into one message under
  // a paced provider; unchanged two-message UX under Meta. See greetAndOpenMenu.
  const { menuSent } = await greetAndOpenMenu(from, auth.user, text);

  // If the greeter already sent the menu AND the text was itself a menu
  // trigger (e.g. "שלום", "היי", "תפריט"), skip handleAIMessage — its only job
  // for this input would be to reopen the same menu.
  if (menuSent) {
    const { MENU_TRIGGER_RE } = await import('../ai/menu');
    if (MENU_TRIGGER_RE.test(text.trim())) return;
  }

  const { handleAIMessage } = await import('../ai/router');
  await handleAIMessage(auth.user, text, quotedWamid);
}

/**
 * First-message-of-the-day greeting + auto-opened v2 menu.
 *
 * Returns `{ menuSent }`. When true and the incoming text was a MENU_TRIGGER,
 * the caller MUST skip `handleAIMessage` (it would only reopen the same menu).
 *
 * Under a PACED provider (Green API delays every send ~15s server-side) the
 * greeting and the menu are ALWAYS coalesced into a SINGLE message — including
 * when the user's own text was itself a menu trigger. In the original design
 * the greeter left `menuText=null` on a trigger and relied on
 * `handleAIMessage → showMenu` to open it, but under paced sending that meant
 * a ~15 s gap between the greeting and the menu (the user sees "בוקר טוב…"
 * alone for 15 s). Coalescing here eliminates the gap and, via the returned
 * `menuSent` flag, lets the caller skip the duplicate menu send from
 * `handleAIMessage`.
 *
 * Under an unpaced provider (Meta) two separate sends are cheap, so the
 * previous byte-for-byte behavior is preserved (greeting, then a separate
 * menu — or when the text WAS a menu trigger, greeting only + let
 * `handleAIMessage` open the menu, matching the pre-PR#2 rollback baseline).
 *
 * Every step is best-effort — a greeting/menu failure never blocks the request.
 */
export async function greetAndOpenMenu(from: string, user: ResolvedUser, incomingText: string): Promise<{ menuSent: boolean }> {
  const { sendTextMessage } = await import('../whatsapp/sender');
  try {
    const { claimDailyGreeting, buildGreeting } = await import('../services/greetings');
    if (!(await claimDailyGreeting(from))) return { menuSent: false };
    const greeting = buildGreeting(user.name);

    const { MENU_TRIGGER_RE, renderMenu } = await import('../ai/menu');
    const textWasTrigger = MENU_TRIGGER_RE.test(incomingText.trim());
    const menuText = renderMenu(user); // best-effort — pure formatter, never throws in practice

    const { getProvider } = await import('../whatsapp/provider');
    if (getProvider().paced) {
      // Paced (Green API): ALWAYS coalesce greeting + menu into one send so the
      // user never waits a full pace between the two. Menu is now considered
      // "sent" regardless of whether the text was a trigger, so the caller
      // skips handleAIMessage's redundant reopen.
      await sendTextMessage({ to: from, text: `${greeting}\n\n${menuText}` });
      return { menuSent: true };
    }

    // Unpaced (Meta): match the previous rollback baseline exactly.
    await sendTextMessage({ to: from, text: greeting });
    if (!textWasTrigger) {
      await sendTextMessage({ to: from, text: menuText });
      return { menuSent: true };
    }
    // Trigger text under Meta → let handleAIMessage → showMenu open it (two
    // sends are cheap here, and rollback shape is preserved).
    return { menuSent: false };
  } catch (err) {
    log.error({ err, from }, 'Daily greeting failed (continuing)');
    return { menuSent: false };
  }
}
