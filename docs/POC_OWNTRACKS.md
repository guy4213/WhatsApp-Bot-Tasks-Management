# POC: אימות OwnTracks כמקור GPS חי לעובדים

> סטטוס: **מתוכנן, טרם מומש** (2026-07-06). מקור GPS למעקב הגעה ללקוח ("Wolt-lite").
> קובץ זה הוא ה-source of truth של ה-POC. אין עדיין migration / endpoint / שינויי env.

## Context

מחקר קודם הראה ש-OwnTracks מתאים עקרונית: open-source, חינמי, iOS+Android, מתוחזק פעיל (2026), שולח מיקום ברקע ל-endpoint שלנו ב-HTTP בלי שהעובד יחזיק דף פתוח, והעובד ממשיך לנווט ב-Waze. **הסיכון היחיד שלא הוכרע:** האם ברקע, במכשיר אמיתי, המיקום באמת ממשיך להגיע בתדירות מספקת — במיוחד ב-iOS שמגביל עדכוני רקע.

**החלטות מוצר שהתקבלו:** סף הצלחה = עדכון **לפחות כל 60 שניות** בנסיעה; צי המכשירים **מעורב ~50/50 iOS/Android** → **iOS הוא הצוואר-בקבוק והמוקד של ה-POC**.

**מטרת ה-POC:** להוכיח *רק* שמקור ה-GPS עובד בפועל בשני מכשירים אמיתיים. לא לבנות עדיין: דף לקוח, Google Maps, ETA, template חדש, tracking session מלא, WebSocket, MQTT, `WorkerDevice`/`WorkerLiveLocation`/`TaskFieldTracking`. אלה שלב הבא — רק אם ה-POC מצליח.

**הנחת תשתית:** OwnTracks חייב public HTTPS. נכוון אותו לאותו host שכבר משרת את `/webhook` של WhatsApp (למשל `https://<host>/owntracks`), או ל-tunnel (cloudflared/ngrok) בפיתוח. אם אין ingress יציב — זה חוסם ומטופל לפני הבדיקה.

---

## 1. DB מינימלי — Migration חדש

קובץ אחד: `src/db/migrations/013_owntracks_poc.sql`, לפי הקונבנציות הקיימות ([009](../src/db/migrations/009_field_inspections.sql) / [012](../src/db/migrations/012_customer_notifications.sql)): PascalCase quoted, `uuid` + `gen_random_uuid()`, `timestamptz DEFAULT now()`, RLS enabled + policy deny-all RESTRICTIVE. מורץ ע"י [migrate.ts](../src/db/migrate.ts) (`npx ts-node src/db/migrate.ts`) או הדבקה ל-Supabase SQL Editor.

**טבלה אחת בלבד — append-only** (מאפשר גם "מיקום אחרון" וגם מדידת תדירות):

`"PocLocationPing"`
- `id uuid PK DEFAULT gen_random_uuid()`
- `workerKey text NOT NULL` — ה-Basic-auth username (זהות העובד ב-POC)
- `deviceId text` , `tid text` — מתוך ה-payload / headers
- `lat double precision`, `lng double precision`
- `accuracy real`, `speed real`, `battery real`
- `trigger text` — ערך `t` מ-OwnTracks (auto/manual/beacon/…)
- `recordedAt timestamptz` — מומר מ-`tst` (epoch שניות)
- `receivedAt timestamptz NOT NULL DEFAULT now()` — זמן קליטה בשרת (בסיס למדידת תדירות + staleness)
- `raw jsonb` — ה-payload המלא, לדיבוג
- אינדקס: `("workerKey", "receivedAt" DESC)`

**מיקום אחרון** = `SELECT DISTINCT ON ("workerKey") ... ORDER BY "workerKey", "receivedAt" DESC`.
**תדירות** = הפרשי `receivedAt` עוקבים פר-`workerKey`.
**Stale** = `now() - MAX("receivedAt") > interval`.

