import { describe, expect, it, vi } from 'vitest';
import { runMonitor } from '../monitor.js';
import { buildVictimMap, type VictimMap } from '../matching.js';
import { buildBattleState, mockStats } from './_helpers.js';
import type { TopDamageEntry } from '../../erep/types/battle-stats.js';

const ROUND_START = 1000;
const SERVER_AT_85 = ROUND_START + 85 * 60;
const LOCAL_NOW = 50000;
const INV = 52;
const DEF = 72;
const BZ = 38158390;

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

const buildDeps = (opts: {
  stats?: ReturnType<typeof mockStats>;
  throwErr?: Error;
  victims?: VictimMap;
  countries?: { inv: number; def: number } | null;
}) => {
  const getBattleStats = vi.fn();
  if (opts.throwErr) {
    getBattleStats.mockRejectedValue(opts.throwErr);
  } else {
    getBattleStats.mockResolvedValue(opts.stats ?? mockStats({ leader: DEF, defender: INV }));
  }
  const maybeAlert = vi.fn().mockResolvedValue('sent');
  return {
    deps: {
      client: { getBattleStats },
      matches: { maybeAlert },
      victims: () => opts.victims ?? buildVictimMap([]),
      countriesFor: vi.fn().mockReturnValue(opts.countries === undefined ? { inv: INV, def: DEF } : opts.countries),
      serverNow: () => SERVER_AT_85,
      localNow: () => LOCAL_NOW,
      windowSec: 300,
      monitorIntervalSec: 30,
      probeLeadSec: 300,
    },
    getBattleStats,
    maybeAlert,
  };
};

describe('runMonitor', () => {
  it('returns remove when zone_finished is true', async () => {
    const { deps } = buildDeps({ stats: mockStats({ zone_finished: true }) });
    const result = await runMonitor(buildBattleState({ start: ROUND_START }), deps);
    expect(result).toEqual({ kind: 'remove' });
  });

  it('demotes to probe when ETA back-flipped above windowSec (hysteresis)', async () => {
    // Leader at 1500 → ETA 600s > 300 → demote to probe with delay = clamp(300, 30, 600) = 300.
    const stats = mockStats({ leader: DEF, defender: INV, leaderPoints: 1500 });
    const { deps, maybeAlert } = buildDeps({ stats });
    const result = await runMonitor(buildBattleState({ start: ROUND_START }), deps);
    expect(result).toMatchObject({
      kind: 'reschedule',
      phase: 'probe',
      nextActionAt: LOCAL_NOW + 300,
    });
    expect(maybeAlert).not.toHaveBeenCalled();
  });

  it('fires maybeAlert once per matched hunter', async () => {
    const stats = mockStats({
      leader: DEF,
      defender: INV,
      leaderPoints: 1700, // ETA = 100s, in window
      invTopDamage: [td({ citizen_id: 1, damage: 1_000_000, side_country_id: INV })],
      defTopDamage: [td({ citizen_id: 2, damage: 500_000, side_country_id: DEF })],
      fightersData: { '1': { id: 1, name: 'Alpha', avatar: '' }, '2': { id: 2, name: 'Bravo', avatar: '' } },
    });
    const victims = buildVictimMap([
      { hunter: 100n, citizen: 1n },
      { hunter: 200n, citizen: 2n },
    ]);
    const { deps, maybeAlert } = buildDeps({ stats, victims });
    const result = await runMonitor(buildBattleState({ start: ROUND_START }), deps);
    expect(maybeAlert).toHaveBeenCalledTimes(2);
    const hunters = (maybeAlert.mock.calls as Array<[Parameters<typeof deps.matches.maybeAlert>[0]]>).map((c) => c[0].hunter.telegramId);
    expect(new Set(hunters)).toEqual(new Set([100n, 200n]));
    expect(result).toMatchObject({
      kind: 'reschedule',
      phase: 'monitor',
      nextActionAt: LOCAL_NOW + 30,
    });
  });

  it('sends no alerts when no fighters match victim list', async () => {
    const stats = mockStats({
      leader: DEF,
      defender: INV,
      leaderPoints: 1700,
      invTopDamage: [td({ citizen_id: 999, damage: 100, side_country_id: INV })],
    });
    const victims = buildVictimMap([{ hunter: 100n, citizen: 1n }]); // no overlap
    const { deps, maybeAlert } = buildDeps({ stats, victims });
    const result = await runMonitor(buildBattleState({ start: ROUND_START }), deps);
    expect(maybeAlert).not.toHaveBeenCalled();
    expect(result.kind).toBe('reschedule');
  });

  it('reschedules monitor (no alerts) when countriesFor returns null', async () => {
    const stats = mockStats({ leader: DEF, defender: INV, leaderPoints: 1700 });
    const { deps, maybeAlert } = buildDeps({ stats, countries: null });
    const result = await runMonitor(buildBattleState({ start: ROUND_START }), deps);
    expect(maybeAlert).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: 'reschedule',
      phase: 'monitor',
      nextActionAt: LOCAL_NOW + 30,
    });
  });

  it('on fetch error, keeps monitor phase and uses monitorIntervalSec', async () => {
    const { deps, maybeAlert } = buildDeps({ throwErr: new Error('boom') });
    const state = buildBattleState({ start: ROUND_START, lastEtaSec: 42 });
    const result = await runMonitor(state, deps);
    expect(maybeAlert).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'reschedule',
      phase: 'monitor',
      nextActionAt: LOCAL_NOW + 30,
      lastEtaSec: 42,
    });
  });
});
