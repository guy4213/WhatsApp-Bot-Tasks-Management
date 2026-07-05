/**
 * List existing WhatsApp templates at Meta + compare against what the code expects.
 * READ-ONLY: never POSTs, never modifies Meta. Access token used only in header.
 *
 * Run:  npx tsx scripts/list-whatsapp-templates.ts
 */
import dotenv from 'dotenv';
import { DEFAULT_TEMPLATE_NAMES, templateName, templateLang, type NotificationKey } from '../src/whatsapp/templateNames';

dotenv.config();

interface MetaTemplate {
  name: string;
  status: string;
  language: string;
  category: string;
  components: Array<{ type: string; text?: string; format?: string }>;
  id?: string;
  rejected_reason?: string;
}

async function main(): Promise<void> {
  const graphVersion = process.env.META_GRAPH_VERSION || 'v23.0';
  const wabaId = process.env.META_WABA_ID || '';
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
  const lang = templateLang();

  const missing: string[] = [];
  if (!wabaId) missing.push('META_WABA_ID');
  if (!accessToken) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (missing.length) {
    console.error(`Missing env: ${missing.join(', ')}`);
    process.exit(1);
  }

  const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/message_templates?fields=name,status,language,category,components,id,rejected_reason&limit=250`;
  console.log(`Fetching from Meta Graph ${graphVersion} for WABA ${wabaId.slice(0, 6)}...\n`);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json: any = await res.json();
  if (!res.ok) {
    console.error(`Meta API error ${res.status}:`, JSON.stringify(json.error ?? json, null, 2));
    process.exit(1);
  }

  const templates: MetaTemplate[] = json.data ?? [];

  console.log(`=== ALL templates registered at Meta (${templates.length}) ===\n`);
  console.log('status       | lang | category  | name');
  console.log('-'.repeat(90));
  for (const t of templates.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`${t.status.padEnd(12)} | ${t.language.padEnd(4)} | ${t.category.padEnd(9)} | ${t.name}${t.rejected_reason ? ` (rejected: ${t.rejected_reason})` : ''}`);
  }

  const expectedKeys = Object.keys(DEFAULT_TEMPLATE_NAMES) as NotificationKey[];
  const expected = expectedKeys.map((k) => ({ key: k, name: templateName(k) }));

  console.log(`\n=== What the code expects (${expected.length} templates in NotificationKey) ===\n`);
  console.log('key                            | resolved name                    | status at Meta');
  console.log('-'.repeat(110));
  const byName = new Map(templates.filter((t) => t.language === lang).map((t) => [t.name, t] as const));
  let approved = 0, pending = 0, rejected = 0, notFound = 0;
  const missingNames: string[] = [];
  for (const { key, name } of expected) {
    const t = byName.get(name);
    const status = t ? t.status : 'NOT_FOUND';
    if (status === 'APPROVED') approved++;
    else if (status === 'PENDING') pending++;
    else if (status === 'REJECTED') rejected++;
    else { notFound++; missingNames.push(name); }
    console.log(`${key.padEnd(30)} | ${name.padEnd(32)} | ${status}${t?.rejected_reason ? ` (${t.rejected_reason})` : ''}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`  APPROVED:  ${approved}`);
  console.log(`  PENDING:   ${pending}`);
  console.log(`  REJECTED:  ${rejected}`);
  console.log(`  NOT_FOUND: ${notFound}`);
  if (missingNames.length > 0) {
    console.log(`\nMissing (not registered at Meta at all):`);
    for (const n of missingNames) console.log(`  - ${n}`);
  }

  console.log(`\nWHATSAPP_TEMPLATES_ENABLED currently: ${process.env.WHATSAPP_TEMPLATES_ENABLED ?? '(unset)'}`);
}

main().catch((err) => {
  console.error('Fatal:', err?.message ?? err);
  process.exit(1);
});
