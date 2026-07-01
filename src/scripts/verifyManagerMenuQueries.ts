/**
 * End-to-end verification of every manager-menu-facing query.
 * Runs each query against the LIVE DB (from DATABASE_URL) and prints
 * SQL, params, row count, and up to 3 sample rows.
 *
 * Usage: npx ts-node src/scripts/verifyManagerMenuQueries.ts
 * Requires: DATABASE_URL set in .env (dev or prod, whichever you want to check).
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are also read from .env (required
 * by connection.ts). Set them to any non-empty string if you only need the pg pool.
 */
import dotenv from 'dotenv';

dotenv.config();

// Ensure Supabase vars are present (connection.ts checks them at module load)
if (!process.env.SUPABASE_URL)               process.env.SUPABASE_URL               = 'https://placeholder.supabase.co';
if (!process.env.SUPABASE_SERVICE_ROLE_KEY)  process.env.SUPABASE_SERVICE_ROLE_KEY  = 'placeholder';

import { pool } from '../db/connection';
import {
  getManagementSnapshot,
  getTodayFieldInspections,
  getFieldExceptionRows,
  getAllWorkersDayOverview,
  getWorkerDayDetail,
  searchTasksByWorkerName,
  searchTasksByProductCode,
  getTaskFieldDetail,
  type TodayFieldInspectionRow,
  type WorkerDayOverviewRow,
} from '../services/managerViews';
import {
  findCustomersByName,
  findOpenTasksForAdmin,
} from '../services/taskFieldScheduling';
import {
  findUnassignedLeadsForAssignment,
  findActiveInspectors,
  findEscalationCandidates,
  findOvernightUnassignedLeads,
  getYoramLeadCounts,
} from '../services/incomingLeads';
import {
  getFieldExceptionCounts,
  getOpenFieldExceptions,
} from '../services/exceptionsQueries';

// ── Colours (ANSI) ────────────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM    = '\x1b[2m';

const SEP = `${'━'.repeat(62)}`;

function hdr(label: string): void {
  console.log(`\n${CYAN}${SEP}${RESET}`);
  console.log(`${BOLD}${CYAN}▸ ${label}${RESET}`);
}

function printRows(rows: unknown[], label: string): void {
  const sample = rows.slice(0, 3);
  const count  = rows.length;
  const color  = count > 0 ? GREEN : YELLOW;
  console.log(`${color}▸ Row count: ${count}${RESET}`);
  if (sample.length > 0) {
    console.log(`${DIM}▸ First ${sample.length} row(s):${RESET}`);
    sample.forEach((r, i) => {
      const s = JSON.stringify(r, null, 2)
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');
      console.log(`  row ${i + 1}:\n${DIM}${s}${RESET}`);
    });
  }
  results.push({ label, ok: true, rows: count });
}

function printErr(label: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`${RED}▸ ERROR: ${msg}${RESET}`);
  results.push({ label, ok: false, rows: 0 });
}

interface Result {
  label: string;
  ok: boolean;
  rows: number;
  note?: string;
}
const results: Result[] = [];

/** Run a query that returns an array. Returns the array or null on error. */
async function runArr<T>(
  label: string,
  fn: () => Promise<T[]>,
): Promise<T[] | null> {
  hdr(label);
  const t0 = Date.now();
  try {
    const arr = await fn();
    const ms = Date.now() - t0;
    printRows(arr, label);
    console.log(`${DIM}▸ Timing: ${ms}ms${RESET}`);
    return arr;
  } catch (err) {
    printErr(label, err);
    return null;
  }
}

