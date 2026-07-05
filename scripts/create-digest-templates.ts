/**
 * Submit the 4 MISSING WhatsApp digest templates to Meta:
 *   employee_morning_digest       (2 params — from formatInspectorMorning)
 *   employee_end_of_day_report    (6 params — from formatEmployeeEndOfDay)
 *   manager_morning_digest        (8 params — from formatGalitManagerMorning)
 *   manager_end_of_day_report     (8 params — from formatGalitManagerEndOfDay)
 *
 * Usage:
 *   npx tsx scripts/create-digest-templates.ts --dry-run    # prints payloads only
 *   npx tsx scripts/create-digest-templates.ts              # LIVE submit to Meta
 *
 * Category: UTILITY (matches the other 10 already-approved templates).
 * Token is only used in Authorization headers, never logged.
 */
import dotenv from 'dotenv';
import { type NotificationKey, templateName, templateLang } from '../src/whatsapp/templateNames';

dotenv.config();

const CATEGORY = 'UTILITY';

interface TemplateDef {
  key: NotificationKey;
  body: string;
  example: string[]; // one value per {{n}}, in order
}

// Body-param contracts sourced directly from digestContent.ts formatters:
//
//   EMPLOYEE_MORNING_DIGEST     formatInspectorMorning       → [name, count]
//   EMPLOYEE_END_OF_DAY_REPORT  formatEmployeeEndOfDay       → [name, dueToday, completed, notCompleted, overdue, openCarry]
//   MANAGER_MORNING_DIGEST      formatGalitManagerMorning    → [name, finishedFieldToday, notConfirmedToday, hasProblemToday, waitingForInfoToday, notClosedDayToday, overnight, unassigned]
//   MANAGER_END_OF_DAY_REPORT   formatGalitManagerEndOfDay   → same 8 as MANAGER_MORNING_DIGEST
const TEMPLATES: TemplateDef[] = [
  {
    key: 'EMPLOYEE_MORNING_DIGEST',
    body:
      'בוקר טוב {{1}}! היום משובצות לך {{2}} בדיקות שדה. ' +
      'שלח "הבדיקות שלי להיום" לצפייה ברשימה המלאה.',
    example: ['דניאל', '4'],
  },
  {
    key: 'EMPLOYEE_END_OF_DAY_REPORT',
    body:
      'ערב טוב {{1}}! דוח סוף יום: מתוך {{2}} משימות להיום — בוצעו {{3}}, לא בוצעו {{4}}, ' +
      'באיחור {{5}}, פתוחות שעוברות למחר {{6}}. שלח "דוח סוף יום שלי" לפירוט מלא.',
    example: ['דניאל', '5', '3', '2', '1', '2'],
  },
  {
    key: 'MANAGER_MORNING_DIGEST',
    body:
      'בוקר טוב {{1}}! סיכום שדה להיום — בוצעו {{2}}, לא אושרו {{3}}, בעיות {{4}}, ' +
      'ממתין למידע {{5}}, לא נסגרו {{6}}. לידים מהלילה {{7}}, לידים לא משויכים {{8}}. ' +
      'פרטים בהודעה הבאה.',
    example: ['גיא', '2', '5', '0', '0', '7', '3', '1'],
  },
  {
    key: 'MANAGER_END_OF_DAY_REPORT',
    body:
      'ערב טוב {{1}}! סיכום סוף יום בשדה — בוצעו {{2}}, לא אושרו {{3}}, בעיות {{4}}, ' +
      'ממתין למידע {{5}}, לא נסגרו {{6}}. לידים מהלילה {{7}}, לידים לא משויכים {{8}}. ' +
      'חריגים פתוחים בהודעה הבאה.',
    example: ['גיא', '4', '2', '1', '0', '5', '3', '0'],
  },
];

function placeholders(body: string): number[] {
  return [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => parseInt(m[1], 10));
}

