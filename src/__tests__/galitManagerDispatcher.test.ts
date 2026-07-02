/**
 * D4-T1 — dispatcher Yoram-branch routing tests.
 *
 * Yoram is identified by User.name === 'יורם' (see specialUsers.ts). No env
 * vars, no phone normalization — the DB row's name is the routing key.
 *
 * Coverage:
 *  - User.name = 'יורם' → formatGalitManagerMorning / formatGalitManagerEndOfDay
 *    is called AND the exceptions queries fire; inspector formatter is NOT.
 *  - User.name != 'יורם' → inspector morning fires (K1: everyone else is a
 *    field worker regardless of role — no more legacy manager digest).
 *  - Equipment reminder is suppressed for Yoram; fires for everyone else.
 *  - claimDigestSend false → no formatter runs.
 *
 * Kept in its own file because `vi.mock('../whatsapp/digestContent', ...)` is
 * hoisted for the whole file — running it alongside the pure formatter tests
 * would replace the real function under test in the other suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mock factories ────────────────────────────────────────────────────

const poolQueryMock = vi.hoisted(() => vi.fn());

const getInspectionsMock = vi.hoisted(() => vi.fn());
const getEquipmentChecklistMock = vi.hoisted(() => vi.fn());
const getEmployeeEndOfDayMock = vi.hoisted(() => vi.fn());

const getFieldExceptionCountsMock = vi.hoisted(() => vi.fn());
const getOpenFieldExceptionsMock = vi.hoisted(() => vi.fn());
const getYoramLeadCountsMock = vi.hoisted(() => vi.fn());

const formatInspectorMorningMock = vi.hoisted(() => vi.fn());
const formatEquipmentReminderMock = vi.hoisted(() => vi.fn());
const formatEmployeeEndOfDayMock = vi.hoisted(() => vi.fn());
const formatGalitManagerMorningMock = vi.hoisted(() => vi.fn());
const formatGalitManagerEndOfDayMock = vi.hoisted(() => vi.fn());

const sendButtonMessageMock = vi.hoisted(() => vi.fn(async () => undefined));
const sendTextMessageMock = vi.hoisted(() => vi.fn(async () => undefined));

const notifyMock = vi.hoisted(() => vi.fn(async () => undefined));
const claimDigestSendMock = vi.hoisted(() => vi.fn(async () => true));
const markDigestFailedMock = vi.hoisted(() => vi.fn(async () => undefined));
const writeAuditLogMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../db/connection', () => ({
  pool: { query: poolQueryMock },
  supabaseAdmin: {},
}));
vi.mock('../services/inspectionsQueries', () => ({
  getInspectionsForWorkerOnDate: getInspectionsMock,
  getEquipmentChecklistForFamilies: getEquipmentChecklistMock,
}));
vi.mock('../services/exceptionsQueries', () => ({
  getFieldExceptionCounts: getFieldExceptionCountsMock,
  getOpenFieldExceptions:  getOpenFieldExceptionsMock,
}));
vi.mock('../services/incomingLeads', () => ({
  findOvernightUnassignedLeads: vi.fn(async () => []),
  findActiveInspectors: vi.fn(async () => []),
  getYoramLeadCounts: getYoramLeadCountsMock,
}));
vi.mock('../ai/leadSuggester', () => ({
  suggestWorkerForLead: vi.fn(async () => ({ userId: null, reason: 'לא נמצאה התאמה' })),
}));
vi.mock('../services/tasks', () => ({
  getEmployeeEndOfDay: getEmployeeEndOfDayMock,
}));
vi.mock('../whatsapp/digestContent', () => ({
  formatInspectorMorning: formatInspectorMorningMock,
  formatEquipmentReminder: formatEquipmentReminderMock,
  formatEmployeeEndOfDay: formatEmployeeEndOfDayMock,
  formatGalitManagerMorning: formatGalitManagerMorningMock,
  formatGalitManagerEndOfDay: formatGalitManagerEndOfDayMock,
  digestTemplateKey: () => 'MANAGER_MORNING_DIGEST',
}));
vi.mock('../whatsapp/sender', () => ({
  sendButtonMessage: sendButtonMessageMock,
  sendTextMessage:   sendTextMessageMock,
  sendListMessage:   vi.fn(async () => undefined),
}));
vi.mock('../whatsapp/templates', () => ({
  notify: notifyMock,
}));
vi.mock('../services/digestSendLog', () => ({
  claimDigestSend: claimDigestSendMock,
  markDigestFailed: markDigestFailedMock,
}));
vi.mock('../utils/auditLog', () => ({
  writeAuditLog: writeAuditLogMock,
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('dispatcher — Yoram branch routing (D4-T1, name-based)', () => {
  const stubContent = { text: 't', params: [], buttons: [] };

  function rowFor(opts: {
    name: string;
    role: string;
    hm?: string;
    morning?: boolean;
    evening?: boolean;
  }) {
    return {
      user_id:         `u-${opts.name}`,
      user_name:       opts.name,
      user_phone:      '972501234567',
      role:            opts.role,
      morning_enabled: opts.morning ?? true,
      morning_time:    '08:00',
      evening_enabled: opts.evening ?? true,
      evening_time:    '17:00',
      local_hm:        opts.hm ?? '08:00',
      local_date:      '2026-06-30',
    };
  }

  beforeEach(() => {
    formatInspectorMorningMock.mockReturnValue(stubContent);
    formatEquipmentReminderMock.mockReturnValue({ text: 't', params: [], buttons: [] });
    formatEmployeeEndOfDayMock.mockReturnValue(stubContent);
    formatGalitManagerMorningMock.mockReturnValue(stubContent);
    formatGalitManagerEndOfDayMock.mockReturnValue(stubContent);
    getInspectionsMock.mockResolvedValue([]);
    getEquipmentChecklistMock.mockResolvedValue([]);
    getEmployeeEndOfDayMock.mockResolvedValue({
      dueToday: 0, completed: 0, notCompleted: 0, overdue: 0, openCarry: 0, unfinishedTitles: [],
    });
    getFieldExceptionCountsMock.mockResolvedValue({
      finishedFieldToday: 8, notConfirmedToday: 1, hasProblemToday: 2,
      waitingForInfoToday: 3, notClosedDayToday: 1,
    });
    getOpenFieldExceptionsMock.mockResolvedValue([]);
    getYoramLeadCountsMock.mockResolvedValue({ overnight: 4, unassigned: 2 });
    claimDigestSendMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function fire(row: Record<string, unknown>): Promise<void> {
    poolQueryMock.mockResolvedValueOnce({ rows: [row] });
    const dispatcher = await import('../scheduler/jobs/digestDispatcher');
    await dispatcher.runDigestDispatcher();
  }

  // ── Yoram (by name) match ──

  it('MORNING — User.name = "יורם" → formatGalitManagerMorning fires; inspector formatter is NOT called', async () => {
    await fire(rowFor({ name: 'יורם', role: 'ADMIN', hm: '08:00', evening: false }));

    expect(getFieldExceptionCountsMock).toHaveBeenCalledWith('2026-06-30');
    expect(getOpenFieldExceptionsMock).toHaveBeenCalledWith('2026-06-30');
    expect(getYoramLeadCountsMock).toHaveBeenCalledWith('2026-06-30');
    expect(formatGalitManagerMorningMock).toHaveBeenCalledTimes(1);
    const call = formatGalitManagerMorningMock.mock.calls[0][0];
    expect(call.user).toEqual({ name: 'יורם' });
    expect(call.counts.finishedFieldToday).toBe(8);
    expect(Array.isArray(call.exceptions)).toBe(true);
    expect(call.leadCounts).toEqual({ overnight: 4, unassigned: 2 });
    // Inspector formatter must NOT have run.
    expect(formatInspectorMorningMock).not.toHaveBeenCalled();
    expect(getInspectionsMock).not.toHaveBeenCalled();
    // Equipment reminder MUST NOT fire for Yoram.
    expect(formatEquipmentReminderMock).not.toHaveBeenCalled();
    expect(sendButtonMessageMock).not.toHaveBeenCalled();
    // Dedup + notify fired.
    expect(claimDigestSendMock).toHaveBeenCalledWith('u-יורם', 'MORNING', '2026-06-30');
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('EVENING — User.name = "יורם" → formatGalitManagerEndOfDay fires; formatEmployeeEndOfDay is NOT called', async () => {
    await fire(rowFor({ name: 'יורם', role: 'ADMIN', hm: '17:00', morning: false }));

    expect(formatGalitManagerEndOfDayMock).toHaveBeenCalledTimes(1);
    const call = formatGalitManagerEndOfDayMock.mock.calls[0][0];
    expect(call.user).toEqual({ name: 'יורם' });
    expect(call.leadCounts).toEqual({ overnight: 4, unassigned: 2 });
    expect(formatEmployeeEndOfDayMock).not.toHaveBeenCalled();
    expect(getEmployeeEndOfDayMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  // ── Other exceptions viewers (dev admins) ──

  it('MORNING — "גיא פרנסס" (dev admin) → §13 exceptions digest fires', async () => {
    await fire(rowFor({ name: 'גיא פרנסס', role: 'ADMIN', hm: '08:00', evening: false }));

    expect(formatGalitManagerMorningMock).toHaveBeenCalledTimes(1);
    expect(formatInspectorMorningMock).not.toHaveBeenCalled();
  });

  it('EVENING — "יאיר" (dev admin) → §13 exceptions eod fires', async () => {
    await fire(rowFor({ name: 'יאיר', role: 'ADMIN', hm: '17:00', morning: false }));

    expect(formatGalitManagerEndOfDayMock).toHaveBeenCalledTimes(1);
    expect(formatEmployeeEndOfDayMock).not.toHaveBeenCalled();
  });

  // ── Fix B: dev admins who are both LeadsViewer+ExceptionsViewer → Galit only ──
  //
  // Regression guard: גיא פרנסס and יאיר are in BOTH LEADS_VIEWER_NAMES and
  // EXCEPTIONS_VIEWER_NAMES. Before the fix they received two morning messages
  // at 09:30: one via dispatchSashaLeadsMorning (sendTextMessage path) and one
  // via dispatchOne → formatGalitManagerMorning (notify path). After the fix
  // only the Galit digest is sent.

  it('09:30 — "גיא פרנסס" (both LeadsViewer+ExceptionsViewer) → only Galit digest, NOT Sasha leads morning', async () => {
    // Row at 09:30 — the time that would previously also trigger dispatchSashaLeadsMorning.
    // morning_time = '09:30' so isDigestDue('09:30', '09:30') = true for MORNING as well.
    const guyRow = {
      ...rowFor({ name: 'גיא פרנסס', role: 'ADMIN', hm: '09:30', evening: false, morning: true }),
      morning_time: '09:30',
    };
    poolQueryMock.mockResolvedValueOnce({ rows: [guyRow] });
    const dispatcher = await import('../scheduler/jobs/digestDispatcher');
    await dispatcher.runDigestDispatcher();

    // Galit digest must fire (via notify).
    expect(formatGalitManagerMorningMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    // Sasha leads path (sendTextMessage) must NOT fire.
    expect(sendTextMessageMock).not.toHaveBeenCalled();
    // Inspector formatter must not run either.
    expect(formatInspectorMorningMock).not.toHaveBeenCalled();
  });

  it('09:30 — "יאיר" (both LeadsViewer+ExceptionsViewer) → only Galit digest, NOT Sasha leads morning', async () => {
    const yairRow = {
      ...rowFor({ name: 'יאיר', role: 'ADMIN', hm: '09:30', evening: false, morning: true }),
      morning_time: '09:30',
    };
    poolQueryMock.mockResolvedValueOnce({ rows: [yairRow] });
    const dispatcher = await import('../scheduler/jobs/digestDispatcher');
    await dispatcher.runDigestDispatcher();

    expect(formatGalitManagerMorningMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(sendTextMessageMock).not.toHaveBeenCalled();
    expect(formatInspectorMorningMock).not.toHaveBeenCalled();
  });

  // ── Regular users (not in any special set) → inspector treatment ──

  it('MORNING — regular MANAGER → inspector morning fires', async () => {
    await fire(rowFor({ name: 'דני', role: 'MANAGER', hm: '08:00', evening: false }));

    expect(formatInspectorMorningMock).toHaveBeenCalledTimes(1);
    expect(formatGalitManagerMorningMock).not.toHaveBeenCalled();
    // Two calls to getInspections: inspector digest + equipment reminder.
    expect(getInspectionsMock).toHaveBeenCalledTimes(2);
  });

  it('MORNING — regular WORKER → inspector morning fires (baseline unchanged)', async () => {
    await fire(rowFor({ name: 'ראובן', role: 'WORKER', hm: '08:00', evening: false }));

    expect(formatInspectorMorningMock).toHaveBeenCalledTimes(1);
  });

  // ── Dedup preserved ──

  it('claimDigestSend false → no formatter runs (dedup preserved)', async () => {
    claimDigestSendMock.mockResolvedValueOnce(false);
    await fire(rowFor({ name: 'יורם', role: 'ADMIN', hm: '08:00', evening: false }));

    expect(formatGalitManagerMorningMock).not.toHaveBeenCalled();
    expect(formatInspectorMorningMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
