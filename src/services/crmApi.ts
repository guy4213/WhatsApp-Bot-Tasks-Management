/**
 * VOICE-2 — Thin client for the CRM REST API (NestJS on Railway).
 *
 * The voice assistant creates/updates CRM Tasks THROUGH the CRM API rather
 * than writing to CRM-owned tables directly — the CRM stays the single owner
 * of task creation logic (auto titles, role rules), per the project's CRM
 * write constraints.
 *
 * Auth: a pre-minted service JWT (CRM_SERVICE_JWT) signed with the CRM's
 * JWT_SECRET, carried as `Authorization: Bearer`. The CRM's RolesGuard reads
 * `{ sub, role }` from it. Mint with an ADMIN/MANAGER role so the voice layer
 * may set `ownerId` to the SPEAKING user (the CRM forbids that for lower
 * roles). The speaking user's id always rides in `ownerId` so ownership stays
 * truthful.
 *
 * Shape mirrors src/services/osrmRoute.ts: native fetch + AbortController
 * timeout, never throws — every failure returns null and the tool layer turns
 * that into a friendly Hebrew error.
 */

import { moduleLogger } from '../utils/logger';
import { pool } from '../db/connection';

const logger = moduleLogger('crm-api');

const TIMEOUT_MS = 10_000;

