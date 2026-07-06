/**
 * Submit the customer_worker_en_route template to Meta.
 * Notifies the customer when a worker updates fieldStatus → EN_ROUTE.
 *
 * Usage:
 *   npx tsx scripts/create-customer-en-route-template.ts --dry-run
 *   npx tsx scripts/create-customer-en-route-template.ts
 */
import dotenv from 'dotenv';
dotenv.config();

const NAME = 'customer_worker_en_route';
const CATEGORY = 'UTILITY';
const BODY =
  'שלום {{1}}!\n\n' +
  '{{2}} מ־גלית - החברה לאיכות הסביבה יצא לדרך אליך לביצוע {{3}}.\n\n' +
  'לפניות ישירות לבודק: {{4}}\n\n' +
  'בהצלחה!';
const EXAMPLE = ['דני', 'אלירן', 'בדיקת ראדון', '050-1234567'];

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
  return errs;
}

function buildPayload(lang: string) {
  return {
    name: NAME,
    category: CATEGORY,
    language: lang,
    components: [
      { type: 'BODY', text: BODY, example: { body_text: [EXAMPLE] } },
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

  console.log(`SUBMIT ${NAME} — ${dryRun ? 'DRY RUN' : 'LIVE'} | graph ${graphVersion} | lang ${lang}\n`);

  const errs = validate();
  if (errs.length) {
    console.error('Validation failed:');
    for (const e of errs) console.error(`  • ${e}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(JSON.stringify(buildPayload(lang), null, 2));
    return;
  }

  if (!wabaId || !token) {
    console.error('Missing META_WABA_ID / WHATSAPP_ACCESS_TOKEN');
    process.exit(1);
  }
  const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates`;
  const r = await submit(url, token, buildPayload(lang));
  if (r.ok) {
    console.log(`✓ ${NAME}: submitted (id=${r.id}, status=${r.status ?? 'PENDING'}).`);
    console.log('Wait for APPROVED, then wire it into notify() with a new NotificationKey.');
  } else {
    console.error(`✗ ${NAME}: ${r.error}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('Fatal:', e?.message ?? e); process.exit(1); });
