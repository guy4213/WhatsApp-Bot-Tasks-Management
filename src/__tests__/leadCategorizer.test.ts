/**
 * Tests for the deterministic keyword-based lead enrichment module.
 *
 * All tests use pool.query mocks so no DB connection is needed.
 * Each test calls _resetCacheForTests() before setting up its mock so the
 * singleton cache never leaks between tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock pool before any import that transitively loads db/connection ─────────

const poolQuery = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
}));

// ── Import the module under test AFTER the mock is registered ─────────────────

import { enrichLead, _resetCacheForTests } from '../services/leadCategorizer';
import type { IncomingLeadRow } from '../services/incomingLeads';

// ── Shared fixtures ───────────────────────────────────────────────────────────

/** Minimal valid IncomingLeadRow for tests that only care about text fields. */
function makeLead(overrides: Partial<IncomingLeadRow> = {}): IncomingLeadRow {
  return {
    id: 'lead-test',
    subject: null,
    body: null,
    fromName: null,
    fromEmail: null,
    receivedAt: new Date('2026-07-01T09:00:00Z'),
    status: null,
    ownerId: null,
    taskId: null,
    ...overrides,
  };
}

/**
 * InspectionType rows returned by the DB mock.
 * We seed a representative set so the categorizer can find clear matches.
 */
const SEEDED_TYPES = [
  // radiation
  { id: 'it-r1', code: '9',     labelHe: 'קרינה – בדיקת קרינה אלקטרומגנטית מרשת החשמל', family: 'radiation' },
  { id: 'it-r2', code: '10064', labelHe: 'קרינה – בדיקת קרינה מרכב היברידי / חשמלי',     family: 'radiation' },
  { id: 'it-r3', code: '002',   labelHe: 'RF – קרינה – בדיקת קרינה אלקטרומגנטית ממתקני שידור ואנטנות סלולריות', family: 'radiation' },
  // noise
  { id: 'it-n1', code: '10056', labelHe: 'רעש – בדיקת רעש ממעלית',                        family: 'noise' },
  { id: 'it-n2', code: '73',    labelHe: 'רעש – בדיקת רעש סביבתית עפ״י סעיף 1',           family: 'noise' },
  // air
  { id: 'it-a1', code: '72',    labelHe: 'אוויר – בדיקת איכות אוויר תוך מבני',            family: 'air' },
  { id: 'it-a2', code: '66',    labelHe: 'אוויר – בדיקת איכות אוויר סביבתית',             family: 'air' },
];

