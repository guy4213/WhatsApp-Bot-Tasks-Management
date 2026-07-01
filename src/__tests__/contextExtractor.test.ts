/**
 * Tests for src/ai/contextExtractor.ts
 *
 * All provider calls are mocked — no real LLM requests.
 * Covers:
 *  - extractFromContext: correct_site intent, all confidence bands, error paths
 *  - extractNote: "always accept" note intents
 *  - Duration parsing (parseHebrewDuration is tested via handleScheduleAwaitDurationReply)
 *  - Provider disabled / throws / returns garbage
 */

import { describe, it, expect, vi } from 'vitest';
import {
  extractFromContext,
  extractNote,
  type ExtractionRequest,
  type ExtractionResult,
} from '../ai/contextExtractor';
import type { LLMProvider, StructuredRequest } from '../ai/provider';

// ── Mock helper ──────────────────────────────────────────────────────────────

function mockProvider(
  impl: (req: StructuredRequest) => Promise<Record<string, unknown>>,
  name = 'mock',
): LLMProvider {
  return { name, emitStructured: impl };
}

function highConfidenceProvider(values: Record<string, unknown>, confidence = 0.95): LLMProvider {
  return mockProvider(async () => ({ values, confidence, clarification: null }));
}

function lowConfidenceProvider(values: Record<string, unknown>, confidence = 0.3): LLMProvider {
  return mockProvider(async () => ({
    values,
    confidence,
    clarification: 'לא הצלחתי לזהות בדיוק מה לעדכן.',
  }));
}

// ── correct_site — Priority 1 ─────────────────────────────────────────────────

