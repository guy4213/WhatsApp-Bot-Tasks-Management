/**
 * D4-T1 — dispatcher Yoram-branch routing tests.
 *
 * Coverage:
 *  - YORAM_PHONE matches the row's phone → formatGalitManagerMorning /
 *    formatGalitManagerEndOfDay is called AND the exceptions queries fire;
 *    legacy formatManagerMorning / formatManagerEndOfDay are NOT called.
 *  - YORAM_PHONE unset → legacy paths preserved (ADMIN → formatManagerMorning /
 *    formatManagerEndOfDay), no exception queries fire.
 *  - Non-Yoram ADMIN with YORAM_PHONE set → still routes to legacy path.
 *
 * Kept in its own file because `vi.mock('../whatsapp/digestContent', ...)` is
 * hoisted for the whole file — running it alongside the pure formatter tests
 * would replace the real function under test in the other suite.
 *
 * Mirrors the mock shape of `inspectorMorningDispatcher.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mock factories ────────────────────────────────────────────────────

const poolQueryMock = vi.hoisted(() => vi.fn());

const getInspectionsMock = vi.hoisted(() => vi.fn());
const getEquipmentChecklistMock = vi.hoisted(() => vi.fn());
const getCompanyMorningMock = vi.hoisted(() => vi.fn());
const getCompanyEndOfDayMock = vi.hoisted(() => vi.fn());
const getEmployeeEndOfDayMock = vi.hoisted(() => vi.fn());

const getFieldExceptionCountsMock = vi.hoisted(() => vi.fn());
const getOpenFieldExceptionsMock = vi.hoisted(() => vi.fn());

const formatInspectorMorningMock = vi.hoisted(() => vi.fn());
const formatManagerMorningMock = vi.hoisted(() => vi.fn());
const formatEquipmentReminderMock = vi.hoisted(() => vi.fn());
const formatManagerEndOfDayMock = vi.hoisted(() => vi.fn());
const formatEmployeeEndOfDayMock = vi.hoisted(() => vi.fn());
const formatGalitManagerMorningMock = vi.hoisted(() => vi.fn());
const formatGalitManagerEndOfDayMock = vi.hoisted(() => vi.fn());

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
vi.mock('../services/exceptionsQueries', () => ({
  getFieldExceptionCounts: getFieldExceptionCountsMock,
  getOpenFieldExceptions:  getOpenFieldExceptionsMock,
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
  formatGalitManagerMorning: formatGalitManagerMorningMock,
  formatGalitManagerEndOfDay: formatGalitManagerEndOfDayMock,
  digestTemplateKey: () => 'MANAGER_MORNING_DIGEST',
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

describe('dispatcher — Yoram branch routing (D4-T1)', () => {
  const stubContent = { text: 't', params: [], buttons: [] };

  // Yoram's phone in the DB — stored as normalized 12-digit.
  const YORAM_DB_PHONE = '972501234567';
  // Env value uses a common Israeli local-format equivalent; normalization
  // must reconcile them.
  const YORAM_ENV_PHONE = '050-123-4567';

  function rowFor(opts: {
    role: string;
    phone: string;
    hm?: string;
    morning?: boolean;
    evening?: boolean;
  }) {
    return {
      user_id:         'u-yoram',
      user_name:       'יורם',
      user_phone:      opts.phone,
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
    formatManagerMorningMock.mockReturnValue(stubContent);
    formatEquipmentReminderMock.mockReturnValue({ text: 't', params: [], buttons: [] });
    formatManagerEndOfDayMock.mockReturnValue(stubContent);
    formatEmployeeEndOfDayMock.mockReturnValue(stubContent);
    formatGalitManagerMorningMock.mockReturnValue(stubContent);
    formatGalitManagerEndOfDayMock.mockReturnValue(stubContent);
    getInspectionsMock.mockResolvedValue([]);
    getEquipmentChecklistMock.mockResolvedValue([]);
    getCompanyMorningMock.mockResolvedValue({
      dueToday: 0, overdue: 0, open: 0, employeesWithOverdue: 0, employees: [],
    });
    getCompanyEndOfDayMock.mockResolvedValue({
      dueToday: 0, completed: 0, notCompleted: 0, overdue: 0, openCarry: 0,
      employeesWithUnfinishedOrOverdue: 0, employees: [],
    });
    getEmployeeEndOfDayMock.mockResolvedValue({
      dueToday: 0, completed: 0, notCompleted: 0, overdue: 0, openCarry: 0, unfinishedTitles: [],
    });
    getFieldExceptionCountsMock.mockResolvedValue({
      finishedFieldToday: 8, notConfirmedToday: 1, hasProblemToday: 2,
      waitingForInfoToday: 3, notClosedDayToday: 1,
    });
    getOpenFieldExceptionsMock.mockResolvedValue([]);
    claimDigestSendMock.mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.YORAM_PHONE;
    vi.clearAllMocks();
  });

  async function fire(row: Record<string, unknown>): Promise<void> {
    poolQueryMock.mockResolvedValueOnce({ rows: [row] });
    const dispatcher = await import('../scheduler/jobs/digestDispatcher');
    await dispatcher.runDigestDispatcher();
  }

  // ── YORAM_PHONE match ──

  it('MORNING — YORAM_PHONE matches → formatGalitManagerMorning fires; legacy ADMIN + inspector formatters are NOT called', async () => {
    process.env.YORAM_PHONE = YORAM_ENV_PHONE;

    await fire(rowFor({ role: 'ADMIN', phone: YORAM_DB_PHONE, hm: '08:00', evening: false }));

    expect(getFieldExceptionCountsMock).toHaveBeenCalledWith('2026-06-30');
    expect(getOpenFieldExceptionsMock).toHaveBeenCalledWith('2026-06-30');
    expect(formatGalitManagerMorningMock).toHaveBeenCalledTimes(1);
    // Body shape: { counts, exceptions, user: { name } }.
    const call = formatGalitManagerMorningMock.mock.calls[0][0];
    expect(call.user).toEqual({ name: 'יורם' });
    expect(call.counts.finishedFieldToday).toBe(8);
    expect(Array.isArray(call.exceptions)).toBe(true);
    // Legacy and inspector formatters must NOT have run.
    expect(formatManagerMorningMock).not.toHaveBeenCalled();
    expect(formatInspectorMorningMock).not.toHaveBeenCalled();
    expect(getCompanyMorningMock).not.toHaveBeenCalled();
    expect(getInspectionsMock).not.toHaveBeenCalled();
    // D2-T9: Yoram (ADMIN with matching phone) is redirected to the exceptions
    // digest instead of the inspector morning; equipment reminder MUST NOT
    // fire for him (see the `isYoram` guard in the dispatcher).
    expect(formatEquipmentReminderMock).not.toHaveBeenCalled();
    expect(sendButtonMessageMock).not.toHaveBeenCalled();
    // Dedup ledger consulted + notify fired.
    expect(claimDigestSendMock).toHaveBeenCalledWith('u-yoram', 'MORNING', '2026-06-30');
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('EVENING — YORAM_PHONE matches → formatGalitManagerEndOfDay fires; formatManagerEndOfDay is NOT called', async () => {
    process.env.YORAM_PHONE = YORAM_ENV_PHONE;

    await fire(rowFor({ role: 'ADMIN', phone: YORAM_DB_PHONE, hm: '17:00', morning: false }));

    expect(formatGalitManagerEndOfDayMock).toHaveBeenCalledTimes(1);
    const call = formatGalitManagerEndOfDayMock.mock.calls[0][0];
    expect(call.user).toEqual({ name: 'יורם' });
    expect(formatManagerEndOfDayMock).not.toHaveBeenCalled();
    expect(getCompanyEndOfDayMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  // ── YORAM_PHONE unset — legacy paths preserved ──

  it('MORNING — YORAM_PHONE unset → ADMIN falls through to formatManagerMorning (legacy path preserved)', async () => {
    // No YORAM_PHONE in the env.
    await fire(rowFor({ role: 'ADMIN', phone: YORAM_DB_PHONE, hm: '08:00', evening: false }));

    expect(formatGalitManagerMorningMock).not.toHaveBeenCalled();
    expect(getFieldExceptionCountsMock).not.toHaveBeenCalled();
    expect(getOpenFieldExceptionsMock).not.toHaveBeenCalled();
    expect(formatManagerMorningMock).toHaveBeenCalledTimes(1);
    expect(getCompanyMorningMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('EVENING — YORAM_PHONE unset → ADMIN falls through to formatManagerEndOfDay', async () => {
    await fire(rowFor({ role: 'ADMIN', phone: YORAM_DB_PHONE, hm: '17:00', morning: false }));

    expect(formatGalitManagerEndOfDayMock).not.toHaveBeenCalled();
    expect(formatManagerEndOfDayMock).toHaveBeenCalledTimes(1);
    expect(getCompanyEndOfDayMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('MORNING — YORAM_PHONE empty string → treated as unset; legacy path runs', async () => {
    process.env.YORAM_PHONE = '   ';
    await fire(rowFor({ role: 'ADMIN', phone: YORAM_DB_PHONE, hm: '08:00', evening: false }));
    expect(formatGalitManagerMorningMock).not.toHaveBeenCalled();
    expect(formatManagerMorningMock).toHaveBeenCalledTimes(1);
  });

  // ── Non-Yoram ADMIN with YORAM_PHONE set ──

  it('MORNING — different ADMIN phone with YORAM_PHONE set → still routes to legacy formatManagerMorning', async () => {
    process.env.YORAM_PHONE = YORAM_ENV_PHONE;
    // Different admin: same 972 prefix, different suffix.
    await fire(rowFor({ role: 'ADMIN', phone: '972509999999', hm: '08:00', evening: false }));

    expect(formatGalitManagerMorningMock).not.toHaveBeenCalled();
    expect(getFieldExceptionCountsMock).not.toHaveBeenCalled();
    expect(formatManagerMorningMock).toHaveBeenCalledTimes(1);
  });

  it('MORNING — non-ADMIN (MANAGER) whose phone matches YORAM_PHONE → Yoram branch STILL wins (K3 is per-user, not per-role)', async () => {
    process.env.YORAM_PHONE = YORAM_ENV_PHONE;
    await fire(rowFor({ role: 'MANAGER', phone: YORAM_DB_PHONE, hm: '08:00', evening: false }));

    expect(formatGalitManagerMorningMock).toHaveBeenCalledTimes(1);
    // Inspector morning branch (D2-T4) must not have run for this row.
    expect(formatInspectorMorningMock).not.toHaveBeenCalled();
    expect(getInspectionsMock).not.toHaveBeenCalled();
  });

  it('claimDigestSend false → no formatter runs (dedup preserved)', async () => {
    process.env.YORAM_PHONE = YORAM_ENV_PHONE;
    claimDigestSendMock.mockResolvedValueOnce(false);
    await fire(rowFor({ role: 'ADMIN', phone: YORAM_DB_PHONE, hm: '08:00', evening: false }));
    expect(formatGalitManagerMorningMock).not.toHaveBeenCalled();
    expect(formatManagerMorningMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
