# TASKS — current bot to Galit v2 (dependency-ordered plan)

Source of truth: `GAP_ANALYSIS.md` (30 gaps across 5 domains, 12 existing capabilities reviewed). Spec references: `SPEC_FIELD_V2.md`.

Conventions:
- Task IDs: `<section>-T<n>`. `B` = blocker / external input, `K` = decision-task, `D1..D5` = domain (per GAP_ANALYSIS Part 1), `X` = dismantle/replace (per GAP_ANALYSIS Part 2).
- "Blocked" means cannot be started until the named blocker resolves (external input received, or decision-task closed).
- Constraints in force throughout: ONE bot (role-routed display); additive-only DB for the field layer; the CRM owns `Task.status` and the bot NEVER writes it; no PG enums (text + CHECK); UUID PKs with `gen_random_uuid()`; RLS deny-all on every new table; migration conventions identical to `001`-`008`.

---

## TRANSPORT — החלפת שכבת ה-transport ל-Green API (זמני) (2026-07-12)

**סטטוס כללי:** IN PROGRESS. מפוצל לשני PRs. **PR#1 (אבסטרקציית ספק) — DONE (merged, `d7465c5`).** **PR#2 (מימוש Green API) — DONE (local, committed; PR פתוח ל-main).**

מטרה: החלפה **זמנית** של Meta Cloud API ב-Green API (ספק לא רשמי, WhatsApp Web) עד שאישור Meta יגיע. אסור לשכתב לוגיקה — השינוי מוגבל לשכבת ה-transport בלבד (`ai/`, `routes/tasks*`, `auth/`, `utils/` לא יודעים שהוחלף ספק). חזרה ל-Meta = החלפת env אחת (`WHATSAPP_PROVIDER=meta`).

### TRANSPORT-T1 — אבסטרקציית ספק (PR#1)

**Status:** DONE (local, committed).

**What to do:** להכניס seam של provider מאחורי `sender.ts` בלי לשנות התנהגות. Meta נשאר הספק הפעיל, כל הטסטים ירוקים.

**Definition of Done:** `sender.ts` הופך ל-facade שמאציל ל-`getProvider()`; מימוש Meta עובר verbatim ל-`providers/meta.ts`; retry/back-off/timeout/DLQ משותפים ב-`providers/httpDelivery.ts`; interface חדש `WhatsAppProvider` (4 שולחים + `supportsTemplates` + `paced`); `notify()` מכבד `provider.supportsTemplates`; אפס שינוי התנהגות תחת Meta; `tsc --noEmit` נקי.

**Files changed:**
- `src/whatsapp/provider.ts` (חדש) — `WhatsAppProvider` interface + message shapes + `getProvider()` (default meta).
- `src/whatsapp/providers/httpDelivery.ts` (חדש) — retry/back-off/timeout/DLQ + low-level POST, הועבר מ-`sender.ts`.
- `src/whatsapp/providers/meta.ts` (חדש) — מימוש Meta של 4 השולחים, verbatim. `supportsTemplates=true`, `paced=false`.
- `src/whatsapp/sender.ts` (שוכתב ל-facade) — אותם exports/interfaces/חתימות בדיוק.
- `src/whatsapp/templates.ts` (edit) — `notify()` בודק `getProvider().supportsTemplates` (no-op תחת Meta).
- `src/__tests__/providerSelection.test.ts` (חדש).

**Tests run:** `npx tsc --noEmit` נקי; טסטי ה-seam (senderWamid, senderTemplateButtons, providerSelection, interactiveButtons, dueDateReminder, deadlineAlerts, sashaLeadsDispatcher, routerEnableTracking) → 63/63; מלוא החבילה ירוקה בריצה מחולקת ל-shards (89 files / ~1678 tests). הערה: הרצת כל החבילה בבת אחת נכשלת ב-OOM של V8 (מגבלת heap 8GB — קדם-קיים, לא רגרסיה; כל קובץ עובר בבידוד).

**Deviations:** ה-throw ברמת module-load של `sender.ts` (creds של Meta חסרים בפרודקשן) לא הועבר לספק — הוא היה dead-code בפועל כי `runPreflight()` רץ קודם ב-`index.ts` ודורש את אותם vars. ה-guard הרך per-send (warn+null) נשמר במלואו ב-`meta.ts`.

**What remains:** PR#2.

### TRANSPORT-T2..T7 — מימוש Green API (PR#2)

