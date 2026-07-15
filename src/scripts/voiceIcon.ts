/**
 * Embed a robot/logo image into the voice assistant as a base64 data URI.
 *
 * Rewrites src/routes/voiceAssets.ts so the page center, the PWA app icon, and
 * the browser favicon all use the given image (single source of truth). After
 * running, rebuild/redeploy the bot.
 *
 *   npm run voice:icon -- <path-to-image.png|jpg|webp>
 *
 * Example:
 *   npm run voice:icon -- C:/Users/yonat/Desktop/gali-robot.png
 */
import * as fs from 'fs';
import * as path from 'path';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function main(): void {
  const src = process.argv[2];
  if (!src) {
    console.error('Usage: npm run voice:icon -- <path-to-image>');
    process.exit(1);
  }
  if (!fs.existsSync(src)) {
    console.error(`File not found: ${src}`);
    process.exit(1);
  }

  const ext = path.extname(src).toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    console.error(`Unsupported image type "${ext}". Use png / jpg / webp / gif.`);
    process.exit(1);
  }

  const bytes = fs.readFileSync(src);
  const sizeKb = Math.round(bytes.length / 1024);
  // Data URIs bloat the HTML (base64 is ~33% larger). Warn past ~700 KB raw —
  // the page inlines it on every /voice load.
  if (sizeKb > 700) {
    console.warn(
      `⚠ Image is ${sizeKb} KB — the data URI is embedded in every page load. ` +
        `Consider compressing to < 300 KB (e.g. a 512×512 PNG) for a snappy page.`,
    );
  }

  const dataUri = `data:${mime};base64,${bytes.toString('base64')}`;

  const target = path.join(__dirname, '..', 'routes', 'voiceAssets.ts');
  const original = fs.readFileSync(target, 'utf8');

  // Replace the ROBOT_DATA_URI export line, preserving the rest of the file.
  const replaced = original.replace(
    /export const ROBOT_DATA_URI: string \| null = [^;]*;/,
    `export const ROBOT_DATA_URI: string | null = ${JSON.stringify(dataUri)};`,
  );

  if (replaced === original) {
    console.error('Could not find the ROBOT_DATA_URI export to replace — was voiceAssets.ts edited?');
    process.exit(1);
  }

  fs.writeFileSync(target, replaced, 'utf8');
  console.log(`✓ Embedded ${src} (${sizeKb} KB) into src/routes/voiceAssets.ts`);
  console.log('  → rebuild + redeploy the bot (git push / npm run build) to publish it.');
}

main();
