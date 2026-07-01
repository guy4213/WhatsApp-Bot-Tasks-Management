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
} from '../services/incomingLeads';

const EMPTY = { rowCount: 0, rows: [] };

// ── findUnassignedInWindow ────────────────────────────────────────────────────

describe('findUnassignedInWindow', () => {
  it('queries IncomingLead WHERE ownerId IS NULL AND receivedAt in [from,to)', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    const from = new Date('2026-06-30T14:00:00Z');
    const to   = new Date('2026-07-01T06:30:00Z');
    await findUnassignedInWindow(from, to);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"IncomingLead"/);
    expect(sql).toMatch(/"ownerId"\s+IS\s+NULL/);
    expect(sql).toMatch(/"receivedAt"\s*>=\s*\$1/);
    expect(sql).toMatch(/"receivedAt"\s*<\s*\$2/);
    expect(params).toEqual([from, to]);
  });
});

// ── findOvernightUnassignedLeads ─────────────────────────────────────────────

describe('findOvernightUnassignedLeads', () => {
  it('queries ownerId IS NULL, receivedAt in overnight window, orders by receivedAt', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await findOvernightUnassignedLeads('2026-07-01');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"IncomingLead"/);
    expect(sql).toMatch(/"ownerId"\s+IS\s+NULL/);
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Jerusalem'/);
    expect(sql).toMatch(/17:00/);
    expect(sql).toMatch(/09:30/);
    expect(sql).toMatch(/ORDER BY\s+"receivedAt"/);
    expect(params).toEqual(['2026-07-01']);
  });
});

// ── findNewlyAssignedLeads ────────────────────────────────────────────────────

describe('findNewlyAssignedLeads', () => {
  it('JOINs User, filters ownerId NOT NULL, role != ADMIN, and WLN NOT EXISTS', async () => {
    poolQuery.mockResolvedValueOnce(EMPTY);
    await findNewlyAssignedLeads();
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/"IncomingLead"\s+il/);
    expect(sql).toMatch(/JOIN\s+"User"\s+u\s+ON\s+u\.id\s*=\s*il\."ownerId"/);
    expect(sql).toMatch(/il\."ownerId"\s+IS\s+NOT\s+NULL/);
    expect(sql).toMatch(/u\.role\s*!=\s*'ADMIN'/);
    expect(sql).toMatch(/NOT\s+EXISTS/);
    expect(sql).toMatch(/"WhatsappLeadNotification"/);
    expect(sql).toMatch(/'ASSIGNED_TO_WORKER'/);
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
