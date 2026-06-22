import { describe, it, expect } from 'vitest';
import { normalizeIsraeliPhone } from '../auth/phoneNormalizer';

describe('normalizeIsraeliPhone', () => {
  it('passes through a valid 972+9-digit number unchanged', () => {
    expect(normalizeIsraeliPhone('972501234567')).toBe('972501234567');
  });

  it('converts local 0xx format to 972xx', () => {
    expect(normalizeIsraeliPhone('0501234567')).toBe('972501234567');
  });

  it('converts 9-digit (no leading 0) to 972xx', () => {
    expect(normalizeIsraeliPhone('501234567')).toBe('972501234567');
  });

  it('strips dashes from international format', () => {
    expect(normalizeIsraeliPhone('972-50-123-4567')).toBe('972501234567');
  });

  it('strips leading + from +972 format', () => {
    expect(normalizeIsraeliPhone('+972501234567')).toBe('972501234567');
  });

  it('strips spaces', () => {
    expect(normalizeIsraeliPhone('0501 234 567')).toBe('972501234567');
  });

  it('returns null for unrecognizable format', () => {
    expect(normalizeIsraeliPhone('123')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeIsraeliPhone('')).toBeNull();
  });

  it('returns null for international numbers that are not Israeli', () => {
    // US number: 12025551234 — starts with 1, not 972
    expect(normalizeIsraeliPhone('12025551234')).toBeNull();
  });
});
