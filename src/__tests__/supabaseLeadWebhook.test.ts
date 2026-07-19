/**
 * Supabase Database Webhook — IncomingLead assignment trigger.
 *
 * Covers:
 *   - auth: missing / wrong / correct secret
 *   - transition filter: NEW→ACTIVE, owner-just-set, uninteresting UPDATE
 *   - happy path: 200 ACK + downstream processAssignmentAlertForLead call
 *   - ignore payloads without a record.id
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const processAssignmentAlertForLead = vi.fn();
vi.mock('../scheduler/jobs/leadAssignmentNotifier', () => ({
  processAssignmentAlertForLead: (...args: unknown[]) => processAssignmentAlertForLead(...args),
}));

import {
  isAssignmentTransition,
  verifySupabaseWebhookSecret,
  supabaseLeadWebhookRoutes,
} from '../routes/supabaseLeadWebhook';
import Fastify, { type FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  processAssignmentAlertForLead.mockReset();
  processAssignmentAlertForLead.mockResolvedValue('sent');
  process.env.SUPABASE_LEAD_WEBHOOK_SECRET = 'test-secret-value';
  app = Fastify();
  await app.register(supabaseLeadWebhookRoutes);
});

afterEach(async () => {
  delete process.env.SUPABASE_LEAD_WEBHOOK_SECRET;
  await app.close();
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('verifySupabaseWebhookSecret', () => {
  it('returns true on exact match', () => {
    process.env.SUPABASE_LEAD_WEBHOOK_SECRET = 'abc123';
    expect(verifySupabaseWebhookSecret('abc123')).toBe(true);
  });

  it('returns false when env var is unset (fail closed)', () => {
    delete process.env.SUPABASE_LEAD_WEBHOOK_SECRET;
    expect(verifySupabaseWebhookSecret('abc123')).toBe(false);
  });

  it('returns false when header is missing', () => {
    process.env.SUPABASE_LEAD_WEBHOOK_SECRET = 'abc123';
    expect(verifySupabaseWebhookSecret(undefined)).toBe(false);
  });

  it('returns false on value mismatch', () => {
    process.env.SUPABASE_LEAD_WEBHOOK_SECRET = 'abc123';
    expect(verifySupabaseWebhookSecret('wrong')).toBe(false);
  });

  it('returns false on length mismatch (timing-safe guard)', () => {
    process.env.SUPABASE_LEAD_WEBHOOK_SECRET = 'abc123';
    expect(verifySupabaseWebhookSecret('abc')).toBe(false);
  });
});

// ── Transition filter ────────────────────────────────────────────────────────

describe('isAssignmentTransition', () => {
  it('true when status flips NEW → ACTIVE', () => {
    expect(isAssignmentTransition({
      type: 'UPDATE',
      table: 'IncomingLead',
      record: { id: 'l1', status: 'ACTIVE', ownerId: 'u1' },
      old_record: { id: 'l1', status: 'NEW', ownerId: null },
    })).toBe(true);
  });

  it('true when ownerId is just set on an already-ACTIVE row (second-write race)', () => {
    expect(isAssignmentTransition({
      type: 'UPDATE',
      table: 'IncomingLead',
      record: { id: 'l1', status: 'ACTIVE', ownerId: 'u1' },
      old_record: { id: 'l1', status: 'ACTIVE', ownerId: null },
    })).toBe(true);
  });

  it('false when status stays ACTIVE and owner unchanged (unrelated UPDATE)', () => {
    expect(isAssignmentTransition({
      type: 'UPDATE',
      table: 'IncomingLead',
      record: { id: 'l1', status: 'ACTIVE', ownerId: 'u1' },
      old_record: { id: 'l1', status: 'ACTIVE', ownerId: 'u1' },
    })).toBe(false);
  });

  it('false when status is not ACTIVE (e.g. row stays NEW)', () => {
    expect(isAssignmentTransition({
      type: 'UPDATE',
      table: 'IncomingLead',
      record: { id: 'l1', status: 'NEW', ownerId: null },
      old_record: { id: 'l1', status: 'NEW', ownerId: null },
    })).toBe(false);
  });

  it('false for INSERT / DELETE (only UPDATE is meaningful here)', () => {
    expect(isAssignmentTransition({
      type: 'INSERT',
      table: 'IncomingLead',
      record: { id: 'l1', status: 'ACTIVE', ownerId: 'u1' },
    })).toBe(false);
  });

  it('false for a different table', () => {
    expect(isAssignmentTransition({
      type: 'UPDATE',
      table: 'Task',
      record: { id: 'l1', status: 'ACTIVE', ownerId: 'u1' },
      old_record: { id: 'l1', status: 'NEW', ownerId: null },
    })).toBe(false);
  });
});

// ── Route ────────────────────────────────────────────────────────────────────

describe('POST /webhooks/supabase/lead-assigned', () => {
  const PATH = '/webhooks/supabase/lead-assigned';

  it('returns 404 (opaque) when secret header is missing', async () => {
    const res = await app.inject({ method: 'POST', url: PATH, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(processAssignmentAlertForLead).not.toHaveBeenCalled();
  });

  it('returns 404 when secret header is wrong', async () => {
    const res = await app.inject({
      method: 'POST', url: PATH,
      headers: { 'x-webhook-secret': 'wrong' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(processAssignmentAlertForLead).not.toHaveBeenCalled();
  });

  it('returns 200 and CALLS processAssignmentAlertForLead on a NEW→ACTIVE transition', async () => {
    const res = await app.inject({
      method: 'POST', url: PATH,
      headers: { 'x-webhook-secret': 'test-secret-value' },
      payload: {
        type: 'UPDATE',
        table: 'IncomingLead',
        record: { id: 'lead-777', status: 'ACTIVE', ownerId: 'u-1' },
        old_record: { id: 'lead-777', status: 'NEW', ownerId: null },
      },
    });
    expect(res.statusCode).toBe(200);
    // Async work runs on process.nextTick after reply.send — a microtask flush
    // lets it settle before we assert.
    await new Promise((r) => setImmediate(r));
    expect(processAssignmentAlertForLead).toHaveBeenCalledWith('lead-777');
  });

  it('returns 200 but DOES NOT call the handler on an uninteresting UPDATE', async () => {
    const res = await app.inject({
      method: 'POST', url: PATH,
      headers: { 'x-webhook-secret': 'test-secret-value' },
      payload: {
        type: 'UPDATE',
        table: 'IncomingLead',
        record: { id: 'lead-777', status: 'ACTIVE', ownerId: 'u-1' },
        old_record: { id: 'lead-777', status: 'ACTIVE', ownerId: 'u-1' },
      },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(processAssignmentAlertForLead).not.toHaveBeenCalled();
  });

  it('returns 200 and ignores payloads missing record.id (defensive)', async () => {
    const res = await app.inject({
      method: 'POST', url: PATH,
      headers: { 'x-webhook-secret': 'test-secret-value' },
      payload: {
        type: 'UPDATE',
        table: 'IncomingLead',
        record: { status: 'ACTIVE', ownerId: 'u-1' },
        old_record: { status: 'NEW', ownerId: null },
      },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(processAssignmentAlertForLead).not.toHaveBeenCalled();
  });
});
