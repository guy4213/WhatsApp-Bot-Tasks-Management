/**
 * D3-T1 — Queries against the CRM-owned `IncomingLead` table.
 *
 * Mostly read-only. The bot writes to this table ONLY through `assignLead`,
 * which mirrors the CRM's own `createTaskForClaimedLead` transaction: it flips
 * ownerId + status=ACTIVE, creates the process Task (`title='ליד חדש נכנס'`,
 * `type='step1'`), and links the new taskId back to the lead — all in one
 * transaction. Any other write path is forbidden by spec.
 *
 * B2 columns: id, subject, body, fromName, fromEmail, receivedAt,
 *             status, ownerId (UUID FK → User), taskId, notifiedAt.
 * No phone column — lead messages display fromName / fromEmail / subject / body.
 */
import { pool } from '../db/connection';
import type { InspectorCandidate } from '../ai/leadSuggester';

export interface IncomingLeadRow {
  id: string;
  subject: string | null;
  body: string | null;
  fromName: string | null;
  fromEmail: string | null;
  receivedAt: Date;
  status: string | null;
  ownerId: string | null;
  taskId: string | null;
}

export interface AssignedLeadRow extends IncomingLeadRow {
  ownerId: string; // query guarantees non-null
  workerId: string;
  workerPhone: string | null;
  workerName: string | null;
}

const SELECT_LEAD_COLS = `
  id::text AS id, subject, body, "fromName", "fromEmail",
  "receivedAt", status, "ownerId"::text AS "ownerId", "taskId"::text AS "taskId"
`;

/**
 * SQL predicate — excludes CMS/system notifications that the CRM's mail
 * ingest sometimes captures as leads (real observed case 2026-07-17:
 * "[גלית ...] האתר עודכן לוורדפרס 6.9.5" from noreply@galit.co.il, shown
 * to Guy as a lead needing assignment). These are pattern-matched
 * DELIBERATELY narrowly: subject must contain the actual notification
 * wording ("עודכן לוורדפרס" / "WordPress" version-update) AND the sender
 * must be a noreply address. Real form leads from noreply@galit.co.il
 * (Elementor) do NOT match this — they have subjects like "הודעה חדשה מאת
 * גלית". If a customer legitimately writes "עודכן לוורדפרס" (unlikely),
 * their email won't be from noreply@ so the guard doesn't fire.
 *
 * Applied to every list the manager or Sasha sees; the row still lives in
 * IncomingLead for the CRM, we just don't surface it to humans.
 */
const NOT_SYSTEM_NOISE_SQL = `
  NOT (
    "fromEmail" ILIKE 'noreply@%'
    AND (
      subject ILIKE '%עודכן לוורדפרס%'
      OR subject ILIKE '%עודכן ל-וורדפרס%'
      OR subject ILIKE '%WordPress%עודכן%'
      OR subject ILIKE '%WordPress % update%'
    )
  )
`;

/**
 * Unassigned leads received in [from, to) — for D3-T2 Sasha morning digest.
 * Prefer `findOvernightUnassignedLeads` when the window is derived from a local date.
 */
export async function findUnassignedInWindow(from: Date, to: Date): Promise<IncomingLeadRow[]> {
  const { rows } = await pool.query<IncomingLeadRow>(
    `SELECT ${SELECT_LEAD_COLS}
     FROM "IncomingLead"
     WHERE status = 'NEW'
       AND "receivedAt" >= $1
       AND "receivedAt" < $2
       AND ${NOT_SYSTEM_NOISE_SQL}
     ORDER BY "receivedAt"`,
    [from, to],
  );
  return rows;
}

/**
 * Overnight unassigned leads for a given local date (Asia/Jerusalem).
 * Window: previous day 17:00 → today 09:30 (Jerusalem time, DST-aware).
 * Used by D3-T2 Sasha morning digest.
 */
