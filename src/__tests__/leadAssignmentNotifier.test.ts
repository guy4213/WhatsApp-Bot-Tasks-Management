/**
 * D3-T3 + D3-T4 — leadAssignmentNotifier polling job.
 *
 * D3-T3 (worker assignment alert) — INSERT-first atomic claim (migration 022):
 *   1. tryClaimLeadNotification — INSERT ... ON CONFLICT DO UPDATE ...
 *      RETURNING. Only one caller can win; parallel webhook + poller cannot
 *      both send the same alert.
 *   2. Send WhatsApp only if we won the claim.
 *   3. markLeadNotificationSent (UPDATE) on success; releaseLeadNotificationClaim
 *      (DELETE) on failure so the next tick retries.
 *
 * D3-T4 (Sasha escalation) — unchanged legacy check-then-act: isLeadNotificationSent
 * SELECT before the send, claimLeadNotification INSERT after a successful send.
 * Racing is acceptable here because there is only one caller (the poller).
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
// isLeadNotificationSent (SELECT) — legacy D3-T4 dedup.
const NOT_SENT = { rowCount: 0, rows: [] };
const ALREADY_SENT = { rowCount: 1, rows: [{ leadId: 'x' }] };
// claimLeadNotification (legacy INSERT ... ON CONFLICT ... RETURNING).
const CLAIMED = { rowCount: 1, rows: [{ leadId: 'x' }] };
// D3-T3 INSERT-first: tryClaimLeadNotification win/lose result shapes.
const CLAIM_WON  = { rowCount: 1, rows: [{ leadId: 'x' }] };
const CLAIM_LOST = { rowCount: 0, rows: [] };
// markLeadNotificationSent / releaseLeadNotificationClaim (UPDATE/DELETE).
const UPDATE_OK = { rowCount: 1, rows: [] };
const DELETE_OK = { rowCount: 1, rows: [] };

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

// ── D3-T3: worker assignment alerts (INSERT-first atomic claim) ─────────────

describe('D3-T3 worker assignment alert', () => {
  it('claims atomically FIRST, sends to worker phone, then marks as SENT', async () => {
    const row = makeAssignedRow();
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findNewlyAssignedLeads
      .mockResolvedValueOnce(CLAIM_WON)   // tryClaimLeadNotification → won
      .mockResolvedValueOnce(UPDATE_OK);  // markLeadNotificationSent (after successful send)

    await runLeadAssignmentNotifier();

    // Claim INSERT ran BEFORE the send.
    const claimCall = poolQuery.mock.calls[1];
    expect(claimCall[0]).toMatch(/INSERT INTO "WhatsappLeadNotification"/);
    expect(claimCall[0]).toMatch(/ON CONFLICT/);
    expect(claimCall[0]).toMatch(/'PENDING'/);
    expect(claimCall[1]).toContain('ASSIGNED_TO_WORKER');

    // Mark-SENT UPDATE ran AFTER the send.
    const markCall = poolQuery.mock.calls[2];
    expect(markCall[0]).toMatch(/UPDATE "WhatsappLeadNotification"/);
    expect(markCall[0]).toMatch(/'SENT'/);

    // sendTextMessage was called for the worker.
    expect(sendTextMessage).toHaveBeenCalledOnce();
    const [msg] = sendTextMessage.mock.calls[0];
    expect(msg.to).toBe('972501111111');
    expect(msg.text).toContain('ליד חדש שויך אליך');
    expect(msg.text).toContain('דוד לוי');
    expect(msg.text).toContain('לטיפול ועדכון ב-CRM');
  });

  it('skips send when the atomic claim loses (webhook already handling)', async () => {
    const row = makeAssignedRow();
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findNewlyAssignedLeads
      .mockResolvedValueOnce(CLAIM_LOST);                  // tryClaimLeadNotification → someone else won

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).not.toHaveBeenCalled();
    // No further pool.query — no send, no mark, no release.
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });

  it('skips send when worker has no phone, and marks SENT so it is not re-selected', async () => {
    const row = makeAssignedRow({ workerPhone: null });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findNewlyAssignedLeads
      .mockResolvedValueOnce(CLAIM_WON)  // tryClaimLeadNotification → won
      .mockResolvedValueOnce(UPDATE_OK); // markLeadNotificationSent (no-phone → terminal state)

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).not.toHaveBeenCalled();
    const markCall = poolQuery.mock.calls[2];
    expect(markCall[0]).toMatch(/UPDATE "WhatsappLeadNotification"/);
    expect(markCall[0]).toMatch(/'SENT'/);
  });

  it('RELEASES the claim when the WhatsApp send fails (allows retry next tick)', async () => {
    const row = makeAssignedRow();
    sendTextMessage.mockRejectedValueOnce(new Error('send failed'));
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findNewlyAssignedLeads
      .mockResolvedValueOnce(CLAIM_WON)  // tryClaimLeadNotification → won
      .mockResolvedValueOnce(DELETE_OK); // releaseLeadNotificationClaim (after send failure)

    await runLeadAssignmentNotifier();

    expect(sendTextMessage).toHaveBeenCalledOnce();
    // Release DELETE ran, no mark-SENT.
    const releaseCall = poolQuery.mock.calls[2];
    expect(releaseCall[0]).toMatch(/DELETE FROM "WhatsappLeadNotification"/);
    expect(releaseCall[0]).toMatch(/'PENDING'/);
  });

  it('continues loop on per-lead send failure', async () => {
    const rowA = makeAssignedRow({ id: 'lead-a', fromName: 'ראשון' });
    const rowB = makeAssignedRow({ id: 'lead-b', fromName: 'שני' });
    poolQuery
      .mockResolvedValueOnce({ rowCount: 2, rows: [rowA, rowB] }) // findNewlyAssignedLeads
      .mockResolvedValueOnce(CLAIM_WON)   // tryClaim lead-a → won
      .mockResolvedValueOnce(DELETE_OK)   // release lead-a (send fails)
      .mockResolvedValueOnce(CLAIM_WON)   // tryClaim lead-b → won
      .mockResolvedValueOnce(UPDATE_OK);  // markSent lead-b

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

// ── D3-T3 exported single-lead handler (webhook consumer) ───────────────────

describe('processAssignmentAlertForLead (webhook path)', () => {
  it('preloaded row: claim → send → mark SENT, returns "sent"', async () => {
    const row = makeAssignedRow({ id: 'lead-w' });
    poolQuery
      .mockResolvedValueOnce(CLAIM_WON)  // tryClaim
      .mockResolvedValueOnce(UPDATE_OK); // markSent

    const { processAssignmentAlertForLead } = await import('../scheduler/jobs/leadAssignmentNotifier');
    const outcome = await processAssignmentAlertForLead('lead-w', row);

    expect(outcome).toBe('sent');
    expect(sendTextMessage).toHaveBeenCalledOnce();
    // findAssignedLeadById is NOT called when preloaded row is provided.
    expect(poolQuery.mock.calls.every((c) => !/SELECT[\s\S]+FROM "IncomingLead"/.test(c[0] as string))).toBe(true);
  });

  it('no preload: fetches via findAssignedLeadById, then claim/send/mark', async () => {
    const row = makeAssignedRow({ id: 'lead-w' });
    poolQuery
      .mockResolvedValueOnce(CLAIM_WON)                    // tryClaim first
      .mockResolvedValueOnce({ rowCount: 1, rows: [row] }) // findAssignedLeadById
      .mockResolvedValueOnce(UPDATE_OK);                   // markSent

    const { processAssignmentAlertForLead } = await import('../scheduler/jobs/leadAssignmentNotifier');
    const outcome = await processAssignmentAlertForLead('lead-w');

    expect(outcome).toBe('sent');
    expect(sendTextMessage).toHaveBeenCalledOnce();
  });

  it('ineligible lead (missing / not ACTIVE / no owner): releases the claim, returns "ineligible"', async () => {
    poolQuery
      .mockResolvedValueOnce(CLAIM_WON)                       // tryClaim
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })       // findAssignedLeadById → null
      .mockResolvedValueOnce(DELETE_OK);                      // releaseClaim (so future ACTIVE txn can re-claim)

    const { processAssignmentAlertForLead } = await import('../scheduler/jobs/leadAssignmentNotifier');
    const outcome = await processAssignmentAlertForLead('lead-w');

    expect(outcome).toBe('ineligible');
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(poolQuery.mock.calls[2][0]).toMatch(/DELETE FROM "WhatsappLeadNotification"/);
  });

  it('claim lost: returns "skipped" without touching send or DB again', async () => {
    poolQuery.mockResolvedValueOnce(CLAIM_LOST); // tryClaim → lost

    const { processAssignmentAlertForLead } = await import('../scheduler/jobs/leadAssignmentNotifier');
    const outcome = await processAssignmentAlertForLead('lead-w');

    expect(outcome).toBe('skipped');
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
