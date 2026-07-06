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
  sendTextMessage:   (...a: unknown[]) => sendTextMessage(...a),
  sendButtonMessage: (...a: unknown[]) => sendButtonMessage(...a),
  sendListMessage:   vi.fn().mockResolvedValue(undefined),
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

// Stub AI and incomingLeads so Sasha dispatch doesn't require real DB.
// getYoramLeadCounts is also mocked so ExceptionsViewer rows (גיא פרנסס, יאיר)
// can reach formatGalitManagerMorning without a real DB call.
vi.mock('../services/incomingLeads', () => ({
  findOvernightUnassignedLeads: vi.fn().mockResolvedValue([]),
  findActiveInspectors:         vi.fn().mockResolvedValue([]),
  getYoramLeadCounts:           vi.fn().mockResolvedValue({ overnight: 0, unassigned: 0 }),
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
});
afterEach(() => {
  vi.restoreAllMocks();
});

import { runDigestDispatcher } from '../scheduler/jobs/digestDispatcher';

const SASHA_PHONE = '972509999999';
const OTHER_PHONE = '972501111111';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'u-sasha',
    user_name: 'סשה', // routing key — must match SASHA_NAME in specialUsers.ts
    user_phone: SASHA_PHONE,
    role: 'ADMIN',
    morning_enabled: true,
    morning_time: '08:00',
    evening_enabled: true,
    evening_time: '17:00',
    local_hm: '09:30',
    local_date: '2026-07-01',
    ...overrides,
  };
}

// isDigestAlreadySent / isLeadNotificationSent read (SELECT 1 ...) — same
// shape as the old claim INSERT's result, just semantically "already sent?".
const ALREADY_SENT = { rowCount: 1, rows: [{ userId: 'u-sasha' }] };
const NOT_SENT      = { rowCount: 0, rows: [] };
// claimDigestSend INSERT — called only AFTER a successful send; its return
// value isn't asserted on by these tests, so any shape works.
const CLAIM_GRANTED = { rowCount: 1, rows: [{ userId: 'u-sasha' }] };

describe('Sasha leads morning dispatcher', () => {
  it('sends LEADS_MORNING at 09:30 when User.name = "סשה"', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] }) // selectDigestCandidates
      .mockResolvedValueOnce(NOT_SENT)      // isDigestAlreadySent LEADS_MORNING → not sent
      .mockResolvedValueOnce(CLAIM_GRANTED); // claimDigestSend LEADS_MORNING (after successful send)

    await runDigestDispatcher();

    expect(sendTextMessage).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled(); // no MORNING/EVENING for Sasha
  });

  it('does NOT send LEADS_MORNING when not in 09:30 window', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [makeRow({ local_hm: '08:05' })] });

    await runDigestDispatcher();

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    // only selectDigestCandidates was called
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('skips send when already sent today (dedup)', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] }) // selectDigestCandidates
      .mockResolvedValueOnce(ALREADY_SENT); // isDigestAlreadySent → already sent

    await runDigestDispatcher();

    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('does NOT record as sent when the WhatsApp send fails (retry next tick)', async () => {
    sendTextMessage.mockRejectedValueOnce(new Error('WhatsApp API error'));
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] }) // selectDigestCandidates
      .mockResolvedValueOnce(NOT_SENT); // isDigestAlreadySent LEADS_MORNING → not sent

    await runDigestDispatcher();

    expect(sendTextMessage).toHaveBeenCalledOnce();
    // Only 2 pool calls happened — no INSERT (claimDigestSend) after a failed send.
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });

  it('routes non-Sasha name to normal MORNING path', async () => {
    // Use morning_time '09:30' so isDigestDue('09:30', '09:30') = true
    const normalRow = makeRow({
      user_id: 'u-other',
      user_name: 'דני',
      user_phone: OTHER_PHONE,
      role: 'WORKER',
      morning_time: '09:30',
    });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [normalRow] }) // selectDigestCandidates
      .mockResolvedValueOnce(NOT_SENT)       // isDigestAlreadySent MORNING → not sent
      .mockResolvedValueOnce(CLAIM_GRANTED)  // claimDigestSend MORNING (after successful send)
      .mockResolvedValueOnce(ALREADY_SENT);  // isDigestAlreadySent EQUIPMENT_MORNING → already sent, skip equipment

    await runDigestDispatcher();

    // Normal path uses notify(), not sendTextMessage
    expect(notify).toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  // ── Fix B: dev observer in both LEADS_VIEWER_NAMES + EXCEPTIONS_VIEWER_NAMES ──
  //
  // Before the fix: גיא פרנסס at 09:30 received BOTH dispatchSashaLeadsMorning
  // (sendTextMessage) AND dispatchOne→formatGalitManagerMorning (notify).
  // After the fix: only the Galit digest fires (ExceptionsViewer takes priority).

  it('at 09:30 — "גיא פרנסס" (LeadsViewer AND ExceptionsViewer) does NOT receive Sasha leads morning', async () => {
    // גיא is in BOTH LEADS_VIEWER_NAMES and EXCEPTIONS_VIEWER_NAMES.
    // With morning_time = '09:30' the MORNING digest is due and will dispatch
    // the Galit digest (ExceptionsViewer path). The LeadsViewer branch must
    // be skipped because isExceptionsViewer is also true.
    const guyRow = makeRow({
      user_id: 'u-guy',
      user_name: 'גיא פרנסס',
      user_phone: OTHER_PHONE,
      role: 'ADMIN',
      morning_time: '09:30', // MORNING due at 09:30 (same window as local_hm)
    });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [guyRow] }) // selectDigestCandidates
      .mockResolvedValueOnce(NOT_SENT)      // isDigestAlreadySent MORNING → not sent
      .mockResolvedValueOnce(CLAIM_GRANTED); // claimDigestSend MORNING (Galit path, after successful send)

    await runDigestDispatcher();

    // Sasha leads path must NOT have fired.
    expect(sendTextMessage).not.toHaveBeenCalled();
    // Galit digest fires via notify().
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('at 09:30 — "יאיר" (LeadsViewer AND ExceptionsViewer) does NOT receive Sasha leads morning', async () => {
    const yairRow = makeRow({
      user_id: 'u-yair',
      user_name: 'יאיר',
      user_phone: OTHER_PHONE,
      role: 'ADMIN',
      morning_time: '09:30', // Galit digest fires at 09:30
    });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [yairRow] }) // selectDigestCandidates
      .mockResolvedValueOnce(NOT_SENT)      // isDigestAlreadySent MORNING → not sent
      .mockResolvedValueOnce(CLAIM_GRANTED); // claimDigestSend MORNING (after successful send)

    await runDigestDispatcher();

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('at 09:30 — pure "סשה" (LeadsViewer only, NOT ExceptionsViewer) still receives Sasha leads morning', async () => {
    // Sasha IS in LEADS_VIEWER_NAMES but NOT in EXCEPTIONS_VIEWER_NAMES.
    // She should still receive dispatchSashaLeadsMorning (sendTextMessage path)
    // and nothing else (the continue after her branch skips MORNING/EVENING).
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [makeRow()] }) // selectDigestCandidates
      .mockResolvedValueOnce(NOT_SENT)      // isDigestAlreadySent LEADS_MORNING → not sent
      .mockResolvedValueOnce(CLAIM_GRANTED); // claimDigestSend LEADS_MORNING (after successful send)

    await runDigestDispatcher();

    expect(sendTextMessage).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled(); // no MORNING/EVENING for Sasha
  });
});
