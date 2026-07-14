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

vi.mock('../services/inboundQueue', () => ({
  enqueueInbound: (...a: unknown[]) => enqueueInbound(...a),
}));
vi.mock('../routes/webhook', () => ({
  processInbound: (...a: unknown[]) => processInbound(...a),
}));
vi.mock('../services/pendingChoice', () => ({
  resolvePendingChoice: (...a: unknown[]) => resolvePendingChoice(...a),
}));

import { greenapiWebhookRoutes } from '../routes/greenapiWebhook';

const TOKEN = 'secret-webhook-token';
let app: FastifyInstance;

/** Let the post-ACK `await processInbound(...)` (fire-and-forget vs inject) settle. */
const flush = () => new Promise((r) => setImmediate(r));

function textWebhook(idMessage: string, text: string) {
  return {
    typeWebhook: 'incomingMessageReceived',
    idMessage,
    senderData: { chatId: '972501234567@c.us', sender: '972501234567@c.us' },
    messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } },
  };
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
  process.env.GREENAPI_WEBHOOK_TOKEN = TOKEN;
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
