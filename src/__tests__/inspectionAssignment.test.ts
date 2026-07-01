/**
 * D2-T2 + D5-T6 — inspection assignment card emission + polling.
 *
 * Coverage:
 *  - findUnnotifiedTaskFields — parameterized SELECT, workerNotifiedAt filter.
 *  - getEquipmentLabels — deduped by labelHe, sortOrder-ordered.
 *  - formatInspectionCard — spec §6 layout + numbered choices.
 *  - sendAndStampAssignmentCard — sends 3 buttons then stamps workerNotifiedAt.
 *  - runInspectionAssignmentPoll — sends per-row, isolates failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

const sendButtonMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendButtonMessage: (...args: unknown[]) => sendButtonMessage(...args),
  sendTextMessage: vi.fn().mockResolvedValue(undefined),
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
  findUnnotifiedTaskFields,
  getEquipmentLabels,
  formatInspectionCard,
  sendAndStampAssignmentCard,
  runInspectionAssignmentPoll,
  inspectionConfirmPayloadId,
  inspectionDeclinePayloadId,
  inspectionNeedInfoPayloadId,
  type UnnotifiedTaskFieldRow,
} from '../services/inspectionAssignment';

function makeRow(overrides: Partial<UnnotifiedTaskFieldRow> = {}): UnnotifiedTaskFieldRow {
  return {
    taskFieldId: '11111111-1111-1111-1111-111111111111',
    workerId: 'u-1',
    workerPhone: '972500000001',
    workerName: 'דני',
    customerName: 'משה כהן',
    siteAddress: 'אחוזה 100',
    siteCity: 'רעננה',
    fieldContactName: 'משה',
    fieldContactPhone: '050-0000000',
    navigationUrl: 'https://maps.example/x',
    specialInstructions: null,
    scheduledStartAt: new Date('2026-07-01T07:00:00Z'), // 10:00 Asia/Jerusalem
    family: 'radiation',
    typeLabelHe: 'בדיקת קרינה מרשת החשמל',
    ...overrides,
  };
}

// ── Payload IDs ──────────────────────────────────────────────────────────────

describe('payload IDs', () => {
  it('are deterministic on taskFieldId', () => {
    expect(inspectionConfirmPayloadId('abc')).toBe('INSP_CONFIRM_abc');
    expect(inspectionDeclinePayloadId('abc')).toBe('INSP_DECLINE_abc');
    expect(inspectionNeedInfoPayloadId('abc')).toBe('INSP_NEED_INFO_abc');
  });
});

// ── findUnnotifiedTaskFields ─────────────────────────────────────────────────

describe('findUnnotifiedTaskFields', () => {
  it('filters WHERE workerNotifiedAt IS NULL, orders by assignedAt, joins user + task + type', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await findUnnotifiedTaskFields();
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/FROM\s+"TaskField"\s+tf/);
    expect(sql).toMatch(/JOIN\s+"Task"\s+t/);
    expect(sql).toMatch(/JOIN\s+"InspectionType"\s+it/);
    expect(sql).toMatch(/JOIN\s+"User"\s+u\s+ON\s+u\.id\s*=\s*t\."ownerId"/);
    expect(sql).toMatch(/WHERE\s+tf\."workerNotifiedAt"\s+IS\s+NULL/);
    expect(sql).toMatch(/ORDER BY\s+tf\."assignedAt"/);
    expect(params).toEqual([50]);
  });

  it('honors an explicit limit', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await findUnnotifiedTaskFields(5);
    expect(poolQuery.mock.calls[0][1]).toEqual([5]);
  });
});

// ── getEquipmentLabels ───────────────────────────────────────────────────────

describe('getEquipmentLabels', () => {
  it('returns labels in sortOrder, deduped by labelHe', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 4,
      rows: [
        { labelHe: 'מד ELF' },
        { labelHe: 'חצובה' },
        { labelHe: 'חצובה' }, // dup
        { labelHe: 'טופס שטח' },
      ],
    });
    const labels = await getEquipmentLabels('radiation');
    expect(labels).toEqual(['מד ELF', 'חצובה', 'טופס שטח']);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/FROM\s+"InspectionChecklist"/);
    expect(sql).toMatch(/WHERE\s+family\s*=\s*\$1/);
    expect(params).toEqual(['radiation']);
  });
});

// ── formatInspectionCard ─────────────────────────────────────────────────────

describe('formatInspectionCard', () => {
  it('renders the §6 layout with type, customer, address, date/time, contact, equipment, nav, choices', () => {
    const body = formatInspectionCard(makeRow(), ['מד ELF', 'מד RF', 'חצובה', 'טופס שטח']);
    expect(body).toContain('שובצה לך בדיקה חדשה.');
    expect(body).toContain('סוג: בדיקת קרינה מרשת החשמל');
    expect(body).toContain('לקוח: משה כהן');
    expect(body).toContain('כתובת: אחוזה 100, רעננה');
    expect(body).toContain('תאריך:');
    expect(body).toContain('שעה:');
    expect(body).toContain('איש קשר: משה, 050-0000000');
    expect(body).toContain('ציוד נדרש:');
    expect(body).toContain('- מד ELF');
    expect(body).toContain('- מד RF');
    expect(body).toContain('- חצובה');
    expect(body).toContain('- טופס שטח');
    expect(body).toContain('ניווט: https://maps.example/x');
    expect(body).toContain('1. מאשר');
    expect(body).toContain('2. לא יכול להגיע');
    expect(body).toContain('3. צריך פרטים נוספים');
  });

  it('omits missing optional lines rather than inventing placeholders', () => {
    const body = formatInspectionCard(
      makeRow({
        customerName: null,
        siteAddress: null,
        siteCity: null,
        fieldContactName: null,
        fieldContactPhone: null,
        navigationUrl: null,
      }),
      [],
    );
    expect(body).not.toMatch(/לקוח:/);
    expect(body).not.toMatch(/כתובת:/);
    expect(body).not.toMatch(/איש קשר:/);
    expect(body).not.toMatch(/ניווט:/);
    expect(body).not.toMatch(/ציוד נדרש:/);
    // choices always present
    expect(body).toContain('1. מאשר');
  });
});

// ── sendAndStampAssignmentCard ───────────────────────────────────────────────

describe('sendAndStampAssignmentCard', () => {
  it('sends the button message with 3 buttons then stamps workerNotifiedAt', async () => {
    poolQuery
      // getEquipmentLabels
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      // UPDATE stamp
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await sendAndStampAssignmentCard(makeRow());

    expect(sendButtonMessage).toHaveBeenCalledTimes(1);
    const call = sendButtonMessage.mock.calls[0][0];
    expect(call.to).toBe('972500000001');
    expect(call.buttons).toHaveLength(3);
    expect(call.buttons[0].id).toBe('INSP_CONFIRM_11111111-1111-1111-1111-111111111111');
    expect(call.buttons[1].id).toBe('INSP_DECLINE_11111111-1111-1111-1111-111111111111');
    expect(call.buttons[2].id).toBe('INSP_NEED_INFO_11111111-1111-1111-1111-111111111111');
    // Stamp query
    const stampCall = poolQuery.mock.calls[1];
    expect(stampCall[0]).toMatch(/UPDATE\s+"TaskField"[\s\S]*"workerNotifiedAt"\s*=\s*now\(\)/);
    expect(stampCall[0]).toMatch(/AND\s+"workerNotifiedAt"\s+IS\s+NULL/);
    expect(stampCall[1]).toEqual(['11111111-1111-1111-1111-111111111111']);
  });

  it('skips send when the worker has no phone (does not stamp)', async () => {
    await sendAndStampAssignmentCard(makeRow({ workerPhone: null }));
    expect(sendButtonMessage).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('does NOT stamp when the send throws (retryable next tick)', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // equipment
    sendButtonMessage.mockRejectedValueOnce(new Error('boom'));

    await expect(sendAndStampAssignmentCard(makeRow())).rejects.toThrow('boom');
    // Only the equipment query ran; no UPDATE.
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });
});

// ── runInspectionAssignmentPoll ──────────────────────────────────────────────

describe('runInspectionAssignmentPoll', () => {
  it('sends each unnotified row and continues on per-row failure', async () => {
    const rowA = makeRow({ taskFieldId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    const rowB = makeRow({ taskFieldId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
    poolQuery
      // findUnnotifiedTaskFields
      .mockResolvedValueOnce({ rowCount: 2, rows: [rowA, rowB] })
      // A: getEquipmentLabels
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    // A: sendButtonMessage throws
    sendButtonMessage.mockRejectedValueOnce(new Error('A failed'));
    // B: getEquipmentLabels
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    // B: sendButtonMessage OK
    sendButtonMessage.mockResolvedValueOnce(undefined);
    // B: stamp
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await runInspectionAssignmentPoll();

    expect(sendButtonMessage).toHaveBeenCalledTimes(2);
    // A did not stamp (only 2 queries: SELECT + equipment); B stamped (SELECT + equipment for A + equipment for B + UPDATE for B = 4)
    // The order is: SELECT, equipmentA, (fail — no stamp), equipmentB, stamp
    expect(poolQuery).toHaveBeenCalledTimes(4);
  });

  it('short-circuits when no rows are unnotified', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await runInspectionAssignmentPoll();
    expect(sendButtonMessage).not.toHaveBeenCalled();
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });
});
