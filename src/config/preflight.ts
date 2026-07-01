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
  { key: 'WHATSAPP_PHONE_NUMBER_ID', productionOnly: true },
  { key: 'WHATSAPP_ACCESS_TOKEN', productionOnly: true },
  { key: 'WHATSAPP_VERIFY_TOKEN', productionOnly: true },
  { key: 'WHATSAPP_APP_SECRET', productionOnly: true },
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

  // AI provider must have its matching key
  const provider = (process.env.AI_PROVIDER ?? '').toLowerCase();
  if (!provider) {
    warnings.push('AI_PROVIDER not set — AI intent parsing is disabled (bot replies "AI not configured")');
  } else if (provider === 'openai' && !process.env.OPENAI_API_KEY) {
    errors.push('AI_PROVIDER=openai but OPENAI_API_KEY is missing');
  } else if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    errors.push('AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing');
  }

  // Non-fatal production warnings
  if (isProd && process.env.WHATSAPP_TEMPLATES_ENABLED !== 'true') {
    warnings.push('WHATSAPP_TEMPLATES_ENABLED!=true — proactive messages deliver only inside each user\'s 24h window');
  }

  // D4-T1 (K3) — Yoram exceptions digest is only routed when YORAM_PHONE is
  // set. It is OPTIONAL: unset / empty is a supported production state (legacy
  // ADMIN morning + evening digests continue to run). Warn only, never fail.
  if (isProd && !(process.env.YORAM_PHONE ?? '').trim()) {
    warnings.push('YORAM_PHONE not set — Yoram exceptions digest (D4-T1) will not route; legacy ADMIN digest continues');
  }
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
