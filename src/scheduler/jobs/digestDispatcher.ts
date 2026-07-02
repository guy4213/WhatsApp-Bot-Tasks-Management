import { pool } from '../../db/connection';
import { notify } from '../../whatsapp/templates';
import { sendButtonMessage, sendTextMessage } from '../../whatsapp/sender';
import { writeAuditLog } from '../../utils/auditLog';
import { moduleLogger } from '../../utils/logger';
import { claimDigestSend, markDigestFailed, type DigestType } from '../../services/digestSendLog';
import { getEmployeeEndOfDay } from '../../services/tasks';
import {
  formatEmployeeEndOfDay,
  formatInspectorMorning,
  formatEquipmentReminder,
  formatGalitManagerMorning, formatGalitManagerEndOfDay,
  formatSashaLeadsMorning,
  digestTemplateKey, type DigestContent,
  type LeadDigestRow, type LeadDigestSuggestion,
} from '../../whatsapp/digestContent';
import {
  getInspectionsForWorkerOnDate,
  getEquipmentChecklistForFamilies,
  type InspectionListItem,
} from '../../services/inspectionsQueries';
import {
  getFieldExceptionCounts, getOpenFieldExceptions,
} from '../../services/exceptionsQueries';
import {
  findOvernightUnassignedLeads,
  findActiveInspectors,
  getYoramLeadCounts,
} from '../../services/incomingLeads';
import { suggestWorkerForLead } from '../../ai/leadSuggester';
import {
  isSasha, isExceptionsViewer, isLeadsViewer,
} from '../../services/specialUsers';

const log = moduleLogger('digestDispatcher');

// How wide the "due now" window is (must match the cron cadence — every 5 min).
const WINDOW_MINUTES = 5;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Minutes-since-midnight for an 'HH:MM' string. Returns NaN on malformed input. */
export function minutesOfDay(hm: string): number {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(hm.trim());
  if (!m) return NaN;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return NaN;
  return h * 60 + min;
}

/**
 * Is the digest due right now? True only inside the [configured, configured+5min)
 * window — i.e. 0 <= (localMinutes - configuredMinutes) < 5 — so the every-5-min
 * cron fires each digest exactly once per day. Returns false on malformed times.
 */
