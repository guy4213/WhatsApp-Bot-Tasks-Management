/**
 * Submit the 10 WhatsApp **Utility** message templates to Meta for approval,
 * via the official Graph API:
 *   POST https://graph.facebook.com/<version>/<WABA_ID>/message_templates
 *
 * Usage (project uses ts-node — tsx is not installed):
 *   npm run templates:dry-run     # prints payloads, never calls Meta
 *   npm run templates:create      # submits to Meta
 *
 * Env (loaded from .env via dotenv):
 *   META_GRAPH_VERSION    e.g. v23.0   (default: v23.0)
 *   META_WABA_ID          WhatsApp Business Account id   (required for live submit)
 *   WHATSAPP_ACCESS_TOKEN     Graph API token               (required for live submit; NEVER logged)
 *   WHATSAPP_TEMPLATE_LANG  default: he
 *
 * Safety: the access token is only ever placed in the Authorization header — it is
 * never printed. Template names come from the shared registry (templateNames.ts),
 * so they stay in sync with the runtime sender and honour WHATSAPP_TEMPLATE_<KEY>.
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

// Bodies + example values. Bodies are validated below to satisfy Meta's rules
// (no leading/trailing variable, no adjacent variables). DUEDATE_APPROVAL_REQUEST
// is prefixed with "שלום, " so it does not start with {{1}}.
const TEMPLATES: TemplateDef[] = [
  { key: 'DAILY_SUMMARY',
    body: 'שלום {{1}}! סיכום יומי: יש לך {{2}} משימות פתוחות. שלח "המשימות שלי" לרשימה המלאה.',
    example: ['דניאל', '8'] },
  { key: 'DUE_REMINDER',
    body: 'תזכורת: המשימה "{{1}}" מגיעה למועדה היום בשעה {{2}}. אנא היערך בהתאם.',
    example: ['לשלוח הצעת מחיר', '15:00'] },
  { key: 'DEADLINE_EXCEEDED',
    body: 'שלום {{1}}, התראה: קיימות {{2}} משימות שעבר מועדן.',
    example: ['יורם', '3'] },
  { key: 'DEADLINE_APPROACHING',
    body: 'שלום {{1}}, תזכורת: {{2}} משימות מתקרבות למועדן ב-{{3}} השעות הקרובות.',
    example: ['יורם', '5', '24'] },
  { key: 'DUEDATE_APPROVAL_REQUEST',
    body: 'שלום, {{1}} מבקש לשנות את מועד המשימה "{{2}}" ל-{{3}}. השב "אשר {{4}}" לאישור או "דחה {{4}}" לדחייה.',
    example: ['דניאל', 'חזרה ללקוח משה כהן', 'מחר בשעה 10:00', 'abc123'] },
  { key: 'DUEDATE_APPROVED',
    body: 'מועד המשימה "{{1}}" שונה ל-{{2}} ואושר על ידי {{3}}. העדכון נשמר במערכת.',
    example: ['חזרה ללקוח משה כהן', 'מחר בשעה 10:00', 'יורם'] },
  { key: 'DUEDATE_REJECTED',
    body: 'בקשתך לשינוי מועד המשימה "{{1}}" נדחתה על ידי {{2}}. ניתן לפנות אליו לפרטים.',
    example: ['חזרה ללקוח משה כהן', 'יורם'] },
  { key: 'TASK_COMPLETED',
    body: 'המשימה "{{1}}" של {{2}} סומנה כבוצעה במערכת.',
    example: ['בדיקת קרינה ללקוח', 'דניאל'] },
  { key: 'REQUEST_EXPIRED',
    body: 'בקשתך לגבי המשימה "{{1}}" פגה ולא בוצעה. ניתן לשלוח אותה מחדש.',
    example: ['שינוי מועד משימה'] },
  { key: 'REQUEST_EXPIRED_MANAGER',
    body: 'בקשת {{1}} לגבי המשימה "{{2}}" פגה ללא טיפול.',
    example: ['דניאל', 'חזרה ללקוח משה כהן'] },
];

// ── Validation ──────────────────────────────────────────────────────────────────

function placeholders(body: string): number[] {
  return [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => parseInt(m[1], 10));
}

function validate(def: TemplateDef, name: string, lang: string): string[] {
  const errs: string[] = [];
  const trimmed = def.body.trim();
  if (/^\{\{/.test(trimmed)) errs.push('body starts with a variable');
  // Meta rejects a body that ends with a variable — and trailing punctuation/quotes
  // after the last {{n}} does NOT count as "text after" (Graph error 100/2388299).
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

// ── Meta Graph API helpers (token only in headers, never logged) ────────────────

/** Concise error string from a Graph error body — contains no secrets. */
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

