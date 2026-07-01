/**
 * X-T5 — LEGACY_MANAGER_DIGEST_ENABLED gate for non-Yoram/non-Sasha ADMIN users.
 *
 * Coverage:
 *  - LEGACY_MANAGER_DIGEST_ENABLED unset (default) → ADMIN who is not Yoram
 *    and not Sasha is skipped early; claimDigestSend is NOT called; no notify.
 *  - LEGACY_MANAGER_DIGEST_ENABLED=true → legacy ADMIN path proceeds normally
 *    (formatManagerMorning / formatManagerEndOfDay called); claimDigestSend runs.
 *  - Yoram (matching YORAM_PHONE) is NOT blocked by the gate — handled by the
 *    Yoram branch in buildContent, but the key invariant is that the gate's
 *    isYoramRow check exempts him and claimDigestSend + notify fire for Yoram.
 *  - SASHA_PHONE set + matching row → Sasha continues past the per-user loop
 *    continuation and never reaches dispatchOne (gate is moot; no side effects).
 *  - Non-ADMIN (MANAGER role) is NOT gated regardless of flag.
 *
 * Kept separate from galitManagerDispatcher.test.ts to keep that file focused
 * on Yoram-branch routing; X-T5 flag semantics are tested here.
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
const getYoramLeadCountsMock = vi.hoisted(() => vi.fn());

const formatManagerMorningMock = vi.hoisted(() => vi.fn());
const formatManagerEndOfDayMock = vi.hoisted(() => vi.fn());
const formatGalitManagerMorningMock = vi.hoisted(() => vi.fn());
const formatGalitManagerEndOfDayMock = vi.hoisted(() => vi.fn());
const formatInspectorMorningMock = vi.hoisted(() => vi.fn());
const formatEmployeeEndOfDayMock = vi.hoisted(() => vi.fn());
const formatEquipmentReminderMock = vi.hoisted(() => vi.fn());
const formatSashaLeadsMorningMock = vi.hoisted(() => vi.fn());

const notifyMock = vi.hoisted(() => vi.fn(async () => undefined));
const sendButtonMessageMock = vi.hoisted(() => vi.fn(async () => undefined));
const sendTextMessageMock = vi.hoisted(() => vi.fn(async () => undefined));
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
  formatSashaLeadsMorning: formatSashaLeadsMorningMock,
  digestTemplateKey: () => 'MANAGER_MORNING_DIGEST',
}));
vi.mock('../whatsapp/sender', () => ({
  sendButtonMessage: sendButtonMessageMock,
  sendTextMessage: sendTextMessageMock,
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

// ── Helpers ────────────────────────────────────────────────────────────────────

const STUB_CONTENT = { text: 't', params: [], buttons: [] };

const YORAM_DB_PHONE  = '972501234567';
const YORAM_ENV_PHONE = '050-123-4567';
const SASHA_DB_PHONE  = '972509876543';
const SASHA_ENV_PHONE = '050-987-6543';
const OTHER_ADMIN_PHONE = '972509111111';

function rowFor(opts: {
  role: string;
  phone: string;
  hm?: string;
  morning?: boolean;
  evening?: boolean;
}) {
  return {
    user_id:         'u-admin',
    user_name:       'מנהל',
    user_phone:      opts.phone,
    role:            opts.role,
    morning_enabled: opts.morning ?? true,
    morning_time:    '08:00',
    evening_enabled: opts.evening ?? false,
    evening_time:    '17:00',
    local_hm:        opts.hm ?? '08:00',
    local_date:      '2026-07-01',
  };
}

async function fire(row: Record<string, unknown>): Promise<void> {
  poolQueryMock.mockResolvedValueOnce({ rows: [row] });
  const dispatcher = await import('../scheduler/jobs/digestDispatcher');
  await dispatcher.runDigestDispatcher();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('X-T5 — LEGACY_MANAGER_DIGEST_ENABLED gate', () => {
  beforeEach(() => {
    // Default stub returns for all formatters.
    formatManagerMorningMock.mockReturnValue(STUB_CONTENT);
    formatManagerEndOfDayMock.mockReturnValue(STUB_CONTENT);
    formatGalitManagerMorningMock.mockReturnValue(STUB_CONTENT);
    formatGalitManagerEndOfDayMock.mockReturnValue(STUB_CONTENT);
    formatInspectorMorningMock.mockReturnValue(STUB_CONTENT);
    formatEmployeeEndOfDayMock.mockReturnValue(STUB_CONTENT);
    formatEquipmentReminderMock.mockReturnValue({ text: '', params: [], buttons: [] });
    formatSashaLeadsMorningMock.mockReturnValue(STUB_CONTENT);
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
      finishedFieldToday: 0, notConfirmedToday: 0, hasProblemToday: 0,
      waitingForInfoToday: 0, notClosedDayToday: 0,
    });
    getOpenFieldExceptionsMock.mockResolvedValue([]);
    getYoramLeadCountsMock.mockResolvedValue({ overnight: 0, unassigned: 0 });
    claimDigestSendMock.mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.YORAM_PHONE;
    delete process.env.SASHA_PHONE;
    delete process.env.LEGACY_MANAGER_DIGEST_ENABLED;
    vi.clearAllMocks();
  });

  // ── Flag OFF (default) — non-Yoram/non-Sasha ADMIN is blocked ──

  it('flag unset — non-Yoram/non-Sasha ADMIN MORNING is skipped; claimDigestSend NOT called', async () => {
    process.env.YORAM_PHONE = YORAM_ENV_PHONE;
    // LEGACY_MANAGER_DIGEST_ENABLED not set → defaults to off.
    await fire(rowFor({ role: 'ADMIN', phone: OTHER_ADMIN_PHONE, hm: '08:00' }));

    expect(claimDigestSendMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(formatManagerMorningMock).not.toHaveBeenCalled();
  });

  it('flag set to "false" — non-Yoram/non-Sasha ADMIN MORNING is skipped', async () => {
    process.env.YORAM_PHONE = YORAM_ENV_PHONE;
    process.env.LEGACY_MANAGER_DIGEST_ENABLED = 'false';
    await fire(rowFor({ role: 'ADMIN', phone: OTHER_ADMIN_PHONE, hm: '08:00' }));

    expect(claimDigestSendMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  // ── Flag ON — non-Yoram/non-Sasha ADMIN proceeds normally ──

  it('flag "true" — non-Yoram/non-Sasha ADMIN MORNING proceeds; claimDigestSend + formatManagerMorning called', async () => {
    process.env.YORAM_PHONE = YORAM_ENV_PHONE;
    process.env.LEGACY_MANAGER_DIGEST_ENABLED = 'true';
    await fire(rowFor({ role: 'ADMIN', phone: OTHER_ADMIN_PHONE, hm: '08:00' }));

    expect(claimDigestSendMock).toHaveBeenCalledWith('u-admin', 'MORNING', '2026-07-01');
    expect(formatManagerMorningMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  // ── Yoram is NOT blocked by the gate (flag is moot for him) ──

  it('Yoram row — NOT blocked by the gate regardless of flag state; Galit formatter fires', async () => {
    process.env.YORAM_PHONE = YORAM_ENV_PHONE;
    // Gate is off, but Yoram is exempt.
    await fire(rowFor({ role: 'ADMIN', phone: YORAM_DB_PHONE, hm: '08:00' }));

    // Claim must have been made for Yoram.
    expect(claimDigestSendMock).toHaveBeenCalledWith('u-admin', 'MORNING', '2026-07-01');
    expect(formatGalitManagerMorningMock).toHaveBeenCalledTimes(1);
    expect(formatManagerMorningMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  // ── Sasha ADMIN row — blocked by continue in the loop, never reaches dispatchOne ──

  it('Sasha row — never reaches dispatchOne (continue in loop); gate is moot; no MORNING/EVENING claimed', async () => {
    process.env.SASHA_PHONE = SASHA_ENV_PHONE;
    // Sasha's row at 09:30 → only LEADS_MORNING fires. At 08:00, nothing fires.
    await fire(rowFor({ role: 'ADMIN', phone: SASHA_DB_PHONE, hm: '08:00' }));

    // Sasha's leads morning fires at 09:30 only; at 08:00 no digest fires.
    expect(claimDigestSendMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(sendTextMessageMock).not.toHaveBeenCalled();
  });

  // ── MANAGER role (non-ADMIN) — NOT gated by the flag ──

  it('MANAGER role — NOT gated; flag is irrelevant; morning digest proceeds normally', async () => {
    // MANAGER is not ADMIN, so the X-T5 gate's `row.role === "ADMIN"` check does not fire.
    // MANAGER rows fall through to the inspector path (role !== 'ADMIN' check), but
    // since we are testing the gate logic we only care that notify fires.
    await fire(rowFor({ role: 'MANAGER', phone: OTHER_ADMIN_PHONE, hm: '08:00' }));

    // MANAGER gets inspector morning (D2-T4: role !== 'ADMIN').
    expect(claimDigestSendMock).toHaveBeenCalledWith('u-admin', 'MORNING', '2026-07-01');
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  // ── YORAM_PHONE unset — legacy path applies; gate matters ──

  it('YORAM_PHONE unset + flag off → non-Yoram ADMIN blocked', async () => {
    // No YORAM_PHONE; LEGACY gate is off.
    await fire(rowFor({ role: 'ADMIN', phone: OTHER_ADMIN_PHONE, hm: '08:00' }));

    expect(claimDigestSendMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('YORAM_PHONE unset + flag on → non-Yoram ADMIN proceeds to legacy formatManagerMorning', async () => {
    process.env.LEGACY_MANAGER_DIGEST_ENABLED = 'true';
    await fire(rowFor({ role: 'ADMIN', phone: OTHER_ADMIN_PHONE, hm: '08:00' }));

    expect(claimDigestSendMock).toHaveBeenCalledWith('u-admin', 'MORNING', '2026-07-01');
    expect(formatManagerMorningMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
