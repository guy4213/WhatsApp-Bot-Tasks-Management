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
    // org-wide CRM tasks is manager-gated → a worker never sees it
    expect(withCrm).not.toContain('list_all_crm_tasks');
  });

  it('managers get list_all_crm_tasks (org-wide office tasks) when CRM is configured', () => {
    process.env.CRM_API_BASE_URL = 'https://crm.example.com';
    process.env.CRM_SERVICE_JWT = 'jwt';
    expect(listToolNames(manager)).toContain('list_all_crm_tasks');
    expect(listToolNames(worker)).not.toContain('list_all_crm_tasks');
  });

  it('get_lead_details is manager-gated (same as list_pending_leads)', () => {
    // Detail tool must not leak lead body to workers even though the underlying
    // getLeadById is a plain DB read.
    expect(listToolNames(worker)).not.toContain('get_lead_details');
    expect(listToolNames(manager)).toContain('get_lead_details');
    // Sasha (leads viewer via isManagerMenuUser) also sees it — same gate as list_pending_leads.
    expect(listToolNames(sasha)).toContain('get_lead_details');
  });

  it('get_crm_task_details appears only when the CRM bridge is configured, for any authenticated user', () => {
    // Off by default (no CRM env vars).
    expect(listToolNames(worker)).not.toContain('get_crm_task_details');
    expect(listToolNames(manager)).not.toContain('get_crm_task_details');

    process.env.CRM_API_BASE_URL = 'https://crm.example.com';
    process.env.CRM_SERVICE_JWT = 'jwt';
    // Gate is 'any' — workers and managers alike see it; ownership is enforced
    // inside the handler (verified in executor test below).
    expect(listToolNames(worker)).toContain('get_crm_task_details');
    expect(listToolNames(manager)).toContain('get_crm_task_details');
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

  it('get_lead_details with no lead_id and no hint → Hebrew "צריך..." error, no DB call', async () => {
    const res = await executeVoiceTool(manager, 'get_lead_details', {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('צריך lead_id או רמז לזיהוי הליד');
  });

  it('get_crm_task_details with no task_id → Hebrew "חסר מזהה משימה" error, no fetch', async () => {
    process.env.CRM_API_BASE_URL = 'https://crm.example.com';
    process.env.CRM_SERVICE_JWT = 'jwt';
    const res = await executeVoiceTool(worker, 'get_crm_task_details', {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('חסר מזהה משימה');
  });

  it('get_crm_task_details returns the not-found/no-access Hebrew line when the CRM answers non-2xx (or endpoint missing)', async () => {
    // crmFetch collapses 404, 403, and network failure into null. All three
    // read the same way to the user, and the message must NOT be a generic
    // "לא הצלחתי לקרוא..." — that would confuse a task that simply doesn't
    // exist / isn't accessible with a real CRM outage.
    process.env.CRM_API_BASE_URL = 'https://crm.example.com';
    process.env.CRM_SERVICE_JWT = 'jwt';
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":"not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    try {
      const res = await executeVoiceTool(worker, 'get_crm_task_details', { task_id: 'task-missing' });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('המשימה לא נמצאה או שאין לך גישה אליה');
      expect(res.detail).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('get_crm_task_details enforces ownership — a worker asking about someone else\'s task is rejected', async () => {
    // Security-critical: gate is 'any' by design, but the handler must reject
    // a non-elevated user asking about a task owned by a different user.
    process.env.CRM_API_BASE_URL = 'https://crm.example.com';
    process.env.CRM_SERVICE_JWT = 'jwt';
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'task-xyz', title: 'Someone else\'s task', description: 'secret',
        dueDate: null, priority: 'MEDIUM', status: 'OPEN',
        ownerId: 'someone-else', customerId: null, productName: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    try {
      const res = await executeVoiceTool(worker, 'get_crm_task_details', { task_id: 'task-xyz' });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('המשימה הזו לא שלך');
      // The full task payload must NOT leak into the result (defense-in-depth
      // read: even the detail key should be absent on rejection).
      expect(res.detail).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('get_crm_task_details returns detail when the task belongs to the worker', async () => {
    process.env.CRM_API_BASE_URL = 'https://crm.example.com';
    process.env.CRM_SERVICE_JWT = 'jwt';
    // The handler also does a small SELECT name for owner_name enrichment.
    query.mockResolvedValueOnce({ rows: [{ name: 'דני בודק' }], rowCount: 1 });
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'task-mine', title: 'שלי', description: 'התוכן המלא',
        dueDate: null, priority: 'HIGH', status: 'IN_PROGRESS',
        ownerId: worker.id, customerId: null, productName: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    try {
      const res = await executeVoiceTool(worker, 'get_crm_task_details', { task_id: 'task-mine' });
      expect(res.ok).toBe(true);
      // The full description (money field) is exposed on the owner's own task.
      expect((res.detail as Record<string, unknown>).description).toBe('התוכן המלא');
      expect((res.detail as Record<string, unknown>).owner_name).toBe('דני בודק');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('every execution is audited — including denials', async () => {
    await executeVoiceTool(worker, 'no_such_tool', {});
    const auditCall = query.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('VoiceToolCall'),
    );
    expect(auditCall).toBeTruthy();
  });

  it('get_my_inspections includes contact_name / contact_phone / notes_snippet per row (safety net vs the model answering from the list)', async () => {
    // Mock the getMyInspectionsInRange SELECT: two rows, one with all contact
    // fields filled, one with them all null. The mapper must include the keys
    // in both cases (a present null field is deliberate — the model must know
    // "no phone recorded" rather than assuming it wasn't fetched).
    query
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          {
            taskFieldId: 'tf-a', taskId: 't-a', customerName: 'לקוח א',
            taskTitle: 'בדיקת רעש', siteAddress: 'הרצל 5', siteCity: 'תל אביב',
            fieldContactName: 'משה אבו', fieldContactPhone: '972501231234',
            fieldNotes: 'להתקשר לפני שמגיעים, יש כלב בחצר וקוד לשער 4321',
            fieldStatus: 'CONFIRMED', family: 'noise', typeLabelHe: 'רעש',
            scheduledStartAt: new Date('2026-07-15T07:00:00Z'),
          },
          {
            taskFieldId: 'tf-b', taskId: 't-b', customerName: 'לקוח ב',
            taskTitle: 'בדיקת קרינה', siteAddress: null, siteCity: 'רמת גן',
            fieldContactName: null, fieldContactPhone: null, fieldNotes: null,
            fieldStatus: 'ASSIGNED', family: 'rad', typeLabelHe: 'קרינה',
            scheduledStartAt: new Date('2026-07-15T09:30:00Z'),
          },
        ],
      });

    const res = await executeVoiceTool(worker, 'get_my_inspections', {});
    expect(res.ok).toBe(true);
    const inspections = res.inspections as Array<Record<string, unknown>>;
    expect(inspections).toHaveLength(2);

    // Filled row — full contact info surfaced; long notes truncated to
    // snippet form (200 chars is far larger than the test string, so no
    // truncation ellipsis expected here — just the raw text).
    expect(inspections[0].contact_name).toBe('משה אבו');
    expect(inspections[0].contact_phone).toBe('972501231234');
    expect(inspections[0].notes_snippet).toBe(
      'להתקשר לפני שמגיעים, יש כלב בחצר וקוד לשער 4321',
    );
    expect(inspections[0].address).toBe('הרצל 5');

    // Empty row — keys present with explicit null so the model can say "אין
    // איש קשר רשום" instead of asking to fetch more.
    expect(inspections[1].contact_name).toBeNull();
    expect(inspections[1].contact_phone).toBeNull();
    expect(inspections[1].notes_snippet).toBeNull();
    expect(inspections[1].address).toBeNull();
  });

  it('get_my_inspections truncates long fieldNotes to 200 chars with an ellipsis', async () => {
    const longNote = 'א'.repeat(400);
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        taskFieldId: 'tf-c', taskId: 't-c', customerName: 'לקוח ג',
        taskTitle: null, siteAddress: null, siteCity: null,
        fieldContactName: null, fieldContactPhone: null, fieldNotes: longNote,
        fieldStatus: 'CONFIRMED', family: 'noise', typeLabelHe: 'רעש',
        scheduledStartAt: new Date('2026-07-15T07:00:00Z'),
      }],
    });

    const res = await executeVoiceTool(worker, 'get_my_inspections', {});
    expect(res.ok).toBe(true);
    const snippet = (res.inspections as Array<Record<string, unknown>>)[0].notes_snippet as string;
    // 200 chars + ellipsis (…, one char). The truncation prevents dumping
    // 2 KB of notes into a spoken response.
    expect(snippet).toHaveLength(201);
    expect(snippet.endsWith('…')).toBe(true);
  });
});

// ── get_my_tasks: unified "my tasks today" (all calendar + office due today) ───

/** An Outlook event at HH:00 local today. `subject` is passed through as-is. */
function calEvent(partial: { id: string; subject: string | null; location?: string | null; isAllDay?: boolean }) {
  return {
    id: partial.id,
    subject: partial.subject,
    start: { dateTime: '2026-07-15T07:00:00Z', timeZone: 'UTC' },
    end: { dateTime: '2026-07-15T08:00:00Z', timeZone: 'UTC' },
    location: partial.location ?? null,
    isOnlineMeeting: false,
    isAllDay: partial.isAllDay ?? false,
    webLink: null,
  };
}

/** A CRM calendar-list HTTP response ({events,count}) for the fetch mock. */
function calResponse(events: unknown[]): Response {
  return new Response(JSON.stringify({ events, count: events.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A "Task" row (what listTasks returns) with a dueDate `daysFromToday` away. */
function taskRow(id: string, title: string, daysFromToday: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return {
    id, title, description: null, dueDate: d, priority: 'MEDIUM', status: 'OPEN',
    type: 'GENERAL', createdAt: d, updatedAt: d, ownerId: 'w1',
    customerId: null, leadId: null, projectId: null,
    ownerName: 'דני בודק', customerName: null, leadName: null, projectName: null,
  };
}

function enableCrm(): void {
  process.env.CRM_API_BASE_URL = 'https://crm.example.com';
  process.env.CRM_SERVICE_JWT = 'jwt';
}

describe('get_my_tasks', () => {
  it('is available to every user, independent of the CRM bridge (office tasks come from the DB)', () => {
    // Office half is a direct DB read → the tool shows up even with no CRM env.
    expect(listToolNames(worker)).toContain('get_my_tasks');
    expect(listToolNames(manager)).toContain('get_my_tasks');
    enableCrm();
    expect(listToolNames(worker)).toContain('get_my_tasks');
  });

  it('combines ALL of today\'s calendar events (unfiltered) with office tasks due today; overdue at the end', async () => {
    enableCrm();
    // listTasks(today_overdue) mock: one due today, one overdue (5 days ago).
    query.mockResolvedValueOnce({
      rows: [taskRow('t-today', 'להתקשר לספק', 0), taskRow('t-late', 'לשלוח דוח', -5)],
      rowCount: 2,
    });
    // Calendar: a field inspection AND a regular meeting — BOTH must be kept.
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      calResponse([
        calEvent({ id: 'c1', subject: 'בדיקת קרינה עבור האוניברסיטה הפתוחה' }),
        calEvent({ id: 'c2', subject: 'פגישה עם רואה חשבון' }),
      ]),
    );
    try {
      const res = await executeVoiceTool(worker, 'get_my_tasks', {});
      expect(res.ok).toBe(true);
      // today = 2 calendar (unfiltered) + 1 office due today = 3
      expect(res.count).toBe(3);
      const tasks = res.tasks as Array<Record<string, unknown>>;
      expect(tasks).toHaveLength(3);
      // the regular meeting is NOT filtered out
      expect(tasks.some((t) => t.title === 'פגישה עם רואה חשבון')).toBe(true);
      expect(tasks.some((t) => t.title === 'בדיקת קרינה עבור האוניברסיטה הפתוחה')).toBe(true);
      // overdue is a SEPARATE bucket, read at the end
      expect(res.overdue_count).toBe(1);
      const overdue = res.overdue as Array<Record<string, unknown>>;
      expect(overdue[0].title).toBe('לשלוח דוח');
      // the spoken line mentions overdue LAST
      expect(res.speak).toBe('היום יש לך 3 משימות. בנוסף, 1 משימות באיחור.');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('works without the CRM bridge — office + overdue only, calendar skipped, no fetch', async () => {
    // No enableCrm() → crmApiConfigured()=false → the calendar read is skipped.
    query.mockResolvedValueOnce({ rows: [taskRow('t-today', 'משימת משרד', 0)], rowCount: 1 });
    const fetchSpy = vi.spyOn(global, 'fetch');
    const res = await executeVoiceTool(worker, 'get_my_tasks', {});
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1); // office only
    expect(fetchSpy).not.toHaveBeenCalled(); // calendar not attempted
    fetchSpy.mockRestore();
  });

  it('no tasks and empty calendar → the "no tasks today" line', async () => {
    enableCrm();
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(calResponse([]));
    try {
      const res = await executeVoiceTool(worker, 'get_my_tasks', {});
      expect(res.ok).toBe(true);
      expect(res.count).toBe(0);
      expect(res.overdue_count).toBe(0);
      expect(res.speak).toBe('אין לך משימות להיום.');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('a failed calendar read does not fail the tool — office tasks still return', async () => {
    enableCrm();
    query.mockResolvedValueOnce({ rows: [taskRow('t-today', 'משימת משרד', 0)], rowCount: 1 });
    // Outlook not connected → the CRM calendar endpoint 400s with a Hebrew error.
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"message":"חשבון Outlook אינו מחובר"}', {
        status: 400, headers: { 'Content-Type': 'application/json' },
      }),
    );
    try {
      const res = await executeVoiceTool(worker, 'get_my_tasks', {});
      expect(res.ok).toBe(true); // tool still succeeds
      expect(res.count).toBe(1); // office task survived the calendar failure
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