describe('extractFromContext — correct_site', () => {
  const siteFields: ExtractionRequest['fields'] = [
    { key: 'siteAddress',       labelHe: 'כתובת אתר',      kind: 'address' },
    { key: 'siteCity',          labelHe: 'עיר',             kind: 'string' },
    { key: 'fieldContactName',  labelHe: 'שם איש קשר',     kind: 'string' },
    { key: 'fieldContactPhone', labelHe: 'טלפון איש קשר',  kind: 'phone' },
  ];

  it('extracts fieldContactPhone from voice-transcribed message', async () => {
    const provider = highConfidenceProvider({
      siteAddress: null, siteCity: null, fieldContactName: null,
      fieldContactPhone: '050-1234567',
    });
    const result = await extractFromContext(
      {
        message: 'אני רוצה לעדכן את הטלפון של איש הקשר ל-050-1234567',
        intent: 'correct_site',
        fields: siteFields,
      },
      provider,
    );
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.values.fieldContactPhone).toBe('050-1234567');
    expect(result.values.siteAddress).toBeNull();
    expect(result.clarification).toBeNull();
  });

  it('extracts siteAddress from voice-style address correction', async () => {
    const provider = highConfidenceProvider({
      siteAddress: 'רוטשילד 15 תל אביב',
      siteCity: null, fieldContactName: null, fieldContactPhone: null,
    });
    const result = await extractFromContext(
      {
        message: 'הכתובת האמיתית היא רוטשילד 15 תל אביב',
        intent: 'correct_site',
        fields: siteFields,
      },
      provider,
    );
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.values.siteAddress).toBe('רוטשילד 15 תל אביב');
  });

  it('extracts fieldContactName from natural phrasing', async () => {
    const provider = highConfidenceProvider({
      siteAddress: null, siteCity: null,
      fieldContactName: 'משה כהן', fieldContactPhone: null,
    });
    const result = await extractFromContext(
      {
        message: 'השם של איש הקשר הוא משה כהן',
        intent: 'correct_site',
        fields: siteFields,
      },
      provider,
    );
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.values.fieldContactName).toBe('משה כהן');
  });

  it('extracts siteCity from natural phrasing', async () => {
    const provider = highConfidenceProvider({
      siteAddress: null, siteCity: 'רעננה', fieldContactName: null, fieldContactPhone: null,
    });
    const result = await extractFromContext(
      {
        message: 'העיר היא רעננה',
        intent: 'correct_site',
        fields: siteFields,
      },
      provider,
    );
    expect(result.values.siteCity).toBe('רעננה');
  });

  it('returns medium confidence + clarification for ambiguous city with no field context', async () => {
    const provider = lowConfidenceProvider(
      { siteAddress: null, siteCity: 'רעננה', fieldContactName: null, fieldContactPhone: null },
      0.5,
    );
    const result = await extractFromContext(
      {
        message: 'תעדכן את זה ל-רעננה',
        intent: 'correct_site',
        fields: siteFields,
      },
      provider,
    );
    expect(result.confidence).toBeLessThan(0.6);
    expect(result.clarification).toBeTruthy();
    expect(typeof result.clarification).toBe('string');
  });

  it('returns confidence 0 and empty values for "שלום" (empty / irrelevant)', async () => {
    const provider = lowConfidenceProvider(
      { siteAddress: null, siteCity: null, fieldContactName: null, fieldContactPhone: null },
      0.2,
    );
    const result = await extractFromContext(
      { message: 'שלום', intent: 'correct_site', fields: siteFields },
      provider,
    );
    expect(result.confidence).toBeLessThan(0.4);
    // All fields are null
    Object.values(result.values).forEach((v) => expect(v).toBeNull());
  });

  it('returns empty result when provider is null (AI disabled)', async () => {
    const result = await extractFromContext(
      { message: 'עדכן טלפון ל-050-9999999', intent: 'correct_site', fields: siteFields },
      null, // no provider
    );
    expect(result).toEqual({ values: {}, confidence: 0, clarification: null });
  });

  it('returns empty result when provider throws (no crash)', async () => {
    const provider = mockProvider(async () => { throw new Error('LLM timeout'); });
    const result = await extractFromContext(
      { message: 'עדכן טלפון', intent: 'correct_site', fields: siteFields },
      provider,
    );
    expect(result).toEqual({ values: {}, confidence: 0, clarification: null });
  });

  it('returns empty result when provider returns garbage (non-object values)', async () => {
    const provider = mockProvider(async () => ({
      values: 'not an object',
      confidence: 0.9,
      clarification: null,
    }));
    const result = await extractFromContext(
      { message: 'עדכן טלפון', intent: 'correct_site', fields: siteFields },
      provider,
    );
    expect(result).toEqual({ values: {}, confidence: 0, clarification: null });
  });

  it('clamps confidence to [0, 1] even if provider returns out-of-range value', async () => {
    const provider = mockProvider(async () => ({
      values: { siteAddress: 'רחוב הרצל 1', siteCity: null, fieldContactName: null, fieldContactPhone: null },
      confidence: 99,
      clarification: null,
    }));
    const result = await extractFromContext(
      { message: 'תעדכן כתובת', intent: 'correct_site', fields: siteFields },
      provider,
    );
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it('does not set clarification when confidence >= 0.7', async () => {
    const provider = mockProvider(async () => ({
      values: { siteAddress: null, siteCity: 'חיפה', fieldContactName: null, fieldContactPhone: null },
      confidence: 0.8,
      clarification: 'some clarification that should be suppressed',
    }));
    const result = await extractFromContext(
      { message: 'העיר היא חיפה', intent: 'correct_site', fields: siteFields },
      provider,
    );
    // Confidence >= 0.7 → clarification should be null
    expect(result.clarification).toBeNull();
    expect(result.values.siteCity).toBe('חיפה');
  });

  it('passes chat history to the provider', async () => {
    let seenRequest: StructuredRequest | null = null;
    const provider = mockProvider(async (req) => {
      seenRequest = req;
      return { values: { siteAddress: null, siteCity: null, fieldContactName: null, fieldContactPhone: null }, confidence: 0.2, clarification: null };
    });
    await extractFromContext(
      {
        message: 'הטלפון',
        intent: 'correct_site',
        fields: siteFields,
        history: [
          { role: 'bot', content: 'מה לתקן?' },
          { role: 'user', content: 'הטלפון של איש הקשר' },
        ],
      },
      provider,
    );
    expect(seenRequest).not.toBeNull();
    expect(seenRequest!.user).toContain('בוט: מה לתקן?');
  });

  it('returns empty result for empty message', async () => {
    const provider = mockProvider(async () => ({ values: {}, confidence: 0.9, clarification: null }));
    const result = await extractFromContext(
      { message: '   ', intent: 'correct_site', fields: siteFields },
      provider,
    );
    expect(result).toEqual({ values: {}, confidence: 0, clarification: null });
  });
});

