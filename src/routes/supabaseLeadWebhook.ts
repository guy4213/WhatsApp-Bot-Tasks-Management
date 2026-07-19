/**
 * Supabase Database Webhook — IncomingLead assignment trigger.
 *
 * POST /webhooks/supabase/lead-assigned
 *
 * Fires on every UPDATE of `IncomingLead`, regardless of which channel wrote
 * the row (CRM UI, voice assistant, WhatsApp bot, manual SQL). Complements
 * the existing 15-minute poller (D3-T3) by delivering the worker alert
 * within ~1 second of the CRM claim, while the poller remains a safety net
 * for missed webhook deliveries.
 *
 * Configuration in Supabase Dashboard:
 *   Database → Webhooks → Create a new hook
 *     Name:    lead-assigned
 *     Table:   IncomingLead
 *     Events:  UPDATE
 *     Type:    HTTP Request
 *     URL:     https://<bot-host>/webhooks/supabase/lead-assigned
 *     Headers: x-webhook-secret: <value of SUPABASE_LEAD_WEBHOOK_SECRET>
 *
 * Security & reliability:
 *   - Auth: timing-safe compare of `x-webhook-secret` against the env var.
 *     Any failure — header missing, wrong value, env unset — returns 404 so
 *     the endpoint is invisible to probes.
 *   - ACK 200 immediately, then process asynchronously. A non-2xx or slow
 *     response would trigger Supabase's retry loop; since the atomic claim
 *     in `tryClaimLeadNotification` is already idempotent, retries would
 *     mostly be no-ops but would still waste round-trips.
 *   - Transition filter: only NEW → ACTIVE status transitions matter for
 *     the ASSIGNED_TO_WORKER alert. Every other UPDATE (e.g. status stays
 *     ACTIVE, taskId is added, notifiedAt is updated) is ignored fast.
 *   - Race with ownerId writes: some channels write `status='ACTIVE'`
 *     before `ownerId` in a separate statement. When the webhook arrives
 *     for the first UPDATE, `record.ownerId` may still be null. The
 *     downstream `findAssignedLeadById` returns null in that case and
 *     `processAssignmentAlertForLead` releases the PENDING claim so the
 *     second UPDATE (with ownerId) can claim and send. No sleep required.
 *   - Idempotent by construction — safe to POST the same payload N times.
 */
import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import { moduleLogger } from '../utils/logger';
import { processAssignmentAlertForLead } from '../scheduler/jobs/leadAssignmentNotifier';

const log = moduleLogger('supabase-lead-webhook');

/**
 * Timing-safe check of `x-webhook-secret` against SUPABASE_LEAD_WEBHOOK_SECRET.
 * Fails closed: unset env var, missing header, or value mismatch all → false.
 */
export function verifySupabaseWebhookSecret(header: string | undefined): boolean {
  const expected = process.env.SUPABASE_LEAD_WEBHOOK_SECRET ?? '';
  if (!expected) return false;
  if (!header) return false;
  const got = Buffer.from(header);
  const exp = Buffer.from(expected);
  if (got.length !== exp.length) return false;
  return crypto.timingSafeEqual(got, exp);
}

interface SupabaseWebhookPayload {
  type?: string;
  table?: string;
  schema?: string;
  record?: { id?: string; status?: string; ownerId?: string | null } | null;
  old_record?: { id?: string; status?: string; ownerId?: string | null } | null;
}

/**
 * Returns true when the payload represents the transition we care about:
 * a NEW → ACTIVE status flip on IncomingLead. Also true when the trigger
 * was fired by a subsequent UPDATE that added the ownerId AFTER the status
 * was already ACTIVE — because the first webhook could have arrived before
 * ownerId was written (see route-level comment). The claim layer dedups
 * duplicate transitions.
 */
export function isAssignmentTransition(payload: SupabaseWebhookPayload): boolean {
  if (payload.type !== 'UPDATE') return false;
  if (payload.table !== 'IncomingLead') return false;
  const nowActive = payload.record?.status === 'ACTIVE';
  if (!nowActive) return false;
  const wasNew = payload.old_record?.status === 'NEW';
  const ownerJustSet =
    !!payload.record?.ownerId && !payload.old_record?.ownerId;
  return wasNew || ownerJustSet;
}

export async function supabaseLeadWebhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/supabase/lead-assigned', async (req, reply) => {
    // 1. Auth — any failure is an opaque 404 (endpoint invisible to probes).
    if (!verifySupabaseWebhookSecret(req.headers['x-webhook-secret'] as string | undefined)) {
      log.warn('Supabase lead webhook: auth failed — 404');
      return reply.code(404).send('Not Found');
    }

    // 2. ACK 200 immediately so Supabase does not retry. Downstream failures
    //    are logged; the poller safety net covers persistent gaps.
    reply.code(200).send('OK');

    const body = (req.body ?? {}) as SupabaseWebhookPayload;

    if (!isAssignmentTransition(body)) {
      // Uninteresting UPDATE — status didn't just flip to ACTIVE and ownerId
      // wasn't just populated. Nothing to do.
      return;
    }

    const leadId = body.record?.id;
    if (!leadId) {
      log.warn({ body }, 'Supabase lead webhook: ACTIVE transition without record.id — ignored');
      return;
    }

    try {
      const outcome = await processAssignmentAlertForLead(leadId);
      log.info({ leadId, outcome }, 'Supabase lead webhook: processed');
    } catch (err) {
      // processAssignmentAlertForLead is not supposed to throw — it swallows
      // per-step errors. This is a last-resort guard for a programmer error
      // or an out-of-band exception path we did not anticipate.
      log.error({ err, leadId }, 'Supabase lead webhook: unexpected error');
    }
  });
}