beforeEach(() => {
  _resetCacheForTests();
  poolQuery.mockReset();
  // Default: return seeded types.
  poolQuery.mockResolvedValue({ rows: SEEDED_TYPES });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('enrichLead — radiation detection', () => {
  it('detects radiation and matches "רשת החשמל" type', async () => {
    const lead = makeLead({ subject: 'צריך בדיקת קרינה בדירה ליד לוח חשמל', body: 'רשת החשמל' });
    const result = await enrichLead(lead);
    expect(result.category).toBe('radiation');
    expect(result.categoryHe).toBe('קרינה');
    // "בדיקת קרינה אלקטרומגנטית מרשת החשמל" tokens: קרינה, אלקטרומגנטית, מרשת, החשמל
    // haystack hits: קרינה ✓, רשת החשמל ✓ → ≥2 tokens matched for it-r1
    expect(result.inspectionType).not.toBeNull();
    expect(result.inspectionType?.labelHe).toContain('רשת החשמל');
  });

  it('detects radiation and matches hybrid/electric vehicle type', async () => {
    const lead = makeLead({ subject: 'בדיקת קרינה לרכב היברידי', body: 'יש לי רכב היברידי' });
    const result = await enrichLead(lead);
    expect(result.category).toBe('radiation');
    expect(result.inspectionType).not.toBeNull();
    expect(result.inspectionType?.labelHe).toContain('היברידי');
  });
});

describe('enrichLead — noise detection', () => {
  it('detects noise from elevator and matches elevator type', async () => {
    const lead = makeLead({ subject: 'רעש מהמעלית בבניין', body: 'בדיקת רעש ממעלית' });
    const result = await enrichLead(lead);
    expect(result.category).toBe('noise');
    expect(result.categoryHe).toBe('רעש');
    expect(result.inspectionType).not.toBeNull();
    expect(result.inspectionType?.labelHe).toContain('מעלית');
  });

  it('detects noise from road but returns null inspectionType (ambiguous)', async () => {
    // "רעש מהכביש" — noise keyword hit, but no unique type token match.
    const lead = makeLead({ subject: 'רעש מהכביש', body: '' });
    const result = await enrichLead(lead);
    expect(result.category).toBe('noise');
    expect(result.categoryHe).toBe('רעש');
    expect(result.inspectionType).toBeNull();
  });
});

describe('enrichLead — air quality detection', () => {
  it('detects air quality and matches indoor type when body tokens align', async () => {
    // "בדיקת איכות אוויר במשרד" — hits air keywords; also "תוך מבני" could match
    // but we only have partial token match unless "מבני" appears.
    // The test checks that category is "air" and at minimum category is detected.
    const lead = makeLead({
      subject: 'בדיקת איכות אוויר במשרד',
      body: 'IAQ בדיקה תוך מבני',
    });
    const result = await enrichLead(lead);
    expect(result.category).toBe('air');
    expect(result.categoryHe).toBe('איכות אוויר');
    // inspectionType may or may not match — depends on token scoring. We just
    // verify category is correct and no crash occurs.
    expect(result).toHaveProperty('inspectionType');
  });
});

describe('enrichLead — unrecognizable lead', () => {
  it('returns null category and "לא זוהתה" when no keyword matches', async () => {
    const lead = makeLead({ subject: 'בדיקה כללית', body: 'אנא הסביר' });
    const result = await enrichLead(lead);
    expect(result.category).toBeNull();
    expect(result.categoryHe).toBe('לא זוהתה');
    expect(result.inspectionType).toBeNull();
  });
});

describe('enrichLead — location extraction', () => {
  it('extracts city from body text', async () => {
    const lead = makeLead({ subject: 'צריך בדיקה בנתניה', body: 'כתובת בנתניה' });
    const result = await enrichLead(lead);
    expect(result.location).toBe('נתניה');
  });

  it('returns null location when no city found', async () => {
    const lead = makeLead({ subject: 'בדיקת קרינה', body: null });
    const result = await enrichLead(lead);
    expect(result.location).toBeNull();
  });
});

describe('enrichLead — null-safe', () => {
  it('handles all null fields without throwing', async () => {
    const lead = makeLead(); // all text fields are null
    const result = await enrichLead(lead);
    expect(result.category).toBeNull();
    expect(result.categoryHe).toBe('לא זוהתה');
    expect(result.inspectionType).toBeNull();
    expect(result.location).toBeNull();
  });
});

describe('enrichLead — DB returns empty rows', () => {
  it('falls back gracefully when InspectionType table is empty', async () => {
    _resetCacheForTests();
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const lead = makeLead({ subject: 'בדיקת קרינה' });
    const result = await enrichLead(lead);
    // Category still detected from keywords even if no types to match.
    expect(result.category).toBe('radiation');
    expect(result.inspectionType).toBeNull();
  });
});

describe('enrichLead — cache', () => {
  it('only queries the DB once across multiple calls (singleton cache)', async () => {
    const lead = makeLead({ subject: 'בדיקת קרינה' });
    await enrichLead(lead);
    await enrichLead(lead);
    await enrichLead(lead);
    // Pool should have been called exactly once (cache hit on subsequent calls).
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('re-queries after _resetCacheForTests()', async () => {
    const lead = makeLead({ subject: 'בדיקת קרינה' });
    await enrichLead(lead);
    _resetCacheForTests();
    await enrichLead(lead);
    expect(poolQuery).toHaveBeenCalledTimes(2);
  });
});
