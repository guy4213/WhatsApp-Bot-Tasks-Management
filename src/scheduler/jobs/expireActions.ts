import { expireStaleActions, getManagersForBroadcast } from '../../services/pendingActions';
import { notify } from '../../whatsapp/templates';
import { moduleLogger } from '../../utils/logger';

const log = moduleLogger('expireActions');

export async function runExpireActions(): Promise<void> {
  const expired = await expireStaleActions();
  if (expired.length === 0) return;

  log.info({ count: expired.length }, 'Expired stale pending actions');

  await Promise.allSettled(
    expired.map(async (action) => {
      const context = action.taskTitle ? `למשימה "${action.taskTitle}"` : '';
      const title = action.taskTitle ?? '';

      if (action.state === 'PENDING_EMPLOYEE_CONFIRM') {
        // Notify the requester their un-confirmed request timed out
        await notify({
          to: action.requesterPhone,
          key: 'REQUEST_EXPIRED',
          bodyParams: [title],
          fallbackText: `פג תוקף הבקשה ${context} — לא אושרה בזמן.`,
        });
      } else {
        // PENDING_MANAGER_APPROVAL — notify requester AND all active managers
        await notify({
          to: action.requesterPhone,
          key: 'REQUEST_EXPIRED',
          bodyParams: [title],
          fallbackText: `פג תוקף בקשת שינוי המועד ${context} — לא אושרה על ידי מנהל בזמן.`,
        });

        const managers = await getManagersForBroadcast();
        await Promise.allSettled(
          managers.map((m) =>
            notify({
              to: m.phone,
              key: 'REQUEST_EXPIRED_MANAGER',
              bodyParams: [action.requesterName, title],
              fallbackText: `בקשת שינוי מועד ${context} (${action.requesterName}) פגה תוקף — לא טופלה בזמן.`,
            }),
          ),
        );
      }
    }),
  );
}
