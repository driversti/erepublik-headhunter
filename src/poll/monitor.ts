import type { Logger } from '../erep/logger.js';
import type { ErepClient } from '../erep/client.js';
import type { MatchesService, MatchAlertInput } from '../services/matches.js';
import { computeRefinedEta } from './eta.js';
import { findMatchesForBattle, type VictimMap } from './matching.js';
import type { BattleState } from './types.js';

export interface MonitorDeps {
  client: Pick<ErepClient, 'getBattleStats'>;
  matches: Pick<MatchesService, 'maybeAlert'>;
  /** Returns the latest victim-map snapshot. Built once per scan by the engine. */
  victims: () => VictimMap;
  /** Country ids for this battle's invader/defender — supplied by the engine
   *  from the cached campaigns response. */
  countriesFor: (battleId: bigint) => { inv: number; def: number } | null;
  serverNow: () => number;
  localNow: () => number;
  logger?: Logger;
  windowSec: number;
  monitorIntervalSec: number;
  probeLeadSec: number;
}

export type MonitorOutcome =
  | { kind: 'remove' }
  | { kind: 'reschedule'; phase: 'monitor' | 'probe'; nextActionAt: number; lastEtaSec: number | null };

/**
 * In-window scan: fetches battle-stats, recomputes ETA, finds matches, and
 * fires `MatchesService.maybeAlert` per matched hunter. Hysteresis: if ETA
 * climbs back above `windowSec`, demote to 'probe' (per REVIEW_NOTES.md §3.2).
 */
export async function runMonitor(state: BattleState, deps: MonitorDeps): Promise<MonitorOutcome> {
  let stats;
  try {
    stats = await deps.client.getBattleStats(state.battleId, state.zoneId, 11);
  } catch (err) {
    deps.logger?.warn('poll.monitor.fetch_failed', {
      battleId: state.battleId.toString(),
      zoneId: state.zoneId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: 'reschedule',
      phase: 'monitor',
      nextActionAt: deps.localNow() + deps.monitorIntervalSec,
      lastEtaSec: state.lastEtaSec,
    };
  }
  if (stats.zone_finished) return { kind: 'remove' };

  const eta = computeRefinedEta({
    stats,
    zoneId: state.zoneId,
    roundStartUnix: state.start,
    serverNowUnix: deps.serverNow(),
  });
  if (!eta) return { kind: 'remove' };

  // Hysteresis: if ETA back-flipped above the window, demote to probe.
  if (eta.etaSec > deps.windowSec) {
    const delay = Math.min(600, Math.max(30, eta.etaSec - deps.probeLeadSec));
    return {
      kind: 'reschedule',
      phase: 'probe',
      nextActionAt: deps.localNow() + delay,
      lastEtaSec: eta.etaSec,
    };
  }

  // Find matches and fire alerts.
  const countries = deps.countriesFor(state.battleId);
  if (countries) {
    const perHunter = findMatchesForBattle({
      stats,
      zoneId: state.zoneId,
      invCountryId: countries.inv,
      defCountryId: countries.def,
      victims: deps.victims(),
    });
    const wallDom = stats.division.domination[String(state.zoneId)] ?? 0;
    const wallHolderId = stats.division.bar[String(state.zoneId)] ?? countries.inv;
    const wallHolderName =
      wallHolderId === countries.inv ? state.invName : wallHolderId === countries.def ? state.defName : String(wallHolderId);
    for (const hunterMatch of perHunter) {
      const alert: MatchAlertInput = {
        hunter: { telegramId: hunterMatch.hunterTelegramId },
        battle: {
          battleId: state.battleId,
          zoneId: state.zoneId,
          invName: state.invName,
          defName: state.defName,
          region: state.region,
        },
        timing: {
          etaMinutes: Math.max(0, Math.round(eta.etaSec / 60)),
          wallDom: Math.round(wallDom),
          wallHolder: wallHolderName,
        },
        matchedVictims: hunterMatch.victims.map((v) => ({
          citizenId: v.citizenId,
          name: v.name,
          side: v.side,
          influence: v.influence,
          airRank: v.airRank,
        })),
      };
      // maybeAlert is resilient (returns 'sent' / 'already_alerted' / 'send_failed');
      // dedup repo + sender's logger handle observability.
      await deps.matches.maybeAlert(alert);
    }
  }

  return {
    kind: 'reschedule',
    phase: 'monitor',
    nextActionAt: deps.localNow() + deps.monitorIntervalSec,
    lastEtaSec: eta.etaSec,
  };
}