function baseUrl(): string | null {
  const raw = (process.env.CRM_API_BASE_URL ?? '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function serviceJwt(): string | null {
  const raw = (process.env.CRM_SERVICE_JWT ?? '').trim();
  return raw || null;
}

/** True when both CRM env vars are configured (tools show up only then). */
export function crmApiConfigured(): boolean {
  return baseUrl() !== null && serviceJwt() !== null;
}

async function crmFetch<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  opts: { userId?: string } = {},
): Promise<T | null> {
  const base = baseUrl();
  const jwt = serviceJwt();
  if (!base || !jwt) {
    logger.warn('CRM API not configured (CRM_API_BASE_URL / CRM_SERVICE_JWT)');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        // The CRM's Outlook/calendar routes act "on behalf of" this user (their
        // stored refresh token). x-user-id names that user.
        ...(opts.userId ? { 'x-user-id': opts.userId } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      // Never log response bodies — they may carry customer data.
      logger.warn({ status: res.status, path, method }, 'CRM API request failed');
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, path, method }, 'CRM API request error');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Task shapes (subset of the CRM Prisma Task the voice layer touches) ──────

export interface CrmTask {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  priority: string;
  status: string;
  ownerId: string;
  customerId: string | null;
  productName: string | null;
  createdAt?: string;
}

export interface CreateCrmTaskInput {
  title: string;
  ownerId: string;                 // the SPEAKING user — ownership stays truthful
  description?: string;
  dueDate?: string;                // ISO 8601
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  customerId?: string;
}

export async function createCrmTask(input: CreateCrmTaskInput): Promise<CrmTask | null> {
  return crmFetch<CrmTask>('POST', '/tasks', input);
}

export interface UpdateCrmTaskInput {
  title?: string;
  description?: string;
  dueDate?: string | null;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  status?: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
}

export async function updateCrmTask(
  taskId: string,
  patch: UpdateCrmTaskInput,
): Promise<CrmTask | null> {
  return crmFetch<CrmTask>('PATCH', `/tasks/${encodeURIComponent(taskId)}`, patch);
}

/**
 * All tasks visible to the service JWT (`scope=all`), filtered here to the
 * given owner. The CRM list endpoint has no owner filter — the voice layer
 * needs "my open office tasks", so we filter + cap client-side.
 */
export async function listCrmTasksForOwner(
  ownerId: string,
  opts: { status?: string; limit?: number } = {},
): Promise<CrmTask[] | null> {
  const all = await crmFetch<CrmTask[]>('GET', '/tasks?scope=all');
  if (!all) return null;
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  return all
    .filter((t) => t.ownerId === ownerId)
    .filter((t) => (opts.status ? t.status === opts.status : t.status !== 'DONE' && t.status !== 'CANCELLED'))
    .slice(0, limit);
}

/** CrmTask enriched with the owner's display name (for manager org-wide views). */
export interface CrmTaskWithOwner extends CrmTask {
  ownerName: string | null;
}

/**
 * ALL office (CRM) tasks org-wide — for managers who need to see everyone's
 * tasks, not just their own. Optionally filter to one owner id. Enriches each
 * task with the owner's Hebrew name (looked up in the shared DB, since the CRM
 * task payload carries only ownerId). Managers-only — the caller gates this.
 */
export async function listAllCrmTasks(
  opts: { ownerId?: string; status?: string; limit?: number } = {},
): Promise<CrmTaskWithOwner[] | null> {
  const all = await crmFetch<CrmTask[]>('GET', '/tasks?scope=all');
  if (!all) return null;

  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const filtered = all
    .filter((t) => (opts.ownerId ? t.ownerId === opts.ownerId : true))
    .filter((t) => (opts.status ? t.status === opts.status : t.status !== 'DONE' && t.status !== 'CANCELLED'))
    .slice(0, limit);

  // Enrich with owner names in a single DB round-trip.
  const ownerIds = [...new Set(filtered.map((t) => t.ownerId).filter(Boolean))];
  const names = new Map<string, string>();
  if (ownerIds.length) {
    try {
      const { rows } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM "User" WHERE id = ANY($1)`,
        [ownerIds],
      );
      rows.forEach((r) => names.set(r.id, r.name));
    } catch (err) {
      logger.warn({ err }, 'owner-name enrichment failed — returning without names');
    }
  }
  return filtered.map((t) => ({ ...t, ownerName: names.get(t.ownerId) ?? null }));
}

// ── Outlook calendar (via the CRM's stored per-user Outlook connection) ──────
//
// The CRM already holds each user's encrypted Outlook refresh token
// (User.msRefreshToken) and mints Graph access tokens on demand. The bot has no
// working Outlook link of its own, so calendar reads/writes go THROUGH the CRM,
// naming the speaking user via x-user-id. This reuses the exact connection the
// CRM uses for quotes/mail/calendar — no separate consent, no second table.
//
// Unlike the task helpers, these throw a Hebrew Error on failure (rather than
// returning null) so the voice tool can speak the CRM's own message — e.g.
// "חשבון Outlook אינו מחובר — יש להתחבר תחילה".

export interface CrmCalendarEvent {
  id: string;
  subject: string | null;
  start: { dateTime: string; timeZone: string } | null;
  end: { dateTime: string; timeZone: string } | null;
  location: string | null;
  isOnlineMeeting: boolean;
  isAllDay: boolean;
  webLink: string | null;
}

export interface CrmCreateCalendarEventInput {
  subject: string;
  /** ISO 8601 local wall time (no offset), e.g. "2026-07-15T14:00:00". */
  start: string;
  end: string;
  timeZone?: string;
  location?: string | null;
  body?: string | null;
}

export interface CrmCreatedCalendarEvent {
  id: string;
  webLink: string | null;
  joinUrl: string | null;
  invited: string[];
}

/**
 * Low-level call that surfaces the CRM's Hebrew error message on failure.
 * Throws Error (message = CRM's `error` field when present) instead of the
 * null-swallowing crmFetch, because calendar UX needs the real reason.
 */
async function crmCalendarFetch<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  userId: string,
  body?: unknown,
): Promise<T> {
  const base = baseUrl();
  const jwt = serviceJwt();
  if (!base || !jwt) {
    throw new Error('חיבור ל-CRM אינו מוגדר — לא ניתן לגשת ליומן כרגע');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        'x-user-id': userId,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      let msg = '';
      try {
        const parsed = (await res.json()) as { message?: string; error?: string };
        msg = parsed.message || parsed.error || '';
      } catch {
        /* non-JSON body */
      }
      logger.warn({ status: res.status, path, method }, 'CRM calendar request failed');
      // Prefer the CRM's Hebrew message; fall back to a generic one.
      throw new Error(msg || 'הפעולה מול היומן נכשלה');
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Read the speaking user's Outlook calendar through the CRM. */
export async function listCrmCalendarEvents(
  userId: string,
  opts: { startIso?: string; endIso?: string; top?: number } = {},
): Promise<CrmCalendarEvent[]> {
  const params = new URLSearchParams();
  if (opts.startIso) params.set('start', opts.startIso);
  if (opts.endIso) params.set('end', opts.endIso);
  if (opts.top) params.set('top', String(opts.top));
  const qs = params.toString();
  const data = await crmCalendarFetch<{ events: CrmCalendarEvent[]; count: number }>(
    'GET',
    `/outlook/calendar/events${qs ? `?${qs}` : ''}`,
    userId,
  );
  return data.events ?? [];
}

/** Create an event on the speaking user's Outlook calendar through the CRM. */
export async function createCrmCalendarEvent(
  userId: string,
  input: CrmCreateCalendarEventInput,
): Promise<CrmCreatedCalendarEvent> {
  return crmCalendarFetch<CrmCreatedCalendarEvent>(
    'POST',
    '/outlook/calendar/events',
    userId,
    {
      subject: input.subject,
      start: input.start,
      end: input.end,
      timeZone: input.timeZone ?? 'Asia/Jerusalem',
      ...(input.location ? { location: input.location } : {}),
      ...(input.body ? { body: input.body } : {}),
    },
  );
}

export interface CrmUpdateCalendarEventInput {
  subject?: string;
  /** ISO 8601 local wall time (no offset). */
  start?: string;
  end?: string;
  timeZone?: string;
  location?: string | null;
  body?: string | null;
}

/** Update an existing event on the speaking user's Outlook calendar (only supplied fields). */
export async function updateCrmCalendarEvent(
  userId: string,
  eventId: string,
  patch: CrmUpdateCalendarEventInput,
): Promise<{ id: string; webLink: string | null }> {
  const payload: Record<string, unknown> = {};
  if (patch.subject !== undefined) payload.subject = patch.subject;
  if (patch.start !== undefined) payload.start = patch.start;
  if (patch.end !== undefined) payload.end = patch.end;
  if (patch.timeZone !== undefined) payload.timeZone = patch.timeZone;
  if (patch.location !== undefined && patch.location !== null) payload.location = patch.location;
  if (patch.body !== undefined && patch.body !== null) payload.body = patch.body;
  return crmCalendarFetch<{ id: string; webLink: string | null }>(
    'PATCH',
    `/outlook/calendar/events/${encodeURIComponent(eventId)}`,
    userId,
    payload,
  );
}

/** Delete an event from the speaking user's Outlook calendar. */
export async function deleteCrmCalendarEvent(
  userId: string,
  eventId: string,
): Promise<{ deleted: boolean }> {
  return crmCalendarFetch<{ deleted: boolean }>(
    'DELETE',
    `/outlook/calendar/events/${encodeURIComponent(eventId)}`,
    userId,
  );
}
