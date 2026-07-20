import { pool } from '../db/connection';
import { normalizeIsraeliPhone } from './phoneNormalizer';
import { writeAuditLog } from '../utils/auditLog';
import type { ResolvedUser } from '../types';

export type AuthResult =
  | { ok: true; user: ResolvedUser }
  | { ok: false; reason: 'UNKNOWN_NUMBER' | 'INACTIVE_USER' };

/**
 * Resolve a raw WhatsApp number to an authenticated, active user.
 * Logs every attempt (success and failure) to "WhatsappAuditLog".
 */
export async function resolveUserByPhone(rawPhone: string): Promise<AuthResult> {
  const canonical = normalizeIsraeliPhone(rawPhone);

  if (!canonical) {
    await writeAuditLog({
      userId: null,
      whatsappNumber: rawPhone,
      originalMessage: null,
      transcribedMessage: null,
      detectedIntent: null,
      detectedAction: null,
      confidence: null,
      targetTaskId: null,
      oldValues: null,
      newValues: null,
      confirmationStatus: null,
      approvalStatus: null,
      approverUserId: null,
      managerNotified: false,
      executionStatus: 'SKIPPED',
      errorMessage: 'Unrecognizable phone format',
      pendingActionId: null,
    });
    return { ok: false, reason: 'UNKNOWN_NUMBER' };
  }

  // Match on the primary "User"."phone" OR any secondary number in "UserPhone"
  // (one user may message from several devices — same userId, so tasks and the
  // Outlook calendar stay shared). "UserPhone"."phoneDigits" is stored already
  // normalized (972XXXXXXXXX) and is UNIQUE, so a number can never map to two
  // people. Primary "phone" is ordered first so it wins on any overlap.
  const result = await pool.query<{
    id: string;
    name: string;
    phone: string;
    role: string;
    status: string;
    can_view_all_records: boolean;
    can_manage_users: boolean;
    can_manage_permissions: boolean;
  }>(
    `SELECT u.id, u.name, u.phone, u.role, u.status,
            u."canViewAllRecords"     AS can_view_all_records,
            u."canManageUsers"        AS can_manage_users,
            u."canManagePermissions"  AS can_manage_permissions
     FROM "User" u
     LEFT JOIN "UserPhone" up ON up."userId" = u.id
     WHERE regexp_replace(u.phone, '[^0-9]', '', 'g') = $1
        OR regexp_replace(u.phone, '[^0-9]', '', 'g') = $2
        OR up."phoneDigits" = $1
     ORDER BY (regexp_replace(u.phone, '[^0-9]', '', 'g') IN ($1, $2)) DESC
     LIMIT 1`,
    [canonical, canonical.replace(/^972/, '0')],
  );

  if ((result.rowCount ?? 0) === 0) {
    await writeAuditLog({
      userId: null,
      whatsappNumber: rawPhone,
      originalMessage: null,
      transcribedMessage: null,
      detectedIntent: null,
      detectedAction: null,
      confidence: null,
      targetTaskId: null,
      oldValues: null,
      newValues: null,
      confirmationStatus: null,
      approvalStatus: null,
      approverUserId: null,
      managerNotified: false,
      executionStatus: 'SKIPPED',
      errorMessage: 'No user found for phone',
      pendingActionId: null,
    });
    return { ok: false, reason: 'UNKNOWN_NUMBER' };
  }

  const row = result.rows[0];

  if (row.status !== 'active' && row.status !== 'ACTIVE') {
    await writeAuditLog({
      userId: row.id,
      whatsappNumber: rawPhone,
      originalMessage: null,
      transcribedMessage: null,
      detectedIntent: null,
      detectedAction: null,
      confidence: null,
      targetTaskId: null,
      oldValues: null,
      newValues: null,
      confirmationStatus: null,
      approvalStatus: null,
      approverUserId: null,
      managerNotified: false,
      executionStatus: 'SKIPPED',
      errorMessage: `User is inactive (status=${row.status})`,
      pendingActionId: null,
    });
    return { ok: false, reason: 'INACTIVE_USER' };
  }

  const role = row.role as ResolvedUser['role'];
  const isElevated = role === 'MANAGER' || role === 'ADMIN';

  return {
    ok: true,
    user: {
      id: row.id,
      name: row.name,
      phone: row.phone,
      role,
      isElevated,
      canViewAllRecords: row.can_view_all_records,
      canManageUsers: row.can_manage_users,
      canManagePermissions: row.can_manage_permissions,
    },
  };
}
