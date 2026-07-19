/**
 * D3-T1 — IncomingLead reader service query shapes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

beforeEach(() => { poolQuery.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

import {
  findUnassignedInWindow,
  findOvernightUnassignedLeads,
  findNewlyAssignedLeads,
  findEscalationCandidates,
  findActiveInspectors,
  getYoramLeadCounts,
} from '../services/incomingLeads';

const EMPTY = { rowCount: 0, rows: [] };

// ── findUnassignedInWindow ────────────────────────────────────────────────────

describe('findUnassignedInWindow', () => {
  // Pending = status='NEW' (product truth: status wins over ownerId).
  it('queries IncomingLead WHERE status=NEW AND receivedAt in [from,to)', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    const from = new Date('2026-06-30T14:00:00Z');
    const to   = new Date('2026-07-01T06:30:00Z');
    await findUnassignedInWindow(from, to);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"IncomingLead"/);
    expect(sql).toMatch(/status\s*=\s*'NEW'/);
    expect(sql).not.toMatch(/"ownerId"\s+IS\s+NULL/);
    expect(sql).toMatch(/"receivedAt"\s*>=\s*\$1/);
    expect(sql).toMatch(/"receivedAt"\s*<\s*\$2/);
    expect(params).toEqual([from, to]);
  });
});

// ── findOvernightUnassignedLeads ─────────────────────────────────────────────

describe('findOvernightUnassignedLeads', () => {
  it('queries status=NEW, receivedAt in overnight window, orders by receivedAt', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await findOvernightUnassignedLeads('2026-07-01');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"IncomingLead"/);
    expect(sql).toMatch(/status\s*=\s*'NEW'/);
    expect(sql).not.toMatch(/"ownerId"\s+IS\s+NULL/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(sql).toMatch(/17:00/);
    expect(sql).toMatch(/09:30/);
    expect(sql).toMatch(/ORDER BY\s+"receivedAt"/);
    expect(params).toEqual(['2026-07-01']);
  });
});

// ── findNewlyAssignedLeads ────────────────────────────────────────────────────

describe('findNewlyAssignedLeads', () => {
  it('JOINs User, filters status=ACTIVE + ownerId NOT NULL + role != ADMIN + PENDING/SENT-aware NOT EXISTS', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await findNewlyAssignedLeads();
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"IncomingLead"\s+il/);
    expect(sql).toMatch(/JOIN\s+"User"\s+u\s+ON\s+u\.id\s*=\s*il\."ownerId"/);
    // status='ACTIVE' predicate — signals CRM ownership transition
    expect(sql).toMatch(/il\.status\s*=\s*'ACTIVE'/);
    expect(sql).toMatch(/il\."ownerId"\s+IS\s+NOT\s+NULL/);
    expect(sql).toMatch(/u\.role\s*!=\s*'ADMIN'/);
    expect(sql).toMatch(/NOT\s+EXISTS/);
    expect(sql).toMatch(/"WhatsappLeadNotification"/);
    expect(sql).toMatch(/'ASSIGNED_TO_WORKER'/);
    // PENDING/SENT filter: skip if SENT OR PENDING < 5 minutes
    expect(sql).toMatch(/status"?\s*=\s*'SENT'/);
    expect(sql).toMatch(/interval\s+'5 minutes'/);
    expect(sql).toMatch(/ORDER BY\s+il\."receivedAt"/);
    expect(params).toEqual([50]);
  });

  it('honours explicit limit', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await findNewlyAssignedLeads(5);
    expect(poolQuery.mock.calls[0][1]).toEqual([5]);
  });
});

// ── findEscalationCandidates ──────────────────────────────────────────────────

describe('findEscalationCandidates', () => {
  it('filters ownerId NULL, >1h old, 09:30-22:00 window, WLN NOT EXISTS', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await findEscalationCandidates();
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"IncomingLead"/);
    expect(sql).toMatch(/"ownerId"\s+IS\s+NULL/);
    expect(sql).toMatch(/interval\s+'1 hour'/);
    expect(sql).toMatch(/09:30/);
    expect(sql).toMatch(/22:00/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(sql).toMatch(/NOT\s+EXISTS/);
    expect(sql).toMatch(/'ESCALATED_1H'/);
    expect(params).toEqual([50]);
  });
});

// ── findActiveInspectors ──────────────────────────────────────────────────────

describe('findActiveInspectors', () => {
  it('selects active non-ADMIN users with phone', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 2, rows: [
      { id: 'u1', name: 'דני', role: 'WORKER' },
      { id: 'u2', name: 'יוסי', role: 'TECHNICIAN' },
    ]});
    const result = await findActiveInspectors();
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/FROM\s+"User"/);
    expect(sql).toMatch(/role\s*!=\s*'ADMIN'/);
    expect(sql).toMatch(/ACTIVE/);
    expect(sql).toMatch(/phone\s+IS\s+NOT\s+NULL/);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('u1');
  });
});

// ── getYoramLeadCounts ────────────────────────────────────────────────────────

describe('getYoramLeadCounts', () => {
  // Product decision 2026-07-02: `overnight` counts ACTIONABLE overnight
  // leads only (received in the overnight window AND still unassigned) —
  // matches `findOvernightUnassignedLeads`. Raw arrival counts would mislead
  // a CEO reading the digest.
  it('returns overnight = received-overnight AND ownerId IS NULL (same predicate as Sasha list)', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ overnight: '2', unassigned: '3' }] });
    const result = await getYoramLeadCounts('2026-07-01');
    const [sql, params] = poolQuery.mock.calls[0];

    expect(sql).toMatch(/"IncomingLead"/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(sql).toMatch(/17:00/);
    expect(sql).toMatch(/09:30/);
    expect(sql).toMatch(/COUNT\(\*\)/i);

    // The overnight FILTER must combine BOTH predicates — the shared
    // "actionable overnight" definition. Regex covers whitespace-forgiving
    // multiline SQL.
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(\s*WHERE "ownerId" IS NULL[\s\S]+?"receivedAt"[\s\S]+?17:00[\s\S]+?09:30[\s\S]+?\)\s*AS overnight/);

    expect(params).toEqual(['2026-07-01']);
    expect(result).toEqual({ overnight: 2, unassigned: 3 });
  });

  // 4 product scenarios enumerated by the CEO product decision.
  it('scenario A — 2 overnight arrivals all assigned → overnight count = 0 (CEO sees no pending)', async () => {
    // DB returns 0 because the SQL filter has AND ownerId IS NULL.
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ overnight: '0', unassigned: '5' }] });
    const result = await getYoramLeadCounts('2026-07-01');
    expect(result.overnight).toBe(0);
  });

  it('scenario B — 3 overnight arrivals, 2 unassigned → overnight count = 2 (matches Sasha list length)', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ overnight: '2', unassigned: '8' }] });
    const result = await getYoramLeadCounts('2026-07-01');
    expect(result.overnight).toBe(2);
  });

  it('scenario C — 0 overnight pending → overnight count = 0 (no implied work)', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ overnight: '0', unassigned: '0' }] });
    const result = await getYoramLeadCounts('2026-07-01');
    expect(result.overnight).toBe(0);
  });

  it('scenario D — SQL window bounds exclude leads outside overnight window', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ overnight: '0', unassigned: '0' }] });
    await getYoramLeadCounts('2026-07-01');
    const [sql] = poolQuery.mock.calls[0];
    // Window bounds are LITERAL "17:00" (previous day) → "09:30" (today).
    // Anything outside must be excluded by SQL, not the caller.
    expect(sql).toMatch(/\(\$1::date - 1\)::timestamp \+ time '17:00:00'/);
    expect(sql).toMatch(/\$1::date::timestamp \+ time '09:30:00'/);
  });

  it('gracefully returns zeros when no rows come back (defensive guard)', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const result = await getYoramLeadCounts('2026-07-01');
    expect(result).toEqual({ overnight: 0, unassigned: 0 });
  });
});
