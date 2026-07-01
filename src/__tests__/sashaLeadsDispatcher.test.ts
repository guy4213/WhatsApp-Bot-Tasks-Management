/**
 * D3-T2 / D4-T2 — Sasha routing in digestDispatcher.
 *
 * Verifies: phone-match → LEADS_MORNING at 09:30; non-09:30 → no send;
 * Sasha gets no MORNING/EVENING; non-Sasha phone falls through to normal path.
 *
 * NOTE: vi.mock on digestContent must NOT replace the real formatters for the
 * formatter suite. This file uses a separate mock approach that only stubs the
 * formatters the dispatcher needs, leaving the pure formatter untouched in the
 * formatter test file. (Same split used for galitManagerDispatcher.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../../src/db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

// Mock the sender — only sendTextMessage matters here; sendButtonMessage for equipment
const sendTextMessage = vi.fn().mockResolvedValue(undefined);
const sendButtonMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: (...a: unknown[]) => sendButtonMessage(...a),
}));

// Mock notify — used by dispatchOne (normal MORNING/EVENING)
const notify = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/templates', () => ({
  notify: (...a: unknown[]) => notify(...a),
}));

// Stub digest content — return safe minimal output so dispatchOne doesn't fail
vi.mock('../whatsapp/digestContent', async (importOriginal) => {
  const real = await importOriginal<typeof import('../whatsapp/digestContent')>();
  return {
    ...real,
    formatSashaLeadsMorning: vi.fn().mockReturnValue({ text: 'leads text', params: ['', '0'], buttons: [] }),
    formatInspectorMorning: vi.fn().mockReturnValue({ text: 'insp text', params: [], buttons: [] }),
    formatManagerMorning:   vi.fn().mockReturnValue({ text: 'mgr text',  params: [], buttons: [] }),
    formatManagerEndOfDay:  vi.fn().mockReturnValue({ text: 'eod text',  params: [], buttons: [] }),
    formatEmployeeEndOfDay: vi.fn().mockReturnValue({ text: 'eod2 text', params: [], buttons: [] }),
    formatGalitManagerMorning: vi.fn().mockReturnValue({ text: 'yoram', params: [], buttons: [] }),
    formatGalitManagerEndOfDay: vi.fn().mockReturnValue({ text: 'yoram eod', params: [], buttons: [] }),
    formatEquipmentReminder:    vi.fn().mockReturnValue({ text: '', params: [], buttons: [] }),
  };
});

// Stub AI and incomingLeads so Sasha dispatch doesn't require real DB
vi.mock('../services/incomingLeads', () => ({
  findOvernightUnassignedLeads: vi.fn().mockResolvedValue([]),
  findActiveInspectors:         vi.fn().mockResolvedValue([]),
}));
vi.mock('../ai/leadSuggester', () => ({
  suggestWorkerForLead: vi.fn().mockResolvedValue({ userId: null, reason: 'לא נמצאה התאמה' }),
}));

// Stub writeAuditLog
vi.mock('../utils/auditLog', () => ({ writeAuditLog: vi.fn().mockResolvedValue({ id: 'audit-1' }) }));

// Stub inspectionsQueries and exceptionsQueries
vi.mock('../services/inspectionsQueries', () => ({
  getInspectionsForWorkerOnDate:       vi.fn().mockResolvedValue([]),
  getEquipmentChecklistForFamilies:    vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/exceptionsQueries', () => ({
  getFieldExceptionCounts: vi.fn().mockResolvedValue({ finishedFieldToday: 0, notConfirmedToday: 0, hasProblemToday: 0, waitingForInfoToday: 0, notClosedDayToday: 0 }),
  getOpenFieldExceptions:  vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/tasks', () => ({
  getEmployeeEndOfDay: vi.fn().mockResolvedValue({}),
  getCompanyMorning:   vi.fn().mockResolvedValue({ dueToday: 0, overdue: 0, open: 0, employeesWithOverdue: 0, employees: [] }),
  getCompanyEndOfDay:  vi.fn().mockResolvedValue({ dueToday: 0, completed: 0, notCompleted: 0, overdue: 0, openCarry: 0, employeesWithUnfinishedOrOverdue: 0, employees: [] }),
}));

beforeEach(() => {
  poolQuery.mockReset();
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue(undefined);
  notify.mockReset();
  notify.mockResolvedValue(undefined);
  delete process.env.SASHA_PHONE;
  delete process.env.YORAM_PHONE;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SASHA_PHONE;
  delete process.env.YORAM_PHONE;
});

import { runDigestDispatcher } from '../scheduler/jobs/digestDispatcher';

const SASHA_PHONE = '972509999999';
const OTHER_PHONE = '972501111111';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'u-sasha',
    user_name: 'שי',
    user_phone: SASHA_PHONE,
    role: 'MANAGER',
    morning_enabled: true,
    morning_time: '08:00',
    evening_enabled: true,
    evening_time: '17:00',
    local_hm: '09:30',
    local_date: '2026-07-01',
    ...overrides,
  };
}

// claimDigestSend INSERT-first
const CLAIM_GRANTED = { rowCount: 1, rows: [{ userId: 'u-sasha' }] };
const CLAIM_DENIED  = { rowCount: 0, rows: [] };

describe('Sasha leads morning dispatcher', () => {
  it('sends LEADS_MORNING at 09:30 when phone matches SASHA_PHONE', async () => {
    process.env.SASHA_PHONE = SASHA_PHONE;
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] }) // selectDigestCandidates
      .mockResolvedValueOnce(CLAIM_GRANTED); // claimDigestSend LEADS_MORNING

    await runDigestDispatcher();

    expect(sendTextMessage).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled(); // no MORNING/EVENING for Sasha
  });

  it('does NOT send LEADS_MORNING when not in 09:30 window', async () => {
    process.env.SASHA_PHONE = SASHA_PHONE;
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [makeRow({ local_hm: '08:05' })] });

    await runDigestDispatcher();

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    // only selectDigestCandidates was called
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('skips send when claim is already taken (dedup)', async () => {
    process.env.SASHA_PHONE = SASHA_PHONE;
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] }) // selectDigestCandidates
      .mockResolvedValueOnce(CLAIM_DENIED); // claimDigestSend → already claimed

    await runDigestDispatcher();

    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('routes non-Sasha phone to normal MORNING path', async () => {
    process.env.SASHA_PHONE = SASHA_PHONE;
    // Use morning_time '09:30' so isDigestDue('09:30', '09:30') = true
    const normalRow = makeRow({
      user_id: 'u-other',
      user_phone: OTHER_PHONE,
      role: 'WORKER',
      morning_time: '09:30',
    });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [normalRow] }) // selectDigestCandidates
      .mockResolvedValueOnce(CLAIM_GRANTED) // claimDigestSend MORNING
      .mockResolvedValueOnce(CLAIM_DENIED); // claimDigestSend EQUIPMENT_MORNING → denied, skip equipment

    await runDigestDispatcher();

    // Normal path uses notify(), not sendTextMessage
    expect(notify).toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('does not send LEADS_MORNING when SASHA_PHONE is unset', async () => {
    const row = makeRow();
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [row] }); // selectDigestCandidates
    // morningDue = isDigestDue('08:00', '09:30') → false (row has morning_time 08:00, local 09:30)
    // eveningDue = isDigestDue('17:00', '09:30') → false
    await runDigestDispatcher();

    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});
