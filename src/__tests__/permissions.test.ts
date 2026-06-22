import { describe, it, expect } from 'vitest';
import {
  getFieldEditPermission,
  canViewAllTasks,
  canCreateForOthers,
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

  it('dueDate requires manager approval', () => {
    expect(getFieldEditPermission(sales,   'dueDate')).toBe('REQUIRES_MANAGER_APPROVAL');
    expect(getFieldEditPermission(manager, 'dueDate')).toBe('REQUIRES_MANAGER_APPROVAL');
  });

  it('admin-only fields return ADMIN_ONLY for ADMIN role', () => {
    expect(getFieldEditPermission(admin, 'ownerId')).toBe('ADMIN_ONLY');
    expect(getFieldEditPermission(admin, 'customerId')).toBe('ADMIN_ONLY');
    expect(getFieldEditPermission(admin, 'leadId')).toBe('ADMIN_ONLY');
    expect(getFieldEditPermission(admin, 'projectId')).toBe('ADMIN_ONLY');
  });

  it('admin-only fields return FORBIDDEN for non-ADMIN roles', () => {
    expect(getFieldEditPermission(sales,   'ownerId')).toBe('FORBIDDEN');
    expect(getFieldEditPermission(manager, 'customerId')).toBe('FORBIDDEN');
  });

  it('unknown fields are FORBIDDEN', () => {
    expect(getFieldEditPermission(admin, 'nonExistent')).toBe('FORBIDDEN');
  });
});

describe('canViewAllTasks', () => {
  it('returns true for MANAGER/ADMIN', () => {
    expect(canViewAllTasks(manager)).toBe(true);
    expect(canViewAllTasks(admin)).toBe(true);
  });

  it('returns true for user with canViewAllRecords flag', () => {
    expect(canViewAllTasks(makeUser({ canViewAllRecords: true }))).toBe(true);
  });

  it('returns false for regular employee', () => {
    expect(canViewAllTasks(sales)).toBe(false);
  });
});

describe('canCreateForOthers', () => {
  it('returns true for elevated users', () => {
    expect(canCreateForOthers(manager)).toBe(true);
    expect(canCreateForOthers(admin)).toBe(true);
  });

  it('returns true when canManageUsers flag is set', () => {
    expect(canCreateForOthers(makeUser({ canManageUsers: true }))).toBe(true);
  });

  it('returns false for regular employee', () => {
    expect(canCreateForOthers(sales)).toBe(false);
  });
});

describe('canApprove', () => {
  it('returns true only for elevated users', () => {
    expect(canApprove(manager)).toBe(true);
    expect(canApprove(admin)).toBe(true);
    expect(canApprove(sales)).toBe(false);
  });
});
