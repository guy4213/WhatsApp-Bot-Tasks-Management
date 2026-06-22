import { pool } from '../db/connection';
import type { PendingAction, WhatsAppActionState, ActionType } from '../types';

const TTL_HOURS = parseInt(process.env.PENDING_ACTION_TTL_HOURS ?? '24', 10);

// NOTE: the "WhatsappPendingAction" table uses camelCase columns (CRM convention),
// so SELECT * / RETURNING * rows map directly onto PendingAction — no translation.

// ── Create ────────────────────────────────────────────────────────────────────

export interface CreatePendingActionInput {
  requesterUserId: string;
  actionType: ActionType;
  targetTaskId?: string;
  payload: Record<string, unknown>;
  initialState?: WhatsAppActionState;
}

export async function createPendingAction(
  input: CreatePendingActionInput,
): Promise<PendingAction> {
  // One-at-a-time: starting a new action auto-cancels the requester's previous
  // un-answered confirmation, so PENDING_EMPLOYEE_CONFIRM rows never pile up.
  // (A request already escalated to PENDING_MANAGER_APPROVAL is left alone — it's
  // legitimately waiting on a manager, not on this user.)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE "WhatsappPendingAction"
       SET state = 'CANCELLED', "resolvedAt" = now(), "updatedAt" = now()
       WHERE "requesterUserId" = $1 AND state = 'PENDING_EMPLOYEE_CONFIRM'`,
      [input.requesterUserId],
    );

    const result = await client.query<PendingAction>(
      `INSERT INTO "WhatsappPendingAction"
         ("requesterUserId", "actionType", "targetTaskId", payload, state, "expiresAt")
       VALUES ($1, $2, $3, $4, $5, now() + $6::interval)
       RETURNING *`,
      [
        input.requesterUserId,
        input.actionType,
        input.targetTaskId ?? null,
        JSON.stringify(input.payload),
        input.initialState ?? 'PENDING_EMPLOYEE_CONFIRM',
        `${TTL_HOURS} hours`,
      ],
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

export async function getPendingAction(id: string): Promise<PendingAction | null> {
  const result = await pool.query<PendingAction>(
    `SELECT * FROM "WhatsappPendingAction" WHERE id = $1`,
    [id],
  );
  return result.rowCount === 0 ? null : result.rows[0];
}

/**
 * The user's most recent un-expired action still awaiting their confirmation.
 * Lets a natural "כן"/"לא" resolve to it without the user typing the id.
 */
export async function getLatestPendingForUser(userId: string): Promise<PendingAction | null> {
  const result = await pool.query<PendingAction>(
    `SELECT * FROM "WhatsappPendingAction"
       WHERE "requesterUserId" = $1
         AND state = 'PENDING_EMPLOYEE_CONFIRM'
         AND "expiresAt" > now()
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    [userId],
  );
  return result.rowCount === 0 ? null : result.rows[0];
}

/**
 * Un-expired actions waiting for a MANAGER/ADMIN to approve or reject (any
 * requester). Lets an elevated user reply a plain "מאשר"/"דחה" to resolve the
 * pending dueDate request without typing its id (when there's exactly one).
 */
export async function getPendingApprovals(limit = 5): Promise<PendingAction[]> {
  const result = await pool.query<PendingAction>(
    `SELECT * FROM "WhatsappPendingAction"
       WHERE state = 'PENDING_MANAGER_APPROVAL'
         AND "expiresAt" > now()
     ORDER BY "createdAt" ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

// ── State transitions ─────────────────────────────────────────────────────────

export async function transitionState(
  id: string,
  toState: WhatsAppActionState,
  approverUserId?: string,
  fromState?: WhatsAppActionState, // if provided, UPDATE only succeeds when current state matches
): Promise<PendingAction> {
  const result = await pool.query<PendingAction>(
    `UPDATE "WhatsappPendingAction"
     SET state            = $2::"WhatsappActionState",
         "approverUserId" = COALESCE($3, "approverUserId"),
         "resolvedAt"     = CASE WHEN $2::text IN ('EXECUTED','REJECTED','EXPIRED','CANCELLED')
                                 THEN now() ELSE "resolvedAt" END,
         "updatedAt"      = now()
     WHERE id = $1
       AND ($4::text IS NULL OR state::text = $4::text)
     RETURNING *`,
    [id, toState, approverUserId ?? null, fromState ?? null],
  );
  if (result.rowCount === 0) {
    throw new Error(`PendingAction ${id} not found or state already changed (concurrent update)`);
  }
  return result.rows[0];
}

// ── Expire stale actions (called by scheduler) ────────────────────────────────

export interface ExpiredAction {
  id: string;
  requesterPhone: string;
  requesterName: string;
  actionType: ActionType;
  state: WhatsAppActionState; // state before expiry (tells us which stage timed out)
  taskTitle: string | null;
}

export async function expireStaleActions(): Promise<ExpiredAction[]> {
  // CTE selects candidates first (capturing old state), then the UPDATE runs
  // against those exact rows. FOR UPDATE SKIP LOCKED prevents double-processing
  // if two scheduler instances run simultaneously.
  const result = await pool.query<ExpiredAction>(
    `WITH candidates AS (
       SELECT wpa.id, wpa.state AS old_state, wpa."actionType", wpa.payload, wpa."requesterUserId"
       FROM "WhatsappPendingAction" wpa
       WHERE wpa.state IN ('PENDING_EMPLOYEE_CONFIRM', 'PENDING_MANAGER_APPROVAL')
         AND wpa."expiresAt" < now()
       FOR UPDATE SKIP LOCKED
     ),
     updated AS (
       UPDATE "WhatsappPendingAction" wpa
       SET state = 'EXPIRED', "resolvedAt" = now(), "updatedAt" = now()
       FROM candidates
       WHERE wpa.id = candidates.id
     )
     SELECT
       c.id,
       u.phone                                                   AS "requesterPhone",
       u.name                                                    AS "requesterName",
       c."actionType"                                            AS "actionType",
       c.old_state                                               AS state,
       COALESCE(c.payload->>'taskTitle', c.payload->>'title')    AS "taskTitle"
     FROM candidates c
     JOIN "User" u ON u.id = c."requesterUserId"`,
  );
  return result.rows;
}

// ── Fetch all active MANAGER/ADMIN users (for broadcast) ──────────────────────

export async function getManagersForBroadcast(): Promise<
  Array<{ id: string; name: string; phone: string }>
> {
  const result = await pool.query<{ id: string; name: string; phone: string }>(
    `SELECT u.id, u.name, u.phone
     FROM "User" u
     WHERE u.role IN ('MANAGER', 'ADMIN')
       AND upper(u.status::text) = 'ACTIVE'
       AND COALESCE(btrim(u.phone), '') <> ''
       AND NOT EXISTS (
         SELECT 1 FROM "WhatsappNotificationRecipient" r
         WHERE r."userId" = u.id
           AND 'DUEDATE_APPROVAL' = ANY(r."eventTypes")
           AND r."isActive" = false
       )`,
  );
  return result.rows;
}
