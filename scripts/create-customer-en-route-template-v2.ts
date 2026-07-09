/**
 * Submit the `customer_worker_en_route_v2` WhatsApp template to Meta.
 *
 * Same 4-var body as the approved v1 `customer_worker_en_route` template
 * (see `scripts/create-customer-en-route-template.ts`), PLUS a BUTTONS
 * component with one URL button ("מעקב אחר הבודק") that deep-links to the
 * live tracking page: `<TRACKING_PUBLIC_BASE_URL>/t/{{1}}` (the button's own
 * `{{1}}` is the session token — independent of the body's {{1}}..{{4}}).
 *
 * Usage:
 *   npx tsx scripts/create-customer-en-route-template-v2.ts --dry-run   # preview only
 *   npx tsx scripts/create-customer-en-route-template-v2.ts             # LIVE submit
 *
 * LIVE submission requires TRACKING_PUBLIC_BASE_URL to be set (the button's
 * example URL must be a real, resolvable host for Meta review) — --dry-run
 * is allowed with a placeholder base URL so the payload shape can be checked
 * before the env is configured.
 *
 * After it shows PENDING → APPROVED at Meta, override in Render:
 *   WHATSAPP_TEMPLATE_CUSTOMER_WORKER_EN_ROUTE=customer_worker_en_route_v2
 */
import dotenv from 'dotenv';
dotenv.config();

const NAME = 'customer_worker_en_route_v2';
const CATEGORY = 'UTILITY';
const BUTTON_TEXT = 'מעקב אחר הבודק';
const PLACEHOLDER_BASE_URL = 'https://bot.example.com';

// Identical body to v1 — copied verbatim so the two templates never drift.
const BODY =
  'שלום {{1}}!\n\n' +
  '{{2}} מ־גלית - החברה לאיכות הסביבה יצא לדרך אליך לביצוע {{3}}.\n\n' +
  'לפניות ישירות לבודק: {{4}}\n\n' +
  'בהצלחה!';
const EXAMPLE = ['דני', 'אלירן', 'בדיקת ראדון', '050-1234567'];
const BUTTON_EXAMPLE_TOKEN = 'EXAMPLETOKEN123';

function placeholders(body: string): number[] {
  return [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => parseInt(m[1], 10));
}

function validate(): string[] {
  const errs: string[] = [];
  const trimmed = BODY.trim();
  if (/^\{\{/.test(trimmed)) errs.push('body starts with a variable');
  const withoutTrailingPunct = trimmed.replace(/[\s.,!?:;"'()\-־]+$/u, '');
  if (/\}\}$/.test(withoutTrailingPunct)) errs.push('body ends with a variable');
  if (/\}\}\s*\{\{/.test(BODY)) errs.push('adjacent variables');
  const nums = placeholders(BODY);
  const max = nums.length ? Math.max(...nums) : 0;
  const set = new Set(nums);
  for (let i = 1; i <= max; i++) if (!set.has(i)) errs.push(`missing {{${i}}}`);
  if (EXAMPLE.length !== max) errs.push(`example count (${EXAMPLE.length}) != placeholders (${max})`);
  if (!/^[a-z0-9_]+$/.test(NAME)) errs.push('bad name');
  if (BUTTON_TEXT.length > 25) errs.push('button text > 25 chars');
  return errs;
}

function buildPayload(lang: string, baseUrl: string) {
  const strippedBase = baseUrl.replace(/\/+$/, '');
  return {
    name: NAME,
    category: CATEGORY,
    language: lang,
    components: [
      { type: 'BODY', text: BODY, example: { body_text: [EXAMPLE] } },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: BUTTON_TEXT,
            url: `${strippedBase}/t/{{1}}`,
            example: [`${strippedBase}/t/${BUTTON_EXAMPLE_TOKEN}`],
          },
        ],
      },
    ],
  };
}

async function submit(url: string, token: string, payload: unknown) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: json.id, status: json.status };
    const e = json?.error ?? {};
    const parts = [
      e.message ?? `HTTP ${res.status}`,
      e.code != null ? `code=${e.code}` : '',
      e.error_subcode != null ? `subcode=${e.error_subcode}` : '',
      e.error_user_msg ? `user_msg=${e.error_user_msg}` : '',
    ].filter(Boolean).join(' | ');
    return { ok: false, error: parts };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network error' };
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const graphVersion = process.env.META_GRAPH_VERSION || 'v23.0';
  const wabaId = process.env.META_WABA_ID || '';
  const token = process.env.WHATSAPP_ACCESS_TOKEN || '';
  const lang = process.env.WHATSAPP_TEMPLATE_LANG || 'he';
  const trackingBaseUrl = (process.env.TRACKING_PUBLIC_BASE_URL || '').trim();

  console.log(`SUBMIT ${NAME} — ${dryRun ? 'DRY RUN' : 'LIVE'} | graph ${graphVersion} | lang ${lang}\n`);

  const errs = validate();
  if (errs.length) {
    console.error('Validation failed:');
    for (const e of errs) console.error(`  • ${e}`);
    process.exit(1);
  }

  if (!trackingBaseUrl && !dryRun) {
    console.error('Missing TRACKING_PUBLIC_BASE_URL — required for a LIVE submission');
    console.error('(the URL button example must point at a real host for Meta review).');
    console.error('Set it in .env, or run with --dry-run to preview using a placeholder.');
    process.exit(1);
  }

  const effectiveBaseUrl = trackingBaseUrl || PLACEHOLDER_BASE_URL;
  if (!trackingBaseUrl) {
    console.log(`(TRACKING_PUBLIC_BASE_URL unset — using placeholder "${PLACEHOLDER_BASE_URL}" for the dry-run preview)\n`);
  }

  if (dryRun) {
    console.log(JSON.stringify(buildPayload(lang, effectiveBaseUrl), null, 2));
    return;
  }

  if (!wabaId || !token) {
    console.error('Missing META_WABA_ID / WHATSAPP_ACCESS_TOKEN');
    process.exit(1);
  }
  const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates`;
  const r = await submit(url, token, buildPayload(lang, effectiveBaseUrl));
  if (r.ok) {
    console.log(`✓ ${NAME}: submitted (id=${r.id}, status=${r.status ?? 'PENDING'}).`);
    console.log('When APPROVED, set WHATSAPP_TEMPLATE_CUSTOMER_WORKER_EN_ROUTE=customer_worker_en_route_v2 in Render.');
  } else {
    console.error(`✗ ${NAME}: ${r.error}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('Fatal:', e?.message ?? e); process.exit(1); });
