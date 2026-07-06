import { pool } from '../src/db/connection';

async function main() {
  for (const table of ['Task', 'Customer']) {
    console.log(`\n=== "${table}" columns ===`);
    const { rows } = await pool.query<{ column: string; type: string; nullable: string; default: string | null }>(
      `SELECT column_name AS column, data_type AS type, is_nullable AS nullable, column_default AS default
         FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position`,
      [table],
    );
    for (const r of rows) {
      console.log(`  ${r.column.padEnd(30)} | ${r.type.padEnd(30)} | nullable=${r.nullable} | default=${r.default ?? ''}`);
    }
  }

  console.log('\n=== a sample InspectionType we can reuse ===');
  const { rows: types } = await pool.query<{ id: string; code: string; labelHe: string; family: string }>(
    `SELECT id::text, code, "labelHe", family
       FROM "InspectionType"
      WHERE family = 'radon' AND "isFieldInspection" = true
      ORDER BY "sortOrder"
      LIMIT 1`,
  );
  console.log(types[0]);

  console.log('\n=== Guy Franses user ===');
  const { rows: u } = await pool.query<{ id: string; name: string; phone: string; role: string; status: string }>(
    `SELECT id::text, name, phone, role::text, status::text FROM "User" WHERE name = 'גיא פרנסס'`,
  );
  console.log(u[0]);

  await pool.end();
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
