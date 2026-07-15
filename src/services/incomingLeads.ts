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
     ORDER BY "receivedAt"`,
    [localDate],
  );
  return rows;
}

/**
 * Leads newly assigned to an inspector (ownerId IS NOT NULL, role != 'ADMIN')
 * with no ASSIGNED_TO_WORKER dedup row yet.
 * Used by D3-T3 worker-assignment alert.
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
     WHERE il."ownerId" IS NOT NULL
       AND u.role != 'ADMIN'
       AND NOT EXISTS (
         SELECT 1 FROM "WhatsappLeadNotification" wln
         WHERE wln."leadId" = il.id::text
           AND wln."eventKind" = 'ASSIGNED_TO_WORKER'
       )
     ORDER BY il."receivedAt"
     LIMIT $1`,
    [limit],
  );
  return rows;
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

/** Active inspector candidates for the AI suggestion (D3-T4, D3-T2). */
export async function findActiveInspectors(): Promise<InspectorCandidate[]> {
  const { rows } = await pool.query<InspectorCandidate>(
    `SELECT id::text AS id, name, role
     FROM "User"
     WHERE upper(status::text) = 'ACTIVE'
       AND role != 'ADMIN'
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
