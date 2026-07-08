/**
 * OwnTracks GPS POC — inbound location receiver + debug view.
 *
 * Goal (see docs/POC_OWNTRACKS.md): prove OwnTracks works as a live GPS source
 * before building the full customer arrival-tracking feature. This plugin ONLY
 * receives raw location pings (HTTP mode) and stores them append-only in
 * "PocLocationPing" so we can measure real-world update frequency on Android vs
 * iPhone (background / screen-off / in-pocket / while Waze navigates).
 *
 * Routes:
 *   POST /owntracks            — PUBLIC. OwnTracks apps POST here directly.
 *                                Authenticated with per-worker HTTP Basic auth
 *                                (allowlist in POC_OWNTRACKS_USERS). Returns [].
 *   GET  /owntracks/poc/debug  — INTERNAL. Guarded by x-internal-secret. Returns
 *                                latest location + staleness + frequency per
 *                                worker, so you can watch results from a phone
 *                                browser during a drive.
 *
 * Unlike taskRoutes (whole plugin gated by x-internal-secret), the POST route is
 * intentionally public — the phone reaches it from the internet. Identity is the
 * authenticated Basic-auth username, NOT the payload's X-Limit-U / tid (those are
 * stored as informational only).
 */
import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from '../db/connection';
import { moduleLogger } from '../utils/logger';
import { resolveWorkerFromKey, upsertLiveLocation } from '../services/workerLocation';
import { bumpSessionLocation } from '../services/tracking';

const log = moduleLogger('owntracks-poc');

// ── Per-worker Basic-auth allowlist ───────────────────────────────────────────
// POC_OWNTRACKS_USERS format: "danny:secret1,yossi:secret2". Parsed once at load.
// Split each entry on the FIRST ':' so passwords may contain ':'.
function parseUsers(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue; // need a non-empty user and a ':'
    const user = trimmed.slice(0, idx).trim();
    const pass = trimmed.slice(idx + 1);
    if (user) map.set(user, pass);
  }
  return map;
}

