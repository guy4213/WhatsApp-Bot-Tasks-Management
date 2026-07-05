/**
 * Special-user routing — identified by User.name (not env vars).
 *
 * V2 spec + operational overrides (2026-07-01):
 *
 *   סשה                                  → SPEC §12 leads morning digest at 09:30
 *                                          + 1-hour escalation alerts. No other digests.
 *
 *   יורם / גיא פרנסס / גיא גבאי / יאיר  → SPEC §13 exceptions digest (morning + evening).
 *                                          "אדמינים" — Yoram is the operational owner;
 *                                          the other three are internal dev observers
 *                                          so we can see the same picture in prod.
 *
 *   גיא פרנסס / יאיר (+ סשה)            → ALSO receive the Sasha leads morning digest
 *                                          and the 1-hour escalation alerts (dev
 *                                          visibility into the leads pipeline).
 *
 *   everyone else                        → inspector morning §7 + employee evening.
 *
 * Names are literal DB matches on `User.name`. If the CRM renames one of these
 * users, edit the set here (one line). This intentional coupling replaces env
 * vars — the DB name is the routing key, the DB phone is the delivery target,
 * no drift possible.
 */
import { pool } from '../db/connection';
import type { ResolvedUser } from '../types';

export const SASHA_NAME = 'סשה';

/** Users who receive the §13 exceptions digest (morning + evening). */
export const EXCEPTIONS_VIEWER_NAMES: ReadonlySet<string> = new Set([
  'יורם',
  'גיא פרנסס',
  'גיא גבאי',
  'יאיר',
]);

/**
 * Users who receive the §12 leads morning digest at 09:30 AND the D3-T4
 * 1-hour escalation alerts. Sasha is the operational owner; the other two are
 * dev observers.
 */
export const LEADS_VIEWER_NAMES: ReadonlySet<string> = new Set([
  SASHA_NAME,
  'גיא פרנסס',
  'יאיר',
]);

export function isSasha(userName: string | null | undefined): boolean {
  return userName === SASHA_NAME;
}

export function isExceptionsViewer(userName: string | null | undefined): boolean {
  return typeof userName === 'string' && EXCEPTIONS_VIEWER_NAMES.has(userName);
}

export function isLeadsViewer(userName: string | null | undefined): boolean {
  return typeof userName === 'string' && LEADS_VIEWER_NAMES.has(userName);
}

/**
 * D5-T19i: users allowed to assign leads via WhatsApp. Previously only
 * `isLeadsViewer` (Sasha + the two dev observers) could — ADMIN/MANAGER were
 * rejected outright, even though they are legitimate lead-assignment
 * stakeholders per an explicit product decision (2026-07-05 QA). Widened to
 * `isLeadsViewer(name) OR isElevated` (ADMIN/MANAGER) — CLAUDE.md §6.5 lists
 * this as the documented allowlist extension, not a new forbidden write:
 * `assign_lead` only ever updates `IncomingLead.ownerId`, already a
 * documented allowed write (§6.6).
 */
export function canAssignLeads(user: Pick<ResolvedUser, 'name' | 'isElevated'>): boolean {
  return isLeadsViewer(user.name) || user.isElevated;
}

/**
 * All active phones of users configured as leads viewers (Sasha + dev
 * observers). Used by the D3-T4 1-hour escalation alert — each phone gets
 * one alert per lead. Users with no phone or not-active are silently skipped.
 * Returns [] when no one is configured — the escalation job then no-ops.
 */
export async function getLeadsViewerPhones(): Promise<string[]> {
  const names = Array.from(LEADS_VIEWER_NAMES);
  const { rows } = await pool.query<{ phone: string }>(
    `SELECT phone FROM "User"
     WHERE name = ANY($1::text[])
       AND upper(status::text) = 'ACTIVE'
       AND phone IS NOT NULL
       AND phone <> ''`,
    [names],
  );
  return rows.map((r) => r.phone);
}
