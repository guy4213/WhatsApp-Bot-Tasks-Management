/**
 * Green API inbound webhook (PR#2) — HTTP contract + queueing behavior.
 *
 * The queue, the downstream processor, and PendingChoice are mocked; we assert
 * only the route's own logic: Bearer auth → 404, typeWebhook filtering, the
 * empty-idMessage guard, enqueue-before-ACK with `greenapi:${idMessage}` dedup,
 * and the number→command translation that happens BEFORE enqueue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const enqueueInbound      = vi.fn();
const processInbound      = vi.fn().mockResolvedValue(undefined);
const resolvePendingChoice = vi.fn().mockResolvedValue(null);
const handleGreenApiStateChange = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/inboundQueue', () => ({
  enqueueInbound: (...a: unknown[]) => enqueueInbound(...a),
}));
vi.mock('../routes/webhook', () => ({
  processInbound: (...a: unknown[]) => processInbound(...a),
}));
vi.mock('../services/pendingChoice', () => ({
  resolvePendingChoice: (...a: unknown[]) => resolvePendingChoice(...a),
}));
vi.mock('../services/greenapiHealth', () => ({
  handleGreenApiStateChange: (...a: unknown[]) => handleGreenApiStateChange(...a),
}));

import { greenapiWebhookRoutes } from '../routes/greenapiWebhook';

const TOKEN = 'secret-webhook-token';
let app: FastifyInstance;

/** Let the post-ACK `await processInbound(...)` (fire-and-forget vs inject) settle. */
const flush = () => new Promise((r) => setImmediate(r));

function textWebhook(idMessage: string, text: string, timestamp?: number) {
  const payload: Record<string, unknown> = {
    typeWebhook: 'incomingMessageReceived',
    idMessage,
    senderData: { chatId: '972501234567@c.us', sender: '972501234567@c.us' },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
  };
  if (timestamp !== undefined) payload.timestamp = timestamp;
  return payload;
}

async function post(payload: unknown, token: string | null = TOKEN) {
  return app.inject({
    method: 'POST',
    url: '/greenapi/webhook',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: payload as object,
  });
}

