import type { ErepClient } from '../erep/client.js';
import type { OwnerPager } from './owner-pager.js';

type ClientForEngine = Pick<ErepClient, 'listCampaigns' | 'getBattleStats'>;

/**
 * Wraps the two ErepClient methods used by the polling engine and reports
 * each call's outcome to the owner-failure pager. The bot + services keep
 * using the unwrapped client (failures there are surfaced through the bot's
 * own resilience policies, not via the polling-source counters).
 */
export function wrapClientForPager(
  inner: ClientForEngine,
  pager: Pick<OwnerPager, 'recordFailure' | 'recordSuccess'>,
): ClientForEngine {
  return {
    async listCampaigns() {
      try {
        const res = await inner.listCampaigns();
        pager.recordSuccess('campaigns');
        return res;
      } catch (err) {
        await pager.recordFailure('campaigns', err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    async getBattleStats(battleId, battleZoneId, division) {
      try {
        const res = await inner.getBattleStats(battleId, battleZoneId, division);
        pager.recordSuccess('battle-stats');
        return res;
      } catch (err) {
        await pager.recordFailure('battle-stats', err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
  };
}
