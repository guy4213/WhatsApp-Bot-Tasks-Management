/**
 * D2-T4 — dispatcher morning branch routing tests.
 *
 * Coverage:
 *  - non-ADMIN user → getInspectionsForWorkerOnDate + formatInspectorMorning
 *    is called (formatManagerMorning is NOT).
 *  - MANAGER (K1 says role !== 'ADMIN' == inspector) also routes to the
 *    inspector formatter.
 *  - ADMIN user → formatManagerMorning is called (inspector path NOT taken).
 *
 * X-T3 (2026-07-01): the retired `formatEmployeeMorning` / `getEmployeeMorning
 * Counts` mocks were removed — those helpers no longer exist.
 *
 * Kept in its own file because `vi.mock('../whatsapp/digestContent', ...)` is
 * hoisted for the entire file — running it in the same file as the pure
 * formatter tests would replace the real function under test.
 *
 * The pg `pool` is mocked so `selectDigestCandidates` returns the fixture row
 * we drive; `notify`, `claimDigestSend`, `writeAuditLog` are stubbed so the
 * dispatch flow reaches `buildContent` without side effects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspectionListItem } from '../services/inspectionsQueries';

// ── Hoisted mock factories ────────────────────────────────────────────────────

const poolQueryMock = vi.hoisted(() => vi.fn());

const getInspectionsMock = vi.hoisted(() => vi.fn());
const getEquipmentChecklistMock = vi.hoisted(() => vi.fn());
const getCompanyMorningMock = vi.hoisted(() => vi.fn());
const getCompanyEndOfDayMock = vi.hoisted(() => vi.fn());
const getEmployeeEndOfDayMock = vi.hoisted(() => vi.fn());

const formatInspectorMorningMock = vi.hoisted(() => vi.fn());
const formatManagerMorningMock = vi.hoisted(() => vi.fn());
const formatEquipmentReminderMock = vi.hoisted(() => vi.fn());
const formatManagerEndOfDayMock = vi.hoisted(() => vi.fn());
const formatEmployeeEndOfDayMock = vi.hoisted(() => vi.fn());

const sendButtonMessageMock = vi.hoisted(() => vi.fn(async () => undefined));

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
vi.mock('../services/tasks', () => ({
  getCompanyMorning: getCompanyMorningMock,
  getCompanyEndOfDay: getCompanyEndOfDayMock,
  getEmployeeEndOfDay: getEmployeeEndOfDayMock,
}));
vi.mock('../whatsapp/digestContent', () => ({
  formatInspectorMorning: formatInspectorMorningMock,
  formatManagerMorning: formatManagerMorningMock,
  formatEquipmentReminder: formatEquipmentReminderMock,
  formatManagerEndOfDay: formatManagerEndOfDayMock,
  formatEmployeeEndOfDay: formatEmployeeEndOfDayMock,
  digestTemplateKey: () => 'EMPLOYEE_MORNING_DIGEST',
}));
vi.mock('../whatsapp/sender', () => ({
  sendButtonMessage: sendButtonMessageMock,
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

describe('dispatcher morning branch — role routing (D2-T4)', () => {
  const stubContent = { text: 't', params: [], buttons: [] };

  function rowFor(role: string) {
    return {
      user_id: 'u-1',
      user_name: 'דני',
      user_phone: '972500000000',
      role,
      morning_enabled: true,
      morning_time: '08:00',
      evening_enabled: false,
      evening_time: '17:00',
      local_hm: '08:00',
      local_date: '2026-06-30',
    };
  }

  beforeEach(() => {
    formatInspectorMorningMock.mockReturnValue(stubContent);
    formatManagerMorningMock.mockReturnValue(stubContent);
    formatEquipmentReminderMock.mockReturnValue({ text: 't', params: [], buttons: [] });
    getInspectionsMock.mockResolvedValue([]);
    getEquipmentChecklistMock.mockResolvedValue([]);
    getCompanyMorningMock.mockResolvedValue({
      dueToday: 0, overdue: 0, open: 0, employeesWithOverdue: 0, employees: [],
    });
    claimDigestSendMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function fireMorning(role: string): Promise<void> {
    poolQueryMock.mockResolvedValueOnce({ rows: [rowFor(role)] });
    const dispatcher = await import('../scheduler/jobs/digestDispatcher');
    await dispatcher.runDigestDispatcher();
  }

  it('non-ADMIN (SALES) → formatInspectorMorning is called; formatManagerMorning is NOT', async () => {
    const items: InspectionListItem[] = [
      {
        taskFieldId: 'tf-a', customerName: 'ל', siteAddress: 'א',
        siteCity: 'ר', fieldStatus: 'ASSIGNED', family: 'general',
        typeLabelHe: 'ט',
      },
    ];
    // getInspectionsForWorkerOnDate is called twice per inspector morning:
    // once by buildContent (inspector digest) and once by
    // maybeDispatchEquipmentReminder (equipment reminder). Return the same
    // list on every call.
    getInspectionsMock.mockResolvedValue(items);

    await fireMorning('SALES');

    expect(getInspectionsMock).toHaveBeenCalledWith('u-1', '2026-06-30');
    expect(formatInspectorMorningMock).toHaveBeenCalledTimes(1);
    expect(formatInspectorMorningMock).toHaveBeenCalledWith(items, { name: 'דני' });
    expect(formatManagerMorningMock).not.toHaveBeenCalled();
    // Dedup ledger was consulted (inspector morning) and the send fired.
    expect(claimDigestSendMock).toHaveBeenCalledWith('u-1', 'MORNING', '2026-06-30');
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('MANAGER (non-ADMIN) also routes through the inspector formatter — K1', async () => {
    // K1: rule is `role !== 'ADMIN'`, so MANAGER is treated as an inspector
    // for the morning path. Sasha's leads digest is D3-T2 (out of D2-T4 scope).
    await fireMorning('MANAGER');
    expect(formatInspectorMorningMock).toHaveBeenCalledTimes(1);
    expect(formatManagerMorningMock).not.toHaveBeenCalled();
  });

  it('ADMIN → legacy formatManagerMorning path; inspector formatter NOT called', async () => {
    await fireMorning('ADMIN');
    expect(formatManagerMorningMock).toHaveBeenCalledTimes(1);
    expect(getCompanyMorningMock).toHaveBeenCalledTimes(1);
    expect(formatInspectorMorningMock).not.toHaveBeenCalled();
    expect(getInspectionsMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('preserves per-day dedup — a false claim skips the send entirely', async () => {
    claimDigestSendMock.mockResolvedValueOnce(false);
    await fireMorning('SALES');
    expect(formatInspectorMorningMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
