/**
 * D3-T3 + D3-T4 — lead assignment notifier.
 *
 * D3-T3: polls IncomingLead for rows where ownerId just flipped null → User.id;
 *        sends one WhatsApp alert to the assigned inspector and dedups via
 *        WhatsappLeadNotification(leadId, 'ASSIGNED_TO_WORKER').
 *
 * D3-T4: finds unassigned daytime leads > 1 hour old (09:30–22:00 Jerusalem)
 *        with no prior escalation; sends Sasha one alert per lead with an
 *        AI-suggested worker. Dedup via WhatsappLeadNotification(leadId, 'ESCALATED_1H').
 *
 * Dedup guarantees at-most-one delivery per (leadId, eventKind): a read-only
 * check runs BEFORE attempting to send, and the WhatsappLeadNotification row
 * is only INSERTed (via claimLeadNotification) AFTER the WhatsApp send
 * actually succeeds — never before. A failed send is retried on the next
 * tick instead of being silently marked as handled.
 * Per-lead failures are isolated — the loop continues to the next row.
 */
import { sendTextMessage } from '../../whatsapp/sender';
import { moduleLogger } from '../../utils/logger';
import {
  findNewlyAssignedLeads,
  findEscalationCandidates,
  findActiveInspectors,
  type IncomingLeadRow,
  type AssignedLeadRow,
} from '../../services/incomingLeads';
import { claimLeadNotification, isLeadNotificationSent } from '../../services/leadNotificationLog';
import { suggestWorkerForLead, type InspectorCandidate } from '../../ai/leadSuggester';
import { normalizeIsraeliPhone } from '../../auth/phoneNormalizer';
import { getLeadsViewerPhones } from '../../services/specialUsers';

const log = moduleLogger('leadAssignmentNotifier');

const BODY_MAX = 300;

function renderLeadBody(body: string | null): string | null {
  if (!body?.trim()) return null;
  const t = body.trim();
  return t.length > BODY_MAX ? t.slice(0, BODY_MAX) + '...' : t;
}

function renderSender(fromName: string | null, fromEmail: string | null): string {
  const parts = [fromName, fromEmail ? `(${fromEmail})` : null].filter(Boolean);
  return parts.join(' ') || 'לא ידוע';
}

// Standard Hebrew lead labels (inline — appear in 2 functions here)
const L_SENDER  = 'שולח';
const L_SUBJECT = 'נושא';
const L_BODY    = 'תוכן';
const L_SUGGES  = 'הצעת שיבוץ';

// ── D3-T3 alert ──────────────────────────────────────────────────────────────

function formatWorkerAssignmentAlert(lead: AssignedLeadRow): string {
  const lines: string[] = [
    'ליד חדש שויך אליך:',
    '',
    `${L_SENDER}: ${renderSender(lead.fromName, lead.fromEmail)}`,
  ];
  if (lead.subject) lines.push(`${L_SUBJECT}: ${lead.subject}`);
  const body = renderLeadBody(lead.body);
  if (body) lines.push(`${L_BODY}: ${body}`);
  lines.push('', 'לטיפול ועדכון ב-CRM');
  return lines.join('\n');
}

async function processAssignmentAlerts(): Promise<void> {
  const rows = await findNewlyAssignedLeads();
  if (rows.length === 0) return;

  log.info({ count: rows.length }, 'Lead assignment notifier: newly assigned leads');

  for (const lead of rows) {
    // Read-only dedup check FIRST — do not mark as sent until the WhatsApp
    // send below actually succeeds.
    let alreadySent: boolean;
    try {
      alreadySent = await isLeadNotificationSent(lead.id, 'ASSIGNED_TO_WORKER');
    } catch (err) {
      log.error({ err, leadId: lead.id }, 'isLeadNotificationSent check failed for ASSIGNED_TO_WORKER');
      continue;
    }
    if (alreadySent) continue;

    if (!lead.workerPhone) {
      log.warn({ leadId: lead.id, workerId: lead.workerId }, 'Assigned worker has no phone — skipping alert');
      // Permanent condition for this lead — record as handled so it isn't
      // re-selected (and re-logged) on every tick. Not the "mark before send"
      // bug: no message was ever meant to go out here.
      await claimLeadNotification(lead.id, 'ASSIGNED_TO_WORKER').catch((err) => {
        log.error({ err, leadId: lead.id }, 'Failed to record no-phone lead as handled');
      });
      continue;
    }

    try {
      const phone = normalizeIsraeliPhone(lead.workerPhone) ?? lead.workerPhone;
      await sendTextMessage({ to: phone, text: formatWorkerAssignmentAlert(lead) });
    } catch (err) {
      log.error(
        { err, leadId: lead.id, phone: lead.workerPhone },
        'Worker assignment alert WhatsApp send FAILED — will retry next tick (not marked as sent)',
      );
      continue;
    }

    // Mark as sent ONLY after the WhatsApp send actually succeeded.
    await claimLeadNotification(lead.id, 'ASSIGNED_TO_WORKER').catch((err) => {
      log.error(
        { err, leadId: lead.id },
        'Failed to record ASSIGNED_TO_WORKER as sent after a successful WhatsApp send — risk of a duplicate on the next tick',
      );
    });
    log.info({ leadId: lead.id, workerId: lead.workerId }, 'Worker assignment alert sent');
  }
}