לא צריך טבלת `WorkerDevice` ל-POC — הזהות היא ה-Basic-auth username, מאומת מול allowlist ב-env.

---

## 2. Endpoint מינימלי לקליטת OwnTracks

Fastify plugin חדש `src/routes/owntracksPoc.ts`, רשום ב-[app.ts](../src/app.ts) לצד `taskRoutes`/`webhookRoutes`.

**חשוב:** שלא כמו `taskRoutes` (שמוגן ב-`x-internal-secret`), ה-endpoint הזה **ציבורי** — OwnTracks פונה אליו ישירות מהטלפון. האימות הוא **HTTP Basic auth פר-עובד**.

- `POST /owntracks`
  - קורא header `Authorization: Basic ...` → מפענח `user:pass`.
  - מאמת מול allowlist ב-env `POC_OWNTRACKS_USERS` (פורמט `danny:secret1,yossi:secret2`). כשל → `401`.
  - `workerKey = user`. (מתעלמים מ-`X-Limit-U` כטענת זהות — מקור האמת הוא ה-credential המאומת. שומרים `deviceId`/`tid` מה-payload/headers כמידע בלבד.)
  - מסנן `_type === "location"` בלבד (OwnTracks שולח גם `transition`/`waypoint` וכו').
  - `INSERT` ל-`PocLocationPing` (כולל `raw`). ממיר `tst`→`recordedAt`.
  - מחזיר `200` עם `[]` (מה ש-OwnTracks מצפה בהצלחה).
  - ה-JSON body כבר נפרס ע"י ה-content-type parser הקיים ב-[app.ts](../src/app.ts) — אין צורך ב-formbody.
  - משתמש ב-`pool` מ-[connection.ts](../src/db/connection.ts) ו-`moduleLogger('owntracks-poc')`.

- `GET /owntracks/poc/debug` (עזר לבדיקה בלבד, מוגן ב-`x-internal-secret` כמו task routes)
  - מחזיר JSON: מיקום אחרון פר-`workerKey`, `secondsSinceLast`, `stale` (בוליאני מול סף), וכמות pings ב-10 הדק' האחרונות + הפרש חציוני בין עדכונים.
  - מחליף בניית דף — מאפשר לראות תוצאות מהדפדפן/טלפון תוך כדי נסיעה.

**Env חדש (`.env.example`):** `POC_OWNTRACKS_USERS`, ואופציונלי `POC_STALE_SECONDS=180`. ללא סודות אמיתיים בקוד.

---

## 3. הגדרת OwnTracks (שני המכשירים)

מצב **HTTP** (לא MQTT). ב-Settings → Connection:
- **Mode:** HTTP / Private
- **Host/URL:** `https://<public-host>/owntracks`
- **Identification:** UserID = `danny` (→ Basic-auth user + `X-Limit-U`), Password = `secret1`, DeviceID, **TrackerID (tid)** — חובה ב-HTTP mode
- **Monitoring mode:** **Move** (עדכונים תכופים; הכרחי כדי לכוון לסף ≤60s)
- כוונון לנסיעה: `locatorInterval`/`locatorDisplacement` נמוכים ככל האפשר (Android: fix ~10s ברירת מחדל; iOS move: ברירת מחדל 100מ'/300ש — צריך להקטין ולבדוק בפועל)

**חלופת הגדרה מהירה (magic link):** `owntracks:///config?inline=<base64 של קובץ .otrc>` — פותח את ההגדרות אוטומטית. שימושי אם רוצים provisioning אחיד לשני המכשירים בלי הקלדה ידנית.

**הרשאות קריטיות:**
- **Android:** Location = "Allow all the time" (רקע), + לכבות Battery optimization לאפליקציה.
- **iOS:** Location = **"Always"** (לא "While Using"), + Precise Location = On, + לאשר Motion & Fitness. בלי "Always" — אין דיווח ברקע.

---

## 4. איך לבדוק Android מול iPhone

זהה בשני המכשירים, כל אחד עם `workerKey` שונה (`danny` / `yossi`):

1. הגדרה + הרשאות כנ"ל; "Publish" ידני אחד לוודא שהמיקום מגיע (רואים ping ב-`/debug`).
2. **תרחיש נסיעה אמיתי** (10–20 דק'), ובכל שלב מוודאים המשך הגעת pings:
   - Waze פתוח ומנווט בקדמת המסך
   - מסך כבוי
   - טלפון בכיס
   - נסיעה אמיתית (תנועה רציפה)
3. במקביל פותחים `/owntracks/poc/debug` ממכשיר אחר ומרעננים — עוקבים אחרי `secondsSinceLast` ו-`stale`.
4. אחרי הנסיעה: שולפים מ-`PocLocationPing` את כל ה-pings פר-מכשיר ומחשבים **הפרשי `receivedAt` עוקבים** → תדירות בפועל לכל פלטפורמה, בכל אחד מהמצבים.

**להשוות ראש-בראש:** טבלת סיכום — Android מול iPhone — של תדירות חציונית + מקסימום פער, לכל מצב (Waze/מסך כבוי/כיס).

---

## 5. מה נחשב הצלחה

סף מוסכם: **עדכון לפחות כל 60 שניות** בנסיעה.

- ✅ **Android:** pings מגיעים רציף בכל 4 המצבים, פער חציוני **≤60s** (מצופה שיעבור — move mode ~10s).
- ✅ **iOS (נקודת ההכרעה):** pings ממשיכים ברקע גם עם Waze בקדמה/מסך כבוי, פער **≤60s** (או קרוב, ולראות אם ניתן להגיע לשם בכוונון move mode).
- ✅ זיהוי עובד עובד: כל ping משויך ל-`workerKey` הנכון לפי ה-credential; `401` על credential שגוי.
- ✅ "מיקום אחרון" ו-`stale` מחושבים נכון ב-`/debug`.
- ✅ אין אובדן מוחלט: גם אם iOS איטי, המיקום *ממשיך להגיע* (לא נעצר לגמרי) לאורך הנסיעה.

## מה נחשב כישלון

- ❌ iOS מפסיק לדווח כשהמסך כבוי / Waze בקדמה / הטלפון בכיס.
- ❌ פערים גדולים בהרבה מהסף באופן עקבי (למשל iOS כל 5–10 דק') **וזה לא מקובל מוצרית** לאותם 50% אייפון.
- ❌ המיקום מגיע רק בזמן שהאפליקציה בקדמת המסך (מנוגד לדרישה — העובד מנווט ב-Waze).
- ❌ אי-אפשר לזהות עובד מהמיקום, או שה-endpoint לא מקבל/דוחה payloadים תקינים.

**החלטת go/no-go:** אם Android עובר ו-iOS מספק אמינות סבירה (ממשיך לדווח ברקע, גם אם הפער > 60s) → **ממשיכים**, אולי עם קבלת ETA גס יותר באייפון. אם iOS נעצר ברקע → **עוצרים** ובוחנים חלופה (Traccar Client / PWA עם Wake Lock).

---

## 6. אילו לוגים צריך לראות

מ-`moduleLogger('owntracks-poc')`:
- על כל POST מוצלח: `{ workerKey, deviceId, tid, lat, lng, accuracy, trigger, recordedAt, ageSincePrevMs }` — כולל הפער מה-ping הקודם.
- `401` על Basic-auth שגוי (עם ה-user שנשלח, בלי הסיסמה).
- payload שאינו `_type:location` → לוג `debug` "skipped non-location".
- שגיאת INSERT / parse → `error`.
- ב-`/debug`: פר-`workerKey` — `lastReceivedAt`, `secondsSinceLast`, `stale`, `pingsLast10min`, `medianGapSeconds`.

מטרה: להסתכל על השדות האלה ולראות מיד את **הפער בין עדכונים** ואת ה-**staleness** — זה כל מה שה-POC מודד.

---

## 7. סיכונים שנשארים אחרי הבדיקה

גם אם ה-POC מצליח, עדיין פתוחים לשלב הבא:
1. **iOS ברקע לאורך זמן** — התנהגות עשויה להשתנות בין דגמים/גרסאות iOS ומצבי סוללה נמוכה; בדיקה קצרה לא מכסה הכל.
2. **סוללה/דאטה** — move mode אגרסיבי מרוקן סוללה בנסיעות ארוכות.
3. **פרטיות** — OwnTracks ידווח כל היום (גם בין משימות); דורש מדיניות consent, retention ובקרת גישה (מטופל בשלב המלא, לא ב-POC).
4. **Provisioning בקנה מידה** — הפצה והגדרה של OwnTracks על צי מכשירים, לא רק 2.
5. **Ingress יציב** — ב-POC אפשר tunnel; בפרודקשן צריך host קבוע + HTTPS תקין.
6. **אמינות מול Waze בפועל** — אושר רק בבדיקה קצרה; לוודא על הדגמים האמיתיים בצי.

---

## Verification (איך לבדוק את ה-POC עצמו מקצה לקצה)

1. הרצת migration: `npx ts-node src/db/migrate.ts` → לוודא ש-`013_owntracks_poc.sql` רץ ו-`"PocLocationPing"` קיים (query ב-Supabase).
2. `.env`: להוסיף `POC_OWNTRACKS_USERS=danny:secret1,yossi:secret2` + לוודא ingress ציבורי.
3. הרצת השרת (`npm run dev`); בדיקת smoke עם `curl -u danny:secret1 -H "Content-Type: application/json" -d '{"_type":"location","lat":32.08,"lon":34.78,"tst":<epoch>,"tid":"D"}' https://<host>/owntracks` → מצפים `[]` ו-ping ב-DB.
4. `curl -u wrong:wrong ...` → מצפים `401`.
5. הגדרת שני המכשירים; ping ידני אחד לכל אחד → נראה ב-`GET /owntracks/poc/debug`.
6. תרחיש הנסיעה (Waze/מסך כבוי/כיס), מעקב חי ב-`/debug`.
7. שליפת pings וחישוב תדירות פר-פלטפורמה; מילוי טבלת ההשוואה; החלטת go/no-go מול הסף ≤60s.

## מה לא בונים ב-POC (מפורש)

דף לקוח · Google Maps · ETA/Routes · geocoding · template חדש · `TaskFieldTracking`/`WorkerDevice`/`WorkerLiveLocation` · חיבור ל-flow "יצאתי"/"הגעתי" · WebSocket · MQTT. כל אלה שלב הבא, מותנה בהצלחת ה-POC.

---

## נספח — מקורות מחקר (OwnTracks / Google / Waze / WhatsApp)

- OwnTracks HTTP: https://owntracks.org/booklet/tech/http/
- OwnTracks JSON payload: https://owntracks.org/booklet/tech/json/
- OwnTracks remote config: https://owntracks.org/booklet/features/remoteconfig/
- OwnTracks location/background: https://owntracks.org/booklet/features/location/
- OwnTracks Recorder: https://github.com/owntracks/recorder
- OwnTracks Android releases: https://github.com/owntracks/android/releases
- OwnTracks iOS (App Store): https://apps.apple.com/us/app/owntracks/id692424691
- Google Maps pricing (שינוי מרץ 2025 — מכסות per-SKU): https://developers.google.com/maps/billing-and-pricing/pricing
- Google Maps pricing overview: https://developers.google.com/maps/billing-and-pricing/overview
- Waze Deep Links (ניווט בלבד — אין live-location API): https://developers.google.com/waze/deeplinks
- Waze partners / Transport SDK: https://www.waze.com/product-partners
- WhatsApp Cloud API location: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/location-messages/
