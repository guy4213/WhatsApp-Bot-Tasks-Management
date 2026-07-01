# CRM Schema Reference — for bot developers

This is the CRM's Prisma-managed schema, used as a reference when writing bot
queries. **The bot never manages this schema** (Prisma does), but every JOIN
the bot performs must match the columns/types here exactly.

Last synced: 2026-07-01. If Prisma migrations change these columns, update this
file too.

---

## Bot-owned tables (managed by our `/src/db/migrations/*.sql`)

- `InspectionType`, `InspectionChecklist`, `TaskField` (migration 009)
- `WhatsappLeadNotification` (migration 010)
- `WhatsappAuditLog`, `WhatsappInboundQueue`, `WhatsappConversationContext`,
  `WhatsappUserGreeting`, `WhatsappReminderLog`, `WhatsappChatHistory`,
  `WhatsappDigestSendLog`, `WhatsappCompletionNotification`,
  `WhatsappNotificationRecipient`, `WhatsappPendingAction`,
  `UserDigestPreference` (migrations 001-008)

## CRM-owned tables (Prisma-managed — read only from the bot, except the
   documented CRM writes listed in `SPEC_FIELD_V2.md` Addendum)

Key tables + the columns the bot actually references. **Ignore everything not
listed** — the CRM has many other columns per table.

---

### `User`
- `id text NOT NULL` — PK, text (NOT uuid). Same id referenced by every FK.
- `name text NOT NULL` — display name. Bot's primary routing key (see `specialUsers.ts`).
- `email text NOT NULL`
- `phone text` — nullable in the schema even though it's required for the bot.
- `role` — enum `UserRole` (values include `ADMIN`, `MANAGER`, `SALES`, plus others).
- `status` — enum `UserStatus` (values include `ACTIVE`).

### `Customer`
- `id text NOT NULL` — PK
- `name text NOT NULL` — primary display name for the customer
- `contactName text NOT NULL` — site contact
- `phone text NOT NULL` — customer phone
- `email text NOT NULL`
- `city text NOT NULL`
- `address text` — nullable
- `status text NOT NULL DEFAULT 'ACTIVE'`
- `type text NOT NULL` — customer type

### `Task` ⚠️ IMPORTANT
- `id text NOT NULL` — PK, text
- `title text NOT NULL`
- `description text`
- `dueDate timestamp`
- `priority` — enum `TaskPriority`
- `status` — enum `TaskStatus` (values include `OPEN`, `DONE`; **CRM owns this**, bot must NEVER write it)
- `ownerId text NOT NULL` — FK → `User.id` (the assigned inspector)
- **`customerId text` — nullable** FK → `Customer.id`
- **`leadId text` — nullable** FK → `Lead.id`
- **`projectId text` — nullable** FK → `Project.id`
- **`incomingLeadId text` — nullable** — implied FK → `IncomingLead.id`
- `productName text` — matches `InspectionType.code` (§6 requirement)
- `type text NOT NULL DEFAULT 'step1'`
- `createdAt`, `updatedAt`

⚠️ **A Task can have EITHER `customerId`, `leadId`, `projectId`, OR
`incomingLeadId` — not always all four.** Bot queries that want to show the
customer name MUST fall back across all four sources. See "Customer name
resolution helper" below.

### `Lead`
- `id text NOT NULL` — PK
- `firstName text NOT NULL`
- `lastName text`
- `fullName text` — often populated for imported/legacy leads
- `company text` — company name for B2B leads
- `email text`
- `phone text`
- `customerId text` — nullable FK → `Customer.id` (when the lead was converted)
- `assignedUserId text` — nullable FK → `User.id`
- `status`, `stage`, `leadStatus` — three (!) different enums
- `city text`, `address text`, `service text`
- `createdAt`, `updatedAt`

### `Project`
- `id text NOT NULL` — PK
- `name text NOT NULL`
- **`client text NOT NULL`** — TEXT customer name (not FK). Populated even
  when `customerId` is null.
- `customerId text` — nullable FK → `Customer.id`
- `status` — enum `ProjectStatus`
- `city text`, `address text`
- `contactName text`, `contactPhone text`
- `fieldContactName text`, `fieldContactPhone text`
- `service text`
- `assignedTechnicianId text` — FK → `User.id`

