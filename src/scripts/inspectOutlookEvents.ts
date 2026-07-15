/**
 * READ-ONLY, one-off diagnostic — safe to run anytime.
 *
 * Prints the raw Outlook calendar events for a given user (subject / location /
 * isAllDay / isOnlineMeeting / start), so a human can eyeball which events are
 * גלית field inspections vs. regular meetings. This is the tool that surfaced
 * the three real Yoram templates ("בדיקדת קרינה…", "בדיקת צוות מריחים…",
 * "סקר אסבסט") and the recurring "בדיקדת" typo.
 *
 * Kept in the repo on purpose: use it to re-calibrate the FIELD_DOMAIN_KEYWORDS
 * / FIELD_ACTION_KEYWORDS lists in services/voiceTools.ts whenever the field
 * team's event-naming habits change. It reads ONLY (goes through the CRM's
 * stored Outlook connection via listCrmCalendarEvents) — it never writes.
 *
 * Usage:
 *   npx tsx src/scripts/inspectOutlookEvents.ts <userId> [daysAhead=30] [daysBack=7]
 */
import { listCrmCalendarEvents } from '../services/crmApi';

async function main(): Promise<void> {
  const userId = process.argv[2];
  if (!userId) {
    console.error('usage: inspectOutlookEvents.ts <userId> [daysAhead=30] [daysBack=7]');
    process.exit(1);
    return;
  }
  const daysAhead = Number(process.argv[3] ?? 30);
  const daysBack = Number(process.argv[4] ?? 7);

  const now = Date.now();
  const startIso = new Date(now - daysBack * 86_400_000).toISOString();
  const endIso = new Date(now + daysAhead * 86_400_000).toISOString();

  const events = await listCrmCalendarEvents(userId, { startIso, endIso, top: 100 });
  console.log(`\n${events.length} Outlook events for user ${userId} (${startIso} → ${endIso}):\n`);
  for (const e of events) {
    console.log(
      [
        `subject   : ${e.subject ?? '(none)'}`,
        `location  : ${e.location ?? '(none)'}`,
        `start     : ${e.start?.dateTime ?? '(none)'}`,
        `isAllDay  : ${e.isAllDay}`,
        `isOnline  : ${e.isOnlineMeeting}`,
        '---',
      ].join('\n'),
    );
  }
}

main().catch((err) => {
  console.error('inspectOutlookEvents failed:', err);
  process.exit(1);
});
