import type { Logger } from '../erep/logger.js';
import type { ErepClient } from '../erep/client.js';
import { computeRefinedEta } from './eta.js';
import type { BattlePhase, BattleState } from './types.js';

export interface ProbeDeps {
  client: Pick<ErepClient, 'getBattleStats'>;
  /** Server-now provider — campaigns response `time` cached by the engine. */
  serverNow: () => number;
  /** Local-now provider, used to compute nextActionAt. Defaults to seconds-since-epoch. */
  localNow: () => number;
  logger?: Logger;
  /** Window threshold in seconds (default 300 per SPEC). */
  windowSec: number;
  /** Probe lead in seconds (default 300 per SPEC). */
  probeLeadSec: number;
}

export type ProbeOutcome =
  | { kind: 'remove' }
  | { kind: 'reschedule'; phase: BattlePhase; nextActionAt: number; lastEtaSec: number | null };

/**
 * Single ETA probe. Fetches battle-stats once, computes refined ETA, and
 * returns what the engine should do next:
 *   - `remove` if zone_finished or computeRefinedEta cannot resolve a leader.
 *   - `reschedule` with phase='monitor' if ETA ≤ window.
 *   - `reschedule` with phase='probe' otherwise, with nextActionAt =
 *     localNow + clamp(eta_s - probeLeadSec, 30, 600).
 */
export async function runProbe(state: BattleState, deps: ProbeDeps): Promise<ProbeOutcome> {
  let stats;
  try {
    stats = await deps.client.getBattleStats(state.battleId, state.zoneId, 11);
  } catch (err) {
    deps.logger?.warn('poll.probe.fetch_failed', {
      battleId: state.battleId.toString(),
      zoneId: state.zoneId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Re-try in 60s — transient errors should not drop the battle.
    return { kind: 'reschedule', phase: 'probe', nextActionAt: deps.localNow() + 60, lastEtaSec: state.lastEtaSec };
  }
  if (stats.zone_finished) return { kind: 'remove' };

  const eta = computeRefinedEta({
    stats,
    zoneId: state.zoneId,
    roundStartUnix: state.start,
    serverNowUnix: deps.serverNow(),
  });
  if (!eta) return { kind: 'remove' };

  if (eta.etaSec <= deps.windowSec) {
    // Promote to monitor immediately (in-window).
    return {
      kind: 'reschedule',
      phase: 'monitor',
      nextActionAt: deps.localNow(),
      lastEtaSec: eta.etaSec,
    };
  }

  // Schedule next probe per SPEC §4.4: clamp(eta - probeLead, 30, 600) seconds.
  const delay = Math.min(600, Math.max(30, eta.etaSec - deps.probeLeadSec));
  return {
    kind: 'reschedule',
    phase: 'probe',
    nextActionAt: deps.localNow() + delay,
    lastEtaSec: eta.etaSec,
  };
}
