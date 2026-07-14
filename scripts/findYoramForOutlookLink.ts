/**
 * Throwaway pre-flight helper: find Yoram Gabai's User.id + phone + role,
 * verify identity before wiring the Outlook OAuth link to that user.
 * Read-only. Delete after use.
 */
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'disable'
      ? false
      : { rejectUnauthorized: false },
  });

  const { rows } = await pool.query<{
    id: string;
    name: string;
    phone: string | null;
    role: string;
    status: string;
  }>(
    `SELECT id, name, phone, role, status
     FROM "User"
     WHERE name ILIKE '%יורם%'
        OR name ILIKE '%גבאי%'
        OR name ILIKE '%yoram%'
        OR name ILIKE '%gabay%'
     ORDER BY name`,
  );

  if (rows.length === 0) {
    console.log('NO ROWS matched Yoram / Gabay');
    process.exit(0);
  }

  for (const r of rows) {
    console.log(JSON.stringify(r, null, 2));
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
