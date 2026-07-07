import { describe, it, expect } from 'vitest';
import { parseTravelMinutes } from '../ai/travelEta';

describe('parseTravelMinutes', () => {
  it('parses a bare number as minutes', () => {
    expect(parseTravelMinutes('20')).toBe(20);
    expect(parseTravelMinutes('5')).toBe(5);
  });

  it('parses "N דקות" / "N דק" forms', () => {
    expect(parseTravelMinutes('20 דקות')).toBe(20);
    expect(parseTravelMinutes('45 דק')).toBe(45);
    expect(parseTravelMinutes("כ-15 דק'")).toBe(15);
  });

  it('parses Hebrew hour-fraction words', () => {
    expect(parseTravelMinutes('רבע שעה')).toBe(15);
    expect(parseTravelMinutes('חצי שעה')).toBe(30);
    expect(parseTravelMinutes('שלושת רבעי שעה')).toBe(45);
    expect(parseTravelMinutes('שעה')).toBe(60);
    expect(parseTravelMinutes('שעה וחצי')).toBe(90);
    expect(parseTravelMinutes('שעתיים')).toBe(120);
    expect(parseTravelMinutes('שעתיים וחצי')).toBe(150);
  });

  it('parses a number with an hour unit', () => {
    expect(parseTravelMinutes('2 שעות')).toBe(120);
    expect(parseTravelMinutes('1.5 שעות')).toBe(90);
  });

  it('clamps to the [1, 600] range and rounds', () => {
    expect(parseTravelMinutes('0')).toBeNull();
    expect(parseTravelMinutes('19.4 דקות')).toBe(19);
    expect(parseTravelMinutes('99999')).toBe(600);
  });

  it('returns null for non-ETA text', () => {
    expect(parseTravelMinutes('')).toBeNull();
    expect(parseTravelMinutes('הגעתי')).toBeNull();
    expect(parseTravelMinutes('לא יודע')).toBeNull();
    expect(parseTravelMinutes('תודה')).toBeNull();
  });
});
