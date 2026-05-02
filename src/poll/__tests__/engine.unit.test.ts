import { describe, expect, it, vi } from 'vitest';
import { PollingEngine, createPollingEngine } from '../index.js';
import type { CampaignsResponse } from '../../erep/types/campaigns.js';
import { mockStats } from './_helpers.js';

const T_NOW = 100000;

const buildCampaigns = (battleIds: number[], opts: { time?: number; serverElapsed?: number } = {}): CampaignsResponse => {
  const serverElapsed = opts.serverElapsed ?? 5100;
  const time = opts.time ?? T_NOW;
  const start = time - serverElapsed;
  return {
    battles: Object.fromEntries(
      battleIds.map((id) => [
        String(id),
        {
          id,
          war_id: 1,
          zone_id: 8,
          is_rw: false,
          is_as: false,
          type: 'battle',
          start,
          det: 0,
          region: { id: 1, name: 'R' },
          city: { id: 1, name: 'C' },
          is_dict: false,
          is_lib: false,
          war_type: 'civilian',
          inv: { id: 52, allies: [], ally_list: [], points: 0 },
          def: { id: 72, allies: [], ally_list: [], points: 0 },
          div: {
            [String(38158390 + id)]: {
              id: 38158390 + id,
              div: 11,
              end: null,
              division_end: false,
              epic: 0,
              epic_type: 0,
              intensity_scale: '',
              co: { inv: [], def: [] },
              wall: { for: 72, dom: 0 },
              terrain: 0,
            },
          },
          terrainTypes: [],
          effects: null,
          hasMultipleTerrains: false,
          isMultiZone: false,
        },
      ]),
    ),
    countries: {
      '52': { id: 52, name: 'Iran', allies: [], is_empire: false, cotd: 0 },
      '72': { id: 72, name: 'Russia', allies: [], is_empire: false, cotd: 0 },
    },
    last_updated: time,
    time,
  };
};

const buildEngine = (overrides: { listCampaigns?: ReturnType<typeof vi.fn>; getBattleStats?: ReturnType<typeof vi.fn>; localNow?: number } = {}) => {
  const listCampaigns = overrides.listCampaigns ?? vi.fn().mockResolvedValue(buildCampaigns([1]));
  const getBattleStats = overrides.getBattleStats ?? vi.fn().mockResolvedValue(mockStats({ zoneId: 38158391, leaderPoints: 0 }));
  const listAllForMatching = vi.fn().mockResolvedValue([]);
  const pruneOlderThan = vi.fn().mockResolvedValue(0);
  const maybeAlert = vi.fn().mockResolvedValue('sent');

  const engine = createPollingEngine({
    client: { listCampaigns, getBattleStats } as never,
    victims: { listAllForMatching } as never,
    alertedRounds: { pruneOlderThan } as never,
    matches: { maybeAlert } as never,
    pollCampaignsSec: 60,
    pollInwindowSec: 30,
    windowSeconds: 300,
    probeLeadSec: 300,
    candidateMinElapsedSec: 5100,
    localNow: () => overrides.localNow ?? T_NOW,
  });

  return { engine, listCampaigns, getBattleStats, listAllForMatching, pruneOlderThan, maybeAlert };
};

describe('PollingEngine', () => {
  it('start() is idempotent (calling twice does not double-register timers)', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const { engine } = buildEngine();
      engine.start();
      engine.start();
      expect(setIntervalSpy.mock.calls.length).toBe(3); // 3 timers, set on first start only
      engine.stop();
    } finally {
      vi.useRealTimers();
      setIntervalSpy.mockRestore();
    }
  });

  it('stop() clears all timers', () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      const { engine } = buildEngine();
      engine.start();
      engine.stop();
      expect(clearIntervalSpy.mock.calls.length).toBe(3);
    } finally {
      vi.useRealTimers();
      clearIntervalSpy.mockRestore();
    }
  });

  it('runCampaignsScanOnce() populates latestCampaigns and snapshot counter', async () => {
    const { engine } = buildEngine();
    expect(engine.snapshot().campaignsScans).toBe(0);
    await engine.runCampaignsScanOnce();
    expect(engine.snapshot().campaignsScans).toBe(1);
    expect(engine.snapshot().latestCampaignsTime).toBe(T_NOW);
    expect(engine.snapshot().inFlight).toBe(1); // battle 1 was added
  });

  it('removes scheduler entry when battle is no longer in campaigns response', async () => {
    const listCampaigns = vi.fn();
    listCampaigns.mockResolvedValueOnce(buildCampaigns([1, 2])).mockResolvedValueOnce(buildCampaigns([1]));
    const { engine } = buildEngine({ listCampaigns });
    await engine.runCampaignsScanOnce();
    expect(engine.snapshot().inFlight).toBe(2);
    await engine.runCampaignsScanOnce();
    expect(engine.snapshot().inFlight).toBe(1);
  });

  it('runTickOnce() calls runProbe and updates probeRuns counter', async () => {
    // After campaigns scan, battle 1 is in scheduler with phase='probe' and nextActionAt=T_NOW.
    // Stats: leader=72, leaderPoints=0 → ETA huge → reschedule probe.
    const { engine, getBattleStats } = buildEngine();
    await engine.runCampaignsScanOnce();
    expect(engine.snapshot().probeRuns).toBe(0);
    await engine.runTickOnce();
    expect(getBattleStats).toHaveBeenCalledTimes(1);
    expect(engine.snapshot().probeRuns).toBe(1);
    expect(engine.snapshot().inFlight).toBe(1); // re-scheduled
  });

  it('exports both PollingEngine class and createPollingEngine factory', () => {
    const { engine } = buildEngine();
    expect(engine).toBeInstanceOf(PollingEngine);
  });
});