export async function findOvernightUnassignedLeads(localDate: string): Promise<IncomingLeadRow[]> {
  const { rows } = await pool.query<IncomingLeadRow>(
    `SELECT ${SELECT_LEAD_COLS}
     FROM "IncomingLead"
     WHERE status = 'NEW'
       AND "receivedAt" >= (($1::date - 1)::timestamp + time '17:00:00') AT TIME ZONE 'Asia/Jerusalem'
       AND "receivedAt" <  ($1::date::timestamp + time '09:30:00') AT TIME ZONE 'Asia/Jerusalem'
       AND ${NOT_SYSTEM_NOISE_SQL}
     ORDER BY "receivedAt"`,
    [localDate],
  );
  return rows;
}

/**
 * Leads newly assigned to a user — the D3-T3 assignment alert scans this list.
 *
 * Predicates:
 *   - status = 'ACTIVE'          → the CRM's "claimed" state; the ONLY moment
 *     that signals ownership has transitioned from Sasha's inbox to a claim.
 *     Filtering on `ownerId IS NOT NULL` alone was insufficient in prod: rows
 *     arrive with an interim ownerId already populated, so the alert would
 *     fire before the claim was actually made.
 *   - ownerId IS NOT NULL        → belt-and-suspenders; a row that is somehow
 *     ACTIVE without an owner has no assignee to notify.
 *   - dedup filter               → skip leads with either a SENT dedup row
 *     (already handled) or a PENDING dedup row younger than 5 minutes (a
 *     concurrent send is in flight from the webhook path). Stale PENDING
 *     rows (>5 min old) fall through so a crashed send can be retried on
 *     the next poller tick.
 *
 * Role filter — INTENTIONALLY NONE. An earlier version filtered
 * `u.role != 'ADMIN'` on the assumption that admins claim leads only in a
 * supervisory capacity. Product reality is different: managers/admins also
 * do field work and are legitimate lead assignees; skipping their alert
 * silently was a bug (Guy Franses feedback 2026-07-19). Every user with a
 * phone that gets a lead assigned to them now receives the alert.
 * Used by D3-T3 assignment alert (poller path).
 */
