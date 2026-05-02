import type { BattleStatsResponse, TopDamageEntry } from '../erep/types/battle-stats.js';

export interface VictimMap {
  /** citizenId → set of hunter Telegram IDs that listed this citizen. */
  byCitizen: Map<bigint, Set<bigint>>;
}

export function buildVictimMap(rows: Array<{ hunter: bigint; citizen: bigint }>): VictimMap {
  const byCitizen = new Map<bigint, Set<bigint>>();
  for (const { hunter, citizen } of rows) {
    let set = byCitizen.get(citizen);
    if (!set) {
      set = new Set();
      byCitizen.set(citizen, set);
    }
    set.add(hunter);
  }
  return { byCitizen };
}

export interface PerHunterMatch {
  hunterTelegramId: bigint;
  victims: Array<{
    citizenId: number;
    /** Damage from top_damage entry — used to sort and to render `infl ...M`. */
    influence: number;
    /** Country side ('inv' for invader country, 'def' for defender). */
    side: 'inv' | 'def';
    /** Top-damage rank (1 = highest), or null if not exposed by the response. */
    airRank: number | null;
    /** Resolved name from fightersData (falls back to citizenId-as-string when missing). */
    name: string;
  }>;
}

/**
 * Walks the air-division top_damage list and groups matches by hunter.
 * Returns one entry per hunter that had ≥1 victim in the round.
 *
 * `airRank` is derived from the position of each fighter within their side's
 * top_damage array, since the array is documented as already sorted by damage
 * (descending) per the KB.
 *
 * **Coordinate note**: `zoneId` is the *battle-zone-id* (the key used by
 * `division.bar`), not the outer `stats.current` key. We walk all outer
 * zone_id buckets and filter top_damage entries by `battle_zone_id`.
 */
export function findMatchesForBattle(input: {
  stats: BattleStatsResponse;
  zoneId: number;
  invCountryId: number;
  defCountryId: number;
  victims: VictimMap;
}): PerHunterMatch[] {
  const matchesByHunter = new Map<bigint, PerHunterMatch>();

  const all = collectAirTopDamageForBattleZone(input.stats, input.zoneId);
  const perSide = groupBySide(all, input.invCountryId, input.defCountryId);

  for (const [side, entries] of perSide) {
    entries.forEach((entry, idx) => {
      const hunterSet = input.victims.byCitizen.get(BigInt(entry.citizen_id));
      if (!hunterSet) return;
      const fighterCard = input.stats.fightersData[String(entry.citizen_id)];
      const name = fighterCard?.name ?? String(entry.citizen_id);
      for (const hunterId of hunterSet) {
        let bucket = matchesByHunter.get(hunterId);
        if (!bucket) {
          bucket = { hunterTelegramId: hunterId, victims: [] };
          matchesByHunter.set(hunterId, bucket);
        }
        bucket.victims.push({
          citizenId: entry.citizen_id,
          influence: entry.damage,
          side,
          airRank: idx + 1,
          name,
        });
      }
    });
  }

  return [...matchesByHunter.values()];
}

/** Walks `stats.current.{*}.11.{*}.{*}` and returns top_damage entries whose
 *  `battle_zone_id` matches the given zone id. Order within a side is preserved. */
function collectAirTopDamageForBattleZone(stats: BattleStatsResponse, battleZoneId: number): TopDamageEntry[] {
  const result: TopDamageEntry[] = [];
  for (const zoneEntries of Object.values(stats.stats.current)) {
    const div = zoneEntries['11'];
    if (!div) continue;
    for (const countryEntries of Object.values(div)) {
      for (const battleZoneEntries of Object.values(countryEntries)) {
        for (const entry of battleZoneEntries.top_damage) {
          if (entry.battle_zone_id === battleZoneId) result.push(entry);
        }
      }
    }
  }
  return result;
}

function groupBySide(
  entries: TopDamageEntry[],
  invId: number,
  defId: number,
): Map<'inv' | 'def', TopDamageEntry[]> {
  const inv: TopDamageEntry[] = [];
  const def: TopDamageEntry[] = [];
  for (const e of entries) {
    if (e.side_country_id === invId) inv.push(e);
    else if (e.side_country_id === defId) def.push(e);
    // else: ally fighters — current spec ignores.
  }
  return new Map<'inv' | 'def', TopDamageEntry[]>([
    ['inv', inv],
    ['def', def],
  ]);
}
