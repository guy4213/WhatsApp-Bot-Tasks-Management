/**
 * DEV/DEMO ONLY — simulates a worker "on the road" for the live-tracking demo
 * page, without needing a real phone running OwnTracks.
 *
 * What it does:
 *   1. Opens a TrackingSession for --taskfield via the real `openTrackingSession`
 *      service (same semantics as a worker sending "יצאתי" — supersedes any
 *      prior ACTIVE|ARRIVED session for --worker).
 *   2. Prints the public tracking URL (`/t/<token>`).
 *   3. Every --interval ms, UPSERTs `WorkerLiveLocation` for --worker, stepping
 *      linearly from --from to --to over --steps ticks, so the demo page shows
 *      the marker moving.
 *
 * This is a throwaway dev tool — NOT wired into any production flow, NOT
 * imported by app code. Safe to run against a scratch/staging DB only.
 *
 * Usage:
 *   npx tsx scripts/seedTrackingDemo.ts \
 *     --worker <userId> --taskfield <taskFieldId> \
 *     [--from 32.0853,34.7818] [--to 32.0700,34.7900] \
 *     [--steps 20] [--interval 5000]
 *
 * Ctrl-C stops the ticking loop. The TrackingSession is left ACTIVE on exit —
 * the demo page keeps showing the last location. To close it manually:
 *   UPDATE "TrackingSession" SET status='FINISHED', "endedAt"=now(), "updatedAt"=now()
 *     WHERE "taskFieldId" = '<taskFieldId>' AND status IN ('ACTIVE','ARRIVED');
 */
import 'dotenv/config';
import { pool } from '../src/db/connection';
import { openTrackingSession } from '../src/services/tracking';
import { upsertLiveLocation } from '../src/services/workerLocation';

const DEFAULT_FROM = { lat: 32.0853, lng: 34.7818 }; // Tel Aviv
const DEFAULT_TO = { lat: 32.0700, lng: 34.7900 };   // ~2km south-east
const DEFAULT_STEPS = 20;
const DEFAULT_INTERVAL_MS = 5000;
const DEMO_WORKER_KEY = 'seed-tracking-demo-script';

interface Args {
  worker: string;
  taskfield: string;
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  steps: number;
  intervalMs: number;
}

function parseLatLng(raw: string, flag: string): { lat: number; lng: number } {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`--${flag} must be "lat,lng" (got "${raw}")`);
  }
  return { lat: parts[0], lng: parts[1] };
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const worker = get('worker');
  const taskfield = get('taskfield');
  if (!worker || !taskfield) {
    throw new Error('Required: --worker <userId> --taskfield <taskFieldId>');
  }

  const fromRaw = get('from');
  const toRaw = get('to');
  const stepsRaw = get('steps');
  const intervalRaw = get('interval');

  return {
    worker,
    taskfield,
    from: fromRaw ? parseLatLng(fromRaw, 'from') : DEFAULT_FROM,
    to: toRaw ? parseLatLng(toRaw, 'to') : DEFAULT_TO,
    steps: stepsRaw ? Math.max(1, parseInt(stepsRaw, 10)) : DEFAULT_STEPS,
    intervalMs: intervalRaw ? Math.max(500, parseInt(intervalRaw, 10)) : DEFAULT_INTERVAL_MS,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[FAIL] ${(err as Error).message}`);
    console.error('\nUsage: npx tsx scripts/seedTrackingDemo.ts --worker <userId> --taskfield <taskFieldId> [--from lat,lng] [--to lat,lng] [--steps 20] [--interval 5000]');
    process.exitCode = 1;
    return;
  }

  console.log(`Opening TrackingSession — worker=${args.worker} taskField=${args.taskfield} ...`);
  const session = await openTrackingSession({ taskFieldId: args.taskfield, workerUserId: args.worker });

  const base = (process.env.TRACKING_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  console.log(`\n✓ Session opened (id=${session.sessionId}, supersededCount=${session.supersededCount})`);
  console.log(`  Tracking URL: ${base}/t/${session.publicToken}\n`);
  console.log(`Stepping ${args.steps} ticks every ${args.intervalMs}ms:`);
  console.log(`  from (${args.from.lat}, ${args.from.lng}) to (${args.to.lat}, ${args.to.lng})`);
  console.log('\nPress Ctrl-C to stop. The session stays ACTIVE on exit — see the file header for how to close it manually.\n');

  let tick = 0;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    console.log('\nStopped. TrackingSession left ACTIVE — close it manually if you are done (see file header).');
    await pool.end().catch(() => { /* best-effort */ });
    process.exit(0);
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });

  const timer = setInterval(async () => {
    if (tick > args.steps) {
      console.log('\nReached the last step. Loop finished — leaving the session ACTIVE at the final location.');
      await stop();
      return;
    }
    const t = args.steps === 0 ? 1 : tick / args.steps;
    const lat = lerp(args.from.lat, args.to.lat, t);
    const lng = lerp(args.from.lng, args.to.lng, t);
    try {
      await upsertLiveLocation({
        workerUserId: args.worker,
        workerKey: DEMO_WORKER_KEY,
        lat,
        lng,
        trigger: 'seed-demo',
        recordedAt: new Date(),
      });
      console.log(`  [${tick}/${args.steps}] lat=${lat.toFixed(6)} lng=${lng.toFixed(6)}`);
    } catch (err) {
      console.error(`  [${tick}/${args.steps}] upsert failed:`, err instanceof Error ? err.message : err);
    }
    tick += 1;
  }, args.intervalMs);
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
