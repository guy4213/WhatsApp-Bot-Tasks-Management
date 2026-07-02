/**
 * D2-T4 — dispatcher morning branch routing tests (name-based routing).
 *
 * Coverage:
 *  - Any non-Yoram user (SALES / MANAGER / ADMIN / WORKER) routes through
 *    getInspectionsForWorkerOnDate + formatInspectorMorning.
 *  - Per-day dedup preserved.
 *
 * The retired formatManagerMorning path is no longer imported — Yoram is
 * handled by galitManagerDispatcher.test.ts, everyone else gets inspector.
 *
 * Kept in its own file because `vi.mock('../whatsapp/digestContent', ...)` is
 * hoisted for the entire file — running it in the same file as the pure
 * formatter tests would replace the real function under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspectionListItem } from '../services/inspectionsQueries';

// ── Hoisted mock factories ────────────────────────────────────────────────────

const poolQueryMock = vi.hoisted(() => vi.fn());

const getInspectionsMock = vi.hoisted(() => vi.fn());
const getEquipmentChecklistMock = vi.hoisted(() => vi.fn());
const getEmployeeEndOfDayMock = vi.hoisted(() => vi.fn());

const formatInspectorMorningMock = vi.hoisted(() => vi.fn());
const formatEquipmentReminderMock = vi.hoisted(() => vi.fn());
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
  getFieldExceptionCounts: vi.fn(async () => ({
    finishedFieldToday: 0, notConfirmedToday: 0, hasProblemToday: 0,
    waitingForInfoToday: 0, notClosedDayToday: 0,
  })),
  getOpenFieldExceptions: vi.fn(async () => []),
}));
vi.mock('../services/incomingLeads', () => ({
  findOvernightUnassignedLeads: vi.fn(async () => []),
  findActiveInspectors: vi.fn(async () => []),
  getYoramLeadCounts: vi.fn(async () => ({ overnight: 0, unassigned: 0 })),
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
  digestTemplateKey: () => 'EMPLOYEE_MORNING_DIGEST',
}));
vi.mock('../whatsapp/sender', () => ({
  sendButtonMessage: sendButtonMessageMock,
  sendTextMessage:   vi.fn(async () => undefined),
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

describe('dispatcher morning branch — routing (D2-T4)', () => {
  const stubContent = { text: 't', params: [], buttons: [] };

  function rowFor(role: string) {
    return {
      user_id: 'u-1',
      user_name: 'דני', // NOT 'יורם' — this user is a regular worker
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
    formatEquipmentReminderMock.mockReturnValue({ text: 't', params: [], buttons: [] });
    getInspectionsMock.mockResolvedValue([]);
    getEquipmentChecklistMock.mockResolvedValue([]);
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

  it('SALES → formatInspectorMorning is called', async () => {
    const items: InspectionListItem[] = [
      {
        taskFieldId: 'tf-a', customerName: 'ל', siteAddress: 'א',
        siteCity: 'ר', fieldStatus: 'ASSIGNED', family: 'general',
        typeLabelHe: 'ט',
      },
    ];
    getInspectionsMock.mockResolvedValue(items);

    await fireMorning('SALES');

    expect(getInspectionsMock).toHaveBeenCalledWith('u-1', '2026-06-30');
    expect(formatInspectorMorningMock).toHaveBeenCalledTimes(1);
    expect(formatInspectorMorningMock).toHaveBeenCalledWith(items, { name: 'דני' });
    expect(claimDigestSendMock).toHaveBeenCalledWith('u-1', 'MORNING', '2026-06-30');
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('MANAGER → inspector morning fires (K1)', async () => {
    await fireMorning('MANAGER');
    expect(formatInspectorMorningMock).toHaveBeenCalledTimes(1);
  });

  it('ADMIN (not Yoram) → inspector morning fires (treated as worker)', async () => {
    await fireMorning('ADMIN');
    expect(formatInspectorMorningMock).toHaveBeenCalledTimes(1);
    expect(getInspectionsMock).toHaveBeenCalledTimes(2); // once for digest, once for equipment reminder
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('preserves per-day dedup — a false claim skips the send entirely', async () => {
    claimDigestSendMock.mockResolvedValueOnce(false);
    await fireMorning('SALES');
    expect(formatInspectorMorningMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
