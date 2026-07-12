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
import {
  resolveWorkerFromKey,
  upsertLiveLocation,
  verifyWorkerCredentials,
} from '../services/workerLocation';
import { bumpSessionLocation } from '../services/tracking';
import { consumeProvisioning } from '../services/owntracksProvisioning';

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

/**
 * Validate Basic-auth creds. Tries the DB-backed WorkerDeviceIdentity path
 * first (migration 018 → provisioning flow); falls back to the legacy ENV
 * allowlist (POC_OWNTRACKS_USERS) so the pre-provisioning POC users
 * (e.g. `guy`) keep working. Returns the workerKey on success.
 */
async function authenticate(header: string | undefined): Promise<string | null> {
  const creds = parseBasicAuth(header);
  if (!creds) return null;

  // 1. DB path — set once the worker has been provisioned via /owntracks/config/:token.
  try {
    const dbResult = await verifyWorkerCredentials(creds.user, creds.pass);
    if (dbResult) return creds.user;
  } catch (err) {
    log.error({ err, user: creds.user }, 'DB auth path failed — falling back to ENV allowlist');
  }

  // 2. Legacy ENV fallback — kept for POC devices that predate migration 018.
  //    When a device is re-provisioned via the DB flow, its ENV entry should be
  //    dropped from POC_OWNTRACKS_USERS.
  const expected = USERS.get(creds.user);
  if (expected !== undefined && safeEqual(creds.pass, expected)) {
    log.warn(
      { user: creds.user },
      'OwnTracks auth: matched via legacy ENV allowlist — migrate to DB provisioning',
    );
    return creds.user;
  }

  return null;
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
    const workerKey = await authenticate(req.headers.authorization);
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

  // ── GET /owntracks/config/:token ────────────────────────────────────────────
  // Public. The OwnTracks app fetches this URL directly from the phone when the
  // worker taps the magic link. Returns an .otrc JSON configuration one time;
  // subsequent calls with the same token return 404. Called by:
  //   `owntracks:///config?url=<PUBLIC_BASE_URL>/owntracks/config/<token>`
  // via the 302 redirect from GET /o/:token below.
  //
  // On success this endpoint has already:
  //   - generated a fresh password in memory,
  //   - written its bcrypt hash to WorkerDeviceIdentity,
  //   - cleared the provisioningToken (single-use),
  //   - set isActive=true and provisionedAt=now().
  // The plaintext password is emitted once here and never persisted.
  app.get<{ Params: { token: string } }>('/owntracks/config/:token', async (req, reply) => {
    const { token } = req.params;
    if (!token || token.length > 128) {
      return reply.code(404).send({ error: 'Not found' });
    }

    let payload;
    try {
      payload = await consumeProvisioning(token);
    } catch (err) {
      log.error({ err }, 'consumeProvisioning threw');
      return reply.code(500).send({ error: 'Internal error' });
    }

    if (!payload) {
      log.warn({ tokenPrefix: token.slice(0, 6) }, 'OwnTracks config: token invalid or expired');
      return reply.code(404).send({ error: 'Not found' });
    }

    // .otrc format — see https://owntracks.org/booklet/features/remoteconfig/
    // mode=3       → HTTP private
    // monitoring=1 → move (frequent updates while driving)
    // locatorInterval=15s / locatorDisplacement=50m → aggressive-enough for the
    //   Wolt-lite ETA without crushing battery. Tunable later by pushing a new
    //   .otrc via a fresh provisioning link.
    const otrc = {
      _type: 'configuration',
      mode: 3,
      url: payload.hostUrl,
      auth: true,
      username: payload.workerKey,
      password: payload.password,
      tid: payload.trackerId,
      deviceId: payload.workerKey,
      monitoring: 1,
      locatorInterval: 15,
      locatorDisplacement: 50,
      pubExtendedData: true,
    };

    log.info({ workerKey: payload.workerKey }, 'OwnTracks .otrc issued');
    return reply
      .type('application/json')
      .send(otrc);
  });

  // ── GET /o/:token ───────────────────────────────────────────────────────────
  // Public HTTPS short link that WhatsApp recognises as a clickable URL. When
  // tapped on a phone with OwnTracks installed, the 302 sends the OS to
  // `owntracks:///config?url=...`, which opens the app; the app then fetches
  // /owntracks/config/:token itself.
  //
  // For desktops or phones without OwnTracks, the browser will follow the
  // owntracks:// scheme fail; we return a small HTML fallback in the response
  // body so a curl / desktop preview still shows something useful.
  app.get<{ Params: { token: string } }>('/o/:token', async (req, reply) => {
    const { token } = req.params;
    const publicBase = process.env.PUBLIC_BASE_URL;
    if (!publicBase) {
      log.error('PUBLIC_BASE_URL not set — /o/:token cannot build redirect');
      return reply.code(500).send({ error: 'Server misconfigured' });
    }
    if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return reply.code(404).send({ error: 'Not found' });
    }

    const configUrl = `${publicBase}/owntracks/config/${token}`;
    const otScheme  = `owntracks:///config?url=${encodeURIComponent(configUrl)}`;

    // Fallback HTML for browsers that can't launch the scheme. iOS Safari will
    // follow the 302 (which fires the scheme) before rendering the body; for
    // WhatsApp's in-app browser the redirect fires OwnTracks directly.
    const fallbackHtml =
      `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">` +
      `<title>OwnTracks setup</title></head><body style="font-family:sans-serif;padding:2em">` +
      `<h2>לפתיחת ההגדרות</h2>` +
      `<p>אם האפליקציה לא נפתחה אוטומטית:</p>` +
      `<ol><li>ודא ש-OwnTracks מותקנת (App Store / Google Play).</li>` +
      `<li>חזור להודעת הוואטסאפ ולחץ על הקישור שוב.</li></ol>` +
      `<p><a href="${otScheme}">פתח OwnTracks ידנית</a></p></body></html>`;

    return reply
      .code(302)
      .header('Location', otScheme)
      .type('text/html; charset=utf-8')
      .send(fallbackHtml);
  });
}
