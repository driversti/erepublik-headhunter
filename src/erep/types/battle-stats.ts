/**
 * GET `/en/military/battle-stats/{battleId}/{division}/{battleZoneId}` response.
 * KB ref: battle-info.md. We model only the subset the polling engine needs.
 *
 * **Open question (carried from SPEC §13.3):** the units of `division.domination`
 * vs `division.{countryId}.{zoneId}.domination` are ambiguous in the KB.
 * The example response shows values like 83.7646 and 90 — likely percentages,
 * but the KB note "Can exceed 100, representing accumulated domination points"
 * suggests they may also represent raw round points. The polling-engine plan
 * is responsible for resolving this by inspecting a real live response and
 * adjusting the ETA math accordingly. For now, we type both as `number` and
 * leave interpretation to consumers.
 */
export interface BattleStatsResponse {
  stats: {
    personal: unknown[];
    /** Nested as `{ zoneId → divisionId → countryId → battleZoneId → { top_damage: [...] } }`. */
    current: Record<string, Record<string, Record<string, Record<string, { top_damage: TopDamageEntry[] }>>>>;
    overall: unknown[];
  };
  zone_finished: boolean;
  /** Absent on some early-round responses; callers must guard before access. */
  division?: DivisionStats;
  /** Citizen-id → minimal citizen card. Used to resolve names/avatars in alerts. */
  fightersData: Record<string, FighterRow>;
  opponentsInQueue: number;
  isInQueue: boolean;
  campaigns: unknown[];
  epicBattle: number;
  activeEffects: unknown[];
  battleEffects: Record<string, unknown>;
  maxHit: number;
  most_contested: unknown[];
  battle_zone_situation: Record<string, number>;
}

export interface DivisionStats {
  created_at: number;
  /** battle-zone-id → country-id holding the wall. */
  bar: Record<string, number>;
  /** battle-zone-id → "domination" value (see open-question note above). */
  domination: Record<string, number>;
  defence_shield: Record<string, number | null>;
  /** Per-country breakdown keyed by stringified country id (numeric strings only). */
  [countryId: string]: unknown;
}

export interface FighterRow {
  id: number;
  name: string;
  avatar: string;
}

export interface TopDamageEntry {
  battle_zone_id: number;
  battle_id: number;
  zone_id: number;
  division: number;
  citizen_id: number;
  damage: number;
  kills: number;
  side_country_id: number;
  type: string;
  level: number;
  sector: string;
}

/** Helper: walks `stats.current.{zoneId}.{divisionId}` and returns the flat list of top_damage entries across both sides. */
export function flattenTopDamage(
  stats: BattleStatsResponse,
  zoneId: number,
  division: number = 11,
): TopDamageEntry[] {
  const zone = stats.stats.current[String(zoneId)];
  if (!zone) return [];
  const div = zone[String(division)];
  if (!div) return [];
  const result: TopDamageEntry[] = [];
  for (const countryEntries of Object.values(div)) {
    for (const battleZoneEntries of Object.values(countryEntries)) {
      result.push(...battleZoneEntries.top_damage);
    }
  }
  return result;
}
