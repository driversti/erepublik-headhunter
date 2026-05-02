import type { Logger } from '../erep/logger.js';
import type { AlertedRoundsRepo } from '../db/repos/alerted-rounds.js';

/** Daily cleanup job. Returns the number of rows deleted. */
export async function runCleanup(deps: {
  alertedRounds: Pick<AlertedRoundsRepo, 'pruneOlderThan'>;
  olderThanHours?: number;
  logger?: Logger;
}): Promise<number> {
  const olderThanHours = deps.olderThanHours ?? 48;
  try {
    const removed = await deps.alertedRounds.pruneOlderThan({ olderThanHours });
    deps.logger?.info('poll.cleanup.done', { removed, olderThanHours });
    return removed;
  } catch (err) {
    deps.logger?.error('poll.cleanup.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
