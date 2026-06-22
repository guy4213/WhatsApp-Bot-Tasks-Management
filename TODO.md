# WhatsApp Task Bot — Remaining Work / Go-Live Checklist

> Code for Phases 1–5 is built and verified (`tsc` clean, 33 tests pass, boots OK).
> What's left is mostly **setup/integration** plus a few functional items.
> Mark `[x]` as completed.

---

## 1. Supabase setup
- [ ] Confirm the Supabase project + region.
- [ ] From Dashboard → Settings → Database/API, collect and put in `.env`:
  - [ ] `DATABASE_URL` (direct connection, port 5432)
  - [ ] `SUPABASE_URL`
  - [ ] `SUPABASE_SERVICE_ROLE_KEY` (server-side only — never expose to clients)
- [ ] Run the migrations in order (SQL Editor or `npm run migrate`):
  - [x] `001_bot_tables.sql` — FK refs fixed to quoted `"User"(id)` / `"Task"(id)` (`user` is a reserved word and won't resolve unquoted). Verified by the CI integration test, which applies all four migrations against a real Postgres.
  - [ ] `002_completion_notifications.sql`
  - [ ] `003_inbound_queue.sql`
  - [ ] `004_conversation_context.sql`
- [ ] Confirm all bot tables exist + RLS enabled (deny_all_public on each).
- [ ] Seed/verify `User.phone` values so inbound numbers resolve to users.

## 2. Meta WhatsApp Cloud API integration
- [ ] Create the Meta app + WhatsApp Business number (or use the test number).
- [ ] Put in `.env`:
  - [ ] `WHATSAPP_PHONE_NUMBER_ID`
  - [ ] `WHATSAPP_ACCESS_TOKEN` (long-lived / system-user token for prod)
  - [ ] `WHATSAPP_VERIFY_TOKEN` (any string; must match webhook config)
  - [ ] `WHATSAPP_APP_SECRET` (App → Settings → Basic) — enables inbound HMAC verification
  - [ ] `WHATSAPP_API_VERSION` (optional; defaults to v19.0)
- [ ] Deploy to an always-on host with a **public HTTPS** URL.
- [ ] Register the webhook URL in Meta, subscribe to the `messages` field, complete verification (GET challenge).
- [ ] Send a test inbound message end-to-end (number → webhook → reply).

## 3. Internal / AI config
- [ ] `INTERNAL_API_SECRET` — generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- [ ] To enable the AI layer: set `AI_PROVIDER` (`openai` | `anthropic`) + matching key
  (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`); optionally `AI_MODEL`.
  - Until set, the bot replies "AI not configured" — quick-reply confirm/approve + scheduler still work.
- [ ] (Optional) tune `AI_CONFIDENCE_HIGH`, `AI_CONFIDENCE_LOW`, `CONVERSATION_CONTEXT_TTL_MINUTES`.

## 4. WhatsApp message templates  ⚠️ required for proactive notifications
Meta only allows free-form text inside the 24h customer-service window. Confirm prompts
are fine (in-window), but every **proactive** message needs a pre-approved **UTILITY** template.
- [ ] Create + get approval for Hebrew (`he`) UTILITY templates for:
  - [ ] dueDate approval request (to managers)
  - [ ] 1-hour due reminder
  - [ ] deadline exceeded (managers)
  - [ ] deadline approaching (managers)
  - [ ] daily summary
  - [ ] task completed (managers)
  - [ ] request expired (employee / manager)
- [x] Add `sendTemplateMessage()` to `src/whatsapp/sender.ts` (`type: 'template'`, name + language + variables, with param sanitization).
- [x] Switch scheduler jobs + manager dueDate broadcast + approve/reject results to `notify()` (template-or-fallback); confirm prompts kept free-form.
- [x] Template registry `src/whatsapp/templates.ts` (logical keys → names + body-param contract; env overrides).
- [ ] **Code is ready — remaining is Meta-side:** register & get the templates approved, then set `WHATSAPP_TEMPLATES_ENABLED=true`.

## 5. Testing & CI
- [x] Integration tests against a throwaway test Postgres (state machine, the actual SQL) — `src/__tests__/integration.test.ts`: applies all 4 migrations, then exercises createPendingAction / transitionState first-to-resolve guard / expireStaleActions. Gated on `RUN_DB_TESTS=1` (skips locally, runs in CI).
- [ ] End-to-end AI test with a real key + Supabase (parse → confirm → write).
- [x] CI pipeline: `tsc --noEmit` + `vitest run` on push/PR — `.github/workflows/ci.yml`, with a `postgres:16` service so the integration tests run too.

## 6. Deferred / optional
- [ ] Voice-message transcription (audio → text → intent parser).
- [ ] Admin UI / command to manage `whatsapp_notification_recipients` opt-outs.

## 7. Nice-to-have hardening
- [ ] Metrics + alerting; ship logs somewhere.
- [ ] Load/perf test the webhook + scheduler.
- [ ] Secrets manager instead of `.env` in prod.

---

## Status snapshot
- ✅ Phases 1–5 implemented (foundation, create/edit + confirm-before-write, dueDate two-person approval, scheduler, AI layer)
- ✅ Production hardening (security, durable ingest, retries, structured logs, health checks, graceful shutdown)
- ✅ Verified against the live CRM schema
- ⏳ Remaining = setup (Supabase/Meta), message templates, integration tests/CI, optional voice