export async function findNewlyAssignedLeads(limit = 50): Promise<AssignedLeadRow[]> {
  const { rows } = await pool.query<AssignedLeadRow>(
    `SELECT
       il.id::text AS id, il.subject, il.body, il."fromName", il."fromEmail",
       il."receivedAt", il.status,
       il."ownerId"::text AS "ownerId", il."taskId"::text AS "taskId",
       u.id::text AS "workerId", u.phone AS "workerPhone", u.name AS "workerName"
     FROM "IncomingLead" il
     JOIN "User" u ON u.id = il."ownerId"
     WHERE il.status = 'ACTIVE'
       AND il."ownerId" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "WhatsappLeadNotification" wln
         WHERE wln."leadId" = il.id::text
           AND wln."eventKind" = 'ASSIGNED_TO_WORKER'
           AND (
             wln."status" = 'SENT'
             OR wln."notifiedAt" > now() - interval '5 minutes'
           )
       )
     ORDER BY il."receivedAt"
     LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Single-row variant of `findNewlyAssignedLeads` — used by the Supabase
 * trigger / webhook path to fetch full assignee + lead details for one lead
 * id. Returns `null` when the row is not eligible (missing / not ACTIVE /
 * no ownerId). Role filter deliberately absent — see the comment on
 * `findNewlyAssignedLeads`. The trigger path does NOT apply the dedup
 * pre-filter itself — atomic claim via `tryClaimLeadNotification` is the
 * source of truth for "should we send".
 */
export async function findAssignedLeadById(leadId: string): Promise<AssignedLeadRow | null> {
  const { rows } = await pool.query<AssignedLeadRow>(
    `SELECT
       il.id::text AS id, il.subject, il.body, il."fromName", il."fromEmail",
       il."receivedAt", il.status,
       il."ownerId"::text AS "ownerId", il."taskId"::text AS "taskId",
       u.id::text AS "workerId", u.phone AS "workerPhone", u.name AS "workerName"
     FROM "IncomingLead" il
     JOIN "User" u ON u.id = il."ownerId"
     WHERE il.id = $1
       AND il.status = 'ACTIVE'
       AND il."ownerId" IS NOT NULL
     LIMIT 1`,
    [leadId],
  );
  return rows[0] ?? null;
}

/**
 * Unassigned leads > 1 hour old, received during 09:30-22:00 (Jerusalem local
 * time), with no ESCALATED_1H dedup row. Used by D3-T4 Sasha escalation.
 * Overnight leads (22:00-09:30) are excluded — they are covered by D3-T2.
 */
export async function findEscalationCandidates(limit = 50): Promise<IncomingLeadRow[]> {
  const { rows } = await pool.query<IncomingLeadRow>(
    `SELECT ${SELECT_LEAD_COLS}
     FROM "IncomingLead"
     WHERE "ownerId" IS NULL
       AND "receivedAt" <= now() - interval '1 hour'
       AND ("receivedAt" AT TIME ZONE 'Asia/Jerusalem')::time >= '09:30:00'::time
       AND ("receivedAt" AT TIME ZONE 'Asia/Jerusalem')::time < '22:00:00'::time
       AND ${NOT_SYSTEM_NOISE_SQL}
       AND NOT EXISTS (
         SELECT 1 FROM "WhatsappLeadNotification" wln
         WHERE wln."leadId" = id::text
           AND wln."eventKind" = 'ESCALATED_1H'
       )
     ORDER BY "receivedAt"
     LIMIT $1`,
    [limit],
  );
  return rows;
}

// ── D4-T1 (LEADS portion) — Yoram lead-count summary ────────────────────────

export interface YoramLeadCounts {
  /**
   * Actionable overnight leads: `receivedAt` in the overnight window AND
   * `ownerId IS NULL`. Matches Sasha's `findOvernightUnassignedLeads` list —
   * one source of truth, one number.
   */
  overnight: number;
  /**
   * DEPRECATED — total open queue right now (all `ownerId IS NULL` regardless
   * of window). Kept as a field for backward-compat with existing template
   * `params` arrays; the Galit/Yoram digest no longer renders it (see
   * `formatLeadsBlock`). New callers should prefer `overnight`.
   */
  unassigned: number;
}

/**
 * Count summary for the Yoram/Galit digest leads line (spec §13).
 *
 * Product decision 2026-07-02: the "לידים מהלילה" line must reflect only
 * ACTIONABLE overnight leads (received overnight AND still unassigned). A raw
 * arrival count is misleading in a CEO-facing digest — reading "לידים מהלילה: 2"
 * when both are already assigned would imply work that does not exist. Sasha's
 * pending queue and the CEO digest now use the same predicate:
 *
 *   `receivedAt` in [prev-day 17:00 IL, today 09:30 IL) AND `ownerId IS NULL`
 *
 * `overnight` — the shared "pending overnight" count. Same predicate as
 *   `findOvernightUnassignedLeads`.
 * `unassigned` — LEGACY total-open-queue snapshot (see interface doc); kept
 *   for template `params` slot stability. Do not render as a NEW field.
 *
 * Bot NEVER writes to IncomingLead — read-only queries.
 */
export async function getYoramLeadCounts(localDate: string): Promise<YoramLeadCounts> {
  const { rows } = await pool.query<{ overnight: string; unassigned: string }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE "ownerId" IS NULL
           AND "receivedAt" >= (($1::date - 1)::timestamp + time '17:00:00') AT TIME ZONE 'Asia/Jerusalem'
           AND "receivedAt" <  ($1::date::timestamp + time '09:30:00') AT TIME ZONE 'Asia/Jerusalem'
       ) AS overnight,
       COUNT(*) FILTER (WHERE "ownerId" IS NULL) AS unassigned
     FROM "IncomingLead"`,
    [localDate],
  );
  const row = rows[0] ?? { overnight: '0', unassigned: '0' };
  return {
    overnight: parseInt(row.overnight, 10),
    unassigned: parseInt(row.unassigned, 10),
  };
}

