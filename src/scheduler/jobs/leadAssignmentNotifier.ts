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
 * INSERT-first dedup (claim before send) guarantees at-most-one delivery per
 * (leadId, eventKind), consistent with completionNotifier + digestDispatcher.
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
import { claimLeadNotification } from '../../services/leadNotificationLog';
import { suggestWorkerForLead, type InspectorCandidate } from '../../ai/leadSuggester';
import { normalizeIsraeliPhone } from '../../auth/phoneNormalizer';
import { getSashaPhone } from '../../services/specialUsers';

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

// ── D3-T3 alert ──────────────────────────────────────────────────────────────

function formatWorkerAssignmentAlert(lead: AssignedLeadRow): string {
  const lines: string[] = [
    'ליד חדש שויך אליך:',
    '',
    `שם: ${renderSender(lead.fromName, lead.fromEmail)}`,
  ];
  if (lead.subject) lines.push(`נושא: ${lead.subject}`);
  const body = renderLeadBody(lead.body);
  if (body) lines.push(`הודעה: ${body}`);
  lines.push('', 'לטיפול ועדכון ב-CRM');
  return lines.join('\n');
}

async function processAssignmentAlerts(): Promise<void> {
  const rows = await findNewlyAssignedLeads();
  if (rows.length === 0) return;

  log.info({ count: rows.length }, 'Lead assignment notifier: newly assigned leads');

  for (const lead of rows) {
    let claimed: boolean;
    try {
      claimed = await claimLeadNotification(lead.id, 'ASSIGNED_TO_WORKER');
    } catch (err) {
      log.error({ err, leadId: lead.id }, 'claimLeadNotification failed for ASSIGNED_TO_WORKER');
      continue;
    }
    if (!claimed) continue;

    if (!lead.workerPhone) {
      log.warn({ leadId: lead.id, workerId: lead.workerId }, 'Assigned worker has no phone — skipping alert');
      continue;
    }

    try {
      const phone = normalizeIsraeliPhone(lead.workerPhone) ?? lead.workerPhone;
      await sendTextMessage({ to: phone, text: formatWorkerAssignmentAlert(lead) });
      log.info({ leadId: lead.id, workerId: lead.workerId }, 'Worker assignment alert sent');
    } catch (err) {
      log.error({ err, leadId: lead.id }, 'Worker assignment alert send failed');
    }
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
    `שם: ${renderSender(lead.fromName, lead.fromEmail)}`,
  ];
  if (lead.subject) lines.push(`נושא: ${lead.subject}`);
  const body = renderLeadBody(lead.body);
  if (body) lines.push(`הודעה: ${body}`);
  const sugLine = workerName
    ? `הצעת שיבוץ: ${workerName} — ${reason}`
    : 'הצעת שיבוץ: לא נמצאה התאמה';
  lines.push('', sugLine, 'לשיבוץ ב-CRM');
  return lines.join('\n');
}

async function processEscalations(): Promise<void> {
  // Sasha is identified by User.name (see specialUsers.ts) — her phone comes
  // from the DB, not env. When no active Sasha row exists, escalations are
  // silently skipped (defensive: the alert has no recipient).
  const sashaPhoneRaw = await getSashaPhone();
  if (!sashaPhoneRaw) {
    log.debug('No active Sasha user with phone in DB — escalation job skipped');
    return;
  }
  const sashaPhone = normalizeIsraeliPhone(sashaPhoneRaw) ?? sashaPhoneRaw;

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
    let claimed: boolean;
    try {
      claimed = await claimLeadNotification(lead.id, 'ESCALATED_1H');
    } catch (err) {
      log.error({ err, leadId: lead.id }, 'claimLeadNotification failed for ESCALATED_1H');
      continue;
    }
    if (!claimed) continue;

    const suggestion = await suggestWorkerForLead(
      { service: lead.subject, messageText: lead.body, customerName: lead.fromName },
      candidates,
    );
    const workerName = suggestion.userId
      ? (candidates.find((c) => c.id === suggestion.userId)?.name ?? null)
      : null;

    try {
      await sendTextMessage({
        to: sashaPhone,
        text: formatEscalationAlert(lead, workerName, suggestion.reason),
      });
      log.info({ leadId: lead.id }, 'Escalation alert sent to Sasha');
    } catch (err) {
      log.error({ err, leadId: lead.id }, 'Escalation alert send failed');
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runLeadAssignmentNotifier(): Promise<void> {
  await processAssignmentAlerts();
  await processEscalations();
}
