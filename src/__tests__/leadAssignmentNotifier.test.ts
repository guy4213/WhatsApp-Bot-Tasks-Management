/**
 * D3-T3 + D3-T4 — leadAssignmentNotifier polling job.
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
  it('claims dedup then sends to worker phone', async () => {
    const row = makeAssignedRow();
    poolQuery
      // findNewlyAssignedLeads
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] })
      // claimLeadNotification ASSIGNED_TO_WORKER
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ leadId: row.id }] })
      // findEscalationCandidates (no Sasha phone set → escalation skipped)
      // actually, processEscalations short-circuits when SASHA_PHONE is unset
      .mockResolvedValueOnce(EMPTY); // findEscalationCandidates would not be called

    await runLeadAssignmentNotifier();

    // Dedup INSERT was called
    const claimCall = poolQuery.mock.calls[1];
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

  it('skips send when dedup claim returns false (already claimed)', async () => {
    const row = makeAssignedRow();
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findNewlyAssignedLeads
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });   // claim → already claimed

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('skips send when worker has no phone', async () => {
    const row = makeAssignedRow({ workerPhone: null });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findNewlyAssignedLeads
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ leadId: row.id }] }); // claim succeeds

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('continues loop on per-lead send failure', async () => {
    const rowA = makeAssignedRow({ id: 'lead-a', fromName: 'ראשון' });
    const rowB = makeAssignedRow({ id: 'lead-b', fromName: 'שני' });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 2, rows: [rowA, rowB] }) // findNewlyAssignedLeads
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ leadId: 'lead-a' }] }) // claim A
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ leadId: 'lead-b' }] }); // claim B

    sendTextMessage
      .mockRejectedValueOnce(new Error('send A failed'))
      .mockResolvedValueOnce(undefined);

    await runLeadAssignmentNotifier();

    // Both rows were attempted
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

  it('claims ESCALATED_1H then sends to Sasha with AI suggestion', async () => {
    const row = makeEscalationRow();
    suggestWorkerForLead.mockResolvedValue({ userId: 'u-1', reason: 'מתמחה בקרינה' });

    poolQuery
      .mockResolvedValueOnce(EMPTY)  // findNewlyAssignedLeads
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] })  // findEscalationCandidates
      // findActiveInspectors runs before claim
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'u-1', name: 'דני', role: 'WORKER' }] })
      // claimLeadNotification ESCALATED_1H
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ leadId: row.id }] });

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
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ leadId: row.id }] }); // claim → granted

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
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ leadId: row.id }] }); // claim

    await runLeadAssignmentNotifier();

    // One send per viewer.
    expect(sendTextMessage).toHaveBeenCalledTimes(3);
    const recipients = sendTextMessage.mock.calls.map((c) => c[0].to);
    expect(recipients).toContain('972500000001');
    expect(recipients).toContain('972500000002');
    expect(recipients).toContain('972500000003');
  });

  it('skips escalation loop when claim returns false', async () => {
    const row = makeEscalationRow();

    poolQuery
      .mockResolvedValueOnce(EMPTY) // findNewlyAssignedLeads
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findEscalationCandidates
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })    // claim → already claimed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });   // findActiveInspectors

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('continues loop when send fails for one lead', async () => {
    const rowA = makeEscalationRow({ id: 'lead-a' });
    const rowB = makeEscalationRow({ id: 'lead-b', fromName: 'רחל' });

    poolQuery
      .mockResolvedValueOnce(EMPTY) // findNewlyAssignedLeads
      .mockResolvedValueOnce({ rowCount: 2, rows: [rowA, rowB] }) // findEscalationCandidates
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // findActiveInspectors
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ leadId: 'lead-a' }] }) // claim A
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ leadId: 'lead-b' }] }); // claim B

    sendTextMessage
      .mockRejectedValueOnce(new Error('A failed'))
      .mockResolvedValueOnce(undefined);

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).toHaveBeenCalledTimes(2);
  });
});
