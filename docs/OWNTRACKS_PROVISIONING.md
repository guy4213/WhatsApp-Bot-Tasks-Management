# OwnTracks Auto-Provisioning — זרימה מלאה

> סטטוס: **מומש** (2026-07-12). מקור-אמת של הפיצ'ר. משלים את [POC_OWNTRACKS.md](./POC_OWNTRACKS.md) (POC של מקור GPS) ואת [LIVE_TRACKING_PLAN.md](./LIVE_TRACKING_PLAN.md) (Wolt-lite ETA).

## למה זה קיים

עד שלב זה זהות עובד ב-OwnTracks נוהלה על ידי הרשימה `POC_OWNTRACKS_USERS` ב-env (סטטי, redeploy לכל עובד חדש). זה לא סקאלבילי לצי של כמה עשרות עובדים.

**המטרה:** מנהל לוחץ "הפעל מעקב מיקום לעובד X" בבוט → העובד מקבל בוואטסאפ קישור אישי → לוחץ → אפליקציית OwnTracks נפתחת ומקבלת קונפיגורציה מלאה אוטומטית. השרת מזהה מיקומים לפי `workerKey + password` שנוצרו דינמית, ומקושרים חזרה ל-`User.id` הקיים.

## מרכיבים

### 1. `WorkerDeviceIdentity` — טבלה קיימת עם עמודות חדשות ([016](../src/db/migrations/016_live_tracking.sql), הורחבה ב-[018](../src/db/migrations/018_owntracks_provisioning.sql))

עמודות מרכזיות:

| עמודה | תוקף | תפקיד |
| --- | --- | --- |
| `workerUserId` | קיים | FK ל-`User.id`. מקור-אמת של העובד. |
| `workerKey` | קיים | שם משתמש ב-Basic auth של OwnTracks. UNIQUE. נגזר משם העובד + suffix אקראי. |
| `passwordHash` | חדש | bcrypt של הסיסמה. הסיסמה הגולמית לא שמורה בשום מקום. |
| `trackerId` | חדש | ה-`tid` שיוזרק ל-config (2 תווים). |
| `provisioningToken` | חדש | 32-byte base64url. one-time, מתפוגג. |
| `provisioningExpiresAt` | חדש | תוקף ה-token (48 שעות). |
| `provisionedAt` | חדש | חותמת של הצריכה הראשונה. |
| `revokedAt` | חדש | אם המנהל revoke בעתיד. |

### 2. שירות פרוביז'נינג ([`src/services/owntracksProvisioning.ts`](../src/services/owntracksProvisioning.ts))

- `createProvisioning(userId)` — יוצר/מרענן שורה, מייצר token חדש. מחזיר `{ magicUrl, workerKey, expiresAt }`.
- `consumeProvisioning(token)` — SELECT FOR UPDATE לפי token, מייצר סיסמה גולמית בזיכרון, מחשב bcrypt hash, שומר, מוחק את ה-token, מחזיר `{ workerKey, password, trackerId, hostUrl }`. **הסיסמה הגולמית לא נכתבת ל-DB.**

### 3. Endpoints ([`src/routes/owntracksPoc.ts`](../src/routes/owntracksPoc.ts))

| endpoint | מי פונה | מה עושה |
| --- | --- | --- |
| `POST /owntracks` | האפליקציה, ping GPS | היה קיים. אימות: **קודם** `verifyWorkerCredentials` (DB, bcrypt+cache), **ואז** fallback ל-`POC_OWNTRACKS_USERS` (env). |
| `GET /o/:token` | הטלפון, קליק בוואטסאפ | 302 → `owntracks:///config?url=<host>/owntracks/config/<token>`. HTML fallback עברי אם האפליקציה לא מותקנת. |
| `GET /owntracks/config/:token` | אפליקציית OwnTracks | מגיש `.otrc` דינמי אחרי `consumeProvisioning`. one-time — קריאה שנייה מחזירה 404. |

### 4. שירות אימות ([`src/services/workerLocation.ts`](../src/services/workerLocation.ts))