// ── D3-T4 escalation ─────────────────────────────────────────────────────────

function formatEscalationAlert(
  lead: IncomingLeadRow,
  workerName: string | null,
  reason: string,
): string {
  const lines: string[] = [
    'ליד ממתין לשיבוץ — מעל שעה:',
    '',
    `${L_SENDER}: ${renderSender(lead.fromName, lead.fromEmail)}`,
  ];
  if (lead.subject) lines.push(`${L_SUBJECT}: ${lead.subject}`);
  const body = renderLeadBody(lead.body);
  if (body) lines.push(`${L_BODY}: ${body}`);
  const sugLine = workerName
    ? `${L_SUGGES}: ${workerName} — ${reason}`
    : `${L_SUGGES}: לא נמצאה התאמה`;
  lines.push('', sugLine, 'לשיבוץ ב-CRM');
  return lines.join('\n');
}

async function processEscalations(): Promise<void> {
  // Leads viewers (Sasha + dev observers) receive the escalation. Phones are
  // looked up from the DB by name — no env vars. When nobody is configured,
  // the escalation job silently no-ops.
  const rawPhones = await getLeadsViewerPhones();
  const viewerPhones = rawPhones.map((p) => normalizeIsraeliPhone(p) ?? p);
  if (viewerPhones.length === 0) {
    log.debug('No active leads viewers with phones in DB — escalation job skipped');
    return;
  }

  const rows = await findEscalationCandidates();
  if (rows.length === 0) return;

  log.info({ count: rows.length }, 'Lead assignment notifier: escalation candidates');

  // Fetch inspector candidates once for the whole batch (AI suggestion input).
  let candidates: InspectorCandidate[];
  try {
    candidates = await findActiveInspectors();
  } catch (err) {
    log.error({ err }, 'findActiveInspectors failed — escalations skipped this tick');
    return;
  }

  for (const lead of rows) {
    // Read-only dedup check FIRST — do not mark as sent until at least one
    // viewer actually receives the WhatsApp message below.
    let alreadySent: boolean;
    try {
      alreadySent = await isLeadNotificationSent(lead.id, 'ESCALATED_1H');
    } catch (err) {
      log.error({ err, leadId: lead.id }, 'isLeadNotificationSent check failed for ESCALATED_1H');
      continue;
    }
    if (alreadySent) continue;

    const suggestion = await suggestWorkerForLead(
      { service: lead.subject, messageText: lead.body, customerName: lead.fromName },
      candidates,
    );
    const workerName = suggestion.userId
      ? (candidates.find((c) => c.id === suggestion.userId)?.name ?? null)
      : null;

    const text = formatEscalationAlert(lead, workerName, suggestion.reason);
    // Fan out to every leads viewer (Sasha + dev observers). Failures are
    // isolated per recipient — one bad phone doesn't block the others.
    const results = await Promise.allSettled(
      viewerPhones.map((phone) => sendTextMessage({ to: phone, text })),
    );
    let delivered = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        delivered += 1;
      } else {
        log.error(
          { err: r.reason, leadId: lead.id, to: viewerPhones[i] },
          'Escalation alert WhatsApp send FAILED for this recipient',
        );
      }
    }

    if (delivered === 0) {
      log.error(
        { leadId: lead.id, recipients: viewerPhones.length },
        'Escalation alert: EVERY recipient send failed — will retry next tick (not marked as sent)',
      );
      continue;
    }

    // Mark as sent ONLY after at least one viewer actually received it.
    await claimLeadNotification(lead.id, 'ESCALATED_1H').catch((err) => {
      log.error(
        { err, leadId: lead.id },
        'Failed to record ESCALATED_1H as sent after a successful WhatsApp send — risk of a duplicate on the next tick',
      );
    });
    log.info(
      { leadId: lead.id, recipients: viewerPhones.length, delivered },
      'Escalation alert fanned out to leads viewers',
    );
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runLeadAssignmentNotifier(): Promise<void> {
  await processAssignmentAlerts();
  await processEscalations();
}