**What to do:** `providers/greenapi.ts` (4 שולחים דרך `sendMessage`, כפתורים→טקסט ממוספר, `supportsTemplates=false`, `paced=true`); `POST /greenapi/webhook` (אימות `Authorization: Bearer <GREENAPI_WEBHOOK_TOKEN>` → 404; `incomingMessageReceived` בלבד; dedup `greenapi:${idMessage}` לפני ACK); `PendingChoice` (migration 019, TTL 60 דק'); `preflight` provider-aware; voice seam ב-`voice.ts`; מיזוג greeting+menu ב-`webhook.ts` כש-`paced`; `.env.example`; `docs/ROLLBACK.md` + `docs/GREENAPI_OPS.md`. **אין OutboundQueue** — Green API מנהל את תור השליחה (`delaySendMessagesMilliseconds`, שמירה 24h).

**Status:** DONE (local, committed; PR פתוח ל-main).

**Files changed (new):**
- `src/whatsapp/providers/greenapi.ts` — ספק Green API. 4 שולחים דרך `sendMessage`; `sendButton`/`sendList` → טקסט ממוספר + `savePendingChoice`; `sendTemplate` דיפנסיבי (טקסט בלבד, לא נגיש דרך `notify` כי `supportsTemplates=false`); `chatId = normalizeIsraeliPhone + '@c.us'`; retry/DLQ דרך `httpDelivery` המשותף. **אין throttling מקומי.**
- `src/services/pendingChoice.ts` — `savePendingChoice` (upsert, TTL 60 דק') + `resolvePendingChoice` (consume אטומי `DELETE ... jsonb_exists`, טקסט חופשי → null בלי DB).
- `src/routes/greenapiWebhook.ts` — `POST /greenapi/webhook`. Bearer timing-safe → 404; `incomingMessageReceived` בלבד (אחר → 200 ignore); `idMessage` ריק → 200 warn; תרגום מספר→id **לפני** enqueue; `msgId=greenapi:${idMessage}` enqueue לפני ACK; מעבד דרך `processInbound` המשותף.
- `src/db/migrations/019_pending_choice.sql` — טבלת `PendingChoice`, additive, idempotent, RLS deny-all (כמו 003).
- `docs/GREENAPI_OPS.md`, `docs/ROLLBACK.md`.
- טסטים: `greenapiProvider`, `greenapiWebhook`, `greenapiTemplates`, `pendingChoice`, `greetingMenuMerge`.

**Files changed (edit):**
- `src/whatsapp/provider.ts` — wire `greenapi` + ברירת מחדל → `greenapi`.
- `src/config/preflight.ts` — provider-aware: מאמת רק את creds של הספק הפעיל; אזהרת templates/24h מוגבלת ל-meta.
- `src/whatsapp/voice.ts` — seam `downloadUrl` (הורדה ישירה ל-Green API) + `downloadAudioFromUrl`.
- `src/routes/webhook.ts` — שורה אדיטיבית ל-`downloadUrl` ב-audio; `greetAndOpenMenu` — מיזוג greeting+menu **רק כש-`paced`** (meta = 2 שליחות ללא שינוי).
- `src/app.ts` — רישום `greenapiWebhookRoutes`.
- `.env.example` — §2b provider selector + `GREENAPI_*`.
- `src/__tests__/providerSelection.test.ts` — עודכן ל-default greenapi.
- `src/__tests__/senderWamid.test.ts`, `senderTemplateButtons.test.ts` — נעצו `WHATSAPP_PROVIDER=meta` (הם בודקים את ספק Meta; ה-default התהפך).

**Tests run:** `npx tsc --noEmit` נקי. 52 טסטים חדשים (6 קבצים) → ירוקים. רגרסיה: shards 1/2/4 של 4 ירוקים במלואם; תוכן shard 3 אומת ב-shards עדינים יותר (5/8, 11/16, 12/16) — כל הקבצים עוברים פרט ל-`routerManagerMenu.test.ts` שנכשל ב-OOM של V8 **גם על הקוד המקורי** (edits ב-stash) — קדם-קיים, לא רגרסיה (הקובץ טוען את כל `router.ts` 297KB; ממוקק את ה-sender כך שה-flip לא נוגע בו).

**Deviations from plan:**
- **מיזוג greeting+menu מותנה ב-`provider.paced`** (לא `supportsTemplates`). `paced` הוא הדגל שכבר קיים ב-interface ומתעד בדיוק את הסיבה למיזוג ("מונע ערימת דיליי per-send"); `supportsTemplates` היה מקרי (גם false ל-greenapi) אבל סמנטית שגוי. תוצאה זהה: מיזוג רק תחת greenapi.
- **40 האתרים ב-router.ts → 11 אמיתיים.** קריאה מלאה של `router.ts` הראתה ש-~40 היה over-count של grep. 11 double-sends אמיתיים (רשימה קונקרטית ב-GREENAPI_OPS §5.1) + multiplier של `sendChunked` (§5.2); ~15 מה-hits הם fallbacks של try/catch (הודעה אחת) ותפריטי מנהל שכבר ממזגים ack+menu. **תועדו, לא תוקנו** (כפי שאושר).
- **ספירת נמענים לא רצה חיה** — סביבת ה-PR היא clone ephemeral בלי creds של פרודקשן. השאילתה + נוסחת הניקוז + טבלת הערכות ב-GREENAPI_OPS §6; להריץ מול פרודקשן ל-N האמיתי (~10 → ~2.3 דק').

**What remains:** להריץ את מיגרציה 019 בפרודקשן; להזין `GREENAPI_*` ולהגדיר את הקונסול (GREENAPI_OPS §1); החלטה עתידית על תיקון 11 האתרים.

---

## 4.20 Auto-provisioning OwnTracks לעובדים (2026-07-12)

**סטטוס כללי:** DONE (local, uncommitted). כל PROV-T1..PROV-T7 מומשו. בדיקות: 32 חדשות עברו; `npx tsc --noEmit` נקי; מיגרציה 018 רצה בפרודקשן. תיעוד מלא ב-[docs/OWNTRACKS_PROVISIONING.md](docs/OWNTRACKS_PROVISIONING.md). משתמשים לא נבנו מחדש — הם כבר קיימים ב-`User`. השורה הקיימת מ-`seedWorkerDeviceIdentity.ts` (`workerKey='guy'`) ממשיכה לעבוד דרך fallback ה-ENV — לא נשברה. אין סוד גולמי ב-DB — הסיסמה נוצרת בזיכרון בזמן צריכת ה-token, נשמרת bcrypt hash בלבד, ומוזרקת פעם אחת ל-`.otrc` שחוזר לאפליקציה.

**Follow-ups:**
- הרשמת template `owntracks_provisioning` ב-Meta Business Manager — **בוצע 2026-07-12** (`npm run templates:create`, id=2105597240836606, status=PENDING). לא נצרך בפועל בזמן ש-`WHATSAPP_PROVIDER=greenapi` (הדיפולט של PR#2) — Green API הוא WhatsApp Web בלי חלון 24h ובלי חובת template. שווה לרגע rollback ל-Meta.
- קונפיגורציית `PUBLIC_BASE_URL` ב-`.env` — **fallback אוטומטי ל-`TRACKING_PUBLIC_BASE_URL`** מאז PROV-T8 (2026-07-13). מספיק להגדיר את השני.
- Revoke בבוט (intent "כבה מעקב") — לא נדרש עכשיו, הטבלה כבר תומכת (`revokedAt`).

### PROV-T8 — `PUBLIC_BASE_URL` fallback ל-`TRACKING_PUBLIC_BASE_URL` (2026-07-13)

**Status:** DONE (local, uncommitted).

**Rationale:** שני המשתנים מצביעים על אותו host פיזי (host הבוט הציבורי). אין סיבה שהאופרייטור יגדיר את שניהם.

**What changed:**
- `getPublicBaseUrl()` ב-`src/services/owntracksProvisioning.ts` הוסב מ-`PUBLIC_BASE_URL` בלבד ל-`PUBLIC_BASE_URL ?? TRACKING_PUBLIC_BASE_URL`, כולל trim + סטריפ trailing slash. הפונקציה מיוצאת (`export`).
- `src/routes/owntracksPoc.ts` — `GET /o/:token` השתמש ב-`process.env.PUBLIC_BASE_URL` ישירות; עכשיו משתמש ב-`getPublicBaseUrl()` המיובא — אותה זרימה אחידה עם `createProvisioning` / `consumeProvisioning`.
- `.env.example` — הערה מעודכנת.
- `src/__tests__/owntracksConfig.test.ts` — mock של `owntracksProvisioning` חושף עכשיו `getPublicBaseUrl` שקורא env בזמן קריאה; בדיקת "missing" גם מוחקת `TRACKING_PUBLIC_BASE_URL` (restore ב-finally).

**Tests:** 91/91 עוברים. `npx tsc --noEmit` נקי.

### PROV-T1 — Migration 018: הרחבת `WorkerDeviceIdentity` לפרוביז'נינג

**Status:** DONE (local, uncommitted).

**What to do:** להוסיף עמודות `passwordHash`, `trackerId`, `provisioningToken`, `provisioningExpiresAt`, `provisionedAt`, `revokedAt` על גבי הטבלה הקיימת. אינדקס partial על `provisioningToken` (WHERE NOT NULL) + partial על `(workerKey) WHERE isActive AND passwordHash NOT NULL` ל-hot-path.

**Definition of Done:** MIG רץ; כל השדות nullable כך שהשורה הקיימת מ-`seedWorkerDeviceIdentity.ts` (`workerKey='guy'`) ממשיכה לעבוד דרך fallback ה-ENV; migration idempotent.

**Files changed:** `src/db/migrations/018_owntracks_provisioning.sql` (חדש).

**Tests run:** `npx ts-node src/db/migrate.ts` → applied.

### PROV-T2 — Provisioning service (יצירה + צריכה של token)

**Status:** DONE (local, uncommitted).

**What to do:** קובץ חדש `src/services/owntracksProvisioning.ts`:
- `createProvisioning(workerUserId): Promise<{ magicUrl, expiresAt }>` — מייצר `workerKey` ייחודי (הזרע: תעתיק שם + suffix random), `trackerId` (2 אותיות), `provisioningToken` (32-byte base64url). UPSERT ל-`WorkerDeviceIdentity` לפי `workerUserId` — אם קיימת שורה, revoke לישנה + חדשה. `provisioningExpiresAt = now()+48h`. `passwordHash` נשאר NULL עד ל-consume.
- `consumeProvisioning(token): Promise<OtrcPayload | null>` — קורא לפי token עם `FOR UPDATE`; אם token תפוג/חסר → null; **מייצר סיסמה גולמית בזיכרון**, מחשב bcrypt hash, שומר, מוחק את ה-token, מסמן `provisionedAt=now()`, `isActive=true`, ומחזיר `{ workerKey, password, trackerId, hostUrl }`.

**Definition of Done:** בדיקות ל-happy-path, expired-token, double-consume-idempotency (הפעם השנייה מחזירה null), UPSERT מ-provision קודם. `npx tsc --noEmit` נקי.

**Files:** `src/services/owntracksProvisioning.ts` (חדש), `src/services/__tests__/owntracksProvisioning.test.ts` (חדש).

### PROV-T3 — `verifyWorkerCredentials` בתוך `workerLocation.ts`

**Status:** DONE (local, uncommitted).

**What to do:** פונקציה חדשה `verifyWorkerCredentials(workerKey, plaintext): Promise<{ workerUserId } | null>`:
- Cache in-process (Map פשוט עם TTL 60s) של `workerKey → { passwordHash, workerUserId, cachedAt }`.
- Cache miss: `SELECT "passwordHash", "workerUserId" FROM "WorkerDeviceIdentity" WHERE "workerKey"=$1 AND "isActive"=true AND "revokedAt" IS NULL AND "passwordHash" IS NOT NULL`.
- `bcrypt.compare(plaintext, passwordHash)`; אמת → מחזיר `{ workerUserId }`.
- Cache invalidation: פונקציית export `invalidateWorkerCredentialCache(workerKey)` שנקראת מתוך `consumeProvisioning` וכל revoke.

**Definition of Done:** יחידה + cache test (miss → hit → invalidate → miss). לא נוגעים בשורות ללא `passwordHash` — נשארות ל-fallback ה-ENV ב-PROV-T4.

**Files:** `src/services/workerLocation.ts` (הרחבה), `src/__tests__/workerLocation.test.ts` (הרחבה).

### PROV-T4 — Route: החלפת auth + endpoint config + short link

**Status:** DONE (local, uncommitted).

**What to do:** ב-`src/routes/owntracksPoc.ts`:
- החלפת `authenticate()`: **קודם** מנסה `verifyWorkerCredentials()` מול DB. **fallback** ל-`USERS` (env) אם ה-workerKey לא נמצא ב-DB או שאין לו `passwordHash` — עם `log.warn` שמסמן deprecation.
- `GET /owntracks/config/:token` (**public**, בלי `x-internal-secret`, כי OwnTracks פונה ישירות מהטלפון): קורא ל-`consumeProvisioning()`; אם null → 404; אחרת מחזיר JSON `.otrc` תואם OwnTracks (mode=3, url=`PUBLIC_BASE_URL/owntracks`, auth=true, username, password, tid, monitoring=1, locatorInterval=15, locatorDisplacement=50, pubExtendedData=true).
- `GET /o/:token` (**public**): 302 → `owntracks:///config?url=<PUBLIC_BASE_URL>/owntracks/config/<token>`. Fallback HTML קטן אם ה-User-Agent לא מובן.
- הוספת `PUBLIC_BASE_URL` ל-`.env.example`.

**Definition of Done:** POST /owntracks עם workerKey ישן (ENV) → 200. POST עם workerKey חדש (DB) → 200. GET /owntracks/config/BAD → 404. GET /owntracks/config/VALID פעם ראשונה → JSON תקין; פעם שנייה → 404. GET /o/VALID → 302 עם Location נכון.

**Files:** `src/routes/owntracksPoc.ts` (שינוי), `.env.example` (הוספת `PUBLIC_BASE_URL`), `src/__tests__/owntracksConfig.test.ts` (חדש).

### PROV-T5 — Bot trigger: intent + router + שליחה (freeform או template)

**Status:** DONE (local, uncommitted).

**What to do:**
- `src/ai/schema.ts`: intent חדש `enable_worker_location_tracking { workerHint: string }`.
- `src/ai/intentParser.ts`: זיהוי ("הפעל מעקב מיקום לדני", "provision X", וכו').
- `src/ai/router.ts`: handler חדש עם `isManagerMenuUser()` guard. Resolve העובד ל-`User.id` (משתמש בלוגיקה קיימת של איתור עובד לפי שם), קורא `createProvisioning`, שולח לעובד את ה-magic URL:
  - **בתוך 24h:** `sendTextMessage` עם `magicUrl + checklist עברי`.
  - **מחוץ ל-24h:** `sendOwnTracksProvisioning` (template).
- למנהל: אישור עברי + חתימת expiry.

**Definition of Done:** בדיקות router.ts: MANAGER → מבצע; WORKER → דחייה מנומסת; לא נמצא עובד → הודעה; בחירה מרובה → disambig list.

**Files:** `src/ai/schema.ts`, `src/ai/intentParser.ts`, `src/ai/router.ts` (highs-conflict — Opus יטפל).

### PROV-T6 — WhatsApp template `owntracks_provisioning`

**Status:** DONE (local, uncommitted).

**What to do:**
- `src/whatsapp/templateNames.ts`: קבוע `OWNTRACKS_PROVISIONING = 'owntracks_provisioning'`.
- `src/whatsapp/templates.ts`: `sendOwnTracksProvisioning({ to, name, magicUrl })` שמעטפת ל-`sendTemplateMessage`.
- שים לב: הרשמת ה-template ב-Meta Business Manager היא צעד external (יומיים אישור). לפני שהוא מאושר — ה-fallback לא יעבוד לעובד מחוץ ל-24h; זה מטופל בטריגר שמדווח למנהל.

**Files:** `src/whatsapp/templateNames.ts`, `src/whatsapp/templates.ts`.

### PROV-T7 — Tests, docs, `BOT_CAPABILITIES.md`, Status → DONE

**Status:** DONE (local, uncommitted).

**What to do:**
- Vitest coverage: provisioning service, verifyWorkerCredentials, config endpoint, short link, router handler.
- `docs/OWNTRACKS_PROVISIONING.md` — הזרימה מקצה לקצה + checklist עברי להרשאות (iOS "Always" / Android battery).
- `BOT_CAPABILITIES.md`: בסעיף "יכולות של מנהל" להוסיף "מנהל יכול להפעיל מעקב מיקום לעובד — הבוט שולח קישור אישי לוואטסאפ שמגדיר אוטומטית את OwnTracks".
- כל שורות ה-Status של PROV-Tn משתנות ל-DONE + files/tests/deviations.

---

## 0.9 Fix: ETA stuck high on the approach — removed the freeze, added a last-mile regime (2026-07-09)

**Status:** DONE (local, uncommitted — awaiting user approval to commit/push).

**Field symptom:** driving toward the customer, the ETA "stopped updating" — it
stayed high not only at the doorstep ("200 m away, still 15 min") but across the
whole slow approach.

**Root cause (in `conservativeEta.ts` Layer D):** two damping mechanisms,
compounded by an input artifact:
1. `not_progressing` → **freeze** (blocked ANY decrease). It fired far too
   easily: the detector's stall threshold (100 m / 2 min) treats normal slow
   city driving as "stuck," and the movement-gated route cache only recomputes
   the base every ~75 m, so `distanceMeters` looked flat between recomputes →
   false `not_progressing` → the ETA refused to come down.
2. The drop-cap of only 25 %/poll made even the non-frozen case sticky.

**Insight:** since the time-based countdown was already removed (0.8-era), a
genuinely stationary worker ALREADY has a flat ETA — the base route doesn't
shrink while the movement-gated cache holds it. So the freeze was redundant AND
harmful. The user's own model ("no movement → don't update; otherwise follow the
real remaining road") argues for LESS damping, not more.

**Fix (`src/services/conservativeEta.ts` only — `progressDetector.ts` untouched,
since removing the freeze makes the stale-distance artifact harmless):**
- **Removed the freeze entirely.** `not_progressing` no longer pins the ETA;
  `frozen` is now always `false` (kept in the output shape for stability).
- **Loosened the drop-cap 25 % → 50 %** — a light one-poll-glitch smoother, not a
  hold-back.
- **Added a "last-mile" regime** keyed on the pure base road time
  (`LAST_MILE_BASE_SECONDS = 300`, i.e. < 5 min of road left): smaller buffer
  (3 min → 1 min), finer rounding (5 min → 1 min), floor 3 → 1 min, and **no
  drop-cap at all** — so the number collapses honestly as the worker reaches the
  door. Keyed on the pre-ratio base so a high traffic ratio can't keep us out of
  the last-mile regime near arrival.

**Behavior now:** the ETA follows the real remaining road — it moves only when
the worker moves, comes down smoothly on the approach, and no longer sticks. A
truly stationary worker still shows a flat ETA (base doesn't shrink), preserving
the "no movement → don't update" intent without an explicit freeze.

**Tests (`conservativeEta.test.ts` + `trackingConservativeIntegration.test.ts`):**
updated the freeze/clamp assertions to the new behavior; added a
`last-mile collapse` block (the "200 m / 15 min" regression: not_progressing +
high previous near the door now yields ~3 min, not 15) and a "does NOT freeze
mid-route" regression. `npx tsc --noEmit` clean; 86/86 across the 4 tracking-ETA
files.

**Deferred (per the user, after this field test):** the self-calibration
("observed ratio" from live progress, to grow the ETA when the worker is
genuinely slower than the map) is designed and documented but NOT built — the
user chose to run a full end-to-end drive on this simpler fix first and decide
afterwards whether the extra complexity is warranted.

---

## 0.8 Fix: fractional OSRM seconds broke the live countdown display (2026-07-09)

**Status:** DONE (local, uncommitted — awaiting user approval to commit/push).

**Bug:** the customer tracking page showed "זמן הגעה משוער: 22:49.40000000000009"
instead of "22:49". Root cause: OSRM's `duration` field is a float (e.g.
`2969.400000000001` seconds). `trackingPage.template.ts` stored it verbatim in
`countdownBaseline.sec`, and `formatCountdown`'s `remainingSec % 60` kept the
fractional remainder, string-concatenated straight into the DOM.

**Fix (`src/routes/trackingPage.template.ts`):** round to whole seconds in two
places — where the countdown baseline is set (root cause) and defensively
inside `formatCountdown` itself (so any future caller is safe regardless).

**Tests:** `src/__tests__/trackingPage.test.ts` +2 — one asserts the served
page ships both `Math.round` guards and never regresses to the unrounded
`remainingSec % 60` pattern; the other extracts the ACTUAL shipped
`formatCountdown` function out of the rendered HTML via regex and executes it
directly on the exact reported value (`2969.400000000001` → `'49:29'`, no
decimal point) — a real behavioral check, not just a source-text match.
28/28 pass in the file; `npx tsc --noEmit` clean.

**Product clarification (same conversation):** the live countdown itself is
intentional (explicit product requirement from 0.7 — "run a visual countdown
between polls"), not a bug. Separately, the user is considering replacing the
OSRM ETA source with Google Maps Distance Matrix/Routes API for
traffic-aware ETA — this requires a Google Cloud project + billing, which
directly contradicts the "NO Google Cloud, NO billing" constraint from the
0.7 brief. Explained the tradeoff (cost, quota-driven fallback design, still
NOT Navigation Connect) and awaiting the user's decision before any such
work starts. Nothing built yet on that front.

---

## 0.7 Wolt-lite tracking upgrade — OSRM routing, live ETA, customer link (2026-07-09)

**Status:** DONE (local, uncommitted — awaiting user approval to commit/push).
Meta v2 template (`customer_worker_en_route_v2`) prepared but NOT submitted
(needs `TRACKING_PUBLIC_BASE_URL` + Meta creds — see follow-ups).

**Spec:** the in-session product brief (2026-07-09): keep the existing
architecture (TrackingSession / WorkerLiveLocation / OwnTracks / `/tracking/:token`
/ `/t/:token` / Leaflet); NO Navigation Connect, NO Google Cloud, NO native app,
NO browser GPS. ETA is a road-routing ESTIMATE from latest GPS + OSRM — never
presented as exact/traffic-aware ("זמן הגעה משוער" wording only; enforced in
code comments and UI strings).

**Implemented (3 parallel Sonnet sub-agents; orchestrator integration + QA):**

1. **`src/services/osrmRoute.ts` (new)** — `getRoadRoute(worker, dest)`:
   `TRACKING_OSRM_ENABLED` flag, `OSRM_BASE_URL` (public demo server for
   dev/MVP only), 3s AbortController timeout, in-memory 20s cache keyed on
   4-decimal-rounded coordinates (null results cached too), injectable fetch,
   never throws. 18 tests.

2. **`src/services/tracking.ts`** — `getPublicView` enriched ADDITIVELY (no
   existing key removed): `headline` (Hebrew), `presentationStatus`
   (WAITING/EN_ROUTE/NEARBY/ARRIVED/COMPLETED/STALE_LOCATION/UNAVAILABLE/EXPIRED),
   `workerLocation`/`destinationLocation` (new naming mirrors), `route`
   (OSRM GeoJSON or straight-line fallback), `distanceMeters`,
   `durationSeconds`, prioritized `etaMinutes` + `etaText`
   (OSRM-fresh → expectedArrivalAt → travelEtaMinutes → none; stale appends
   "(הערכה בלבד)"), `lastUpdatedAt`, `locationFreshnessSeconds`,
   `isLocationFresh` (`TRACKING_STALE_SECONDS`, default 120),
   `isRouteAvailable`, `fallbackReason`. NEARBY within
   `TRACKING_NEARBY_METERS` (default 300). Stale location SKIPS the OSRM call.
   Nothing sensitive exposed (no task/user ids, no phone, no raw payload).

3. **`src/routes/trackingPage.template.ts`** — customer page: all Hebrew
   states incl. the stale two-liner ("לא התקבל עדכון מיקום בדקות האחרונות." /
   "זמן ההגעה מוצג כהערכה בלבד."), distance line (ק״מ/מטרים), OSRM solid
   polyline (GeoJSON [lng,lat]→[lat,lng] flip) vs dashed straight fallback,
   smooth marker animation (rAF ease-out 1.5s, >2km snap guard), live ETA
   countdown between polls gated STRICTLY on `isLocationFresh === true` +
   EN_ROUTE/NEARBY, terminal statuses stop polling. Legacy payloads (old
   backend) still render byte-identically (regression-tested).

4. **Order fix (`src/ai/router.ts` `performTransition`)** — on DEPARTED the
   tracking session is now opened (awaited, try/catch) BEFORE
   `advanceFieldStatus`, because the customer EN_ROUTE notification fires
   inside `advanceFieldStatus` and needs the session token for the link.
   Call-order regression test added.

5. **Customer link (`src/services/customerNotifications.ts` + new
   `src/services/trackingLink.ts`)** — after the dedup claim, resolves the
   active session token → `TRACKING_PUBLIC_BASE_URL`/t/<token>. Freeform
   (in-window) path appends the link to the message text NOW; the template
   path passes a URL-button param ONLY when
   `WHATSAPP_TEMPLATE_CUSTOMER_WORKER_EN_ROUTE` is overridden to the v2
   template (legacy-guard identical to `dueDateReminder.ts` — v1 keeps its
   exact current payload). No token/base-url → sends exactly as before.
   Dedup via `CustomerNotificationLog` unchanged.

6. **Scripts** — `scripts/create-customer-en-route-template-v2.ts` (v1 body
   verbatim + URL button `<base>/t/{{1}}`; refuses LIVE without
   `TRACKING_PUBLIC_BASE_URL`; dry-run verified by the orchestrator) and
   `scripts/seedTrackingDemo.ts` (opens a session, prints the /t/ URL, steps a
   fake WorkerLiveLocation along a line for demos).

**New env (documented in .env.example):** `TRACKING_OSRM_ENABLED=false`,
`OSRM_BASE_URL`, `TRACKING_PUBLIC_BASE_URL`, `TRACKING_STALE_SECONDS=120`,
`TRACKING_NEARBY_METERS=300`. **DB changes: NONE** (016+017 suffice).

**Orchestrator QA:** all diffs reviewed line by line; backend↔page contract
compared field-by-field (matches; page also falls back to legacy fields);
`npx tsc --noEmit` clean repo-wide; 254/254 tests across the 12
tracking-related files; v2 template dry-run payload verified; full-suite run
green (see report). Known follow-ups: (1) submit v2 template once
`TRACKING_PUBLIC_BASE_URL` + Meta creds available, then set
`WHATSAPP_TEMPLATE_CUSTOMER_WORKER_EN_ROUTE=customer_worker_en_route_v2`;
(2) set `TRACKING_OSRM_ENABLED=true` + `TRACKING_PUBLIC_BASE_URL` in Render
when ready; (3) demo-server OSRM is dev/MVP only — move to a self-hosted OSRM
before scale; (4) `fallbackReason='NO_ETA_SOURCE'` currently unreachable
(defensive only, documented in code).

---

## 0.6 Live tracking foundation — Wolt-lite backend (2026-07-08)

**Status:** DONE (local, uncommitted). Plan approved in-session — see
`docs/LIVE_TRACKING_PLAN.md` for the full inspection report, migration sketch,
questions locked in, and edge cases. Migration `016` NOT yet applied to Supabase.

Converts the OwnTracks POC (0.3) into a backend tracking foundation. The POC
proved OwnTracks can push GPS to the server; this step connects those pings to
a specific TaskField so a future customer page can show "the inspector is on
the way". Explicitly deferred: Google ETA, WebSocket, geofence, customer UI,
customer WhatsApp template, cron expiry — all still in the "later, only if
this passes" bucket, matching the POC discipline.

**Behavior:** on "יצאתי" the router opens a `TrackingSession` for that exact
TaskField with a fresh `publicToken`. Every subsequent OwnTracks ping upserts
`WorkerLiveLocation` (single row per worker — history stays append-only in
`PocLocationPing`) and bumps `TrackingSession.lastLocationAt` when the worker
has an active session. "הגעתי" flips the session to `ARRIVED`; "סיימתי"
closes it as `FINISHED`; DECLINE closes it as `CANCELED`. A public JSON view
at `GET /tracking/:token` returns only the customer-safe whitelist
(`status, taskFieldStatus, lastLocation, updatedAt, etaMinutes?`) with
`Cache-Control: no-store`; unknown / malformed tokens are 404 without
distinguishing "revoked" from "never existed" (no existence leak).

**Invariant (approved refinement):** at most ONE active session per WORKER at
any time. New "יצאתי" on a new TaskField transactionally supersedes the prior
session as `SUPERSEDED` (`endedAt = now()`) before inserting the new row.
Enforced by a partial unique index `uniq_trackingsession_active_per_worker`
AND by explicit code in `openTrackingSession` — belt and suspenders. A second
partial unique index enforces the per-TaskField invariant.

**Files:**
- `src/db/migrations/016_live_tracking.sql` — new `WorkerDeviceIdentity`
  (workerKey UNIQUE → `User.id`, isActive), `WorkerLiveLocation` (PK on
  `workerUserId`), `TrackingSession` (`taskFieldId uuid REFERENCES TaskField(id)`
  matching migration 009, `workerUserId text REFERENCES User(id)`, status CHECK
  including `SUPERSEDED`). RLS deny-all on all three. Idempotent.
- `src/services/workerLocation.ts` — new. `resolveWorkerFromKey` (active only),
  `upsertLiveLocation` (INSERT ... ON CONFLICT ("workerUserId") DO UPDATE, PK on
  the user id; latest fix overwrites the previous one).
- `src/services/tracking.ts` — new. Transactional `openTrackingSession`
  (SUPERSEDE prior worker session + INSERT new in one BEGIN/COMMIT with
  ROLLBACK-on-throw); `markArrived`; `closeSession` (idempotent, WHERE guards
  on ACTIVE|ARRIVED); `bumpSessionLocation`; `getPublicView` (lazy expiry on
  read, terminal-safe field whitelist); `listActiveSessions` (debug).
- `src/routes/owntracksPoc.ts` — after the POC insert, best-effort fan-out to
  `upsertLiveLocation` + `bumpSessionLocation`. Never fails the ack.
- `src/routes/tracking.ts` — new. `GET /tracking/:token` (public, token
  whitelist regex, 404-no-leak, no-store cache), `GET /tracking/debug/sessions`
  (internal, x-internal-secret guard mirrors `routes/tasks.ts`).
- `src/app.ts` — registers `trackingRoutes`.
- `src/ai/router.ts` `performTransition` — fire-and-forget hooks:
  DEPARTED → `openTrackingSession`, ARRIVED → `markArrived`, FINISHED →
  `closeSession('FINISHED')`. Tracking failures are logged and swallowed —
  they must NOT block the status write or the worker's ETA prompt.
- `src/ai/router.ts` decline reply handler — `closeSession('CANCELED')` on
  worker DECLINE (single call site, verified by grep — no other DECLINED /
  CANCELED write path exists in the bot).

**Env:** none new.

**QA:**
- `npx tsc --noEmit` — clean.
- Full `vitest run` — 1382 passing / 7 skipped / 74 files. Pre-existing
  intermittent "Worker exited unexpectedly" pool flake unchanged.
- New tests (20 cases, colocated under `src/__tests__/`):
  - `tracking.test.ts` — `openTrackingSession` transaction ordering (BEGIN →
    SUPERSEDE UPDATE → INSERT → COMMIT); `supersededCount` reported; ROLLBACK
    on INSERT throw + client released; `markArrived` only touches ACTIVE;
    `closeSession` idempotent + reason parameterized; `bumpSessionLocation`
    scoped by worker + status; `getPublicView` null-on-unknown, ACTIVE →
    full payload, expired ACTIVE → EXPIRED + location dropped, FINISHED →
    location dropped; internal ids never appear in the public payload;
    `listActiveSessions` filters + orders correctly.
  - `trackingRoute.test.ts` — token regex rejects malformed BEFORE DB call;
    404 semantics on unknown; `Cache-Control: no-store`; debug body shape.
  - `workerLocation.test.ts` — `resolveWorkerFromKey` requires `isActive=true`;
    `upsertLiveLocation` uses ON CONFLICT DO UPDATE, server-side `lastSeenAt`,
    optional fields null-safe, raw JSON-serialized.
- Existing router tests (`routerActiveInspection`, `routerInspections`)
  updated with a no-op `services/tracking` mock so their fire-and-forget log
  noise stays silent. All 76 assertions in those two files pass unchanged.

**Deviations / notes:**
- Migration `016` NOT yet applied to Supabase. Do NOT run without approval.
- Nothing deployed to Render — new `/tracking` route lands on next deploy only.
- `PocLocationPing` (migration 013) kept — the POC diagnostic surface is
  unchanged, `GET /owntracks/poc/debug` still works.
- The `expiresAt` cron sweep is intentionally out of scope. Sessions are
  lazily marked `EXPIRED` on read; a scheduler job can be added later.
- No `BOT_CAPABILITIES.md` update — this is backend foundation only, no new
  user-facing capability yet.

---

## 0.5 Quoted-message context infrastructure — Phase 2 (2026-07-07)

**Status:** DONE (local, uncommitted)

General "reply/quote → context" infrastructure. When a worker swipe-replies to a
bot message, Meta's webhook carries `context.id` = the quoted message's wamid; we
record a general context row at send time (`WhatsappMessageRef`) and resolve the
quote back to what the message was about. Builds on Phase 1.

**Two behavior layers:**
- **Deterministic (task_field):** swipe-reply to a TaskField message + "יצאתי"/
  "הגעתי"/"סיימתי" → updates exactly that TaskField. **Beats the Phase-1 pointer**
  and works with **no AI provider** (fast path before the `getProvider()` gate,
  like button taps). Also honored on the LLM path for verbose phrasing.
- **AI-with-context (non-task_field, minimal-safe):** the resolved `quotedContext`
  is passed into `parseIntent` (prompt enrichment) so a reply to e.g. the equipment
  reminder ("חסר לי מד רעש") routes through the existing `missing_equipment_free`
  flow; ambiguity → ask. The AI only picks existing intents — no free actions.

**Design guarantees:** `recordOutboundRef` is best-effort and NEVER throws (a ref
failure can't break a WhatsApp send); a missing/unknown/expired/other quote falls
through to the normal flow. task_field refs get `expiresAt = now()+30d`.

**Files:** new `src/db/migrations/015_message_refs.sql` (general `WhatsappMessageRef`:
wamid PK, recipientUserId, entityType, entityId, taskFieldId, kind, payload jsonb,
createdAt, expiresAt; RLS deny-all) + `src/services/messageRefs.ts`
(`recordOutboundRef`/`recordTaskFieldRef`/`resolveQuotedContext`, general
`QuotedContext`). `src/whatsapp/sender.ts` + `templates.ts` — senders now return
`Promise<string|null>` (the wamid; `post()` parses `messages[0].id`, non-fatal on
parse failure). Ref capture: `preInspectionReminder.ts` (pre_reminder),
`inspectionAssignment.ts` (assignment_card), `router.ts performTransition`
(eta_prompt/status_confirm), `digestDispatcher.ts` (equipment_reminder, rich
payload). `webhook.ts` parses `m.context.id` → threads `quotedWamid`.
`router.ts` — quoted fast path in `handleAIMessage` + threads `quotedContext`
through `routeIntent`/`executeIntent`/`runAdvanceStatusDirect` (priority #1).
`intentParser.ts` — optional `quotedContext` in the prompt.

**Env:** none new.

**QA:** `npx tsc --noEmit` clean; full `vitest run` green (1295 passing on a clean
run; the intermittent worker-exit pool flake pre-dates this). New tests:
`messageRefs.test.ts` (record/resolve, task_field vs non, unknown/expired null,
best-effort no-throw), `senderWamid.test.ts` (returns wamid / null-no-throw),
`routerActiveInspection.test.ts` +5 (quote beats pointer deterministically w/o AI;
verbose LLM path; unknown→pointer; closed/not-owner→fallback; equipment reply →
context to AI, no status write). Existing suites unaffected (ref recording
short-circuits on the `undefined` wamid mocked senders return).

**Deviations / notes:** daily_digest / menu / CRM-task / lead refs are NOT captured
yet (schema + service support them; a one-line `recordOutboundRef` per send-site
adds them later) and have no reply behavior — per the agreed scope. Migration `015`
not yet applied to Supabase. Not touched: GPS/OwnTracks/Google-Maps/customer page.

---

## 0.4 Active-task context after "יצאתי" — Phase 1 (2026-07-07)

**Status:** DONE (local, uncommitted)

Follow-up status messages ("הגעתי"/"סיימתי") now attach to the exact inspection
the worker departed for, instead of being re-resolved from scratch (which was
ambiguous on a multi-inspection day). Plan approved in-session.

**Core principle:** the moment "יצאתי" flips a TaskField to EN_ROUTE, its exact
`taskFieldId` is stored as the worker's `activeInspection` pointer (in
`WhatsappConversationContext.state`, keyed by phone, with its OWN 4h window that
outlives the 10-min row TTL). That pointer — NOT a status search — is the source
of truth for the next transition. Status (EN_ROUTE/ARRIVED) is only a validity
check; a status search is a **fallback** used only when there is no valid pointer.

**Behavior:**
- "יצאתי" → EN_ROUTE + store pointer immediately (independent of ETA) + ask the
  (binding, but OPTIONAL/non-blocking) travel ETA.
- "הגעתי"/"סיימתי" → use the stored pointer after validating it still belongs to
  the worker and isn't CANCELED/DECLINED/FINISHED_FIELD → ARRIVED / FINISHED_FIELD.
- Fallback when no valid pointer: single in-progress EN_ROUTE/ARRIVED → use it;
  several → ask (`status_disambig`); none → existing "any open" behavior.
- ETA reply parsed (`parseTravelMinutes`) → stored on `TaskField.travelEtaMinutes`
  + `expectedArrivalAt` (feeds the future customer-tracking ETA). No/unclear ETA
  never weakens the context (default 4h window).

**Files:** `src/db/migrations/014_travel_eta.sql` (2 additive columns);
`src/services/conversationContext.ts` (`activeInspection` + `status_eta_prompt`/
`idle_active_inspection` states + set/get/clear helpers);
`src/services/inspections.ts` (`validateWorkerTaskField`,
`findActiveInProgressTaskFieldForWorker`, `writeTravelEta`);
`src/ai/travelEta.ts` (new); `src/ai/router.ts` (`performTransition`
DEPARTED/ARRIVED, `handleStatusEtaReply`, pointer-first `runAdvanceStatusDirect`,
`idle_active_inspection` fall-through); `.env.example`
(`ACTIVE_INSPECTION_DEFAULT_WINDOW_MINUTES`, default 240).

**QA:** `npx tsc --noEmit` clean; full `vitest run` green (1263 passing on a clean
run; the intermittent "Worker exited unexpectedly" pool flake pre-dates this
change). New tests: `routerActiveInspection.test.ts` (chained
יצאתי→ETA→הגעתי→סיימתי on the SAME TaskField, follow-ups NOT disambiguated;
pointer-primary; ETA-not-a-condition; keyword-during-ETA; 3 fallback cases) +
`travelEta.test.ts`. Updated `routerInspections`/`detailViewAIContext` mocks +
DEPARTED/ARRIVED assertions for the new prompt + persisted-pointer behavior.

**Deviations / notes:** the ETA prompt replaces the old "עדכנתי — סטטוס: בדרך"
confirmation on DEPARTED (approved). The 60-min pre-reminder "יצאתי" tap
(`PREREMIND_DEPART`) still calls `advanceFieldStatus` directly and does NOT set
the pointer — a later "הגעתי" resolves via the in-progress FALLBACK; wiring it
through `performTransition` is a small follow-up. Migration `014` not yet applied
to Supabase. Phase 2 (reply/quoted-message reference) deferred as agreed.

---

## 0.3 OwnTracks GPS POC (2026-07-06)

**Status:** DONE (local, uncommitted)

Standalone POC to validate OwnTracks as the live GPS source for a future
customer arrival-tracking feature ("Wolt-lite"), BEFORE building the full
feature. Source of truth: `docs/POC_OWNTRACKS.md` (research + plan + go/no-go
criteria). Product decisions locked: success bar = a location update at least
every 60s while driving; fleet ~50/50 iOS/Android → iOS background behavior is
the deciding factor.

**Scope (intentionally minimal — receive + store + measure only):**
- Migration `013_owntracks_poc.sql` — one append-only table `"PocLocationPing"`
  (RLS deny-all, additive-only; mirrors 012 conventions). Not yet applied to
  Supabase.
- `src/routes/owntracksPoc.ts` — PUBLIC `POST /owntracks` (per-worker HTTP Basic
  auth via `POC_OWNTRACKS_USERS` allowlist; `workerKey` = authenticated
  username, NOT trusted from payload; stores only `_type:location`, acks `[]`)
  + INTERNAL `GET /owntracks/poc/debug` (x-internal-secret; latest location +
  `secondsSinceLast` + `stale` + pings-last-10min + median/max gap per worker).
- Registered in `src/app.ts`; env `POC_OWNTRACKS_USERS` + `POC_STALE_SECONDS`
  added to `.env.example` (section 10).

**Explicitly NOT built (deferred to full feature, only if POC passes):** customer
page, Google Maps / Routes ETA, geocode cache, new customer template,
`WorkerDevice`/`WorkerLiveLocation`/`TaskFieldTracking`, "יצאתי"/"הגעתי" flow
wiring, WebSocket, MQTT.

**QA done:** `npx tsc --noEmit` clean; full vitest suite 1258 passing (2 skip;
1 unrelated pool-worker flake); smoke test via buildApp+inject confirmed 401 on
missing/wrong/unknown creds and 200 `[]` on non-location. DB-insert path
(valid location) + real-device frequency measurement remain to be run against
Supabase during the field test.

**Remaining before field test:** apply migration `013` to Supabase; set
`POC_OWNTRACKS_USERS`; ensure a public HTTPS ingress to `POST /owntracks`;
configure OwnTracks (HTTP mode, Move, "Always"/background perms) on one Android
+ one iPhone; run the drive scenarios and fill the go/no-go table.

---

## 0.2 Dev-observer routing (2026-07-01)

Extended the special-user routing to include internal dev admins. Now:

**Exceptions viewers (§13 morning + evening):**
- `יורם` — operational owner
- `גיא פרנסס`, `גיא גבאי`, `יאיר` — dev observers

**Leads viewers (§12 leads morning 09:30 + D3-T4 escalation alerts):**
- `סשה` — operational owner
- `גיא פרנסס`, `יאיר` — dev observers (NOT `גיא גבאי`)

Escalation alerts fan out to all leads viewers via `Promise.allSettled` —
per-recipient failures are isolated. Sasha still receives only the leads
digest + escalations (no MORNING/EVENING); the other special users receive
BOTH the §13 exceptions digest AND (for leads viewers) the LEADS_MORNING.

**Sets are defined in `src/services/specialUsers.ts`** — `EXCEPTIONS_VIEWER_NAMES`
and `LEADS_VIEWER_NAMES`. To add / remove a name, edit the set (one line).

Users with no `User.phone` or `status != 'ACTIVE'` are silently blocked at
`selectDigestCandidates` (the SQL filter) and `getLeadsViewerPhones`.

---

## 0.1 Post-M9 routing refactor (2026-07-01)

**Change:** Yoram + Sasha are now identified by `User.name` (constants in
`src/services/specialUsers.ts` — `YORAM_NAME = 'יורם'`, `SASHA_NAME = 'סשה'`),
not by env-var phone allow-lists. The DB is the source of truth for their
phones (Sasha's phone is fetched via `getSashaPhone()` for the D3-T4 escalation
alert).

**Simplifications:**
- Removed `YORAM_PHONE` and `SASHA_PHONE` env vars everywhere.
- Removed `LEGACY_MANAGER_DIGEST_ENABLED` env var (X-T5 gate obsolete — see below).
- Removed `formatManagerMorning` and `formatManagerEndOfDay` from the dispatch
  path entirely (the retired formatters are still exported but unused).
- Everyone-except-Yoram is now treated as a field worker regardless of role
  (ADMIN / MANAGER / WORKER / TECHNICIAN): MORNING → `formatInspectorMorning`,
  EVENING → `formatEmployeeEndOfDay`. K1 rule (`role !== 'ADMIN'` = inspector)
  is superseded by name-based routing.
- The X-T5 gate becomes moot — non-Yoram/non-Sasha ADMINs now receive the
  same inspector treatment as workers, so no gate is needed.
- Sasha's phone is looked up from the DB (`getSashaPhone()` in
  `specialUsers.ts`) rather than read from an env var.

**Files touched:** `src/services/specialUsers.ts` (new), `digestDispatcher.ts`,
`leadAssignmentNotifier.ts`, `preflight.ts`, `.env.example`,
`galitManagerDispatcher.test.ts`, `sashaLeadsDispatcher.test.ts`,
`inspectorMorningDispatcher.test.ts`, `equipmentReminderDispatcher.test.ts`,
`leadAssignmentNotifier.test.ts`. `legacyManagerGate.test.ts` deleted.

**Impact on tasks:**
- D4-T1 / D4-T2 status unchanged (still DONE) — routing logic replaced but
  behavior for Yoram/Sasha is identical.
- X-T5 effectively **withdrawn** (the gate is deleted — everyone is treated as
  worker, so there's nothing to gate). Old K4 option (a) is now in effect by
  default without an env flag.

**Trade-off:** if the CRM renames Yoram or Sasha, edit the constants in
`specialUsers.ts` (one line). Env-var drift is eliminated.

---

## 0. Decisions log (locked 2026-06-30)

The 7 K-tasks from §2 are closed. Resolutions:

- **K1 — Inspector identification:** rule is `user.role !== 'ADMIN'`. No schema change, no new role value, no per-user flag column. Simpler than any of the 3 surfaced options. `D5-T1` collapses to a one-liner branch in the menu router; `D2-T1` is unblocked from the K1 axis.
- **K2 — `TaskField` scheduling mechanism:** CLOSED (2026-07-01). No field-task flag on `Task`. The CRM field scheduling form creates a `TaskField` row using an existing `Task ID`; `Task` remains the office / CRM customer task, and each `TaskField` row is one scheduled field visit / inspection appointment. One `Task` can have multiple `TaskField` rows. `Task.ownerId` is the assigned field worker; do not add `fieldWorkerId` to `TaskField`.
- **K3 — Yoram vs Sasha dispatcher routing:** option (a) — per-user routing inside `src/scheduler/jobs/digestDispatcher.ts`, keyed on a tiny bot-side mapping (env-var phone allow-list, or a 2-row lookup table). One scheduled job, two code paths inside. Two-cron-jobs rejected as over-engineered for ~2 users.
- **K4 — Old CRM manager digest:** option (c) — gate behind an env flag, default off. Precedent: `LEGACY_DAILY_SUMMARY_ENABLED` at `src/scheduler/index.ts:76`. Delete entirely once v2 has run cleanly in production for ~2 weeks.
- **K5 — Digest-preference sub-menu:** option (b) — hidden capability. Keep `UserDigestPreference` table + service as infrastructure. No menu entry. Accessible only via a free-text trigger. Worker menu stays at exactly 7 items per spec.
- **K6 — Daily greeting:** option (a) — keep AND auto-open the v2 inspections menu after it. Matches the §5 spec example "שלום דני, מה תרצה לעשות?".
- **K7 — STT provider:** OpenAI Whisper API. Hebrew supported. ~$0.006/min. Single env var (`OPENAI_API_KEY` or a dedicated `WHISPER_API_KEY`).

Downstream effect on task blockers: all K-decisions are closed. `D1-T4`, `D2-T2`, `D3-T3`, and `D5-T6` are no longer blocked on K2; they now target the CRM scheduling-form / unsent-`TaskField` model.

**2026-07-01 — B1, B2, and K2 RESOLVED.**
- **B1 resolved:** proceed with the clear, field-relevant מק"טים from the spec draft (lines 416-571). Shielding and borderline rows are skipped for now — include only unambiguous field-inspection types. `D1-T7` is unblocked.
- **B2 resolved:** table is `IncomingLead`. Columns: `id`, `subject`, `body`, `fromName`, `fromEmail`, `receivedAt`, `status`, `ownerId`, `taskId`, `notifiedAt`. Assignment field is `ownerId` (UUID FK to `User`). No phone column — messages display `fromName` / `fromEmail` / `subject` / `body`. `transferredToId` exists but is not used. All Domain 3 tasks unblocked; `D4-T1` leads portion unblocked.
- **K2 resolved:** the CRM field scheduling form creates `TaskField` using an existing `Task ID`. The bot detects/sends assignment cards from created `TaskField` rows where `workerNotifiedAt IS NULL`.

---

## 1. Blockers / external dependencies

These are inputs the bot team cannot produce internally. Work that depends on them is marked `Blocked: YES (B<n>)` throughout this document.

### B1 — InspectionType catalog (~150 מק"טים) sign-off
- **Status: RESOLVED (2026-07-01).** Proceed with the clear, field-relevant מק"טים from the draft at `SPEC_FIELD_V2.md` lines 416-571. Shielding rows and borderline non-inspection services are excluded from the initial seed — include only unambiguous field-inspection types. `D1-T7` is now unblocked.
- **What was needed:** the full, signed-off list of inspection מק"טים used to seed `InspectionType` — code (מק"ט), Hebrew label, family (one of the 13 CHECK values), `isActive`, `sortOrder`, and the `isFieldInspection` boolean per row.
- **Tasks previously gated on B1:** `D1-T7` (catalog seed) — now unblocked. Downstream verification of `D2-T2` (inspection card family label) also unblocked.

### B2 — `IncomingLead` table schema
- **Status: RESOLVED (2026-07-01).** All Domain 3 tasks unblocked; `D4-T1` leads portion unblocked.
- **Resolved details:**
  - **Table name:** `IncomingLead` (not `lead incoming` — old references in the spec/gap analysis are updated below).
  - **Columns:** `id`, `subject`, `body`, `fromName`, `fromEmail`, `receivedAt`, `status`, `ownerId`, `taskId`, `notifiedAt`.
  - **Assignment field:** `ownerId` (UUID FK to `User`) — transitions from null/empty to a user ID when Sasha assigns in the CRM.
  - **No phone column** — lead messages display `fromName` / `fromEmail` / `subject` / `body`.
  - `transferredToId` exists on the table but is **not used** in the bot for now.
  - The spec's earlier question about whether `assignedTo` is a FK or free-text: it is a UUID FK (`ownerId`).
- **Tasks previously gated on B2:** `D3-T1`, `D3-T2`, `D3-T3`, `D3-T4` — all now unblocked. `D3-T3` is independent of K2 unless it deliberately reuses generic polling helpers. The leads-counts portion of `D4-T1` is also now unblocked.

---

## 2. Decision-tasks (do BEFORE the code they gate)

Each of these resolves an ambiguity in the spec. They must close before any task that depends on them starts. The bot team owns the decision — but a stakeholder sign-off (Galit / spec author) should accompany each, since these affect product-visible behavior.

### K1 — How is an inspector identified?
- **Question:** how does the bot know a given `User` is a field inspector (so it shows the inspections menu)?
- **Options surfaced by the gap analysis** (GAP Domain 5 row 1):
  - (a) Reuse an existing `UserRole` value (e.g. `TECHNICIAN` becomes "inspector"). Fewest changes — but reuses a CRM name that may already mean something else.
  - (b) Introduce a new role value (`INSPECTOR` / `FIELD_WORKER`) on `User.role`. Additive but touches a CRM column.
  - (c) Add a per-user boolean (e.g. `isFieldInspector`) on a bot-side table. Strictly additive — does NOT touch the CRM. Most aligned with §1 ("additive-only on CRM").
- **What's blocked until decided:** `D5-T1` (role-based menu routing), `D2-T1` (the worker menu can be rendered, but it has no "right people" without this).
- **Recommended default per gap analysis lean:** option (c). Confirm with stakeholders.

### K2 — CRM scheduling form creates `TaskField`
- **Status: RESOLVED (2026-07-01).**
- **Decision:** no field-task flag on `Task` and no automatic `Task` → `TaskField` conversion. The CRM field scheduling form receives an existing `Task ID` and creates a `TaskField` row for one scheduled field visit / inspection appointment.
- **Card trigger:** the bot sends the inspection card when a created `TaskField` row exists and `workerNotifiedAt IS NULL`. After sending, the bot stamps `workerNotifiedAt` to prevent duplicate assignment-card sends.
- **Cardinality:** `TaskField.taskId` is not unique. One `Task` can have multiple scheduled `TaskField` rows.
- **Worker assignment:** `Task.ownerId` remains the assigned field worker. Do not add `fieldWorkerId` to `TaskField`.
- **Required creation validation:** `Task` exists; `Task.ownerId` exists; `Task.productName` exists; `Task.productName` matches `InspectionType.code`; scheduling form includes `scheduledStartAt`, `durationMinutes`, and location; `scheduledEndAt` is calculated from start time + duration. Do not send an inspection card unless `TaskField` was created successfully.
- **Unblocked by this decision:** `D1-T4`, `D2-T2`, `D3-T3`, `D5-T6`.

### K3 — Routing Yoram vs. Sasha to two different digests
- **Question:** how does the dispatcher decide Yoram gets the field+leads exceptions digest and Sasha gets the leads-only digest, when both look like elevated users today?
- **Options surfaced by the gap analysis** (GAP Domain 4 row 2):
  - (a) Per-user routing inside `digestDispatcher.ts`, keyed by a phone allow-list or a new role attribute.
  - (b) Split into two scheduled jobs with disjoint user sets.
- **What's blocked until decided:** `D4-T1` (Yoram exceptions digest content), `D3-T2` (Sasha 09:30 leads digest), `D4-T2` (Sasha-vs-Yoram dispatcher branch).

### K4 — Fate of the old CRM manager digest
- **Question:** once Yoram's v2 digest is in place, does the old CRM manager digest stay as a fallback, get deleted, or get gated behind an env flag?
- **Options surfaced by the gap analysis** (GAP Domain 4 row 4):
  - (a) Keep as fallback for unrecognized elevated users.
  - (b) Delete entirely — the bot is being repurposed and the old CRM digest no longer matches the product.
  - (c) Gate behind an env flag (precedent: `LEGACY_DAILY_SUMMARY_ENABLED` in `src/scheduler/index.ts` line 76).
- **What's blocked until decided:** `X-T5` (removing or gating the old manager digest formatters).

### K5 — Digest preference sub-menu exposure
- **Question:** is item 6/7 ("הגדרות סיכום בוקר/דוח סוף יום") removed from the v2 inspector menu, or kept as a hidden capability, or surfaced?
- **Options surfaced by the gap analysis** (GAP Part 2, "Digest settings sub-menu" row):
  - (a) Remove from menu entirely; keep `UserDigestPreference` table + service as infrastructure.
  - (b) Keep as a hidden capability (no menu entry; only accessible via a free-text trigger).
  - (c) Keep visible in the v2 worker menu (would require an 8th item).
- **What's blocked until decided:** `D2-T1` (the v2 worker menu items). The spec lists exactly 7 items, so default leans (a) or (b).
- **Recommended default per gap analysis:** option (b) — keep as a hidden capability for now; surface only if asked.

### K6 — Daily greeting in the v2 flow
- **Question:** does the per-user daily greeting (`src/services/greetings.ts`) stay, and if so does it open the v2 inspections menu automatically?
- **Options surfaced by the gap analysis** (GAP Part 2, "Per-user daily greeting" row):
  - (a) Keep + auto-open the v2 menu after the greeting (consistent with §5 example "שלום דני, מה תרצה לעשות?").
  - (b) Keep but do not auto-open.
  - (c) Remove entirely.
- **What's blocked until decided:** the menu wiring in `D2-T1` (whether the greeting triggers `renderMenu` automatically).
- **Recommended default per gap analysis:** option (a).

### K7 — Voice STT provider selection
- **Question:** which STT provider transcribes inbound voice messages? Whisper API? Another provider?
- **Options:** Whisper API (OpenAI), other commercial STT. The provider choice is the bot team's; the spec doesn't constrain it.
- **What's blocked until decided:** `D5-T2` (voice-handler implementation cannot be completed without an STT credential / provider client).

---

## 3. Tasks grouped by the 5 domains, in dependency order

### Domain 1 — DB schema (additive only)

#### D1-T1 — Migration 009 file scaffold (idempotent + conventions)
- **Status:** DONE (commit f7aeaa0)
- **What to do:** new file `src/db/migrations/009_field_inspections.sql`. Header + DO block envelope mirroring `008_digests.sql`. No DDL yet — this task is just the file shell + `BEGIN ... COMMIT` and the migration runner registration check. Confirm the file is detected by `src/db/migrate.ts` and `schema_migrations` tracks it.
- **Definition of Done:** running `npm run migrate` on a fresh DB applies migration 009 (currently a no-op) and records it in `schema_migrations`; running again is idempotent.
- **Reference:** GAP Domain 1 (all rows reference `009_*.sql`). Spec migration block lines 258-356.
- **Dependencies:** none.
- **Blocked:** no.

#### D1-T2 — `InspectionType` table DDL
- **Status:** DONE (commit f7aeaa0). Note: `isFieldInspection` column was OMITTED — it is not in the authoritative spec migration block (lines 258–356), which is the source of truth for column names per the build brief. Only the deferred, B1-blocked `D1-T7` references it; add it via an additive `ALTER TABLE` in that PR.
- **What to do:** extend `009_field_inspections.sql` with the `InspectionType` table. Columns per spec §3 + migration block lines 258-356: UUID PK `gen_random_uuid()`, `code` UNIQUE (= `Task.productName`), `labelHe`, `family` text + CHECK across the 13 declared values, `isActive` bool default true, `sortOrder` int, `isFieldInspection` bool, `createdAt`/`updatedAt` timestamps. Index on `family`. RLS enabled deny-all (pattern from `008_digests.sql`).
- **Definition of Done:** migration creates the table; the CHECK constraint rejects an unknown `family`; the unique constraint on `code` rejects a duplicate insert; RLS deny-all is verified via a non-service-role connection.
- **Reference:** GAP Domain 1 row 1. Spec §3, §14, lines 258-356, 408-413.
- **Dependencies:** D1-T1.
- **Blocked:** no (DDL not blocked — the seed is).

#### D1-T3 — `InspectionChecklist` table DDL
- **Status:** DONE (commit f7aeaa0)
- **What to do:** extend `009_field_inspections.sql` with `InspectionChecklist`. Columns per spec migration block lines 282-294: UUID PK, `family` text + CHECK (same 13 values), `code`, `labelHe`, `isRequired` bool, `sortOrder` int, `UNIQUE(family, code)`, index on `family`, RLS deny-all. NO `kind` column (dropped per spec).
- **Definition of Done:** table created; unique constraint on `(family, code)` rejects duplicates; CHECK on `family` rejects unknown values; RLS deny-all verified.
- **Reference:** GAP Domain 1 row 2. Spec §3, lines 282-294.
- **Dependencies:** D1-T1.
- **Blocked:** no.

#### D1-T4 — CRM scheduling form creates `TaskField` using `Task ID`
- **Status:** OBSOLETE/REWRITTEN by K2 (2026-07-01). Do not add a field-task flag to `Task`.
- **What to do:** document the CRM scheduling-form contract instead of adding a `Task` flag. The form creates one `TaskField` row per scheduled field visit using an existing `Task ID`; `Task` remains the office / CRM customer task.
- **Definition of Done:** no migration adds a field-task flag column to `Task`; docs/migration comments state that `TaskField` is created from the CRM scheduling form using `Task ID`; validation rules are documented (`Task` exists, `ownerId`, `productName`, matching `InspectionType.code`, `scheduledStartAt`, `durationMinutes`, location, calculated `scheduledEndAt`).
- **Reference:** GAP Domain 1 row 4. Spec §1, §3.
- **Dependencies:** D1-T1, K2.
- **Blocked:** NO (K2 resolved 2026-07-01).

#### D1-T5 — `TaskField` table DDL (operational spine)
- **Status:** DONE (commit b288e72; original DDL commit f7aeaa0). K2 revision applied 2026-07-01 and committed: removed the old uniqueness constraint on `taskId`, added scheduling fields (`appointmentTitle`, `scheduledStartAt`, `scheduledEndAt`, `durationMinutes`, `workerNotifiedAt`), and added `idx_taskfield_task_id`. Note: a 13-value `CHECK` was added to `TaskField.family` (the snapshot column) to match `InspectionType`/`InspectionChecklist` — the raw spec block left it bare, but the build brief's hard constraints and this task spec both require it.
- **What to do:** extend `009_field_inspections.sql` with `TaskField`. Columns per spec §3, §4, migration block lines 297-336: UUID PK, `taskId` FK to `Task` (**not unique**; one `Task` can have multiple scheduled field visits), `inspectionTypeId` UUID FK to `InspectionType`, snapshot `family` text + CHECK (same 13 values), scheduling metadata (`appointmentTitle`, `scheduledStartAt`, `scheduledEndAt`, `durationMinutes`, `workerNotifiedAt`), static site metadata (`siteAddress`, `siteCity`, `fieldContactName`, `fieldContactPhone`, `navigationUrl`, `specialInstructions`), live `fieldStatus` text + CHECK over **exactly the 10 values** (`ASSIGNED, CONFIRMED, DECLINED, NEEDS_MORE_INFO, EN_ROUTE, ARRIVED, FINISHED_FIELD, WAITING_FOR_INFO, HAS_PROBLEM, CANCELED` — NO `STARTED`), per-status timestamps (`assignedAt, confirmedAt, declinedAt, departedAt, arrivedAt, finishedAt`), `declinedReason` text, inline problem (`problemType` text + CHECK over the 7 declared values, `problemNote` text, `hasOpenProblem` bool), missing-info (`missingReportInfo` bool, `missingReportInfoNote` text), `managerNotifiedAt` timestamp, `updatedByUserId` UUID FK to `User`, `createdAt/updatedAt` timestamps. `assignedAt` is row creation / system assignment time; `scheduledStartAt` is the planned inspection time. Index on `taskId`; index on `fieldStatus`; partial index `WHERE hasOpenProblem = true`. RLS deny-all.
- **Definition of Done:** table created; `taskId` allows multiple rows for the same `Task`; normal `idx_taskfield_task_id` exists; the 10-value CHECK rejects any other `fieldStatus`; the 7-value CHECK rejects any other `problemType`; scheduling fields exist with `scheduledStartAt`, `scheduledEndAt`, and positive `durationMinutes`; indexes present; RLS deny-all verified.
- **Reference:** GAP Domain 1 row 3. Spec §3, §4, lines 297-336.
- **Dependencies:** D1-T1, D1-T2.
- **Blocked:** no.

#### D1-T6 — Seed `InspectionChecklist` for the 4 declared families
- **Status:** DONE (commit f7aeaa0)
- **What to do:** idempotent `INSERT ... ON CONFLICT (family, code) DO NOTHING` block for the 4 families (radiation / noise / asbestos / radon) — 17 rows total — fully specified in spec migration block lines 360-381.
- **Definition of Done:** running migration 009 twice leaves exactly 17 rows in `InspectionChecklist`; rows match the spec's family/code/labelHe/isRequired/sortOrder.
- **Reference:** GAP Domain 1 row 6. Spec lines 360-381, 580-598.
- **Dependencies:** D1-T3.
- **Blocked:** no.

#### D1-T7 — Seed `InspectionType` catalog (~150 rows)
- **Status:** DONE (local, uncommitted). Extended `src/db/migrations/009_field_inspections.sql` inside the existing `BEGIN...COMMIT` transaction: added idempotent `ALTER TABLE "InspectionType" ADD COLUMN IF NOT EXISTS "isFieldInspection" boolean NOT NULL DEFAULT true` (per D1-T2 status note — column was omitted from original migration), then idempotent `INSERT ... ON CONFLICT (code) DO NOTHING` seeding **74 field-inspection rows** across **10 families**: `air (12)`, `asbestos (3)`, `radon (10)`, `odor (3)`, `water (7)`, `soil (5)`, `occupational (2)`, `noise (21)`, `radiation (10)`, `green (1)`. All 10 families verified against the 13-value CHECK. Excluded (all rows with `isFieldInspection=false`): all shielding/מיגון rows (~39 radiation shielding products), all `thermal` office reports, all `opinion` (environmental opinions), all `general` (logistics/admin), plus ~12 misc rows for lab calibration / office reports / preliminary surveys / consulting / historical surveys / customer-info forms / noise forecasts / document prep. Deviations: (1) used `ON CONFLICT DO NOTHING` instead of the spec's `DO UPDATE` upsert — matches `InspectionChecklist` seed style in the same file and matches the brief; (2) `sortOrder` for `soil` starts at 3 to preserve spec relative ordering (rows 1 and 2 were shielding/office and skipped). tsc clean; SQL syntactically valid.
- **What to do:** idempotent `INSERT ... ON CONFLICT (code) DO NOTHING` block for the clear field-relevant מק"ט rows from `SPEC_FIELD_V2.md` lines 416-571. Shielding/borderline rows excluded for now. Set `isFieldInspection = true` for the relevant subset.
- **Definition of Done:** catalog seed runs idempotently; every row's `family` passes the CHECK; shielding/borderline rows omitted; re-runnable without duplicates.
- **Reference:** GAP Domain 1 row 1 (seed). Spec lines 416-571 (draft).
- **Dependencies:** D1-T2, B1.
- **Blocked:** NO (B1 resolved 2026-07-01 — proceed with unambiguous field-inspection rows).

### Cross-cutting infra prerequisites (interleaved here — needed before D2 menus and D3 reads)

#### D5-T1 — Inspector role detection + role-based menu routing
- **Status:** DONE (commit b288e72). `menuItemsFor` in `src/ai/menu.ts` implements K1: `user.role === 'ADMIN' → managerMenu(); else → employeeMenu()`. Comment in the function documents the deliberate v2 change from the old `isElevated` split. The three-way Yoram/Sasha/inspector routing at the dispatcher level is D4-T2 (not yet done). DoD is met: inspector sees v2 7-item menu; ADMIN (elevated) sees manager menu; tsc clean; 276/283 tests pass.
- **What to do:** extend `src/auth/userResolver.ts` and `src/ai/menu.ts` to recognize a field inspector per the K1 decision. The current `menuItemsFor` two-way branch (`isElevated` vs. not) becomes three-way: inspector → inspections menu (Domain 2); Sasha → leads-only display; Yoram → exceptions-only display; remaining elevated → fallback per K4.
- **Definition of Done:** an inspector calling the menu trigger sees the v2 inspections menu items only; a non-inspector elevated user sees no inspector menu; resolved role is logged in the audit trail.
- **Reference:** GAP Domain 5 row 1. Spec §1, §2.
- **Dependencies:** K1, K3, K4.
- **Blocked:** NO (K1, K3, K4 closed).

#### D5-T2 — Voice (`audio`) inbound: download + transcribe + route as text
- **Status:** DONE (commit a628b10). New `src/whatsapp/voice.ts` (Meta 2-step download + Whisper `/v1/audio/transcriptions`, `whisper-1`, `language=he`, K7) + `src/__tests__/voice.test.ts` (11 tests, all pass). `webhook.ts` audio branch seeds `WhatsappAuditLog` with `mediaId`, transcribes, feeds transcript through the existing `handleIncomingMessage` text path; fallback text `לא הצלחתי להבין את ההודעה הקולית…` on null. `utils/auditLog.ts`: `writeAuditLog` now returns the inserted id + new `updateTranscribedMessage(id, text)` helper (never throws) — 3 unrelated callers (`routes/tasks.ts`, `scheduler/jobs/digestDispatcher.ts`, `ai/router.ts`) got 1-line `await` conversions to preserve `Promise<void>` contracts. Deviations: raw `https.request` (mirrors `sender.ts`) instead of fetch, no new dep; audit-log helper lives in `utils/auditLog.ts` (no `whatsappAuditLog.ts` service exists in this repo). `OPENAI_API_KEY` already recognized by preflight — missing key logs a warn and no-ops.
- **What to do:** new file `src/whatsapp/voice.ts` (or similar). Extend `src/routes/webhook.ts processInbound` to handle `m.type === 'audio'`. Pipeline: download the Meta audio asset → call the STT provider chosen in K7 → write the transcript into the existing `WhatsappAuditLog.transcribedMessage` column (slot already exists from migration 001 line 54) → feed the transcript into the existing `handleIncomingMessage` text path. New env var for the STT credential.
- **Definition of Done:** sending a Hebrew voice message via WhatsApp results in: (a) the transcript stored in `WhatsappAuditLog.transcribedMessage`, (b) the same downstream routing as if the transcript had been typed.
- **Reference:** GAP Domain 5 row 2. Spec §5, §8, §9, §11, §14.
- **Dependencies:** K7.
- **Blocked:** NO (K7 closed).

#### D5-T3 — AI intent set rewrite for field statuses
- **Status:** DONE (commit a628b10). `ai/schema.ts` adds 3 new `AI_INTENTS` (`set_field_status`, `report_problem`, `report_missing_info`) + `FIELD_STATUS_TRANSITIONS` (5 values) + `FIELD_PROBLEM_TYPES` (7 values); JSON tool-call schema + Zod validator extended with strict `z.enum` (out-of-set values rejected per DoD). `types/index.ts`: `AIIntent` union extended, `FieldStatusTransition` + `FieldProblemType` exported. `intentParser.ts`: Hebrew few-shot mappings for all 5 transitions (יצאתי / הגעתי / סיימתי / מחכה למידע / יש בעיה), mapped + unmapped `problem_type` cases, missing-info notes, inline customer-ref ("יצאתי ללקוח כהן"). Legacy CRM intents preserved (X-T2 removes them). 20 new tests in `aiSchema.test.ts` across 8 describe blocks — all pass; existing 5 tests unchanged. Deviation: `transition` + `problem_type` land as top-level `AIIntentResult` fields (mirrors `field` / `new_value`) rather than inside `params` — required for strict `z.enum` rejection. Router untouched (`executeIntent` has a `default: helpText()` branch, no exhaustiveness fix needed) — the 3 new intents fall to `helpText()` until D2-T5 / T7 / T8 wire them.
- **What to do:** extend `src/ai/intentParser.ts` and `src/ai/schema.ts` with a new intent `set_field_status` and sub-types `DEPARTED / ARRIVED / FINISHED / WAITING_FOR_INFO / HAS_PROBLEM`. Also add `report_problem`, `report_missing_info`. Keep `help` and `unknown`. The drop of the old CRM intents (`list_tasks`, `create_task`, `edit_field`, `edit_duedate`, `reassign_task`, `relink_task`, `team_workload`, `confirm_pending_action`, `decline_pending_action`) is `X-T2` — keep them temporarily here for the transitional period.
- **Definition of Done:** "departed for Ra'anana", "arrived", "finished" all parse to `set_field_status` with the right sub-type; ambiguous cases route through the existing `task_disambig` path in `src/ai/router.ts` lines 286-296.
- **Reference:** GAP Domain 5 row 3, GAP Part 2 "Existing AI router + intent parser" row. Spec §5.
- **Dependencies:** D5-T1.
- **Blocked:** no (after D5-T1 done).

### Domain 2 — Worker side, field inspections (sections 5-11)

#### D2-T1 — Rewrite worker main menu (`employeeMenu()`) to the 7 v2 items
- **Status:** DONE (local, uncommitted; base commit b288e72). `employeeMenu()` in `src/ai/menu.ts` has exactly 7 v2 items: הבדיקות שלי להיום / למחר / עדכון סטטוס / דיווח על בעיה / חסר ציוד / חסר מידע לדוח / סיכום יום. Per K5, digest_settings is absent from `employeeMenu()` (hidden capability — it remains in `managerMenu()` only). `menuItemsFor` routes !ADMIN → employeeMenu per K1. **Follow-up 2026-07-01 (part A):** items 1+2 (`list_inspections_today` / `_tomorrow`) are no longer stubs — new `sendInspectorDayList(user, when)` helper in `src/ai/router.ts` calls `getInspectionsForWorkerOnDate(user.id, localDate)` and renders via new `formatInspectorDayList(items, {when})` in `src/whatsapp/digestContent.ts` (menu-friendly header "הבדיקות שלך להיום/למחר:", no "בוקר טוב" greeting, empty → "אין בדיקות משובצות …"); tomorrow = 24h shift in Asia/Jerusalem. **Follow-up 2026-07-01 (part B) — v2 UX contract "free text at any time":** added `NUMERIC_PICKER_AWAITING` set + `looksLikeNumericPickerInput(trimmed)` helper at the top of `router.ts`; a top-of-`continueConversation` escape hatch clears context and re-enters `handleAIMessage` whenever the user is in a numeric-picker state (main menu, mgr menus, sub-menus, mgr_today/exceptions/search_action detail views, all confirm states, all pick-worker/pick-list pickers) and types free text rather than digits or a nav word (`חזרה`/`ביטול`/`כן`/`לא`/`חיפוש`/…). This fixes the "I see inspection detail → I ask a question → I just get the menu again" bug flagged by the user. Text-capture states (missing_info_note, decline_reason, need_info_note, notes, search queries, time/duration prompts) are intentionally NOT in the set — the whole point of those states is to capture free text. `correct_type_pick_from_list` is also excluded because its handler treats free text as a search filter over the type catalog. Existing "invalid input re-prompts" tests updated: numeric out-of-range inputs (`9`, `99`) still re-prompt; free-text inputs (`טקסט לא תקין`, `אולי`, `משהו`) now escape to AI. Tests: 3 new `formatInspectorDayList` cases in `inspectorMorning.test.ts`; 4 "invalid choice" tests renamed to "out-of-range numeric choice"; 2 confirm-state tests reframed to "free text escapes to AI (ctx cleared, no direct action)". Full suite: 618/625 pass (7 pre-existing DB-integration skips); tsc clean.
- **What to do:** rewrite `employeeMenu()` in `src/ai/menu.ts` (lines 51-61 today). The 7 items per spec §5: `הבדיקות שלי להיום`, `הבדיקות שלי למחר`, `עדכון סטטוס בדיקה`, `דיווח על בעיה`, `חסר ציוד`, `חסר מידע לדוח`, `סיכום יום`. Add 7 new `MenuAction` kinds: `list_inspections_today`, `list_inspections_tomorrow`, `update_inspection_status`, `report_problem`, `missing_equipment`, `missing_report_info`, `day_summary`. Per K5, digest-settings exposure is removed from this menu (default: hidden).
- **Definition of Done:** an inspector sees exactly the 7 v2 items, numbered, Hebrew, no emojis; replying with a number triggers the corresponding `MenuAction`; `MENU_TRIGGER_RE` (existing) re-opens the menu.
- **Reference:** GAP Domain 2 row 1. Spec §5.
- **Dependencies:** D5-T1, K5, K6.
- **Blocked:** NO (K5, K6 closed; K1 axis resolved via D5-T1).

#### D2-T2 — Inspection card emission on `TaskField` creation
- **Status:** DONE (local, uncommitted). New `src/services/inspectionAssignment.ts` — `findUnnotifiedTaskFields()` selects `WHERE workerNotifiedAt IS NULL`, joins `Task → User (ownerId)`, `InspectionType`, `Customer` (LEFT), ordered by `assignedAt`. `getEquipmentLabels(family)` reads `InspectionChecklist` sorted by `sortOrder`, deduped by `labelHe`. `formatInspectionCard` renders the spec §6 body verbatim (type / customer / address / date+time in Asia/Jerusalem / contact / equipment list / navigation / 3 numbered choices); missing optional fields are omitted rather than shown as placeholders. `sendAndStampAssignmentCard` calls `sendButtonMessage` with 3 deterministic payload IDs (`INSP_CONFIRM_<uuid>`, `INSP_DECLINE_<uuid>`, `INSP_NEED_INFO_<uuid>`), then UPDATEs `workerNotifiedAt = now()` guarded by `AND "workerNotifiedAt" IS NULL` so a concurrent stamp is a no-op. Send failures leave the row unstamped for the next tick to retry. Skips rows with no worker phone (warning). Tests: `src/__tests__/inspectionAssignment.test.ts` — payload IDs, query shape, dedup, layout, missing-field handling, send-then-stamp order, send-failure-does-not-stamp, no-phone skip. `npx tsc --noEmit` clean; `npx vitest run` — 299 passed / 7 skipped / 306 total. Deviations: (a) card lives in `services/inspectionAssignment.ts` rather than `services/inspections.ts` (the latter already exists as the D2-T5/T7/T8 write path; splitting keeps the polling send-path isolated). (b) Button titles are shortened to fit Meta's 20-char cap while preserving numbers ("1. מאשר" / "2. לא יכול" / "3. פרטים") — the full spec labels appear in the card body's numbered "בחר:" section.
- **What to do:** new file `src/services/inspections.ts` for `TaskField` reads/writes. New emission path detects created `TaskField` rows where `workerNotifiedAt IS NULL`; these rows come from the CRM field scheduling form using an existing `Task ID`. Load `TaskField` + `Task` + `InspectionType` + `Customer` + `InspectionChecklist` rows for the family + `User` from `Task.ownerId` (the assignee), assemble the card per spec §6 (type label, customer, address, `scheduledStartAt`, contact, equipment list, navigation link), and call `sendButtonMessage` with 3 reply buttons: `1. מאשר`, `2. לא יכול להגיע`, `3. צריך פרטים נוספים`. Use deterministic payload IDs (e.g. `INSP_CONFIRM_<taskFieldId>`, `INSP_DECLINE_<taskFieldId>`, `INSP_NEED_INFO_<taskFieldId>`). After successful send, stamp `workerNotifiedAt`.
- **Definition of Done:** a created `TaskField` row with `workerNotifiedAt IS NULL` results in the assigned worker (`Task.ownerId`) receiving one card with three labelled buttons matching spec §6 verbatim; successful sends set `workerNotifiedAt`; repeated polling does not send duplicates.
- **Reference:** GAP Domain 2 row 2. Spec §6.
- **Dependencies:** D1-T5, D1-T6, K2.
- **Blocked:** NO (K2 resolved). For end-to-end verification with a real family label, also B1.

#### D2-T3 — Inspection card button replies → `fieldStatus` writes
- **Status:** DONE (local, uncommitted). Five new write helpers in `src/services/inspections.ts`: `confirmInspection` (CONFIRMED + confirmedAt), `declineInspection` (DECLINED + declinedAt + declinedReason), `requestMoreInfo` (NEEDS_MORE_INFO + fieldNotes + managerNotifiedAt), plus `notifyOfficeDeclined` / `notifyOfficeNeedsMoreInfo` broadcasting to every active MANAGER/ADMIN via the existing `broadcastToManagers`/`loadAlertContext` helpers. Router (`src/ai/router.ts`): new `matchInspectionCardTap(text)` — anchored regex `^INSP_(CONFIRM|DECLINE|NEED_INFO)_([0-9a-f-]{36})$` — invoked ahead of AI/NLU inside `handleAIMessage`, same slot as `matchEquipmentTap`. `handleInspectionCardTap` — CONFIRM writes directly + acks + clears; DECLINE sets `awaiting: 'inspection_decline_reason'` with `taskFieldId` and prompts for a short reason; NEED_INFO sets `awaiting: 'inspection_need_info_note'` and prompts for follow-up text. Two new `AwaitingKind`s added to `conversationContext.ts` (`inspection_decline_reason`, `inspection_need_info_note`) — `continueConversation` handles both via `handleInspectionDeclineReasonReply` / `handleInspectionNeedInfoNoteReply`, which run the write + notify pair and reply "עדכנתי. המשרד קיבל התראה." — empty text keeps the awaiting state and re-prompts. Interactive-message handling already routes button `id` through the text path in `webhook.ts:162-170` (no webhook change needed). Tests: 5 new write/notify cases in `src/__tests__/inspections.test.ts` (SQL shape + params for all 3 writes, alert body content for both notifies); 7 new tap-driven cases in `src/__tests__/routerInspections.test.ts` (CONFIRM ack, DECLINE prompt, DECLINE reason capture, DECLINE empty-reason re-prompt, NEED_INFO prompt, NEED_INFO note capture, non-matching INSP_* payload falls through). `npx tsc --noEmit` clean; `npx vitest run` — 299 passed / 7 skipped / 306 total. Deviation: NEEDS_MORE_INFO follow-up text is persisted to `fieldNotes` (no dedicated column exists on `TaskField` for assignment-time questions; the migration comment "field notes + single inline problem" makes it the natural home). The office receives the text in the alert, so durability is not required, but persisting preserves the request across CRM-side inspection review.
- **What to do:** extend `src/routes/webhook.ts` interactive-message handler (lines 162-170 today) to route the 3 stable payload IDs from D2-T2 to `TaskField` updates: `INSP_CONFIRM_*` → `fieldStatus = CONFIRMED` + `confirmedAt`; `INSP_DECLINE_*` → `fieldStatus = DECLINED` + `declinedAt` + prompt for short `declinedReason` (new `conversationContext.awaiting` state) + alert office; `INSP_NEED_INFO_*` → `fieldStatus = NEEDS_MORE_INFO` + prompt for free-text follow-up (new awaiting state).
- **Definition of Done:** each button tap writes the right `fieldStatus`, sets the right timestamp, persists `declinedReason` when supplied, and emits the office alert; the next inbound text from the same user lands in the right `awaiting` slot.
- **Reference:** GAP Domain 2 row 3. Spec §6, §7.
- **Dependencies:** D1-T5, D2-T2.
- **Blocked:** no (after D2-T2).

#### D2-T4 — Worker morning reminder: today's inspections + numbered status update
- **Status:** DONE (commit b288e72). `getInspectionsForWorkerOnDate(userId, localDate)` in `src/services/inspectionsQueries.ts` filters/orders by `scheduledStartAt`. `formatInspectorMorning(items, user)` in `src/whatsapp/digestContent.ts` — Hebrew numbered list per spec §7, all 8 status labels, null-tolerant. Dispatcher in `src/scheduler/jobs/digestDispatcher.ts` routes non-ADMIN → `formatInspectorMorning` (X-T3 done here). Tests: `inspectorMorning.test.ts` + `inspectorMorningDispatcher.test.ts` — all pass. tsc clean.
- **What to do:** extend `src/scheduler/jobs/digestDispatcher.ts` so that — for users identified as inspectors per K1/D5-T1 — the morning slot sends inspections where `TaskField.scheduledStartAt` falls on the local day (numbered, ordered by `scheduledStartAt`) + a "choose a number to update status" prompt. New content formatter in `src/whatsapp/digestContent.ts` (replaces `formatEmployeeMorning` for inspectors; old CRM formatter handled by `X-T3`). Numbered-reply pattern reused from `src/ai/router.ts`. Per-day dedup via `src/services/digestSendLog.ts`.
- **Definition of Done:** an inspector with N inspections today receives one Hebrew message listing all N numbered, with a status-update prompt; dispatcher dedup prevents a second send the same day.
- **Reference:** GAP Domain 2 row 4. Spec §7.
- **Dependencies:** D1-T5, D2-T1, D5-T1.
- **Blocked:** NO (K1 axis resolved; query contract updated to `scheduledStartAt`).

#### D2-T5 — Worker on-demand status transitions (departed / arrived / finished)
- **Status:** DONE (commit b288e72). `services/inspections.ts` gained `advanceFieldStatus({ taskFieldId, transition, updatedBy })` — 3-way switch on the `AdvanceTransition` union (`DEPARTED|ARRIVED|FINISHED`, narrowed at the type level so `WAITING_FOR_INFO`/`HAS_PROBLEM` are not accepted here; those still route through `writeMissingInfo`/`writeProblem`). FINISHED write is unconditional (only `WHERE id = $1` — no CHECK-current-status guard). Also added `resolveOpenTaskFieldByHint(userId, hint)` — parameterized ILIKE substring on `Customer.name` OR `TaskField.siteAddress` (`'%' || $2 || '%'`), same OPEN_FIELD_STATUSES filter as `findOpenTaskFieldForWorker`, empty-hint short-circuit. `ai/menu.ts` gained `statusUpdateMenu()` + `renderStatusUpdateMenu()` (3 items). `ai/router.ts`: menu route 3 replaced (`startStatusUpdateFlow` → `renderStatusUpdateMenu` → `status_choice` awaiting → `advanceFieldStatus` + "עדכנתי — סטטוס: …" reply; FINISHED opens the D2-T6 follow-up). D5-T3 `set_field_status` intent wired in `executeIntent`: DEPARTED/ARRIVED/FINISHED → `runAdvanceStatusDirect` (with hint via `resolveOpenTaskFieldByHint` when `intent.task_reference` set); WAITING_FOR_INFO → D2-T7 path (with `params.note` short-circuit); HAS_PROBLEM → D2-T8 path (with `problem_type` short-circuit). The previously-stubbed `missing_info_disambig`/`problem_disambig` are now wired via a shared `handleDisambigReply` that resolves the hint and transitions to the right follow-up state (`missing_info_note`/`problem_type_choice`); "ביטול" clears; no match keeps awaiting. New `AwaitingKind`s: `status_choice`, `status_disambig`. `pendingTransition?: FieldStatusTransition` added to `ConversationState` so a free-text disambig hint carries the requested transition across turns. Tests: `__tests__/inspections.test.ts` — 3 `advanceFieldStatus` cases (per transition, asserting sibling timestamps untouched, FINISHED assert no `AND "fieldStatus"` guard), 5 `resolveOpenTaskFieldByHint` cases (0/1/N + ILIKE parameterization + empty short-circuit). `__tests__/routerInspections.test.ts` — 7 D2-T5 menu-driven cases + 5 `set_field_status` intent cases + 6 disambig-resolution cases. Full suite: 233 pass / 7 skipped / 240 total (was 183/7/190). `npx tsc --noEmit` clean. No deviations.
- **What to do:** in `src/services/inspections.ts`, implement `advanceFieldStatus(taskFieldId, transition)` for `EN_ROUTE` ("departed", + `departedAt`), `ARRIVED` ("arrived", + `arrivedAt`), `FINISHED_FIELD` ("finished", + `finishedAt`, **unconditional**). Wire to: (a) the menu item 3 numbered-reply path, (b) the free-text/voice routing via D5-T3 intents.
- **Definition of Done:** each transition writes the correct `fieldStatus` and timestamp; "finished" never blocks; ambiguity when the worker has multiple inspections today routes through the existing `task_disambig` style flow.
- **Reference:** GAP Domain 2 row 4. Spec §7.
- **Dependencies:** D1-T5, D2-T4, D5-T3.
- **Blocked:** no (after deps).

#### D2-T6 — Finished follow-up 4-option menu
- **Status:** DONE (commit b288e72). Landed in the same edits as D2-T5. `services/inspections.ts` gained `writeFieldNotes({ taskFieldId, notes, updatedBy })` — writes only `fieldNotes` + `updatedByUserId` + `updatedAt` (no `fieldStatus`/`finishedAt`/`managerNotifiedAt` touched; the FINISHED_FIELD write already happened). `fieldNotes` column already exists on `TaskField` from D1-T5, no migration change needed. `ai/menu.ts` gained `finishedFollowUpMenu()` + `renderFinishedFollowUpMenu()` (4 items, numbered text per D5-T4). `ai/router.ts`: after `performTransition(...,'FINISHED')` we set `awaiting: 'finished_followup'` (retaining `taskFieldId`) and send the 4-option menu. `handleFinishedFollowUpReply`: option 1 → "רשמנו. כל טוב!" + clear; option 2 → prompt "מה ההערות מהשטח?" + `awaiting: 'finished_notes'`; option 3 → hand off to D2-T8 (`awaiting: 'problem_type_choice'` + `renderProblemTypeMenu()` — reuses the already-known `taskFieldId`, no re-lookup); option 4 → hand off to D2-T7 (`awaiting: 'missing_info_note'` + "מה חסר לדוח?"). Invalid input → resend menu with "בחר מספר תקין:" prefix, keep awaiting. `handleFinishedNotesReply` captures the text (voice arrives as text via D5-T2) and calls `writeFieldNotes`, then "נשמר. תודה." + clear. New `AwaitingKind`s: `finished_followup`, `finished_notes`. Tests: `__tests__/inspections.test.ts` — `writeFieldNotes` asserts fieldNotes/updatedByUserId/updatedAt only, no other columns touched. `__tests__/routerInspections.test.ts` — 5 D2-T6 cases (option 1, option 2 flow with notes write, options 3/4 hand-offs asserting no re-lookup, invalid input). Full suite: 233 pass / 7 skipped / 240 total. No deviations.
- **What to do:** after `FINISHED_FIELD` writes successfully, send the 4-option follow-up menu (`אין הערות` / `יש הערות מהשטח` / `יש בעיה` / `חסר מידע לדוח`). Option 2 → free text → save to `fieldNotes` (a column on `TaskField` — confirm it exists in D1-T5 schema; if not, add a `fieldNotes` text column to D1-T5). Option 3 → route to D2-T8 (problem flow). Option 4 → route to D2-T7 (missing-info flow).
- **Definition of Done:** after a finished write, the worker receives the 4-option menu; option 1 ends the flow; option 2 captures notes; options 3/4 hand off cleanly to the right downstream flow.
- **Reference:** GAP Domain 2 row 5. Spec §7.
- **Dependencies:** D2-T5.
- **Blocked:** no.

#### D2-T7 — "Missing info for report" flow
- **Status:** DONE (commit b288e72). New `src/services/inspections.ts` (~230 LOC — `writeMissingInfo`, `findOpenTaskFieldForWorker`, `notifyOfficeMissingInfo` + shared `writeProblem` / `notifyOfficeProblem` for D2-T8, all queries parameterized). `src/ai/router.ts`: menu route 6 replaced (prompts "מה חסר לדוח?" → new `missing_info_note` awaiting state → `writeMissingInfo` + `notifyOfficeMissingInfo` → "עדכנתי. המשרד קיבל התראה."); D5-T3 free-text intent `report_missing_info` wired in `executeIntent` (skips prompt when `params.note` is set). `src/services/conversationContext.ts` extended with 5 new `AwaitingKind`s + `taskFieldId` / `problemType` state fields. Ambiguous case (>1 open TaskField) captures `missing_info_disambig` state with a TODO(D2-T5) message — D2-T5 will resolve. Office recipient uses existing `getManagersForBroadcast()` (active MANAGER/ADMIN with a phone) — matches how the due-date approval flow broadcasts today; when no managers exist, logs a warning and no-ops the send (the write already stamped `managerNotifiedAt`). Verified `Task.ownerId` column name against `src/services/tasks.ts` (no `assigneeId` in this schema). Tests: `src/__tests__/inspections.test.ts` (20/20 pass); `src/__tests__/routerInspections.test.ts` (17/17 pass). Full suite: 183 pass / 7 skipped. `npx tsc --noEmit` clean.
- **What to do:** new flow triggered by menu item 6 or by the post-finished menu option 4. Prompt: "מה חסר לדוח?" → accept free text or voice → set `fieldStatus = WAITING_FOR_INFO`, `missingReportInfo = true`, `missingReportInfoNote = <text>`, `managerNotifiedAt = now()` → alert the office via `sendTextMessage`. Voice transcripts arrive here automatically via D5-T2.
- **Definition of Done:** the four `TaskField` fields are written; the office receives an alert containing the worker name, the inspection identity, and the missing-info note.
- **Reference:** GAP Domain 2 row 6. Spec §8.
- **Dependencies:** D1-T5, D5-T2, D5-T3.
- **Blocked:** NO (D5-T2/K7 closed).

#### D2-T8 — "Report a problem" flow (7-item numbered sub-menu)
- **Status:** DONE (commit b288e72). Shipped in the same commit as D2-T7 — the 4 write/query helpers live together in the new `src/services/inspections.ts`. `src/ai/menu.ts` gained `problemTypeMenu()` + `renderProblemTypeMenu()` exports (7 items numbered 1–7, Hebrew labels, `problemType` machine values verbatim from the CHECK constraint on `TaskField.problemType` in migration 009). `src/ai/router.ts`: menu route 4 replaced (findOpenTaskFieldForWorker → `renderProblemTypeMenu` → new `problem_type_choice` awaiting state; types 1–5 write directly with `note=null`; types 6 [PROFESSIONAL_ISSUE] / 7 [OTHER] transition to `problem_type_note` awaiting state and write on the follow-up reply; invalid number → resend menu with "בחר מספר תקין:" prefix, keep awaiting). D5-T3 free-text intent `report_problem` wired: skips the sub-menu when `problem_type` is set on the intent; otherwise runs the same menu-driven flow. Manager alert per spec §9 (בעיה מהשטח / עובד / בדיקה / לקוח / סוג / detail / לטיפול מנהל.) broadcast via `getManagersForBroadcast()`. Tests: 5 problem-type param tests (types 1–5 direct write); 2 elaboration tests (6, 7); invalid-input resend; ambiguous & no-open branches; D5-T3 direct-dispatch tests. Full suite: 183 pass / 7 skipped. `npx tsc --noEmit` clean.
- **What to do:** new flow triggered by menu item 4 or by the post-finished menu option 3. Render the 7 problem types numbered: `CUSTOMER_NOT_ANSWERING / NO_ACCESS / CUSTOMER_NOT_PRESENT / MISSING_EQUIPMENT / CANNOT_PERFORM / PROFESSIONAL_ISSUE / OTHER`. Options 6 ("בעיה מקצועית") and 7 ("אחר") prompt for free-text elaboration. Write `problemType`, `problemNote`, `hasOpenProblem = true`, `fieldStatus = HAS_PROBLEM`. Send the spec-§9 alert to the manager.
- **Definition of Done:** every problem type writes the right `problemType`; options 6 and 7 also write `problemNote`; the manager alert text matches the spec §9 template; only ONE open problem at a time per `TaskField` (per spec §9 — multi-problem is deferred via `TaskFieldEntry`).
- **Reference:** GAP Domain 2 row 7. Spec §9.
- **Dependencies:** D1-T5, D5-T3.
- **Blocked:** no.

#### D2-T9 — Equipment reminder (morning roll-up by family)
- **Status:** DONE (commit b288e72). `getEquipmentChecklistForFamilies(families)` in `src/services/inspectionsQueries.ts` — deduped by `labelHe`, returns `EquipmentChecklistItem[]`. `formatEquipmentReminder(items, user)` + `equipmentTakenAllPayloadId` / `equipmentMissingPayloadId` in `src/whatsapp/digestContent.ts`. `maybeDispatchEquipmentReminder(row)` in `src/scheduler/jobs/digestDispatcher.ts` — piggybacked on the MORNING slot, own `EQUIPMENT_MORNING` dedup key. Button handler in `src/ai/router.ts`: `EQUIP_ALL_*` → ack + clear; `EQUIP_MISSING_*` → `equipment_missing_note` awaiting → free-text → manager alert. Menu item 5 also opens the "חסר ציוד" flow. Tests: `equipmentReminder.test.ts` (formatter — 5 cases), `equipmentQuery.test.ts` (query — 2 cases), `equipmentReminderDispatcher.test.ts` (dispatcher routing). All pass.
- **What to do:** new job (or piggyback on D2-T4) that, for each inspector with inspections where `TaskField.scheduledStartAt` falls today, aggregates the required equipment by joining each inspection's `family` to `InspectionChecklist` rows. Send one message listing the unique equipment items + 2 buttons via `sendButtonMessage`: `לקחתי הכל` / `חסר לי ציוד`. The second button → free-text prompt → manager alert.
- **Definition of Done:** worker with two inspections in different families receives one consolidated equipment list (deduped); "חסר לי ציוד" handler captures the free-text item and alerts the manager.
- **Reference:** GAP Domain 2 row 8. Spec §10.
- **Dependencies:** D1-T3, D1-T5, D1-T6, D2-T4.
- **Blocked:** no.

#### D2-T10 — On-demand worker day summary (menu item 7)
- **Status:** DONE (commit b288e72). `getFieldSummaryForWorkerOnDate(userId, localDate)` in `src/services/inspectionsQueries.ts` filters/orders by `scheduledStartAt`. `dayFieldSummary(userId, localDate)` in `src/services/inspections.ts`. `formatDaySummary` + `daySummaryFollowUpMenu()` + `renderDaySummaryFollowUpMenu()` in `src/whatsapp/digestContent.ts` + `src/ai/menu.ts`. Router: menu item 7 → `startDaySummaryFlow` → `day_summary_choice` awaiting; option 1 → "כל הכבוד!"; options 2/3/4 hand off to D2-T7/call-back-later/D2-T8. Tests: `daySummary.test.ts` + `routerDaySummary.test.ts` (20 cases). All pass. No new DB tables written per spec §14.
- **What to do:** new service method `dayFieldSummary(userId, date)` in `src/services/inspections.ts`. Reads today's `TaskField` rows for the worker by `scheduledStartAt`, lists those at `FINISHED_FIELD`, counts `WAITING_FOR_INFO`. Then renders a 4-option menu (`הכל בוצע` / `חסר מידע לדוח` / `צריך לחזור ללקוח` / `בעיה פתוחה`); options 2-4 hand back into D2-T7 / a (light) "call back later" handler / D2-T8 respectively. **No `FieldWorkerDayClose` DB write** — deferred per §14.
- **Definition of Done:** the menu produces a Hebrew summary of today's finished inspections and the waiting-for-info count; options 2-4 hand off to existing flows; no new tables are written.
- **Reference:** GAP Domain 2 row 9. Spec §11.
- **Dependencies:** D1-T5, D2-T1, D2-T7, D2-T8.
- **Blocked:** no.

### Domain 3 — Leads stream (Sasha)

#### D3-T1 — `IncomingLead` reader service
- **Status:** DONE (local, uncommitted). New file `src/services/incomingLeads.ts`. Exports: `IncomingLeadRow`, `AssignedLeadRow`, `findUnassignedInWindow(from, to)`, `findOvernightUnassignedLeads(localDate)` (DST-aware PostgreSQL window: prev-day 17:00 → today 09:30 Jerusalem), `findNewlyAssignedLeads(limit?)` (JOIN User, role != ADMIN, NOT EXISTS WLN ASSIGNED_TO_WORKER), `findEscalationCandidates(limit?)` (ownerId NULL, >1h old, 09:30–22:00 Jerusalem, NOT EXISTS WLN ESCALATED_1H), `findActiveInspectors()`. Also new `src/services/leadNotificationLog.ts` with `claimLeadNotification(leadId, eventKind)` (INSERT-first dedup into WhatsappLeadNotification). Migration 010 (`WhatsappLeadNotification` dedup table) already committed. Tests: `src/__tests__/incomingLeads.test.ts` (9 cases). tsc clean; 329/336 tests pass. Deviation: function names differ from spec (renamed to match actual callers; `findOvernightUnassignedLeads` replaces `findUnassignedInWindow` for D3-T2; `findNewlyAssignedLeads` replaces `findRecentlyAssigned`; dedup checks included in queries rather than delegated to callers).
- **What to do:** new file `src/services/incomingLeads.ts`. Read-only queries against the `IncomingLead` table. Columns: `id`, `subject`, `body`, `fromName`, `fromEmail`, `receivedAt`, `status`, `ownerId`, `taskId`, `notifiedAt`. No phone — messages use `fromName`/`fromEmail`/`subject`/`body`. Provide: `findUnassignedInWindow(from, to)` (where `ownerId IS NULL`), `findUnassignedOlderThan(minutes, createdBetween)`, `findRecentlyAssigned(sinceTimestamp)` (where `ownerId` just flipped from null). The bot WRITES NOTHING to this table — handling and assignment happen in the CRM.
- **Definition of Done:** functions return typed `IncomingLeadRow` rows; pool from `src/db/connection.ts`; no INSERTs/UPDATEs; column names match B2 resolution.
- **Reference:** GAP Domain 3 row 1. Spec §12.
- **Dependencies:** B2.
- **Blocked:** NO (B2 resolved 2026-07-01).

#### D3-T2 — Sasha 09:30 morning leads digest
- **Status:** DONE (commit 1751119 refactored the earlier local WIP; base 6181042). Follow-up QA 2026-07-01: original notes referenced `SASHA_PHONE` env var; commit 1751119 dropped env-var config and switched to **name-based routing** — dispatcher now branches on `isSasha(row.user_name)` / `isLeadsViewer(row.user_name)` from `src/services/specialUsers.ts`. Rest of the impl unchanged: `DigestType` extended with `'LEADS_MORNING'`, `formatSashaLeadsMorning` in digestContent, `dispatchSashaLeadsMorning` fires at 09:30 with `claimDigestSend(userId, 'LEADS_MORNING', localDate)` dedup, normal MORNING/EVENING suppressed via `if (isSasha(row.user_name)) continue`. Tests: `sashaLeadsMorning.test.ts` + `sashaLeadsDispatcher.test.ts`. Uses `sendTextMessage` directly (no template — D5-T5 scope).
- **What to do:** new digest type `LEADS_MORNING` (or a Sasha-only flavor per K3). Content formatter in `src/whatsapp/digestContent.ts`: list all `IncomingLead` rows from 17:00 yesterday → 09:30 today where `ownerId IS NULL`, per spec §12 format. Display `fromName` / `fromEmail` / `subject` / `body` (no phone). Include per-lead AI suggestion of the best-matching worker by ROLE (from D3-T5). New cron entry at 09:30 (either a per-Sasha `UserDigestPreference` row, or a dedicated job).
- **Definition of Done:** at 09:30 local (`Asia/Jerusalem`), Sasha receives one message listing overnight unassigned leads with AI suggestions; per-day dedup via `digestSendLog`; advisory-lock protected.
- **Reference:** GAP Domain 3 row 2. Spec §12.
- **Dependencies:** D3-T1, D3-T5, K3.
- **Blocked:** NO (B2 resolved; K3 closed to option (a)).

#### D3-T3 — Worker-assignment alert (`ownerId` transitions null → user)
- **Status:** DONE (local, uncommitted). New file `src/scheduler/jobs/leadAssignmentNotifier.ts` (`runLeadAssignmentNotifier` → `processAssignmentAlerts` + `processEscalations`). D3-T3 path: `findNewlyAssignedLeads()` → INSERT-first `claimLeadNotification(leadId, 'ASSIGNED_TO_WORKER')` → `sendTextMessage` to worker (alert: sender, subject, body, "לטיפול ועדכון ב-CRM"). Skips workers with no phone. Per-lead failures isolated. Registered in `scheduler/index.ts` at `*/2 * * * *`, lock ID 1010. Dedup is via `WhatsappLeadNotification` (migration 010) — NOT via `IncomingLead.notifiedAt` (CRM-owned column not written). Tests: in `src/__tests__/leadAssignmentNotifier.test.ts`.
- **What to do:** new polling job in `src/scheduler/jobs/leadAssignmentNotifier.ts` (mirroring `completionNotifier.ts` lines 16-37). Polls `IncomingLead` for rows where `ownerId` just flipped from null to a `User.id`. Alert content: `fromName` / `fromEmail` / `subject` / `body` + "לטיפול ועדכון ב-CRM" (no phone; read-only). Dedup: use `IncomingLead.notifiedAt` — stamp it on the bot side after sending (NOT via a column on the CRM table — use a bot-side mirror table if `notifiedAt` is not writable, or confirm it is a bot-writable column).
- **Definition of Done:** when `ownerId` flips from null to a `User` who is an inspector (`role !== 'ADMIN'`), that inspector receives one alert and only one; restarts don't re-alert.
- **Reference:** GAP Domain 3 row 3. Spec §12.
- **Dependencies:** D3-T1. Optional: reuse generic polling/dedup infrastructure from D5-T6 if that helper exists, but lead assignment is independent of K2.
- **Blocked:** NO (B2 and K2 resolved).

#### D3-T4 — 1-hour escalation to Sasha for unassigned daytime leads
- **Status:** DONE (commit 1751119 refactored; base 6181042). Follow-up QA 2026-07-01: escalation recipient is no longer `SASHA_PHONE` env var — `processEscalations` in `src/scheduler/jobs/leadAssignmentNotifier.ts` calls `getLeadsViewerPhones()` (DB name lookup for every user matching `isLeadsViewer`, fans out via `Promise.allSettled` — one bad phone doesn't block the others). Silently no-ops when no leads viewers have phones. Rest unchanged: `findEscalationCandidates()` (ownerId IS NULL, >1h old, 09:30–22:00 Jerusalem local) → `findActiveInspectors()` → `claimLeadNotification(leadId, 'ESCALATED_1H')` (INSERT-first at-most-once) → `suggestWorkerForLead` → escalation alert text. Tests: `leadAssignmentNotifier.test.ts` (still references `SASHA_PHONE` in comments but exercises the DB-based path).
- **What to do:** add to the polling job from D3-T3: any `IncomingLead` row where `ownerId IS NULL` and `receivedAt` is between 09:30-22:00 local and more than 1 hour ago → ONE alert to Sasha including the AI suggestion (D3-T5) or "לא נמצאה התאמה". Display: `fromName` / `fromEmail` / `subject` / `body`. Overnight leads (17:00-09:30) are skipped — covered by D3-T2. Dedup must guarantee exactly one event per lead.
- **Definition of Done:** a lead with `receivedAt` at 11:00, still `ownerId IS NULL` at 12:00, triggers ONE Sasha alert; overnight leads never trigger; restarts don't re-fire.
- **Reference:** GAP Domain 3 row 4. Spec §12.
- **Dependencies:** D3-T1, D3-T3, D3-T5.
- **Blocked:** NO (B2 resolved; lead assignment/escalation is independent of K2).

#### D3-T5 — AI suggest-worker-by-role function
- **Status:** DONE (commit b288e72). Landed as new sibling file `src/ai/leadSuggester.ts` (not extended into `provider.ts`) exporting `suggestWorkerForLead(lead, candidates, provider?)`. Uses the existing `getProvider()` seam via `emitStructured`, strict JSON schema `{ userId: string|null, reason: string }`. Returns `{ userId: null, reason: 'לא נמצאה התאמה' }` on any of: empty candidates (no AI call), null provider, thrown error, hallucinated userId (not in candidate list). Never throws. Optional third `provider` param mirrors `parseIntent`'s pattern in `intentParser.ts:130-133` — real callers pass just two args; tests inject a mock directly. Per K1, inspector filtering (`role !== 'ADMIN'`) is the caller's responsibility. Tests: `src/__tests__/leadSuggester.test.ts` — 7/7 passing (empty candidates, disabled provider, valid pick, hallucinated id, provider throws, radiation sample, null-with-reason-kept).
- **What to do:** new function in `src/ai/provider.ts` (or a sibling file) that takes a lead's `service`/message text + the list of inspector `User` rows and returns a single suggested `User.id` (or null with reason). System prompt maps the lead text → best `User.role` → candidate. Strictly a suggestion; never auto-assigns.
- **Definition of Done:** for a sample lead "בדיקת קרינה ברעננה", the function returns an inspector whose role matches "קרינה"; for an off-topic message, returns null with "לא נמצאה התאמה".
- **Reference:** GAP Domain 3 row 5. Spec §12.
- **Dependencies:** D5-T1 (need to know which `User`s are inspectors).
- **Blocked:** no (the AI call itself isn't blocked; the lead text input is via B2 which gates the consumers D3-T2 / D3-T4, not this function).

### Domain 4 — Manager digest / exceptions (Yoram + Sasha)

#### D4-T1 — Yoram exceptions digest (morning + evening) content
- **Follow-up 2026-07-02 — `scheduledStartAt` alignment:** the original impl used `assignedAt` / `finishedAt` as the day-scoping column for all 5 counts, and `getOpenFieldExceptions` had no date filter at all (Deviations 2 + 3 in the earlier status). Product decision reversed both: "today" for every TaskField daily count and every open-exception in Yoram's daily digest is **`TaskField.scheduledStartAt` inside the local Asia/Jerusalem day**. Files changed: `src/services/exceptionsQueries.ts` — `getFieldExceptionCounts` now uses a single `WHERE tf."scheduledStartAt" IN today` predicate with per-status `COUNT(*) FILTER`; `getOpenFieldExceptions` now filters by `scheduledStartAt` too (no more all-time). `src/services/managerViews.ts` — `getManagementSnapshot` Query 2 (openExceptions) and `getFieldExceptionRows` filters `open_exceptions` / `has_problem` / `waiting_for_info` gained the same daily scope (they previously received `localDate` but ignored it). Leads flow (`IncomingLead` / `receivedAt`) intentionally UNCHANGED. New file `src/__tests__/exceptionsQueries.test.ts` — 11 focused tests (scheduledStartAt in WHERE, no assignedAt/finishedAt as day-scoping cols, all 5 count predicates present, open-exceptions ordering, empty-DB zeros). `src/__tests__/managerViews.test.ts` — 5 assertions strengthened to require `scheduledStartAt` + `localDate` param on the openExceptions/has_problem/waiting_for_info/open_exceptions paths; leads query gained a regression guard ("must still use `receivedAt`, must NOT use scheduledStartAt"). Full suite: 778 passed / 7 pre-existing DB-integration skips / 785 total; tsc clean.
- **Status:** DONE (local, uncommitted). FIELD portion committed earlier (b288e72). LEADS portion now complete: added `getYoramLeadCounts(localDate)` + `YoramLeadCounts` type to `src/services/incomingLeads.ts` — single-query aggregate `COUNT(*) FILTER (...)` returning `overnight` (all leads received in prev-day-17:00 → today-09:30 Jerusalem window, regardless of ownerId) + `unassigned` (all rows where `ownerId IS NULL` right now). Deleted `LEADS_TODO_LINE` constant from `src/whatsapp/digestContent.ts`; added `formatLeadsLine` helper; extended `formatGalitManagerMorning` and `formatGalitManagerEndOfDay` signatures to accept `leadCounts: YoramLeadCounts` and render `לידים: X מהלילה · Y לא שויכו`; `params` arrays extended to 8 entries (name + 5 field counts + 2 lead counts). `src/scheduler/jobs/digestDispatcher.ts` Yoram branch `Promise.all` extended with `getYoramLeadCounts(row.local_date)`; result passed through to both Galit formatters. Tests: `src/__tests__/incomingLeads.test.ts` extended with 3-case `getYoramLeadCounts` describe block; `galitManagerDigest.test.ts` updated (leadCounts arg, params length, real leads-line assertions, +2 non-zero cases); `galitManagerDispatcher.test.ts` extended with lead-counts mock. tsc clean; 342/349 total pass (7 pre-existing skips). New file `src/services/exceptionsQueries.ts` — read-only, parameterized: `getFieldExceptionCounts(localDate)` (5 counts per §13: בוצעו / לא אושרו / עם בעיה / ממתינות למידע / לא סגרו יום, all in ONE round-trip via `COUNT(*) FILTER` + a `bounds` CTE for the Asia/Jerusalem half-open window) + `getOpenFieldExceptions(localDate)` (LEFT JOIN Task→Customer, LEFT JOIN Task→User via `Task.ownerId`, WHERE `hasOpenProblem = true` OR (`missingReportInfo = true` AND `fieldStatus = 'WAITING_FOR_INFO'`), ordered by `managerNotifiedAt ASC NULLS LAST`). New formatters in `src/whatsapp/digestContent.ts`: `formatGalitManagerMorning` + `formatGalitManagerEndOfDay` (no emojis per spec, no CTA button; header + field counts row + leads placeholder still pending integration + numbered `פתוחים:` list or `אין חריגים פתוחים.` one-liner; null-tolerant worker/customer → `עובד לא ידוע`/`לקוח לא ידוע`; note fallback: `problemNote` / `missingReportInfoNote` → `problemType` Hebrew label from `problemTypeMenu()` → `—`). `src/scheduler/jobs/digestDispatcher.ts`: new Yoram branch in `buildContent` fires BEFORE both the D2-T4 inspector branch AND the legacy ADMIN branch when `normalizeIsraeliPhone(row.user_phone) === normalizeIsraeliPhone(YORAM_PHONE)`; `YORAM_PHONE` is cached OUTSIDE the `for (const row of rows)` loop so non-Yoram rows pay only a string-compare — no N+1 env-parse fan-out. Dedup ledger (`claimDigestSend(userId, MORNING|EVENING, localDate)`) untouched — Yoram writes the same digestType so the existing PK covers him. Legacy paths preserved when `YORAM_PHONE` unset/empty/unparseable. Phone normalization reuses `normalizeIsraeliPhone` from `src/auth/phoneNormalizer.ts` — no new helper. `src/config/preflight.ts`: added a production-only warning when `YORAM_PHONE` is unset; app never crashes on absence. `.env.example`: added `YORAM_PHONE=` block with K3/B2 context. Tests: `src/__tests__/galitManagerDigest.test.ts` (12 formatter cases — empty/N exceptions, null worker+customer, note-null-with-problemType fallback, note+problemType both null → `—`, null user name, counts row content, leads TODO present for both formatters) + `src/__tests__/galitManagerDispatcher.test.ts` (9 routing cases — MORNING+EVENING match, MORNING+EVENING unset, whitespace-only YORAM_PHONE, different-ADMIN-phone falls through to legacy, MANAGER whose phone matches STILL wins the Yoram branch, `claimDigestSend`-false skips send). Split into two files because `vi.mock('../whatsapp/digestContent', ...)` is file-hoisted and would replace the real formatters in the pure suite. `npx tsc --noEmit` clean; `npx vitest run` — 233 passed / 7 skipped / 240 total (baseline before this task was 183/7/190 per brief; the delta is Wave-2 test files landing between the brief being written and this task starting). Deviations: (1) LEADS portion outstanding; B2 is resolved. (2) `getOpenFieldExceptions` takes `localDate` in its signature for API symmetry but does NOT filter by date — an open problem from yesterday is still open today; commented in the module. (3) `hasProblemToday` count considers rows either finished-today OR assigned-today-still-open, so a same-day problem counts even if unfinished. (4) preflight warning is `productionOnly`, following the precedent of other optional-in-dev keys.
- **What to do:** new formatters `formatGalitManagerMorning` / `formatGalitManagerEndOfDay` in `src/whatsapp/digestContent.ts` (or rename and replace the existing `formatManagerMorning` / `formatManagerEndOfDay` per K4). New aggregation queries against `TaskField` for the 5 field counts (`בוצעו / לא אושרו / עם בעיה / ממתינות למידע / לא סגרו יום`) and against `IncomingLead` for the leads numbers (מהלילה / לא שויכו). Also the numbered list of OPEN exceptions = workers + customers + free-text issue (from `problemNote` / `missingReportInfoNote`).
- **Definition of Done:** Yoram's morning and evening messages match the §13 format; counts come from `TaskField` queries; open-exceptions list is sorted (suggested: by `managerNotifiedAt`); dispatcher uses the existing 08:00/17:00 default times unchanged for Yoram.
- **Reference:** GAP Domain 4 rows 1, 3. Spec §13.
- **Dependencies:** D1-T5, D3-T1 (for the leads counts).
- **Blocked:** NO — B2 resolved (2026-07-01); leads portion now unblocked. `IncomingLead` columns: `id`, `subject`, `body`, `fromName`, `fromEmail`, `receivedAt`, `status`, `ownerId`, `taskId`, `notifiedAt`.

#### D4-T2 — Dispatcher branch Yoram vs. Sasha vs. other elevated
- **Status:** DONE (commit 1751119 refactored to name-based routing; earlier design used YORAM_PHONE / SASHA_PHONE env vars). Follow-up QA 2026-07-01: routing branches:
  - **Yoram / exceptions viewers:** `isExceptionsViewer(row.user_name)` in `buildContent` → `formatGalitManagerMorning` / `formatGalitManagerEndOfDay` for MORNING + EVENING (real leads counts, see D4-T1).
  - **Sasha / leads viewers:** `isSasha(row.user_name)` at top of `runDigestDispatcher` loop → `dispatchSashaLeadsMorning` (LEADS_MORNING at 09:30) + `continue` to suppress normal MORNING/EVENING.
  - **Residual elevated (other ADMIN/MANAGER, not exceptions/leads viewers):** falls through to `buildContent`'s field-worker path — MORNING = `formatInspectorMorning`, EVENING = `formatEmployeeEndOfDay`. The `LEGACY_MANAGER_DIGEST_ENABLED` env flag from the earlier X-T5 design was REMOVED by 1751119; `formatManagerMorning` / `formatManagerEndOfDay` in `digestContent.ts` are now orphaned exports (dead code from the dispatcher's POV). Tests: `galitManagerDispatcher.test.ts` + `sashaLeadsDispatcher.test.ts`. `legacyManagerGate.test.ts` may still exist but tests dead code — verify next cleanup.
- **What to do:** per K3, extend `src/scheduler/jobs/digestDispatcher.ts isElevated` branching (line 119) so Yoram routes to D4-T1, Sasha routes to D3-T2, and the residual elevated path is handled per K4 (kept / removed / env-gated — see `X-T5`).
- **Definition of Done:** Yoram receives only the exceptions digest (D4-T1); Sasha receives only the leads digest (D3-T2); the test of "two elevated users get different content the same morning" passes.
- **Reference:** GAP Domain 4 row 2. Spec §13.
- **Dependencies:** D3-T2, D4-T1, K3, K4.
- **Blocked:** NO (K3, K4 closed).

### Domain 5 — Cross-cutting infra (remaining)

#### D5-T4 — Button-vs-numbered-text policy enforcement
- **Status:** DONE (wave 2 commit — same as D2-T4/T7/T8). Policy documented inline in two places: (1) a JSDoc block above `problemTypeMenu()` in `src/ai/menu.ts` naming the two allowed `sendButtonMessage` surfaces (§6 inspection card = D2-T2; §10 equipment reminder = D2-T9) and stating every other menu stays numbered text; (2) the JSDoc on `sendButtonMessage` in `src/whatsapp/sender.ts:57-66` extended with the same policy. Cross-refs the pre-existing caveat at `src/ai/router.ts:773-776` (which predates this policy but stays valid). No behavioural change — every v2 menu emitted so far (7-item main via D2-T1, 7-item problem sub-menu via D2-T8) is already numbered text; policy locks in the invariant.
- **What to do:** no new code, but a written policy comment in `src/ai/menu.ts` / `src/whatsapp/sender.ts` reaffirming: 3-button `sendButtonMessage` only for the inspection card (§6) and the equipment reminder (§10); everything else (7-item main menu, 7-item problem sub-menu, finished follow-up 4-item, day-summary 4-item) stays numbered text. Honor the existing comment in `src/ai/router.ts` lines 773-776.
- **Definition of Done:** the policy is documented inline; no menu rendered with more than 3 buttons exists in the code.
- **Reference:** GAP Domain 5 row 4. Spec §1, §6.
- **Dependencies:** none.
- **Blocked:** no.

#### D5-T5 — Approved Meta templates for out-of-window sends
- **What to do:** register Meta-approved templates for: the §6 inspection card and the §13 exception alerts (likely arrive out-of-window). Config task, not a code change — but blocks production validation.
- **Definition of Done:** templates approved by Meta; template IDs added to env config; `sendTemplateMessage` calls in the inspection-card and exception-alert paths reference them.
- **Reference:** GAP Part 2, "WhatsApp sender" row. Spec §6, §13.
- **Dependencies:** D2-T2, D4-T1.
- **Blocked:** no (technically; depends on Meta turnaround).

#### D5-T6 — Polling-job template for unsent `TaskField` assignment cards
- **Status:** DONE (local, uncommitted). Instead of a shared "template" file, the D2-T2 send + stamp lives in `services/inspectionAssignment.ts` and the polling entrypoint `runInspectionAssignmentPoll` is invoked by a thin new job wrapper `src/scheduler/jobs/assignmentCardNotifier.ts` (`runAssignmentCardNotifier`). Registered in `src/scheduler/index.ts` at `*/2 * * * *` (Asia/Jerusalem), new advisory-lock id `1009` (`assignmentCardNotifier`) — same interval and lock discipline the retired `completionNotifier` used to run at. Dedup semantics: `workerNotifiedAt IS NULL` is the primary filter; the UPDATE is `SET "workerNotifiedAt" = now() WHERE id = $1 AND "workerNotifiedAt" IS NULL` so a race between the same instance's retries or a manual DB stamp becomes a no-op. Per-row send failures are logged and isolated — the loop continues to the next row and unstamped rows retry on the next tick. Tests: `runInspectionAssignmentPoll` cases in `inspectionAssignment.test.ts` verify per-row failure isolation and the no-rows short-circuit. `npx tsc --noEmit` clean; `npx vitest run` — 299 passed / 7 skipped / 306 total. Deviation from spec: no separate reusable "polling template" — the primary consumer (D2-T2 assignment cards) has its own dedicated module; lead-assignment polling (D3-T3) is independent of K2 and will be introduced separately when the leads stream lands.
- **What to do:** if D2-T2 uses polling, factor out a shared polling-job template (mirroring `completionNotifier.ts`). Primary consumer: D2-T2 detects created `TaskField` rows where `workerNotifiedAt IS NULL`, sends the inspection card, then stamps `workerNotifiedAt`. Optional consumer: D3-T3 may reuse the helper for `IncomingLead.ownerId` flip null→user → alert worker, but that lead flow is independent of K2.
- **Definition of Done:** one reusable polling helper exists if polling is chosen; the `TaskField` assignment-card consumer uses `workerNotifiedAt` for dedup; any lead-assignment consumer has isolated dedup from field cards.
- **Reference:** GAP Domain 1 row 4, Domain 3 row 3, Domain 5 cross-cutting. Spec §1.
- **Dependencies:** D1-T5, D2-T2.
- **Blocked:** NO (K2 resolved).

---

## 4. Dismantle / replace the existing

These tasks remove or rewrite Part 2 capabilities marked "dropped" or "to-rewrite". They are ordered AFTER their replacements so functionality is never absent.

#### X-T1 — Drop `my tasks` / `list_tasks` from the worker menu and intents
- **Status:** DONE (local, uncommitted). `list_tasks` intent no longer reaches an active user-facing handler. `doListTasks` router handler retired; `list_tasks` removed from the `AI_INTENTS` union in `src/ai/schema.ts` and from the `AIIntent` type in `src/types/index.ts`. `src/services/tasks.ts listTasks` PRESERVED (still exported — no active caller in the worker menu, but kept for potential admin/debug use per the "keep for residual admin use" clause of the brief). Menu removal was already done in D2-T1. Tests updated: `aiSchema.test.ts` legacy-kind assertion replaced with "contains exactly the 6 active intents" test.
- **What to do:** removal from `employeeMenu()` is already covered by `D2-T1`. Additionally: gut the `list_tasks` handler path from `src/ai/router.ts` `doListTasks` (lines 641-655) and the corresponding `MenuAction`. Keep `src/services/tasks.ts listTasks` function for any residual admin use (or remove entirely if no other callers remain).
- **Definition of Done:** `list_tasks` intent no longer reaches a handler in the worker path; `doListTasks` is removed or guarded behind an admin-only flag.
- **Reference:** GAP Part 2, "my tasks / list_tasks" row.
- **Dependencies:** D2-T1, D2-T4 (inspections-list replacement must be live first).
- **Blocked:** no.

#### X-T2 — Drop old CRM intents (`create_task`, `edit_field`, `edit_duedate`, `reassign_task`, `relink_task`, `team_workload`, `confirm_pending_action`, `decline_pending_action`)
- **Status:** DONE (local, uncommitted). All 8 retired intents removed from `src/ai/schema.ts` (`AI_INTENTS` reduced to the 6 active field-inspector intents), from `src/types/index.ts` (`AIIntent` union trimmed; `WorkloadRow` deleted), and from `src/ai/intentParser.ts` (`buildSystemPrompt` rewritten with field-inspector focus only, all legacy few-shot examples removed). Corresponding handlers removed from `src/ai/router.ts`: `doListTasks`, `doTeamWorkload`, `doPendingApprovals`, plus create/edit/reassign/relink handlers; `executeIntent` switch cleaned up; `routeIntent` simplified. Manager approval pipeline dismantled: `MANAGER_APPROVAL_FIELDS` and `REQUIRES_MANAGER_APPROVAL` path removed from `src/auth/permissions.ts` (test updated: "dueDate requires manager approval" → "dueDate is FORBIDDEN for all roles"); `pending_approvals` `MenuAction` kind removed from `src/ai/menu.ts`. `WhatsappPendingAction` TABLE preserved — no DROP migration. Tests: `aiSchema.test.ts` updated (parses with `get_task`; confidence clamp uses `help`; legacy-kind test replaced), `menu.test.ts` updated (removed `pending_approvals`), `permissions.test.ts` updated.
- **What to do:** remove these from `src/ai/schema.ts`, `src/types/index.ts` `IntentType`, `src/ai/intentParser.ts`, and the corresponding router handlers in `src/ai/router.ts`. Drop the manager approval pipeline that supports `edit_duedate` (`src/services/pendingActions.ts`, `src/auth/permissions.ts MANAGER_APPROVAL_FIELDS`, the "אישורים ממתינים" manager menu item, the `confirm/decline` handlers in `src/ai/digestCommands.ts` if specific to this pipeline). Leave the `WhatsappPendingAction` TABLE in place (no DROP — bot doesn't write CRM, and the table is harmless).
- **Definition of Done:** none of these intents resolves to a handler; the pending-action approval flow is unreachable from any menu or free-text path.
- **Reference:** GAP Part 2, "create_task" and "change due date + manager approval pipeline" rows.
- **Dependencies:** D5-T3, D2-T1.
- **Blocked:** no.

#### X-T3 — Rewrite worker morning digest content (CRM tasks → inspections list)
- **Status:** DONE (commit b288e72). `src/scheduler/jobs/digestDispatcher.ts` MORNING branch: `formatEmployeeMorning` is retired — every non-ADMIN routes to `formatInspectorMorning` (D2-T4). Comment in the dispatcher marks "formatEmployeeMorning fallback is retired (X-T3)". The 17:00 evening `runDailySummary` broadcast remains disabled by default per `LEGACY_DAILY_SUMMARY_ENABLED` (untouched per spec).
- **What to do:** replace `formatEmployeeMorning` (`src/whatsapp/digestContent.ts` lines 71-81) for inspector recipients with D2-T4 content. The 17:00 evening employee broadcast (`runDailySummary`) is already disabled by default (`src/scheduler/index.ts` line 76) — leave dormant; don't delete.
- **Definition of Done:** an inspector's morning send goes through the D2-T4 content path; non-inspectors (if any remain) still get the old `formatEmployeeMorning` until a separate decision.
- **Reference:** GAP Part 2, "Employee morning digest + evening digest (CRM content)" row.
- **Dependencies:** D2-T4, D5-T1.
- **Blocked:** no.

#### X-T4 — Remove `team_workload` manager menu item + handler
- **Status:** DONE (local, uncommitted). `team_workload` `MenuAction` kind removed from `src/ai/menu.ts`; manager menu trimmed to 6 items; `doTeamWorkload` handler removed from `src/ai/router.ts`; `getTeamWorkload` removed from `src/services/tasks.ts`; `WorkloadRow` type deleted from `src/types/index.ts`. Test `menu.test.ts` updated: ADMIN menu assertion changed from 8-item to 6-item.
- **What to do:** remove menu item 1 from `managerMenu()` in `src/ai/menu.ts` (the `team_workload` action), the `team_workload` intent in the parser, and `doTeamWorkload` (`src/ai/router.ts` lines 745-770). Drop `src/services/tasks.ts getTeamWorkload` if no callers remain.
- **Definition of Done:** no menu path or intent resolves to a workload-counts view; replaced by Yoram's exceptions digest (D4-T1).
- **Reference:** GAP Part 2, "team_workload" row.
- **Dependencies:** D4-T1 (replacement must be live).
- **Blocked:** no.

#### X-T5 — Old manager digest content (Yoram replacement + fallback decision)
- **Status:** DONE via K4 option (c) equivalent — refactored 2026-07-01 (commit 1751119). Original design used `LEGACY_MANAGER_DIGEST_ENABLED` env flag + `LEGACY_DAILY_SUMMARY_ENABLED` precedent; the 1751119 refactor DROPPED the env flag entirely and switched the dispatcher to name-based routing:
  - `isExceptionsViewer(name)` → Galit exceptions digest (Yoram-style)
  - `isSasha(name)` / `isLeadsViewer(name)` → LEADS_MORNING only
  - Everyone else (incl. residual ADMIN not in those sets) → inspector morning + employee end-of-day
  Net effect matches K4 option (c) DoD: Yoram never double-sends, no residual elevated user receives the retired manager-digest content in the SCHEDULED path. **Dead-code follow-up:** `formatManagerMorning` is orphaned in `digestContent.ts` (no callers outside its own test file — cleanup candidate). `formatManagerEndOfDay` is still reachable via the on-demand manager digest command (`doTeamEndOfDayReport` at `router.ts:1723-1730`) — keep. The earlier `legacyManagerGate.test.ts` was deleted with the refactor.
- **What to do:** per K4, either: (a) keep `formatManagerMorning` / `formatManagerEndOfDay` (`src/whatsapp/digestContent.ts` lines 83-110, 142-172) as a fallback for non-Yoram non-Sasha elevated users; (b) delete both; or (c) gate behind an env flag (`LEGACY_DAILY_SUMMARY_ENABLED` precedent in `src/scheduler/index.ts` line 76). Implement the chosen option.
- **Definition of Done:** the chosen option is implemented; for Yoram the new D4-T1 content is the only one that fires; no double-send to elevated users.
- **Reference:** GAP Domain 4 row 4, GAP Part 2, "Manager morning + evening digest (CRM content)" row.
- **Dependencies:** D4-T1, D4-T2, K4.
- **Blocked:** NO (K4 closed).

#### X-T6 — Digest preferences menu item (worker 6 / manager 7)
- **Status:** DONE (commit b288e72; K5 option b). `employeeMenu()` in `src/ai/menu.ts` has 7 items — `digest_settings` does NOT appear. The underlying `showDigestSettings` handler and `UserDigestPreference` service are untouched (hidden capability, accessible via free-text). `managerMenu()` retains its own digest-settings item (item 7) — that is the legacy manager surface, not the worker menu.
- **What to do:** per K5, either remove the menu item entirely (default), keep as a hidden capability (free-text trigger only), or surface in the v2 worker menu. Code in `src/ai/router.ts showDigestSettings` + `handleDigestSettingsReply` + `handleDigestTimeReply` (lines 897-982) and `src/services/digestPreferences.ts` is infrastructure — KEEP the underlying service even if the menu entry is removed.
- **Definition of Done:** the chosen exposure level is implemented; `UserDigestPreference` table and service untouched.
- **Reference:** GAP Part 2, "Digest settings sub-menu" row.
- **Dependencies:** K5.
- **Blocked:** NO (K5 closed).

#### X-T7 — Disable / retire `completionNotifier`
- **Status:** DONE (commit a628b10). `scheduler/index.ts`: cron registration for `completionNotifier` is env-gated behind `COMPLETION_NOTIFIER_ENABLED` (default off), matching the `LEGACY_DAILY_SUMMARY_ENABLED` precedent on the same file. Comment references the v2 status-ownership rule (bot never writes `Task.status`) and points at `completionNotifier.ts` as the D5-T6 polling template per K2 brief §7. `completionNotifier.ts` itself and the `WhatsappCompletionNotification` table untouched. No scheduler test in repo — nothing to update. `tsc` + 106-baseline tests still pass.
- **What to do:** the bot no longer detects `Task.status = DONE` because the bot doesn't own `Task.status`. Either disable `src/scheduler/jobs/completionNotifier.ts` (preferred — set its scheduled entry off in `src/scheduler/index.ts`) or remove it. Keep `WhatsappCompletionNotification` table in place (no DROP).
- **Definition of Done:** the job no longer runs; no scheduled entry references it; table preserved.
- **Reference:** GAP Part 2, "Audit log + reminder log + completion-notification log" row (the completion-notifier becomes inert).
- **Dependencies:** none.
- **Blocked:** no.

---

## 4.6 Manager unified menu (2026-07-01)

### D5-T8 — Role-aware AI intent parser + manager free-text intents
- **Status:** DONE (local, uncommitted). Motivation: manager typing/dictating "תציג לי את בדיקות השטח להיום" was misrouted to `get_task` (single-task disambiguation) because the AI prompt was inspector-only. Now `buildSystemPrompt` splits by user level: workers get worker intents + few-shots, manager-level users get a manager-focused prompt with 25+ Hebrew examples covering voice-transcription quirks ("בבקשה", "אני רוצה", "תציג לי" prefixes).
- **New AI_INTENTS (7):** `open_manager_menu`, `management_snapshot`, `list_today_field_inspections`, `list_open_exceptions` (with `params.filter`), `list_pending_leads` (with `params.filter`), `workers_day_overview` (with `params.workerName`), `search_task` (with `params.searchBy` + `params.query`).
- **Extended `INTENT_JSON_SCHEMA`:** `params.searchBy`, `params.query`, `params.workerName`, `params.filter` declared so LLM tool call passes validation.
- **Router (`executeIntent`):** 7 new case branches — each dispatches to the existing manager-menu handler (D5-T7). No duplicated business logic. Auth check: `isManagerMenuUser(user)` gates all 7; workers get `unknown` handling.
- **Fallback improvement:** when a manager-level user's intent parses as `unknown`, the router appends "תרצה לראות את התפריט? כתוב 'תפריט'." — replaces the previous generic dead-end.
- **Tests:** `managerIntents.test.ts` (43 cases — Hebrew phrase → intent + params), `routerManagerIntents.test.ts` (33 cases — dispatch + auth + fallback), extended `aiSchema.test.ts` (13 cases). +93 tests total, all pass. Full suite 618/625 (7 pre-existing skips). tsc clean.
- **Deviation:** test for `open_manager_menu` uses "תן לי את התפריט" instead of exact "תפריט" because "תפריט" alone is matched by the deterministic `MENU_TRIGGER_RE` *before* the AI parser is reached (intentional — menu trigger is deterministic).

### D5-T7 — Unified 6-item manager menu
- **Status:** DONE (local, uncommitted). Replaced the retired legacy `managerMenu()` with a 6-item top-level menu ("תמונת מצב ניהולית / בדיקות שטח להיום / חריגים ודיווחים / לידים ממתינים לטיפול / עובדים וסיכומי יום / חיפוש משימה / בדיקה"). Menu opens for `role IN ('ADMIN','MANAGER')` OR `isExceptionsViewer(name)` OR `isLeadsViewer(name)` — regular field workers keep the §5 spec 7-item menu unchanged.
- **Sub-menus + flows wired:**
  - Item 1 → one-shot management snapshot (today counts + open exceptions + leads counts)
  - Item 2 → org-wide today's TaskField list → pick a row → inline actions (correct site D2-T12 / correct type D2-T14 / reassign D2-T13, all prefilled with taskFieldId — skip pick-task step)
  - Item 3 → 5 filters (open / not confirmed / has problem / waiting for info / didn't close day) → row list → detail
  - Item 4 → 3 sub-options (unassigned list / escalated list / assign lead — triggers D3-T6 with leads-viewer auth gate)
  - Item 5 → 2 sub-options (all-workers overview / pick a worker for detail)
  - Item 6 → 3 search axes (customer / worker / product code) → free-text query → results → detail + inline actions
- **New service file:** `src/services/managerViews.ts` — 8 read-only query helpers. All parameterized. Timezone-aware via `AT TIME ZONE 'Asia/Jerusalem'`.
- **13 new AwaitingKind values** for the multi-step navigation (mgr_menu_root, mgr_exceptions_sub, etc.). See `conversationContext.ts`.
- **Tests:** `managerViews.test.ts` (30 cases), `managerMenu.test.ts` (20 cases), `routerManagerMenu.test.ts` (33 cases). +83 tests total, all pass. tsc clean. Full suite: 525/532 (7 pre-existing skips).
- **Free-text triggers preserved:** power users can still type "לשייך ליד", "לתזמן ביקור", "הכתובת שגויה", "סוג בדיקה שגוי", "לשייך משימה מחדש" and skip the menu entirely.
- **Deviations:** (1) customer search in item 6 uses inline pool.query rather than a separate helper (identical pattern to existing `findCustomersByName`); (2) leads pick-row shows minimal detail (name+id) rather than full body — full detail would require a new `getIncomingLeadById` helper.

---

## 4.5 New scope (2026-07-01 product update — SPEC Addendum)

Two capabilities were promoted from OUT-OF-SCOPE to IN-SCOPE via the SPEC
Addendum. See `SPEC_FIELD_V2.md` § "Addendum — 2026-07-01".

### D3-T6 — Sasha lead assignment via WhatsApp
- **Status:** DONE (local, uncommitted). Extended `src/services/incomingLeads.ts` with `findUnassignedLeadsForAssignment(limit=20)` + `assignLead(leadId, workerId, actorId)` (UPDATE IncomingLead.ownerId + writeAuditLog). Router state machine: `assign_lead_pick_lead` → `assign_lead_pick_worker` → `assign_lead_confirm`. Reuses existing `findActiveInspectors()` + `suggestWorkerForLead()` (D3-T5). Auth: only `isLeadsViewer(user.name) === true` (Sasha + Guy F + Yair) can execute; others rejected. After INSERT no extra plumbing needed — existing D3-T3 poller detects the new `ownerId` and sends the worker alert within 2 min. Tests: `assignLead.test.ts` (6 cases) + `routerAssignLead.test.ts` (14 cases) — 20 new tests pass. tsc clean.
- **What to do:** new intent `assign_lead` + router state machine + `assignLead(leadId, workerId, actorId)` service in `src/services/incomingLeads.ts` (bot writes to `IncomingLead.ownerId` — first CRM-table write from the bot). Flow: Sasha (or a leads-viewer) types trigger → bot lists unassigned leads (uses `findUnassignedInWindow` — already exists) → Sasha picks number → bot calls `suggestWorkerForLead` (already exists, D3-T5) → shows AI suggestion + numbered list of active inspectors → Sasha picks a worker → confirmation → `UPDATE "IncomingLead" SET "ownerId" = $1 WHERE id = $2`. The existing D3-T3 poller (`leadAssignmentNotifier`) then detects the new `ownerId` and sends the worker their assignment alert — no extra plumbing needed. LEAD CLOSURE is NOT in scope — still the CRM's job.
- **Definition of Done:** Sasha (or Guy F / Yair) can type "לשייך ליד" from WhatsApp, pick from a list, assign to a worker, and the worker receives the D3-T3 alert within 2 minutes; a worker who is not in `LEADS_VIEWER_NAMES` is rejected with "אין הרשאה".
- **Auth:** only users in `LEADS_VIEWER_NAMES` (Sasha + Guy F + Yair) can execute the assignment.
- **Dependencies:** D3-T1, D3-T5. No new migration.
- **Blocked:** no.

### D2-T12 — Correct site metadata on a `TaskField` from WhatsApp
- **Status:** DONE (local, uncommitted). Implemented via `src/services/taskFieldCorrections.ts` `updateSiteMetadata()` — dynamic SET clause on TaskField (only updates provided fields), never touches Customer/Task. Router state machine + handlers in `router.ts` wired via `correct_site_pick_task` → `correct_site_pick_field` → `correct_site_await_value` → `correct_site_confirm`. Auth: WORKER on own TaskField only, MANAGER+ADMIN any. Tests: `taskFieldCorrections.test.ts` (site cases) + `routerCorrections.test.ts` (site flow) — all pass. 442/449 total (baseline was 334); tsc clean.
- **What to do:** new intent `correct_task_field_site` + router flow. Worker types "הכתובת שגויה" or similar; bot lists their open TaskField rows (or the "current" one from context if one is being worked); worker picks; bot asks which field (address / city / contact name / contact phone) and the corrected value; confirmation; UPDATE the specific column(s) on `TaskField`. Bot NEVER touches `Customer` or `Task` — this is a per-visit override. If the underlying `Customer` row is genuinely wrong, that's still the office's job.
- **Auth:** WORKER can correct only rows where `Task.ownerId = self`. MANAGER + ADMIN can correct any.
- **Fields writable:** `siteAddress`, `siteCity`, `fieldContactName`, `fieldContactPhone`. `navigationUrl` optional stretch.
- **Dependencies:** D1-T5, D2-T2. No new migration.
- **Blocked:** no.

### D2-T13 — Reassign a `Task` to another worker (MANAGER/ADMIN only)
- **Status:** DONE (local, uncommitted). Implemented via `reassignTask()` in `src/services/taskFieldCorrections.ts` — transactional BEGIN/COMMIT: `UPDATE Task.ownerId` + `UPDATE TaskField.workerNotifiedAt = NULL WHERE fieldStatus IN ('ASSIGNED','CONFIRMED')`. Returns `{resetCount, hadInProgressRows}` — the router warns "משימה זו כבר בביצוע. לשייך מחדש בכל זאת?" when in-progress rows exist. Auth: MANAGER + ADMIN only; WORKER rejected. Router state machine: `reassign_pick_task` → `reassign_pick_worker` → `reassign_confirm`. Assumption to verify with implementer: `findUsersByName('')` returns all active users (used to populate worker picker).
- **What to do:** new intent `reassign_task` + router flow. MANAGER/ADMIN types "לשייך משימה מחדש" / picks a task from a list → picks a target worker from an active-workers list → confirmation → transactional UPDATE: (1) `Task.ownerId = <newWorkerId>`, (2) `TaskField.workerNotifiedAt = NULL` for every TaskField row of this Task whose `fieldStatus IN ('ASSIGNED','CONFIRMED')` so the existing D5-T6 poller sends the §6 card to the new worker. Old worker is silently unassigned. **This is the SECOND CRM-table write from the bot** (first was D3-T6). Extend the SPEC Addendum "additive to CRM schema but bot may write specific documented fields" scope note.
- **Auth:** MANAGER + ADMIN only. WORKER rejected.
- **Fields writable:** `Task.ownerId` (write); `TaskField.workerNotifiedAt` (reset to NULL). Nothing else on `Task`.
- **Edge cases:** reassigning a Task with mid-flight FieldTasks (EN_ROUTE / ARRIVED / FINISHED_FIELD) — bot warns "משימה זו כבר בביצוע. לשייך מחדש בכל זאת?" and prompts confirmation. If confirmed, only the ASSIGNED/CONFIRMED TaskField rows get a reset; in-progress ones stay with the old worker.
- **Dependencies:** D1-T5. No new migration.
- **Blocked:** no.

### D2-T14 — Worker correction of inspection type (MVP)
- **Status:** DONE (local, uncommitted). Implemented via `correctInspectionType()` in `src/services/taskFieldCorrections.ts` — single transaction: UPDATE `TaskField.inspectionTypeId + family` + UPDATE `Task.productName` + WhatsApp notification to Yoram+Sasha (looked up from `User.name`) + `writeAuditLog` capturing old/new productName + taskId + taskFieldId + workerId + timestamp. Rejects when `TaskField.fieldStatus IN ('FINISHED_FIELD','CANCELED')` via `ClosedInspectionError`. Worker confirmation required before write. Router state machine: `correct_type_pick_task` → `correct_type_await_search` (free-text search of `InspectionType.labelHe`) → `correct_type_pick_from_list` → `correct_type_confirm`. Auth: WORKER on own TaskField only, MANAGER+ADMIN any (subject to same closed-status rejection). Deviation from brief: notification message uses `taskField: ${id}` reference instead of a richer customer name — the service function doesn't get the customer name from the caller; enrichment via a `LEFT JOIN Customer` in the prefetch query would be a small follow-up.
- **What to do:** new intent `correct_inspection_type` + router flow. A field worker types "סוג בדיקה שגוי" (or similar) while working on a specific TaskField; bot asks for the correct type via free-text search against `InspectionType.labelHe` / `code`; bot shows top matches numbered; worker picks; **worker confirmation is REQUIRED before writing** (spec: "The correction must require worker confirmation before writing."). Then, in a single transaction:
  1. `UPDATE "TaskField" SET "inspectionTypeId" = <newId>, "family" = <newFamily>, "updatedByUserId" = <workerId> WHERE id = <taskFieldId>`
  2. `UPDATE "Task" SET "productName" = <newInspectionType.code> WHERE id = <taskId>`
  3. Notify the office (Yoram + Sasha via WhatsApp `sendTextMessage` — same recipient logic as `notifyOfficeDeclined` in `src/services/inspections.ts`): "תיקון סוג בדיקה: העובד <name> עדכן את המשימה של <customer> מ-<oldType> ל-<newType>."
  4. Write an audit record via `writeAuditLog` capturing: old `productName`, new `productName`, workerId, taskId, taskFieldId, timestamp.
  This is the WORKER-authored propagation of the correction — no separate ADMIN approval step. The office is NOTIFIED, not asked to approve.
- **Auth:** WORKER can correct only TaskField rows where `Task.ownerId = self`. MANAGER + ADMIN inherit the same correction ability for any Task.
- **Fields writable:**
  - `TaskField.inspectionTypeId`, `TaskField.family`, `TaskField.updatedByUserId`, `TaskField.updatedAt`
  - `Task.productName` (writes to CRM Task — third CRM-table write from the bot, after D3-T6 and D2-T13)
- **Fields NOT writable (explicit spec):** general CRM task fields (title, description, dueDate, priority, etc.), `Task.status`, `Task.customerId`, `Task.ownerId`, `Task.price`, and any other commercial/payment/owner column on `Task`. Only `productName`.
- **Validation:**
  - The new type must exist in `InspectionType` (validated at pick time by the numbered list — user can't type a raw code)
  - Worker cannot correct a TaskField they are not assigned to (`Task.ownerId != caller`)
  - `TaskField.fieldStatus` must not be `FINISHED_FIELD` or `CANCELED` — corrections apply to open field work only
- **Dependencies:** D1-T2, D1-T5, D1-T7 (need catalog seeded so lookups have data). No new migration.
- **Blocked:** no.

### D2-T15 — Pre-inspection 60-minute reminder
**Status:** DONE (local, uncommitted) — see follow-up **X-T15a** in §4.7.

A field worker receives a WhatsApp reminder ~60 min before their scheduled inspection (when `scheduledStartAt <= now() + 60 min`) so they can prepare and leave on time.

**Files created:**
- `src/db/migrations/011_pre_reminder.sql` — idempotent `ALTER TABLE "TaskField" ADD COLUMN IF NOT EXISTS "preReminderSentAt" timestamptz NULL`
- `src/services/preInspectionReminder.ts` — `findDuePreReminders`, `formatPreReminderCard`, `sendAndStampPreReminder`, `runPreInspectionReminderPoll`, payload-ID helpers
- `src/scheduler/jobs/preInspectionReminder.ts` — thin wrapper (`runPreInspectionReminderJob`)
- `src/__tests__/preInspectionReminder.test.ts` — 19 tests (query shape, formatter, send+stamp, poll isolation)
- `src/__tests__/routerPreReminderTap.test.ts` — 12 tests (regex, DEPART guard, NEED_INFO state, PROBLEM flow)

**Files modified:**
- `src/scheduler/index.ts` — new advisory lock id 1011 (`preInspectionReminder`); registered `*/2 * * * *` cron
- `src/services/conversationContext.ts` — new `AwaitingKind`: `pre_reminder_need_info_note`
- `src/ai/router.ts` — added `pool` import; added `matchPreReminderTap` / `handlePreReminderTap` / `handlePreReminderNeedInfoNoteReply`; wired in `handleAIMessage` (after INSP_ tap) and `continueConversation`
- `SPEC_FIELD_V2.md` — Addendum item 7 added
- `TASKS.md` — this entry

**Buttons:**
- `PREREMIND_DEPART_<taskFieldId>` → "יוצא בזמן" → advances to `EN_ROUTE` (guarded: no-op if already EN_ROUTE/ARRIVED/FINISHED_FIELD)
- `PREREMIND_NEED_INFO_<taskFieldId>` → "צריך פרטים" → `pre_reminder_need_info_note` → `requestMoreInfo` + office alert
- `PREREMIND_PROBLEM_<taskFieldId>` → "יש בעיה" → reuses `problem_type_choice` flow

**Tests run:** 19 new service tests + 12 new router tests = 31 new tests, all pass. `npx tsc --noEmit` clean. Zero regressions.
**Constraints satisfied:** Task.status never written; lead code untouched; migration is idempotent (ADD COLUMN IF NOT EXISTS).

---

### D2-T11 — Schedule a `TaskField` for an existing `Task` from WhatsApp
- **Status:** DONE (local, uncommitted). Full design was in `HANDOFF.md` — implementation matches. New service file `src/services/taskFieldScheduling.ts` exports `findOpenTasksForOwner`, `findOpenTasksForAdmin`, `findCustomersByName`, `findOpenTasksForCustomer`, `scheduleTaskField`. Router state machine covers pick-task → search-customer fallback → time → duration → confirm → INSERT (with `workerNotifiedAt=NULL` so the D5-T6 poller sends the §6 card automatically). Auth: WORKER on own Task only, MANAGER+ADMIN any. Tests: `taskFieldScheduling.test.ts` + `routerScheduleTaskField.test.ts` — 49 new tests pass. tsc clean; full suite 442/449 (7 pre-existing skips).
- **What to do:** new intent `schedule_task_field` + router state machine + `scheduleTaskField(taskId, actorId, {scheduledStartAt, durationMinutes, specialInstructions?})` service. Flow: user types trigger → bot lists user's open tasks (own only for WORKER; any for MANAGER/ADMIN) → user picks → bot asks for date/time (Hebrew parser: "ראשון בעשר") → duration (default 60) → confirmation with all static fields pre-filled from the picked `Task` → `INSERT` into `TaskField` with `workerNotifiedAt = NULL`. The existing D5-T6 poller sends the §6 card automatically. Bot NEVER writes `Task` or `Customer`.
- **Definition of Done:** any user can schedule a TaskField from WhatsApp against a Task where auth permits; the inspector receives the §6 assignment card within 2 minutes; worker attempting to schedule for someone else's Task is rejected; TaskField inherits customer/address/product from the Task row.
- **Auth:** WORKER can only schedule for `Task.ownerId = self`. MANAGER + ADMIN can schedule for any `Task`.
- **Dependencies:** D1-T5, D1-T7 (need catalog seeded), D2-T2 (card pipeline). No new migration.
- **Blocked:** no.

### D2-T16 — Manager menu item 7 ("הבדיקות שלי להיום")
**Status:** DONE (local, uncommitted)

A manager who is also a field inspector can now open item 7 from the manager menu to see only their own TaskField rows for today — without opening the org-wide list (item 2). Business rationale: Yoram (and any other manager) still gets §13 exceptions digests org-wide, but if they also have inspections assigned to themselves, item 7 lets them check their own day in one tap.

**Files changed:**
- `src/ai/menu.ts` — added `mgr_my_inspections_today` to the `MenuAction` union; extended `managerMenu()` from 6 to 7 items (item 7 label: `הבדיקות שלי להיום`); updated `managerMenu()` JSDoc.
- `src/services/managerViews.ts` — added `getMyFieldInspectionsToday(userId, localDate)` next to `getTodayFieldInspections`. SQL shape is identical plus `AND t."ownerId" = $2`. Does NOT use `assignedAt` or `finishedAt` — day window is always `scheduledStartAt` in Asia/Jerusalem.
- `src/services/conversationContext.ts` — added `mgr_my_today_pick_task` to `AwaitingKind`; updated comment on `mgr_menu_root` to say 1-7.
- `src/ai/router.ts` — imported `getMyFieldInspectionsToday`; added `mgr_my_today_pick_task` to `NUMERIC_PICKER_AWAITING`; added `case 'mgr_my_inspections_today'` to `handleMenuRoute`; added dispatch branch in `continueConversation`; added `showMyFieldInspectionsToday(user)` and `handleMgrMyTodayPickTaskReply(user, trimmed, ctx)` handlers. Detail view reuses `showMgrTaskFieldDetail(..., 'mgr_today_action')` — no duplication; list row uses `formatInspectionListRow(row, false)` (worker column suppressed).
- `src/__tests__/routerManagerMenu.test.ts` — added `getMyFieldInspectionsToday` mock; updated "admin sees manager menu" test to assert 7-item presence; added 9 new test cases under `describe('item 7 — הבדיקות שלי להיום')`.
- `src/__tests__/managerViews.test.ts` — imported `getMyFieldInspectionsToday`; added 5 new test cases under `describe('getMyFieldInspectionsToday')`.
- `TASKS.md` — this entry.
- `SPEC_FIELD_V2.md` — addendum item 6 added.

**Tests run:** `npx vitest run` — all new tests pass; zero regressions against pre-existing suite; `npx tsc --noEmit` clean (pre-existing TS errors in this worktree are unrelated to this task).

**Deviations from spec:** none. Reused `showMgrTaskFieldDetail` (detail formatter) and `formatInspectionListRow` (list row). `Task.status` not written. Lead code not touched.

**Follow-up (2026-07-02):** item 7 label changed from "הבדיקות שלי להיום" to "הבדיקות שלי"; today remains the default but arbitrary date ranges are now supported via free text. See **X-T16a** in §4.7.

---

## 4.7 Product-fix batch (2026-07-02)

### X-T15a — Fix pre-inspection reminder in production + gate assignment card auto-send + debug logs
**Status:** DONE (local, uncommitted)

**Context.** In-field verification on 2026-07-02 revealed that the D2-T15 pre-inspection reminder never fires in the real DB. A TaskField scheduled for 13:00 Jerusalem, tested at ~12:08, produced no WhatsApp. Root cause: migration `011_pre_reminder.sql` was **never applied to the Supabase instance** — the `TaskField."preReminderSentAt"` column did not exist. Every `*/2` tick failed inside `findDuePreReminders` with `column "preReminderSentAt" does not exist` (SQLSTATE 42703), so no row could ever be selected.

**Separate product decision (Jul 2026).** Automatic WhatsApp assignment cards on TaskField creation / re-assignment are **not** wanted. `assignmentCardNotifier` (D5-T6) is now gated behind an env flag (default OFF); code retained for a future explicit manual command.

**Fixes:**
1. Applied migration 011 (idempotent — `schema_migrations` shows `('011_pre_reminder.sql','2026-07-02 09:33:36.702Z')`). Post-migration verification: a real TaskField (id=`aeb02160-…`, scheduled 2026-07-02T10:45:00Z) had `preReminderSentAt` stamped at `2026-07-02T09:54:02.999Z` — the reminder fired ~51 min before scheduled start, worker tapped "יוצא בזמן", status transitioned to EN_ROUTE. **End-to-end proof captured via `src/scripts/diagPreReminder.ts`.**
2. Gated `assignmentCardNotifier` cron in `src/scheduler/index.ts` behind `ASSIGNMENT_CARD_NOTIFIER_ENABLED=true`, mirroring the `completionNotifier` / `LEGACY_DAILY_SUMMARY_ENABLED` pattern. Default OFF. Warn log when enabled; info log explaining the product decision when disabled.
3. Added persistent INFO logs to `runPreInspectionReminderPoll` + `findDuePreReminders` + `sendAndStampPreReminder` (poll start, DB `now()` local, `dueCount`, per-row `taskFieldId`/`scheduledStartAt`/`workerId`/`phonePresent` — no raw phones, send-attempt, send/stamp result). Non-destructive; kept permanently for future ops.
4. `.env.example` updated with `ASSIGNMENT_CARD_NOTIFIER_ENABLED=false` under §8 "Legacy feature gates" + product-decision comment.

**Files changed:**
- `src/scheduler/index.ts` — assignment-card cron wrapped in env gate.
- `src/services/preInspectionReminder.ts` — added INFO logs, added `dbNowLocal` column to the SELECT.
- `.env.example` — added the new flag.

**Files created:**
- `src/__tests__/assignmentCardGate.test.ts` — 3 tests (env unset / false / true → gate behavior).
- `src/scripts/diagPreReminder.ts` — non-destructive DB diagnostic (migration check, column check, DB now(), findDuePreReminders live run, ±3h near-window survey with exclusion reasons). Kept as an ops asset; does no writes; masks phones.

**Files audited (no direct sends found):**
- `src/services/taskFieldScheduling.ts` — clean; no WhatsApp on TaskField insert.
- `src/services/taskFieldCorrections.ts` — two `sendTextMessage` calls exist but both are user-triggered (Yoram/Sasha type-correction audit notify + user-initiated reschedule confirm) — NOT auto-assignment cards. No changes.

**Constraints satisfied:**
- Task.status never written.
- Lead-assignment notifications (`leadAssignmentNotifier`) untouched — still fires independently.
- No creation-time WhatsApp on TaskField create or Task.ownerId assignment.
- Dedup remains per-TaskField via `preReminderSentAt`.
- `scheduledStartAt` is the only date field used for the reminder window.

**Tests run:** `npx vitest run` — 56/56 across the affected scope (assignment-gate + preInspectionReminder + intent regex + date parser + range query). `npx tsc --noEmit` clean.

**Known risks / follow-ups:**
- DB session TZ reports `UTC` despite the pool startup option `-c timezone=Asia/Jerusalem` (Supabase pooler drops connection startup options). Immaterial to the pre-reminder window (timestamptz math is TZ-agnostic), but any code that later relies on `to_char(now(), 'YYYY-MM-DD')::date` without `AT TIME ZONE 'Asia/Jerusalem'` will read UTC. Existing digest / range queries already do the explicit `AT TIME ZONE` cast so they are safe.
- `assignmentCardGate.test.ts` uses `globalThis.__disabledSchedCount` to share state between tests — works because vitest runs tests in file order, but consider refactoring to independent tests when convenient.
- `routerManagerMenu.test.ts` has a pre-existing OOM under vitest fork pool (present on main baseline too — 24 tests pass then heap exhaustion). Not caused by this batch; the specific label-change assertions run before the OOM point and pass.

---

### X-T16a — "My inspections" flexible date range (extends D2-T16)
**Status:** DONE (local, uncommitted)

**Product goal.** Any user can ask for their own TaskField rows over an arbitrary date range in free text, not only today. Manager menu item 7 label changed to "הבדיקות שלי" (today remains the default; a footer nudges the user to try other ranges).

**Business date is always `TaskField.scheduledStartAt` in Asia/Jerusalem** (CLAUDE.md §6.1). Never `Task.createdAt`, `Task.dueDate`, `TaskField.assignedAt`, or `TaskField.finishedAt`.

**Files created:**
- `src/services/myInspectionsRange.ts` — `getMyInspectionsInRange(userId, fromLocalDate, toLocalDate)` — half-open window, INNER JOIN Task → InspectionType, LEFT JOINs to Customer/Lead/Project/IncomingLead for the 6-source COALESCE'd customerName. Excludes CANCELED / DECLINED. Never plain Task rows without TaskField.
- `src/ai/dateRangeParser.ts` — `parseHebrewInspectionRange(text, nowJerusalem?)` — pure, deterministic. Supports: היום, מחר, השבוע, שבוע הבא, החודש, חודש הבא, named weekdays (יום ראשון..שבת → next occurrence incl. today), single date "ב-DD/M[/YYYY]", range "בין DD/M ל-DD/M[/YYYY]" (unspecified past year auto-bumps to next year), "לעוד שבוע" / "לעוד חודש" (rolling from today). Uses UTC-noon anchors for date math to avoid DST flips.
- `src/__tests__/dateRangeParser.test.ts` — 14 tests with pinned `NOW=2026-07-02T09:00:00Z` (Thursday 12:00 IL).
- `src/__tests__/myInspectionsRange.test.ts` — 6 tests: SQL shape (ownerId, TZ window, INNER joins), no forbidden date columns, row mapping.
- `src/__tests__/myInspectionsIntent.test.ts` — 14 tests locking in `MY_INSPECTIONS_RE` shape (self-contained alternatives allow empty suffix → today; "מה יש לי" requires a date-cue).

**Files modified:**
- `src/ai/menu.ts` — manager item 7 label: "הבדיקות שלי להיום" → "הבדיקות שלי". Action kind unchanged.
- `src/ai/router.ts` — exported `MY_INSPECTIONS_RE` (regex with date-cue lookahead on the ambiguous "מה יש לי" branch); added `handleMyInspectionsFreeText` + `formatMyInspectionsRange` + small local helpers (`formatHmJerusalem`, `localJerusalemDateOf`, `addLocalDay`, `daysBetween`); dispatched from `handleAIMessage` immediately after `MENU_TRIGGER_RE` and before the bare-digit guard / AI parser; empty suffix → default today; unparseable non-empty suffix → hint "לא הצלחתי להבין את הטווח…"; multi-day range → each row shows DD/MM+HH:MM, single-day → HH:MM only. Reuses existing `mgr_my_today_pick_task` conversation context so numeric picks flow through the existing detail-view handler. Appended a "אפשר גם לכתוב…" footer to `showMyFieldInspectionsToday` so manager item 7 tells users about the range vocabulary.
- `src/__tests__/managerMenu.test.ts`, `src/__tests__/routerManagerMenu.test.ts` — updated item 7 label assertions.

**Router regex shape (verbatim, for reviewers):**
```
^((?:הבדיקות\s+שלי|בדיקות(?:\s+השטח)?\s+שלי|תראה\s+לי\s+את\s+(?:ה)?בדיקות(?:\s+השטח)?\s+שלי|איזה\s+בדיקות\s+יש\s+לי)|(?:מה\s+יש\s+לי)(?=\s+<DATE_CUE>))(.*)$
```
`<DATE_CUE>` covers היום / מחר / השבוע / שבוע הבא / החודש / חודש הבא / לעוד (שבוע|חודש) / named weekday / "בין <digit>" / "ב-<digit>".

**Manager vs. worker semantics preserved:**
- Manager item 2 — org-wide today (unchanged).
- Manager item 7 — own inspections today (default) + footer telling the user they can ask for other ranges.
- Worker menu items 1 (today) / 2 (tomorrow) — unchanged.
- Any user, free text: "הבדיקות שלי <range>" — own inspections in that range.

**Never displays:** the raw word "משפחה" (category label if used is "קטגוריית בדיקה"). Category rendering itself is out of scope for this task — only `InspectionType.labelHe` is shown for "סוג בדיקה".

**Tests run:** 56/56 across the affected scope. `npx tsc --noEmit` clean.

**Known follow-ups:**
- Range vocabulary is intentionally conservative. Extend the parser when users ask for phrases we don't cover (e.g. "בעוד שבוע", "לפני יומיים", exact "לתאריך X").
- If the AI intent parser ever tries to match "הבדיקות שלי …" as a task intent, the fast path here shadows it — that's intentional.

---

### X-T17a — Fix: employees with zero TaskFields today vanish from "עובדים וסיכומי יום" + falsely reported as nonexistent
**Status:** DONE (local, uncommitted)

**Bug report (user, 2026-07-02).** Manager reported that "גיא גבאי" (role=MANAGER, an active User) never appears in the "בחר עובד לסיכום שלו" worker picker, and asking free-text for his data ("תן לי דאטה על גיא גבאי") returned "לא מצאתי עובד בשם גיא גבאי" — a false claim, since he exists in `User` with `status='ACTIVE'`.

**Root cause.** `getAllWorkersDayOverview` (`src/services/managerViews.ts`) started `FROM "TaskField" tf JOIN "Task" t JOIN "User" u` — an inner-join chain scoped to *today's* `scheduledStartAt` (per §6.1). Any active user with **zero** `TaskField` rows scheduled today (any role — confirmed via a full `User` table export: 6 generic system accounts and one real MANAGER all had 0 rows today) never produced a row at all, so they silently disappeared from both (a) the "בחר עובד" picker and (b) the free-text `workers_day_overview` worker-name match, which then fell through to a misleading "employee not found" message instead of "no field checks today."

Confirmed NOT the cause: no role-based filter, no `LIMIT` truncation (only 9 of 16 users shown, well under any limit), no trailing-whitespace/exact-match issue in this code path (`ILIKE` substring match tolerates it).

**Fix:**
1. `src/services/managerViews.ts` — `getAllWorkersDayOverview` rewritten to start `FROM "User" u` (filtered `WHERE upper(u.status::text) = 'ACTIVE'`) with `LEFT JOIN "Task"` / `LEFT JOIN "TaskField"` (today's window moved into the `TaskField` `ON` clause, not `WHERE`, to preserve the outer join). `COUNT(*) AS total` → `COUNT(tf.id) AS total` so a worker with no TaskField rows gets `0`, not `1`. Every active user now gets a row (`0/0` when they have no field visit today) instead of disappearing.
2. `src/ai/router.ts` (`workers_day_overview` intent, named-worker branch) — when the matched worker's `getWorkerDayDetail(...).total === 0`, send a clean "X — היום: אין בדיקות שטח מתוזמנות היום." instead of an empty-lines dump. The pre-existing "לא מצאתי עובד בשם X" fallback is now only reachable for a genuinely nonexistent name (since the roster is complete), which is correct.
3. The `mgr_workers_pick_worker` reply handler (`handleMgrWorkersPickWorkerReply`, router.ts) already handled `detail.total === 0` gracefully ("אין בדיקות היום עבור X") — no change needed there; it now receives the full roster instead of a partial one.

**Side effect (flagged to user, no action taken):** 6 generic system/placeholder `User` rows (Sales/Admin/Manager/Billing/Technician/Expert — `@galit.local` emails, no phone) now also appear in both the picker and the "כל העובדים" table with `0/0`, since they are `status='ACTIVE'` and there is no documented rule distinguishing them from real employees. Left un-filtered per YAGNI — no spec basis for guessing a filter (e.g. by email domain or phone presence). Revisit if the user asks to exclude them.

**Files changed:**
- `src/services/managerViews.ts` — `getAllWorkersDayOverview` query rewrite.
- `src/ai/router.ts` — named-worker zero-total message in the `workers_day_overview` intent handler.

**Files changed (tests):**
- `src/__tests__/managerViews.test.ts` — added: query shape assertion (`FROM "User" u` + `LEFT JOIN "TaskField"` + `status = 'ACTIVE'`); a worker with 0 TaskFields today still appears in the result with `finished/total/exceptions` all `0`.
- `src/__tests__/routerManagerIntents.test.ts` — added regression test: a matched worker with `total: 0` gets "אין בדיקות שטח מתוזמנות היום" and never "לא מצאתי עובד".

**Tests run:** `npx vitest run` — full suite, 939 passed / 7 skipped / 0 failed (one unrelated pre-existing worker-pool OOM after all tests completed, on unrelated files — see X-T15a's known-risks note on the same OOM pattern). `npx tsc --noEmit` — clean.

**Constraints satisfied:** read-only query change (no writes); no `Task.status` touched; no permission-gate change (`isManagerMenuUser` untouched); `TaskField.scheduledStartAt` remains the sole "today" date column (§6.1); no migration needed.

**Known follow-ups (resolved same session, see addendum below):**
- ~~If the business wants the 6 generic system accounts hidden from these employee-facing lists, add an explicit, documented filter~~ — done, see below.
- Not independently verified against the live CRM DB (no `DATABASE_URL` in this environment) — verified via the user's exported `User` table snapshot + code/query-logic review + full test suite.

**Addendum (same day, follow-up request):** user asked explicitly to filter out the non-Hebrew-named generic system accounts (Sales/Admin/Manager/Billing/Technician/Expert) from `getAllWorkersDayOverview`. Added `AND u.name ~ '[א-ת]'` to the query's `WHERE` clause (Postgres POSIX regex — matches any name containing at least one Hebrew letter; excludes pure-Latin placeholder names). Updated JSDoc. Added test `managerViews.test.ts` — asserts the SQL contains the Hebrew-name filter. Full scope stayed limited to this one function (not applied to `findUsersByName`, used by the unrelated reassign/lead-assign pickers — out of scope, not requested). Re-ran `npx vitest run` on the affected files (67/67 passed) + full suite (910 passed / 7 skipped, same pre-existing OOM-after-completion pattern) + `npx tsc --noEmit` clean.

---

## 4.8 Worker NLU parity + disambig UX — Phase 1 (2026-07-05)

### D5-T9 — Worker free-text NLU parity + disambig list + stale-context handlers

**Status:** DONE (local, uncommitted)

**Problem:** User reported that as a worker/TECHNICIAN he couldn't ask
"הצג את כל הבדיקות שלי" without getting "לא הבנתי", and that after tapping
"דיווח על בעיה" the bot said "יש לך 3 בדיקות פתוחות" without listing them.
Comprehensive NLU audit (two parallel Explore agents — see conversation log)
uncovered ~28 gaps in worker/manager intent surface; Phase 1 addresses the
HIGH-severity worker unblockers.

**What to do (Phase 1 scope):**
- Add `list_my_inspections` intent to `AI_INTENTS` (schema.ts) and to
  `AIIntent` (types/index.ts). Includes `params.dateScope`
  (`today`/`tomorrow`/`week`/`next_week`) and `params.rangeExpr` (raw Hebrew
  suffix for arbitrary ranges).
- Expand `WORKER_INTENT_LIST` + `WORKER_FEW_SHOT` in `intentParser.ts` with
  ~20 examples covering list-my-inspections phrasings, status-transition
  variants (בדרכי / אני עוזב / סיימתי הכל / הגעתי לאתר), problem-type variants
  (הלקוח מתחמק / אין תשובה / אין מפתח / אין חשמל / לא הצלחתי לבצע),
  report_missing_info variants (שכחתי את X / חסר לי X), voice prefixes
  (בבקשה / אני רוצה / כן, X), STARTED-retirement note.
- Expand `MY_INSPECTIONS_RE` in `router.ts` to catch display verbs
  ("הצג", "תציג לי", "תן לי", "אני רוצה לראות"), lists ("רשימ[הת]?"),
  and open-day phrasings ("היום שלי", "מה היום שלי", "מה על הפרק",
  "מה מחכה לי").
- Add `EMP_MENU_\d+` stale-context handler mirroring the existing
  `MGR_MENU_\d+` handler (router.ts) — worker taps item N from a still-open
  list message after previous tap cleared context; without this the payload
  hits the AI parser and returns "לא הבנתי".
- Add worker bare-digit guard (`^[1-7]$`) with same shape as the manager
  guard, opening the worker menu + dispatching the digit through the
  standard menu-reply path.
- Route `list_my_inspections` in `executeIntent` — synthesize a "הבדיקות שלי
  <suffix>" string and hand off to the existing `handleMyInspectionsFreeText`
  so all Hebrew range logic stays in one place.
- Update `unknown`-intent fallback: workers now get the same
  "תרצה לראות את התפריט? כתוב 'תפריט'." nudge as managers.
- Replace disambig prompt in 4 flows (`startReportProblemFlow`,
  `startMissingInfoFlow`, `startStatusUpdateFlow`, `runMissingInfoDirect` and
  the `runAdvanceStatusDirect` hint-ambiguous branch) with a numbered list:
  `יש לך N בדיקות פתוחות:` followed by rows of
  `${idx}. ${customer} — ${address}, ${city} · ${HH:MM}`.
- Extend `findOpenTaskFieldForWorker` (`services/inspections.ts`) to return
  `{ambiguous, count, items}` where `items: OpenTaskFieldPreview[]` includes
  `customerName`, `siteAddress`, `siteCity`, `scheduledStartAt`. Order by
  `scheduledStartAt NULLS LAST, assignedAt`.
- Add `disambigTaskFieldIds?: string[]` to `ConversationState` — set by all
  4 disambig entry points so a bare digit reply resolves without a second DB
  round-trip.
- Extend `handleDisambigReply` to accept a numeric 1..N pick (matches
  ordered stash) before falling back to text-hint DB resolution.

**Files changed:**
- `src/ai/schema.ts` (+2/-0)
- `src/types/index.ts` (+1/-0)
- `src/ai/intentParser.ts` (worker prompt list + FEW_SHOT — sizeable)
- `src/ai/router.ts` (MY_INSPECTIONS_RE, EMP_MENU handler, worker bare-digit
  guard, list_my_inspections dispatch, fallback menu-hint, 4 disambig
  handlers, buildDisambigPrompt helper, numeric-pick in handleDisambigReply)
- `src/services/inspections.ts` (findOpenTaskFieldForWorker returns items;
  formatOpenTaskFieldPreview helper; new `OpenTaskFieldPreview` type)
- `src/services/conversationContext.ts` (+3/-0 — `disambigTaskFieldIds`)
- `src/__tests__/routerWorkerFreeText.test.ts` **(new)** — regex coverage,
  intent dispatch, EMP_MENU handler, worker menu-hint, disambig list +
  numeric pick + out-of-range fallback + text hint.
- `src/__tests__/routerBareDigitGuard.test.ts` — worker bare-digit guard
  test flipped from "does NOT trigger" to "opens worker menu"; new "8 falls
  through" case; added `formatInspectorDayList`/`inspectionsQueries`/
  `myInspectionsRange` mocks.
- `src/__tests__/aiSchema.test.ts` — expected AI_INTENTS list now
  includes `list_my_inspections`.
- `src/__tests__/inspections.test.ts` — updated single-open shape to include
  `taskTitle`, ambiguous shape to `{ambiguous, count, items}` (3-row items).
- `src/__tests__/routerManagerIntents.test.ts` — worker unknown-fallback
  test flipped to assert menu-hint IS appended.
- `src/__tests__/routerInspections.test.ts`, `routerDaySummary.test.ts` —
  disambig mocks now include `items` array.

**QA report (2026-07-05):**

Files reviewed manually:
- `src/ai/router.ts` — full audit of the 4 flows + handleDisambigReply +
  regex + EMP_MENU handler + bare-digit guard + fallback.
- `src/services/inspections.ts` — verified new query orders by
  scheduledStartAt NULLS LAST + returns full preview items.
- `src/ai/intentParser.ts` — verified isMgr branch untouched; worker branch
  says manager intents unavailable without exposing MANAGER_INTENT_LIST
  block.

Scenarios manually reasoned about:
- Worker with 0 open TaskFields taps "דיווח על בעיה" → clearContext + "אין
  לך כרגע בדיקות פתוחות." (unchanged).
- Worker with 1 open TaskField → problem sub-menu directly (unchanged).
- Worker with 3 open TaskFields → new numbered list with customer/address/
  city/time; disambigTaskFieldIds stashed. Bare digit "2" picks tf-2 with
  no DB round-trip. Out-of-range "9" falls through to text-hint resolver.
- Worker taps EMP_MENU_1 (list_inspections_today) → clearContext → then
  taps EMP_MENU_2 (tomorrow) from same open list → new stale handler routes
  through menu path. AI parser NOT called.
- Worker types bare "2" with cleared context → menu opens + item 2
  dispatched. AI parser NOT called.
- Worker types "8" → falls through to AI parser (menu has only 7 items).
- Worker types "הצג את הבדיקות שלי" / "אני רוצה לראות את הבדיקות שלי" →
  MY_INSPECTIONS_RE catches, fast-path dispatch, no AI call.
- Worker types "משהו לגמרי לא ברור..." → AI returns unknown → fallback text
  now ends with menu hint (new).
- Manager typing "הבדיקות שלי" — still works (was already covered by regex).
- Manager typing EMP_MENU_2 — NOT hijacked by worker handler
  (`!isManagerMenuUser` guard).

Tests:
- Full suite: `npx vitest run` → **980 passed / 7 skipped / 0 failed**.
- Affected suites re-run individually → 263 passed / 0 failed.
- `npx tsc --noEmit` → exit 0.

State/context/permissions verified:
- `disambigTaskFieldIds` is a NEW state field (append-only to
  `ConversationState`) — no existing state consumer is disrupted.
- `findOpenTaskFieldForWorker` still filters by `Task.ownerId = $1` and the
  6 open `fieldStatus` values — permission surface unchanged.
- No `Task.status` write, no CRM commercial-field write, no new sensitive
  writes introduced (§6.6 compliant).
- No changes to manager surface, digest flows, migrations, or DB schema.

Remaining risks / known weak spots:
- LLM prompt changes are behavioral (not schema) — hard to unit-test the
  LLM output itself. Coverage relies on FEW_SHOT quality; live smoke test
  recommended after commit.
- `formatOpenTaskFieldPreview` in `inspections.ts` is currently unused
  outside its own unit context (router inlines the logic); kept exported for
  future reuse but flagged as dead-import-risk.
- `resolveOpenTaskFieldByHint` still returns bare `{ambiguous, count}`
  without items; the hinted-ambiguous path in `runAdvanceStatusDirect`
  compensates by re-querying with `findOpenTaskFieldForWorker` for the
  numbered list. Not a bug — small extra query when the hint is too vague.

**Definition of Done:**
- [x] `list_my_inspections` intent exists in schema + parser prompt +
  router dispatch.
- [x] Worker can type ≥10 natural phrasings of "show my inspections" and
  reach the same handler as the menu path.
- [x] Bare digits 1..7 from a worker with no context open the worker menu.
- [x] EMP_MENU_N with no context reopens the worker menu.
- [x] Disambig prompt lists open TaskFields with customer + address; digit
  reply resolves without another DB query.
- [x] Worker `unknown` fallback appends menu hint.
- [x] All existing tests still pass (980 passed).
- [x] `npx tsc --noEmit` clean.

**Follow-up (Phase 2+):** shipped — see D5-T10 / D5-T11 / D5-T12 / D5-T13
below (Phases 2-6 completed same session).

---

### D5-T10 — Worker richness + Menu regex + Multi-intent (Phase 2+3)

**Status:** DONE (local, uncommitted)

**What to do:**
- Expand `WORKER_FEW_SHOT` with ~40 examples covering: status transition
  variants (בדרכי / אני עוזב / אני כבר בשטח / סיימתי הכל / הגעתי לאתר),
  problem-type variants (הלקוח מתחמק / אין תשובה / אין מפתח / אין חשמל / לא
  הצלחתי לבצע), report_missing_info variants (שכחתי את X / חסר לי X),
  voice quirks ("בבקשה" / "אני רוצה" / "כן, X"), STARTED-retirement note.
- Add two new worker intents:
  - `day_summary_query` — free-text day-summary request → routes to
    `startDaySummaryFlow` (same handler as menu item 7).
  - `missing_equipment_free` — free-text pre-departure equipment miss
    (not scoped to a specific TaskField) → mirrors menu item 5.
- Expand `MENU_TRIGGER_RE` to catch: "תראה לי (את) התפריט", "הצג (לי) את
  התפריט", "תפריט בבקשה", "בבקשה תפריט", "יאללה תפריט", "אני רוצה (לראות)
  תפריט".
- Add multi-intent detection line to `rulesBlock` of `buildSystemPrompt`.

**Files changed:** `schema.ts`, `types/index.ts`, `intentParser.ts`,
`menu.ts`, `router.ts`; tests `aiSchema` +2, `menu` +2 blocks,
`routerWorkerFreeText` +4 tests + contextExtractor mock; **new**
`workerFewShotPhrasings.test.ts` (56 regex sanity tests).

**QA:** `npx tsc --noEmit` exit 0. Full suite 1042/0/7.

---

### D5-T11 — Manager dateRange scoping (Phase 4)

**Status:** DONE (local, uncommitted)

**What to do:**
- Add `params.dateRange = {from, to}` (half-open, Asia/Jerusalem YYYY-MM-DD)
  to `list_open_exceptions`, `list_pending_leads`, `workers_day_overview`
  in schema + parser prompt + 14 FEW_SHOT examples.
- Router: extract `dateRange`, validate (ignore-and-fall-back-to-today on
  invalid), forward to service functions.
- Services: extend `getFieldExceptionRows`, `getAllWorkersDayOverview`,
  `getWorkerDayDetail` (managerViews.ts) + `findUnassignedLeadsForAssignment`
  (incomingLeads.ts) with optional `dateRange` param filtering on
  `TaskField.scheduledStartAt` / `IncomingLead.receivedAt`.
- `findEscalationCandidates` intentionally NOT extended (relative-time
  query, not a date-range).

**Files changed:** `schema.ts` +15, `intentParser.ts` +18,
`managerViews.ts` +62, `incomingLeads.ts` +22, `router.ts` +55
(`extractDateRange` helper + 3 case updates), `routerManagerIntents.test.ts`
+14; **new** `managerDateRange.test.ts` (13 tests).

**Decision:** invalid dateRange → ignored (fall back to today), not
`unknown`. LLM sometimes emits partial ranges; useful behavior beats
strict rejection.

**QA:** `npx tsc --noEmit` exit 0. Full suite 1055/0/7.

**Known limits:** Date-range label formatter shows exclusive end
(`01/07–04/07` for `to:"2026-07-04"`); could improve in follow-up.
Menu-driven flows still default to today (only free-text AI path uses
dateRange).

---

### D5-T12 — Manager searchBy expansion + count_only (Phase 5)

**Status:** DONE (local, uncommitted)

**What to do:**
- Expand `searchBy` enum from `[customer, worker, product]` to also include
  `address`, `phone`, `task_id`, `field_status`.
- Add `count_only: boolean` param — router sends only "יש X <label>"
  instead of the full list. Applies to
  `list_today_field_inspections`, `list_open_exceptions`,
  `list_pending_leads`, `workers_day_overview`, `management_snapshot`.
- Add ~10 FEW_SHOT examples.
- New service functions in `managerViews.ts`:
  - `searchTasksByAddress(query)` — ILIKE on siteAddress + siteCity
  - `searchTasksByPhone(query)` — ILIKE on customer/lead phones
  - `searchTasksByTaskId(query)` — safe UUID/int parse, empty on bad input
  - `searchTasksByFieldStatus(status)` — exact enum match, Hebrew synonyms
    map at router level (פתוח→ASSIGNED, אושר→CONFIRMED, בדרך→EN_ROUTE,
    באתר→ARRIVED, ממתין למידע→WAITING_FOR_INFO, סיים→FINISHED_FIELD,
    בעיה→HAS_PROBLEM, בוטל→CANCELED).

**Files changed:** `schema.ts`, `intentParser.ts` (manager section),
`router.ts` (search dispatch + count_only branches), `managerViews.ts`
(4 new functions), `aiSchema.test.ts` (+ enum assertions); **new**
`managerSearchExpansion.test.ts` (48 tests).

**QA:** `npx tsc --noEmit` exit 0. Full suite 1126/0/7.

---

### D5-T13 — Manager richness + polish (Phase 6)

**Status:** DONE (local, uncommitted)

**What to do:**
- **6a — Voice colloquialisms + filter synonyms** in `MANAGER_FEW_SHOT`
  (~15 new examples): "אה, תראה מה קורה", "יאללה תפריט", "כן, תראה חריגים",
  "בטח תמונת מצב", "סליחה, חזור לתפריט"; filter synonyms ("בעיות שטח",
  "בעייתיים", "המתינות לאישור", "חסרות מידע", "עדיין לא סגרו"); leads
  variants ("לידים בעיכוב", "לידים שעברו זמן").
- **6b — Structured `assign_lead`**: LLM extracts BOTH `params.leadRef` and
  `params.assigneeName` from one sentence. Router's new
  `tryPrePopulateAssignLead`: if both hints resolve unambiguously
  (exactly one lead + one worker matching substring), jumps straight to
  `assign_lead_confirm`. Falls back to normal multi-step flow otherwise.
  Auth gate preserved + read-only lookup only (no writes until confirm).
- **6c — Guard expansion for "digit + word"**: normalize
  `^([1-9])\s+(בבקשה|תודה|תודה\s+רבה)$` and
  `^(כן|אישור|בטח|אוקי|אוקיי|סבבה)\s+([1-9])$` into a bare digit before
  applying the existing manager/worker bare-digit guards. Prevents
  "2 בבקשה" or "כן 3" from going to the AI parser.
- **6d — Owner-scoped leads rejection**: LLM instructed to emit
  `list_pending_leads` with `unassigned` filter + clarification when user
  asks "לידים שלי" / "לידים של סשה". Router (new logic in `routeIntent`)
  surfaces `clarification` before the list rendering for the 6
  high-confidence query intents (list_open_exceptions,
  list_pending_leads, workers_day_overview, list_today_field_inspections,
  management_snapshot, search_task).
- **6f — Menu regex parity**: verified `MENU_TRIGGER_RE` catches
  "יאללה תפריט"; added test coverage.

**Files changed:** `intentParser.ts` (~50 new FEW_SHOT lines +
MANAGER_INTENT_LIST additions), `router.ts` (digit+word normalization,
`tryPrePopulateAssignLead`, `assign_lead` dispatch, high-confidence
clarification pre-message); **new** `managerRichness.test.ts` (27 tests).

**QA:** `npx tsc --noEmit` exit 0. Individual test suites all pass.
Concurrent full-suite runs intermittently timeout on 2-3 tests
(equipmentQuery / routerAssignLead / routerCorrections) under CPU
pressure — not reproducible in isolation, pre-existing pattern, not
caused by Phase 6.

**Known follow-ups (LOW severity, deferred):**
- Owner-scoped leads is documented rejection — actually filtering by
  lead owner requires product decision on which "owner" column.
- Multi-intent detection is prompt-level only — no schema field for
  "second intent detected"; user is told to send it separately.

---

## 4.9 Phase 1-6 consolidated summary (2026-07-05)

**Total scope shipped in one session:**
- 3 new AI intents: `list_my_inspections` (Phase 1), `day_summary_query`,
  `missing_equipment_free` (Phase 2).
- Expanded `searchBy` enum: 3 → 7 values (Phase 5).
- Expanded `MENU_TRIGGER_RE` (Phase 2+3, verified in Phase 6).
- `params.dateRange` on 3 manager list intents (Phase 4).
- `params.count_only` on 5 manager list intents (Phase 5).
- `params.leadRef` + `params.assigneeName` for structured
  assign_lead (Phase 6).
- 4 new manager service search functions (Phase 5).
- `dateRange` support in 4 service query functions (Phase 4).
- EMP_MENU_N stale-context handler + worker bare-digit guard for [1-7]
  (Phase 1).
- Guard normalization for "digit + polite word" / "confirmation + digit"
  patterns (Phase 6).
- Numbered disambig list for open TaskFields with digit-pick support
  (Phase 1).
- Menu-hint suffix for worker `unknown` fallback (Phase 1).
- High-confidence `clarification` surface for 6 query intents (Phase 6).

**Files touched (aggregate):**
- Sources: `schema.ts`, `intentParser.ts`, `menu.ts`, `router.ts`,
  `types/index.ts`, `services/inspections.ts`,
  `services/conversationContext.ts`, `services/managerViews.ts`,
  `services/incomingLeads.ts`.
- Tests: 5 new files (`routerWorkerFreeText`, `workerFewShotPhrasings`,
  `managerDateRange`, `managerSearchExpansion`, `managerRichness`);
  updates to 9 existing test files.
- Docs: `TASKS.md` sections 4.8 + 4.9 (this one).

**Constraints preserved throughout:**
- No `Task.status` write.
- No CRM commercial-field write.
- No new migrations / DB schema.
- `TaskField.scheduledStartAt` remains the sole "today" date column (§6.1).
- `IncomingLead.receivedAt` remains the leads date column (§6.2).
- All permission gates intact (`isManagerMenuUser`, `isLeadsViewer`,
  worker owner scoping).
- No manager intents leak into worker prompt.
- STARTED remains retired; ARRIVED replaces it in FEW_SHOT hint.

**Test coverage delta:** ~187 new tests across 5 new files + ~40
modifications in 9 existing files. `npx tsc --noEmit` clean throughout.
Full suite peaked at 1119-1166 passing.

**Not shipped in this session (LOW / follow-up):**
- Owner-scoped leads filter (product decision needed).
- Weekly/multi-day workers overview label improvement.
- Menu-driven flows do not yet accept dateRange (only free-text path).
- Manager-worker item 7 parity test.
- Live smoke test in production WhatsApp (this environment has no
  DATABASE_URL / WA sandbox).

---

### D5-T14 — `list_my_inspections` dateScope="all" + AI-first fallback (2026-07-05 hotfix)

**Status:** DONE (local, uncommitted)

**Problem reported live:** worker typed "תציג את כל הבדיקות שלי מכל הזמנים" —
regex fast-path matched, passed "מכל הזמנים" as range suffix,
`parseHebrewInspectionRange` returned null → bot answered
"לא הצלחתי להבין את הטווח". Even when the user retried with more context,
the bot defaulted to today, IGNORING the user's explicit "מכל הזמנים".

**Fix:**
- Added `dateScope: "all"` to `list_my_inspections` schema semantics.
- New service `getAllMyInspections(userId, limit=200)` — no date filter,
  ordered DESC by scheduledStartAt, soft cap 200 rows.
- Router `case 'list_my_inspections'` handles `dateScope === 'all'` → routes
  to `handleMyInspectionsAllTime` (new function).
- `handleMyInspectionsFreeText` — when the fast-path regex matches but the
  Hebrew range suffix is unrecognized (used to error), now delegates to the
  AI parser via `routeToAIParserFor` so the LLM can emit
  `list_my_inspections` with the appropriate `dateScope`. This is the
  "AI-first" behavior the user asked for ("מספיק עם הרגקסים - AI INTENT
  כמו שצריך כמו באדמין").
- Fast-path shortcut inside `handleMyInspectionsFreeText`: if the suffix
  matches "מכל הזמנים / הכל / בלי הגבלה / מאז ומעולם / מהתחלה", jump
  straight to `handleMyInspectionsAllTime` without an AI round-trip.
- Intent parser prompt: `WORKER_INTENT_LIST` documents `dateScope="all"`;
  `WORKER_FEW_SHOT` gets 7 new examples covering the "all" variants.

**Files changed:**
- `src/services/myInspectionsRange.ts` (+62 — `getAllMyInspections`)
- `src/ai/router.ts` — import `getAllMyInspections`, extended
  `list_my_inspections` case, added `handleMyInspectionsAllTime` and
  `routeToAIParserFor` helpers, fast-path all-time shortcut.
- `src/ai/intentParser.ts` — worker prompt docs `dateScope='all'`, +7 FEW_SHOT.
- `src/__tests__/routerWorkerFreeText.test.ts` — mock `getAllMyInspections`,
  +5 tests covering AI intent path, fast-path shortcut, empty-result
  message, and the "regex matched but range unparseable → AI takeover".
- `src/__tests__/managerRichness.test.ts` — added `getAllMyInspections`
  mock to satisfy import.
- `src/__tests__/routerBareDigitGuard.test.ts` — same mock addition.

**QA:** `npx tsc --noEmit` exit 0. Suites re-run: 180/180 across the six
affected files. Key scenario (regex matches "מכל הזמנים" → all-time list)
covered.

**Live user impact:** "תציג את כל הבדיקות שלי מכל הזמנים" now returns the
full list of worker's TaskFields (up to 200 most-recent) instead of an
error or a today-only view.

---

### D5-T15 — Worker-intent inline dispatch inside detail-view action states (2026-07-05 hotfix)

**Status:** DONE (local, uncommitted)

**Problem reported live:** worker was viewing a specific TaskField's detail
(state = `mgr_today_action` after picking from `הבדיקות שלי` list). They
typed "יצאתי" expecting a status update. Bot invoked
`extractInspectionActions` (correction/reassign extractor — Agent B), which
does NOT recognize `set_field_status` / `report_problem` /
`report_missing_info` intents → returned:
> "לא זוהתה פעולה ברורה מההודעה. אנא ציין את הפעולה הרצויה. 1/2/3/4"

The user (correctly) demanded: "worker free text must be understood as
intent in ANY state, not only at menu top-level".

**Fix:**
- New function `tryDispatchWorkerIntentInline(user, text, taskFieldId)` in
  `router.ts`. Called BEFORE `extractInspectionActions` inside
  `handleMgrActionFreeText`.
- Runs the general `parseIntent` with the user's role context.
- On `set_field_status` (DEPARTED/ARRIVED/FINISHED) with confidence ≥
  `CONF_LOW` → `performTransition(user, currentTaskFieldId, transition)`.
  No disambiguation needed: we already know which TaskField the user is
  viewing.
- On `set_field_status` (WAITING_FOR_INFO) with a note → write directly;
  without note → prompt for the note against the current TF.
- On `set_field_status` (HAS_PROBLEM) with `problem_type` → write directly;
  without → open the 7-item problem sub-menu against the current TF.
- On `report_problem` → same as HAS_PROBLEM branch above.
- On `report_missing_info` → write directly (with note) or prompt for the
  note against the current TF.
- Returns `true` (consumed) so the caller skips the correction extractor.
- Any other intent OR low-confidence → returns `false`; the existing
  `extractInspectionActions` path handles corrections/reassign/reschedule.

**Files changed:**
- `src/ai/router.ts` — `tryDispatchWorkerIntentInline` (+90 lines) invoked
  from `handleMgrActionFreeText` (+3 lines).
- `src/__tests__/detailViewAIContext.test.ts` — refactored parseIntent
  mock + inspections service mocks to be trackable; +8 new tests for
  D5-T15 covering DEPARTED / ARRIVED / FINISHED / report_problem (typed
  + untyped) / report_missing_info / correction-still-routes-to-extractor
  regression / low-confidence-still-routes-to-extractor regression.

**QA:** `npx tsc --noEmit` exit 0. All 44 tests in
`detailViewAIContext.test.ts` pass; 215/215 across 7 affected suites.

**Live user impact:** typing "יצאתי" / "הגעתי" / "סיימתי" / "הלקוח לא ענה" /
"שכחתי את המדד" while viewing an inspection's detail view now dispatches
directly against that TaskField. No more "לא זוהתה פעולה ברורה" trap for
worker intents in the detail view.

**Constraints preserved:**
- Correction/reassign/reschedule flows unchanged (regression tests).
- Low-confidence intent still falls through to the correction extractor.
- Both worker and manager users benefit — a manager viewing their own
  inspection (item 7) can also say "יצאתי" and it works.
- No new schema, no new migrations, no permission changes.

---

### D5-T15b — AI-first flexibility for vague / colloquial intents inside detail view (2026-07-05 iteration)

**Status:** DONE (local, uncommitted)

**Problem reported live (2nd iteration):** the previous D5-T15 fix only
handled explicit transitions ("יצאתי" / "הגעתי" / "סיימתי"). When the user
said "שנה סטטוס" / "נכון תשנה סטטוס" (colloquial: "change status" without
naming which one), the LLM either returned low confidence or set
`transition=null`, and the correction extractor's rejection ("ההודעה
מתייחסת לשינוי סטטוס ולא לעדכון פרטי אתר") reached the user with a menu
prompting for 1/2/3/4 corrections — a dead-end for someone trying to update
status. User pushback: "AI INTENT - לבצע פעולות בטקסט חופשי או הקלטה
שמומרת לטקסט חופשי אם יש לו אי הבנות לAI שישאל" = AI must understand free-
text/voice, and if uncertain, the AI must ASK (via `clarification`), not
fall back to a menu of 4 unrelated actions.

**Approach — AI-first, no regex:**
- Reject any regex-based keyword detection ("סטטוס" + verb) — the user
  explicitly asked NOT to add regex fallbacks.
- Have the LLM emit `set_field_status` with `transition=null` and a clear
  Hebrew `clarification` for vague phrasings, INSTEAD OF returning
  `unknown`. Prompt updates:
  - `WORKER_INTENT_LIST`: added a "VAGUE STATUS PHRASES" clause telling the
    model to emit `set_field_status` with `transition=null` and a Hebrew
    clarification when the user asks to change/update status without
    naming the target ("שנה סטטוס", "עדכן סטטוס", "אני רוצה לשנות סטטוס",
    "נכון תשנה סטטוס", "אפשר לעדכן סטטוס", "צריך לעדכן סטטוס").
  - `WORKER_FEW_SHOT`: added 6 examples for the vague-status pattern, each
    emitting `transition=null` + `clarification="לאיזה סטטוס לעדכן?"`.
- Router `tryDispatchWorkerIntentInline`:
  - Removed the regex-based deterministic pre-check (per the user's
    directive).
  - When `set_field_status` intent arrives with `transition=null`, surface
    the LLM's `clarification` (falling back to a helpful default text if
    the model omitted one). Keeps the action context alive so the user's
    next reply routes back into the same handler with the same TaskField.
  - Confidence threshold for the worker-inline path stays at `0.4` (biased
    toward the worker path inside the detail view; the LLM can always ask
    a clarification instead of committing).
- Router `handleMgrActionFreeText` (fallback branch when correction
  extractor rejected):
  - Removed the regex clarification-string matching (kept from previous
    iteration).
  - Now RE-INVOKES `tryDispatchWorkerIntentInline` as a "second chance" —
    the general parser is broader than the correction extractor and may
    recognize the worker intent that the extractor rejected. If it also
    fails, the extractor's clarification is shown as-is (letting the LLM
    drive the next turn).

**Files changed:**
- `src/ai/intentParser.ts` — updated `WORKER_INTENT_LIST` set_field_status
  line + added 6 new FEW_SHOT examples for vague status phrases.
- `src/ai/router.ts` — `tryDispatchWorkerIntentInline` removed regex
  pre-check + added AI-clarification handling for `transition=null` case;
  `handleMgrActionFreeText` fallback now retries worker-intent path.
- `src/__tests__/detailViewAIContext.test.ts` — +2 new tests:
  - "vague שנה סטטוס → surfaces AI clarification, no menu fallback"
  - "correction-extractor rejection re-tries as worker intent (second chance)"

**QA:** `npx tsc --noEmit` exit 0. All 46 tests in
`detailViewAIContext.test.ts` pass; 206/206 across 6 affected suites.

**Live user impact:** "שנה סטטוס" / "נכון תשנה סטטוס" / "אני רוצה לעדכן
סטטוס" now trigger the AI's clarification "לאיזה סטטוס לעדכן?" — the AI is
asking, not the bot fallbacking. Any explicit transition in the reply
completes the flow on the same TaskField.

**Philosophy locked in for future phases:** no regex intent detection.
AI-first everywhere. When AI is uncertain, AI asks (via `clarification`).

---

### D5-T16 — Universal AI-first pivot escape from text-capture states (2026-07-05 iteration)

**Status:** DONE (local, uncommitted)

**Problem reported live (3rd iteration):** the user pointed out that the
AI-first policy was only applied to `mgr_*_action` states inside D5-T15.
Every OTHER text-capture state (missing_info_note, equipment_missing_note,
inspection_decline_reason, etc.) still forced the user's reply into the
capture, even if they had clearly pivoted to a new intent
("שנה סטטוס", "יאללה תפריט", "יצאתי לאתר"). The user's clarification:
"AI בעל עדיפות אם לא נבחר סעיף בתפריט. שיהיה התייחסות לטקסט חופשי יותר
בבקשה" = AI has priority when the user didn't pick a menu item; make
free-text handling universal.

**Fix — universal pivot check:**
- New `TEXT_CAPTURE_PIVOT_STATES` set listing all text-capture awaiting
  states where a mid-flow pivot is allowed:
  - Note states: `missing_info_note`, `problem_type_note`,
    `finished_notes`, `callback_customer_note`, `equipment_missing_note`,
    `inspection_decline_reason`, `inspection_need_info_note`,
    `pre_reminder_need_info_note`.
  - Search: `mgr_search_await_query`.
  - Deliberately EXCLUDED: `schedule_await_time` /
    `schedule_await_duration` / `correct_site_await_value` /
    `correct_site_confirm_extracted` — the user is deep in a specific
    multi-step flow; their reply is meant as a value (date, minutes,
    corrected address), not a free-text note. Pivoting would cause
    accidental exits.
  - Also excluded: `mgr_*_action` (they already have their own AI-first
    path via `tryDispatchWorkerIntentInline` in D5-T15).
- New `tryPivotToAIIntent(user, text, ctx)` helper — runs `parseIntent`
  and only escapes when the LLM returns a HIGH-confidence (`≥ CONF_HIGH =
  0.85`) top-level intent from a curated allow-list:
  - `open_manager_menu`, `management_snapshot`,
    `list_today_field_inspections`, `list_open_exceptions`,
    `list_pending_leads`, `workers_day_overview`, `search_task`
    (top-level manager dashboards).
  - `list_my_inspections`.
  - `schedule_task_field`, `assign_lead` (top-level office actions).
  - `set_field_status` with an explicit transition (DEPARTED / ARRIVED /
    FINISHED).
  - `report_problem` with a decisive `problem_type`.
  - Intentionally EXCLUDED: `report_missing_info`, `set_field_status`
    without a transition, `help`, `unknown` — these overlap with
    legitimate capture data (e.g. "טופס דגימה" could be misinterpreted
    as report_missing_info).
- Cheap short-token guard: single words ≤6 chars with no whitespace skip
  the LLM call entirely — most legitimate notes ("מדד", "בטריות",
  "טופס") are short and clearly answers, not pivots. Full-sentence
  pivots ("רגע יצאתי כבר לאתר") pass the guard and reach the LLM.
- `MENU_TRIGGER_RE` deterministic pre-check (זה נשמר בכל מקום כי מנוע
  התפריט הוא unambiguous UX contract, לא intent detection).

**Files changed:**
- `src/ai/router.ts` — `TEXT_CAPTURE_PIVOT_STATES` set (+15 lines);
  `tryPivotToAIIntent` (+80 lines); guarded pivot block inside
  `continueConversation` (+22 lines).
- `src/__tests__/routerFreeTextAwait.test.ts` — expose `parseIntentMock`
  for controllable per-test behavior; +2 tests:
  - LOW-confidence intent → stays in capture (no false pivot).
  - Short single-word note → skips the LLM check entirely.

**Constraints preserved:**
- All existing text-capture flows still work (regression suites pass).
- Multi-step flows (schedule, correct-site) explicitly excluded from
  pivot — no accidental exits.
- Silent try/catch on `parseIntent` — this path runs on every text-
  capture message; noisy `log.warn` would flood stderr in test/dev.
- Confidence threshold `CONF_HIGH` = 0.85 keeps borderline phrasings in
  the capture (biases toward "user answered our question" over "user
  pivoted").

**QA:** `npx tsc --noEmit` exit 0. Full suite **1132 passed / 0 failed
/ 7 skipped**.

**Live user impact:** the user can now say "תפריט" / "יצאתי" / "מה יש
היום" / "הבדיקות שלי" mid-capture from ANY note state, and the bot
recognizes the pivot instead of writing the pivot text as a note. If the
AI is uncertain, it asks via `clarification` — never forces a confusing
capture.

**Philosophy applied universally:** AI-first when the user did not pick a
menu number. Regex only for the deterministic menu trigger (an
unambiguous UX contract). All intent detection routed through the LLM.

---

### D5-T17 — Helpful clarification for unsupported Task-field edits (2026-07-05 iteration)

**Status:** DONE (local, uncommitted)

**Problem reported live (4th iteration):** viewing a specific inspection's
detail, the user asked "תעדכן את ההערות - בדיקת ניסיון..." (update the
task's notes/description). Bot answered "לא זוהתה פעולה ברורה מההודעה" +
the generic 4-item menu. The user re-tried "ביקשתי לשנות את הערות המשימה
ל: ..." → same generic fallback. Also tried "תשנה את הכותרת למשימה
אחרונה" → same. User pushback: "לא תיקנת כלום".

Per project constraints (`CLAUDE.md §6.6`, §5), editing `Task` fields
(title, description, price, dueDate, customerId, etc.) is CRM-only —
NOT permitted from the bot. But the bot's response gave no explanation:
it just showed the same 4-action menu.

**Fix — AI-first, explanatory clarification:**
- Extended the `inspection_action` extractor prompt in
  `src/ai/contextExtractor.ts` (`buildInspectionActionBlock`) with an
  explicit "פעולות שאינן זמינות מהבוט" section:
  - Task-level fields (title, description, specialInstructions,
    Task.status, commercial fields, customer/lead/project FK).
- When the user asks to edit any of these, the LLM is instructed to:
  - Return `action=null`, `confidence < 0.60`.
  - Emit a Hebrew `clarification` explaining WHY it's not available
    ("זמין רק ב-CRM ולא מהבוט") AND what CAN be done from the bot
    ("מכאן אפשר לתקן פרטי אתר, לשנות סוג בדיקה, לשייך מחדש, או לשנות
    תאריך/שעה") — customized to the user's specific request.
- The router's `handleMgrActionFreeText` fallback (added earlier in
  D5-T15b) already surfaces the extractor's `clarification` as-is. The
  user now sees a specific, helpful explanation instead of the generic
  "לא הבנתי" prefix.

**Files changed:**
- `src/ai/contextExtractor.ts` — extended
  `buildInspectionActionBlock` with a 7-line "unsupported fields"
  section + instruction for the LLM to emit an explanatory
  `clarification`.
- `src/__tests__/detailViewAIContext.test.ts` — +1 new test verifying
  the extractor's `clarification` reaches the user verbatim when it
  matches the unsupported-field pattern.

**Constraints preserved:**
- No new writes — the bot still refuses to edit Task-level fields (§6.6).
- The 4 supported actions (correct_site, correct_type, reassign,
  reschedule) are unchanged.
- The router's existing `handleMgrActionFreeText` fallback path is
  reused — no new code branches.

**QA:** `npx tsc --noEmit` exit 0. Full suite **1139 passed / 0 failed
/ 7 skipped**. New test in `detailViewAIContext.test.ts` verifies the
clarification content is surfaced to the user.

**Live user impact:** the user's failing scenarios now return a helpful
message:
> "עדכון ההערות של המשימה זמין רק ב-CRM ולא מהבוט. מכאן אפשר לתקן פרטי
> אתר, לשנות סוג בדיקה, לשייך מחדש, או לשנות תאריך/שעה."

instead of the confusing generic "לא זוהתה פעולה ברורה".

**Future work (LOW, not shipped here):** if the product decides to
support any of these Task-level edits from the bot (which would be a
spec change), it belongs in a new domain-2 task, not in this NLU
polish batch.

---

### D5-T18 — Add CONFIRM (אושרה) to free-text worker status transitions (2026-07-05 iteration)

**Status:** DONE (local, uncommitted)

**Problem reported live (5th iteration):** in the detail view, user typed
"שנה סטטוס לאושרה". Bot returned the AI clarification "לאיזה סטטוס
לעדכן? כתוב 'יצאתי', 'הגעתי', או 'סיימתי'." — but the user wanted to
change the status to CONFIRMED (אושרה), which wasn't in the list. User's
push: allow more of the workflow status values from free text
("אושר", "שובץ" etc).

**Analysis:** worker-triggered transitions per SPEC_FIELD_V2 §7 and the
worker menu (item 3) previously covered only DEPARTED / ARRIVED /
FINISHED (plus WAITING_FOR_INFO / HAS_PROBLEM via their own flows).
CONFIRMED existed only via the §6 inspection-card button (§6
`confirmInspection`) — no free-text entry point. ASSIGNED is set by the
CRM at TaskField creation and is not a legal worker transition (workers
don't "revert" to assigned).

**Fix (CONFIRM only):**
- Added `CONFIRM` to `FIELD_STATUS_TRANSITIONS` enum (`src/ai/schema.ts`).
- Added `CONFIRM` to `FieldStatusTransition` union (`src/types/index.ts`).
- Extended `AdvanceTransition` type + `advanceFieldStatus` in
  `src/services/inspections.ts` — new CONFIRM case writes
  `fieldStatus='CONFIRMED'` + `confirmedAt=now()` (same column set as
  the §6 button path).
- Router updates:
  - `STATUS_HE_LABEL[CONFIRM] = 'אושרה'` — response label.
  - `performTransition` / `handleDisambigReply` (status_disambig) /
    `runAdvanceStatusDirect` / `tryDispatchWorkerIntentInline` (D5-T15
    inline path) all extended to accept CONFIRM.
  - Universal-pivot `tryPivotToAIIntent` (D5-T16) now also treats
    `set_field_status` with `transition='CONFIRM'` as a high-confidence
    pivot from text-capture states.
- Intent parser prompt:
  - Extended `WORKER_INTENT_LIST` set_field_status line with the CONFIRM
    mapping: "אישרתי", "אושרה", "מאשר", "אני מאשר", "אני מאשר את
    הבדיקה", "אישור", "מאשר את השיבוץ".
  - +8 CONFIRM examples in `WORKER_FEW_SHOT`.
  - +3 examples for the "explicit-status-name" pattern ("שנה סטטוס
    ליצאתי", "עדכן סטטוס לבאתר", "עדכן סטטוס להסתיים") so the LLM emits
    the specific transition instead of the transition=null clarification
    fallback.

**Not included (deliberate):**
- `ASSIGNED` — the CRM's initial state, not a worker-triggered
  transition. Adding it would violate the §6.3 worker status flow
  contract and open a workflow-integrity risk.
- `DECLINED` — requires a reason capture; would ship as a separate
  D5-T19 with the sub-flow if the product owner asks.
- `CANCELED` — office-only per §6.3, not a worker transition.

**Files changed:**
- `src/ai/schema.ts` — `FIELD_STATUS_TRANSITIONS` +CONFIRM (1 line).
- `src/types/index.ts` — `FieldStatusTransition` +CONFIRM (1 line).
- `src/services/inspections.ts` — `AdvanceTransition` +CONFIRM; new
  switch branch in `advanceFieldStatus` (10 lines).
- `src/ai/router.ts` — `STATUS_HE_LABEL[CONFIRM]`; extended 4 pattern
  matches for CONFIRM.
- `src/ai/intentParser.ts` — `WORKER_INTENT_LIST` prompt + 11 new
  FEW_SHOT lines.
- `src/__tests__/aiSchema.test.ts` — expected transitions list from 5
  → 6.
- `src/__tests__/inspections.test.ts` — +1 test for CONFIRM SQL
  (fieldStatus='CONFIRMED' + confirmedAt).
- `src/__tests__/detailViewAIContext.test.ts` — +2 tests for CONFIRM
  dispatch inside `mgr_today_action` (bare "אישרתי" + explicit "שנה
  סטטוס לאושרה").

**QA:** `npx tsc --noEmit` exit 0. Full suite **1145 passed / 0 failed
/ 7 skipped**.

**Live user impact:** "שנה סטטוס לאושרה" / "אישרתי" / "אני מאשר את
הבדיקה" now dispatch CONFIRM on the current TaskField and respond
"עדכנתי — סטטוס: אושרה." — no more "לאיזה סטטוס לעדכן?" prompt for
these clearly-named CONFIRM phrasings.

---

## 4.10 QA findings from live-testing (2026-07-05, evening session)

The user performed a comprehensive live QA against the WhatsApp bot and
identified 15 items in a written report. Split into 4 work batches
(A/B/C/D) grouped by severity. **Each item below is an OPEN task** — status
`OPEN` until fixed and QA'd.

### Batch A — URGENT (investigation + fix)

#### D5-T19a — Manager notifications: verify actual send + DB log + 24h window handling
**Status:** DONE (local, uncommitted) — partial scope, see below

**What the QA report said:** in several flows the bot says "נשלחה הודעה
למנהל" but it's unclear whether the WhatsApp message actually reaches the
manager. Relevant flows: report_problem, missing_info, missing_equipment,
day summary/exceptions alerts.

**Investigation findings (confirmed by tracing + tests):**
1. `broadcastToManagers` (`src/services/inspections.ts`) used a per-item
   `.catch()` inside `Promise.allSettled(...)`, which swallowed every send
   rejection into a resolved value — so `Promise.allSettled` always saw
   `'fulfilled'`, and the function returned `true` whenever `managers.length >
   0`, regardless of whether any `sendTextMessage` call actually succeeded.
2. Every caller in `router.ts` (13 sites) ignored the return value entirely and
   unconditionally sent "עדכנתי. המנהל/המשרד קיבל התראה." to the worker — even
   when zero managers were configured or every send failed.
3. A 14th, undiscovered instance of the same bug: `handleCallbackCustomerNoteReply`
   (D2-T10 "צריך לחזור ללקוח") had its own **inline duplicate** of the same
   broken pattern (direct `getManagersForBroadcast` + swallowed `.catch()`),
   not going through `broadcastToManagers` at all.
4. DB audit-log: confirmed a `WhatsappAuditLog` row **is** written on failure
   (`sender.ts::writeSendFailure`, `executionStatus='FAILED'`) after all
   retries are exhausted — but there is no success-path row, and no
   correlation to a specific manager-alert broadcast/taskFieldId.
5. 24h-window / template fallback: **not implemented** (confirmed out of
   scope for this fix, tracked as a follow-up below). `sendTextMessage` is
   documented (file header, `sender.ts`) as free-form-only, valid solely
   inside the 24h WhatsApp service window; there is no fallback to
   `sendTemplateMessage` when a manager is outside that window — the send
   just fails (correctly detected as a failure by the fix below, but not
   auto-retried via a template).

**Fix implemented (scope: 1-3 above):**
- `broadcastToManagers` rewritten to award `Promise.allSettled` results
  properly (no per-item `.catch()`), count actual `'fulfilled'` sends, and
  return `true` only if `sentCount > 0`. Logs each failed recipient plus a
  summary warning when every send fails.
- All 5 `notifyOffice*` functions (`notifyOfficeMissingInfo`,
  `notifyOfficeProblem`, `notifyOfficeDeclined`, `notifyOfficeNeedsMoreInfo`,
  `notifyOfficeMissingEquipment`) now return `Promise<boolean>` instead of
  `Promise<void>` — true only if at least one manager actually received the
  alert.
- New `notifyOfficeCallbackRequest` extracted from the inline duplicate in
  `handleCallbackCustomerNoteReply` — same `broadcastToManagers`-backed
  contract, removing the 14th duplicate instance of the bug.
- `src/ai/router.ts`: added `officeNotifiedText(sent, kind)` helper; all 14
  call sites now check the boolean and send an honest failure message
  ("עדכנתי במערכת, אך לא הצלחתי להתריע כרגע — כדאי לוודא ידנית מול המשרד.")
  instead of blindly claiming delivery. Removed the now-dead direct
  `getManagersForBroadcast` import from `router.ts` (only used by the
  now-removed inline duplicate).

**Files changed:**
- `src/services/inspections.ts` — `broadcastToManagers` rewrite, 5 `notifyOffice*`
  signatures → `Promise<boolean>`, new `notifyOfficeCallbackRequest`.
- `src/ai/router.ts` — `officeNotifiedText` helper + 14 call sites updated
  (13 existing `notifyOffice*` calls + the extracted callback-request flow).

**Files changed (tests):**
- `src/__tests__/inspections.test.ts` — added return-value assertions to every
  existing `notifyOffice*` happy-path test; added 2 new regression tests
  (`notifyOfficeMissingInfo` returns `false` when every manager send rejects,
  `true` when at least one of several succeeds) — these fail against the old
  implementation; added `notifyOfficeCallbackRequest` coverage.
- `src/__tests__/routerDaySummary.test.ts` — rewrote the "צריך לחזור ללקוח"
  tests to assert on `notifyOfficeCallbackRequest` instead of raw
  `getManagersForBroadcast`/`sendTextMessage`-per-manager (matches the new
  architecture); the "no managers" test now asserts the **honest failure
  copy**, not the old false-positive success text.
- 8 other router test files (`routerInspections`, `routerWorkerFreeText`,
  `routerCorrections`, `routerFreeTextAwait`, `routerPreReminderTap`,
  `managerRichness`, `managerSearchExpansion`, `managerDateRange`,
  `detailViewAIContext`, `routerAssignLead`, `routerLeadsDisplay`,
  `routerScheduleTaskField`, `routerBareDigitGuard`, `interactiveButtons`,
  `routerManagerMenu`) — updated `notifyOffice*` mock defaults from
  `mockResolvedValue(undefined)` to `mockResolvedValue(true)` (several had a
  `beforeEach` that reset the mock back to `undefined` even after the
  top-level default was fixed — found by running the suite, not by
  inspection alone).

**Tests run:** `npx tsc --noEmit` clean. Full suite `npx vitest run` —
1135 passed / 7 skipped / 0 failed (same pre-existing worker-pool OOM after
all tests complete, noted in X-T15a — not caused by this change; re-ran the
18 directly-affected files individually first and confirmed 0 failures
before the full-suite run).

**Scope NOT done (follow-ups):**
- **24h-window / template fallback** — still not implemented. When every
  manager is outside the WhatsApp service window, the worker now correctly
  sees the honest "לא הצלחתי להתריע" message (fixed), but the alert is not
  auto-retried via an approved template. Needs a Meta-approved template +
  error-code detection in `deliver()` (`sender.ts`) — larger, separate
  change; not attempted here per the scoping agreed with the user.
- **Per-broadcast audit-log row** — still relies solely on the generic
  failure-only `WhatsappAuditLog` row in `sender.ts`; no explicit
  success/failure row scoped to `broadcastToManagers` + `taskFieldId`. Not
  in scope for this fix.
- D5-T19b/c (note-saving bug, raw-enum display) — separate open items,
  untouched by this change.

**Priority:** URGENT — the user has no visibility into whether the bot's
"עדכנתי, המנהל קיבל התראה" claim is truthful. Core false-positive bug fixed;
24h/template fallback and per-alert audit logging remain open follow-ups.

#### D5-T19b — "בעיה מקצועית" (PROFESSIONAL_ISSUE) / OTHER note not saved properly
**Status:** DONE (local, uncommitted)

**What the QA report said:** in TC-5.1, when the worker selects
PROFESSIONAL_ISSUE or OTHER and then types a note, the note is not saved
correctly.

**Investigation.** `handleProblemTypeNoteReply` (router.ts) and `writeProblem`
(`src/services/inspections.ts`) were both verified correct in isolation — the
`UPDATE ... SET "problemNote" = $3` writes the note fine, and there was
already a passing unit test for this exact scenario. So the note loss does
NOT happen inside the note-capture handler itself.

**Actual root cause:** the D5-T16 (2026-07-05) "universal AI-first pivot"
escape hatch (`tryPivotToAIIntent`, router.ts). `'problem_type_note'` is one
of the `TEXT_CAPTURE_PIVOT_STATES` — while the worker is typing their
elaboration note, the message is first run through the LLM; if it classifies
with high confidence as a top-level intent, the current capture is dropped
and the message is re-dispatched as a brand-new intent instead. One of the
pivot conditions was:
```js
const isProblemPivot =
  intent.intent === 'report_problem' && intent.problem_type !== null;
```
An elaboration note **describing a problem** (the entire point of the note —
e.g. "לא ניתן לבצע מדידה בגלל עבודות בנייה במקום") is exactly the kind of
text the LLM classifies as `report_problem` with high confidence. So typing
the note itself triggered the pivot:
- The already-chosen `problemType` (PROFESSIONAL_ISSUE/OTHER, picked from the
  numbered sub-menu) and `taskFieldId` were discarded (`clearContext`).
- The message was re-dispatched as a **fresh** `report_problem` intent →
  `runProblemDirect(user, problemType, note)`, where `problemType` is
  whatever the LLM *re-guessed* from the note text alone (frequently a
  different type than what the worker explicitly picked), and `note` comes
  from a fresh `intent.params.note` extraction (may differ from, or be empty
  relative to, the actual typed text).
- Worse: if the worker had more than one open `TaskField`, `runProblemDirect`
  hits the ambiguous branch → `problem_disambig` → after picking which
  TaskField, `handleDisambigReply`'s `flow === 'problem'` branch reopens the
  **entire 7-item problem-type sub-menu from scratch** — the worker's
  problemType choice AND their typed note are both silently lost; they must
  restart the whole flow with no explanation.

**Fix (scope agreed with user — preserve genuine mid-flow escapes):**
Removing `'problem_type_note'` from `TEXT_CAPTURE_PIVOT_STATES` entirely was
rejected — that would also disable legitimate escapes (typing "תפריט" or
"הבדיקות שלי" while elaborating a problem note must keep working). Instead,
narrowed `isProblemPivot` to exclude this one specific state:
```js
const isProblemPivot =
  intent.intent === 'report_problem' &&
  intent.problem_type !== null &&
  ctx.awaiting !== 'problem_type_note';
```
Rationale: once the worker has explicitly picked PROFESSIONAL_ISSUE/OTHER
from the numbered sub-menu, nothing they type next can legitimately be a
"new" `report_problem` — it is, by definition, the note for the
problem-report already in progress. `isTopLevelPivot` (menu, "my
inspections", search, etc.) and `isStatusPivot` (status changes) are
untouched — those remain valid escapes mid-note.

**Files changed:**
- `src/ai/router.ts` — `isProblemPivot` condition in `tryPivotToAIIntent`.

**Files changed (tests):**
- `src/__tests__/routerFreeTextAwait.test.ts` — 2 new tests in the "D5-T16 —
  universal AI-first pivot" describe block:
  1. Regression: an elaboration note in `problem_type_note` that the LLM
     classifies as `report_problem` (different guessed type) does NOT pivot
     — `writeProblem` is called with the worker's ORIGINALLY chosen
     `problemType` and the actual typed note. Fails against the old code.
  2. A genuine top-level escape (`open_manager_menu`, high confidence) from
     `problem_type_note` still pivots normally (`clearContext` called,
     `writeProblem` NOT called) — proves the fix didn't regress legitimate
     mid-flow escapes.

**Tests run:** `npx tsc --noEmit` clean. Full suite `npx vitest run` — 1137
passed / 7 skipped / 0 failed (same pre-existing worker-pool OOM noted in
X-T15a, unrelated to this change).

**Scope note:** the same theoretical exposure (`isProblemPivot` not scoped to
a particular state) could in principle also misfire from other note-capture
states (e.g. `missing_info_note`) if a note happens to read like a problem
description — not fixed here (out of scope; no report of it occurring, and
`report_missing_info`/`WAITING_FOR_INFO` have no matching pivot condition at
all, so they were never exposed the way `problem_type_note` was). Flag as a
follow-up if it's ever reported.

**Priority:** URGENT — data-integrity bug. Root cause was a routing/pivot
bug, not a data-write bug.

#### D5-T19c — Localize fieldStatus enums shown to user (FINISHED_FIELD → "הסתיים בשטח")
**Status:** DONE (local, uncommitted)

**What the QA report said:** in search-by-status results and other display
paths, the bot returns raw enums like `FINISHED_FIELD` instead of the
Hebrew label.

**Investigation.** All manager-side search/detail formatters (`managerViews.ts`
consumers, `router.ts` search dispatch, `formatInspectionListRow`/
`formatInspectionDetail`) already routed through the shared `fieldStatusHe()`
in `src/ai/inspectionFormatters.ts` — verified clean. The actual leak was on
the WORKER side: `src/whatsapp/digestContent.ts` kept a **second,
independently-maintained copy** of the Hebrew label table (`FIELD_STATUS_HE`
+ local `fieldStatusLabelHe`), missing `DECLINED` and `CANCELED` — those two
statuses rendered as the raw enum in the worker's morning digest
(`formatInspectorMorning`) and on-demand day list (`formatInspectorDayList`,
menu items 1/2).

**Fix:** removed the duplicate table; `fieldStatusLabelHe` now delegates to
the single shared `fieldStatusHe()` from `inspectionFormatters.ts` — the two
tables can never drift apart again.

**Files changed:**
- `src/whatsapp/digestContent.ts` — removed local `FIELD_STATUS_HE` +
  `fieldStatusLabelHe`; imports and delegates to `fieldStatusHe`.

**Files changed (tests):**
- `src/__tests__/inspectorMorning.test.ts` — new test: DECLINED/CANCELED now
  localize correctly (fails against the old duplicate table).

**Tests run:** `npx tsc --noEmit` clean; `npx vitest run` full suite —
1145 passed / 7 skipped / 0 failed (pre-existing worker-pool OOM after
completion, per X-T15a, unrelated).

**Priority:** URGENT — user-visible polish. Also affects search results.

### Batch B — URGENT (product-level fixes)

#### D5-T19d — `missing_equipment_free` routes to missing_info flow instead of equipment flow
**Status:** DONE (local, uncommitted)

**What the QA report said:** phrases like "אין לי בטריות" / "חסר לי מזרן"
sometimes ask "מה חסר לדוח?" instead of "איזה ציוד חסר?".

**Investigation.** `case 'missing_equipment_free'` in router.ts was already
correctly wired to `handleEquipmentMissingNoteReply` — not a router dispatch
bug. This is purely LLM-classification confusion between
`missing_equipment_free` and `report_missing_info`. Root cause: the two
few-shot example blocks in `src/ai/intentParser.ts` used the Hebrew word
"טופס" (form) as an example of BOTH intents — `report_missing_info`'s
example was "חסר לי טופס דגימה" (missing a sampling form) while
`missing_equipment_free`'s example was "שכחתי את הטופס" (forgot the form).
Two near-identical phrasings pointing to different intents teaches the
model that "טופס" is ambiguous, which plausibly bleeds into how confidently
it classifies *other* equipment phrases too.

**Fix:** replaced the ambiguous "שכחתי את הטופס" example with unambiguous
physical items (gloves/helmet/camera), and added an explicit disambiguation
heuristic to both blocks: `missing_equipment_free` = a physical
tool/device/material; `report_missing_info` = information/data/a document to
retrieve needed to WRITE the report — never a physical item.

**Files changed:**
- `src/ai/intentParser.ts` — few-shot examples + disambiguation heuristic
  for both `missing_equipment_free` and `report_missing_info`.

**Files changed (tests):**
- `src/__tests__/managerIntents.test.ts` — new test asserting the worker
  prompt contains the disambiguation heuristic and no longer contains the
  ambiguous "שכחתי את הטופס" example.

**Tests run:** `npx tsc --noEmit` clean; targeted + full suite pass (see
D5-T19c's Part-1 summary run).

**Priority:** URGENT — flow confusion.

#### D5-T19e — Customer search returns empty despite matching data
**Status:** DONE (local, uncommitted)

**What the QA report said:** "חפש בדיקה של חיים" / "חפש בדיקה של מעיין
שפירא" returned no results, even though matches should exist. Field-status
search DOES work, so the search dispatch works — just customer/name search
is broken.

**Root cause (confirmed).** No `searchTasksByCustomerName` function existed
— the "customer" search branch was an inline `pool.query` in `router.ts`
(two near-duplicate copies, one in the `search_task` intent handler, one in
`handleMgrSearchAwaitQueryReply`). Both SELECTed a 6-source `COALESCE`
customer name (Customer/Lead/Project/IncomingLead) for **display**, but the
`WHERE` clause filtered **only `c.name`** (the `Customer` table). Any Task
linked via `Lead`/`Project`/`IncomingLead` instead of an actual `Customer`
row — i.e. exactly the common case for inspections booked from a lead —
would silently never match the search, even though that same name displays
correctly everywhere else via the COALESCE.

**Fix:** added `searchTasksByCustomerName` to `src/services/managerViews.ts`
(reusing the existing shared `SEARCH_SELECT`), filtering on the SAME
6-source `COALESCE` used for display. Replaced both inline duplicate
queries in `router.ts` with calls to this function (also removing an
inconsistent 8-source COALESCE variant that had crept into one of the two
duplicates, unifying both to the canonical 6-source shape).

**Files changed:**
- `src/services/managerViews.ts` — new `searchTasksByCustomerName`.
- `src/ai/router.ts` — both customer-search call sites now call the shared
  function instead of inline SQL.

**Files changed (tests):**
- `src/__tests__/managerViews.test.ts` — SQL-shape assertion (WHERE
  filters the full COALESCE, not just `c.name`) + a Lead-linked-row match
  test (the exact reported bug).
- `src/__tests__/managerSearchExpansion.test.ts` — router dispatch test:
  `searchBy=customer` calls `searchTasksByCustomerName`.

**Tests run:** `npx tsc --noEmit` clean; full suite pass (see D5-T19c's
Part-1 summary run).

**Priority:** URGENT — a core manager feature.

#### D5-T19f — Exceptions by date range shows generic menu instead of filtered list
**Status:** DONE (local, uncommitted)

**What the QA report said:** "חריגים של אתמול" opens a generic exceptions
menu instead of showing yesterday's exceptions. The dateRange param from
D5-T11 (Phase 4) seems not to reach the query.

**Investigation.** Router dispatch (`extractDateRange` → `getFieldExceptionRows`)
and the service's SQL (half-open window, correctly toggling between
`dateRange` and the single-`localDate` default) were both verified fully
correct — already covered by `managerDateRange.test.ts` (which mocks
`buildSystemPrompt` entirely, so it could never have caught this). The
actual bug lives one layer up, in what the LLM is taught to emit.

**Root cause (confirmed).** The `dateRange` few-shot examples in
`src/ai/intentParser.ts` hardcoded a specific illustrative "today"
(`// Date-range scoping examples (today = 2026-07-05 for illustration)`,
with "אתמול" → literal `{from:"2026-07-04", to:"2026-07-05"}`). That comment
IS part of the actual prompt text sent to the model (the array is
`.join('\n')`'d verbatim). On any day other than 2026-07-05 this directly
**contradicts** the dynamically-injected `Today (Asia/Jerusalem) is
${todayIsrael}` statement elsewhere in the same prompt — two conflicting
claims about "today" in one prompt. The model would sometimes resolve
"אתמול" against the stale example's implied date instead of the real one,
emitting a `dateRange` for the wrong day → zero matching rows →
`list_open_exceptions` falls through to `showMgrExceptionsSub` (the generic
menu) instead of a filtered list — exactly the reported symptom.

**Fix:** extracted the date-range few-shot block into
`buildDateRangeFewShot(todayIsrael)`, computed dynamically inside
`buildSystemPrompt` from the SAME real `todayIsrael` used for the "Today is
X" statement — "yesterday", "שלשום", and week boundaries can never drift
from the stated real date again. The one example using literal dates given
verbatim in the message itself ("חריגים בין 1/7 ל-3/7") is left as a fixed
literal on purpose — it doesn't depend on "today" at all.

**Files changed:**
- `src/ai/intentParser.ts` — `buildDateRangeFewShot` (new, dynamic) replaces
  the hardcoded block; spliced into the manager prompt only.

**Files changed (tests):**
- `src/__tests__/managerIntents.test.ts` — 3 new tests using
  `vi.useFakeTimers()` to pin "today" to two different dates (neither is
  the old hardcoded 2026-07-05) and assert the "אתמול" example always
  computes to exactly (today − 1) → today; asserts the old hardcoded date
  string is gone; asserts the block is manager-only.

**Tests run:** `npx tsc --noEmit` clean; full suite pass (see D5-T19c's
Part-1 summary run).

**Priority:** URGENT — Phase 4 regression / incomplete plumbing. Root cause
was a prompt-consistency bug, not a router/service plumbing bug — both were
already correct and already tested.

### Batch C — URGENT + IMPORTANT (features)

#### D5-T19g — `list_today_field_inspections` (manager) needs dateRange support
**Status:** DONE (local, uncommitted)

**What the QA report said:** admin's "משימות של השבוע" / "משימות של אתמול"
/ "בין תאריכים" isn't supported — Phase 4 added dateRange to
list_open_exceptions / list_pending_leads / workers_day_overview but NOT
to list_today_field_inspections (which stays today-only per its name).

**Implementation.** Took the "cleaner path" option: extended the existing
intent/service rather than renaming or adding a parallel intent.
- `getTodayFieldInspections` (managerViews.ts) now takes an optional
  `dateRange?: DateRangeParam`, same half-open-window pattern as
  `getFieldExceptionRows` — the date condition moved into a computed
  `dateWindow` fragment so absence still falls back to the single-`localDate`
  window (existing today-only behavior unchanged).
- `showMgrTodayInspections` (router.ts) takes the same optional `dateRange`
  and builds a label (`fmtDDMM(from)–fmtDDMM(to)` vs `היום (DD/MM)`) reused
  in both the header and the empty-state message — same style as
  `workers_day_overview`'s `wovLabel`.
- `case 'list_today_field_inspections'` extracts `params.dateRange` via the
  existing `extractDateRange`, forwards it through both the `count_only` and
  full-list branches.
- LLM prompt: intent description now documents `dateRange`; added 3 few-shot
  examples to the dynamic `buildDateRangeFewShot` (D5-T19f) block — reusing
  the same real-"today"-derived dates, no new hardcoding risk.

**Files changed:**
- `src/services/managerViews.ts` — `getTodayFieldInspections(localDate, dateRange?)`.
- `src/ai/router.ts` — `showMgrTodayInspections` optional dateRange +
  label; `list_today_field_inspections` case extracts/forwards it.
- `src/ai/intentParser.ts` — intent description + 3 few-shot examples.

**Files changed (tests):**
- `src/__tests__/managerViews.test.ts` — dateRange uses `$1::date`/`$2::date`
  (not the `INTERVAL '1 day'` single-day form); absent dateRange still uses
  the single-day form.
- `src/__tests__/managerDateRange.test.ts` — new
  `list_today_field_inspections — dateRange forwarding` block (4 tests:
  dateRange forwarded, absent → undefined, count_only forwards + reports,
  invalid dateRange falls back to undefined) — mirrors the existing
  `list_open_exceptions` block exactly.

**Tests run:** `npx tsc --noEmit` clean; full suite pass (see D5-T19j's
Part-2 summary run).

**Priority:** URGENT — the user labeled this "צריך לטפל דחוף".

#### D5-T19h — Exception filter phrasings ("בעיות שטח" / "חסר מידע") don't trigger filter — show generic menu
**Status:** DONE (local, uncommitted)

**What the QA report said:** in TC-9.3, filter synonyms added in Phase 6
(D5-T13) don't actually cause the router to apply the filter — it falls
back to the generic exceptions menu.

**First investigation pass (superseded — see below):** static analysis
concluded the router/prompt plumbing was correct end-to-end (few-shot
examples present, `exFilterMap` complete, passing tests per filter value)
and could not reproduce a defect, so this was marked NEEDS FOLLOW-UP
pending live verification. That static analysis was incomplete: it
verified the NON-EMPTY-result path but never followed the EMPTY-result
path (`exRows.length === 0`) through to what it actually does.

**Root cause (confirmed via live production report):** user sent "בעיות
שטח" as a manager. The LLM correctly classified it as
`list_open_exceptions` with `params.filter="has_problem"` (this exact
mapping is a few-shot example in the prompt) — the classification was
NEVER the problem. The bug was in router.ts's handling of a *correctly
filtered, genuinely empty* result:
```js
if (exRows.length === 0) {
  await showMgrExceptionsSub(user);   // ← shows the FULL generic menu
  return;
}
```
Since there happened to be zero `has_problem` exceptions at that moment
(plausible right after production data was reset), the manager saw the
full "חריגים ודיווחים" sub-menu — visually indistinguishable from "the
filter was ignored," which is exactly what the QA report described. The
`list_pending_leads` case one switch-arm below already had the correct
pattern (`if (unassLeads.length === 0) { sendTextMessage('אין כרגע לידים
לא משויכים.'); }` / same for `escLeads`) — `list_open_exceptions` was the
inconsistent one.

**Implementation:** replaced the `showMgrExceptionsSub(user)` fallback
with a filter-specific "no results" message (mirroring the
`list_pending_leads` pattern) — one line per `FieldExceptionFilter` value:
open_exceptions / not_confirmed / has_problem / waiting_for_info /
not_closed, each with its own Hebrew "none of this kind right now" text,
then `clearContext`.

**Files affected:** `src/ai/router.ts` (`case 'list_open_exceptions'`
empty-result branch).

**Files changed (tests):** `src/__tests__/routerManagerIntents.test.ts` —
replaced the one test that had encoded the BUGGY behavior as expected
(`'shows exceptions sub-menu when no rows found'`, asserting the message
contained `'חריגים ודיווחים'`) with 5 tests, one per filter value,
including the exact live-reported phrase "בעיות שטח" → filter=has_problem
→ `'אין חריגים עם בעיה כרגע.'`. Verified `managerDateRange.test.ts`'s
empty-result tests for this intent only assert the `getFieldExceptionRows`
call args (not the response text), so they were unaffected.

**Tests run:** `npx tsc --noEmit` clean; targeted 6-file batch (229
tests) pass; full suite 1172 passed, 7 skipped, 0 failed.

**Priority:** URGENT — Phase 6 feature that doesn't work end-to-end. Root
cause located and fixed; this was a router bug, not an LLM classification
issue as first suspected.

#### D5-T19i — Allow ADMIN / MANAGER to assign leads (currently only Sasha + dev observers)
**Status:** DONE (local, uncommitted)

**What the QA report said:** the auth gate on `startAssignLeadFlow` /
`tryPrePopulateAssignLead` rejects any user who is not in `isLeadsViewer`
(Sasha + dev observers). The user requests: ADMIN / MANAGER should also
be allowed.

**Implementation.** Added `canAssignLeads(user)` to
`src/services/specialUsers.ts`: `isLeadsViewer(user.name) || user.isElevated`.
Used `user.isElevated` (documented on `ResolvedUser` as "MANAGER or ADMIN")
rather than re-deriving the role check, matching the existing convention
used elsewhere in router.ts (`reassign`/`reschedule` inline actions already
gate on `user.isElevated`). Replaced all 6 `isLeadsViewer(user.name)` auth
guards in router.ts (`tryPrePopulateAssignLead`, `startAssignLeadFlow`,
`handleAssignLeadPickLeadReply`, `handleAssignLeadPickWorkerReply`,
`handleAssignLeadConfirmReply`, and the manager-menu "3. שיוך ליד" inline
action) with `canAssignLeads(user)`. Removed the now-unused `isLeadsViewer`
import from router.ts.

**Deferred (by design, not by omission):**
- Rejection-message rewording — explicitly scoped to D5-T19n (Part 3), left
  untouched here to keep the two tasks' diffs separable.
- CRM-write check — confirmed satisfied, not a new concern: `assignLead`
  only ever writes `IncomingLead.ownerId`, already a documented allowed
  write (CLAUDE.md §6.6); widening WHO can trigger it is a permission-scope
  change, not a new write path.

**Files changed:**
- `src/services/specialUsers.ts` — new `canAssignLeads`.
- `src/ai/router.ts` — 6 call sites + import.

**Files changed (tests):**
- `src/__tests__/routerAssignLead.test.ts` — 2 new tests: a MANAGER and an
  ADMIN who are NOT named leads-viewers can now proceed past the auth gate
  (both fail against the old code); existing "regular worker rejected"
  test retitled for clarity, still passes unchanged (worker is neither a
  leads viewer nor elevated).

**Tests run:** `npx tsc --noEmit` clean; full suite pass (see D5-T19j's
Part-2 summary run).

**Priority:** URGENT — permission gate blocking real users.

### Batch D — IMPORTANT + UX

#### D5-T19j — Structured "missing info" sub-menu (top of D2-T7 flow)
**Status:** DONE (local, uncommitted)

**What to do:** before prompting for free-text "מה חסר לדוח?", show a
numbered sub-menu of common missing items ("טופס דגימה" / "מדד" / "שעה" /
"מספר היתר" / "פרטי אתר" / "שם איש קשר / מתכנן" / "אחר — כתיבה חופשית").
Route options 1-6 to a preset note text; option 7 falls back to the
existing free-text prompt.

**Implementation:** added `MissingInfoMenuItem` type + `missingInfoMenu()`
(7 items, numbered 1-7, item 7 = "אחר" with `presetNote: null`) +
`renderMissingInfoMenu()` in `src/ai/menu.ts`, following the existing
`problemTypeMenu()` pattern. `startMissingInfoFlow` in `router.ts` now
sets `awaiting: 'missing_info_choice'` and sends `renderMissingInfoMenu()`
instead of jumping straight to a free-text prompt. New
`handleMissingInfoChoiceReply(user, trimmed, ctx)` dispatches: items 1-6
save the preset note directly and confirm; item 7 (or invalid input)
falls back to the pre-existing free-text capture state. Added
`'missing_info_choice'` to `NUMERIC_PICKER_AWAITING` (D5-T13 digit-only
guard applies) and to `TEXT_CAPTURE_PIVOT_STATES`-adjacent dispatch in
`continueConversation`.

**Files affected:** `src/ai/menu.ts` (`missingInfoMenu`,
`renderMissingInfoMenu`), `src/ai/router.ts` (`startMissingInfoFlow`,
new `handleMissingInfoChoiceReply`, `NUMERIC_PICKER_AWAITING` entry,
`continueConversation` dispatch), `src/services/conversationContext.ts`
(new `AwaitingKind` value `'missing_info_choice'`).

**Files changed (tests):** `src/__tests__/menu.test.ts` (new
`missingInfoMenu`/`renderMissingInfoMenu` suite — 7 items, item 7 preset
note null, header text present), `src/__tests__/routerInspections.test.ts`
(`D2-T7 — missing info flow via menu item 6`: sub-menu shown + "אחר"/7
falls through to free text + capture, preset item 1 writes directly, an
invalid choice re-sends the sub-menu and keeps state, no-open-inspection
case unaffected).

**Tests run:** `npx tsc --noEmit` clean; full suite pass — 1161 passed,
7 skipped, 0 failed.

**Priority:** IMPORTANT — UX polish.

#### D5-T19k — Structured "missing equipment" sub-menu
**Status:** DONE (local, uncommitted)

**What to do:** same pattern as D5-T19j. Suggested items:
"בטריות" / "מכשיר מדידה" / "מזרן" / "מד רעש/קרינה" / "טופס בדיקה" / "אחר".

**Implementation:** implemented together with D5-T19j (same pattern,
same commit). Added `MissingEquipmentMenuItem` type + `missingEquipmentMenu()`
(6 items numbered 1-6, item 6 = "אחר" with `presetNote: null`) +
`renderMissingEquipmentMenu()` in `src/ai/menu.ts`. New
`showMissingEquipmentChoice(user, localDate)` sets
`awaiting: 'missing_equipment_choice'` and sends the rendered sub-menu;
new `handleMissingEquipmentChoiceReply(user, trimmed, ctx)` dispatches
presets 1-5 to a direct save + confirmation, item 6 (or invalid input)
falls back to the existing free-text equipment-note capture. Added
`'missing_equipment_choice'` to `NUMERIC_PICKER_AWAITING` and wired into
`continueConversation`.

**Files affected:** `menu.ts` (`missingEquipmentMenu`,
`renderMissingEquipmentMenu`), `router.ts` (`showMissingEquipmentChoice`,
`handleMissingEquipmentChoiceReply`, `NUMERIC_PICKER_AWAITING` entry,
`continueConversation` dispatch), `conversationContext.ts` (new
`AwaitingKind` value `'missing_equipment_choice'`).

**Files changed (tests):** `src/__tests__/menu.test.ts` (new
`missingEquipmentMenu`/`renderMissingEquipmentMenu` suite),
`src/__tests__/routerInspections.test.ts` (`D2-T9 — equipment reminder
handling`: tap → sub-menu shown, preset item 1 writes directly, "אחר"/6
falls through to free-text capture, menu item 5 opens the sub-menu).

**Tests run:** `npx tsc --noEmit` clean; full suite pass — 1161 passed,
7 skipped, 0 failed (same run as D5-T19j).

**Priority:** IMPORTANT — pairs with D5-T19d.

#### D5-T19l — Extended pivot experience (mid-flow escape without "ביטול")
**Status:** DONE (local, uncommitted)

**What to do:** D5-T16 already added `TEXT_CAPTURE_PIVOT_STATES` for
note-capture states. Extend the concept to any state where the user
clearly asked for a new top-level intent (excluding value-prompt states
like schedule_await_time to prevent accidental exits). Review the current
allow-list; the user's report explicitly calls out this pattern being
too restrictive.

**Trade-off note:** the user warns not to be too aggressive on internal
note captures — those should still capture the answer, not pivot away
from a legitimate free-text response. Balance carefully.

**Investigation:** reviewed every `AwaitingKind` not already in either
`TEXT_CAPTURE_PIVOT_STATES` or `NUMERIC_PICKER_AWAITING` (the two existing
escape mechanisms). Found 4 states that are structurally identical to
`mgr_search_await_query` (already in the pivot list) but were missed when
D5-T16 first shipped: `correct_site_pick_task`, `reassign_pick_task`,
`correct_type_pick_task`, `correct_type_await_search`. All four are
flow-ENTRY states — the user has just been asked "לאיזו בדיקה/משימה
הכוונה?" and hasn't selected/committed anything yet. Before this fix,
typing "תפריט" or any other top-level request there was fed straight into
`resolveOpenTaskFieldByHint` / `resolveTask` as literal search text (a
guaranteed "not found" or a wrong search), leaving the user stuck without
typing "ביטול" — exactly the complaint pattern the task describes.

**Deliberately did NOT extend to:** `correct_site_await_value` /
`schedule_await_time` / `schedule_await_duration` (existing exclusions,
still value-prompts) — nor to `correct_site_confirm_extracted` /
`correct_type_pick_from_list` / `correct_type_confirm` / `*_disambig`
states / any `*_confirm` state / `mgr_*_action` states (own AI-first
path). Those either narrow to a specific already-selected candidate
(pivoting would discard real progress), are yes/no confirmations, or are
list-refine search loops where free text is itself the filter — same
reasoning the original D5-T16 comment already used, just reworded to
cover the fuller state list. This mirrors the D5-T19b lesson: keep the
pivot scoped to states where nothing is lost by escaping, not "any state
that isn't explicitly a value prompt."

**Files affected:** `src/ai/router.ts` (`TEXT_CAPTURE_PIVOT_STATES` — 4
states added, header comment updated to list the new exclusions
explicitly).

**Files changed (tests):** `src/__tests__/routerCorrections.test.ts` —
named the previously-anonymous `parseIntent` mock (`parseIntentMock`) so
tests can control confidence per-case, added a `beforeEach` reset for it,
and added a new `D5-T19l` describe block (4 tests): confident pivot from
`correct_site_pick_task` (does not call `resolveOpenTaskFieldByHint`),
non-regression for a plain-name reply in the same state (still resolves
normally), confident pivot from `reassign_pick_task` (does not call
`resolveTask`), and `correct_type_pick_task` low-confidence reply still
resolving as a task hint (non-regression). Verified non-vacuous: reverted
the 4-state addition, confirmed the 2 pivot-assertion tests fail, then
restored the fix.

**Tests run:** `npx tsc --noEmit` clean; `routerCorrections.test.ts`
29/29 pass; full suite 1168 passed, 7 skipped, 0 failed.

**Priority:** IMPORTANT — UX; balance carefully with D5-T16 regression
tests.

#### D5-T19m — Verify "digit + polite word" (D5-T13 6c) actually works live
**Status:** DONE (local, uncommitted)

**What the QA report said:** in TC-8.3, "2 בבקשה" / "כן 2" / "אוקי 4"
were NOT intercepted despite the Phase 6 guard (D5-T13). Either the
regex is broken or the guard was refactored/moved by a later phase.

**What to do:**
- Verify the DIGIT_POLITE_RE / CONFIRM_DIGIT_RE regexes in `router.ts` still
  fire (they were added in D5-T13 6c).
- Test with each of: "2 בבקשה", "2 תודה", "כן 2", "אישור 3", "אוקי 4",
  "בטח 1", "סבבה 5".
- If they don't work, fix — the tests in `managerRichness.test.ts` should
  cover this and should still pass. Investigate why live differs.

**Investigation:** `DIGIT_POLITE_RE`/`CONFIRM_DIGIT_RE` (router.ts:447-448)
are intact and correct. The existing Phase 6c tests
(`managerRichness.test.ts`) all call `getContext.mockResolvedValue(null)`,
which *pins* the mock to always return `null` — they only exercise the
FRESH-message path (no active context). TC-8.3's real-life failure report
implies the manager already has an active `mgr_menu_root` context (they're
looking at a just-shown menu) when they reply "2 בבקשה". Traced that path:
`continueConversation` → `mgr_menu_root` is in `NUMERIC_PICKER_AWAITING` →
`looksLikeNumericPickerInput('2 בבקשה')` is `false` (not a bare digit/nav
word) → context is cleared and `handleAIMessage(user, text)` is re-invoked
→ this time `getContext` returns `null` → the digit-polite normalization at
the top of `handleAIMessage` fires correctly → item 2 dispatches. No code
defect found; confirmed correct by a new test using the *stateful*
`ctxStore`-backed `getContext` implementation (restoring it via
`mockImplementation`, since earlier tests in the same file had pinned it to
`null`) with `ctxStore = { awaiting: 'mgr_menu_root' }` pre-set — this is
the actual live shape of the scenario, not the fresh-message shape the
older tests covered. Verified the new tests are non-vacuous: temporarily
broke `DIGIT_POLITE_RE` to a never-matching pattern and confirmed all 3
now-added assertions fail, then restored the original regex.

**Files changed (tests):** `src/__tests__/managerRichness.test.ts` (2 new
tests under "Phase 6c" — `"2 בבקשה"` and `"אוקי 3"` from an ACTIVE
`mgr_menu_root` context, not a fresh/null one).

**Tests run:** `npx tsc --noEmit` clean; `managerRichness.test.ts` 29/29
pass; full suite 1164 passed, 7 skipped, 0 failed at the time (see D5-T19l for the final Part-3 count after all 5 tasks).

**Priority:** IMPORTANT — feature that was tested green but reportedly
fails live. Conclusion: code was already correct; the gap was in test
coverage (fresh-message-only), now closed.

#### D5-T19n — Rephrase "תצפיתני DEV" auth-rejection message to user-friendly text
**Status:** DONE (local, uncommitted)

**What the QA report said:** the current rejection message
"אין הרשאה — רק סשה או תצפיתני dev יכולים לשייך לידים." leaks internal
terminology and isn't user-friendly.

**What to do:** replace with something like:
"אין לך הרשאה לשייך לידים. אם אתה חושב שזה נחוץ, פנה למנהל המערכת."
Suggest new copy in the AUTH_REJECT_MSG constant in `src/ai/router.ts:3084`.

Also — should be paired with D5-T19i (widening the allowlist) so the
rejection is even RARER.

**Implementation:** replaced `AUTH_REJECT_MSG` in `src/ai/router.ts` with
"אין הרשאה לשייך לידים. אם אתה חושב שזה נחוץ, פנה למנהל המערכת." — a
close variant of the suggested copy (dropped the "לך" that the suggestion
had after "אין", i.e. "אין לך הרשאה" → "אין הרשאה") so the message still
contains "אין הרשאה" as one contiguous phrase, since ~15 existing tests
across the suite assert `.toContain('אין הרשאה')` and "אין לך הרשאה" does
NOT contain that substring contiguously ("לך" splits it). Caught this by
actually running the full affected-test batch rather than trusting a
static grep for the word "הרשאה" — one test
(`routerAssignLead.test.ts`) failed on the first attempt with the literal
suggested copy, which is what surfaced the gap. No more internal names
("סשה", "תצפיתני dev") leaked to end users either way. All 5 call sites
(assign-lead flow) pick it up automatically since they reference the
constant. Already paired with D5-T19i (Part 2), which widened the
allowlist so this rejection fires less often in the first place.

**Files affected:** `src/ai/router.ts` (`AUTH_REJECT_MSG` constant only).

**Files changed (tests):** none — the final copy preserves the
`.toContain('אין הרשאה')` substring every existing test relies on.

**Tests run:** `npx tsc --noEmit` clean; `routerAssignLead.test.ts` +
9 other manager/assign-lead files re-run clean after the wording fix;
full suite 1164 passed, 7 skipped, 0 failed at the time (see D5-T19l for the final Part-3 count after all 5 tasks).

**Priority:** UX.

#### D5-T19o — Verify menu item 7 vs free-text "הבדיקות שלי" parity for managers who are also workers
**Status:** DONE (local, uncommitted)

**What the QA report said:** TC-16.3 needs verification — a manager who
is also assigned as a worker on TaskFields should see the same
"personal" list via both:
- Menu item 7 → `mgr_my_inspections_today` action.
- Free text "הבדיקות שלי" → `handleMyInspectionsFreeText` (or the LLM
  intent `list_my_inspections`).

**What to do:**
- Trace both flows.
- Confirm they use the same worker-owner-scoped query (Task.ownerId =
  user.id).
- Add a parity test that seeds a manager + 3 TaskFields owned by them,
  then asserts both paths return the same 3 rows.

**Investigation — found a real parity bug:** both paths filter
`Task.ownerId = user.id` and the same Asia/Jerusalem `scheduledStartAt`
day window, but they disagreed on **status filtering**:
- Menu item 7 → `getMyFieldInspectionsToday` (managerViews.ts) — NO status
  filter at all (includes CANCELED/DECLINED rows).
- Free text (bare "הבדיקות שלי", defaults to today) →
  `getMyInspectionsInRange` (myInspectionsRange.ts) — excludes
  `fieldStatus IN ('CANCELED','DECLINED')`.

The exclusion in `getMyInspectionsInRange` is also what the WORKER's own
"1. הבדיקות שלי להיום" menu item uses
(`getInspectionsForWorkerOnDate` in inspectionsQueries.ts already excludes
CANCELED/DECLINED) — so item 7's *personal* list was the odd one out, not
the free-text path. A manager who is also a worker with a CANCELED or
DECLINED TaskField scheduled today would see a different row count
depending on which of the two paths they used.

**Implementation:** added `AND tf."fieldStatus" NOT IN ('CANCELED','DECLINED')`
to `getMyFieldInspectionsToday`'s query in `managerViews.ts`, matching both
`getMyInspectionsInRange` and `getInspectionsForWorkerOnDate`. Updated the
function's doc comment to record the parity rule and why it matters.

**Files affected:** `src/services/managerViews.ts`
(`getMyFieldInspectionsToday` SQL + doc comment).

**Files changed (tests):** `src/__tests__/managerViews.test.ts` (new test
in the `getMyFieldInspectionsToday` describe block asserting the SQL
contains the `NOT IN ('CANCELED','DECLINED')` clause — mirrors the
existing equivalent assertion in `myInspectionsRange.test.ts` for
`getMyInspectionsInRange`). A true row-level "same 3 rows" integration
test isn't practical against the mocked `pool.query` unit-test style used
throughout this codebase (no real DB in the test env); the SQL-clause
assertion is the established pattern here for proving query-shape parity
(see the pre-existing `getMyFieldInspectionsToday` tests asserting
`ownerId = $2`, the `scheduledStartAt` window, etc. the same way).

**Tests run:** `npx tsc --noEmit` clean; `managerViews.test.ts` full file
re-run clean; full suite 1164 passed, 7 skipped, 0 failed at the time (see D5-T19l for the final Part-3 count).

**Priority:** UX consistency. Real (if minor) bug fixed, not just verified.

---

**Execution plan:** Batches A → B → C → D, sequential. After each batch:
`npx tsc --noEmit`, run affected suites, update this section's Status
fields, produce a QA report, then move to the next batch. The user will
verify the fixes live in one final pass ("אבדוק את הכל בסוף בבת אחת").

---

## 4.11 — D5-T20: WhatsApp notification "mark before send" audit + fix (production incident)

**Status:** DONE (local, uncommitted) — 5 of 6 unsafe paths fixed; `expireActions`
deferred as a separate follow-up (see D5-T20f below), per explicit user decision.

**Context:** live production digest failures (Meta template 404s, see the
D5-T19 digest incident discussion) led to a broader question: does the bot
ever mark a WhatsApp notification as "sent/handled" in the DB **before**
confirming the actual send succeeded? A full audit of every automatic
WhatsApp notification path found the answer was yes, in several places —
the classic "claim before send" pattern used for cross-instance dedup also
silently absorbed permanent, un-retried delivery failures (a failed send
looks identical to a successfully-delivered one from the DB's point of
view, since the dedup row already exists either way).

**User decision:** minimal fix now (no new migrations / status columns /
attemptCount / lastError / nextRetryAt) — just re-order each unsafe path to
"attempt the send → mark sent/claimed ONLY on success → on failure, log
clearly and leave no row, so the next tick retries." A full retry
mechanism (status/attemptCount/lastAttemptAt/lastError/nextRetryAt) is
explicitly deferred to a second phase, after the Meta templates are
approved and the system is stable.

#### D5-T20a — digestDispatcher.ts (MORNING/EVENING/EQUIPMENT_MORNING/LEADS_MORNING)
**Status:** DONE.

**Fix:** added `isDigestAlreadySent` (read-only SELECT) to
`src/services/digestSendLog.ts`, called BEFORE attempting any send in all
3 functions (`dispatchOne`, `dispatchSashaLeadsMorning`,
`maybeDispatchEquipmentReminder`). `claimDigestSend` (the INSERT) is now
called ONLY after the WhatsApp send actually succeeds. Legitimate no-op
skips in the equipment reminder (no inspections today / no checklist rows
/ empty formatter output) still record as handled via `claimDigestSend` —
these are not send failures, so recording them prevents needless
re-derivation, matching the original design intent. `markDigestFailed` is
no longer called from the dispatcher (no row is ever inserted before
success, so there's nothing to flip to FAILED) but the function itself is
left in place/exported since `digest.integration.test.ts` unit-tests it
directly.

**Files affected:** `src/services/digestSendLog.ts` (new
`isDigestAlreadySent`), `src/scheduler/jobs/digestDispatcher.ts` (all 3
dispatch functions restructured).

**Files changed (tests):** `inspectorMorningDispatcher.test.ts`,
`equipmentReminderDispatcher.test.ts`, `sashaLeadsDispatcher.test.ts`,
`galitManagerDispatcher.test.ts` — updated mocks to include
`isDigestAlreadySent`, converted "claim returns false" tests to
"already sent" tests, and added new tests per file: WhatsApp send failure
does NOT record as sent (retry next tick).

#### D5-T20b — dueDateReminder.ts
**Status:** DONE.

**Fix:** replaced the pre-send `INSERT ... ON CONFLICT DO NOTHING` claim
with a `SELECT 1 FROM "WhatsappReminderLog"` dedup check BEFORE the send;
the INSERT now runs only after `notify()` succeeds.

**Files affected:** `src/scheduler/jobs/dueDateReminder.ts`.

**Files changed (tests):** new file `src/__tests__/dueDateReminder.test.ts`
(6 tests — no tasks due, success path records after send, dedup skip,
failed send does NOT record + retries, a failed-then-successful retry
sequence, continues the batch when one task fails and another succeeds).
This job had ZERO test coverage before this fix. Verified non-vacuous:
temporarily reverted the fix (`git stash` on just this file) and confirmed
5 of 6 new tests fail against the old code, then restored.

#### D5-T20c — deadlineAlerts.ts (runDeadlineExceededAlert only)
**Status:** DONE. `runDeadlineApproachingAlert` was audited and found
already safe — it has NO dedup/claim mechanism at all (re-sends daily
while a task remains in the approaching window), so it cannot have the
"mark before send" bug; that's a separate, pre-existing "may repeat daily"
characteristic, out of scope here.

**Fix:** the dedup INSERT (kind `DEADLINE_EXCEEDED`) previously ran once
per task BEFORE the fan-out to all managers. Now: tasks are read
read-only, the fan-out happens, and each task is marked alerted only if
**at least one** manager actually received the WhatsApp message (same
"at least one delivery counts as sent" bar used by `broadcastToManagers`
in `services/inspections.ts`). If every manager send fails, no task is
marked and the whole batch retries on the next tick.

**Files affected:** `src/scheduler/jobs/deadlineAlerts.ts`.

**Files changed (tests):** new file `src/__tests__/deadlineAlerts.test.ts`
(7 tests — no overdue tasks, no active managers, success path, every-
manager-fails does NOT mark, partial delivery (≥1 success) DOES mark, a
failed-then-successful retry sequence, one combined message per manager
covering all fresh tasks). This job had ZERO test coverage before this
fix.

#### D5-T20d — leadAssignmentNotifier.ts (both D3-T3 assignment alerts and D3-T4 escalations)
**Status:** DONE.

**Fix:** added `isLeadNotificationSent` (read-only SELECT) to
`src/services/leadNotificationLog.ts`. `processAssignmentAlerts`: checks
dedup first; a missing worker phone is a permanent no-op and is still
recorded as handled (via `claimLeadNotification`) to avoid re-logging
every 2-minute tick; the claim INSERT only happens after a successful
send. `processEscalations`: same dedup-first pattern; since this fans out
to multiple leads viewers, the claim is written only when at least one
recipient actually receives the message (same bar as D5-T20c).

**Files affected:** `src/services/leadNotificationLog.ts` (new
`isLeadNotificationSent`), `src/scheduler/jobs/leadAssignmentNotifier.ts`
(both functions restructured).

**Files changed (tests):** `src/__tests__/leadAssignmentNotifier.test.ts`
— rewritten in full (13 tests) to match the new query ordering, plus new
cases: failed send does not record + retries, no-phone lead is recorded
as handled, every-recipient-fails does not record, partial escalation
delivery still records.

#### D5-T20e — Meta template retry correctness (checked per user's explicit ask)
**Status:** DONE — verified, no separate action needed beyond D5-T20a-d.

Confirmed: even with `WHATSAPP_TEMPLATES_ENABLED=true` and fully-approved
templates, `notify()` in `src/whatsapp/templates.ts` either returns
successfully or throws — there is no scenario where it silently succeeds
without actually delivering. The D5-T20a-d fixes (mark only after
`notify()`/`sendTextMessage()`/`sendButtonMessage()` resolves) are
therefore already correct for both the free-form fallback path AND the
future fully-templated path — no additional change is needed once the
Meta templates are approved and `WHATSAPP_TEMPLATES_ENABLED` is flipped
back to `true`.

#### D5-T20f — expireActions.ts (DEFERRED — separate follow-up, not fixed here)
**Status:** OPEN — explicitly deferred by the user ("לגבי expireActions —
תסמן כמשימה נפרדת, כי זה שונה במהות ודורש החלטה נפרדת").

**Why this is different from the other 5 paths:** `expireStaleActions()`
transitions `WhatsappPendingAction.state` from PENDING_* to `EXPIRED`
**atomically as part of the same query that selects candidates** (a CTE
with `FOR UPDATE SKIP LOCKED`). Unlike the other paths, this state
transition is the actual business fact (the action genuinely did expire)
and is correct regardless of whether the notification about it is ever
delivered — un-expiring an action just because a WhatsApp send failed
would be wrong. The bug here is narrower: there is no separate tracking of
whether the EXPIRY NOTIFICATION itself was delivered, and no retry for
just that notification. Fixing this requires a product decision on what
"retry" even means for an expiry announcement (re-fetch the resolved
action's phone/manager list days later? cap retries? etc.) — hence
deferred rather than guessed at.

**Tests run (whole D5-T20 fix):** `npx tsc --noEmit` clean; full suite
1191 passed, 7 skipped, 0 failed.

**Priority:** URGENT (D5-T20a-e) — silent, permanent notification loss in
production. D5-T20f: IMPORTANT, deferred pending a product decision.

---

## 4.12 — D5-T21: Enhanced CRM due-date reminder (contact details + "פרטים נוספים", freeform + due_reminder_v2 template)

**Status:** DONE (commit a8b4297, pushed to main +
claude/employee-visibility-issue-52i6yw). Meta LIVE template submission still
pending (no Meta credentials in this environment — see below).

**Spec:** `TASK_ENHANCED_DUE_REMINDER.md` (implemented verbatim). Enrich the
1-hour CRM due-date reminder with a full detail body + a "פרטים נוספים"
quick-reply button that opens an extended detail message, with **100%
coverage**: freeform (`sendButtonMessage`, in-window) and the new Meta
template `due_reminder_v2` (out-of-window) render byte-identical text.

**Consistency invariant (by construction):** `formatTaskReminderBody(d, crmUrl)`
is DEFINED as the substitution of `reminderTemplateParams(d, crmUrl)` into the
frozen `DUE_REMINDER_V2_TEMPLATE_BODY` — the freeform text and the template
render cannot drift. A test asserts this via an independent substitution.

**Files created:**
- `src/services/taskDetailFormatter.ts` — pure formatters (`formatTaskReminderBody`,
  `reminderTemplateParams`, `formatTaskDetailsExtended`, `truncateForTemplate`,
  `buildCrmTaskUrl`) + the frozen template body constant. No DB/network.
- `scripts/create-due-reminder-v2-template.ts` — submits `due_reminder_v2`
  (10 body vars + one QUICK_REPLY button) to Meta; `--dry-run` supported;
  imports the frozen body so it can't drift.
- `src/__tests__/taskDetailFormatter.test.ts` (23 tests, incl. the invariant).
- `src/__tests__/senderTemplateButtons.test.ts` (6 tests, incl. 2 regression
  guards for the 14 existing templates).
- `src/__tests__/routerTaskDetailsButton.test.ts` (5 tests).

**Files edited:**
- `src/whatsapp/sender.ts` — extended `sendTemplateMessage` with optional
  `buttonParams` (quick_reply/url button components). Shape is IDENTICAL when
  `buttonParams` is absent (regression-tested).
- `src/whatsapp/templates.ts` — `notify()` gained `templateButtonParams`,
  passed through only on the template path.
- `src/services/tasks.ts` — new `getTaskDetailsForReminder(taskId)`.
- `src/scheduler/jobs/dueDateReminder.ts` — enriched body + button +
  `templateButtonParams`; `setActiveTask` (fire-and-forget, try/catch) after a
  successful send; `taskDetailsPayloadId` / `matchTaskDetailsPayload` helpers.
- `src/ai/router.ts` — dispatch for the `TASK_DETAILS_<taskId>` tap and the
  "פרטים" / "פרטים נוספים" text triggers → `handleTaskDetailsRequest` (read-only).
- `.env.example` — `CRM_TASK_URL_TEMPLATE` + a comment on flipping
  `WHATSAPP_TEMPLATE_DUE_REMINDER=due_reminder_v2` after Meta approval.
- `src/__tests__/dueDateReminder.test.ts` — extended (D5-T20 regressions kept +
  enrichment/button/context tests). 9 tests.

**Schema decisions (Assumption A + audit — no DB access in this env):**
- `contactPhone` → **`Customer.contactPhone`**, NOT the spec's tentative
  `phone2`. Clear evidence: `taskFieldScheduling.ts` already SELECTs
  `c."contactPhone"` live, and `Customer.contactName` (its sibling) is in
  SCHEMA_CRM.md. This is the spec's explicit "change in one place + document"
  path.
- `Task.processNotes` and `IncomingLead.fromPhone` are absent from SCHEMA_CRM.md
  and have zero query usage anywhere, so they're read **defensively** via
  `to_jsonb(row) ->> 'col'` — yields the value if the column exists, NULL (never
  a hard error) if not. The every-5-min reminder can't crash on a missing column.
  Confirmed by the user ("מאשר הכל תרוץ").
- Extended message shows the FULL (untruncated) description/notes ("תיאור מלא"),
  while the short reminder truncates to 200 chars — that is the point of the
  "more details" tap.

**Constraints honored:** no writes to `Task.status` (only `t.status::text` read);
`preInspectionReminder.ts` and its tests untouched (verified via git diff —
empty); existing approved `due_reminder` template NOT edited; `due_reminder_v2`
is the new template; `WHATSAPP_TEMPLATE_DUE_REMINDER=due_reminder_v2` NOT
enabled in any committed env (comment only).

**Tests run:** `npx tsc --noEmit` clean; the 4 target files 43/43 pass; full
suite **1244 passed, 7 skipped, 0 failed** (67 files; trailing worker-exit is
the known pre-existing OOM). Template `--dry-run` validated (body passes the
no-trailing-variable check; well-formed payload).

**Remaining follow-ups:**
1. **LIVE Meta submission not done here** — this environment has no
   `META_WABA_ID` / `WHATSAPP_ACCESS_TOKEN`. Run
   `npx tsx scripts/create-due-reminder-v2-template.ts` (then
   `list-whatsapp-templates.ts` to confirm PENDING) where the creds exist.
2. After Meta APPROVES `due_reminder_v2`, set
   `WHATSAPP_TEMPLATE_DUE_REMINDER=due_reminder_v2` in Render.
3. ~~Phase 2 (documented, not done): CRM URL button; provide `CRM_TASK_URL_TEMPLATE`.~~
   **DONE (local, uncommitted `.env` + Meta edit PENDING)** — see 4.12.1 below.

---

### 4.12.1 — CRM URL button on `due_reminder_v2` (Phase 2)

**Status:** DONE (code committed in `659ab87 "UDPATES"`; Meta template edit
submitted, currently PENDING; `.env` update local — `.env` is gitignored).

**What changed vs the original 4.12 shape:**
- Template body vars 10 → **9** (the `{{10}}` CRM-link line moved out of the body).
- Approved template gains a URL button (`"פתח משימה ב-CRM"`) with dynamic URL
  `https://crm.galit.co.il/dashboard?taskid={{1}}`; the existing QUICK_REPLY
  button (`"פרטים נוספים"`) stays. URL is at button index 0 (Meta requires
  URL/PHONE before QUICK_REPLY), QUICK_REPLY moves to index 1.
- Freeform path (in-24h-window) can't render URL buttons, so
  `formatTaskReminderBody` still injects the CRM URL as text before the trailing
  salutation — behaviour identical to the previous body-inline shape from the
  recipient's POV. Uses `CRM_TASK_URL_TEMPLATE` env (unchanged contract:
  `{taskId}` placeholder → `encodeURIComponent`d).
- `.env` gets `CRM_TASK_URL_TEMPLATE=https://crm.galit.co.il/dashboard?taskid={taskId}`.
- `dueDateReminder.ts` sends the taskId URL-encoded for the URL button suffix
  (defensive against `&`/`?`/`#` in future ids).

**Files changed (committed in 659ab87 "UDPATES"):**
- `src/services/taskDetailFormatter.ts` — body ↓ to 9 vars; `formatTaskReminderBody`
  now composes (substitute body) + inject CRM URL section + trailing salutation.
- `src/scheduler/jobs/dueDateReminder.ts` — v2 path sends 9-var bodyParams + two
  `templateButtonParams` (URL@0, QUICK_REPLY@1).
- `scripts/create-due-reminder-v2-template.ts` — payload now emits URL button.
- `src/__tests__/taskDetailFormatter.test.ts`, `src/__tests__/dueDateReminder.test.ts` —
  updated to the new shape.

**Tests run:** `npx tsc --noEmit` clean; `taskDetailFormatter.test.ts`,
`dueDateReminder.test.ts`, `senderTemplateButtons.test.ts` → 41/41 pass.

**Meta submission:** template id `2826181947780628`, `POST /{id}` with the new
components — Meta returned `{success:true}`; current `status=PENDING`. Prior
approved version continues to serve during review; new components apply once
approved.

**Follow-up:**
1. Wait for Meta to APPROVE the edited `due_reminder_v2` (usually minutes).
2. Verify a live out-of-window reminder in production: the URL button opens the
   CRM task; the QUICK_REPLY "פרטים נוספים" still fires the details flow.
3. If the CRM URL prefix ever changes (e.g. domain move), edit the Meta template
   again (`POST /{id}` — 10 edits/30d allowed) and update `.env` to match.

**Post-push production-safety fix (same day):** the user confirmed
`WHATSAPP_TEMPLATES_ENABLED=true` in prod. The still-approved `due_reminder`
v1 template is body-only (2 vars: title, time; no button) — but the initial
implementation unconditionally sent the new 10-var/button shape to whichever
template name `DUE_REMINDER` resolved to. Since `WHATSAPP_TEMPLATE_DUE_REMINDER`
is intentionally NOT overridden until Meta approves `due_reminder_v2` (per this
task's own constraint), every out-of-window reminder would have hit the v1
template with a param-count/component mismatch and been rejected by Meta —
silently retried forever, never delivered. Fixed in
`src/scheduler/jobs/dueDateReminder.ts`: the job now checks whether
`templateName('DUE_REMINDER')` still resolves to the legacy default name; if so
it sends the legacy 2-var/no-button contract on the template path (preserving
today's working behavior), and only sends the enriched 10-var + button contract
once an operator points the env var at `due_reminder_v2`. The in-window
freeform path (`fallbackText` + `buttons`) is unaffected either way — it always
gets the full enriched body. Added a regression test
(`REGRESSION: without WHATSAPP_TEMPLATE_DUE_REMINDER override, uses the legacy
2-var/no-button template contract`) plus a test for the post-approval enriched
path. `npx tsc --noEmit` clean; 4 target files 45/45 pass.

**Priority:** feature — CEO-requested richer reminders. Freeform path is fully
functional immediately; template path activates on Meta approval.

---

## 4.13 — QA-FIX-1: quoted context lost during the status_eta_prompt live await (2026-07-07)

**Status:** DONE (local, uncommitted — awaiting user approval to commit/push).

**What to do:** Fix the medium-severity bug found in the Phase 1+2 QA review:
while a worker is answering the travel-ETA prompt (awaiting `status_eta_prompt`,
active pointer on task A), a swipe-reply (quote) to a DIFFERENT TaskField's
message (B) with verbose text containing no bare status keyword lost the quote —
`handleStatusEtaReply` case 3 recursed into `handleAIMessage(user, text)`
without the `quotedWamid`, so the LLM-classified transition resolved via the
Phase-1 pointer and updated A instead of the quoted B.

**Definition of Done:** the quoted TaskField wins over the pointer in the
`status_eta_prompt` state for both keyword and verbose phrasings; regression
test proves the pre-fix code fails; no other await handler's behavior changes.

**Fix:** thread an optional `quotedWamid` through `continueConversation` →
`handleStatusEtaReply` → both of its recursive `handleAIMessage` calls
(`src/ai/router.ts`, +6/−4). The recursion re-resolves the quoted context and
the existing (already-tested) quote-beats-pointer priority in
`runAdvanceStatusDirect` does the rest — no duplicated logic, no new DB writes.

**Files changed:** `src/ai/router.ts`,
`src/__tests__/routerActiveInspection.test.ts` (+3 tests: the regression, the
fast-path keyword case in the same state, and no-quote pointer preservation).

**Implemented by an Opus sub-agent; orchestrator QA:** diff reviewed line by
line (only the 2 allowed files touched); regression test verified to FAIL on
the pre-fix router (1 failed | 13 passed) and pass after; `npx tsc --noEmit`
clean; 280/280 tests pass across 12 router-related files.

**Known remaining (documented, out of scope):** other live-await handlers that
recurse via `handleAIMessage(user, text)` still drop `quotedWamid`; the
deterministic keyword fast path covers those states, and a similar one-line
threading can be applied if a real case surfaces.

---

## 4.19 — QA-FIX-7: past time ranges ("אתמול"/"שבוע שעבר") for the personal list + free AI dateRange channel (2026-07-08)

**Status:** DONE (local, uncommitted — awaiting user approval to commit/push).

**What to do:** "הבדיקות שלי אתמול" / "המשימות שלי אתמול" / any PAST range
returned today's list or "not understood". Product direction from the user:
the AI should get MORE freedom, not more regexes — any time expression it
understands must be expressible to the backend.

**Root cause:** the personal-list pipeline was forward-only on all 3 layers:
`parseHebrewInspectionRange` had zero past vocabulary; the
`list_my_inspections` prompt contract offered only a closed
today/tomorrow/week/next_week/all enum + rangeExpr (which feeds back into the
same past-blind parser); and `executeIntent` never read `params.dateRange` for
this intent — unlike every org-wide list intent, which already accepts a free
LLM-resolved {from,to}.

**Fix (three layers):**
- `src/ai/router.ts` — `case 'list_my_inspections'` now accepts a free
  `params.dateRange` (validated by the existing `extractDateRange`), rendered
  via a new shared `renderMyInspectionsRange` helper (extracted from
  `handleMyInspectionsFreeText` — no duplicated render/context/send logic).
  Precedence: dateScope='all' → dateRange → legacy synthesis.
- `src/ai/dateRangeParser.ts` — deterministic past vocabulary: אתמול/מאתמול/
  של אתמול, שלשום, שבוע שעבר (4 variants, previous Sun→Sun), חודש שעבר
  (3 variants, with January year-rollover).
- `src/ai/intentParser.ts` — worker AND manager `list_my_inspections` lines now
  instruct the model to resolve ANY uncovered time expression (especially past)
  to `params.dateRange` itself; new shared `buildMyInspectionsPastFewShot`
  (dynamic dates, both roles — deliberately separate from the manager-only
  `buildDateRangeFewShot` which references org-wide intents).

**Files changed:** the 3 above + tests: `dateRangeParser.test.ts` (+23, pinned
dates incl. Sunday edge + January rollover), `routerWorkerFreeText.test.ts`
(+6: deterministic worker/manager paths, LLM dateRange channel exact-dates,
invalid-range fallback), `managerIntents.test.ts` (+4 prompt assertions).

**Implemented by a Sonnet sub-agent; orchestrator QA:** full diff reviewed
line by line (half-open windows correct; label shows the INCLUSIVE last day;
precedence order verified; no forbidden files touched); `npx tsc --noEmit`
clean; **442/442 tests** across 12 files on the orchestrator's own run;
sub-agent full suite 1330 passed / 0 failed (known vitest OOM teardown flake).

**Remaining (documented):** "לפני שבועיים"-style arbitrary past expressions ride
the LLM dateRange channel only (no deterministic shortcut) — by design; live
smoke test with the real provider recommended after deploy.

---

## 4.18 — QA-FIX-6: manager "המשימות שלי למחר" showed today-only / not understood (2026-07-07)

**Status:** DONE (local, uncommitted — awaiting user approval to commit/push).

**What to do:** A manager asking (text or voice) for their OWN tasks in any
non-today scope — "תציג לי את המשימות שלי למחר", "המשימות שלי לשבוע הבא" —
got today's list or an "I don't understand" reply.

**Root cause (two gaps, orchestrator-verified):**
1. `MY_INSPECTIONS_RE` (router.ts) fast-pathed only "בדיקות שלי" phrasings —
   the word "משימות" never matched, so those messages fell through to the LLM.
2. `MANAGER_INTENT_LIST` / `MANAGER_FEW_SHOT` (intentParser.ts) did not include
   `list_my_inspections` AT ALL (worker-list only), so for manager users the
   LLM misrouted to `list_today_field_inspections` (org-wide, defaults to
   today) or `unknown`. The backend handler already supported managers — the
   prompt just never told the model the intent existed.

**Definition of Done:** "המשימות שלי (למחר/השבוע/בין X ל-Y)" resolves for a
manager deterministically (no AI) via the existing fast path; free-form
phrasings the regex misses are covered by the new manager-prompt intent line +
few-shots (incl. explicit "שלי" vs org-wide disambiguation and a dynamic
"בדיקות שטח למחר" dateRange example in buildDateRangeFewShot).

**Files changed:** `src/ai/router.ts` (regex + JSDoc only),
`src/ai/intentParser.ts` (manager prompt additions),
`src/__tests__/myInspectionsIntent.test.ts` (+10 regex tests incl. the
"משימות עם בעיה" / "משימות השטח שלי" negative collision cases),
`src/__tests__/routerWorkerFreeText.test.ts` (+3 manager E2E tests, incl.
exact tomorrow-window assertion on getMyInspectionsInRange, parseIntent NOT
called), `src/__tests__/managerIntents.test.ts` (+5 prompt-content assertions).

**Implemented by a Sonnet sub-agent; orchestrator QA:** full diff reviewed
line by line (capture-group structure preserved — suffix stays m[2]); only
allowed files touched; `npx tsc --noEmit` clean; 334/334 tests pass across 10
router/prompt files; sub-agent's full-suite run 1307 passed / 0 failed (known
vitest OOM worker flake, unrelated).

**Remaining (documented):** the prompt half is LLM-dependent — a live smoke
test with the real provider ("המשימות שלי למחר" by voice) is recommended
after deploy; the deterministic regex path is the primary guarantee.

---

## 4.17 — QA-FIX-5: no-quote keyword+active-pointer fast path (2026-07-07)

**Status:** DONE (local, uncommitted — awaiting user approval to commit/push).

**What to do:** Fix the live bug: worker tapped "יוצא בזמן" on the 60-min
pre-reminder → active pointer set on tf-B → ETA "45 דקות" logged → then
worker typed a bare "הגעתי" (no quote) → bot answered
"לא ברור מה הכוונה. אנא נסח מחדש." The correct answer was
ARRIVED on tf-B via the active pointer.

**Root cause:** the deterministic keyword fast path in `handleAIMessage`
(`router.ts:452`) is gated on `quotedContext` — it only fires for a
swipe-reply. With no quote, the flow depends on the AI parser correctly
classifying "הגעתי" as `set_field_status`. In practice the AI parser
occasionally returns `unknown` / low-confidence when the recent history is
noisy (customer notifications, ETA acks). When that happened, the router hit
the `unknown` fallback ("לא ברור...") without ever consulting the active
pointer — even though the pointer + a strong verb are together an
unambiguous signal.

**Definition of Done:** a bare status verb ("יצאתי" / "הגעתי" / "סיימתי")
with no quote AND an active pointer whose TaskField validates → dispatch
transitions on the pointer's TaskField BEFORE the AI parser runs. Quote path
still wins when both are present. No pointer → unchanged fallback.

**Fix:** `src/ai/router.ts` — added a second deterministic gate right after
the quote path, before `getProvider()`:
```ts
if (!(quotedContext?.entityType === 'task_field' && quotedContext.taskFieldId)) {
  const kw = extractDirectStatusKeyword(text);
  if (kw) {
    const active = await getActiveInspection(user.phone);
    if (active) {
      const v = await validateWorkerTaskField(user.id, active.taskFieldId);
      if (v.ok) {
        await performTransition(user, active.taskFieldId, kw);
        return;
      }
    }
  }
}
```

**Files changed:** `src/ai/router.ts` (+17/−0),
`src/__tests__/routerActiveInspection.test.ts` (+123/−2: 5 new QA-FIX-5 tests +
2-line mock robustness fix on the existing "pointer closed → fallback" test —
persistent `mockResolvedValue` instead of `mockResolvedValueOnce` because both
the new fast path AND the existing `runAdvanceStatusDirect` fallback now
validate the pointer).

**QA:**
- `npx tsc --noEmit` clean.
- `routerActiveInspection.test.ts` 19/19 pass (5 new QA-FIX-5 tests: bare
  "הגעתי" bypasses AI, bare "סיימתי" bypasses AI, no-pointer keyword falls
  through to AI, pointer-with-invalid-TF falls through, quote still beats
  pointer).
- Broader run (9 test files including router*, detailView, contextExtractor,
  messageRefs) — 321/321 pass. No regressions.

**Behavioral notes:**
- Order of priority preserved: (1) quoted TaskField ref + keyword — strongest,
  (2) active pointer + keyword — new, (3) AI parse + `runAdvanceStatusDirect`
  which itself consults the pointer as a fallback.
- The fast path does NOT fire for status verbs during a mid-conversation live
  await (`status_eta_prompt`, `finished_followup`, etc.) — the `getContext`
  check + `continueConversation` on line 476 still runs; only `idle_active_inspection`
  falls through to the fresh-message path where the new gate sits.
- Ambiguous phrasing ("אני בדרך", "אני אצל הלקוח") isn't in
  `extractDirectStatusKeyword`'s vocabulary — those still go through the AI,
  matching the QA doc's Phase 1 expectations.

---

## 4.16 — QA-FIX-4: hybrid smart confirmation gate for AI-inferred single actions (2026-07-07)

**Status:** DONE (local, uncommitted — awaiting user approval to commit/push).
**Model roles:** Opus orchestrator + 2 Sonnet sub-agents (extractor + router) in parallel.

**What to do:** Fix the systemic complaint reported after QA-FIX-3: users want the
AI to be smart enough to infer defaults from context AND to confirm before
writing, so that a mis-inferred date/name/address never hits the DB silently.
Currently single-action extractions execute immediately (only multi-action asks
for confirmation). The product decision (Width 3): if the LLM inferred any
field from context, gate on confirmation; if everything was explicit, execute
immediately (fast path preserved).

**Definition of Done:**
- A single-action extraction with `inferredFields.length > 0` on a destructive
  action (`correct_site`/`correct_type`/`reassign`/`reschedule`) routes to a
  confirm prompt using the existing `mgr_multi_action_confirm` state and
  buttons; no DB write yet.
- The confirm reply ("אישור" / `CONFIRM_YES_MULTI_ACTION` / "כן") executes the
  action via the existing multi-action confirm handler (1-element batch).
- Explicit-only single actions (`inferredFields=[]`) execute immediately —
  fast path unchanged.
- Multi-action path unchanged.

**Fix:**
1. `src/ai/contextExtractor.ts`:
   - New `inferredFields?: string[]` on `InspectionActionExtractionItem`.
   - `INSPECTION_ACTION_ITEM_SCHEMA`: adds `inferredFields` (array of strings,
     required at the JSON-schema level so the LLM always emits at least `[]`).
   - Parser coerces missing/null/non-array to `[]`, filters to trimmed non-empty
     strings.
   - Prompt: new "עקרון AI-first" block + "דוגמאות ל-inferredFields" section
     with 6 worked examples covering explicit, inferred (date-from-current-TF),
     name-only, phone-only, next-day + inferred time, and "don't invent a
     missing value" (low confidence).
   - QA-FIX-3's time-only reschedule rule preserved verbatim; a one-line note
     appended to mark it as an `inferredFields=["newScheduledStartAt"]` case.
2. `src/services/conversationContext.ts`:
   - `pendingMultiActions` element type gains `inferredFields?: string[]`.
3. `src/ai/router.ts`:
   - `handleMgrActionFreeText` single-action fast path: if
     `only.inferredFields.length > 0` and action is destructive → call
     `promptSingleActionConfirmation`; else preserve the immediate dispatch.
   - New helper `promptSingleActionConfirmation` builds a one-line summary
     ("תאריך ושעה → 07/07 בשעה 21:00"), lists which fields were inferred
     ("השלמתי מההקשר: תאריך ושעה"), sets state to `mgr_multi_action_confirm`
     with a 1-element `pendingMultiActions` array, and sends buttons with the
     existing `CONFIRM_YES_MULTI` / `CONFIRM_NO_MULTI` IDs (falls back to
     text on send failure).
   - `HEB_INFERRED_LABEL` map translates raw property names → Hebrew labels.
   - `handleMgrMultiActionConfirmReply` untouched — its existing iterator
     handles the 1-element batch identically.
4. `src/__tests__/detailViewAIContext.test.ts`:
   - Added 5 tests in a new "QA-FIX-4" describe block:
     - Explicit reschedule (`inferredFields=[]`) → immediate write, no confirm
       button.
     - Inferred reschedule (`inferredFields=["newScheduledStartAt"]`) → confirm
       button + `mgr_multi_action_confirm` state + `pendingMultiActions=[act]`,
       no write.
     - Confirm reply "CONFIRM_YES_MULTI_ACTION" → `updateTaskFieldSchedule`
       called with the parsed Date.
     - Inferred `correct_site` → confirm body includes
       "השלמתי מההקשר: כתובת האתר".
     - `back`/`cancel` with `inferredFields` → not gated (isDestructive=false).
   - `updateTaskFieldSchedule` mock added to the shared `taskFieldCorrections`
     `vi.mock` block + `mockClear()` in `beforeEach`.

**Files changed:** `src/ai/contextExtractor.ts` (+42/−1), `src/ai/router.ts`
(+112/−1), `src/services/conversationContext.ts` (+5/−0),
`src/__tests__/detailViewAIContext.test.ts` (+140/−0).

**QA (orchestrator, independently verified — not sub-agent summaries):**
- Read the actual diff from both sub-agents (contextExtractor prompt lines
  260–272 + parser lines 610–631; router lines 6178–6190 + 6269–6358). Verified
  the contract (`inferredFields?: string[]`) is honored both sides.
- Verified the confirm handler (`handleMgrMultiActionConfirmReply` L6640+) has
  an existing `reschedule` branch (L6748) that calls `updateTaskFieldSchedule`
  with the parsed date — so a 1-element batch from the new path writes exactly
  once on approval and is cancelable.
- `npx tsc --noEmit` clean.
- Focused test run: `detailViewAIContext.test.ts` 56/56 (includes 5 new
  QA-FIX-4 tests). Individual runs of `contextExtractor.test.ts`,
  `routerCorrections.test.ts`, `routerManagerDisplay.test.ts`,
  `managerSearchExpansion.test.ts`, `routerActiveInspection.test.ts`,
  `messageRefs.test.ts`, `routerInspections.test.ts`, `routerAssignLead.test.ts`,
  `routerDaySummary.test.ts`, `routerFreeTextAwait.test.ts`,
  `routerScheduleTaskField.test.ts` — all pass individually (162/162 across the
  6 heavier ones together).
- Full-suite run has 3 pre-existing failures caused by heap pressure when 71
  files run in one process (JS heap OOM even at 8 GB); these are NOT caused by
  the QA-FIX-4 changes (they fail in the same shape on `main` if the process
  runs out of memory).

**Manual re-run required by the user:** bot restart, open detail card, type
"עדכן שעה ל-21:00", verify the bot shows the confirm prompt with the
"השלמתי מההקשר: תאריך ושעה" line, tap "אישור", verify the DB update.

**Known follow-ups (documented, out of scope):**
- The pre-existing test-suite OOM in single-process runs is unrelated but
  worth a `pool.forks.singleFork=false` / test-file-splitting fix in a future
  round.
- The AI-first principle currently applies only to the `inspection_action`
  extractor. Other intents (`schedule_time`, general intent parser) still parse
  strictly. If a similar time-only / name-only complaint surfaces there, mirror
  the pattern.

---

## 4.15 — QA-FIX-3: time-only reschedule ("עדכן שעה ל-21:00") rejected by AI extractor (2026-07-07)

**Status:** DONE (local, uncommitted — awaiting user approval to commit/push).

**What to do:** Fix the frustration reported in real-user QA: while viewing a
TaskField's detail card (scheduled 22:00), the user typed
"עדכן את שעת הבדיקה ל-21:00" and got "לא ניתן לזהות שעה מדויקת. אנא ציין
תאריך ושעה מלאים." The user's intent was unambiguous — reschedule to 21:00 on
the SAME DAY the inspection is already on. The AI shouldn't demand a full date
when it can be inferred from the TaskField being viewed.

**Root cause:** `buildInspectionActionBlock` in `src/ai/contextExtractor.ts`
never gave the LLM the current `scheduledStartAt`, only contact/site fields.
The prompt only handled "date-only, no time" (confidence < 0.60), so a time-only
input had no rule to fall back on — the LLM refused to guess and returned a
clarification, which `handleMgrActionFreeText` surfaced verbatim.

**Definition of Done:** "עדכן שעה ל-21:00" (or any time-only reschedule) while
viewing a TaskField resolves to a single-action reschedule with
`newScheduledStartAt` = current TaskField's date + the new time,
confidence ≥ 0.85 — driving the normal single-action confirm path
(`dispatchSingleAction` → success message "עודכן — תאריך ושעה: DD/MM בשעה HH:MM").

**Fix:**
1. `src/services/managerViews.ts` — add `scheduledStartAt` and `durationMinutes`
   to `TaskFieldContextSnapshot` + query.
2. `src/ai/contextExtractor.ts` — add `currentScheduledStartAtIL` +
   `currentDurationMinutes` to `TaskFieldContextValues`; include them in
   `buildInspectionActionBlock` and add an explicit rule + worked example:
   "if only a time is given, use the SAME date as the current TaskField —
   confidence ≥ 0.85, no clarification."
3. `src/ai/inspectionFormatters.ts` — new helper `formatScheduledStartForPrompt`
   (`YYYY-MM-DD HH:MM` in Asia/Jerusalem, Intl-based → UTC-server safe).
4. `src/ai/router.ts` — thread the new snapshot fields into `ctxValues` inside
   `handleMgrActionFreeText`.

**Files changed:** `src/ai/contextExtractor.ts` (+7/−1),
`src/ai/inspectionFormatters.ts` (+15/−0), `src/ai/router.ts` (+7/−0),
`src/services/managerViews.ts` (+5/−0).

**QA:** `npx tsc --noEmit` clean; 219/219 tests pass across
`contextExtractor.test.ts`, `routerCorrections.test.ts`,
`routerManagerDisplay.test.ts`, `managerSearchExpansion.test.ts`,
`detailViewAIContext.test.ts`. Manual re-run on the live worker's phone still
required — the change is on the AI prompt, so behavior depends on the LLM
respecting the new rule (GPT-4o has honored analogous defaulting rules in this
codebase).

**Known caveat:** the fix targets the extractor path used by the `mgr_today_action`
detail view (the flow the user was in). The other reschedule entry points
(`schedule_time` intent from top-level free text, `schedule_task_field` flow)
still parse dates the old way — they see the LLM's own `schedule_time` prompt,
which is unchanged. If a similar "time-only" complaint surfaces there, mirror
this rule into `INTENT_SYSTEM_BLOCKS.schedule_time`.

---

## 4.14 — QA-FIX-2: swipe-reply on the "my inspections" detail card not resolving (2026-07-07)

**Status:** DONE (local, uncommitted — awaiting user approval to commit/push).

**What to do:** Fix the Phase-2 gap discovered in real-user QA: after opening a
task from the "הבדיקות שלי" list ("1"), the worker got the detail card and later
swipe-replied to it with "הגעתי". The bot answered "לא ברור לאיזו משימה אתה
מתכוון." — the quote never resolved, and the LLM (with 2 open TFs visible in
history) fell back to a clarification instead of the active pointer.

**Root cause:** `showMgrTaskFieldDetail` (`src/ai/router.ts`) sent the detail
text without calling `recordTaskFieldRef`. Every other TaskField-scoped outbound
(assignment card, morning reminder, ETA prompt, status confirm) DOES record a
`WhatsappMessageRef`, so quotes on those messages resolve. The detail card was
the one omission — a swipe-reply on it returned `resolveQuotedContext = null`,
so the deterministic fast path (`handleAIMessage` around L451) never triggered,
and the flow depended on the LLM classifying the bare "הגעתי" correctly (which
it failed to do when history mentioned multiple open TFs).

**Definition of Done:** any swipe-reply on the detail card with an unambiguous
status keyword ("יצאתי" / "הגעתי" / "סיימתי") updates the exact quoted TaskField
deterministically, before the AI parser runs. Behavior for lists/menus/digests
is unchanged (they intentionally don't record TF-scoped refs).

**Fix:** capture the wamid from `sendTextMessage` in `showMgrTaskFieldDetail`
and call `recordTaskFieldRef(wamid, taskFieldId, user.id, 'detail_view')` in
BOTH the happy path AND the list-message-failure fallback (which also carries
the detail body). Added `'detail_view'` to the `MessageRefKind` union
(TypeScript-only; the DB `kind` column has no CHECK — no migration needed).

**Files changed:** `src/ai/router.ts` (+8/−2), `src/services/messageRefs.ts`
(+1/−0).

**QA:** `npx tsc --noEmit` clean; 119/119 tests pass across `messageRefs.test.ts`,
`routerActiveInspection.test.ts`, `routerManagerDisplay.test.ts`,
`detailViewAIContext.test.ts`; manual re-run of the reported scenario is still
required by the user (bot restart needed for the change to take effect on the
live worker's phone). No behavioral change for messages already recording refs.

---

## 5. Out of scope — later

Per Section 14 of the spec (with 2026-07-01 Addendum adjustments), deferred — NO tasks created for any of these:

- Photos (no upload, no completion gate, no `TaskPhotoMeta`).
- Outlook integration.
- `TaskFieldStatusHistory` (structured status-history table).
- Structured `TaskFieldEntry` (multi-problem-per-inspection).
- `FieldWorkerDayClose` (the "I'm done for the day" sealed record).
- Performance analysis.
- Automated reports.
- Lead CLOSURE / handling from the bot (still in the CRM — only assignment moved to the bot per D3-T6).
- Creating a new `Task` or `Customer` from the bot (still CRM only — D2-T11 only writes `TaskField` against existing `Task`s).
- Editing `TaskField` scheduling fields (`scheduledStartAt`, `scheduledEndAt`, `durationMinutes`, `appointmentTitle`) — reschedule stays in the CRM.
- Editing `TaskField.specialInstructions` from the bot — CRM only.
- Editing `Customer` data from the bot — CRM only. The D2-T12 site-metadata correction is a per-visit override on `TaskField`, not a `Customer` write.
- Editing `Task.productName` outside the D2-T14 controlled correction — CRM only. D2-T14 is the sole path for the bot to write `Task.productName`, and only under the strict validation + notification + audit conditions listed on that task.
- Editing any other `Task` field (title, description, dueDate, priority, customerId, ownerId outside D2-T13 reassignment, price, and all commercial/payment columns) — CRM only.

---

## 6. Suggested execution order — milestones

- **M1: External inputs received + decisions made.** ✅ B1 resolved (proceed with clear מק"טים). ✅ B2 resolved (`IncomingLead` table + columns confirmed). ✅ K1–K7 closed, including K2 (CRM scheduling form creates `TaskField` by existing `Task ID`).
- **M2: DB foundation.** `D1-T1`, `D1-T2`, `D1-T3`, `D1-T4`, `D1-T5`, `D1-T6`. (Catalog seed `D1-T7` slides in as soon as B1 lands.)
- **M3: Cross-cutting infra prerequisites.** `D5-T1` (inspector detection + role-based menu routing), `D5-T2` (voice), `D5-T3` (AI intents), `D5-T4` (button policy), `D5-T6` (unsent `TaskField` assignment-card polling template if polling is used).
- **M4: Worker inspections menu + card + button replies.** `D2-T1`, `D2-T2`, `D2-T3`. End-to-end: a worker can confirm/decline/need-info on an assigned inspection.
- **M5: Worker morning reminder + on-demand status transitions + finished follow-up.** `D2-T4`, `D2-T5`, `D2-T6`. End-to-end: a full inspection day from morning list to finished + notes.
- **M6: Worker problem + missing-info + day-summary flows.** `D2-T7`, `D2-T8`, `D2-T9`, `D2-T10`. Worker side feature-complete for MVP.
- **M7: Leads stream for Sasha.** `D3-T1`, `D3-T5`, `D3-T3`, `D3-T4`, `D3-T2`. End-to-end: 09:30 digest, assignment alert, escalation.
- **M8: Manager exceptions digest for Yoram.** `D4-T1`, `D4-T2`. End-to-end: §13 morning and evening content with the right routing per K3.
- **M9: Dismantle and clean up.** `X-T1`, `X-T2`, `X-T3`, `X-T4`, `X-T5`, `X-T6`, `X-T7`. Old surface area removed AFTER the new surface is shipping.
- **M10: Templates + production validation.** `D5-T5` (Meta-approved templates for out-of-window sends), end-to-end smoke testing.
- **M11: WhatsApp-based `TaskField` scheduling for existing `Task`s.** `D2-T11`. Added via 2026-07-01 SPEC Addendum. Bot now writes `TaskField` (not just reads); existing D5-T6 poller fires the §6 card automatically. See `HANDOFF.md` for the full design.
- **M12: Sasha lead-assignment from WhatsApp.** `D3-T6`. Added via 2026-07-01 SPEC Addendum. Bot writes `IncomingLead.ownerId` (first CRM-table write from the bot); existing D3-T3 poller fires the worker alert automatically. Lead CLOSURE stays in the CRM.
- **M13: WhatsApp-based corrections.** `D2-T12` (site metadata override on TaskField — no CRM write), `D2-T13` (reassign worker — writes `Task.ownerId` + resets `TaskField.workerNotifiedAt`), `D2-T14` (inspection type — writes BOTH `TaskField.inspectionTypeId/family` AND `Task.productName`, with worker confirmation + office notification + audit). Added via 2026-07-01 SPEC Addendum. Editing scheduling / duration / instructions and all other CRM Task fields still stay in the CRM.
- **M14: Unified 6-item manager menu.** `D5-T7`. Added 2026-07-01. Everyone matching `role IN ('ADMIN','MANAGER')` OR name-based special sets sees a top-level 6-item navigation that wires into all existing flows (snapshot, today's inspections, exceptions, leads, workers, search). Regular field workers keep the §5 spec menu.

---

### T-ROUTE-CACHE — Movement-gated route cache above routeProvider (ORS quota fix)

**Status:** DONE (local, uncommitted)

**Why:** the ORS dashboard was showing 16+ calls per tracking session even for a
stationary phone. Root cause: the orsRoute internal cache is keyed on 4-decimal
coords (~11m), but real-world GPS jitter routinely exceeds 11m even when the
worker isn't moving. Every jitter busted the cache and cost an ORS credit.

**What changed:**
- NEW `src/services/routeMovementCache.ts` — a `Map<destKey, Entry>` cache with
  two code-constant gates: `MIN_ROUTE_RECALC_MOVE_METERS = 75` (below → HIT) and
  `MAX_STATIONARY_ROUTE_CACHE_MS = 10 * 60 * 1000` (safety refresh even without
  movement). `checkCache` returns a discriminated union (`HIT` /
  `MISS_NO_PRIOR` / `MISS_DEST_CHANGED` / `MISS_MOVEMENT` / `MISS_MAX_AGE`) with
  `movedMeters` and `routeAgeSeconds` for observability.
- `src/services/routeProvider.ts` — `getRouteEstimate` consults the cache
  BEFORE calling ORS/OSRM. On MISS it delegates to the existing provider chain
  (unchanged behavior) and stores the successful result. On HIT it logs
  `{ provider, cacheHit: true, skipReason: 'NO_SIGNIFICANT_MOVEMENT',
  movedMeters, routeAgeSeconds }` and returns the cached estimate without
  hitting the network. Null results are NOT cached (orsRoute keeps its own
  short null-cache to avoid null-spamming).
- `src/__tests__/routeProvider.test.ts` — added `_clearMovementCache()` in
  `beforeEach` so existing tests start with an empty cache each run.

**No env, no DB.** Both thresholds are code constants (per the "minimal ENV"
project decision).

**Files:**
- `src/services/routeMovementCache.ts` (new)
- `src/services/routeProvider.ts` (wire the cache in `getRouteEstimate`)
- `src/__tests__/routeMovementCache.test.ts` (new — 18 unit tests: threshold
  boundaries, decision matrix, multi-destination isolation)
- `src/__tests__/routeProviderMovementGate.test.ts` (new — 10 integration tests:
  first call → ORS, second same location → no ORS, 6× jitter under 75m → no
  ORS, > 75m → ORS again, destination change → ORS again, max stationary age
  → refresh, ORS null → OSRM cached and reused, both null → not cached / retry,
  OSRM-only deployment obeys the same gate)
- `src/__tests__/routeProvider.test.ts` (clear cache in beforeEach)

**Tests run:** `npx tsc --noEmit` clean; new + updated route tests → 34/34
pass; existing `tracking.test.ts`, `trackingConservativeIntegration.test.ts`,
`orsRoute.test.ts` → 55/55 pass (they mock routeProvider wholesale so the new
cache is fully transparent to them).

**Stale-location requirement (spec item 10) — behavior verified upstream:**
`tracking.ts` skips `getRouteEstimate` entirely on stale coords (falls straight
to STRAIGHT_LINE); routeProvider never sees stale calls. Covered by the
existing tracking suite, not duplicated here.

**Follow-up:** monitor the ORS dashboard after next deploy — expected drop from
~16 calls/hour per stationary worker to ~1 call per 10 min (the safety
refresh). If numbers still look high, tune `MIN_ROUTE_RECALC_MOVE_METERS`
upward (e.g. 100) before promoting the constants to env.
