/**
 * D2-T9 — equipment reminder pure formatter tests.
 *
 * Coverage:
 *  - 0 items → empty text + empty buttons (dispatcher short-circuits and skips
 *    the send when this happens).
 *  - 1 item, 1 family → single-line list + 2 buttons with deterministic ids.
 *  - N items across families → deduped by labelHe (e.g. `חצובה` is seeded
 *    for both radiation and noise; renders once).
 *  - Null user name → falls back to no-greeting variant, still lists items.
 *  - Payload id shape → `EQUIP_ALL_<userId>_<localDate>` /
 *    `EQUIP_MISSING_<userId>_<localDate>`.
 *
 * Kept in a separate file from the dispatcher tests because
 * `vi.mock('../whatsapp/digestContent', ...)` is hoisted for the whole file
 * and would replace the real formatter under test here.
 */
import { describe, expect, it } from 'vitest';
import {
  formatEquipmentReminder,
  equipmentTakenAllPayloadId,
  equipmentMissingPayloadId,
} from '../whatsapp/digestContent';
import type { EquipmentChecklistItem } from '../services/inspectionsQueries';

const USER_ID = '11111111-2222-3333-4444-555555555555';
const LOCAL_DATE = '2026-07-01';

function item(family: string, code: string, labelHe: string, sortOrder = 1): EquipmentChecklistItem {
  return { family, code, labelHe, isRequired: true, sortOrder };
}

describe('formatEquipmentReminder', () => {
  it('empty item list → empty text + empty buttons (dispatcher will skip the send)', () => {
    const { text, params, buttons } = formatEquipmentReminder([], {
      id: USER_ID, name: 'דני', localDate: LOCAL_DATE,
    });
    expect(text).toBe('');
    expect(buttons).toEqual([]);
    expect(params).toEqual(['דני', '0']);
  });

  it('renders a single item with the 2 buttons and deterministic ids', () => {
    const items = [item('noise', 'noise_meter', 'מד רעש')];
    const { text, params, buttons } = formatEquipmentReminder(items, {
      id: USER_ID, name: 'דני', localDate: LOCAL_DATE,
    });
    expect(text).toContain('היי דני');
    expect(text).toContain('• מד רעש');
    expect(params).toEqual(['דני', '1']);
    expect(buttons).toHaveLength(2);
    expect(buttons[0].id).toBe(`EQUIP_ALL_${USER_ID}_${LOCAL_DATE}`);
    expect(buttons[0].title).toBe('לקחתי הכל');
    expect(buttons[1].id).toBe(`EQUIP_MISSING_${USER_ID}_${LOCAL_DATE}`);
    expect(buttons[1].title).toBe('חסר לי ציוד');
  });

  it('dedupes by labelHe across multiple families (radiation + noise share חצובה)', () => {
    // A worker with 1 radiation inspection + 1 noise inspection: `חצובה` and
    // `טופס שטח` etc. are seeded per family; the deduped set must not repeat.
    const items = [
      item('radiation', 'elf_meter', 'מד ELF', 1),
      item('radiation', 'rf_meter', 'מד RF', 2),
      item('radiation', 'tripod', 'חצובה', 3),
      item('noise', 'noise_meter', 'מד רעש', 1),
      item('noise', 'calibrator', 'קליברטור', 2),
      item('noise', 'tripod', 'חצובה', 3),         // duplicate label
    ];
    const { text, params } = formatEquipmentReminder(items, {
      id: USER_ID, name: 'יוסי', localDate: LOCAL_DATE,
    });
    // 6 rows → 5 unique labels (חצובה dedupes).
    expect(params).toEqual(['יוסי', '5']);
    const matches = (text.match(/• חצובה/g) ?? []).length;
    expect(matches).toBe(1);
    // Order preservation — first occurrence wins.
    expect(text.indexOf('• מד ELF')).toBeLessThan(text.indexOf('• מד RF'));
    expect(text.indexOf('• מד RF')).toBeLessThan(text.indexOf('• חצובה'));
    expect(text.indexOf('• חצובה')).toBeLessThan(text.indexOf('• מד רעש'));
  });

  it('gracefully drops the greeting when user.name is null', () => {
    const items = [item('radon', 'detector', 'גלאי ראדון')];
    const { text, params, buttons } = formatEquipmentReminder(items, {
      id: USER_ID, name: null, localDate: LOCAL_DATE,
    });
    expect(text).not.toContain('היי');
    expect(text).toContain('• גלאי ראדון');
    expect(text).toContain('נא לוודא שכל הציוד נמצא');
    expect(params[0]).toBe('');
    expect(buttons).toHaveLength(2);
  });

  it('button titles stay under Meta\'s 20-char cap', () => {
    const items = [item('noise', 'noise_meter', 'מד רעש')];
    const { buttons } = formatEquipmentReminder(items, {
      id: USER_ID, name: 'דני', localDate: LOCAL_DATE,
    });
    for (const b of buttons) expect(b.title.length).toBeLessThanOrEqual(20);
  });
});

describe('equipment payload id helpers', () => {
  it('emit stable shapes suitable for a regex parse', () => {
    expect(equipmentTakenAllPayloadId(USER_ID, LOCAL_DATE)).toBe(
      `EQUIP_ALL_${USER_ID}_${LOCAL_DATE}`,
    );
    expect(equipmentMissingPayloadId(USER_ID, LOCAL_DATE)).toBe(
      `EQUIP_MISSING_${USER_ID}_${LOCAL_DATE}`,
    );
  });
});
