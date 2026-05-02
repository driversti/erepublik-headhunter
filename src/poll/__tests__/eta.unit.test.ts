import { describe, expect, it } from 'vitest';
import { rampRateAtMinute, computeRefinedEta } from '../eta.js';
import type { BattleStatsResponse } from '../../erep/types/battle-stats.js';

describe('rampRateAtMinute', () => {
  it.each([
    [0, 10],
    [30, 10],
    [31, 20],
    [60, 20],
    [61, 30],
    [90, 30],
    [91, 60],
    [119, 60],
  ])('elapsed=%d → rate=%d pts/min', (elapsed, expected) => {
    expect(rampRateAtMinute(elapsed)).toBe(expected);
  });
});

const mockStats = (overrides: {
  zoneKey?: string;
  leader?: number;
  leaderPoints?: number;
  defenderPoints?: number;
}): BattleStatsResponse => {
  const zoneKey = overrides.zoneKey ?? '38158390';
  const leader = overrides.leader ?? 72;
  const defender = leader === 72 ? 52 : 72;
  return {
    stats: { personal: [], current: {}, overall: [] },
    zone_finished: false,
    division: {
      created_at: 0,
      bar: { [zoneKey]: leader },
      domination: { [zoneKey]: 0 },
      defence_shield: { [zoneKey]: 0 },
      [String(leader)]: { [zoneKey]: { domination: overrides.leaderPoints ?? 0, won: 0 } },
      [String(defender)]: { [zoneKey]: { domination: overrides.defenderPoints ?? 0, won: 0 } },
    } as never,
    fightersData: {},
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

describe('computeRefinedEta', () => {
  it('returns ETA when leader has accumulated points and is rising at the current ramp', () => {
    // T85: rate = 30 pts/min. Leader at 1500; remaining 300; ETA = 300/30 * 60 = 600s = 10 min.
    const result = computeRefinedEta({
      stats: mockStats({ leader: 72, leaderPoints: 1500 }),
      zoneId: 38158390,
      roundStartUnix: 1000,
      serverNowUnix: 1000 + 85 * 60,
    });
    expect(result).not.toBeNull();
    expect(result!.etaSec).toBeCloseTo(600, 0);
    expect(result!.leaderCountryId).toBe(72);
    expect(result!.leaderPoints).toBe(1500);
    expect(result!.currentRatePm).toBe(30);
  });

  it('returns ETA=0 when leader has reached 1800 already', () => {
    const result = computeRefinedEta({
      stats: mockStats({ leader: 72, leaderPoints: 1800 }),
      zoneId: 38158390,
      roundStartUnix: 1000,
      serverNowUnix: 1000 + 85 * 60,
    });
    expect(result?.etaSec).toBe(0);
  });

  it('uses the 60 pts/min rate after T90', () => {
    // T100: rate = 60 pts/min. Leader at 600; remaining 1200; ETA = 1200/60 * 60 = 1200s = 20 min.
    // Capped by the round itself at T120 → 20 min remaining; equal here.
    const result = computeRefinedEta({
      stats: mockStats({ leader: 72, leaderPoints: 600 }),
      zoneId: 38158390,
      roundStartUnix: 1000,
      serverNowUnix: 1000 + 100 * 60,
    });
    expect(result?.currentRatePm).toBe(60);
    expect(result?.etaSec).toBeCloseTo(1200, 0);
  });

  it('returns null when bar lacks the zone (e.g. round just ended)', () => {
    const stats = mockStats({});
    delete (stats.division.bar as Record<string, number>)['38158390'];
    expect(
      computeRefinedEta({
        stats,
        zoneId: 38158390,
        roundStartUnix: 1000,
        serverNowUnix: 1000 + 85 * 60,
      }),
    ).toBeNull();
  });

  it('returns null when leader country has no per-zone domination entry', () => {
    const stats = mockStats({ leader: 72, leaderPoints: 1000 });
    delete ((stats.division as Record<string, unknown>)['72'] as Record<string, unknown>)['38158390'];
    expect(
      computeRefinedEta({
        stats,
        zoneId: 38158390,
        roundStartUnix: 1000,
        serverNowUnix: 1000 + 85 * 60,
      }),
    ).toBeNull();
  });
});
