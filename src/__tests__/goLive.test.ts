/**
 * Go-live automated checks — exercises the behavior the manual suite describes,
 * for everything verifiable without a live WhatsApp phone / Meta:
 *  - Confirm / cancel / correction word matching (M-5.1–5.9)
 *  - Task-type normalization Hebrew→enum (M-4.5, M-6.5, M-15.5)
 *  - HTTP contract for /health, /health/live, /health/ready, GET /webhook verify
 *    (M-1.1, M-1.2, M-1.3, M-15.3) via Fastify inject — no network, no sends.
 */
import { describe, it, expect } from 'vitest';
import { YES_RE, NO_RE, CORRECTION_RE } from '../ai/router';
import { normalizeTaskType } from '../services/tasks';
import { buildApp } from '../app';

// ── M-5.1–5.5 — confirmation words ──────────────────────────────────────────────
describe('confirmation words (M-5.1–5.5)', () => {
  for (const w of ['כן', 'אשר', 'מאשר', 'אוקיי', 'סבבה', 'אישור', 'תאשר', 'בצע', 'yes', 'ok']) {
    it(`"${w}" → YES`, () => {
      expect(YES_RE.test(w)).toBe(true);
      expect(NO_RE.test(w)).toBe(false);
    });
  }
  it('"כן בבקשה" still matches YES', () => expect(YES_RE.test('כן בבקשה')).toBe(true));
  it('"yesterday" is NOT a YES (word-boundary guard)', () => expect(YES_RE.test('yesterday')).toBe(false));
});

// ── M-5.6–5.8 — cancellation words ──────────────────────────────────────────────
describe('cancellation words (M-5.6–5.8)', () => {
  for (const w of ['לא', 'בטל', 'ביטול', 'עצור', 'אל תבצע', 'no']) {
    it(`"${w}" → NO`, () => {
      expect(NO_RE.test(w)).toBe(true);
      expect(YES_RE.test(w)).toBe(false);
    });
  }
  it('"לאט" is NOT a NO (word-boundary guard)', () => expect(NO_RE.test('לאט')).toBe(false));
});

// ── M-5.9 — correction words (and NOT real edit commands) ────────────────────────
describe('correction words (M-5.9)', () => {
  for (const w of ['רגע', 'תיקון', 'לא לזה התכוונתי']) {
    it(`"${w}" → correction`, () => expect(CORRECTION_RE.test(w)).toBe(true));
  }
  it('"שנה את הכותרת" is NOT a correction (stays a real edit)', () =>
    expect(CORRECTION_RE.test('שנה את הכותרת')).toBe(false));
  it('"תקן את התיאור" is NOT a correction (stays a real edit)', () =>
    expect(CORRECTION_RE.test('תקן את התיאור')).toBe(false));
});

// ── M-4.5 / M-6.5 / M-15.5 — task-type normalization ────────────────────────────
describe('normalizeTaskType (M-4.5, M-6.5, M-15.5)', () => {
  it('maps Hebrew labels to enum values', () => {
    expect(normalizeTaskType('פתיחת פנייה')).toBe('step1');
    expect(normalizeTaskType('הצעת מחיר')).toBe('stepQuote');
    expect(normalizeTaskType('פולואפ')).toBe('step4');
    expect(normalizeTaskType('תיאום')).toBe('step5');
    expect(normalizeTaskType('ביצוע')).toBe('step6');
    expect(normalizeTaskType('כתיבת דוח')).toBe('step7');
  });
  it('accepts a raw enum value (case-insensitive)', () => {
    expect(normalizeTaskType('step1')).toBe('step1');
    expect(normalizeTaskType('STEPQUOTE')).toBe('stepQuote');
  });
  it('matches a label embedded in a longer phrase', () => {
    expect(normalizeTaskType('צריך לעשות תיאום עם הלקוח')).toBe('step5');
  });
  it('returns null for an unknown / empty type (M-15.5)', () => {
    expect(normalizeTaskType('משהו לא קיים בכלל')).toBeNull();
    expect(normalizeTaskType('')).toBeNull();
    expect(normalizeTaskType(undefined)).toBeNull();
    expect(normalizeTaskType(123)).toBeNull();
  });
});

// ── M-1.x / M-15.3 — HTTP health & webhook verification (no sends) ───────────────
describe('HTTP endpoints (M-1.1, M-1.2, M-1.3, M-15.3)', () => {
  it('GET /health → 200 {status:"ok"}', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /health/ready → 200 db:connected, or 503 db:unreachable (M-1.2 / M-15.3)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect([200, 503]).toContain(res.statusCode);
    const body = res.json();
    if (res.statusCode === 200) expect(body.db).toBe('connected');
    else expect(body.db).toBe('unreachable');
    await app.close();
  });

  it('GET /webhook with correct verify token echoes the challenge (M-1.3)', async () => {
    const app = await buildApp();
    const token = process.env.WHATSAPP_VERIFY_TOKEN ?? '';
    const res = await app.inject({
      method: 'GET',
      url: `/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=test-challenge-123`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('test-challenge-123');
    await app.close();
  });

  it('GET /webhook with a wrong verify token is rejected', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/webhook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=x',
    });
    expect(res.statusCode).not.toBe(200);
    await app.close();
  });
});
