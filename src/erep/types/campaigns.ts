/** Public `/en/military/campaignsJson/list` response. KB ref: campaigns.md. */
export interface CampaignsResponse {
  battles: Record<string, Battle>;
  countries: Record<string, CountryInfo>;
  last_updated: number;
  /** Server Unix timestamp — use this for elapsed/ETA math, not Date.now(). */
  time: number;
}

export interface Battle {
  id: number;
  war_id: number;
  zone_id: number;
  is_rw: boolean;
  is_as: boolean;
  type: string;
  /** Per-round start timestamp (battle-level — all 5 divisions share it). */
  start: number;
  det: number;
  region: { id: number; name: string };
  city: { id: number; name: string };
  is_dict: boolean;
  is_lib: boolean;
  war_type: string;
  inv: SideInfo;
  def: SideInfo;
  /** Map of battle-zone-id → division round. Keys are stringified numbers. */
  div: Record<string, BattleZone>;
  terrainTypes: number[];
  effects: unknown;
  hasMultipleTerrains: boolean;
  isMultiZone: boolean;
}

export interface SideInfo {
  id: number;
  allies: number[];
  ally_list: unknown[];
  points: number;
}

export interface BattleZone {
  id: number;
  /** Division number: 1-4 ground, 11 air. */
  div: number;
  /** Round-end Unix timestamp. `null` while round is active. */
  end: number | null;
  division_end: boolean;
  epic: number;
  epic_type: number;
  intensity_scale: string;
  co: { inv: unknown[]; def: unknown[] };
  wall: WallInfo;
  terrain: number;
}

export interface WallInfo {
  /** Country ID currently holding the wall. */
  for: number;
  /** Wall-domination percentage (0-100). */
  dom: number;
}

export interface CountryInfo {
  id: number;
  name: string;
  allies: number[];
  is_empire: boolean;
  /** Campaign-of-the-day battle ID, or 0 if none. */
  cotd: number;
}

/** Helper: returns the air-division zone id (the key in battle.div whose value has div === 11). */
export function findAirZoneId(battle: Battle): string | null {
  for (const [zoneId, zone] of Object.entries(battle.div)) {
    if (zone.div === 11) return zoneId;
  }
  return null;
}