function validate(def: TemplateDef, name: string, lang: string): string[] {
  const errs: string[] = [];
  const trimmed = def.body.trim();
  if (/^\{\{/.test(trimmed)) errs.push('body starts with a variable');
  const withoutTrailingPunct = trimmed.replace(/[\s.,!?:;"'()\-־]+$/u, '');
  if (/\}\}$/.test(withoutTrailingPunct)) {
    errs.push('body effectively ends with a variable — add real text after the last {{n}}');
  }
  if (/\}\}\s*\{\{/.test(def.body)) errs.push('adjacent variables with no text between them');

  const nums = placeholders(def.body);
  const max = nums.length ? Math.max(...nums) : 0;
  const set = new Set(nums);
  for (let i = 1; i <= max; i++) if (!set.has(i)) errs.push(`missing placeholder {{${i}}}`);
  if (def.example.length !== max) errs.push(`example count (${def.example.length}) != placeholders (${max})`);

  if (!/^[a-z0-9_]+$/.test(name)) errs.push(`name "${name}" must be lowercase letters/digits/underscores only`);
  if (lang !== 'he') errs.push(`language must be "he" (got "${lang}")`);
  return errs;
}

function buildPayload(def: TemplateDef, name: string, lang: string) {
  return {
    name,
    category: CATEGORY,
    language: lang,
    components: [
      {
        type: 'BODY',
        text: def.body,
        example: { body_text: [def.example] },
      },
    ],
  };
}

function describeError(json: any, status?: number): string {
  const e = json?.error;
  if (e?.message) {
    const code = e.code != null ? ` (code ${e.code}${e.error_subcode != null ? `/${e.error_subcode}` : ''})` : '';
    return `${e.message}${code}`;
  }
  return status != null ? `HTTP ${status}` : 'unknown error';
}

function looksLikeDuplicate(json: any): boolean {
  const e = json?.error;
  const msg = String(e?.message ?? '');
  return /already exists/i.test(msg) || e?.error_subcode === 2388023;
}

interface SubmitResult { ok: boolean; id?: string; status?: string; alreadyExists?: boolean; error?: string }

async function submit(url: string, token: string, payload: unknown): Promise<SubmitResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: json.id, status: json.status };
    if (looksLikeDuplicate(json)) return { ok: false, alreadyExists: true };
    return { ok: false, error: describeError(json, res.status) };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network error' };
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const graphVersion = process.env.META_GRAPH_VERSION || 'v23.0';
  const wabaId = process.env.META_WABA_ID || '';
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
  const lang = templateLang();

  console.log(`Digest templates — ${dryRun ? 'DRY RUN (no requests)' : 'LIVE SUBMIT'} | graph ${graphVersion} | lang ${lang}\n`);

  const defs = TEMPLATES.map((def) => ({ def, name: templateName(def.key) }));

  let invalid = 0;
  for (const { def, name } of defs) {
    const errs = validate(def, name, lang);
    if (errs.length) {
      invalid++;
      console.error(`✗ ${name}: INVALID — ${errs.join('; ')}`);
    }
  }
  if (invalid > 0) {
    console.error(`\n${invalid} template(s) failed validation — nothing submitted.`);
    process.exit(1);
  }

  if (dryRun) {
    for (const { def, name } of defs) {
      console.log(`--- ${name} ---`);
      console.log(`POST ${graphVersion}/<META_WABA_ID>/message_templates`);
      console.log(JSON.stringify(buildPayload(def, name, lang), null, 2));
      console.log('');
    }
    console.log(`DRY RUN complete — ${defs.length} payload(s) printed, 0 requests sent.`);
    return;
  }

  const missing: string[] = [];
  if (!wabaId) missing.push('META_WABA_ID');
  if (!accessToken) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (missing.length) {
    console.error(`Missing required env var(s): ${missing.join(', ')}`);
    process.exit(1);
  }

  const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates`;
  let submitted = 0, skipped = 0, failed = 0;
  for (const { def, name } of defs) {
    const r = await submit(url, accessToken, buildPayload(def, name, lang));
    if (r.ok) {
      submitted++;
      console.log(`✓ ${name}: submitted (id=${r.id ?? '?'}, status=${r.status ?? 'PENDING'}).`);
    } else if (r.alreadyExists) {
      skipped++;
      console.log(`• ${name}: skipped — already exists.`);
    } else {
      failed++;
      console.error(`✗ ${name}: failed — ${r.error}`);
    }
  }

  console.log(`\nDone — submitted=${submitted}, skipped=${skipped}, failed=${failed}.`);
  console.log('Templates are PENDING at Meta. When all show APPROVED, set WHATSAPP_TEMPLATES_ENABLED=true.');
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err?.message ?? err);
  process.exit(1);
});