/**
 * Assignable-user candidates for the AI suggestion (D3-T4, D3-T2) AND for
 * the manual assign-lead pick-worker list (D3-T6). Any active user with a
 * phone is a valid assignee.
 *
 * Role filter — INTENTIONALLY NONE (Guy Franses feedback 2026-07-19b). A
 * prior version filtered `role != 'ADMIN'` and hid managers/admins from
 * both the AI suggestion input AND the pick-worker list, which contradicts
 * product reality: managers and admins do field work and can legitimately
 * receive leads. The alert-side filter was already removed earlier; this
 * completes the fix on the selection side.
 *
 * Name kept as `findActiveInspectors` for now to avoid churn in every
 * caller; a follow-up rename to `findAssignableUsers` would be more
 * accurate but is a mechanical refactor for another pass.
 */
export async function findActiveInspectors(): Promise<InspectorCandidate[]> {
  const { rows } = await pool.query<InspectorCandidate>(
    `SELECT id::text AS id, name, role
     FROM "User"
     WHERE upper(status::text) = 'ACTIVE'
       AND phone IS NOT NULL`,
  );
  return rows;
}

// D3-T6: Sasha lead-assignment via WhatsApp ─────────────────────────────────

/**
 * All currently unassigned leads (ownerId IS NULL), newest first.
 * Used by D3-T6 assign-lead flow to display the pick list.
 * Defaults to 20 items — enough for a WhatsApp conversation.
 *
 * When `dateRange` is provided, further scopes to leads whose `receivedAt`
 * falls in [dateRange.from, dateRange.to) — half-open, YYYY-MM-DD local dates
 * converted via `AT TIME ZONE 'Asia/Jerusalem'`.
 * Per §6.2, leads use `receivedAt` (not scheduledStartAt) for date filtering.
 */