### `IncomingLead`
- `id text NOT NULL` — PK
- `subject text NOT NULL`
- `body text`
- `fromName text`
- `fromEmail text`
- `receivedAt timestamp NOT NULL`
- `status` — enum `IncomingLeadStatus` (values include `NEW`)
- **`ownerId text` — nullable in practice.** The Prisma schema declares it as
  `NOT NULL`, but in this database an unassigned lead has `ownerId IS NULL`.
  All the bot's D3 flows (`findOvernightUnassignedLeads`,
  `findEscalationCandidates`, `findUnassignedLeadsForAssignment`) correctly
  filter `WHERE "ownerId" IS NULL` — do NOT change this to a sentinel-user
  check.
- `transferredToId text` — nullable
- `taskId text` — nullable
- `notifiedAt timestamp` — nullable

### `TaskField` (bot-managed, migration 009)
- Full schema in `src/db/migrations/009_field_inspections.sql`. Documented for
  reference:
- `id uuid NOT NULL DEFAULT gen_random_uuid()`
- `taskId text NOT NULL` → `Task.id`
- `inspectionTypeId uuid NOT NULL` → `InspectionType.id`
- `family text NOT NULL` — 13-value CHECK (radiation / noise / air / …)
- Scheduling: `appointmentTitle`, `scheduledStartAt`, `scheduledEndAt`,
  `durationMinutes`, `workerNotifiedAt` (all with clear semantics)
- Site: `siteAddress`, `siteCity`, `fieldContactName`, `fieldContactPhone`,
  `navigationUrl`, `specialInstructions`
- `fieldStatus text NOT NULL DEFAULT 'ASSIGNED'` — 10-value CHECK
- Status timestamps: `assignedAt`, `confirmedAt`, `declinedAt`, `departedAt`,
  `arrivedAt`, `finishedAt`
- Problems: `problemType`, `problemNote`, `hasOpenProblem`
- Missing info: `missingReportInfo`, `missingReportInfoNote`
- `managerNotifiedAt`, `updatedByUserId`, `createdAt`, `updatedAt`, `fieldNotes`

---

## Customer name resolution helper

For ANY query that needs to display "the customer" of a Task, use this
fallback pattern (do NOT hardcode `c.name`):

```sql
COALESCE(
  c.name,
  l."fullName",
  NULLIF(TRIM(CONCAT_WS(' ', l."firstName", l."lastName")), ''),
  l.company,
  p.client,
  il."fromName"
) AS "customerName"
```

with the JOINs:

```sql
LEFT JOIN "Customer"    c  ON c.id  = t."customerId"
LEFT JOIN "Lead"        l  ON l.id  = t."leadId"
LEFT JOIN "Project"     p  ON p.id  = t."projectId"
LEFT JOIN "IncomingLead" il ON il.id = t."incomingLeadId"
```

Order of precedence:
1. Direct `Customer.name` (if `Task.customerId` is set)
2. `Lead.fullName` (imported legacy leads store the full name here)
3. `Lead.firstName + lastName` (composed)
4. `Lead.company` (B2B leads with only company info)
5. `Project.client` (project-based tasks; text field, not FK)
6. `IncomingLead.fromName` (leads that came in via the mailbox)

If ALL six are NULL/empty, the bot may display "לקוח לא ידוע" but this
indicates a data-quality issue that should be flagged, not silenced.

---

## SQL conventions in the CRM schema

- Table names: **PascalCase, quoted** (`"Task"`, `"Customer"`, `"IncomingLead"`).
- Column names: **camelCase, quoted** (`"customerId"`, `"scheduledStartAt"`,
  `"fieldStatus"`).
- Primary keys: text (except `TaskField` and `InspectionType` which use uuid
  via bot migrations).
- `TaskField.taskId` is text-FK to `Task.id` (both text) — no cast needed.
- `TaskField.updatedByUserId` is text-FK to `User.id` (both text).
- The CRM uses PostgreSQL `USER-DEFINED` types (enums) — the bot NEVER writes
  to enum columns.