interface Existing { body: string; status: string }

async function listExisting(baseUrl: string, token: string): Promise<Map<string, Existing>> {
  const map = new Map<string, Existing>();
  try {
    const res = await fetch(`${baseUrl}?fields=name,status,components&limit=250`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`! Could not list existing templates (${describeError(json, res.status)}) — proceeding without body comparison.`);
      return map;
    }
    for (const t of json.data ?? []) {
      const body = (t.components ?? []).find((c: any) => c.type === 'BODY')?.text ?? '';
      map.set(t.name, { body, status: t.status });
    }
  } catch {
    console.warn('! Could not list existing templates (network) — proceeding without body comparison.');
  }
  return map;
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

// ── Main ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const graphVersion = process.env.META_GRAPH_VERSION || 'v23.0';
  const wabaId = process.env.META_WABA_ID || '';
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
  const lang = templateLang();

  console.log(`WhatsApp templates — ${dryRun ? 'DRY RUN (no requests)' : 'LIVE SUBMIT'} | graph ${graphVersion} | lang ${lang}\n`);

  const defs = TEMPLATES.map((def) => ({ def, name: templateName(def.key) }));

  // 1. Validate everything first — a broken template is a real failure.
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

  // 2. Dry run — print payloads, never touch Meta.
  if (dryRun) {
    for (const { def, name } of defs) {
      console.log(`--- ${name} ---`);
      console.log(`POST ${graphVersion}/<META_WABA_ID>/message_templates`);
      console.log(JSON.stringify(buildPayload(def, name, lang), null, 2));
      console.log('');
    }
    console.log(`DRY RUN complete — ${defs.length} payload(s) printed, 0 requests sent.`);
    return; // exit 0
  }

  // 3. Live submit — require creds.
  const missing: string[] = [];
  if (!wabaId) missing.push('META_WABA_ID');
  if (!accessToken) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (missing.length) {
    console.error(`Missing required env var(s) for live submit: ${missing.join(', ')}.`);
    console.error('Set them in .env (or the shell) or run with --dry-run to preview without them.');
    process.exit(1);
  }

  const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates`;
  const existing = await listExisting(url, accessToken);

  let submitted = 0, skipped = 0, warned = 0, failed = 0;
  for (const { def, name } of defs) {
    const ex = existing.get(name);
    if (ex) {
      if (ex.body === def.body) {
        skipped++;
        console.log(`• ${name}: skipped — already exists (identical, status=${ex.status}).`);
      } else {
        warned++;
        console.warn(`⚠ ${name}: already exists with a DIFFERENT body — NOT overwriting. ` +
          `Meta's create endpoint cannot update; ask explicitly to handle an update path.`);
      }
      continue;
    }
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

  console.log(`\nDone — submitted=${submitted}, skipped=${skipped}, warned=${warned}, failed=${failed}.`);
  console.log('Templates are PENDING review in Meta. Keep WHATSAPP_TEMPLATES_ENABLED=false until all are Approved.');
  if (failed > 0) process.exit(1); // non-zero only on real failed submissions
}

main().catch((err) => {
  console.error('Fatal error:', err?.message ?? err);
  process.exit(1);
});
