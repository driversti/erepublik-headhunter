import type { CampaignsResponse } from '../erep/types/campaigns.js';
import { findAirZoneId } from '../erep/types/campaigns.js';
import type { BattleState } from './types.js';

export interface CampaignsScanInput {
  campaigns: CampaignsResponse;
  /** Lower bound on round elapsed (seconds). Per SPEC §4.4 the cutoff is 5100s (T85+). */
  minElapsedSec: number;
}

export interface CampaignsScanOutput {
  /** Battles to keep / introduce. Keys are `${battleId}:${zoneId}`. Values
   *  carry the descriptive fields the polling engine needs to render alerts. */
  active: Map<string, NewBattleSeed>;
}

export interface NewBattleSeed {
  battleId: bigint;
  zoneId: number;
  start: number;
  invName: string;
  defName: string;
  region: string;
}

/**
 * Pure function: walks the campaigns response and returns the set of battles
 * whose air round meets the T85+ cutoff. Caller diff this against the
 * scheduler's current set to decide what to add/remove.
 */
export function scanCampaigns(input: CampaignsScanInput): CampaignsScanOutput {
  const active = new Map<string, NewBattleSeed>();
  const serverNow = input.campaigns.time;

  for (const battle of Object.values(input.campaigns.battles)) {
    const elapsed = serverNow - battle.start;
    if (elapsed < input.minElapsedSec) continue;

    const airZoneKey = findAirZoneId(battle);
    if (airZoneKey === null) continue;
    const air = battle.div[airZoneKey]!;
    if (air.division_end || air.end !== null) continue; // Round already closed.

    const invName = input.campaigns.countries[String(battle.inv.id)]?.name ?? String(battle.inv.id);
    const defName = input.campaigns.countries[String(battle.def.id)]?.name ?? String(battle.def.id);

    active.set(`${battle.id}:${air.id}`, {
      battleId: BigInt(battle.id),
      zoneId: air.id,
      start: battle.start,
      invName,
      defName,
      region: battle.region.name,
    });
  }

  return { active };
}

/** Helper: builds the initial BattleState for a newly-detected battle (entry probe). */
export function seedToInitialState(seed: NewBattleSeed, now: number): BattleState {
  return {
    battleId: seed.battleId,
    zoneId: seed.zoneId,
    phase: 'probe',
    start: seed.start,
    invName: seed.invName,
    defName: seed.defName,
    region: seed.region,
    lastEtaSec: null,
    /** Probe immediately (within the next tick). */
    nextActionAt: now,
  };
}
