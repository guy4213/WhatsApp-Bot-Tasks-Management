import { describe, it, expect } from 'vitest';
import {
  getFieldEditPermission,
  canViewAllTasks,
  canCreateForOthers,
  canEditTask,
  canApprove,
} from '../auth/permissions';
import type { ResolvedUser } from '../types';

function makeUser(overrides: Partial<ResolvedUser> = {}): ResolvedUser {
  return {
    id: 'u1',
    name: 'Test',
    phone: '972501234567',
    role: 'SALES',
    isElevated: false,
    canViewAllRecords: false,
    canManageUsers: false,
    canManagePermissions: false,
    ...overrides,
  };
}

const manager = makeUser({ role: 'MANAGER', isElevated: true });
const admin   = makeUser({ role: 'ADMIN',   isElevated: true });
const sales   = makeUser({ role: 'SALES' });

describe('getFieldEditPermission', () => {
  it('system fields are READONLY', () => {
    expect(getFieldEditPermission(sales, 'id')).toBe('READONLY');
    expect(getFieldEditPermission(sales, 'createdAt')).toBe('READONLY');
    expect(getFieldEditPermission(sales, 'updatedAt')).toBe('READONLY');
    expect(getFieldEditPermission(sales, 'status')).toBe('READONLY');
  });

  it('free-edit fields are FREE_EDIT for any role', () => {
    expect(getFieldEditPermission(sales,   'title')).toBe('FREE_EDIT');
    expect(getFieldEditPermission(manager, 'description')).toBe('FREE_EDIT');
    expect(getFieldEditPermission(admin,   'priority')).toBe('FREE_EDIT');
    expect(getFieldEditPermission(sales,   'type')).toBe('FREE_EDIT');
  });

  it('dueDate is FORBIDDEN for all roles (X-T2 removed the manager-approval pipeline)', () => {
    expect(getFieldEditPermission(sales,   'dueDate')).toBe('FORBIDDEN');
    expect(getFieldEditPermission(manager, 'dueDate')).toBe('FORBIDDEN');
    expect(getFieldEditPermission(admin,   'dueDate')).toBe('FORBIDDEN');
  });

  it('reassign/relink fields return ELEVATED_ONLY for MANAGER/ADMIN', () => {
    for (const f of ['ownerId', 'customerId', 'leadId', 'projectId']) {
      expect(getFieldEditPermission(admin,   f)).toBe('ELEVATED_ONLY');
      expect(getFieldEditPermission(manager, f)).toBe('ELEVATED_ONLY');
    }
  });

  it('reassign/relink fields return FORBIDDEN for a regular employee', () => {
    expect(getFieldEditPermission(sales, 'ownerId')).toBe('FORBIDDEN');
    expect(getFieldEditPermission(sales, 'customerId')).toBe('FORBIDDEN');
  });

  it('unknown fields are FORBIDDEN', () => {
    expect(getFieldEditPermission(admin, 'nonExistent')).toBe('FORBIDDEN');
  });
});

describe('canViewAllTasks', () => {
  it('viewing is open to everyone — returns true for any authenticated user', () => {
    expect(canViewAllTasks(manager)).toBe(true);
    expect(canViewAllTasks(admin)).toBe(true);
    expect(canViewAllTasks(sales)).toBe(true);
    expect(canViewAllTasks(makeUser({ canViewAllRecords: false }))).toBe(true);
  });
});

describe('canCreateForOthers', () => {
  it('returns true for elevated users', () => {
    expect(canCreateForOthers(manager)).toBe(true);
    expect(canCreateForOthers(admin)).toBe(true);
  });

  it('canManageUsers flag does NOT grant create-for-others (ADMIN/MANAGER only)', () => {
    expect(canCreateForOthers(makeUser({ canManageUsers: true }))).toBe(false);
  });

  it('returns false for regular employee', () => {
    expect(canCreateForOthers(sales)).toBe(false);
  });
});

describe('canEditTask', () => {
  it('owner can edit their own task', () => {
    expect(canEditTask(sales, { ownerId: 'u1' })).toBe(true);
  });

  it('regular employee CANNOT edit another user\'s task', () => {
    expect(canEditTask(sales, { ownerId: 'someone-else' })).toBe(false);
  });

  it('canViewAllRecords does NOT grant edit rights on others\' tasks', () => {
    const viewer = makeUser({ canViewAllRecords: true });
    expect(canEditTask(viewer, { ownerId: 'someone-else' })).toBe(false);
  });

  it('manager/admin can edit any task', () => {
    expect(canEditTask(manager, { ownerId: 'someone-else' })).toBe(true);
    expect(canEditTask(admin, { ownerId: 'someone-else' })).toBe(true);
  });
});

describe('canApprove', () => {
  it('returns true only for elevated users', () => {
    expect(canApprove(manager)).toBe(true);
    expect(canApprove(admin)).toBe(true);
    expect(canApprove(sales)).toBe(false);
  });
});