- `verifyWorkerCredentials(workerKey, plaintext)` — Cache in-process (TTL 60s), `bcrypt.compare`. Cache miss על DB miss **לא** נשמר (כדי שעובד שרק עכשיו נפרוביז'ן יוכל להתחיל להתחבר מיד).
- `invalidateWorkerCredentialCache(workerKey)` — נקרא מ-`consumeProvisioning` אחרי החלפת סיסמה.

### 5. Trigger מהבוט ([`src/ai/router.ts`](../src/ai/router.ts))

Intent חדש `enable_worker_location_tracking`, MANAGER-only:
1. Guard `isManagerMenuUser(user)`.
2. Resolve שם עובד → `User.id` דרך `findUsersByName`.
3. Fetch `phone` דרך `pool.query`.
4. `createProvisioning(workerId)` → magic URL.
5. `notify()` לעובד עם `key='OWNTRACKS_PROVISIONING'`:
   - templates.ENABLED=true → template `owntracks_provisioning` (out-of-window).
   - templates.ENABLED=false → freeform (in-window).
6. אישור למנהל.

### 6. WhatsApp template ([`src/whatsapp/templateNames.ts`](../src/whatsapp/templateNames.ts))

`OWNTRACKS_PROVISIONING` — שם default `owntracks_provisioning`. שני משתני body:
- `{{1}}` שם עובד
- `{{2}}` magic URL (`https://<host>/o/<token>`)

**חובה להירשם ידנית ב-Meta Business Manager** כ-UTILITY. עד להרשמה + אישור, out-of-window sends יזרקו — הבוט מדווח לזה למנהל.

## הזרימה בפועל — צעד צעד

### דני מוגדר להיום מקבל mail חד-פעמי

1. **מנהל בוואטסאפ:** "הפעל מעקב מיקום לדני".
2. **Router:**
   - Intent parser → `enable_worker_location_tracking`, `task_reference="דני"`.
   - Guard `isManagerMenuUser` → פס.
   - `findUsersByName("דני")` → אחד תואם (`u_danny`, `phone=972501234567`).
   - `createProvisioning("u_danny")`:
     - שם slug מתעתק: `dny_ka` (או דומה) + 4 hex → `dnykhn_a3f9`.
     - `trackerId = 'DA'`.
     - token = `base64url(24 bytes)`.
     - `expiresAt = now+48h`.
     - INSERT/UPDATE שורת `WorkerDeviceIdentity` (לפי אם קיימת).
     - מחזיר `magicUrl = https://bot.example.com/o/<token>`.
3. **הודעה לדני** (`notify`):
   - Body: `שלום דני, להפעלת מעקב מיקום ... https://bot.example.com/o/<token> ... 48 שעות.`
   - Checklist: iOS "Always" + Precise; Android "Allow all the time" + Battery Unrestricted.
4. **אישור למנהל:** "נשלח לעובד דני קישור להפעלת מעקב מיקום. תוקף עד DD/MM HH:MM."

### דני לוחץ על הקישור

1. הטלפון פותח בדפדפן `https://bot.example.com/o/<token>` (WhatsApp מכיר קישור HTTPS).
2. השרת מחזיר `302 Location: owntracks:///config?url=https%3A%2F%2Fbot.example.com%2Fowntracks%2Fconfig%2F<token>` + HTML fallback עברי.
3. iOS/Android יודעים ש-`owntracks://` שייך לאפליקציה → פותחים אותה.
4. **OwnTracks עצמה** עושה HTTP GET ל-`https://bot.example.com/owntracks/config/<token>`.
5. **`consumeProvisioning(token)`** בשרת:
   - `SELECT FOR UPDATE` לפי token; אם פג/חסר → 404.
   - מייצר סיסמה גולמית בזיכרון (`crypto.randomBytes(18).toString('base64url')`).
   - `bcrypt.hash(plaintext, 10)`.
   - UPDATE: `passwordHash`, `provisioningToken=NULL`, `provisionedAt=now()`, `isActive=true`, `revokedAt=NULL`.
   - Invalidate `verifyWorkerCredentials` cache עבור `workerKey`.
   - COMMIT.
6. השרת מגיש JSON `.otrc`:
   ```json
   {
     "_type": "configuration",
     "mode": 3,
     "url": "https://bot.example.com/owntracks",
     "auth": true,
     "username": "dnykhn_a3f9",
     "password": "<the-plaintext-just-generated>",
     "tid": "DA",
     "deviceId": "dnykhn_a3f9",
     "monitoring": 1,
     "locatorInterval": 15,
     "locatorDisplacement": 50,
     "pubExtendedData": true
   }
   ```
7. OwnTracks מציגה prompt "Import configuration? Host: bot.example.com, User: dnykhn_a3f9". דני לוחץ Accept.
8. **הכל בהגדרות פנימיות של OwnTracks עכשיו** — Host, User, Password, TID, Monitoring=move, intervals, בלי הקלדה ידנית.

### דני מוצג להרשאות (ידני, לא ניתן לעקוף)

זה מוצג ב-checklist בהודעה. iOS/Android לא מאפשרים אוטומציה של דיאלוגי הרשאה.

- **iPhone:** Settings → OwnTracks → Location → **Always**. Precise Location = On. Motion & Fitness = On.
- **Android:** Location → **Allow all the time**. Battery → **Unrestricted** (בטל אופטימיזציית סוללה).

### הפינג הראשון

1. דני לוחץ Publish באפליקציה (או מתחיל לנסוע והאפליקציה שולחת אוטומטית).
2. OwnTracks שולחת `POST https://bot.example.com/owntracks` עם `Authorization: Basic base64("dnykhn_a3f9:<password>")` וגוף JSON.
3. Route:
   - `parseBasicAuth()` → `{ user: 'dnykhn_a3f9', pass: '<password>' }`.
   - `authenticate()` → `verifyWorkerCredentials('dnykhn_a3f9', '<password>')`:
     - Cache miss → SELECT מ-`WorkerDeviceIdentity`.
     - `bcrypt.compare(password, passwordHash)` → true.
     - Cache set. מחזיר `{ workerUserId: 'u_danny' }`.
   - `resolveWorkerFromKey('dnykhn_a3f9')` → `u_danny`.
   - `upsertLiveLocation()` → מעדכן `WorkerLiveLocation`.
   - `bumpSessionLocation()` → אם יש `TrackingSession` פעיל.
4. ה-ping הבא (בתוך 60 שניות) — cache hit, בלי bcrypt, בלי DB.

## תרחישים חריגים

| תרחיש | התנהגות |
| --- | --- |
| דני לחץ פעמיים על הקישור | הפעם השנייה → 404. `consumeProvisioning` מחזירה null (token כבר נמחק). מנהל צריך לייצר קישור חדש. |
| דני מחליף מכשיר | מנהל שולח provisioning חדש → `createProvisioning` מרענן את השורה, מחליף `workerKey`? לא — `workerKey` נשמר יציב לפי הלוגיקה הקיימת. הסיסמה מתחלפת. הישן פשוט לא יעבוד יותר (`passwordHash` חדש). |
| דני מוחק את OwnTracks | הרשאות אבודות. מנהל שולח provisioning חדש. |
| דני קיבל קישור אבל OwnTracks לא מותקנת | הטלפון יעביר אותו ל-HTML fallback בעברית עם הסבר. |
| קישור פג תוקף (48h) | `consumeProvisioning` מחזירה null. אותו הצעד — קישור חדש. |
| Meta template לא מאושר | `notify()` בזמן templates.ENABLED=true → תזרוק. הבוט תופס ומדווח למנהל שהשליחה נכשלה + מציג את ה-URL כדי שהמנהל יעביר ידנית. |

## שדרוגים עתידיים אפשריים

- **Revoke בבוט:** intent "כבה מעקב לדני" שמסמן `revokedAt=now()`, `isActive=false`, מוחק `passwordHash`. הטבלה כבר מכינה את זה.
- **Fine-tune per-worker:** רענון config דרך provisioning link חדש — משתמשי OwnTracks יכולים לחיות עם `locatorInterval=15` אבל אולי מנהל רוצה לבדוק מכשיר חלש-סוללה עם 30s. פשוט לרוץ shove-config עם token חדש.
- **Cross-device rotation:** אם מכשיר נגנב, `revokedAt + provisioning חדש = ping הבא ייכשל`.

## Env נוסף שהופיע

```env
# .env.example
PUBLIC_BASE_URL=https://bot.example.com   # ← REQUIRED once auto-provisioning is used
```

`POC_OWNTRACKS_USERS` נשאר, אבל מסומן deprecated. שורות legacy (כמו `guy` מה-POC) ממשיכות לעבוד דרך fallback עד ל-re-provisioning.
