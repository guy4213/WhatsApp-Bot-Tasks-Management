import type { ResolvedUser } from '../types';

// Fields a regular employee can edit freely on their own tasks
const FREE_EDIT_FIELDS = new Set(['title', 'description', 'priority', 'type']);

// Reassign/relink fields — only MANAGER/ADMIN (elevated) may change them.
const ELEVATED_ONLY_FIELDS = new Set(['ownerId', 'customerId', 'leadId', 'projectId']);

// Fields the bot never touches
const SYSTEM_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'status']);

export type EditPermission =
  | 'FREE_EDIT'
  | 'REQUIRES_MANAGER_APPROVAL'
  | 'ELEVATED_ONLY'
  | 'READONLY'
  | 'FORBIDDEN';

export function getFieldEditPermission(
  user: ResolvedUser,
  field: string,
): EditPermission {
  if (SYSTEM_FIELDS.has(field)) return 'READONLY';
  if (FREE_EDIT_FIELDS.has(field)) return 'FREE_EDIT';
  if (ELEVATED_ONLY_FIELDS.has(field)) {
    return user.isElevated ? 'ELEVATED_ONLY' : 'FORBIDDEN';
  }
  return 'FORBIDDEN';
}

/**
 * Can this user see tasks that belong to other users?
 * Viewing is OPEN to every authenticated user — anyone may READ any task (both
 * the list view and the single-task details). Write actions are gated separately
 * and stay restricted: canEditTask (own task, or elevated), canCreateForOthers
 * (elevated), and the ELEVATED_ONLY reassign/relink fields. The per-user
 * canViewAllRecords flag is therefore no longer consulted for task visibility.
 */
export function canViewAllTasks(_user: ResolvedUser): boolean {
  return true;
}

/** Can this user create a task on behalf of another user? ADMIN/MANAGER only —
 *  the per-user canManageUsers flag governs user administration, not task
 *  authorship, so it intentionally does NOT grant create-for-others. */
export function canCreateForOthers(user: ResolvedUser): boolean {
  return user.isElevated;
}

/**
 * Can this user perform a write action (edit/reassign/relink) on this task?
 * A regular employee may only act on tasks they OWN. Only MANAGER/ADMIN may act
 * on any task. NOTE: this is deliberately stricter than canViewAllTasks — the
 * canViewAllRecords flag grants read-only visibility and must NOT grant edit
 * rights, so it is intentionally not consulted here.
 */
export function canEditTask(user: ResolvedUser, task: { ownerId: string }): boolean {
  return user.isElevated || task.ownerId === user.id;
}

/** Is this user allowed to approve/reject dueDate change requests? */
export function canApprove(user: ResolvedUser): boolean {
  return user.isElevated;
}
