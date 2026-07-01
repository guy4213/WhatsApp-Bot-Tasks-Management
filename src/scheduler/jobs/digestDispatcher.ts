import { pool } from '../../db/connection';
import { notify } from '../../whatsapp/templates';
import { writeAuditLog } from '../../utils/auditLog';
import { moduleLogger } from '../../utils/logger';
import { claimDigestSend, markDigestFailed, type DigestType } from '../../services/digestSendLog';
import {
  getEmployeeMorningCounts, getEmployeeEndOfDay, getCompanyMorning, getCompanyEndOfDay,
} from '../../services/tasks';
import {
  formatEmployeeMorning, formatManagerMorning,
  formatEmployeeEndOfDay, formatManagerEndOfDay,
  formatInspectorMorning,
  formatGalitManagerMorning, formatGalitManagerEndOfDay,
  digestTemplateKey, type DigestContent,
} from '../../whatsapp/digestContent';
import { getInspectionsForWorkerOnDate } from '../../services/inspectionsQueries';
import {
  getFieldExceptionCounts, getOpenFieldExceptions,
} from '../../services/exceptionsQueries';
import { normalizeIsraeliPhone } from '../../auth/phoneNormalizer';

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

  // D4-T1 (K3) — cache Yoram's phone allow-list outside the loop so the per-
  // user Yoram check is a cheap string compare, not a re-parse per row.
  // Empty / unset → the entire Yoram branch is inert and legacy paths run.
  const yoramPhoneRaw = (process.env.YORAM_PHONE ?? '').trim();
  const yoramPhoneNormalized = yoramPhoneRaw
    ? normalizeIsraeliPhone(yoramPhoneRaw)
    : null;

  for (const row of rows) {
    const morningDue = row.morning_enabled && isDigestDue(row.morning_time, row.local_hm);
    const eveningDue = row.evening_enabled && isDigestDue(row.evening_time, row.local_hm);
    if (morningDue) await dispatchOne(row, 'MORNING', yoramPhoneNormalized);
    if (eveningDue) await dispatchOne(row, 'EVENING', yoramPhoneNormalized);
  }
}

async function dispatchOne(
  row: DueUserRow,
  type: DigestType,
  yoramPhoneNormalized: string | null,
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

  const isElevated = row.role === 'MANAGER' || row.role === 'ADMIN';

  try {
    const content = await buildContent(row, type, isElevated, yoramPhoneNormalized);
    const key = digestTemplateKey({ isElevated }, type);
    await notify({
      to: row.user_phone,
      key,
      bodyParams: content.params,
      fallbackText: content.text,
      buttons: content.buttons,
    });
    await auditDigest(row, type, 'SUCCESS');
    log.info({ userId: row.user_id, type, elevated: isElevated }, 'Digest sent');
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
  type: DigestType,
  isElevated: boolean,
  yoramPhoneNormalized: string | null,
): Promise<DigestContent> {
  // D4-T1 (K3) — Yoram exceptions digest (FIELD portion only; leads portion is
  // B2-blocked and rendered as a TODO placeholder in the formatter). Fires
  // BEFORE the D2-T4 inspector branch and BEFORE the legacy ADMIN branch so it
  // takes precedence when the phone matches. When `YORAM_PHONE` is unset (or
  // the number doesn't parse), `yoramPhoneNormalized` is null and this branch
  // is inert — legacy paths run unchanged. Dedup + audit + advisory-lock
  // wiring are unchanged (same digestType, same claim ledger).
  if (yoramPhoneNormalized) {
    const rowPhoneNormalized = normalizeIsraeliPhone(row.user_phone);
    if (rowPhoneNormalized && rowPhoneNormalized === yoramPhoneNormalized) {
      const [counts, exceptions] = await Promise.all([
        getFieldExceptionCounts(row.local_date),
        getOpenFieldExceptions(row.local_date),
      ]);
      const user = { name: row.user_name };
      return type === 'MORNING'
        ? formatGalitManagerMorning({ counts, exceptions, user })
        : formatGalitManagerEndOfDay({ counts, exceptions, user });
    }
  }

  if (type === 'MORNING') {
    // D2-T4 (K1): non-ADMIN users are inspectors and get the v2 numbered
    // inspections list. ADMIN keeps the legacy manager path. `formatEmployee
    // Morning` is preserved for any residual non-inspector path — X-T3 retires
    // it once every non-ADMIN is routed through this branch.
    if (row.role !== 'ADMIN') {
      const items = await getInspectionsForWorkerOnDate(row.user_id, row.local_date);
      return formatInspectorMorning(items, { name: row.user_name });
    }
    return formatManagerMorning(row.user_name, await getCompanyMorning());
  }
  if (isElevated) return formatManagerEndOfDay(row.user_name, await getCompanyEndOfDay());
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
