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

// יורם — exceptions-only viewer (isManagerMenuUser=true), NOT in
// LEADS_VIEWER_NAMES, NOT elevated. Must be blocked from `assign_lead`
// (canAssignLeads=false) even though he sees the broader manager menu.
const yoram: ResolvedUser = {
  id: 'y1', name: 'יורם', phone: '972503333333', role: 'TECHNICIAN',
  isElevated: false, canViewAllRecords: false, canManageUsers: false,
  canManagePermissions: false,
};

// סשה — leads viewer, NOT elevated. Must be allowed on `assign_lead`
// (canAssignLeads=true via isLeadsViewer).
const sasha: ResolvedUser = {
  id: 's1', name: 'סשה', phone: '972504444444', role: 'TECHNICIAN',
  isElevated: false, canViewAllRecords: false, canManageUsers: false,
  canManagePermissions: false,
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
    // get_calendar_events is CRM-bridge-gated (calendar reads go through the CRM's
    // stored Outlook connection), so it's covered in the CRM-conditional test below.
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

  it('an exceptions-only viewer (Yoram) sees the manager menu but NOT assign_lead', () => {
    // isManagerMenuUser=true → sees the broader manager surface,
    // but canAssignLeads=false → assign_lead is hidden.
    const names = listToolNames(yoram);
    expect(names).toContain('management_snapshot');
    expect(names).toContain('list_pending_leads');
    expect(names).not.toContain('assign_lead');
    expect(names).not.toContain('reassign_task'); // elevated-only
  });

  it('a leads viewer (Sasha) sees assign_lead even without elevation', () => {
    // canAssignLeads=true via isLeadsViewer; not elevated so no reassign_task.
    const names = listToolNames(sasha);
    expect(names).toContain('assign_lead');
    expect(names).toContain('list_pending_leads');
    expect(names).not.toContain('reassign_task');
  });

  it('CRM task tools appear only when the CRM bridge is configured', () => {
    expect(listToolNames(worker)).not.toContain('create_crm_task');
    // Calendar tools also go through the CRM bridge (stored Outlook connection).
    expect(listToolNames(worker)).not.toContain('get_calendar_events');
    expect(listToolNames(worker)).not.toContain('create_calendar_event');

    process.env.CRM_API_BASE_URL = 'https://crm.example.com';
    process.env.CRM_SERVICE_JWT = 'jwt';
    const withCrm = listToolNames(worker);
    expect(withCrm).toContain('create_crm_task');
    expect(withCrm).toContain('update_crm_task');
    expect(withCrm).toContain('list_my_crm_tasks');
    expect(withCrm).toContain('get_calendar_events');
    expect(withCrm).toContain('create_calendar_event');
    expect(withCrm).toContain('update_calendar_event');
    expect(withCrm).toContain('delete_calendar_event');
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

  it('Yoram (exceptions-only) calling assign_lead → permission denied even though he sees the manager menu', async () => {
    // Defense-in-depth: the browser is not trusted. Even if the tool was
    // somehow surfaced client-side, the server-side gate must block it.
    const res = await executeVoiceTool(yoram, 'assign_lead', {
      lead_query: 'anything', worker_name: 'דני',
    });
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
