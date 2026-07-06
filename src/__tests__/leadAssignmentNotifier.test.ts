/**
 * D3-T3 + D3-T4 — leadAssignmentNotifier polling job.
 *
 * Dedup check (isLeadNotificationSent, a plain SELECT) now runs BEFORE the
 * WhatsApp send; the ledger row (claimLeadNotification, an INSERT) is only
 * written AFTER the send actually succeeds — never before. A failed send
 * leaves no row, so the next tick retries instead of silently skipping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage:   (...args: unknown[]) => sendTextMessage(...args),
  sendButtonMessage: vi.fn(),
  sendListMessage:   vi.fn().mockResolvedValue(undefined),
}));

const suggestWorkerForLead = vi.fn();
vi.mock('../ai/leadSuggester', () => ({
  suggestWorkerForLead: (...args: unknown[]) => suggestWorkerForLead(...args),
}));

const getLeadsViewerPhones = vi.fn();
vi.mock('../services/specialUsers', () => ({
  getLeadsViewerPhones: (...args: unknown[]) => getLeadsViewerPhones(...args),
}));

beforeEach(() => {
  poolQuery.mockReset();
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue(undefined);
  suggestWorkerForLead.mockReset();
  suggestWorkerForLead.mockResolvedValue({ userId: null, reason: 'לא נמצאה התאמה' });
  getLeadsViewerPhones.mockReset();
  getLeadsViewerPhones.mockResolvedValue([]); // default: no viewers configured
});
afterEach(() => {
  vi.restoreAllMocks();
});

import { runLeadAssignmentNotifier } from '../scheduler/jobs/leadAssignmentNotifier';

const EMPTY = { rowCount: 0, rows: [] };
// isLeadNotificationSent (SELECT) result shapes.
const NOT_SENT = { rowCount: 0, rows: [] };
const ALREADY_SENT = { rowCount: 1, rows: [{ leadId: 'x' }] };
// claimLeadNotification (INSERT, called only after a successful send).
const CLAIMED = { rowCount: 1, rows: [{ leadId: 'x' }] };

function makeAssignedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lead-aaa',
    subject: 'בדיקת קרינה',
    body: 'פרטים',
    fromName: 'דוד לוי',
    fromEmail: 'david@test.com',
    receivedAt: new Date(),
    status: 'NEW',
    ownerId: 'u-1',
    taskId: null,
    workerId: 'u-1',
    workerPhone: '972501111111',
    workerName: 'דני',
    ...overrides,
  };
}

function makeEscalationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lead-bbb',
    subject: 'שאלה',
    body: 'שאלת לקוח',
    fromName: 'משה',
    fromEmail: 'moshe@test.com',
    receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    status: 'NEW',
    ownerId: null,
    taskId: null,
    ...overrides,
  };
}

// ── D3-T3: worker assignment alerts ──────────────────────────────────────────

describe('D3-T3 worker assignment alert', () => {
  it('checks dedup, sends to worker phone, then records as sent', async () => {
    const row = makeAssignedRow();
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findNewlyAssignedLeads
      .mockResolvedValueOnce(NOT_SENT)   // isLeadNotificationSent ASSIGNED_TO_WORKER → not sent
      .mockResolvedValueOnce(CLAIMED);   // claimLeadNotification (after successful send)

    await runLeadAssignmentNotifier();

    // Dedup check ran BEFORE the send.
    const checkCall = poolQuery.mock.calls[1];
    expect(checkCall[0]).toMatch(/SELECT 1 FROM "WhatsappLeadNotification"/);
    expect(checkCall[1]).toContain('ASSIGNED_TO_WORKER');
    // The claim INSERT ran AFTER the send.
    const claimCall = poolQuery.mock.calls[2];
    expect(claimCall[0]).toMatch(/INSERT INTO "WhatsappLeadNotification"/);
    expect(claimCall[1]).toContain('ASSIGNED_TO_WORKER');

    // sendTextMessage was called for the worker
    expect(sendTextMessage).toHaveBeenCalledOnce();
    const [msg] = sendTextMessage.mock.calls[0];
    expect(msg.to).toBe('972501111111');
    expect(msg.text).toContain('ליד חדש שויך אליך');
    expect(msg.text).toContain('דוד לוי');
    expect(msg.text).toContain('לטיפול ועדכון ב-CRM');
  });

  it('skips send when already sent (dedup)', async () => {
    const row = makeAssignedRow();
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findNewlyAssignedLeads
      .mockResolvedValueOnce(ALREADY_SENT);                // isLeadNotificationSent → already sent

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('skips send when worker has no phone, and records it as handled (no re-log every tick)', async () => {
    const row = makeAssignedRow({ workerPhone: null });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findNewlyAssignedLeads
      .mockResolvedValueOnce(NOT_SENT)                     // isLeadNotificationSent → not sent
      .mockResolvedValueOnce(CLAIMED);                     // claimLeadNotification (no-phone → recorded as handled)

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).not.toHaveBeenCalled();
    const claimCall = poolQuery.mock.calls[2];
    expect(claimCall[0]).toMatch(/INSERT INTO "WhatsappLeadNotification"/);
  });

  it('does NOT record as sent when the WhatsApp send fails (retry next tick)', async () => {
    const row = makeAssignedRow();
    sendTextMessage.mockRejectedValueOnce(new Error('send failed'));
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findNewlyAssignedLeads
      .mockResolvedValueOnce(NOT_SENT);                    // isLeadNotificationSent → not sent

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).toHaveBeenCalledOnce();
    // No further pool.query call (no claim INSERT) after the failed send.
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });

  it('continues loop on per-lead send failure', async () => {
    const rowA = makeAssignedRow({ id: 'lead-a', fromName: 'ראשון' });
    const rowB = makeAssignedRow({ id: 'lead-b', fromName: 'שני' });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 2, rows: [rowA, rowB] }) // findNewlyAssignedLeads
      .mockResolvedValueOnce(NOT_SENT) // isLeadNotificationSent lead-a → not sent
      // send A fails below → no claim call for lead-a
      .mockResolvedValueOnce(NOT_SENT) // isLeadNotificationSent lead-b → not sent
      .mockResolvedValueOnce(CLAIMED); // claimLeadNotification lead-b (send succeeds)

    sendTextMessage
      .mockRejectedValueOnce(new Error('send A failed'))
      .mockResolvedValueOnce(undefined);

    await runLeadAssignmentNotifier();

    // Both rows were attempted despite A failing.
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
  });

  it('short-circuits when no newly assigned leads', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY); // findNewlyAssignedLeads
    // SASHA_PHONE not set → escalation skipped without querying
    await runLeadAssignmentNotifier();
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });
});

// ── D3-T4: Sasha escalation ───────────────────────────────────────────────────

describe('D3-T4 Sasha escalation', () => {
  beforeEach(() => {
    getLeadsViewerPhones.mockResolvedValue(['972509999999']);
  });

  it('checks dedup, sends to Sasha with AI suggestion, then records as sent', async () => {
    const row = makeEscalationRow();
    suggestWorkerForLead.mockResolvedValue({ userId: 'u-1', reason: 'מתמחה בקרינה' });

    poolQuery
      .mockResolvedValueOnce(EMPTY)  // findNewlyAssignedLeads
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] })  // findEscalationCandidates
      // findActiveInspectors runs before the dedup check
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'u-1', name: 'דני', role: 'WORKER' }] })
      .mockResolvedValueOnce(NOT_SENT)  // isLeadNotificationSent ESCALATED_1H → not sent
      .mockResolvedValueOnce(CLAIMED);  // claimLeadNotification (after successful send)

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).toHaveBeenCalledOnce();
    const [msg] = sendTextMessage.mock.calls[0];
    expect(msg.to).toBe('972509999999');
    expect(msg.text).toContain('ליד ממתין לשיבוץ');
    expect(msg.text).toContain('משה');
    expect(msg.text).toContain('לשיבוץ ב-CRM');
  });

  it('sends "no match" suggestion when AI returns null userId', async () => {
    const row = makeEscalationRow();
    suggestWorkerForLead.mockResolvedValue({ userId: null, reason: 'לא נמצאה התאמה' });

    poolQuery
      .mockResolvedValueOnce(EMPTY) // findNewlyAssignedLeads
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findEscalationCandidates
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })    // findActiveInspectors
      .mockResolvedValueOnce(NOT_SENT)  // isLeadNotificationSent → not sent
      .mockResolvedValueOnce(CLAIMED);  // claimLeadNotification

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).toHaveBeenCalledOnce();
    const [msg] = sendTextMessage.mock.calls[0];
    expect(msg.text).toContain('הצעת שיבוץ: לא נמצאה התאמה');
  });

  it('skips escalation entirely when no active leads viewers in DB', async () => {
    getLeadsViewerPhones.mockResolvedValue([]);
    poolQuery.mockResolvedValueOnce(EMPTY); // findNewlyAssignedLeads

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).not.toHaveBeenCalled();
    // findEscalationCandidates should NOT have been called
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('fans out escalation to multiple viewers (Sasha + Guy F + Yair)', async () => {
    getLeadsViewerPhones.mockResolvedValue(['972500000001', '972500000002', '972500000003']);
    const row = makeEscalationRow();

    poolQuery
      .mockResolvedValueOnce(EMPTY) // findNewlyAssignedLeads
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findEscalationCandidates
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })    // findActiveInspectors
      .mockResolvedValueOnce(NOT_SENT)  // isLeadNotificationSent → not sent
      .mockResolvedValueOnce(CLAIMED);  // claimLeadNotification (after >=1 delivery)

    await runLeadAssignmentNotifier();

    // One send per viewer.
    expect(sendTextMessage).toHaveBeenCalledTimes(3);
    const recipients = sendTextMessage.mock.calls.map((c) => c[0].to);
    expect(recipients).toContain('972500000001');
    expect(recipients).toContain('972500000002');
    expect(recipients).toContain('972500000003');
  });

  it('skips escalation loop when already sent', async () => {
    const row = makeEscalationRow();

    poolQuery
      .mockResolvedValueOnce(EMPTY) // findNewlyAssignedLeads
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findEscalationCandidates
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })    // findActiveInspectors
      .mockResolvedValueOnce(ALREADY_SENT);                // isLeadNotificationSent → already sent

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('does NOT record as sent when every recipient send fails (retry next tick)', async () => {
    const row = makeEscalationRow();
    sendTextMessage.mockRejectedValue(new Error('send failed'));

    poolQuery
      .mockResolvedValueOnce(EMPTY) // findNewlyAssignedLeads
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findEscalationCandidates
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })    // findActiveInspectors
      .mockResolvedValueOnce(NOT_SENT); // isLeadNotificationSent → not sent

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).toHaveBeenCalledOnce();
    // No further pool.query call (no claim INSERT) since delivery count is 0.
    expect(poolQuery).toHaveBeenCalledTimes(4);
  });

  it('continues loop when send fails for one lead', async () => {
    const rowA = makeEscalationRow({ id: 'lead-a' });
    const rowB = makeEscalationRow({ id: 'lead-b', fromName: 'רחל' });

    poolQuery
      .mockResolvedValueOnce(EMPTY) // findNewlyAssignedLeads
      .mockResolvedValueOnce({ rowCount: 2, rows: [rowA, rowB] }) // findEscalationCandidates
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // findActiveInspectors
      .mockResolvedValueOnce(NOT_SENT)  // isLeadNotificationSent lead-a → not sent
      // lead-a's only viewer send fails → delivered=0 → NO claim call for lead-a
      .mockResolvedValueOnce(NOT_SENT)  // isLeadNotificationSent lead-b → not sent
      .mockResolvedValueOnce(CLAIMED);  // claimLeadNotification lead-b (send succeeds)

    sendTextMessage
      .mockRejectedValueOnce(new Error('A failed'))
      .mockResolvedValueOnce(undefined);

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).toHaveBeenCalledTimes(2);
  });
});
