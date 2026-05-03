import { describe, expect, it } from 'vitest';
import { buildVictimMap, findMatchesForBattle } from '../matching.js';
import type { BattleStatsResponse, TopDamageEntry } from '../../erep/types/battle-stats.js';

const BZ = 38158390; // battle-zone-id used across tests
const INV = 52;
const DEF = 72;

const td = (overrides: Partial<TopDamageEntry> & { citizen_id: number; damage: number; side_country_id: number }): TopDamageEntry => ({
  battle_zone_id: BZ,
  battle_id: 869119,
  zone_id: 8,
  division: 11,
  kills: 0,
  type: 'top_damage',
  level: 100,
  sector: '',
  ...overrides,
});

const buildStats = (perSide: { inv: TopDamageEntry[]; def: TopDamageEntry[] }, names: Record<string, string> = {}): BattleStatsResponse => ({
  stats: {
    personal: [],
    current: {
      '8': {
        '11': {
          [String(INV)]: { [String(BZ)]: { top_damage: perSide.inv } },
          [String(DEF)]: { [String(BZ)]: { top_damage: perSide.def } },
        },
      },
    },
    overall: [],
  },
  zone_finished: false,
  division: {
    created_at: 0,
    bar: { [String(BZ)]: DEF },
    domination: { [String(BZ)]: 0 },
    defence_shield: { [String(BZ)]: 0 },
  } as never,
  fightersData: Object.fromEntries(
    Object.entries(names).map(([id, name]) => [id, { id: Number(id), name, avatar: '' }]),
  ),
  opponentsInQueue: 0,
  isInQueue: false,
  campaigns: [],
  epicBattle: 0,
  activeEffects: [],
  battleEffects: {},
  maxHit: 0,
  most_contested: [],
  battle_zone_situation: { [String(BZ)]: 0 },
});

describe('buildVictimMap', () => {
  it('groups [{hunter, citizen}] rows into a byCitizen map of sets', () => {
    const map = buildVictimMap([
      { hunter: 100n, citizen: 1n },
      { hunter: 100n, citizen: 2n },
      { hunter: 200n, citizen: 1n },
    ]);
    expect(map.byCitizen.get(1n)).toEqual(new Set([100n, 200n]));
    expect(map.byCitizen.get(2n)).toEqual(new Set([100n]));
  });

  it('returns an empty map for empty input', () => {
    const map = buildVictimMap([]);
    expect(map.byCitizen.size).toBe(0);
  });
});