beforeEach(async () => {
  enqueueInbound.mockReset().mockResolvedValue(true);
  processInbound.mockReset().mockResolvedValue(undefined);
  resolvePendingChoice.mockReset().mockResolvedValue(null);
  handleGreenApiStateChange.mockReset().mockResolvedValue(undefined);
  process.env.GREENAPI_WEBHOOK_TOKEN = TOKEN;
  // Reconnect-protection envs — must be off by default so unrelated tests
  // exercise the normal path (fail-open freshness, no suppression).
  delete process.env.GREENAPI_INBOUND_SUPPRESSED;
  delete process.env.GREENAPI_MAX_INBOUND_AGE_SEC;
  app = Fastify();
  await app.register(greenapiWebhookRoutes);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('auth', () => {
  it('wrong token → 404, nothing enqueued', async () => {
    const res = await post(textWebhook('ID1', 'hi'), 'wrong-token');
    expect(res.statusCode).toBe(404);
    expect(enqueueInbound).not.toHaveBeenCalled();
  });

  it('missing Authorization header → 404', async () => {
    const res = await post(textWebhook('ID1', 'hi'), null);
    expect(res.statusCode).toBe(404);
    expect(enqueueInbound).not.toHaveBeenCalled();
  });

  it('unset GREENAPI_WEBHOOK_TOKEN → 404 (fail closed)', async () => {
    delete process.env.GREENAPI_WEBHOOK_TOKEN;
    const res = await post(textWebhook('ID1', 'hi'), TOKEN);
    expect(res.statusCode).toBe(404);
    expect(enqueueInbound).not.toHaveBeenCalled();
  });
});

describe('type filtering & idMessage guard', () => {
  it('incomingMessageReceived → 200, enqueued with greenapi:<idMessage>, processed', async () => {
    const res = await post(textWebhook('ABC123', 'שלום'));
    await flush();
    expect(res.statusCode).toBe(200);
    expect(enqueueInbound).toHaveBeenCalledTimes(1);
    const item = enqueueInbound.mock.calls[0][0] as { msgId: string; fromPhone: string; payload: Record<string, unknown> };
    expect(item.msgId).toBe('greenapi:ABC123');
    expect(item.fromPhone).toBe('972501234567');
    expect(item.payload.type).toBe('text');
    expect((item.payload.text as { body: string }).body).toBe('שלום');
    expect(processInbound).toHaveBeenCalledTimes(1);
  });

  it('non-inbound typeWebhook → 200, NOT enqueued', async () => {
    const res = await post({ typeWebhook: 'outgoingMessageStatus', idMessage: 'X', status: 'delivered' });
    expect(res.statusCode).toBe(200);
    expect(enqueueInbound).not.toHaveBeenCalled();
    expect(processInbound).not.toHaveBeenCalled();
    expect(handleGreenApiStateChange).not.toHaveBeenCalled();
  });

  it('stateInstanceChanged → 200, drives handleGreenApiStateChange with the state + "webhook" source', async () => {
    const res = await post({
      typeWebhook: 'stateInstanceChanged',
      instanceData: { idInstance: 1101, wid: '972501234567@c.us', typeInstance: 'whatsapp' },
      timestamp: 1719800000,
      stateInstance: 'notAuthorized',
    });
    await flush();
    expect(res.statusCode).toBe(200);
    expect(handleGreenApiStateChange).toHaveBeenCalledWith('notAuthorized', 'webhook');
    expect(enqueueInbound).not.toHaveBeenCalled();
    expect(processInbound).not.toHaveBeenCalled();
  });

  it('stateInstanceChanged handler throwing does NOT crash the route (200 still returned)', async () => {
    handleGreenApiStateChange.mockRejectedValueOnce(new Error('boom'));
    const res = await post({
      typeWebhook: 'stateInstanceChanged',
      stateInstance: 'authorized',
    });
    await flush();
    expect(res.statusCode).toBe(200);
    expect(handleGreenApiStateChange).toHaveBeenCalledTimes(1);
  });

  it('empty idMessage → 200, NOT enqueued (never an empty PK)', async () => {
    const res = await post(textWebhook('', 'hi'));
    expect(res.statusCode).toBe(200);
    expect(enqueueInbound).not.toHaveBeenCalled();
  });
});

describe('dedup', () => {
  it('the same idMessage twice → processed exactly once', async () => {
    enqueueInbound.mockReset()
      .mockResolvedValueOnce(true)   // first delivery: newly enqueued
      .mockResolvedValueOnce(false); // re-delivery: ON CONFLICT DO NOTHING
    await post(textWebhook('DUP1', 'hi')); await flush();
    await post(textWebhook('DUP1', 'hi')); await flush();
    expect(enqueueInbound).toHaveBeenCalledTimes(2);
    expect(processInbound).toHaveBeenCalledTimes(1);
  });
});

describe('number → command translation (before enqueue)', () => {
  it('a numeric reply is resolved via PendingChoice; the stored payload carries the command', async () => {
    resolvePendingChoice.mockResolvedValueOnce('כן 9c-uuid');
    await post(textWebhook('NUM1', '2')); await flush();
    expect(resolvePendingChoice).toHaveBeenCalledWith('972501234567', '2');
    const item = enqueueInbound.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect((item.payload.text as { body: string }).body).toBe('כן 9c-uuid'); // translated, not "2"
    expect(processInbound).toHaveBeenCalledTimes(1);
  });

  it('a non-matching reply stays raw (PendingChoice returns null)', async () => {
    resolvePendingChoice.mockResolvedValueOnce(null);
    await post(textWebhook('NUM2', 'שלום')); await flush();
    const item = enqueueInbound.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect((item.payload.text as { body: string }).body).toBe('שלום');
  });
});

// ── Swipe-reply / long-press → Reply. Green API delivers this as
//    typeMessage='quotedMessage'; before the fix the extractor returned null
//    and the whole ETA / messageRefs chain was silently dropped.
describe('quotedMessage (swipe-reply) — preserves text + stanzaId as context.id', () => {
  function quotedWebhook(idMessage: string, text: string, stanzaId: string) {
    return {
      typeWebhook: 'incomingMessageReceived',
      idMessage,
      senderData: { chatId: '972501234567@c.us', sender: '972501234567@c.us' },
      messageData: {
        typeMessage: 'quotedMessage',
        extendedTextMessageData: { text },
        quotedMessage: { stanzaId, typeMessage: 'extendedTextMessage' },
      },
    };
  }

  it('reply text is extracted and stanzaId is threaded as context.id', async () => {
    const res = await post(quotedWebhook('QR1', 'חצי שעה', 'BAE5F1ORIGWAMID'));
    await flush();
    expect(res.statusCode).toBe(200);
    expect(enqueueInbound).toHaveBeenCalledTimes(1);
    const item = enqueueInbound.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(item.payload.type).toBe('text');
    expect((item.payload.text as { body: string }).body).toBe('חצי שעה');
    expect((item.payload.context as { id: string }).id).toBe('BAE5F1ORIGWAMID');
    expect(processInbound).toHaveBeenCalledTimes(1);
  });

  it('older schema variant (textMessageData.textMessage) still works', async () => {
    const res = await post({
      typeWebhook: 'incomingMessageReceived',
      idMessage: 'QR2',
      senderData: { chatId: '972501234567@c.us', sender: '972501234567@c.us' },
      messageData: {
        typeMessage: 'quotedMessage',
        textMessageData: { textMessage: '30 דקות' },
        quotedMessage: { stanzaId: 'ORIG2' },
      },
    });
    await flush();
    expect(res.statusCode).toBe(200);
    const item = enqueueInbound.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect((item.payload.text as { body: string }).body).toBe('30 דקות');
    expect((item.payload.context as { id: string }).id).toBe('ORIG2');
  });
});

// ── Reconnect protection (2026-07-19 incident): after a long Green API socket
//    outage the server dumps its 24h backlog. Without a freshness filter the
//    router replies to every stale message and WhatsApp raises a yellowCard on
//    the sender. GREENAPI_MAX_INBOUND_AGE_SEC (default 300) drops stale
//    webhooks; GREENAPI_INBOUND_SUPPRESSED is the operator kill switch.
describe('freshness cutoff (GREENAPI_MAX_INBOUND_AGE_SEC)', () => {
  it('a 10s-old message is processed (well under the 300s default)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await post(textWebhook('FRESH1', 'שלום', now - 10));
    await flush();
    expect(res.statusCode).toBe(200);
    expect(enqueueInbound).toHaveBeenCalledTimes(1);
    expect(processInbound).toHaveBeenCalledTimes(1);
  });

  it('a 3600s-old message is dropped with 200 (never enqueued, never processed)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await post(textWebhook('STALE1', 'שלום', now - 3600));
    await flush();
    // MUST be 200 — a 4xx/5xx would make Green API keep the notification and retry.
    expect(res.statusCode).toBe(200);
    expect(enqueueInbound).not.toHaveBeenCalled();
    expect(processInbound).not.toHaveBeenCalled();
  });

  it('missing timestamp → fail-open (message processed)', async () => {
    const res = await post(textWebhook('NOTS1', 'שלום')); // no timestamp
    await flush();
    expect(res.statusCode).toBe(200);
    expect(enqueueInbound).toHaveBeenCalledTimes(1);
    expect(processInbound).toHaveBeenCalledTimes(1);
  });

  it('GREENAPI_MAX_INBOUND_AGE_SEC overrides the 300s default', async () => {
    process.env.GREENAPI_MAX_INBOUND_AGE_SEC = '60';
    const now = Math.floor(Date.now() / 1000);
    // 100s ago — would pass with default 300, blocked by override 60.
    const res = await post(textWebhook('OVR1', 'שלום', now - 100));
    await flush();
    expect(res.statusCode).toBe(200);
    expect(enqueueInbound).not.toHaveBeenCalled();
  });

  it('drops before enqueue AND before number→command translation (no PendingChoice lookup)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await post(textWebhook('STALE2', '2', now - 999));
    await flush();
    expect(resolvePendingChoice).not.toHaveBeenCalled();
    expect(enqueueInbound).not.toHaveBeenCalled();
  });
});

