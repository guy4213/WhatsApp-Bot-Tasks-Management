/**
 * Submit 4 NEW digest templates with a `_v2` suffix and the clean wording
 * ("שיהיה בוקר מצוין!" / "שיהיה ערב נפלא!"). Bypasses the PENDING-edit block
 * on the v1 templates. Once these are APPROVED, override the env vars:
 *   WHATSAPP_TEMPLATE_EMPLOYEE_MORNING_DIGEST=employee_morning_digest_v2
 *   WHATSAPP_TEMPLATE_EMPLOYEE_END_OF_DAY_REPORT=employee_end_of_day_report_v2
 *   WHATSAPP_TEMPLATE_MANAGER_MORNING_DIGEST=manager_morning_digest_v2
 *   WHATSAPP_TEMPLATE_MANAGER_END_OF_DAY_REPORT=manager_end_of_day_report_v2
 *
 * Usage:
 *   npx tsx scripts/create-digest-templates-v2.ts --dry-run
 *   npx tsx scripts/create-digest-templates-v2.ts
 */
import dotenv from 'dotenv';
dotenv.config();

const CATEGORY = 'UTILITY';

interface TemplateDef {
  name: string;
  body: string;
  example: string[];
}

const TEMPLATES: TemplateDef[] = [
  {
    name: 'employee_morning_digest_v2',
    body:
      'בוקר טוב {{1}}!\n\n' +
      'היום משובצות לך {{2}} בדיקות שדה.\n\n' +
      'שיהיה בוקר מצוין!',
    example: ['דניאל', '4'],
  },
  {
    name: 'employee_end_of_day_report_v2',
    body:
      'ערב טוב {{1}}!\n\n' +
      'דוח סוף יום — מתוך {{2}} משימות להיום:\n' +
      '• בוצעו: {{3}}\n' +
      '• לא בוצעו: {{4}}\n' +
      '• באיחור: {{5}}\n' +
      '• עוברות למחר: {{6}}\n\n' +
      'שיהיה ערב נפלא!',
    example: ['דניאל', '5', '3', '2', '1', '2'],
  },
  {
    name: 'manager_morning_digest_v2',
    body:
      'בוקר טוב {{1}}!\n\n' +
      'סיכום שדה להיום:\n' +
      '• בוצעו: {{2}}\n' +
      '• לא אושרו: {{3}}\n' +
      '• בעיות: {{4}}\n' +
      '• ממתין למידע: {{5}}\n' +
      '• לא נסגרו: {{6}}\n\n' +
      'לידים:\n' +
      '• מהלילה: {{7}}\n' +
      '• לא משויכים: {{8}}\n\n' +
      'שיהיה בוקר מצוין!',
    example: ['גיא', '2', '5', '0', '0', '7', '3', '1'],
  },
  {
    name: 'manager_end_of_day_report_v2',
    body:
      'ערב טוב {{1}}!\n\n' +
      'סיכום סוף יום — שדה:\n' +
      '• בוצעו: {{2}}\n' +
      '• לא אושרו: {{3}}\n' +
      '• בעיות: {{4}}\n' +
      '• ממתין למידע: {{5}}\n' +
      '• לא נסגרו: {{6}}\n\n' +
      'לידים:\n' +
      '• מהלילה: {{7}}\n' +
      '• לא משויכים: {{8}}\n\n' +
      'שיהיה ערב נפלא!',
    example: ['גיא', '4', '2', '1', '0', '5', '3', '0'],
  },
];

function placeholders(body: string): number[] {
  return [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => parseInt(m[1], 10));
}

function validate(def: TemplateDef): string[] {
  const errs: string[] = [];
  const trimmed = def.body.trim();
  if (/^\{\{/.test(trimmed)) errs.push('body starts with a variable');
  const withoutTrailingPunct = trimmed.replace(/[\s.,!?:;"'()\-־]+$/u, '');
  if (/\}\}$/.test(withoutTrailingPunct)) errs.push('body ends with a variable');
  if (/\}\}\s*\{\{/.test(def.body)) errs.push('adjacent variables');
  const nums = placeholders(def.body);
  const max = nums.length ? Math.max(...nums) : 0;
  const set = new Set(nums);
  for (let i = 1; i <= max; i++) if (!set.has(i)) errs.push(`missing {{${i}}}`);
  if (def.example.length !== max) errs.push(`example count (${def.example.length}) != placeholders (${max})`);
  if (!/^[a-z0-9_]+$/.test(def.name)) errs.push('bad name');
  return errs;
}

function buildPayload(def: TemplateDef, lang: string) {
  return {
    name: def.name,
    category: CATEGORY,
    language: lang,
    components: [
      { type: 'BODY', text: def.body, example: { body_text: [def.example] } },
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

  console.log(`v2 SUBMIT — ${dryRun ? 'DRY RUN' : 'LIVE'} | graph ${graphVersion} | lang ${lang}\n`);

  let invalid = 0;
  for (const def of TEMPLATES) {
    const errs = validate(def);
    if (errs.length) { invalid++; console.error(`✗ ${def.name}: ${errs.join('; ')}`); }
  }
  if (invalid > 0) { console.error(`\n${invalid} invalid — nothing sent.`); process.exit(1); }

  if (dryRun) {
    for (const def of TEMPLATES) {
      console.log(`── ${def.name} ──`);
      console.log(def.body);
      console.log();
    }
    return;
  }

  if (!wabaId || !token) {
    console.error('Missing META_WABA_ID / WHATSAPP_ACCESS_TOKEN');
    process.exit(1);
  }
  const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates`;
  let ok = 0, failed = 0;
  for (const def of TEMPLATES) {
    const r = await submit(url, token, buildPayload(def, lang));
    if (r.ok) { ok++; console.log(`✓ ${def.name}: submitted (id=${r.id}, status=${r.status ?? 'PENDING'}).`); }
    else { failed++; console.error(`✗ ${def.name}: ${r.error}`); }
  }
  console.log(`\nDone — ok=${ok}, failed=${failed}.`);
  console.log('When APPROVED, override env vars in Render to point at the _v2 names.');
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('Fatal:', e?.message ?? e); process.exit(1); });
