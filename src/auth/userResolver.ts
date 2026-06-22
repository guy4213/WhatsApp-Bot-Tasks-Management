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

  // Try several phone column formats stored in the DB
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
    `SELECT id, name, phone, role, status,
            "canViewAllRecords"     AS can_view_all_records,
            "canManageUsers"        AS can_manage_users,
            "canManagePermissions"  AS can_manage_permissions
     FROM "User"
     WHERE regexp_replace(phone, '[^0-9]', '', 'g') = $1
        OR regexp_replace(phone, '[^0-9]', '', 'g') = $2
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
