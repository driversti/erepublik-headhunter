import { describe, expect, it } from 'vitest';
import { findAirZoneId, type Battle } from '../types/campaigns.js';
import { flattenTopDamage, type BattleStatsResponse } from '../types/battle-stats.js';

const buildZone = (id: number, div: number): Battle['div'][string] => ({
  id,
  div,
  end: null,
  division_end: false,
  epic: 0,
  epic_type: 0,
  intensity_scale: 'cold_war',
  co: { inv: [], def: [] },
  wall: { for: 1, dom: 0 },
  terrain: 0,
});

describe('findAirZoneId', () => {
  it('returns the zone id whose div === 11', () => {
    const battle = {
      div: {
        '111': buildZone(111, 1),
        '222': buildZone(222, 11),
        '333': buildZone(333, 4),
      },
    } as unknown as Battle;
    expect(findAirZoneId(battle)).toBe('222');
  });

  it('returns null when no zone has div === 11', () => {
    const battle = {
      div: {
        '111': buildZone(111, 1),
        '222': buildZone(222, 4),
      },
    } as unknown as Battle;
    expect(findAirZoneId(battle)).toBeNull();
  });

  it('returns null on an empty div map', () => {
    const battle = { div: {} } as unknown as Battle;
    expect(findAirZoneId(battle)).toBeNull();
  });
});

describe('flattenTopDamage', () => {
  const buildEntry = (citizenId: number, country: number) => ({
    battle_zone_id: 1,
    battle_id: 869119,
    zone_id: 8,
    division: 11,
    citizen_id: citizenId,
    damage: 1,
    kills: 0,
    side_country_id: country,
    type: 'top_damage',
    level: 1,
    sector: '',
  });

  it('merges entries from multiple countries into a flat list', () => {
    const stats = {
      stats: {
        current: {
          '8': {
            '11': {
              '52': { '1': { top_damage: [buildEntry(11, 52), buildEntry(12, 52)] } },
              '72': { '1': { top_damage: [buildEntry(21, 72)] } },
            },
          },
        },
      },
    } as unknown as BattleStatsResponse;
    const result = flattenTopDamage(stats, 8, 11);
    expect(result.map((e) => e.citizen_id).sort()).toEqual([11, 12, 21]);
  });

  it('returns [] when the zone is missing', () => {
    const stats = { stats: { current: {} } } as unknown as BattleStatsResponse;
    expect(flattenTopDamage(stats, 8, 11)).toEqual([]);
  });

  it('returns [] when the division is missing', () => {
    const stats = {
      stats: {
        current: {
          '8': { '4': { '52': { '1': { top_damage: [buildEntry(99, 52)] } } } },
        },
      },
    } as unknown as BattleStatsResponse;
    expect(flattenTopDamage(stats, 8, 11)).toEqual([]);
  });

  it('defaults the division to 11', () => {
    const stats = {
      stats: {
        current: {
          '8': { '11': { '52': { '1': { top_damage: [buildEntry(7, 52)] } } } },
        },
      },
    } as unknown as BattleStatsResponse;
    const result = flattenTopDamage(stats, 8); // no division arg
    expect(result.map((e) => e.citizen_id)).toEqual([7]);
  });
});
