/**
 * PR#1 — provider seam selection. Meta is the only/default provider; an unset or
 * unknown WHATSAPP_PROVIDER resolves to Meta so nothing changes operationally.
 * (PR#2 adds 'greenapi' and flips the default.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getProvider } from '../whatsapp/provider';

const original = process.env.WHATSAPP_PROVIDER;
afterEach(() => {
  if (original === undefined) delete process.env.WHATSAPP_PROVIDER;
  else process.env.WHATSAPP_PROVIDER = original;
});

describe('getProvider (PR#1 — Meta only)', () => {
  it('defaults to Meta when WHATSAPP_PROVIDER is unset', () => {
    delete process.env.WHATSAPP_PROVIDER;
    expect(getProvider().name).toBe('meta');
  });

  it('selects Meta explicitly (case/space-insensitive)', () => {
    process.env.WHATSAPP_PROVIDER = '  Meta ';
    expect(getProvider().name).toBe('meta');
  });

  it('falls back to Meta for an unknown provider value', () => {
    process.env.WHATSAPP_PROVIDER = 'greenapi'; // not wired until PR#2
    expect(getProvider().name).toBe('meta');
  });

  it('Meta advertises template support and is not paced', () => {
    delete process.env.WHATSAPP_PROVIDER;
    const p = getProvider();
    expect(p.supportsTemplates).toBe(true);
    expect(p.paced).toBe(false);
  });

  it('exposes all four send methods', () => {
    const p = getProvider();
    expect(typeof p.sendText).toBe('function');
    expect(typeof p.sendButton).toBe('function');
    expect(typeof p.sendList).toBe('function');
    expect(typeof p.sendTemplate).toBe('function');
  });
});
