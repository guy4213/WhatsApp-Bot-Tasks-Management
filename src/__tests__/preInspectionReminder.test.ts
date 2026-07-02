/**
 * D2-T15 — Pre-inspection 60-minute reminder: service tests.
 *
 * Coverage:
 *  - findDuePreReminders — SQL shape, 60-min window, preReminderSentAt IS NULL,
 *    fieldStatus whitelist, 6-source customer COALESCE, worker phone filter.
 *  - formatPreReminderCard — pure text assertions.
 *  - sendAndStampPreReminder — sends 3 buttons, stamps preReminderSentAt only
 *    on success, throws on send failure.
 *  - runPreInspectionReminderPoll — per-row failure isolation, no-rows short-circuit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

const sendButtonMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendButtonMessage: (...args: unknown[]) => sendButtonMessage(...args),
  sendTextMessage:   vi.fn().mockResolvedValue(undefined),
  sendListMessage:   vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  poolQuery.mockReset();
  sendButtonMessage.mockReset();
  sendButtonMessage.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

import {
  findDuePreReminders,
  formatPreReminderCard,
  sendAndStampPreReminder,
  runPreInspectionReminderPoll,
  preReminderDepartPayloadId,
  preReminderNeedInfoPayloadId,
  preReminderProblemPayloadId,
  type DuePreReminderRow,
} from '../services/preInspectionReminder';

function makeRow(overrides: Partial<DuePreReminderRow> = {}): DuePreReminderRow {
  return {
    taskFieldId: '22222222-2222-2222-2222-222222222222',
    scheduledStartAt: new Date('2026-07-01T08:00:00Z'), // 11:00 Asia/Jerusalem
    siteAddress: 'הרצל 5',
    siteCity: 'תל אביב',
    fieldContactName: 'אביגיל',
    fieldContactPhone: '052-1234567',
    family: 'noise',
    typeLabelHe: 'בדיקת רעש תעסוקתי',
    workerId: 'u-worker-1',
    workerName: 'דני',
    workerPhone: '972501234567',
    customerName: 'חברת בנייה',
    taskTitle: 'בדיקה 123',
    ...overrides,
  };
}

// ── Payload IDs ──────────────────────────────────────────────────────────────

describe('payload IDs', () => {
  it('are deterministic on taskFieldId', () => {
    expect(preReminderDepartPayloadId('abc')).toBe('PREREMIND_DEPART_abc');
    expect(preReminderNeedInfoPayloadId('abc')).toBe('PREREMIND_NEED_INFO_abc');
    expect(preReminderProblemPayloadId('abc')).toBe('PREREMIND_PROBLEM_abc');
  });
});

// ── findDuePreReminders ──────────────────────────────────────────────────────

describe('findDuePreReminders', () => {
  it('filters preReminderSentAt IS NULL and 60-min window', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await findDuePreReminders();
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"preReminderSentAt"\s+IS\s+NULL/);
    expect(sql).toMatch(/tf\."scheduledStartAt"\s*>\s*now\(\)/);
    expect(sql).toMatch(/tf\."scheduledStartAt"\s*<=\s*now\(\)\s*\+\s*interval\s*'60 minutes'/);
    expect(params).toEqual([50]);
  });

  it('filters fieldStatus to ASSIGNED, CONFIRMED, NEEDS_MORE_INFO', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await findDuePreReminders();
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/tf\."fieldStatus"\s+IN\s*\(\s*'ASSIGNED'\s*,\s*'CONFIRMED'\s*,\s*'NEEDS_MORE_INFO'\s*\)/);
  });

  it('filters ownerId IS NOT NULL and non-empty phone', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await findDuePreReminders();
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/t\."ownerId"\s+IS\s+NOT\s+NULL/);
    expect(sql).toMatch(/u\.phone\s+IS\s+NOT\s+NULL/);
    expect(sql).toMatch(/u\.phone\s+<>\s+''/);
  });

  it('uses the 6-source customer COALESCE (Customer, Lead fullName, Lead firstName+lastName, Lead company, Project client, IncomingLead fromName)', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await findDuePreReminders();
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/COALESCE/i);
    expect(sql).toMatch(/c\.name/);
    expect(sql).toMatch(/l\."fullName"/);
    expect(sql).toMatch(/CONCAT_WS.*l\."firstName".*l\."lastName"/s);
    expect(sql).toMatch(/l\.company/);
    expect(sql).toMatch(/p\.client/);
    expect(sql).toMatch(/il\."fromName"/);
  });

  it('joins InspectionType, User, and left-joins Customer/Lead/Project/IncomingLead', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await findDuePreReminders();
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/JOIN\s+"InspectionType"\s+it/);
    expect(sql).toMatch(/LEFT JOIN\s+"User"\s+u/);
    expect(sql).toMatch(/LEFT JOIN\s+"Customer"\s+c/);
    expect(sql).toMatch(/LEFT JOIN\s+"Lead"\s+l/);
    expect(sql).toMatch(/LEFT JOIN\s+"Project"\s+p/);
    expect(sql).toMatch(/LEFT JOIN\s+"IncomingLead"\s+il/);
  });

  it('orders by scheduledStartAt ASC and respects an explicit limit', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await findDuePreReminders(10);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/ORDER BY\s+tf\."scheduledStartAt"\s+ASC/);
    expect(params).toEqual([10]);
  });
});

// ── formatPreReminderCard ────────────────────────────────────────────────────

describe('formatPreReminderCard', () => {
  it('renders the reminder body with header, type, customer, address, time, contact', () => {
    const body = formatPreReminderCard(makeRow());
    expect(body).toContain('תזכורת בדיקה קרובה');
    expect(body).toContain('בעוד שעה יש לך בדיקה:');
    expect(body).toContain('סוג בדיקה: בדיקת רעש תעסוקתי');
    expect(body).toContain('לקוח: חברת בנייה');
    expect(body).toContain('כתובת: הרצל 5, תל אביב');
    expect(body).toContain('שעה:');
    expect(body).toContain('איש קשר: אביגיל, 052-1234567');
  });

  it('uses "לקוח לא ידוע" when customerName is null', () => {
    const body = formatPreReminderCard(makeRow({ customerName: null }));
    expect(body).toContain('לקוח: לקוח לא ידוע');
  });

  it('uses "לקוח לא ידוע" when customerName is empty string', () => {
    const body = formatPreReminderCard(makeRow({ customerName: '' }));
    expect(body).toContain('לקוח: לקוח לא ידוע');
  });

  it('uses "כתובת לא ידועה" when both siteAddress and siteCity are null', () => {
    const body = formatPreReminderCard(makeRow({ siteAddress: null, siteCity: null }));
    expect(body).toContain('כתובת: כתובת לא ידועה');
  });

  it('renders city alone when siteAddress is null', () => {
    const body = formatPreReminderCard(makeRow({ siteAddress: null, siteCity: 'חיפה' }));
    expect(body).toContain('כתובת: חיפה');
  });

  it('renders address alone when siteCity is null', () => {
    const body = formatPreReminderCard(makeRow({ siteCity: null, siteAddress: 'בן גוריון 10' }));
    expect(body).toContain('כתובת: בן גוריון 10');
  });

  it('uses "לא צוין" when contact is null', () => {
    const body = formatPreReminderCard(makeRow({ fieldContactName: null, fieldContactPhone: null }));
    expect(body).toContain('איש קשר: לא צוין');
  });

  it('uses Intl-based time (HH:MM format) — not raw .getHours()', () => {
    // scheduledStartAt is 2026-07-01T08:00:00Z = 11:00 Asia/Jerusalem
    const body = formatPreReminderCard(makeRow({
      scheduledStartAt: new Date('2026-07-01T08:00:00Z'),
    }));
    expect(body).toContain('שעה: 11:00');
  });
});

// ── sendAndStampPreReminder ──────────────────────────────────────────────────

describe('sendAndStampPreReminder', () => {
  it('sends the button message with 3 buttons then stamps preReminderSentAt', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // UPDATE stamp

    await sendAndStampPreReminder(makeRow());

    expect(sendButtonMessage).toHaveBeenCalledTimes(1);
    const call = sendButtonMessage.mock.calls[0][0];
    expect(call.to).toBe('972501234567');
    expect(call.buttons).toHaveLength(3);
    expect(call.buttons[0].id).toBe('PREREMIND_DEPART_22222222-2222-2222-2222-222222222222');
    expect(call.buttons[1].id).toBe('PREREMIND_NEED_INFO_22222222-2222-2222-2222-222222222222');
    expect(call.buttons[2].id).toBe('PREREMIND_PROBLEM_22222222-2222-2222-2222-222222222222');
    // Button titles must fit Meta's 20-char cap
    for (const btn of call.buttons) {
      expect(btn.title.length).toBeLessThanOrEqual(20);
    }
    // Stamp query
    const stampCall = poolQuery.mock.calls[0];
    expect(stampCall[0]).toMatch(/UPDATE\s+"TaskField"[\s\S]*"preReminderSentAt"\s*=\s*now\(\)/);
    expect(stampCall[0]).toMatch(/AND\s+"preReminderSentAt"\s+IS\s+NULL/);
    expect(stampCall[1]).toEqual(['22222222-2222-2222-2222-222222222222']);
  });

  it('does NOT stamp when the send throws (retryable next tick)', async () => {
    sendButtonMessage.mockRejectedValueOnce(new Error('network error'));

    await expect(sendAndStampPreReminder(makeRow())).rejects.toThrow('network error');
    // send threw — no stamp query executed
    expect(poolQuery).not.toHaveBeenCalled();
  });
});

// ── runPreInspectionReminderPoll ─────────────────────────────────────────────

describe('runPreInspectionReminderPoll', () => {
  it('short-circuits when no rows are due', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await runPreInspectionReminderPoll();
    expect(sendButtonMessage).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('sends each due row and continues on per-row failure', async () => {
    const rowA = makeRow({ taskFieldId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    const rowB = makeRow({ taskFieldId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
    // findDuePreReminders returns 2 rows
    poolQuery.mockResolvedValueOnce({ rowCount: 2, rows: [rowA, rowB] });
    // A: sendButtonMessage fails
    sendButtonMessage.mockRejectedValueOnce(new Error('A failed'));
    // B: sendButtonMessage succeeds
    sendButtonMessage.mockResolvedValueOnce(undefined);
    // B: stamp succeeds
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await runPreInspectionReminderPoll();

    // Both rows were attempted
    expect(sendButtonMessage).toHaveBeenCalledTimes(2);
    // A failed — no stamp; B succeeded — stamp ran (SELECT + stamp = 2 pool calls total)
    expect(poolQuery).toHaveBeenCalledTimes(2); // SELECT rows + B stamp
  });
});
