/**
 * Behavioral tests for ai/fieldTaskClassifier.ts — the AI (second) layer of the
 * get_my_field_tasks filter. Uses the provider test seam (setProvider) to mock
 * the LLM; asserts the conservative contract: never throws, one batched call,
 * hallucination guard, full mapping, and false-on-any-failure fallback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setProvider, type LLMProvider } from '../ai/provider';
import { classifyUncertainEventsByAI } from '../ai/fieldTaskClassifier';

const FALLBACK_REASON = 'לא התקבלה הכרעה תקינה';

function makeProvider(emit: LLMProvider['emitStructured']): LLMProvider {
  return { name: 'mock', emitStructured: emit };
}

afterEach(() => {
  setProvider(undefined); // reset to env-derived (null in tests)
});

describe('classifyUncertainEventsByAI', () => {
  it('classifies a batch — one true, one false — into a full Map in ONE call', async () => {
    const emit = vi.fn().mockResolvedValue({
      classifications: [
        { event_id: 'e1', is_field_task: true, reason: 'בדיקת קרינה באתר לקוח' },
        { event_id: 'e2', is_field_task: false, reason: 'פגישה אישית' },
      ],
    });
    setProvider(makeProvider(emit));

    const map = await classifyUncertainEventsByAI([
      { event_id: 'e1', subject: 'ביקור אצל לקוח', location: 'חיפה' },
      { event_id: 'e2', subject: 'קפה עם דוד', location: 'תל אביב' },
    ]);

    expect(emit).toHaveBeenCalledTimes(1); // one batched call, never per-event
    expect(map.size).toBe(2);
    expect(map.get('e1')).toEqual({ is_field_task: true, reason: 'בדיקת קרינה באתר לקוח' });
    expect(map.get('e2')).toEqual({ is_field_task: false, reason: 'פגישה אישית' });
  });

  it('provider throws → every event conservatively false, no crash', async () => {
    const emit = vi.fn().mockRejectedValue(new Error('boom'));
    setProvider(makeProvider(emit));

    const map = await classifyUncertainEventsByAI([
      { event_id: 'e1', subject: 'x', location: 'y' },
      { event_id: 'e2', subject: 'a', location: 'b' },
    ]);

    expect(map.size).toBe(2);
    expect(map.get('e1')).toEqual({ is_field_task: false, reason: FALLBACK_REASON });
    expect(map.get('e2')).toEqual({ is_field_task: false, reason: FALLBACK_REASON });
  });

  it('no provider configured → every event false, provider never consulted', async () => {
    setProvider(null);

    const map = await classifyUncertainEventsByAI([
      { event_id: 'e1', subject: 'x', location: 'y' },
    ]);

    expect(map.size).toBe(1);
    expect(map.get('e1')!.is_field_task).toBe(false);
  });

  it('hallucination guard: unknown ids are dropped, unanswered inputs fall back to false', async () => {
    const emit = vi.fn().mockResolvedValue({
      classifications: [
        { event_id: 'e1', is_field_task: true, reason: 'סקר אסבסט' },
        { event_id: 'GHOST', is_field_task: true, reason: 'לא נשלח מעולם' },
      ],
    });
    setProvider(makeProvider(emit));

    const map = await classifyUncertainEventsByAI([
      { event_id: 'e1', subject: 'סקר', location: 'רעננה' },
      { event_id: 'e2', subject: 'ביקור', location: 'לוד' },
    ]);

    expect(map.has('GHOST')).toBe(false); // foreign id never enters
    expect(map.get('e1')).toEqual({ is_field_task: true, reason: 'סקר אסבסט' });
    // e2 got no valid verdict → conservative fallback
    expect(map.get('e2')).toEqual({ is_field_task: false, reason: FALLBACK_REASON });
    expect(map.size).toBe(2);
  });

  it('empty input → empty Map and NO provider call', async () => {
    const emit = vi.fn();
    setProvider(makeProvider(emit));

    const map = await classifyUncertainEventsByAI([]);

    expect(map.size).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('partial answer → answered events kept, the rest false; never throws', async () => {
    const emit = vi.fn().mockResolvedValue({
      classifications: [{ event_id: 'e2', is_field_task: true, reason: 'דיגום קרקע' }],
    });
    setProvider(makeProvider(emit));

    const map = await classifyUncertainEventsByAI([
      { event_id: 'e1', subject: 'a', location: 'b' },
      { event_id: 'e2', subject: 'c', location: 'd' },
      { event_id: 'e3', subject: 'e', location: 'f' },
    ]);

    expect(map.size).toBe(3);
    expect(map.get('e1')).toEqual({ is_field_task: false, reason: FALLBACK_REASON });
    expect(map.get('e2')).toEqual({ is_field_task: true, reason: 'דיגום קרקע' });
    expect(map.get('e3')).toEqual({ is_field_task: false, reason: FALLBACK_REASON });
  });

  it('malformed provider output (no classifications array) → all false, no throw', async () => {
    const emit = vi.fn().mockResolvedValue({ something_else: 42 });
    setProvider(makeProvider(emit));

    const map = await classifyUncertainEventsByAI([
      { event_id: 'e1', subject: 'a', location: 'b' },
    ]);

    expect(map.size).toBe(1);
    expect(map.get('e1')!.is_field_task).toBe(false);
  });
});
