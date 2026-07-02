/**
 * D2-T7 + D2-T8 — inspection write helpers, open-TaskField resolver, and
 * problem-type sub-menu builder.
 *
 * Coverage:
 *  - writeMissingInfo — builds the correct UPDATE (fields, params, WHERE id),
 *    parameterized.
 *  - writeProblem — for each of the 7 FIELD_PROBLEM_TYPES, plus one with a note
 *    and one without.
 *  - findOpenTaskFieldForWorker — 0 / 1 / N result cases.
 *  - problemTypeMenu — 7 items with the correct CHECK-matching machine values
 *    and Hebrew labels; renderProblemTypeMenu formats a numbered menu.
 *  - notifyOfficeMissingInfo / notifyOfficeProblem — office alert is broadcast
 *    to every active MANAGER/ADMIN, or logs a warning when nobody is configured
 *    (the write helper already stamped `managerNotifiedAt`, so no-op is fine).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks — pool, sender, managers ──────────────────────────────────────────

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../whatsapp/sender', () => ({
  sendTextMessage:   (...args: unknown[]) => sendTextMessage(...args),
  sendButtonMessage: vi.fn().mockResolvedValue(undefined),
  sendListMessage:   vi.fn().mockResolvedValue(undefined),
}));

const getManagersForBroadcast = vi.fn().mockResolvedValue([]);
vi.mock('../services/pendingActions', () => ({
  getManagersForBroadcast: (...args: unknown[]) => getManagersForBroadcast(...args),
}));

beforeEach(() => {
  poolQuery.mockReset();
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue(undefined);
  getManagersForBroadcast.mockReset();
  getManagersForBroadcast.mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

import {
  writeMissingInfo,
  writeProblem,
  findOpenTaskFieldForWorker,
  notifyOfficeMissingInfo,
  notifyOfficeProblem,
  advanceFieldStatus,
  writeFieldNotes,
  resolveOpenTaskFieldByHint,
} from '../services/inspections';
import { problemTypeMenu, renderProblemTypeMenu } from '../ai/menu';
import { FIELD_PROBLEM_TYPES } from '../ai/schema';
import type { FieldProblemType } from '../types';

// ── problemTypeMenu ─────────────────────────────────────────────────────────

describe('problemTypeMenu', () => {
  it('returns exactly 7 items numbered 1..7', () => {
    const items = problemTypeMenu();
    expect(items).toHaveLength(7);
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('every problemType is one of the 7 CHECK values from migration 009', () => {
    const allowed = new Set<string>(FIELD_PROBLEM_TYPES);
    for (const item of problemTypeMenu()) {
      expect(allowed.has(item.problemType)).toBe(true);
    }
    // …and every CHECK value appears in the menu.
    const inMenu = new Set(problemTypeMenu().map((i) => i.problemType));
    for (const v of FIELD_PROBLEM_TYPES) expect(inMenu.has(v)).toBe(true);
  });

  it('has Hebrew labels matching SPEC_FIELD_V2 §9 order', () => {
    const items = problemTypeMenu();
    expect(items.map((i) => i.label)).toEqual([
      'הלקוח לא ענה',
      'אין גישה',
      'הלקוח לא נמצא',
      'חסר ציוד',
      'לא ניתן לבצע',
      'בעיה מקצועית',
      'אחר',
    ]);
  });

  it('renderProblemTypeMenu formats a numbered sub-menu with a Hebrew prompt', () => {
    const text = renderProblemTypeMenu();
    expect(text).toContain('בחר סוג בעיה:');
    for (const item of problemTypeMenu()) {
      expect(text).toContain(`${item.n}. ${item.label}`);
    }
  });
});

// ── writeMissingInfo ────────────────────────────────────────────────────────

describe('writeMissingInfo', () => {
  it('UPDATEs TaskField with WAITING_FOR_INFO + note + managerNotifiedAt + updatedByUserId, parameterized', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await writeMissingInfo({ taskFieldId: 'tf-1', note: 'חסר טופס דגימה', updatedBy: 'u-9' });

    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    // WHERE + core column writes
    expect(sql).toMatch(/UPDATE\s+"TaskField"/);
    expect(sql).toMatch(/"fieldStatus"\s*=\s*'WAITING_FOR_INFO'/);
    expect(sql).toMatch(/"missingReportInfo"\s*=\s*true/);
    expect(sql).toMatch(/"missingReportInfoNote"\s*=\s*\$2/);
    expect(sql).toMatch(/"managerNotifiedAt"\s*=\s*now\(\)/);
    expect(sql).toMatch(/"updatedByUserId"\s*=\s*\$3/);
    expect(sql).toMatch(/"updatedAt"\s*=\s*now\(\)/);
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1/);
    // parameterized — no string concatenation of user input
    expect(sql).not.toContain('tf-1');
    expect(sql).not.toContain('חסר טופס דגימה');
    expect(params).toEqual(['tf-1', 'חסר טופס דגימה', 'u-9']);
  });
});

// ── writeProblem ────────────────────────────────────────────────────────────

describe('writeProblem', () => {
  it.each(FIELD_PROBLEM_TYPES)(
    'writes problemType=%s with fieldStatus=HAS_PROBLEM + hasOpenProblem=true',
    async (problemType) => {
      poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
      await writeProblem({
        taskFieldId: 'tf-x',
        problemType: problemType as FieldProblemType,
        note: null,
        updatedBy: 'u-1',
      });
      const [sql, params] = poolQuery.mock.calls[0];
      expect(sql).toMatch(/UPDATE\s+"TaskField"/);
      expect(sql).toMatch(/"problemType"\s*=\s*\$2/);
      expect(sql).toMatch(/"problemNote"\s*=\s*\$3/);
      expect(sql).toMatch(/"hasOpenProblem"\s*=\s*true/);
      expect(sql).toMatch(/"fieldStatus"\s*=\s*'HAS_PROBLEM'/);
      expect(sql).toMatch(/"managerNotifiedAt"\s*=\s*now\(\)/);
      expect(sql).toMatch(/"updatedByUserId"\s*=\s*\$4/);
      expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1/);
      expect(params).toEqual(['tf-x', problemType, null, 'u-1']);
    },
  );

  it('persists a note when supplied (PROFESSIONAL_ISSUE / OTHER path)', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await writeProblem({
      taskFieldId: 'tf-2',
      problemType: 'PROFESSIONAL_ISSUE',
      note: 'לא מצליח למדוד רעש רקע',
      updatedBy: 'u-1',
    });
    const [, params] = poolQuery.mock.calls[0];
    expect(params).toEqual(['tf-2', 'PROFESSIONAL_ISSUE', 'לא מצליח למדוד רעש רקע', 'u-1']);
  });
});

// ── findOpenTaskFieldForWorker ───────────────────────────────────────────────

describe('findOpenTaskFieldForWorker', () => {
  it('returns null when the worker has no open TaskField', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await findOpenTaskFieldForWorker('u-9');
    expect(res).toBeNull();
  });

  it('returns { taskFieldId, customerName } when exactly one open TaskField exists', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ taskFieldId: 'tf-1', customerName: 'משה כהן' }],
    });
    const res = await findOpenTaskFieldForWorker('u-9');
    expect(res).toEqual({ taskFieldId: 'tf-1', customerName: 'משה כהן' });
  });

  it('returns { ambiguous, count } when more than one open TaskField exists', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 3,
      rows: [
        { taskFieldId: 'tf-a', customerName: 'א' },
        { taskFieldId: 'tf-b', customerName: 'ב' },
        { taskFieldId: 'tf-c', customerName: 'ג' },
      ],
    });
    const res = await findOpenTaskFieldForWorker('u-9');
    expect(res).toEqual({ ambiguous: true, count: 3 });
  });

  it('filters by Task.ownerId (the CRM column) and the 6 open fieldStatus values', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await findOpenTaskFieldForWorker('u-worker-42');
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"ownerId"\s*=\s*\$1/);
    expect(sql).toMatch(/"fieldStatus"\s*=\s*ANY\(\$2::text\[\]\)/);
    expect(params[0]).toBe('u-worker-42');
    // The status list contains the 6 open statuses spec §7 defines pre-terminal.
    const statuses = params[1] as readonly string[];
    for (const s of ['ASSIGNED', 'CONFIRMED', 'EN_ROUTE', 'ARRIVED', 'WAITING_FOR_INFO', 'NEEDS_MORE_INFO']) {
      expect(statuses).toContain(s);
    }
    // The office-terminal statuses must NOT be in the "open" list.
    for (const s of ['DECLINED', 'FINISHED_FIELD', 'HAS_PROBLEM', 'CANCELED']) {
      expect(statuses).not.toContain(s);
    }
  });
});

// ── notifyOfficeMissingInfo / notifyOfficeProblem ─────────────────────────────

describe('notifyOfficeMissingInfo', () => {
  it('reads TaskField+Task+Customer+InspectionType context and broadcasts to every active manager', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        workerName: 'דני',
        familyLabelHe: 'בדיקת רעש',
        customerName: 'משה כהן',
        siteCity: 'הרצליה',
        missingReportInfoNote: 'חסר מספר היתר בנייה',
        problemType: null,
        problemNote: null,
      }],
    });
    getManagersForBroadcast.mockResolvedValueOnce([
      { id: 'm-1', name: 'יורם', phone: '972500000001' },
      { id: 'm-2', name: 'סשה', phone: '972500000002' },
    ]);

    await notifyOfficeMissingInfo('tf-abc');

    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    const bodies = sendTextMessage.mock.calls.map((c) => c[0].text);
    expect(bodies[0]).toContain('חסר מידע לדוח');
    expect(bodies[0]).toContain('דני');
    expect(bodies[0]).toContain('בדיקת רעש');
    expect(bodies[0]).toContain('משה כהן');
    expect(bodies[0]).toContain('הרצליה');
    expect(bodies[0]).toContain('חסר מספר היתר בנייה');
  });

  it('logs a warning + no-ops when no active managers are configured', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        workerName: 'דני', familyLabelHe: 'רעש', customerName: null,
        siteCity: null, missingReportInfoNote: 'x', problemType: null, problemNote: null,
      }],
    });
    getManagersForBroadcast.mockResolvedValueOnce([]);
    await notifyOfficeMissingInfo('tf-abc');
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});

// ── advanceFieldStatus (D2-T5) ──────────────────────────────────────────────

describe('advanceFieldStatus', () => {
  it('DEPARTED → UPDATE fieldStatus=EN_ROUTE + departedAt + updatedByUserId, parameterized', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await advanceFieldStatus({ taskFieldId: 'tf-a', transition: 'DEPARTED', updatedBy: 'u-1' });
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE\s+"TaskField"/);
    expect(sql).toMatch(/"fieldStatus"\s*=\s*'EN_ROUTE'/);
    expect(sql).toMatch(/"departedAt"\s*=\s*now\(\)/);
    expect(sql).toMatch(/"updatedByUserId"\s*=\s*\$2/);
    expect(sql).toMatch(/"updatedAt"\s*=\s*now\(\)/);
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1/);
    // Sibling timestamps must NOT be touched on DEPARTED.
    expect(sql).not.toMatch(/"arrivedAt"\s*=/);
    expect(sql).not.toMatch(/"finishedAt"\s*=/);
    expect(params).toEqual(['tf-a', 'u-1']);
  });

  it('ARRIVED → UPDATE fieldStatus=ARRIVED + arrivedAt, parameterized', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await advanceFieldStatus({ taskFieldId: 'tf-b', transition: 'ARRIVED', updatedBy: 'u-2' });
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"fieldStatus"\s*=\s*'ARRIVED'/);
    expect(sql).toMatch(/"arrivedAt"\s*=\s*now\(\)/);
    expect(sql).not.toMatch(/"departedAt"\s*=/);
    expect(sql).not.toMatch(/"finishedAt"\s*=/);
    expect(params).toEqual(['tf-b', 'u-2']);
  });

  it('FINISHED → UPDATE fieldStatus=FINISHED_FIELD + finishedAt, UNCONDITIONAL (no current-status guard)', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await advanceFieldStatus({ taskFieldId: 'tf-c', transition: 'FINISHED', updatedBy: 'u-3' });
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"fieldStatus"\s*=\s*'FINISHED_FIELD'/);
    expect(sql).toMatch(/"finishedAt"\s*=\s*now\(\)/);
    expect(sql).not.toMatch(/"departedAt"\s*=/);
    expect(sql).not.toMatch(/"arrivedAt"\s*=/);
    // Only WHERE id = $1 — no extra AND on current fieldStatus.
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1\s*$/m);
    expect(sql).not.toMatch(/AND\s+"fieldStatus"/);
    expect(params).toEqual(['tf-c', 'u-3']);
  });
});

// ── writeFieldNotes (D2-T6) ─────────────────────────────────────────────────

describe('writeFieldNotes', () => {
  it('writes fieldNotes + updatedByUserId + updatedAt only — does not touch fieldStatus', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await writeFieldNotes({ taskFieldId: 'tf-x', notes: 'הלקוח ביקש חזרה', updatedBy: 'u-1' });
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE\s+"TaskField"/);
    expect(sql).toMatch(/"fieldNotes"\s*=\s*\$2/);
    expect(sql).toMatch(/"updatedByUserId"\s*=\s*\$3/);
    expect(sql).toMatch(/"updatedAt"\s*=\s*now\(\)/);
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1/);
    // These must NOT be modified — the inspection is already FINISHED_FIELD.
    expect(sql).not.toMatch(/"fieldStatus"\s*=/);
    expect(sql).not.toMatch(/"finishedAt"\s*=/);
    expect(sql).not.toMatch(/"managerNotifiedAt"\s*=/);
    expect(params).toEqual(['tf-x', 'הלקוח ביקש חזרה', 'u-1']);
  });
});

// ── resolveOpenTaskFieldByHint (D2-T5) ──────────────────────────────────────

describe('resolveOpenTaskFieldByHint', () => {
  it('returns null when no TaskField matches the hint', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await resolveOpenTaskFieldByHint('u-9', 'כהן');
    expect(res).toBeNull();
  });

  it('returns { taskFieldId, customerName } on a unique match', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ taskFieldId: 'tf-1', customerName: 'משה כהן' }],
    });
    const res = await resolveOpenTaskFieldByHint('u-9', 'כהן');
    expect(res).toEqual({ taskFieldId: 'tf-1', customerName: 'משה כהן' });
  });

  it('returns { ambiguous, count } when >1 TaskField matches', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 2,
      rows: [
        { taskFieldId: 'tf-a', customerName: 'כהן א' },
        { taskFieldId: 'tf-b', customerName: 'כהן ב' },
      ],
    });
    const res = await resolveOpenTaskFieldByHint('u-9', 'כהן');
    expect(res).toEqual({ ambiguous: true, count: 2 });
  });

  it('uses ILIKE (case-insensitive) on Customer.name OR siteAddress, parameterized', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await resolveOpenTaskFieldByHint('u-w', 'raanana');
    const [sql, params] = poolQuery.mock.calls[0];
    // Both fields checked with ILIKE.
    expect(sql).toMatch(/c\.name\s+ILIKE/i);
    expect(sql).toMatch(/tf\."siteAddress"\s+ILIKE/i);
    // Parameterized — user input never inlined into SQL.
    expect(sql).not.toContain('raanana');
    expect(sql).toMatch(/'%'\s*\|\|\s*\$2\s*\|\|\s*'%'/);
    // Same open-status list as findOpenTaskFieldForWorker.
    expect(sql).toMatch(/"fieldStatus"\s*=\s*ANY\(\$3::text\[\]\)/);
    expect(params[0]).toBe('u-w');
    expect(params[1]).toBe('raanana');
    const statuses = params[2] as readonly string[];
    for (const s of ['ASSIGNED', 'CONFIRMED', 'EN_ROUTE', 'ARRIVED', 'WAITING_FOR_INFO', 'NEEDS_MORE_INFO']) {
      expect(statuses).toContain(s);
    }
  });

  it('empty / whitespace-only hint short-circuits to null (no DB call)', async () => {
    const res1 = await resolveOpenTaskFieldByHint('u-9', '');
    const res2 = await resolveOpenTaskFieldByHint('u-9', '   ');
    expect(res1).toBeNull();
    expect(res2).toBeNull();
    expect(poolQuery).not.toHaveBeenCalled();
  });
});

describe('notifyOfficeProblem', () => {
  it('renders the spec §9 alert (בעיה מהשטח + type label + note)', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        workerName: 'דני',
        familyLabelHe: 'בדיקת רעש',
        customerName: 'משה כהן',
        siteCity: 'הרצליה',
        missingReportInfoNote: null,
        problemType: 'PROFESSIONAL_ISSUE' as FieldProblemType,
        problemNote: 'לא ניתן לבצע מדידה בגלל עבודות בנייה במקום.',
      }],
    });
    getManagersForBroadcast.mockResolvedValueOnce([
      { id: 'm-1', name: 'יורם', phone: '972500000001' },
    ]);

    await notifyOfficeProblem('tf-x');

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const body = sendTextMessage.mock.calls[0][0].text;
    expect(body).toContain('בעיה מהשטח');
    expect(body).toContain('דני');
    expect(body).toContain('בדיקת רעש');
    expect(body).toContain('משה כהן');
    expect(body).toContain('הרצליה');
    expect(body).toContain('בעיה מקצועית'); // the Hebrew label for PROFESSIONAL_ISSUE
    expect(body).toContain('לא ניתן לבצע מדידה');
    expect(body).toContain('לטיפול מנהל.');
  });
});

// ── notifyOfficeMissingEquipment (D2-T9) ───────────────────────────────────

describe('notifyOfficeMissingEquipment', () => {
  it('broadcasts a §10 alert with worker name + date + note to every manager', async () => {
    getManagersForBroadcast.mockResolvedValue([
      { id: 'm-1', name: 'מ1', phone: '972500000001' },
      { id: 'm-2', name: 'מ2', phone: '972500000002' },
    ]);
    const { notifyOfficeMissingEquipment } = await import('../services/inspections');

    await notifyOfficeMissingEquipment({
      userId: 'u-1',
      userName: 'דני',
      note: 'חסר מד רעש',
      localDate: '2026-07-01',
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    for (const call of sendTextMessage.mock.calls) {
      const body = call[0].text;
      expect(body).toContain('חסר ציוד לבוקר');
      expect(body).toContain('דני');
      expect(body).toContain('2026-07-01');
      expect(body).toContain('חסר מד רעש');
      expect(body).toContain('לטיפול המשרד.');
    }
  });

  it('degrades gracefully when userName is null (worker fallback "—")', async () => {
    getManagersForBroadcast.mockResolvedValue([
      { id: 'm-1', name: 'מ1', phone: '972500000001' },
    ]);
    const { notifyOfficeMissingEquipment } = await import('../services/inspections');

    await notifyOfficeMissingEquipment({
      userId: 'u-1',
      userName: null,
      note: 'חסר X',
      localDate: '2026-07-01',
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][0].text).toContain('שם עובד: —');
  });

  it('no-ops when no MANAGER/ADMIN is configured (logs a warning, does not throw)', async () => {
    getManagersForBroadcast.mockResolvedValue([]);
    const { notifyOfficeMissingEquipment } = await import('../services/inspections');

    await expect(
      notifyOfficeMissingEquipment({
        userId: 'u-1',
        userName: 'דני',
        note: 'חסר',
        localDate: '2026-07-01',
      }),
    ).resolves.toBeUndefined();
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});

// ── D2-T3: confirmInspection / declineInspection / requestMoreInfo ──────────

describe('confirmInspection', () => {
  it('writes CONFIRMED + confirmedAt, parameterized', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const { confirmInspection } = await import('../services/inspections');
    await confirmInspection({ taskFieldId: 'tf-1', updatedBy: 'u-9' });
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE\s+"TaskField"/);
    expect(sql).toMatch(/"fieldStatus"\s*=\s*'CONFIRMED'/);
    expect(sql).toMatch(/"confirmedAt"\s*=\s*now\(\)/);
    expect(sql).toMatch(/"updatedByUserId"\s*=\s*\$2/);
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1/);
    expect(params).toEqual(['tf-1', 'u-9']);
  });
});

describe('declineInspection', () => {
  it('writes DECLINED + declinedAt + declinedReason, parameterized', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const { declineInspection } = await import('../services/inspections');
    await declineInspection({ taskFieldId: 'tf-2', reason: 'הרכב במוסך', updatedBy: 'u-9' });
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"fieldStatus"\s*=\s*'DECLINED'/);
    expect(sql).toMatch(/"declinedAt"\s*=\s*now\(\)/);
    expect(sql).toMatch(/"declinedReason"\s*=\s*\$2/);
    expect(sql).toMatch(/"updatedByUserId"\s*=\s*\$3/);
    expect(params).toEqual(['tf-2', 'הרכב במוסך', 'u-9']);
  });
});

describe('requestMoreInfo', () => {
  it('writes NEEDS_MORE_INFO + fieldNotes + managerNotifiedAt, parameterized', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const { requestMoreInfo } = await import('../services/inspections');
    await requestMoreInfo({ taskFieldId: 'tf-3', note: 'צריך אישור כניסה', updatedBy: 'u-9' });
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"fieldStatus"\s*=\s*'NEEDS_MORE_INFO'/);
    expect(sql).toMatch(/"fieldNotes"\s*=\s*\$2/);
    expect(sql).toMatch(/"managerNotifiedAt"\s*=\s*now\(\)/);
    expect(sql).toMatch(/"updatedByUserId"\s*=\s*\$3/);
    expect(params).toEqual(['tf-3', 'צריך אישור כניסה', 'u-9']);
  });
});

describe('notifyOfficeDeclined', () => {
  it('broadcasts a §6 alert with worker + type + customer + reason', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        workerName: 'דני',
        familyLabelHe: 'בדיקת קרינה',
        customerName: 'משה כהן',
        siteCity: 'רעננה',
        missingReportInfoNote: null,
        problemType: null,
        problemNote: null,
      }],
    });
    getManagersForBroadcast.mockResolvedValueOnce([
      { id: 'm-1', name: 'יורם', phone: '972500000001' },
    ]);
    const { notifyOfficeDeclined } = await import('../services/inspections');

    await notifyOfficeDeclined('tf-x', 'הרכב במוסך');

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const body = sendTextMessage.mock.calls[0][0].text;
    expect(body).toContain('בדיקה סורבה');
    expect(body).toContain('דני');
    expect(body).toContain('בדיקת קרינה');
    expect(body).toContain('משה כהן');
    expect(body).toContain('רעננה');
    expect(body).toContain('סיבה: הרכב במוסך');
    expect(body).toContain('יש לשבץ מחדש.');
  });
});

describe('notifyOfficeNeedsMoreInfo', () => {
  it('broadcasts a §6 alert with worker + customer + note', async () => {
    poolQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        workerName: 'דני',
        familyLabelHe: 'בדיקת רעש',
        customerName: 'משה כהן',
        siteCity: 'הרצליה',
        missingReportInfoNote: null,
        problemType: null,
        problemNote: null,
      }],
    });
    getManagersForBroadcast.mockResolvedValueOnce([
      { id: 'm-1', name: 'יורם', phone: '972500000001' },
    ]);
    const { notifyOfficeNeedsMoreInfo } = await import('../services/inspections');

    await notifyOfficeNeedsMoreInfo('tf-y', 'צריך אישור כניסה');

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const body = sendTextMessage.mock.calls[0][0].text;
    expect(body).toContain('בקשת פרטים נוספים לבדיקה');
    expect(body).toContain('דני');
    expect(body).toContain('משה כהן');
    expect(body).toContain('צריך אישור כניסה');
    expect(body).toContain('לטיפול המשרד.');
  });
});