describe('inbound suppress (GREENAPI_INBOUND_SUPPRESSED)', () => {
  it('=true → 200 with zero processing (no enqueue, no PendingChoice, no processInbound)', async () => {
    process.env.GREENAPI_INBOUND_SUPPRESSED = 'true';
    const now = Math.floor(Date.now() / 1000);
    const res = await post(textWebhook('SUP1', 'שלום', now));
    await flush();
    expect(res.statusCode).toBe(200);
    expect(enqueueInbound).not.toHaveBeenCalled();
    expect(processInbound).not.toHaveBeenCalled();
    expect(resolvePendingChoice).not.toHaveBeenCalled();
  });

  it('=true also suppresses stateInstanceChanged handling', async () => {
    process.env.GREENAPI_INBOUND_SUPPRESSED = 'true';
    const res = await post({
      typeWebhook: 'stateInstanceChanged',
      stateInstance: 'notAuthorized',
    });
    await flush();
    expect(res.statusCode).toBe(200);
    expect(handleGreenApiStateChange).not.toHaveBeenCalled();
  });

  it('=true precedes the freshness cutoff (a stale message returns 200 without evaluating age)', async () => {
    process.env.GREENAPI_INBOUND_SUPPRESSED = 'true';
    const now = Math.floor(Date.now() / 1000);
    const res = await post(textWebhook('SUP2', 'שלום', now - 999999));
    expect(res.statusCode).toBe(200);
    expect(enqueueInbound).not.toHaveBeenCalled();
  });

  it('=true still requires a valid Bearer token (auth still returns 404)', async () => {
    process.env.GREENAPI_INBOUND_SUPPRESSED = 'true';
    const res = await post(textWebhook('SUP3', 'שלום'), 'wrong-token');
    expect(res.statusCode).toBe(404);
  });

  it('unset / "false" / anything != "true" → suppression OFF (normal processing)', async () => {
    process.env.GREENAPI_INBOUND_SUPPRESSED = 'false';
    const res = await post(textWebhook('SUP4', 'שלום'));
    await flush();
    expect(res.statusCode).toBe(200);
    expect(enqueueInbound).toHaveBeenCalledTimes(1);
  });
});
