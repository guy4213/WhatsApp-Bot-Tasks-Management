import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const graphVersion = process.env.META_GRAPH_VERSION || 'v23.0';
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  const wabaIdEnv = process.env.META_WABA_ID || '';
  const token = process.env.WHATSAPP_ACCESS_TOKEN || '';

  console.log(`env META_WABA_ID              = ${wabaIdEnv}`);
  console.log(`env WHATSAPP_PHONE_NUMBER_ID  = ${phoneId}`);
  console.log();

  // 1. Ask Meta which WABA owns this phone
  const phoneUrl = `https://graph.facebook.com/${graphVersion}/${phoneId}?fields=id,display_phone_number,verified_name,whatsapp_business_account,quality_rating`;
  const rPhone = await fetch(phoneUrl, { headers: { Authorization: `Bearer ${token}` } });
  const jPhone: any = await rPhone.json();
  console.log('=== Phone number → owning WABA ===');
  console.log(JSON.stringify(jPhone, null, 2));
  console.log();

  // 2. List phones in the WABA we sent templates to
  const wabaUrl = `https://graph.facebook.com/${graphVersion}/${wabaIdEnv}/phone_numbers?fields=id,display_phone_number,verified_name`;
  const rWaba = await fetch(wabaUrl, { headers: { Authorization: `Bearer ${token}` } });
  const jWaba: any = await rWaba.json();
  console.log(`=== Phone numbers registered under META_WABA_ID (${wabaIdEnv}) ===`);
  console.log(JSON.stringify(jWaba, null, 2));
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
