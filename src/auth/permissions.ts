import type { ResolvedUser } from '../types';

// Fields a regular employee can edit freely on their own tasks
const FREE_EDIT_FIELDS = new Set(['title', 'description', 'priority', 'type']);

// Fields that require manager approval
const MANAGER_APPROVAL_FIELDS = new Set(['dueDate']);

// Fields only an ADMIN can change
const ADMIN_ONLY_FIELDS = new Set(['ownerId', 'customerId', 'leadId', 'projectId']);

// Fields the bot never touches
const SYSTEM_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'status']);

export type EditPermission =
  | 'FREE_EDIT'
  | 'REQUIRES_MANAGER_APPROVAL'
  | 'ADMIN_ONLY'
  | 'READONLY'
  | 'FORBIDDEN';

export function getFieldEditPermission(
  user: ResolvedUser,
  field: string,
): EditPermission {
  if (SYSTEM_FIELDS.has(field)) return 'READONLY';
  if (FREE_EDIT_FIELDS.has(field)) return 'FREE_EDIT';
  if (MANAGER_APPROVAL_FIELDS.has(field)) return 'REQUIRES_MANAGER_APPROVAL';
  if (ADMIN_ONLY_FIELDS.has(field)) {
    return user.role === 'ADMIN' ? 'ADMIN_ONLY' : 'FORBIDDEN';
  }
  return 'FORBIDDEN';
}

/** Can this user see tasks that belong to other users? */
export function canViewAllTasks(user: ResolvedUser): boolean {
  return user.isElevated || user.canViewAllRecords;
}

/** Can this user create a task on behalf of another user? */
export function canCreateForOthers(user: ResolvedUser): boolean {
  return user.isElevated || user.canManageUsers;
}

/** Is this user allowed to approve/reject dueDate change requests? */
export function canApprove(user: ResolvedUser): boolean {
  return user.isElevated;
}
