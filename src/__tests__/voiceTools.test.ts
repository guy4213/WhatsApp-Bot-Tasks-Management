/**
 * Behavioral tests for services/voiceTools.ts — the tool REGISTRY layer:
 * role gating (worker vs manager vs elevated), env-conditional CRM tools,
 * OpenAI schema shape, and executor denial paths. Handlers that need real
 * data are exercised elsewhere / against the DB — here the pool is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
vi.mock('../db/connection', () => ({
  pool: { query: (...a: unknown[]) => query(...a) },
  supabaseAdmin: {},
}));

import {
  buildOpenAiTools,
  listToolNames,
  executeVoiceTool,
} from '../services/voiceTools';
import type { ResolvedUser } from '../types';

const worker: ResolvedUser = {
  id: 'w1', name: 'דני בודק', phone: '972501111111', role: 'TECHNICIAN',
  isElevated: false, canViewAllRecords: false, canManageUsers: false,
  canManagePermissions: false,
};

const manager: ResolvedUser = {
  id: 'm1', name: 'אורי מנהל', phone: '972502222222', role: 'MANAGER',
  isElevated: true, canViewAllRecords: true, canManageUsers: true,
  canManagePermissions: true,
};

beforeEach(() => {
  query.mockClear();
  delete process.env.CRM_API_BASE_URL;
  delete process.env.CRM_SERVICE_JWT;
});

describe('role gating', () => {
  it('a worker sees worker tools but no manager tools', () => {
    const names = listToolNames(worker);
    expect(names).toContain('get_my_inspections');
    expect(names).toContain('update_inspection_status');
    expect(names).toContain('report_problem');
    expect(names).toContain('get_calendar_events');
    expect(names).not.toContain('management_snapshot');
    expect(names).not.toContain('assign_lead');
    expect(names).not.toContain('reassign_task');
    expect(names).not.toContain('enable_worker_tracking');
  });

  it('a manager sees manager tools including elevated-only reassign', () => {
    const names = listToolNames(manager);
    expect(names).toContain('management_snapshot');
    expect(names).toContain('list_exceptions');
    expect(names).toContain('assign_lead');
    expect(names).toContain('reassign_task');
    expect(names).toContain('enable_worker_tracking');
  });

  it('CRM task tools appear only when the CRM bridge is configured', () => {
    expect(listToolNames(worker)).not.toContain('create_crm_task');

    process.env.CRM_API_BASE_URL = 'https://crm.example.com';
    process.env.CRM_SERVICE_JWT = 'jwt';
    const withCrm = listToolNames(worker);
    expect(withCrm).toContain('create_crm_task');
    expect(withCrm).toContain('update_crm_task');
    expect(withCrm).toContain('list_my_crm_tasks');
  });
});

describe('buildOpenAiTools', () => {
  it('emits the OpenAI Realtime function-tool shape', () => {
    const tools = buildOpenAiTools(worker);
    expect(tools.length).toBeGreaterThan(5);
    for (const t of tools) {
      expect(t.type).toBe('function');
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.parameters).toBeTypeOf('object');
    }
  });
});

describe('executeVoiceTool — denial paths', () => {
  it('unknown tool → Hebrew error, ok=false', async () => {
    const res = await executeVoiceTool(worker, 'no_such_tool', {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('כלי לא מוכר');
  });

  it('worker calling a manager tool → permission denied (server-side gate)', async () => {
    const res = await executeVoiceTool(worker, 'management_snapshot', {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('אין לך הרשאה לפעולה הזו');
  });

  it('every execution is audited — including denials', async () => {
    await executeVoiceTool(worker, 'no_such_tool', {});
    const auditCall = query.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('VoiceToolCall'),
    );
    expect(auditCall).toBeTruthy();
  });
});