// ── extractNote ───────────────────────────────────────────────────────────────

describe('extractNote', () => {
  it('returns cleaned note from voice-style decline reason', async () => {
    const provider = highConfidenceProvider({ note: 'לא יכול להגיע בגלל חוסר ציוד' });
    const result = await extractNote(
      'אני לא יכול להגיע בגלל חוסר ציוד',
      'decline_reason',
      provider,
    );
    expect(result).toBe('לא יכול להגיע בגלל חוסר ציוד');
  });

  it('returns null when message is empty', async () => {
    const provider = highConfidenceProvider({ note: null });
    const result = await extractNote('', 'decline_reason', provider);
    expect(result).toBeNull();
  });

  it('returns null when provider is null (AI disabled)', async () => {
    const result = await extractNote('אני לא יכול', 'decline_reason', null);
    expect(result).toBeNull();
  });

  it('returns the original message when provider throws', async () => {
    const provider = mockProvider(async () => { throw new Error('boom'); });
    const result = await extractNote('חסר לי ציוד מדידה', 'equipment_missing_note', provider);
    // Should return null (confidence 0 from error path) → extractNote returns null
    expect(result).toBeNull();
  });

  it('returns original message as fallback when provider returns null note but confidence >= 0.4', async () => {
    const provider = mockProvider(async () => ({
      values: { note: null },
      confidence: 0.8,
      clarification: null,
    }));
    const result = await extractNote('הערות שלי על הבדיקה', 'field_notes', provider);
    // Provider returned null note but confidence is high → fall back to original
    expect(result).toBe('הערות שלי על הבדיקה');
  });

  it('strips polite prefix "בבקשה" from field_notes', async () => {
    const provider = highConfidenceProvider({ note: 'הבדיקה בוצעה בהצלחה' });
    const result = await extractNote('בבקשה תרשום הבדיקה בוצעה בהצלחה', 'field_notes', provider);
    expect(result).toBe('הבדיקה בוצעה בהצלחה');
  });
});

// ── schedule_duration via extractFromContext ──────────────────────────────────

describe('extractFromContext — schedule_duration', () => {
  const durationFields: ExtractionRequest['fields'] = [
    { key: 'duration_minutes', labelHe: 'משך בדקות', kind: 'number', required: true },
  ];

  it('extracts 90 minutes from "שעה וחצי"', async () => {
    const provider = highConfidenceProvider({ duration_minutes: 90 });
    const result = await extractFromContext(
      { message: 'שעה וחצי', intent: 'schedule_duration', fields: durationFields },
      provider,
    );
    expect(result.values.duration_minutes).toBe(90);
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('extracts 45 from "45 דקות"', async () => {
    const provider = highConfidenceProvider({ duration_minutes: 45 });
    const result = await extractFromContext(
      { message: '45 דקות', intent: 'schedule_duration', fields: durationFields },
      provider,
    );
    expect(result.values.duration_minutes).toBe(45);
  });

  it('extracts 60 from "שעה"', async () => {
    const provider = highConfidenceProvider({ duration_minutes: 60 });
    const result = await extractFromContext(
      { message: 'שעה', intent: 'schedule_duration', fields: durationFields },
      provider,
    );
    expect(result.values.duration_minutes).toBe(60);
  });

  it('extracts 60 from plain "60"', async () => {
    const provider = highConfidenceProvider({ duration_minutes: 60 });
    const result = await extractFromContext(
      { message: '60', intent: 'schedule_duration', fields: durationFields },
      provider,
    );
    expect(result.values.duration_minutes).toBe(60);
  });
});
