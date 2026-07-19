/**
 * Scheduler job: poll Green API instance state every 5 minutes and drive the
 * health-alert logic (services/greenapiHealth.ts) when the phone leaves the
 * `authorized` state.
 *
 * Advisory lock id 1013 (`greenapiHealthCheck`) prevents concurrent runs across
 * instances — see src/scheduler/index.ts. The job is a no-op when the active
 * transport is not Green API.
 */
import { moduleLogger } from '../../utils/logger';
import { pollGreenApiState } from '../../services/greenapiHealth';

const log = moduleLogger('greenapi-health-check');

export async function runGreenApiHealthCheck(): Promise<void> {
  const provider = (process.env.WHATSAPP_PROVIDER ?? 'greenapi').trim().toLowerCase();
  if (provider !== 'greenapi') {
    log.debug({ provider }, 'Not on Green API — skipping health poll');
    return;
  }
  await pollGreenApiState();
}
