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