export function isDigestDue(configuredTime: string, localTime: string): boolean {
  const cfg = minutesOfDay(configuredTime);
  const now = minutesOfDay(localTime);
  if (Number.isNaN(cfg) || Number.isNaN(now)) return false;
  const delta = now - cfg;
  return delta >= 0 && delta < WINDOW_MINUTES;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export interface DueUserRow {
  user_id: string;
  user_name: string;
  user_phone: string;
  role: string;
  morning_enabled: boolean;
  morning_time: string;
  evening_enabled: boolean;
  evening_time: string;
  local_hm: string;
  local_date: string;
}

/**
 * Load every active user with a phone, joined to their digest preference (or the
 * COALESCE'd defaults when no row exists), plus their current local time/date. A
 * missing "UserDigestPreference" row therefore reads as ON-with-defaults (morning
 * 08:00 / evening 17:00 / Asia/Jerusalem), so everyone is covered without seeding.
 * Exported so the selection logic can be tested against a real DB without sending.
 */
export async function selectDigestCandidates(): Promise<DueUserRow[]> {
  const { rows } = await pool.query<DueUserRow>(
    `SELECT
       u.id    AS user_id,
       u.name  AS user_name,
       u.phone AS user_phone,
       u.role  AS role,
       COALESCE(p."morningEnabled", true)             AS morning_enabled,
       COALESCE(p."morningTime",   '08:00')           AS morning_time,
       COALESCE(p."eveningEnabled", true)             AS evening_enabled,
       COALESCE(p."eveningTime",   '17:00')           AS evening_time,
       to_char(now() AT TIME ZONE COALESCE(p."timezone", 'Asia/Jerusalem'), 'HH24:MI')        AS local_hm,
       to_char((now() AT TIME ZONE COALESCE(p."timezone", 'Asia/Jerusalem'))::date, 'YYYY-MM-DD') AS local_date
     FROM "User" u
     LEFT JOIN "UserDigestPreference" p ON p."userId" = u.id
     WHERE upper(u.status::text) = 'ACTIVE'
       AND u.phone IS NOT NULL
       AND u.phone <> ''`,
  );
  return rows;
}

/**
 * Send any morning/evening digests due in the current 5-minute window.
 *
 * Per-user dedup is enforced by claimDigestSend (INSERT-first on the
 * (userId, type, localDate) PK), making this safe to run on multiple instances
 * concurrently. Delivery uses notify() — an approved template out-of-window (once
 * enabled), rich free-form in-window.
 */
export async function runDigestDispatcher(): Promise<void> {
  const rows = await selectDigestCandidates();

  for (const row of rows) {
    // Leads viewers (Sasha + dev observers) receive LEADS_MORNING at 09:30.
    // Per-user dedup — each viewer has an independent claim row so they all
    // fire independently.
    //
    // Exception: users who are ALSO ExceptionsViewers (dev admins — גיא פרנסס,
    // יאיר) already receive the Galit digest which contains the leads-counts
    // line. Sending them the Sasha leads morning as well would create a
    // contradictory duplicate. Only pure LeadsViewers (Sasha, who is NOT an
    // ExceptionsViewer) get the standalone leads morning.
    if (
      isLeadsViewer(row.user_name)
      && !isExceptionsViewer(row.user_name)
      && isDigestDue('09:30', row.local_hm)
    ) {
      await dispatchSashaLeadsMorning(row);
    }

    // Sasha receives ONLY the leads digest — no MORNING/EVENING for her.
    if (isSasha(row.user_name)) {
      continue;
    }

    const morningDue = row.morning_enabled && isDigestDue(row.morning_time, row.local_hm);
    const eveningDue = row.evening_enabled && isDigestDue(row.evening_time, row.local_hm);
    if (morningDue) {
      await dispatchOne(row, 'MORNING');
      // Equipment reminder piggy-backs on the morning slot for FIELD workers
      // only. Exceptions viewers (Yoram + dev admins) receive the §13 digest
      // instead — an equipment checklist doesn't make sense for them.
      if (!isExceptionsViewer(row.user_name)) {
        await maybeDispatchEquipmentReminder(row);
      }
    }
    if (eveningDue) await dispatchOne(row, 'EVENING');
  }
}

// ── D3-T2: Sasha 09:30 leads morning digest ──────────────────────────────────
//
// Fetches overnight unassigned leads, gets one AI suggestion per lead, formats
// via formatSashaLeadsMorning, and sends. Dedup via LEADS_MORNING in the
// WhatsappDigestSendLog (same INSERT-first pattern as the inspector morning).
// Uses sendTextMessage directly — no approved template yet (D5-T5 scope).

async function dispatchSashaLeadsMorning(row: DueUserRow): Promise<void> {
  let claimed = false;
  try {
    claimed = await claimDigestSend(row.user_id, 'LEADS_MORNING', row.local_date);
  } catch (err) {
    log.error({ err, userId: row.user_id }, 'claimDigestSend LEADS_MORNING failed');
    return;
  }
  if (!claimed) return;

  try {
    const leads = await findOvernightUnassignedLeads(row.local_date);

    const suggestions: LeadDigestSuggestion[] = [];
    if (leads.length > 0) {
      const candidates = await findActiveInspectors();
      const rawSuggestions = await Promise.all(
        leads.map((lead) =>
          suggestWorkerForLead(
            { service: lead.subject, messageText: lead.body, customerName: lead.fromName },
            candidates,
          ).then((s) => ({
            leadId: lead.id,
            workerName: s.userId
              ? (candidates.find((c) => c.id === s.userId)?.name ?? null)
              : null,
            reason: s.reason,
          })),
        ),
      );
      suggestions.push(...rawSuggestions);
    }

    const content = formatSashaLeadsMorning(
      leads as LeadDigestRow[],
      suggestions,
      { name: row.user_name },
    );

    await sendTextMessage({ to: row.user_phone, text: content.text });
    await auditDigest(row, 'LEADS_MORNING', 'SUCCESS');
    log.info({ userId: row.user_id, leadCount: leads.length }, 'Sasha leads morning digest sent');
  } catch (err) {
    log.error({ err, userId: row.user_id }, 'Sasha leads morning digest send failed');
    try {
      await markDigestFailed(row.user_id, 'LEADS_MORNING', row.local_date);
    } catch (markErr) {
      log.error({ err: markErr, userId: row.user_id }, 'markDigestFailed LEADS_MORNING failed');
    }
    await auditDigest(row, 'LEADS_MORNING', 'FAILED', (err as Error).message ?? 'unknown');
  }
}

// `dispatchOne` handles the two "primary" digest slots — MORNING and EVENING.
// EQUIPMENT_MORNING and LEADS_MORNING are handled by dedicated helpers with
// their own dedup rows, so the digestType here is narrowed to the two-value
// union that `digestTemplateKey` accepts.
type PrimaryDigestType = Exclude<DigestType, 'EQUIPMENT_MORNING' | 'LEADS_MORNING'>;

async function dispatchOne(
  row: DueUserRow,
  type: PrimaryDigestType,
): Promise<void> {
  // INSERT-first dedup: only the instance that wins the claim sends.
  let claimed = false;
  try {
    claimed = await claimDigestSend(row.user_id, type, row.local_date);
  } catch (err) {
    log.error({ err, userId: row.user_id, type }, 'claimDigestSend failed');
    return;
  }
  if (!claimed) return; // already sent today (this user/type/day)

  try {
    const content = await buildContent(row, type);
    // Exceptions viewers (Yoram + dev admins) use the "elevated" template
    // (manager digest slot); everyone else uses the employee digest template.
    // The template content itself is currently rendered from `fallbackText`
    // (free-form) until D5-T5 templates land.
    const isElevated = isExceptionsViewer(row.user_name);
    const key = digestTemplateKey({ isElevated }, type);
    await notify({
      to: row.user_phone,
      key,
      bodyParams: content.params,
      fallbackText: content.text,
      buttons: content.buttons,
    });
    await auditDigest(row, type, 'SUCCESS');
    log.info({ userId: row.user_id, type, name: row.user_name }, 'Digest sent');
  } catch (err) {
    log.error({ err, userId: row.user_id, type }, 'Digest send failed');
    try {
      await markDigestFailed(row.user_id, type, row.local_date);
    } catch (markErr) {
      log.error({ err: markErr, userId: row.user_id, type }, 'markDigestFailed failed');
    }
    await auditDigest(row, type, 'FAILED', (err as Error).message ?? 'unknown send error');
  }
}

async function buildContent(
  row: DueUserRow,
  type: PrimaryDigestType,
): Promise<DigestContent> {
  // Exceptions viewers (Yoram + dev admins) — SPEC §13 exceptions digest
  // (field counts + open exceptions + leads counts). Fires for both MORNING
  // and EVENING.
  if (isExceptionsViewer(row.user_name)) {
    const [counts, exceptions, leadCounts] = await Promise.all([
      getFieldExceptionCounts(row.local_date),
      getOpenFieldExceptions(row.local_date),
      getYoramLeadCounts(row.local_date),
    ]);
    const user = { name: row.user_name };
    return type === 'MORNING'
      ? formatGalitManagerMorning({ counts, exceptions, user, leadCounts })
      : formatGalitManagerEndOfDay({ counts, exceptions, user, leadCounts });
  }

  // Everyone else — treated as a field worker regardless of role. MORNING →
  // inspector list §7, EVENING → employee end-of-day summary.
  if (type === 'MORNING') {
    const items = await getInspectionsForWorkerOnDate(row.user_id, row.local_date);
    return formatInspectorMorning(items, { name: row.user_name });
  }
  return formatEmployeeEndOfDay(row.user_name, await getEmployeeEndOfDay(row.user_id));
}

async function auditDigest(
  row: DueUserRow,
  type: DigestType,
  status: 'SUCCESS' | 'FAILED',
  error?: string,
): Promise<void> {
  await writeAuditLog({
    userId: row.user_id,
    whatsappNumber: row.user_phone,
    originalMessage: null,
    transcribedMessage: null,
    detectedIntent: `digest_${type.toLowerCase()}`,
    detectedAction: null,
    confidence: null,
    targetTaskId: null,
    oldValues: null,
    newValues: null,
    confirmationStatus: null,
    approvalStatus: null,
    approverUserId: null,
    managerNotified: false,
    executionStatus: status,
    errorMessage: error ?? null,
    pendingActionId: null,
  });
}

// ── D2-T9: equipment reminder morning roll-up ────────────────────────────────
//
// Fires as a SECOND send after `dispatchOne('MORNING', ...)` for inspector
// rows only. Dedup is via `EQUIPMENT_MORNING` in `WhatsappDigestSendLog` so
// this is safe under overlapping cron runs. Send failures are logged and
// audit-stamped just like the inspector morning path, but they DO NOT throw —
// a bad equipment send must not block the inspector morning digest which was
// already delivered successfully.

async function maybeDispatchEquipmentReminder(row: DueUserRow): Promise<void> {
  // INSERT-first dedup on a separate digestType — an inspector morning that
  // already went out today doesn't gate the equipment reminder, and vice-versa.
  let claimed = false;
  try {
    claimed = await claimDigestSend(row.user_id, 'EQUIPMENT_MORNING', row.local_date);
  } catch (err) {
    log.error(
      { err, userId: row.user_id, type: 'EQUIPMENT_MORNING' },
      'claimDigestSend failed (equipment reminder skipped)',
    );
    return;
  }
  if (!claimed) return;

  // Skip if no inspections today (empty families → no checklist → no message).
  let inspections: InspectionListItem[];
  try {
    inspections = await getInspectionsForWorkerOnDate(row.user_id, row.local_date);
  } catch (err) {
    log.error(
      { err, userId: row.user_id },
      'getInspectionsForWorkerOnDate failed (equipment reminder skipped)',
    );
    await markDigestFailed(row.user_id, 'EQUIPMENT_MORNING', row.local_date).catch(() => undefined);
    return;
  }
  if (inspections.length === 0) {
    // The morning digest itself already told the worker there's nothing today.
    // The claim row stays so we don't re-check throughout the day.
    log.info({ userId: row.user_id }, 'Equipment reminder skipped — no inspections today');
    return;
  }

  const families = Array.from(new Set(inspections.map((i) => i.family)));
  let items: Awaited<ReturnType<typeof getEquipmentChecklistForFamilies>>;
  try {
    items = await getEquipmentChecklistForFamilies(families);
  } catch (err) {
    log.error({ err, userId: row.user_id, families }, 'getEquipmentChecklistForFamilies failed');
    await markDigestFailed(row.user_id, 'EQUIPMENT_MORNING', row.local_date).catch(() => undefined);
    return;
  }
  if (items.length === 0) {
    // No checklist seeded for the family(ies) the worker is inspecting. Skip
    // silently — safer than sending a confusing empty message.
    log.info(
      { userId: row.user_id, families },
      'Equipment reminder skipped — no checklist rows for these families',
    );
    return;
  }

  const content = formatEquipmentReminder(items, {
    id: row.user_id,
    name: row.user_name,
    localDate: row.local_date,
  });
  if (content.text.length === 0 || content.buttons.length === 0) {
    log.info({ userId: row.user_id }, 'Equipment reminder skipped — empty formatter output');
    return;
  }

  try {
    // D5-T4 button-policy: `sendButtonMessage` is explicitly allowed here (see
    // JSDoc on `sendButtonMessage` in `src/whatsapp/sender.ts` and on
    // `formatEquipmentReminder` in `src/whatsapp/digestContent.ts`).
    await sendButtonMessage({
      to: row.user_phone,
      body: content.text,
      buttons: content.buttons,
    });
    await auditDigest(row, 'EQUIPMENT_MORNING', 'SUCCESS');
    log.info({ userId: row.user_id }, 'Equipment reminder sent');
  } catch (err) {
    log.error({ err, userId: row.user_id }, 'Equipment reminder send failed');
    try {
      await markDigestFailed(row.user_id, 'EQUIPMENT_MORNING', row.local_date);
    } catch (markErr) {
      log.error({ err: markErr, userId: row.user_id }, 'markDigestFailed failed');
    }
    await auditDigest(
      row,
      'EQUIPMENT_MORNING',
      'FAILED',
      (err as Error).message ?? 'unknown send error',
    );
  }
}
