import { describe, it, expect, vi } from 'vitest';
import { suggestWorkerForLead, type InspectorCandidate } from '../ai/leadSuggester';
import type { LLMProvider, StructuredRequest } from '../ai/provider';

const NO_MATCH_REASON = 'לא נמצאה התאמה';

function mockProvider(
  impl: (req: StructuredRequest) => Promise<Record<string, unknown>>,
  name = 'mock',
): LLMProvider {
  return {
    name,
    emitStructured: impl,
    runLoop: async () => ({ text: '', toolCallCount: 0 }),
  };
}

describe('suggestWorkerForLead', () => {
  const radiation: InspectorCandidate = { id: 'u-1', name: 'דני', role: 'טכנאי קרינה' };
  const asbestos: InspectorCandidate = { id: 'u-2', name: 'רון', role: 'טכנאי אזבסט' };

  it('returns no-match without calling the provider when candidates is empty', async () => {
    const spy = vi.fn();
    const provider = mockProvider(spy);
    const result = await suggestWorkerForLead(
      { service: 'בדיקת קרינה' },
      [],
      provider,
    );
    expect(result).toEqual({ userId: null, reason: NO_MATCH_REASON });
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns no-match when the provider is disabled (null)', async () => {
    const result = await suggestWorkerForLead(
      { service: 'בדיקת קרינה' },
      [radiation, asbestos],
      null,
    );
    expect(result).toEqual({ userId: null, reason: NO_MATCH_REASON });
  });

  it('returns the suggested id when the provider picks a real candidate', async () => {
    const provider = mockProvider(async () => ({ userId: 'u-1', reason: 'תפקיד תואם לקרינה' }));
    const result = await suggestWorkerForLead(
      { service: 'בדיקת קרינה', messageText: 'רוצה בדיקת קרינה ברעננה' },
      [radiation, asbestos],
      provider,
    );
    expect(result).toEqual({ userId: 'u-1', reason: 'תפקיד תואם לקרינה' });
  });

  it('downgrades a hallucinated userId to no-match', async () => {
    const provider = mockProvider(async () => ({ userId: 'u-999', reason: 'made up' }));
    const result = await suggestWorkerForLead(
      { service: 'בדיקת קרינה' },
      [radiation, asbestos],
      provider,
    );
    expect(result).toEqual({ userId: null, reason: NO_MATCH_REASON });
  });

  it('returns no-match (never throws) when the provider throws', async () => {
    const provider = mockProvider(async () => {
      throw new Error('boom');
    });
    const result = await suggestWorkerForLead(
      { service: 'בדיקת קרינה' },
      [radiation, asbestos],
      provider,
    );
    expect(result).toEqual({ userId: null, reason: NO_MATCH_REASON });
  });

  it('passes the lead text and candidate list to the provider (radiation sample)', async () => {
    let seen: StructuredRequest | null = null;
    const provider = mockProvider(async (req) => {
      seen = req;
      return { userId: 'u-1', reason: 'תפקיד קרינה מתאים' };
    });
    const result = await suggestWorkerForLead(
      { service: 'בדיקת קרינה', messageText: 'בדיקת קרינה ברעננה' },
      [radiation, asbestos],
      provider,
    );
    expect(result.userId).toBe('u-1');
    expect(seen).not.toBeNull();
    expect(seen!.user).toContain('בדיקת קרינה');
    expect(seen!.user).toContain('u-1');
    expect(seen!.user).toContain('u-2');
    expect(seen!.user).toContain('טכנאי קרינה');
  });

  it('propagates a null userId from the provider as no-match with the provider reason kept', async () => {
    const provider = mockProvider(async () => ({ userId: null, reason: 'תחום לא מזוהה' }));
    const result = await suggestWorkerForLead(
      { messageText: 'שאלה כללית' },
      [radiation, asbestos],
      provider,
    );
    expect(result).toEqual({ userId: null, reason: 'תחום לא מזוהה' });
  });
});