/** Run a query that returns a single value; wrap it as a 1-element array for display. */
async function runOne<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  hdr(label);
  const t0 = Date.now();
  try {
    const val = await fn();
    const ms = Date.now() - t0;
    printRows(val != null ? [val] : [], label);
    console.log(`${DIM}▸ Timing: ${ms}ms${RESET}`);
    return val;
  } catch (err) {
    printErr(label, err);
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Local date in Asia/Jerusalem
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  console.log(`\n${BOLD}${CYAN}בודק על local_date = ${localDate} (Asia/Jerusalem)${RESET}\n`);

  // 1. Management snapshot
  await runOne(
    `getManagementSnapshot('${localDate}')`,
    () => getManagementSnapshot(localDate),
  );

  // 2. Today field inspections
  const todayRows: TodayFieldInspectionRow[] | null = await runArr(
    `getTodayFieldInspections('${localDate}')`,
    () => getTodayFieldInspections(localDate),
  );

  // 3. Field exception rows — all 5 filters
  const filters = [
    'open_exceptions', 'not_confirmed', 'has_problem', 'waiting_for_info', 'not_closed',
  ] as const;
  for (const f of filters) {
    await runArr(
      `getFieldExceptionRows('${localDate}', '${f}')`,
      () => getFieldExceptionRows(localDate, f),
    );
  }

  // 4. All workers day overview
  const workerOverview: WorkerDayOverviewRow[] | null = await runArr(
    `getAllWorkersDayOverview('${localDate}')`,
    () => getAllWorkersDayOverview(localDate),
  );

  // 5. Worker day detail — pick first worker from overview if available
  let pickedWorkerId: string | null = null;
  if (workerOverview && workerOverview.length > 0) {
    pickedWorkerId = workerOverview[0].workerId;
  }

  if (pickedWorkerId) {
    const label = `getWorkerDayDetail('${pickedWorkerId}', '${localDate}')`;
    hdr(label);
    const t0 = Date.now();
    try {
      const detail = await getWorkerDayDetail(pickedWorkerId, localDate);
      const ms = Date.now() - t0;
      printRows(detail.inspections, label);
      console.log(`${DIM}▸ Timing: ${ms}ms${RESET}`);
    } catch (err) {
      printErr(label, err);
    }
  } else {
    hdr(`getWorkerDayDetail(<no worker today>, '${localDate}')`);
    console.log(`${YELLOW}▸ Skipped — no workers found for today${RESET}`);
    results.push({ label: 'getWorkerDayDetail(skipped)', ok: true, rows: 0, note: 'no workers today' });
  }

  // 6. Search by worker name
  await runArr(
    `searchTasksByWorkerName('יאיר')`,
    () => searchTasksByWorkerName('יאיר'),
  );
  await runArr(
    `searchTasksByWorkerName('דני')`,
    () => searchTasksByWorkerName('דני'),
  );

  // 7. Search by product code
  await runArr(
    `searchTasksByProductCode('10156')`,
    () => searchTasksByProductCode('10156'),
  );

  // 8. Task field detail — pick first from today's list if available
  let pickedTaskFieldId: string | null = null;
  if (todayRows && todayRows.length > 0) {
    pickedTaskFieldId = todayRows[0].taskFieldId;
  }

  if (pickedTaskFieldId) {
    const label = `getTaskFieldDetail('${pickedTaskFieldId}')`;
    hdr(label);
    const t0 = Date.now();
    try {
      const detail = await getTaskFieldDetail(pickedTaskFieldId);
      const ms = Date.now() - t0;
      printRows(detail ? [detail] : [], label);
      console.log(`${DIM}▸ Timing: ${ms}ms${RESET}`);
    } catch (err) {
      printErr(label, err);
    }
  } else {
    hdr(`getTaskFieldDetail(<no taskField today>)`);
    console.log(`${YELLOW}▸ Skipped — no TaskField rows for today${RESET}`);
    results.push({ label: 'getTaskFieldDetail(skipped)', ok: true, rows: 0, note: 'no today rows' });
  }

  // 9. Find customers by name
  await runArr(
    `findCustomersByName('כהן')`,
    () => findCustomersByName('כהן'),
  );

  // 10. Find open tasks for admin
  await runArr(
    `findOpenTasksForAdmin()`,
    () => findOpenTasksForAdmin(),
  );

  // 11. Find unassigned leads for assignment
  await runArr(
    `findUnassignedLeadsForAssignment()`,
    () => findUnassignedLeadsForAssignment(),
  );

  // 12. Find escalation candidates
  await runArr(
    `findEscalationCandidates()`,
    () => findEscalationCandidates(),
  );

  // 13. Find active inspectors
  await runArr(
    `findActiveInspectors()`,
    () => findActiveInspectors(),
  );

  // 14. Find overnight unassigned leads
  await runArr(
    `findOvernightUnassignedLeads('${localDate}')`,
    () => findOvernightUnassignedLeads(localDate),
  );

  // 15. Yoram lead counts
  await runOne(
    `getYoramLeadCounts('${localDate}')`,
    () => getYoramLeadCounts(localDate),
  );

  // 16. Field exception counts
  await runOne(
    `getFieldExceptionCounts('${localDate}')`,
    () => getFieldExceptionCounts(localDate),
  );

  // 17. Open field exceptions
  await runArr(
    `getOpenFieldExceptions('${localDate}')`,
    () => getOpenFieldExceptions(localDate),
  );

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${CYAN}${SEP}${RESET}`);
  console.log(`${BOLD}SUMMARY${RESET}`);

  const withRows = results.filter((r) => r.ok && r.rows > 0);
  const empty    = results.filter((r) => r.ok && r.rows === 0);
  const errored  = results.filter((r) => !r.ok);

  console.log(`${GREEN}✓ ${withRows.length} / ${results.length} queries returned rows${RESET}`);

  if (empty.length > 0) {
    console.log(`${YELLOW}⚠  ${empty.length} queries returned 0 rows (may or may not be a bug):${RESET}`);
    for (const r of empty) {
      const note = r.note ? `  — ${r.note}` : '';
      console.log(`    - ${r.label}${note}`);
    }
  }

  if (errored.length > 0) {
    console.log(`${RED}✗ ${errored.length} queries errored:${RESET}`);
    for (const r of errored) {
      console.log(`    - ${r.label}`);
    }
  }

  console.log(`${CYAN}${SEP}${RESET}\n`);
}

main()
  .catch((err) => {
    console.error(`${RED}[verify] FATAL: ${err instanceof Error ? err.message : String(err)}${RESET}`);
    process.exit(1);
  })
  .finally(() => pool.end());
