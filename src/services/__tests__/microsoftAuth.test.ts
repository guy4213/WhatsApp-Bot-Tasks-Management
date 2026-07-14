import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startOAuth } from '../microsoftAuth';

const ENV_KEYS = [
  'GRAPH_TENANT_ID',
  'GRAPH_CLIENT_ID',
  'GRAPH_REDIRECT_URI',
  'INTERNAL_API_SECRET',
] as const;

describe('startOAuth', () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
    process.env.GRAPH_TENANT_ID = 'tenant-id';
    process.env.GRAPH_CLIENT_ID = 'client-id';
    process.env.GRAPH_REDIRECT_URI = 'https://example.test/microsoft/oauth/callback';
    process.env.INTERNAL_API_SECRET = 'test-secret';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('does not force a new consent prompt', () => {
    const { url } = startOAuth('c7f229a5-f182-4f85-8be7-2465fb3ca389');
    const parsed = new URL(url);

    expect(parsed.searchParams.get('scope')).toBe(
      'offline_access Calendars.ReadWrite User.Read',
    );
    expect(parsed.searchParams.has('prompt')).toBe(false);
    expect(parsed.searchParams.has('login_hint')).toBe(false);
  });

  it('adds the requested login hint without changing consent behavior', () => {
    const { url } = startOAuth('c7f229a5-f182-4f85-8be7-2465fb3ca389', {
      loginHint: 'yoram@galit.co.il',
    });
    const parsed = new URL(url);

    expect(parsed.searchParams.get('login_hint')).toBe('yoram@galit.co.il');
    expect(parsed.searchParams.has('prompt')).toBe(false);
  });
});
