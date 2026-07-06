/**
 * Edit the 4 approved digest templates to improve formatting (line breaks,
 * bullets, sections). Uses Meta's edit endpoint:
 *   POST /{template_id}   body: { category, components }
 *
 * Per Meta docs (2025-2026):
 *  - Edit rate limit: 1 per template per 24h (10 per 30 days).
 *  - Edits auto-approve immediately if they pass automated compliance checks.
 *  - The previously-approved version keeps serving during any human review.
 *
 * Usage:
 *   npx tsx scripts/edit-digest-templates.ts --dry-run    # print payloads only
 *   npx tsx scripts/edit-digest-templates.ts              # LIVE edit at Meta
 */
import dotenv from 'dotenv';
dotenv.config();

interface EditDef {
  id: string;
  name: string;
  body: string;
  example: string[];
}

// Template IDs from the create step (verified via list-whatsapp-templates.ts).
const EDITS: EditDef[] = [
  {
    id: '1325390393133400',
    name: 'employee_morning_digest',
    body:
      'בוקר טוב {{1}}!\n\n' +
      'היום משובצות לך {{2}} בדיקות שדה.\n\n' +
      'לצפייה ברשימה המלאה — שלח "הבדיקות שלי להיום".',
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
      'לפירוט מלא — שלח "דוח סוף יום שלי".',
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
      'פרטים בהודעה הבאה.',
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
      'חריגים פתוחים בהודעה הבאה.',
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
      {
        type: 'BODY',
        text: def.body,
        example: { body_text: [def.example] },
      },
    ],
  };
}

async function editOne(baseUrl: string, token: string, def: EditDef): Promise<{ ok: boolean; status?: string; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/${def.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(def)),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, status: json.status ?? 'ok' };
    const msg = json?.error?.message ?? `HTTP ${res.status}`;
    const code = json?.error?.code != null ? ` (code ${json.error.code})` : '';
    return { ok: false, error: `${msg}${code}` };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network error' };
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const graphVersion = process.env.META_GRAPH_VERSION || 'v23.0';
  const token = process.env.WHATSAPP_ACCESS_TOKEN || '';

  console.log(`Digest template EDIT — ${dryRun ? 'DRY RUN' : 'LIVE'} | graph ${graphVersion}\n`);

  let invalid = 0;
  for (const def of EDITS) {
    const errs = validate(def);
    if (errs.length) {
      invalid++;
      console.error(`✗ ${def.name}: INVALID — ${errs.join('; ')}`);
    }
  }
  if (invalid > 0) {
    console.error(`\n${invalid} template(s) failed validation — nothing sent.`);
    process.exit(1);
  }

  if (dryRun) {
    for (const def of EDITS) {
      console.log(`── ${def.name} (id ${def.id}) ──`);
      console.log(JSON.stringify(buildPayload(def), null, 2));
      console.log();
    }
    console.log(`DRY RUN complete — ${EDITS.length} payload(s) printed, 0 requests sent.`);
    return;
  }

  if (!token) {
    console.error('Missing WHATSAPP_ACCESS_TOKEN');
    process.exit(1);
  }

  const baseUrl = `https://graph.facebook.com/${graphVersion}`;
  let ok = 0, failed = 0;
  for (const def of EDITS) {
    const r = await editOne(baseUrl, token, def);
    if (r.ok) {
      ok++;
      console.log(`✓ ${def.name}: edit accepted (status=${r.status}).`);
    } else {
      failed++;
      console.error(`✗ ${def.name}: ${r.error}`);
    }
  }
  console.log(`\nDone — ok=${ok}, failed=${failed}.`);
  console.log('Next: npx tsx scripts/list-whatsapp-templates.ts  # confirm status (APPROVED / PENDING).');
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('Fatal:', e?.message ?? e); process.exit(1); });
