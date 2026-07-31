import type { ErepClient } from '../erep/client.js';
import type { Logger } from '../erep/logger.js';
import type { OwnerPager } from './owner-pager.js';

type ClientForEngine = Pick<ErepClient, 'listCampaigns' | 'getBattleStats'>;

export interface EngineGuardDeps {
  pager: Pick<OwnerPager, 'recordFailure' | 'recordSuccess'>;
  /** Sends an HTML message to the owner. Rejections are caught and logged. */
  notifyOwner: (html: string) => Promise<void>;
  now?: () => number;
  canaryIntervalMs?: number;
  reminderIntervalMs?: number;
  logger?: Logger;
}

/**
 * Wraps the two ErepClient methods used by the polling engine. Owns two
 * concerns that must stay coordinated (see
 * docs/superpowers/specs/2026-07-31-auth-verification-gate-design.md):
 *
 * 1. Owner-failure pager accounting (previously wrap-client.ts).
 * 2. The verification-gate state machine — pager counters freeze while the
 *    gate is active, which is why one wrapper owns both.
 */
export function guardEngineClient(
  inner: ClientForEngine,
  deps: EngineGuardDeps,
): ClientForEngine {
  const pager = deps.pager;

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