const USERS = parseUsers(process.env.POC_OWNTRACKS_USERS);
const STALE_SECONDS = Number(process.env.POC_STALE_SECONDS ?? '180');

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Decode `Authorization: Basic ...` → { user, pass }, or null if absent/malformed. */
function parseBasicAuth(header: string | undefined): { user: string; pass: string } | null {
  if (!header || !header.startsWith('Basic ')) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

/** Validate Basic-auth creds against the allowlist. Returns the workerKey or null. */
function authenticate(header: string | undefined): string | null {
  const creds = parseBasicAuth(header);
  if (!creds) return null;
  const expected = USERS.get(creds.user);
  if (expected === undefined) return null;
  if (!safeEqual(creds.pass, expected)) return null;
  return creds.user;
}

// ── Internal-secret guard for the debug route (mirrors routes/tasks.ts) ────────
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? '';
function verifyInternalSecret(provided: string): boolean {
  if (!INTERNAL_SECRET) return true; // not configured — allow in dev
  if (!provided || provided.length !== INTERNAL_SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(INTERNAL_SECRET));
}

// ── Field coercion helpers (OwnTracks payloads are loosely typed) ─────────────
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function owntracksPocRoutes(app: FastifyInstance) {

  // POST /owntracks — receive one OwnTracks publish. Public + Basic auth.
  app.post('/owntracks', async (req, reply) => {
    const workerKey = authenticate(req.headers.authorization);
    if (!workerKey) {
      const attempted = parseBasicAuth(req.headers.authorization)?.user ?? '(none)';
      log.warn({ attemptedUser: attempted }, 'OwnTracks POST rejected — bad Basic auth');
      reply.header('WWW-Authenticate', 'Basic realm="owntracks-poc"');
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    // OwnTracks emits several _type values (location, transition, waypoint,
    // lwt, ...). The POC only cares about location fixes. Non-location → ack [].
    if (body._type !== 'location') {
      log.debug({ workerKey, type: body._type }, 'skipped non-location');
      return reply.send([]);
    }

    const deviceId = (req.headers['x-limit-d'] as string | undefined) ?? null;
    const lat = num(body.lat);
    const lng = num(body.lon);
    const acc = num(body.acc);
    const vel = num(body.vel);
    const batt = num(body.batt);
    const tst = num(body.tst); // epoch seconds
    const tid = typeof body.tid === 'string' ? body.tid : null;
    const trigger = typeof body.t === 'string' ? body.t : null;

    try {
      // Gap since this worker's previous ping — for at-a-glance frequency in logs.
      const prev = await pool.query<{ receivedAt: string }>(
        `SELECT "receivedAt" FROM "PocLocationPing"
          WHERE "workerKey" = $1 ORDER BY "receivedAt" DESC LIMIT 1`,
        [workerKey],
      );
      const ageSincePrevMs = prev.rows[0]
        ? Date.now() - new Date(prev.rows[0].receivedAt).getTime()
        : null;

      await pool.query(
        `INSERT INTO "PocLocationPing"
           ("workerKey", "deviceId", tid, lat, lng, accuracy, speed, battery,
            "trigger", "recordedAt", raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                 CASE WHEN $10::double precision IS NULL THEN NULL
                      ELSE to_timestamp($10) END,
                 $11)`,
        [workerKey, deviceId, tid, lat, lng, acc, vel, batt, trigger, tst, JSON.stringify(body)],
      );

      log.info(
        { workerKey, deviceId, tid, lat, lng, accuracy: acc, trigger, tst, ageSincePrevMs },
        'OwnTracks location stored',
      );
    } catch (err) {
      log.error({ err, workerKey }, 'Failed to store OwnTracks location');
      // Still ack — OwnTracks queues on non-2xx and would retransmit; for the POC
      // we don't want a transient DB blip to back up the phone's queue endlessly.
    }

    // Migration 016: live-tracking fan-out. Best-effort, MUST NOT fail the ack.
    // - resolveWorkerFromKey maps the OwnTracks basic-auth username → User.id.
    //   Null = unmapped device → POC diagnostics only, no live tracking.
    // - upsertLiveLocation overwrites the worker's single latest-fix row.
    // - bumpSessionLocation touches the worker's ACTIVE|ARRIVED TrackingSession
    //   (no-op when the worker isn't currently en route).
    // Any failure here is logged and swallowed — same rationale as the POC insert
    // above: don't turn a transient bot-side blip into an OwnTracks retransmit
    // storm from the phone.
    if (lat != null && lng != null) {
      try {
        const workerUserId = await resolveWorkerFromKey(workerKey);
        if (workerUserId) {
          await upsertLiveLocation({
            workerUserId,
            workerKey,
            deviceId,
            lat,
            lng,
            accuracy: acc,
            speed: vel,
            battery: batt,
            trigger,
            recordedAt: tst != null ? new Date(tst * 1000) : null,
            raw: body,
          });
          await bumpSessionLocation(workerUserId);
        }
      } catch (err) {
        log.error({ err, workerKey }, 'Live-tracking fan-out failed (ack still sent)');
      }
    }

    return reply.send([]);
  });

  // GET /owntracks/poc/debug — internal view of latest + staleness + frequency.
  app.get('/owntracks/poc/debug', async (req, reply) => {
    const provided = (req.headers['x-internal-secret'] as string) ?? '';
    if (!verifyInternalSecret(provided)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { rows } = await pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON ("workerKey")
                "workerKey", "deviceId", tid, lat, lng, accuracy, "trigger",
                "recordedAt", "receivedAt"
           FROM "PocLocationPing"
          ORDER BY "workerKey", "receivedAt" DESC
       ),
       recent AS (
         SELECT "workerKey",
                EXTRACT(EPOCH FROM ("receivedAt" -
                  LAG("receivedAt") OVER (PARTITION BY "workerKey" ORDER BY "receivedAt")
                )) AS gap
           FROM "PocLocationPing"
          WHERE "receivedAt" > now() - interval '10 minutes'
       ),
       agg AS (
         SELECT "workerKey",
                COUNT(*)                                              AS pings_last_10min,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)
                  FILTER (WHERE gap IS NOT NULL)                      AS median_gap_seconds,
                MAX(gap)                                              AS max_gap_seconds
           FROM recent
          GROUP BY "workerKey"
       )
       SELECT l."workerKey", l."deviceId", l.tid, l.lat, l.lng, l.accuracy,
              l."trigger", l."recordedAt", l."receivedAt",
              EXTRACT(EPOCH FROM (now() - l."receivedAt"))::int AS seconds_since_last,
              COALESCE(a.pings_last_10min, 0)                   AS pings_last_10min,
              a.median_gap_seconds,
              a.max_gap_seconds
         FROM latest l
         LEFT JOIN agg a USING ("workerKey")
        ORDER BY l."workerKey"`,
    );

    const workers = rows.map((r) => ({
      workerKey: r.workerKey,
      deviceId: r.deviceId,
      tid: r.tid,
      lat: r.lat,
      lng: r.lng,
      accuracy: r.accuracy,
      trigger: r.trigger,
      recordedAt: r.recordedAt,
      receivedAt: r.receivedAt,
      secondsSinceLast: r.seconds_since_last,
      stale: r.seconds_since_last > STALE_SECONDS,
      pingsLast10min: Number(r.pings_last_10min),
      medianGapSeconds: r.median_gap_seconds === null ? null : Math.round(Number(r.median_gap_seconds)),
      maxGapSeconds: r.max_gap_seconds === null ? null : Math.round(Number(r.max_gap_seconds)),
    }));

    return reply.send({ staleThresholdSeconds: STALE_SECONDS, now: new Date().toISOString(), workers });
  });
}
