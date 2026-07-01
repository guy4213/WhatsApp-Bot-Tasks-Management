/**
 * D2-T9 — `getEquipmentChecklistForFamilies` query test (pool-mocked).
 *
 * We don't test the DB itself here (that's the integration suite gated by
 * RUN_DB_TESTS); this asserts the SQL shape + parameter binding + empty-input
 * short-circuit + result mapping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.hoisted(() => vi.fn());

vi.mock('../db/connection', () => ({
  pool: { query: poolQueryMock },
  supabaseAdmin: {},
}));

beforeEach(() => {
  poolQueryMock.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('getEquipmentChecklistForFamilies', () => {
  it('short-circuits on empty input (no DB call)', async () => {
    const { getEquipmentChecklistForFamilies } = await import('../services/inspectionsQueries');
    const rows = await getEquipmentChecklistForFamilies([]);
    expect(rows).toEqual([]);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('binds the families array as a single text[] parameter (no interpolation)', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const { getEquipmentChecklistForFamilies } = await import('../services/inspectionsQueries');
    await getEquipmentChecklistForFamilies(['radiation', 'noise']);
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(typeof sql).toBe('string');
    expect(sql).toContain('"InspectionChecklist"');
    expect(sql).toContain('family = ANY($1::text[])');
    // ORDER BY family + sortOrder — stable within a family block.
    expect(sql).toMatch(/ORDER BY\s+family\s+ASC,\s+"sortOrder"\s+ASC/i);
    expect(params).toEqual([['radiation', 'noise']]);
  });

  it('returns the pool rows verbatim (query maps aliases 1:1)', async () => {
    const dbRows = [
      { family: 'radiation', code: 'elf_meter', labelHe: 'מד ELF', isRequired: true, sortOrder: 1 },
      { family: 'noise',     code: 'noise_meter', labelHe: 'מד רעש', isRequired: true, sortOrder: 1 },
    ];
    poolQueryMock.mockResolvedValue({ rows: dbRows });
    const { getEquipmentChecklistForFamilies } = await import('../services/inspectionsQueries');
    const rows = await getEquipmentChecklistForFamilies(['radiation', 'noise']);
    expect(rows).toEqual(dbRows);
  });
});
