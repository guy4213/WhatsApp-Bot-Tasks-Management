/**
 * Quoted-message context infrastructure (Phase 2).
 *
 * At send time we record a GENERAL context row (`WhatsappMessageRef`, migration
 * 015) mapping the outbound Meta message id (wamid) to WHAT the message was about
 * — a TaskField, an equipment reminder, a daily digest, a menu, etc. When a
 * worker swipe-replies (quotes) that message, Meta's inbound webhook carries
 * `context.id = <that wamid>`, and `resolveQuotedContext` maps it back so the
 * router can decide what to do (deterministic for task_field status updates;
 * hand the context to the AI for other kinds).
 *
 * Design rules:
 *  - `recordOutboundRef` is BEST-EFFORT and NEVER throws: a ref-write failure must
 *    not affect the WhatsApp send that produced the wamid.
 *  - The table is deliberately general — `taskFieldId` is only a convenience FK
 *    for `entityType='task_field'`.
 */
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('messageRefs');

/** How long a task_field ref stays actionable (so a very old quote can't act). */
const TASKFIELD_REF_TTL_DAYS = 30;

export type MessageRefEntityType =
  | 'task_field' | 'equipment_reminder' | 'daily_digest'
  | 'menu' | 'task' | 'lead' | 'general';

export type MessageRefKind =
  | 'pre_reminder' | 'assignment_card' | 'eta_prompt' | 'status_confirm'
  | 'equipment_reminder' | 'daily_digest' | 'menu' | 'general';

export interface RecordOutboundRefParams {
  wamid: string | null | undefined;
  entityType: MessageRefEntityType;
  kind: MessageRefKind;
  recipientUserId?: string | null;
  entityId?: string | null;
  taskFieldId?: string | null;
  payload?: Record<string, unknown> | null;
  /** Explicit expiry; when omitted, task_field refs default to +30d, others null. */
  expiresAt?: Date | null;
}

export interface QuotedContext {
  wamid: string;
  recipientUserId: string | null;
  entityType: MessageRefEntityType;
  entityId: string | null;
  taskFieldId: string | null;
  kind: string;
  payload: Record<string, unknown> | null;
  createdAt: Date;
  expiresAt: Date | null;
}

/**
 * Record a wamid → context mapping. BEST-EFFORT: swallows every error (a missing
 * wamid, a DB blip) so a send is never impacted. Returns true iff a row was written.
 */
export async function recordOutboundRef(params: RecordOutboundRefParams): Promise<boolean> {
  const { wamid } = params;
  if (!wamid) return false; // send returned no id (or was skipped) → nothing to record
  try {
    const expiresAt =
      params.expiresAt !== undefined
        ? params.expiresAt
        : params.entityType === 'task_field'
          ? new Date(Date.now() + TASKFIELD_REF_TTL_DAYS * 24 * 3600_000)
          : null;
    await pool.query(
      `INSERT INTO "WhatsappMessageRef"
         (wamid, "recipientUserId", "entityType", "entityId", "taskFieldId", kind, payload, "expiresAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (wamid) DO NOTHING`,
      [
        wamid,
        params.recipientUserId ?? null,
        params.entityType,
        params.entityId ?? null,
        params.taskFieldId ?? null,
        params.kind,
        params.payload ? JSON.stringify(params.payload) : null,
        expiresAt,
      ],
    );
    return true;
  } catch (err) {
    log.warn({ err, wamid, entityType: params.entityType }, 'recordOutboundRef failed (ignored)');
    return false;
  }
}

/** Convenience: record a ref for a TaskField-scoped message. Best-effort. */
export async function recordTaskFieldRef(
  wamid: string | null | undefined,
  taskFieldId: string,
  recipientUserId: string | null,
  kind: MessageRefKind,
): Promise<boolean> {
  return recordOutboundRef({
    wamid,
    entityType: 'task_field',
    entityId: taskFieldId,
    taskFieldId,
    recipientUserId,
    kind,
  });
}

/**
 * Resolve a quoted (replied-to) wamid back to its full context. Returns null when
 * the wamid is unknown or the ref has expired (expiresAt in the past). NULL
 * expiresAt means "no expiry". Never throws on a not-found — only on a real DB
 * error (which callers treat as "no context").
 */
export async function resolveQuotedContext(
  wamid: string | null | undefined,
): Promise<QuotedContext | null> {
  if (!wamid) return null;
  try {
    const { rows } = await pool.query<{
      wamid: string;
      recipientUserId: string | null;
      entityType: MessageRefEntityType;
      entityId: string | null;
      taskFieldId: string | null;
      kind: string;
      payload: Record<string, unknown> | null;
      createdAt: Date;
      expiresAt: Date | null;
    }>(
      `SELECT wamid, "recipientUserId", "entityType", "entityId", "taskFieldId",
              kind, payload, "createdAt", "expiresAt"
         FROM "WhatsappMessageRef"
        WHERE wamid = $1
          AND ("expiresAt" IS NULL OR "expiresAt" > now())`,
      [wamid],
    );
    return rows[0] ?? null;
  } catch (err) {
    log.warn({ err, wamid }, 'resolveQuotedContext failed (treated as no context)');
    return null;
  }
}
