/**
 * Unit tests for the customer-facing notification service (WORKER_EN_ROUTE).
 * Covers:
 *  - FAMILY_LABELS covers all 13 InspectionType families
 *  - resolveInspectionLabel picks appointmentTitle → family label → fallback
 *  - Env flag gate: no DB/network touched when CUSTOMER_NOTIFICATIONS_ENABLED!=true
 *  - "No customer phone" path — worker gets "call manually", template NOT sent
 *  - Happy path — template sent, worker gets ✅ confirmation
 *  - Send failure path — worker gets ⚠️ + phone-to-call
 *  - Dedup — a second call for the same (taskFieldId, type) is a no-op
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAMILY_LABELS, resolveInspectionLabel } from '../services/customerNotifications';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const poolQueryMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn(async () => undefined));
const sendTextMock = vi.hoisted(() => vi.fn(async () => undefined));
const writeAuditLogMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock('../db/connection', () => ({
  pool: { query: poolQueryMock },
  supabaseAdmin: {},
}));
vi.mock('../whatsapp/templates', () => ({ notify: notifyMock }));
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage: sendTextMock,
  sendButtonMessage: vi.fn(async () => undefined),
  sendListMessage: vi.fn(async () => undefined),
  sendTemplateMessage: vi.fn(async () => undefined),
}));
vi.mock('../utils/auditLog', () => ({ writeAuditLog: writeAuditLogMock }));

// Import AFTER the mocks are hoisted so the service picks them up.
async function loadService() {
  return import('../services/customerNotifications');
}

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  poolQueryMock.mockReset();
  notifyMock.mockReset();
  sendTextMock.mockReset();
  writeAuditLogMock.mockReset();
  notifyMock.mockResolvedValue(undefined);
  sendTextMock.mockResolvedValue(undefined);
  writeAuditLogMock.mockResolvedValue(null);
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

// ── Pure logic ────────────────────────────────────────────────────────────────

describe('FAMILY_LABELS', () => {
  it('covers all 13 InspectionType families from migration 009', () => {
    const expected = [
      'radiation', 'noise', 'radon', 'air', 'asbestos', 'water',
      'odor', 'soil', 'occupational', 'thermal', 'green', 'opinion', 'general',
    ] as const;
    for (const family of expected) {
      expect(FAMILY_LABELS[family]).toBeTruthy();
      expect(FAMILY_LABELS[family].length).toBeGreaterThan(0);
    }
    expect(Object.keys(FAMILY_LABELS)).toHaveLength(13);
  });

  it('uses short natural Hebrew phrases, not raw code strings', () => {
    expect(FAMILY_LABELS.radon).toMatch(/^בדיקת/);
    expect(FAMILY_LABELS.noise).toMatch(/^בדיקת/);
    expect(FAMILY_LABELS.radiation).toMatch(/^בדיקת/);
  });
});

describe('resolveInspectionLabel', () => {
  const base = { recipientName: null, recipientPhone: null, workerName: null, workerPhone: null };

  it('prefers appointmentTitle when non-empty', () => {
    expect(resolveInspectionLabel({
      ...base, family: 'radon', appointmentTitle: 'בדיקה מיוחדת ללקוח X',
    })).toBe('בדיקה מיוחדת ללקוח X');
  });

  it('falls back to family label when appointmentTitle is blank/whitespace', () => {
    expect(resolveInspectionLabel({
      ...base, family: 'radon', appointmentTitle: '',
    })).toBe('בדיקת ראדון');
    expect(resolveInspectionLabel({
      ...base, family: 'radon', appointmentTitle: '   ',
    })).toBe('בדיקת ראדון');
    expect(resolveInspectionLabel({
      ...base, family: 'noise', appointmentTitle: null,
    })).toBe('בדיקת רעש');
  });

  it('final fallback is "בדיקה" when both are missing', () => {
    expect(resolveInspectionLabel({
      ...base, family: null, appointmentTitle: null,
    })).toBe('בדיקה');
  });
});

// ── Env flag gate ─────────────────────────────────────────────────────────────

describe('sendWorkerEnRouteNotification — env flag gate', () => {
  it('is a no-op when CUSTOMER_NOTIFICATIONS_ENABLED is unset', async () => {
    delete process.env.CUSTOMER_NOTIFICATIONS_ENABLED;
    const svc = await loadService();
    await svc.sendWorkerEnRouteNotification('tf-1', 'user-1');
    expect(poolQueryMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('is a no-op when CUSTOMER_NOTIFICATIONS_ENABLED=false', async () => {
    process.env.CUSTOMER_NOTIFICATIONS_ENABLED = 'false';
    const svc = await loadService();
    await svc.sendWorkerEnRouteNotification('tf-1', 'user-1');
    expect(poolQueryMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

// ── Recipient resolution / send paths ─────────────────────────────────────────

describe('sendWorkerEnRouteNotification — send behavior', () => {
  beforeEach(() => {
    process.env.CUSTOMER_NOTIFICATIONS_ENABLED = 'true';
  });

  function mockContextRow(overrides: Partial<{
    recipientName: string | null;
    recipientPhone: string | null;
    workerName: string | null;
    workerPhone: string | null;
    family: string | null;
    appointmentTitle: string | null;
  }> = {}) {
    return {
      recipientName: 'דני',
      recipientPhone: '972501234567',
      workerName: 'אלירן',
      workerPhone: '972541234567',
      family: 'radon',
      appointmentTitle: null,
      ...overrides,
    };
  }

  it('sends template + ✅ worker confirmation on happy path', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [mockContextRow()], rowCount: 1 })  // loadNotificationContext
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                    // claim (won)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                   // stampWorkerFeedback

    const svc = await loadService();
    await svc.sendWorkerEnRouteNotification('tf-1', 'worker-user-1');

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const notifyArgs = (notifyMock.mock.calls as unknown as Array<Array<{ to: string; key: string; bodyParams: string[] }>>)[0][0];
    expect(notifyArgs.to).toBe('972501234567');
    expect(notifyArgs.key).toBe('CUSTOMER_WORKER_EN_ROUTE');
    expect(notifyArgs.bodyParams).toEqual(['דני', 'אלירן', 'בדיקת ראדון', '972541234567']);

    expect(sendTextMock).toHaveBeenCalledTimes(1);
    const feedback = (sendTextMock.mock.calls as unknown as Array<Array<{ to: string; text: string }>>)[0][0];
    expect(feedback.to).toBe('972541234567');
    expect(feedback.text).toContain('✅');
    expect(feedback.text).toContain('דני');
  });

  it('falls back to Customer.phone/name when fieldContact fields are null', async () => {
    // The SQL COALESCE is exercised in DB; here we just verify the service uses
    // whatever the query returned. Sanity check that the recipient it resolves
    // matches the mocked context (which represents the post-COALESCE row).
    poolQueryMock
      .mockResolvedValueOnce({
        rows: [mockContextRow({ recipientName: 'לקוח מהחוזה', recipientPhone: '972509998877' })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const svc = await loadService();
    await svc.sendWorkerEnRouteNotification('tf-1', 'worker-user-1');

    const args = (notifyMock.mock.calls as unknown as Array<Array<{ to: string; bodyParams: string[] }>>)[0][0];
    expect(args.to).toBe('972509998877');
    expect(args.bodyParams[0]).toBe('לקוח מהחוזה');
  });

  it('when no customer phone at all — no template send, worker gets ⚠️ manual-call message', async () => {
    poolQueryMock
      .mockResolvedValueOnce({
        rows: [mockContextRow({ recipientPhone: null, recipientName: 'דני' })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // markFailed
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // stampWorkerFeedback

    const svc = await loadService();
    await svc.sendWorkerEnRouteNotification('tf-1', 'worker-user-1');

    expect(notifyMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenCalledTimes(1);
    const text = (sendTextMock.mock.calls as unknown as Array<Array<{ text: string }>>)[0][0].text;
    expect(text).toContain('⚠️');
    expect(text).toContain('אין ללקוח דני מספר טלפון');
  });

  it('when notify() throws — worker gets ⚠️ with customer phone to call', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [mockContextRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // claim won
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // markFailed
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // stampWorkerFeedback
    notifyMock.mockRejectedValueOnce(new Error('Meta 400 template not approved'));

    const svc = await loadService();
    await svc.sendWorkerEnRouteNotification('tf-1', 'worker-user-1');

    expect(sendTextMock).toHaveBeenCalledTimes(1);
    const text = (sendTextMock.mock.calls as unknown as Array<Array<{ text: string }>>)[0][0].text;
    expect(text).toContain('⚠️');
    expect(text).toContain('972501234567'); // customer's phone for manual call
  });

  it('dedup: a second call for the same TaskField is a no-op (claim returns 0)', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [mockContextRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // claim LOST (dedup)

    const svc = await loadService();
    await svc.sendWorkerEnRouteNotification('tf-1', 'worker-user-1');

    expect(notifyMock).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('gracefully returns when TaskField is not found', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const svc = await loadService();
    await svc.sendWorkerEnRouteNotification('missing-tf', 'worker-user-1');
    expect(notifyMock).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it('never throws even if loadNotificationContext blows up', async () => {
    poolQueryMock.mockRejectedValueOnce(new Error('db down'));
    const svc = await loadService();
    await expect(svc.sendWorkerEnRouteNotification('tf-1', 'worker-user-1')).resolves.toBeUndefined();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