export async function findUnassignedLeadsForAssignment(
  limit = 20,
  dateRange?: { from: string; to: string },
): Promise<IncomingLeadRow[]> {
  if (dateRange) {
    const { rows } = await pool.query<IncomingLeadRow>(
      `SELECT ${SELECT_LEAD_COLS}
       FROM "IncomingLead"
       WHERE status = 'NEW'
         AND "receivedAt" >= ($2::date) AT TIME ZONE 'Asia/Jerusalem'
         AND "receivedAt" <  ($3::date) AT TIME ZONE 'Asia/Jerusalem'
         AND ${NOT_SYSTEM_NOISE_SQL}
       ORDER BY "receivedAt" DESC
       LIMIT $1`,
      [limit, dateRange.from, dateRange.to],
    );
    return rows;
  }
  const { rows } = await pool.query<IncomingLeadRow>(
    `SELECT ${SELECT_LEAD_COLS}
     FROM "IncomingLead"
     WHERE status = 'NEW'
       AND ${NOT_SYSTEM_NOISE_SQL}
     ORDER BY "receivedAt" DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Assign an IncomingLead to a worker — mirrors the CRM's `createTaskForClaimedLead`
 * transaction. Three writes in one transaction:
 *   1. `IncomingLead.ownerId=workerId`, `status='ACTIVE'` (race-guarded on `status='NEW'`).
 *   2. `INSERT INTO Task` with the canonical process-task fields
 *      (`title='ליד חדש נכנס'`, `type='step1'`, `status='OPEN'`, `priority='HIGH'`,
 *      `currentStage=0`, `incomingLeadId`, `ownerId`, `description=lead.body`).
 *   3. `IncomingLead.taskId = <new task id>`.
 *
 * The CRM creates the process Task only inside its own claim transaction, so a
 * bot-side assignment that skipped step 2 stranded the lead: ACTIVE with an
 * owner but no Task, and out of the pending queue so nobody could recover it
 * from the CRM. Doing all three writes together keeps CRM and bot claims
 * indistinguishable downstream.
 *
 * Race guard: the ownership UPDATE stays conditioned on `status='NEW'` — if a
 * second manager assigns the same lead microseconds later, that UPDATE affects
 * 0 rows, we `ROLLBACK`, and throw `'הליד כבר שויך'`. Everything runs on a
 * dedicated pooled client so a mid-transaction failure rolls back cleanly.
 *
 * Audit: written only after `COMMIT` so a rolled-back assignment is never
 * recorded as success. `newValues` includes the new taskId for traceability.
 */
export async function assignLead(
  leadId: string,
  workerId: string,
  actorId: string,
  actorPhone: string,
): Promise<void> {
  const client = await pool.connect();
  let prevOwnerId: string | null = null;
  let newTaskId: string;
  try {
    await client.query('BEGIN');

    // Snapshot the pre-UPDATE ownerId for audit oldValues. Status pre-UPDATE
    // is guaranteed to be 'NEW' by the guarded UPDATE below (otherwise we
    // throw), so we don't need to read it here.
    const beforeRes = await client.query<{ ownerId: string | null }>(
      `SELECT "ownerId"::text AS "ownerId" FROM "IncomingLead" WHERE id = $1`,
      [leadId],
    );
    prevOwnerId = beforeRes.rows[0]?.ownerId ?? null;

    // Race-guarded claim. RETURNING body lets us use it as the Task
    // description without a second round-trip on the same row.
    const claimRes = await client.query<{ body: string | null; prevOwnerId: string }>(
      `UPDATE "IncomingLead"
         SET "ownerId" = $1, status = 'ACTIVE'
       WHERE id = $2 AND status = 'NEW'
       RETURNING body, "ownerId"::text AS "prevOwnerId"`,
      [workerId, leadId],
    );
    if (claimRes.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new Error('הליד כבר שויך');
    }
    const leadBody = claimRes.rows[0]?.body ?? null;

    // Task table has no DB defaults for id / updatedAt — set them explicitly.
    const taskRes = await client.query<{ id: string }>(
      `INSERT INTO "Task"
         (id, title, description, type, status, priority, "ownerId", "currentStage", "incomingLeadId", "updatedAt")
       VALUES
         (gen_random_uuid(), 'ליד חדש נכנס', $1, 'step1', 'OPEN', 'HIGH', $2, 0, $3, now())
       RETURNING id::text AS id`,
      [leadBody, workerId, leadId],
    );
    newTaskId = taskRes.rows[0]!.id;

    await client.query(
      `UPDATE "IncomingLead" SET "taskId" = $1 WHERE id = $2`,
      [newTaskId, leadId],
    );

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }

  // Import inline to avoid circular dependency with utils/auditLog.
  const { writeAuditLog } = await import('../utils/auditLog');
  await writeAuditLog({
    userId: actorId,
    whatsappNumber: actorPhone,
    originalMessage: null,
    transcribedMessage: null,
    detectedIntent: 'assign_lead',
    detectedAction: 'ASSIGN_LEAD',
    confidence: null,
    targetTaskId: leadId,
    oldValues: { ownerId: prevOwnerId, status: 'NEW' },
    newValues: { leadId, ownerId: workerId, status: 'ACTIVE', taskId: newTaskId },
    confirmationStatus: 'CONFIRMED',
    approvalStatus: null,
    approverUserId: null,
    managerNotified: false,
    executionStatus: 'SUCCESS',
    errorMessage: null,
    pendingActionId: null,
  });
}

/**
 * Fetch a single IncomingLead row by its UUID.
 * Returns null when no matching row is found.
 * Used by the manager lead-detail view (D3-T6 display enhancement).
 */
export async function getLeadById(leadId: string): Promise<IncomingLeadRow | null> {
  const { rows } = await pool.query<IncomingLeadRow>(
    `SELECT ${SELECT_LEAD_COLS}
     FROM "IncomingLead"
     WHERE id = $1`,
    [leadId],
  );
  return rows[0] ?? null;
}
