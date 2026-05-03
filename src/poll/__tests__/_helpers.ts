import type { BattleStatsResponse, TopDamageEntry } from '../../erep/types/battle-stats.js';
import type { BattleState } from '../types.js';

export interface MockStatsOverrides {
  zoneId?: number;
  leader?: number;
  defender?: number;
  leaderPoints?: number;
  defenderPoints?: number;
  zone_finished?: boolean;
  invTopDamage?: TopDamageEntry[];
  defTopDamage?: TopDamageEntry[];
  domination?: number;
  fightersData?: Record<string, { id: number; name: string; avatar: string }>;
}

export const mockStats = (o: MockStatsOverrides = {}): BattleStatsResponse => {
  const zoneId = o.zoneId ?? 38158390;
  const zoneKey = String(zoneId);
  const leader = o.leader ?? 72;
  const defender = o.defender ?? (leader === 72 ? 52 : 72);
  return {
    stats: {
      personal: [],
      current: {
        '8': {
          '11': {
            [String(leader)]: { [zoneKey]: { top_damage: o.invTopDamage ?? [] } },
            [String(defender)]: { [zoneKey]: { top_damage: o.defTopDamage ?? [] } },
          },
        },
      },
      overall: [],
    },
    zone_finished: o.zone_finished ?? false,
    division: {
      created_at: 0,
      bar: { [zoneKey]: leader },
      domination: { [zoneKey]: o.domination ?? 0 },
      defence_shield: { [zoneKey]: 0 },
      [String(leader)]: { [zoneKey]: { domination: o.leaderPoints ?? 0, won: 0 } },
      [String(defender)]: { [zoneKey]: { domination: o.defenderPoints ?? 0, won: 0 } },
    } as never,
    fightersData: o.fightersData ?? {},
    opponentsInQueue: 0,
    isInQueue: false,
    campaigns: [],
    epicBattle: 0,
    activeEffects: [],
    battleEffects: {},
    maxHit: 0,
    most_contested: [],
    battle_zone_situation: { [zoneKey]: 0 },
  };
};

export const buildBattleState = (overrides: Partial<BattleState> = {}): BattleState => ({
  battleId: overrides.battleId ?? 869119n,
  zoneId: overrides.zoneId ?? 38158390,
  phase: overrides.phase ?? 'probe',
  start: overrides.start ?? 1000,
  invName: overrides.invName ?? 'Iran',
  defName: overrides.defName ?? 'Russia',
  region: overrides.region ?? 'TestRegion',
  lastEtaSec: overrides.lastEtaSec ?? null,
  nextActionAt: overrides.nextActionAt ?? 0,
});