describe('findMatchesForBattle', () => {
  it('returns one PerHunterMatch entry per hunter that has ≥1 victim', () => {
    const stats = buildStats(
      {
        inv: [td({ citizen_id: 1, damage: 100, side_country_id: INV })],
        def: [td({ citizen_id: 2, damage: 50, side_country_id: DEF })],
      },
      { '1': 'Alpha', '2': 'Bravo' },
    );
    const victims = buildVictimMap([
      { hunter: 100n, citizen: 1n },
      { hunter: 200n, citizen: 2n },
    ]);
    const result = findMatchesForBattle({ stats, zoneId: BZ, invCountryId: INV, defCountryId: DEF, victims });
    expect(result).toHaveLength(2);
    const hunters = new Set(result.map((r) => r.hunterTelegramId));
    expect(hunters).toEqual(new Set([100n, 200n]));
  });

  it('combines multiple victims for one hunter into a single PerHunterMatch', () => {
    const stats = buildStats(
      {
        inv: [
          td({ citizen_id: 1, damage: 100, side_country_id: INV }),
          td({ citizen_id: 2, damage: 80, side_country_id: INV }),
        ],
        def: [],
      },
      { '1': 'A', '2': 'B' },
    );
    const victims = buildVictimMap([
      { hunter: 100n, citizen: 1n },
      { hunter: 100n, citizen: 2n },
    ]);
    const result = findMatchesForBattle({ stats, zoneId: BZ, invCountryId: INV, defCountryId: DEF, victims });
    expect(result).toHaveLength(1);
    expect(result[0]?.victims).toHaveLength(2);
    expect(result[0]?.victims.map((v) => v.citizenId).sort()).toEqual([1, 2]);
  });

  it('returns multiple PerHunterMatch entries when same victim is on multiple hunters lists', () => {
    const stats = buildStats(
      { inv: [td({ citizen_id: 1, damage: 100, side_country_id: INV })], def: [] },
      { '1': 'A' },
    );
    const victims = buildVictimMap([
      { hunter: 100n, citizen: 1n },
      { hunter: 200n, citizen: 1n },
    ]);
    const result = findMatchesForBattle({ stats, zoneId: BZ, invCountryId: INV, defCountryId: DEF, victims });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.victims.length === 1 && r.victims[0]?.citizenId === 1)).toBe(true);
  });

  it('airRank is the 1-indexed position within the side top_damage array', () => {
    const stats = buildStats(
      {
        inv: [
          td({ citizen_id: 10, damage: 1000, side_country_id: INV }),
          td({ citizen_id: 20, damage: 500, side_country_id: INV }),
          td({ citizen_id: 30, damage: 100, side_country_id: INV }),
        ],
        def: [],
      },
      { '10': 'first', '30': 'third' },
    );
    const victims = buildVictimMap([
      { hunter: 100n, citizen: 10n },
      { hunter: 100n, citizen: 30n },
    ]);
    const result = findMatchesForBattle({ stats, zoneId: BZ, invCountryId: INV, defCountryId: DEF, victims });
    const ranks = Object.fromEntries(result[0]!.victims.map((v) => [v.citizenId, v.airRank]));
    expect(ranks).toEqual({ 10: 1, 30: 3 });
  });

  it('side is assigned by side_country_id matching invCountryId / defCountryId', () => {
    const stats = buildStats(
      {
        inv: [td({ citizen_id: 1, damage: 1, side_country_id: INV })],
        def: [td({ citizen_id: 2, damage: 1, side_country_id: DEF })],
      },
      {},
    );
    const victims = buildVictimMap([
      { hunter: 100n, citizen: 1n },
      { hunter: 100n, citizen: 2n },
    ]);
    const result = findMatchesForBattle({ stats, zoneId: BZ, invCountryId: INV, defCountryId: DEF, victims });
    const sides = Object.fromEntries(result[0]!.victims.map((v) => [v.citizenId, v.side]));
    expect(sides).toEqual({ 1: 'inv', 2: 'def' });
  });

  it('name falls back to citizen-id string when fightersData lacks the entry', () => {
    const stats = buildStats(
      { inv: [td({ citizen_id: 9999, damage: 100, side_country_id: INV })], def: [] },
      {}, // no fightersData
    );
    const victims = buildVictimMap([{ hunter: 100n, citizen: 9999n }]);
    const result = findMatchesForBattle({ stats, zoneId: BZ, invCountryId: INV, defCountryId: DEF, victims });
    expect(result[0]?.victims[0]?.name).toBe('9999');
  });

  it('fighters not in any victim list yield no match entries', () => {
    const stats = buildStats(
      { inv: [td({ citizen_id: 42, damage: 100, side_country_id: INV })], def: [] },
      { '42': 'Stranger' },
    );
    const victims = buildVictimMap([{ hunter: 100n, citizen: 999n }]);
    const result = findMatchesForBattle({ stats, zoneId: BZ, invCountryId: INV, defCountryId: DEF, victims });
    expect(result).toEqual([]);
  });

  it('only includes top_damage entries whose battle_zone_id matches state.zoneId', () => {
    const stats = buildStats({ inv: [], def: [] }, { '1': 'A' });
    // Inject a foreign battle-zone entry into the same outer zone.
    stats.stats.current['8']!['11']![String(INV)]![String(BZ + 1)] = {
      top_damage: [td({ citizen_id: 1, damage: 100, side_country_id: INV, battle_zone_id: BZ + 1 })],
    };
    const victims = buildVictimMap([{ hunter: 100n, citizen: 1n }]);
    const result = findMatchesForBattle({ stats, zoneId: BZ, invCountryId: INV, defCountryId: DEF, victims });
    expect(result).toEqual([]);
  });
});
