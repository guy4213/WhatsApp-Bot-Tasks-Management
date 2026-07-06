/**
 * v2 edit — replace the misleading "פרטים בהודעה הבאה" / "חריגים פתוחים
 * בהודעה הבאה" trailers with warm closing greetings ("שיהיה בוקר מצוין!" /
 * "שיהיה ערב נפלא!"). Body content otherwise unchanged.
 *
 * Prerequisites:
 *   • Templates must be APPROVED (Meta blocks editing PENDING templates).
 *   • 24-hour rate limit from previous edit (09:22 IL 2026-07-06).
 *
 * Usage:
 *   npx tsx scripts/edit-digest-templates-v2.ts --dry-run   # preview
 *   npx tsx scripts/edit-digest-templates-v2.ts             # LIVE
 */
import dotenv from 'dotenv';
dotenv.config();

interface EditDef {
  id: string;
  name: string;
  body: string;
  example: string[];
}

const EDITS: EditDef[] = [
  {
    id: '1325390393133400',
    name: 'employee_morning_digest',
    body:
      'בוקר טוב {{1}}!\n\n' +
      'היום משובצות לך {{2}} בדיקות שדה.\n\n' +
      'שיהיה בוקר מצוין!',
    example: ['דניאל', '4'],
  },
  {
    id: '1053602420437444',
    name: 'employee_end_of_day_report',
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
    id: '1590271532459276',
    name: 'manager_morning_digest',
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
    id: '3531280530366031',
    name: 'manager_end_of_day_report',
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

function validate(def: EditDef): string[] {
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
  return errs;
}

function buildPayload(def: EditDef) {
  return {
    category: 'UTILITY',
    components: [
      { type: 'BODY', text: def.body, example: { body_text: [def.example] } },
    ],
  };
}

async function editOne(baseUrl: string, token: string, def: EditDef) {
  try {
    const res = await fetch(`${baseUrl}/${def.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(def)),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, status: json.status ?? 'ok' };
    const e = json?.error ?? {};
    const parts = [
      e.message ?? `HTTP ${res.status}`,
      e.code != null ? `code=${e.code}` : '',
      e.error_subcode != null ? `subcode=${e.error_subcode}` : '',
      e.error_user_title ? `title=${e.error_user_title}` : '',
      e.error_user_msg ? `user_msg=${e.error_user_msg}` : '',
      e.error_data?.details ? `details=${e.error_data.details}` : '',
    ].filter(Boolean).join(' | ');
    return { ok: false, error: parts };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network error' };
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const graphVersion = process.env.META_GRAPH_VERSION || 'v23.0';
  const token = process.env.WHATSAPP_ACCESS_TOKEN || '';
  console.log(`Digest v2 EDIT — ${dryRun ? 'DRY RUN' : 'LIVE'} | graph ${graphVersion}\n`);

  let invalid = 0;
  for (const def of EDITS) {
    const errs = validate(def);
    if (errs.length) { invalid++; console.error(`✗ ${def.name}: ${errs.join('; ')}`); }
  }
  if (invalid > 0) { console.error(`\n${invalid} invalid — nothing sent.`); process.exit(1); }

  if (dryRun) {
    for (const def of EDITS) {
      console.log(`── ${def.name} ──`);
      console.log(def.body);
      console.log();
    }
    return;
  }

  if (!token) { console.error('Missing WHATSAPP_ACCESS_TOKEN'); process.exit(1); }
  const baseUrl = `https://graph.facebook.com/${graphVersion}`;
  let ok = 0, failed = 0;
  for (const def of EDITS) {
    const r = await editOne(baseUrl, token, def);
    if (r.ok) { ok++; console.log(`✓ ${def.name}: edit accepted.`); }
    else { failed++; console.error(`✗ ${def.name}: ${r.error}`); }
  }
  console.log(`\nDone — ok=${ok}, failed=${failed}.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('Fatal:', e?.message ?? e); process.exit(1); });
