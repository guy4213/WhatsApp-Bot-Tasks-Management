import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
p.query(
  `SELECT * FROM "WhatsappCustomerNotification" WHERE "taskFieldId" = '2640132b-f324-4226-9c90-c43a19d3c940'`,
).then((r) => {
  console.log('WhatsappCustomerNotification rows for this TaskField:');
  console.log(JSON.stringify(r.rows, null, 2));
  return p.end();
});
