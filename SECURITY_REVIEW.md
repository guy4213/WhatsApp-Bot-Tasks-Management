# Security Review — WhatsApp Task Bot (go-live)

Scope: the six areas requested. Verdicts: ✅ good · ⚠️ acceptable with note · ❌ must fix.

---

## 1. `service_role` only server-side — ✅ (with cleanup)
- The service-role client `supabaseAdmin` is created in `src/db/connection.ts` from `SUPABASE_SERVICE_ROLE_KEY`, which lives only in `.env` (gitignored — see §6). It is **never sent to a client**; there is no frontend in this repo.
- **Finding (⚠️ dead code):** `supabaseAdmin` is **never used** anywhere (no `.from()`/`.rpc()` calls). All DB access goes through the `pg` Pool. Loading an unused service-role key is needless attack surface.
- **Recommend:** delete `supabaseAdmin` and stop requiring `SUPABASE_SERVICE_ROLE_KEY` (keeps the powerful key out of the process entirely).

## 2. Webhook verification — ✅
- **POST** `/webhook`: `X-Hub-Signature-256` is HMAC-SHA256-verified against the **raw body** using `WHATSAPP_APP_SECRET`, with a **timing-safe** compare and a length guard (`webhook.ts:27-35`). Raw body is captured by a dedicated content-type parser (`app.ts:29-40`).
- **GET** `/webhook`: verify-token compared **timing-safe** (`verifyTokenEqual`, `webhook.ts:37-40`).
- ⚠️ Both skip verification only when the secret/token is **unset** (dev convenience). In production both `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` are present and now **enforced by preflight** (§ added). `VERIFY_TOKEN` falls back to `'changeme'` if unset — preflight blocks that in prod.
- ⚠️ The webhook ACKs 200 before processing (correct for Meta's 20s rule); processing errors are caught and audit-logged, so a malformed payload can't crash the server.

## 3. `INTERNAL_API_SECRET` usage — ✅ (now hardened)
- Task routes are gated by a `preHandler` that requires `x-internal-secret`, compared **timing-safe** with a length check (`tasks.ts:64-68`, `verifyInternalSecret`). The webhook→route calls attach it (`internalApi.ts`).
- ❌→✅ **Was the placeholder** `your_random_secret_here` (effectively open, since an attacker could guess/replay it). **Fixed:** replaced with a fresh 32-byte random value in `.env`, and **preflight now refuses to boot in production** if it's missing, the placeholder, or < 32 chars.
- ⚠️ When the secret is unset the check returns `true` (dev). Acceptable because the routes bind to `0.0.0.0` but are intended to be reached only via localhost; **do not expose port 3000 publicly** — only the Cloudflare tunnel → `/webhook` should be public. Consider binding internal routes to `127.0.0.1` or splitting them onto a separate port for stronger isolation.

## 4. Role permissions — ✅ (hardened this cycle; keep watch)
Server-side gates, enforced in the routes (not just the AI layer):
- **View:** open to all authenticated users by design (`canViewAllTasks` → true).
- **Edit:** `canEditTask` = owner **or** elevated (`tasks.ts:294`).
- **Create-for-others:** `canCreateForOthers` = elevated only (`permissions.ts`).
- **Reassign/relink (`ownerId`/`customerId`/`leadId`/`projectId`):** `ELEVATED_ONLY`.
- **Approve dueDate:** `isElevated` only (`tasks.ts`).
- Defense-in-depth: `listTasks` hard-clamps non-elevated to own rows; `resolveTask` is scoped.
- ⚠️ **History note:** three privilege-escalation bugs were found & fixed this cycle (`canManageUsers`→create, `canViewAllRecords`→edit, ADMIN-only vs manager). The pattern — a *flag/role granting more than intended* — means the permission surface deserves a regression test per gate and a re-review on any future change. RLS will **not** catch these (see §5).

## 5. RLS assumptions — ⚠️ understand the trust boundary
- The bot connects as the Supabase **`postgres`** role (`DATABASE_URL`), which has **`BYPASSRLS`**. So **RLS policies do not apply to any bot query.** The (unused) service-role key would also bypass RLS by design.
- **Implication:** RLS protects your **other** clients (anon/authenticated keys — frontend/CRM), **not** the bot. The bot's security is **entirely** the app-level checks in §4. Treat them as the security boundary.
- **Recommend (defense-in-depth):** run the bot's pool as a **dedicated least-privilege role** with grants only on the tables it uses (not `postgres`/BYPASSRLS), so a bug/injection can't reach other schemas. Queries are already fully parameterized (low injection risk), so this is hardening, not an emergency.

## 6. No secrets committed — ✅
- `.env` is **gitignored** (`.gitignore:4`) and **not tracked** (`git ls-files .env` → not found). The generated `INTERNAL_API_SECRET` written there is **not** committed.
- **No hardcoded secrets in `src/`** (scanned for `sk-…`, `Bearer …`, `EAA…`, JWTs, `postgresql://…`, inline passwords — only benign matches: test IDs, comments, the logger's service name).
- ⚠️ **Operational:** the live tokens (WhatsApp access token, Supabase service-role key & DB password, OpenAI key) were visible in this working session. **Rotate them before go-live** and store prod values in the host's secret manager / env, not a checked-in file.

---

## Action list
| Priority | Item |
|---|---|
| ✅ Done | Strong `INTERNAL_API_SECRET`; preflight enforcement; prod DB TLS fix. |
| 🔴 Before launch | Rotate all live secrets (WhatsApp token, Supabase key + DB password, OpenAI key). |
| 🟠 Recommended | Remove unused `supabaseAdmin` + service-role key; run pool as a least-privilege DB role; provide `DATABASE_CA_CERT` for verified TLS. |
| 🟡 Hardening | Bind internal routes to localhost or a separate port; add a unit test per permission gate. |
