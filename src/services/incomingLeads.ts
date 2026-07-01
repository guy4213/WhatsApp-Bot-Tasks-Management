/**
 * D3-T1 — Read-only queries against the CRM-owned `IncomingLead` table.
 * The bot NEVER writes to this table — assignment and handling are done in the CRM.
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
     WHERE "ownerId" IS NULL
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
     WHERE "ownerId" IS NULL
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
  /** All leads received in the overnight window (prev day 17:00 → today 09:30 Jerusalem). */
  overnight: number;
  /** All leads where ownerId IS NULL right now (total open unassigned queue). */
  unassigned: number;
}

/**
 * Count summary for the Yoram digest leads line (spec §13: "לידים: X מהלילה · Y לא שויכו").
 *
 * `overnight` — ALL leads received in the overnight window (previous day 17:00 →
 *   today 09:30, Asia/Jerusalem DST-aware), regardless of assignment status.
 *   Same time-zone SQL pattern as `findOvernightUnassignedLeads` but WITHOUT
 *   the `ownerId IS NULL` filter.
 *
 * `unassigned` — total IncomingLead rows where ownerId IS NULL right now
 *   (snapshot at query time, not window-scoped).
 *
 * Bot NEVER writes to IncomingLead — read-only queries.
 */
export async function getYoramLeadCounts(localDate: string): Promise<YoramLeadCounts> {
  const { rows } = await pool.query<{ overnight: string; unassigned: string }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE "receivedAt" >= (($1::date - 1)::timestamp + time '17:00:00') AT TIME ZONE 'Asia/Jerusalem'
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
 */
export async function findUnassignedLeadsForAssignment(limit = 20): Promise<IncomingLeadRow[]> {
  const { rows } = await pool.query<IncomingLeadRow>(
    `SELECT ${SELECT_LEAD_COLS}
     FROM "IncomingLead"
     WHERE "ownerId" IS NULL
     ORDER BY "receivedAt" DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Write ownerId onto an IncomingLead row — the FIRST bot write to a CRM-owned
 * table (SPEC Addendum point 1). Parameterized to prevent injection. Also
 * writes an audit-log entry with actor + lead + target-worker captured.
 *
 * NOTE: the existing D3-T3 poller (leadAssignmentNotifier) will detect the new
 * ownerId and send the worker alert automatically — no alert logic here.
 *
 * @param leadId   UUID of the IncomingLead row to assign.
 * @param workerId UUID of the User to set as ownerId.
 * @param actorId  UUID of the User performing the action (for audit).
 * @param actorPhone  WhatsApp phone of the actor (for audit).
 */
export async function assignLead(
  leadId: string,
  workerId: string,
  actorId: string,
  actorPhone: string,
): Promise<void> {
  await pool.query(
    `UPDATE "IncomingLead" SET "ownerId" = $1 WHERE id = $2`,
    [workerId, leadId],
  );

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
    oldValues: null,
    newValues: { leadId, ownerId: workerId },
    confirmationStatus: 'CONFIRMED',
    approvalStatus: null,
    approverUserId: null,
    managerNotified: false,
    executionStatus: 'SUCCESS',
    errorMessage: null,
    pendingActionId: null,
  });
}
