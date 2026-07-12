/**
 * Startup preflight — fail fast (in production) when required env vars are missing
 * or invalid, and warn about risky-but-non-fatal config. Called once at boot from
 * index.ts BEFORE the server starts listening.
 */
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('preflight');

interface Required {
  key: string;
  productionOnly?: boolean;             // only required when NODE_ENV=production
  validate?: (v: string) => string | null; // returns an error message, or null if ok
}

const REQUIRED: Required[] = [
  { key: 'DATABASE_URL' },
  { key: 'SUPABASE_URL' },
  // WhatsApp transport credentials are validated per-provider below (they differ
  // for Meta vs Green API), not here — a Green API deployment must not be blocked
  // by absent Meta creds, and vice versa.
  {
    key: 'INTERNAL_API_SECRET',
    productionOnly: true,
    validate: (v) =>
      v === 'your_random_secret_here'
        ? 'is still the placeholder — generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
        : v.length < 32
          ? 'is too short (use at least 32 chars / 16 random bytes)'
          : null,
  },
];

export function runPreflight(): void {
  const isProd = process.env.NODE_ENV === 'production';
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const c of REQUIRED) {
    const v = process.env[c.key];
    if (!v || !v.trim()) {
      if (c.productionOnly && !isProd) warnings.push(`${c.key} not set (ok outside production)`);
      else errors.push(`${c.key} is missing`);
      continue;
    }
    const msg = c.validate?.(v);
    if (msg) errors.push(`${c.key} ${msg}`);
  }

  // WhatsApp transport provider (PR#2): Green API is the default; Meta stays
  // reachable via WHATSAPP_PROVIDER=meta. Validate ONLY the active provider's
  // credentials.
  //   meta     → WHATSAPP_PHONE_NUMBER_ID / _ACCESS_TOKEN / _VERIFY_TOKEN / _APP_SECRET
  //   greenapi → GREENAPI_ID_INSTANCE / _API_TOKEN_INSTANCE / _WEBHOOK_TOKEN
  const waProvider = (process.env.WHATSAPP_PROVIDER ?? 'greenapi').trim().toLowerCase();
  const providerVars = waProvider === 'meta'
    ? ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET']
    : ['GREENAPI_ID_INSTANCE', 'GREENAPI_API_TOKEN_INSTANCE', 'GREENAPI_WEBHOOK_TOKEN'];
  for (const key of providerVars) {
    const v = process.env[key];
    if (v && v.trim()) continue;
    if (isProd) errors.push(`${key} is missing (WHATSAPP_PROVIDER=${waProvider})`);
    else warnings.push(`${key} not set (ok outside production; WHATSAPP_PROVIDER=${waProvider})`);
  }

  // AI provider must have its matching key
  const provider = (process.env.AI_PROVIDER ?? '').toLowerCase();
  if (!provider) {
    warnings.push('AI_PROVIDER not set — AI intent parsing is disabled (bot replies "AI not configured")');
  } else if (provider === 'openai' && !process.env.OPENAI_API_KEY) {
    errors.push('AI_PROVIDER=openai but OPENAI_API_KEY is missing');
  } else if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    errors.push('AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing');
  }

  // Non-fatal production warnings. The templates/24h-window concern is Meta-only:
  // Green API is always in-window (WhatsApp Web) and ignores WHATSAPP_TEMPLATES_ENABLED.
  if (isProd && waProvider === 'meta' && process.env.WHATSAPP_TEMPLATES_ENABLED !== 'true') {
    warnings.push('WHATSAPP_TEMPLATES_ENABLED!=true — proactive messages deliver only inside each user\'s 24h window');
  }

  // Yoram + Sasha are identified by User.name at runtime (see specialUsers.ts).
  // No env vars needed — the DB is the source of truth. If either row is
  // missing from the User table, the corresponding digest is silently disabled
  // (see specialUsers.getSashaPhone / isYoram / isSasha).

  if (isProd && !process.env.DATABASE_CA_CERT && process.env.DATABASE_SSL !== 'disable') {
    warnings.push('DATABASE_CA_CERT not set — DB TLS is encrypted but the server cert is not verified');
  }

  for (const w of warnings) log.warn(`[preflight] ${w}`);

  if (errors.length > 0) {
    for (const e of errors) log.error(`[preflight] ${e}`);
    throw new Error(
      `Preflight failed — ${errors.length} missing/invalid env var(s): ${errors.join('; ')}`,
    );
  }

  log.info({ env: process.env.NODE_ENV ?? 'development', warnings: warnings.length }, '[preflight] Environment OK');
}
