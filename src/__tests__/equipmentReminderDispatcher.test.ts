/**
 * D2-T9 — dispatcher equipment-reminder tests.
 *
 * Coverage:
 *  - Inspector row with inspections today → equipment checklist loaded,
 *    formatter called, `sendButtonMessage` fired, dedup row claimed.
 *  - Inspector row with NO inspections today → no send, no formatter call.
 *  - ADMIN row → equipment reminder skipped entirely (K1 branch guard).
 *  - Yoram row (phone matches YORAM_PHONE) → equipment reminder skipped
 *    (D4-T1 exceptions digest is what Yoram gets, not an inspector reminder).
 *  - `EQUIPMENT_MORNING` claim already taken → no send.
 *  - Getting the checklist returns [] → no send.
 *
 * Kept in its own file — same rationale as `inspectorMorningDispatcher.test.ts`:
 * `vi.mock('../whatsapp/digestContent', ...)` is hoisted and would replace
 * the real formatter if this ran alongside the pure formatter tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EquipmentChecklistItem,
  InspectionListItem,
} from '../services/inspectionsQueries';

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
const claimDigestSendMock = vi.hoisted(() => vi.fn());
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
vi.mock('../services/incomingLeads', () => ({
  findOvernightUnassignedLeads: vi.fn(async () => []),
  findActiveInspectors: vi.fn(async () => []),
  getYoramLeadCounts: vi.fn(async () => ({ overnight: 0, unassigned: 0 })),
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

describe('dispatcher — equipment reminder (D2-T9)', () => {
  const stubInspector = { text: 'inspector', params: [], buttons: [] };
  const stubEquipment = {
    text: 'equipment body',
    params: [],
    buttons: [
      { id: 'EQUIP_ALL_x_2026-06-30', title: 'לקחתי הכל' },
      { id: 'EQUIP_MISSING_x_2026-06-30', title: 'חסר לי ציוד' },
    ],
  };

  const oneInspection: InspectionListItem = {
    taskFieldId: 'tf-a', customerName: 'ל', siteAddress: 'א',
    siteCity: 'ר', fieldStatus: 'ASSIGNED', family: 'radiation',
    typeLabelHe: 'ט',
  };
  const checklistRows: EquipmentChecklistItem[] = [
    { family: 'radiation', code: 'elf_meter', labelHe: 'מד ELF', isRequired: true, sortOrder: 1 },
  ];

  function rowFor(role: string, phone = '972500000000') {
    return {
      user_id: 'u-1',
      user_name: 'דני',
      user_phone: phone,
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
    formatInspectorMorningMock.mockReturnValue(stubInspector);
    formatManagerMorningMock.mockReturnValue(stubInspector);
    formatEquipmentReminderMock.mockReturnValue(stubEquipment);
    getInspectionsMock.mockResolvedValue([]);
    getEquipmentChecklistMock.mockResolvedValue([]);
    getCompanyMorningMock.mockResolvedValue({
      dueToday: 0, overdue: 0, open: 0, employeesWithOverdue: 0, employees: [],
    });
    // Default: both claim attempts (MORNING + EQUIPMENT_MORNING) succeed.
    claimDigestSendMock.mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.YORAM_PHONE;
    delete process.env.LEGACY_MANAGER_DIGEST_ENABLED;
    vi.clearAllMocks();
  });

  async function fireMorning(row: Record<string, unknown>): Promise<void> {
    poolQueryMock.mockResolvedValueOnce({ rows: [row] });
    const dispatcher = await import('../scheduler/jobs/digestDispatcher');
    await dispatcher.runDigestDispatcher();
  }

  it('inspector with inspections today → equipment reminder fires with sendButtonMessage', async () => {
    getInspectionsMock.mockResolvedValue([oneInspection]);
    getEquipmentChecklistMock.mockResolvedValue(checklistRows);

    await fireMorning(rowFor('SALES'));

    // MORNING claim + EQUIPMENT_MORNING claim.
    expect(claimDigestSendMock).toHaveBeenCalledWith('u-1', 'MORNING', '2026-06-30');
    expect(claimDigestSendMock).toHaveBeenCalledWith('u-1', 'EQUIPMENT_MORNING', '2026-06-30');
    // Families deduped in the dispatcher, passed to the query.
    expect(getEquipmentChecklistMock).toHaveBeenCalledWith(['radiation']);
    // Formatter received the checklist + the user context (id + name + date).
    expect(formatEquipmentReminderMock).toHaveBeenCalledTimes(1);
    const fmtCall = formatEquipmentReminderMock.mock.calls[0] as unknown as [
      EquipmentChecklistItem[],
      { id: string; name: string | null; localDate: string },
    ];
    expect(fmtCall[0]).toEqual(checklistRows);
    expect(fmtCall[1]).toEqual({ id: 'u-1', name: 'דני', localDate: '2026-06-30' });
    // sendButtonMessage fired with the formatter's body + buttons.
    expect(sendButtonMessageMock).toHaveBeenCalledTimes(1);
    const callArgs = sendButtonMessageMock.mock.calls[0] as unknown as [{
      to: string; body: string; buttons: Array<{ id: string; title: string }>;
    }];
    const btnArg = callArgs[0];
    expect(btnArg.to).toBe('972500000000');
    expect(btnArg.body).toBe('equipment body');
    expect(btnArg.buttons).toEqual(stubEquipment.buttons);
  });

  it('inspector with NO inspections today → equipment reminder skipped (no formatter, no send)', async () => {
    getInspectionsMock.mockResolvedValue([]);

    await fireMorning(rowFor('SALES'));

    // Equipment claim is still made (dedup ledger) but the send is skipped
    // once we see the empty inspections list.
    expect(claimDigestSendMock).toHaveBeenCalledWith('u-1', 'EQUIPMENT_MORNING', '2026-06-30');
    expect(getEquipmentChecklistMock).not.toHaveBeenCalled();
    expect(formatEquipmentReminderMock).not.toHaveBeenCalled();
    expect(sendButtonMessageMock).not.toHaveBeenCalled();
  });

  it('inspector with inspections but empty checklist rows → send skipped', async () => {
    getInspectionsMock.mockResolvedValue([oneInspection]);
    getEquipmentChecklistMock.mockResolvedValue([]);

    await fireMorning(rowFor('SALES'));

    expect(getEquipmentChecklistMock).toHaveBeenCalledWith(['radiation']);
    expect(formatEquipmentReminderMock).not.toHaveBeenCalled();
    expect(sendButtonMessageMock).not.toHaveBeenCalled();
  });

  it('ADMIN row + flag on → equipment reminder never fires (K1 branch guard); MORNING claim made, EQUIPMENT_MORNING not', async () => {
    // X-T5: LEGACY_MANAGER_DIGEST_ENABLED must be true so the ADMIN reaches the claim step.
    process.env.LEGACY_MANAGER_DIGEST_ENABLED = 'true';
    getInspectionsMock.mockResolvedValue([oneInspection]);
    getEquipmentChecklistMock.mockResolvedValue(checklistRows);

    await fireMorning(rowFor('ADMIN'));

    // Only the ADMIN MORNING claim; EQUIPMENT_MORNING is never even attempted.
    expect(claimDigestSendMock).toHaveBeenCalledWith('u-1', 'MORNING', '2026-06-30');
    expect(claimDigestSendMock).not.toHaveBeenCalledWith('u-1', 'EQUIPMENT_MORNING', '2026-06-30');
    expect(getEquipmentChecklistMock).not.toHaveBeenCalled();
    expect(formatEquipmentReminderMock).not.toHaveBeenCalled();
    expect(sendButtonMessageMock).not.toHaveBeenCalled();
  });

  it('Yoram (matching YORAM_PHONE) → equipment reminder skipped', async () => {
    process.env.YORAM_PHONE = '972500000000';
    getInspectionsMock.mockResolvedValue([oneInspection]);
    getEquipmentChecklistMock.mockResolvedValue(checklistRows);

    await fireMorning(rowFor('MANAGER', '972500000000'));

    expect(claimDigestSendMock).not.toHaveBeenCalledWith('u-1', 'EQUIPMENT_MORNING', '2026-06-30');
    expect(formatEquipmentReminderMock).not.toHaveBeenCalled();
    expect(sendButtonMessageMock).not.toHaveBeenCalled();
  });

  it('EQUIPMENT_MORNING claim returns false → no send (already sent this local day)', async () => {
    getInspectionsMock.mockResolvedValue([oneInspection]);
    getEquipmentChecklistMock.mockResolvedValue(checklistRows);
    // MORNING claim: true. EQUIPMENT_MORNING claim: false (already sent).
    claimDigestSendMock.mockImplementation(async (_uid, type: string) =>
      type === 'EQUIPMENT_MORNING' ? false : true,
    );

    await fireMorning(rowFor('SALES'));

    expect(getEquipmentChecklistMock).not.toHaveBeenCalled();
    expect(formatEquipmentReminderMock).not.toHaveBeenCalled();
    expect(sendButtonMessageMock).not.toHaveBeenCalled();
  });

  it('dedupes families before hitting the DB (2 inspections in same family → one lookup)', async () => {
    getInspectionsMock.mockResolvedValue([
      { ...oneInspection, taskFieldId: 'tf-a', family: 'radiation' },
      { ...oneInspection, taskFieldId: 'tf-b', family: 'radiation' },
      { ...oneInspection, taskFieldId: 'tf-c', family: 'noise' },
    ]);
    getEquipmentChecklistMock.mockResolvedValue(checklistRows);

    await fireMorning(rowFor('SALES'));

    // Families argument must be deduped (order not asserted — depends on Set
    // iteration; assert size + contents).
    const families = getEquipmentChecklistMock.mock.calls[0][0];
    expect(new Set(families)).toEqual(new Set(['radiation', 'noise']));
    expect(families).toHaveLength(2);
  });
});
