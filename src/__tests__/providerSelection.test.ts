/**
 * PR#2 — provider seam selection. Green API is now the default; Meta stays
 * reachable via WHATSAPP_PROVIDER=meta (rollback path). An unset or unknown value
 * resolves to Green API.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getProvider } from '../whatsapp/provider';

const original = process.env.WHATSAPP_PROVIDER;
afterEach(() => {
  if (original === undefined) delete process.env.WHATSAPP_PROVIDER;
  else process.env.WHATSAPP_PROVIDER = original;
});

describe('getProvider (PR#2 — Green API default)', () => {
  it('defaults to Green API when WHATSAPP_PROVIDER is unset', () => {
    delete process.env.WHATSAPP_PROVIDER;
    expect(getProvider().name).toBe('greenapi');
  });

  it('selects Green API explicitly (case/space-insensitive)', () => {
    process.env.WHATSAPP_PROVIDER = '  GreenAPI ';
    expect(getProvider().name).toBe('greenapi');
  });

  it('selects Meta explicitly (rollback path)', () => {
    process.env.WHATSAPP_PROVIDER = '  Meta ';
    expect(getProvider().name).toBe('meta');
  });

  it('falls back to Green API for an unknown provider value', () => {
    process.env.WHATSAPP_PROVIDER = 'twilio';
    expect(getProvider().name).toBe('greenapi');
  });

  it('Green API does NOT support templates and IS paced', () => {
    delete process.env.WHATSAPP_PROVIDER;
    const p = getProvider();
    expect(p.supportsTemplates).toBe(false);
    expect(p.paced).toBe(true);
  });

  it('Meta supports templates and is NOT paced (unchanged)', () => {
    process.env.WHATSAPP_PROVIDER = 'meta';
    const p = getProvider();
    expect(p.supportsTemplates).toBe(true);
    expect(p.paced).toBe(false);
  });

  it('both providers expose all four send methods', () => {
    for (const name of ['greenapi', 'meta']) {
      process.env.WHATSAPP_PROVIDER = name;
      const p = getProvider();
      expect(typeof p.sendText).toBe('function');
      expect(typeof p.sendButton).toBe('function');
      expect(typeof p.sendList).toBe('function');
      expect(typeof p.sendTemplate).toBe('function');
    }
  });
});
