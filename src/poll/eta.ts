import type { BattleStatsResponse } from '../erep/types/battle-stats.js';
import type { EtaResult } from './types.js';

/** SPEC §8 ramp rate, in points per minute. */
export function rampRateAtMinute(elapsedMin: number): number {
  if (elapsedMin <= 30) return 10;
  if (elapsedMin <= 60) return 20;
  if (elapsedMin <= 90) return 30;
  return 60;
}

/**
 * Computes refined ETA from a battle-stats response and the campaigns-supplied
 * round-start + server-now timestamps.
 *
 * **Domination units assumption** (SPEC §13.3 — verify against live data):
 * we assume `division.{countryId}.{zoneId}.domination` is the per-country round
 * points (0–1800). If a real fetch shows it's actually a percentage 0-100,
 * change the `pointsFromDomination` helper to multiply by 18.
 */
export function computeRefinedEta(input: {
  stats: BattleStatsResponse;
  zoneId: number;
  /** From campaigns response: per-round start. */
  roundStartUnix: number;
  /** From campaigns response: top-level `time`. */
  serverNowUnix: number;
}): EtaResult | null {
  const zoneKey = String(input.zoneId);
  // `bar` can be omitted altogether on early-round responses where neither
  // side has yet dominated. The type is optimistic; defend against the wire.
  const leaderCountryId = input.stats.division.bar?.[zoneKey];
  if (leaderCountryId === undefined) return null;

  const leaderPoints = pointsFor(input.stats, leaderCountryId, zoneKey);
  if (leaderPoints === null) return null;

  const elapsedMin = Math.max(0, (input.serverNowUnix - input.roundStartUnix) / 60);
  const currentRatePm = rampRateAtMinute(elapsedMin);

  const remainingPoints = Math.max(0, 1800 - leaderPoints);
  if (remainingPoints === 0) {
    // Round just hit 1800 (or response is stale); ETA effectively zero.
    return { etaSec: 0, leaderCountryId, leaderPoints, currentRatePm };
  }

  const etaSec = (remainingPoints / currentRatePm) * 60;
  return { etaSec, leaderCountryId, leaderPoints, currentRatePm };
}

function pointsFor(stats: BattleStatsResponse, countryId: number, zoneKey: string): number | null {
  const countryEntry = (stats.division as Record<string, unknown>)[String(countryId)];
  if (!countryEntry || typeof countryEntry !== 'object') return null;
  const zoneEntry = (countryEntry as Record<string, unknown>)[zoneKey];
  if (!zoneEntry || typeof zoneEntry !== 'object') return null;
  const dom = (zoneEntry as { domination?: unknown }).domination;
  if (typeof dom !== 'number') return null;
  return dom;
}
