import { describe, expect, it, vi } from 'vitest';
import { runProbe } from '../probe.js';
import { buildBattleState, mockStats } from './_helpers.js';

const ROUND_START = 1000;
const SERVER_AT_85 = ROUND_START + 85 * 60;
const LOCAL_NOW = 50000;

const buildDeps = (overrides: { stats?: ReturnType<typeof mockStats>; throwErr?: Error; localNow?: number; serverNow?: number }) => {
  const getBattleStats = vi.fn();
  if (overrides.throwErr) {
    getBattleStats.mockRejectedValue(overrides.throwErr);
  } else {
    getBattleStats.mockResolvedValue(overrides.stats ?? mockStats({}));
  }
  return {
    deps: {
      client: { getBattleStats },
      serverNow: () => overrides.serverNow ?? SERVER_AT_85,
      localNow: () => overrides.localNow ?? LOCAL_NOW,
      windowSec: 300,
      probeLeadSec: 300,
    },
    getBattleStats,
  };
};

describe('runProbe', () => {
  it('returns remove when zone_finished is true', async () => {
    const { deps } = buildDeps({ stats: mockStats({ zone_finished: true }) });
    const result = await runProbe(buildBattleState({ start: ROUND_START }), deps);
    expect(result).toEqual({ kind: 'remove' });
  });

  it('returns remove when computeRefinedEta cannot resolve a leader (bar lacks zone)', async () => {
    const stats = mockStats({});
    delete (stats.division!.bar as Record<string, number>)['38158390'];
    const { deps } = buildDeps({ stats });
    const result = await runProbe(buildBattleState({ start: ROUND_START }), deps);
    expect(result).toEqual({ kind: 'remove' });
  });

  it('promotes to monitor with nextActionAt = localNow when ETA <= windowSec', async () => {
    // T85 → 30 pts/min. Leader at 1650 → remaining 150 → ETA = 300s = exactly windowSec.
    const stats = mockStats({ leaderPoints: 1650 });
    const { deps } = buildDeps({ stats });
    const result = await runProbe(buildBattleState({ start: ROUND_START }), deps);
    expect(result).toMatchObject({ kind: 'reschedule', phase: 'monitor', nextActionAt: LOCAL_NOW });
    if (result.kind === 'reschedule') {
      expect(result.lastEtaSec).toBeCloseTo(300, 0);
    }
  });

  it('reschedules probe with clamp(eta - lead, 30, 600) when ETA > windowSec', async () => {
    // T85 → 30 pts/min. Leader at 1500 → remaining 300 → ETA = 600s.
    // delay = clamp(600 - 300, 30, 600) = 300.
    const stats = mockStats({ leaderPoints: 1500 });
    const { deps } = buildDeps({ stats });
    const result = await runProbe(buildBattleState({ start: ROUND_START }), deps);
    expect(result).toMatchObject({
      kind: 'reschedule',
      phase: 'probe',
      nextActionAt: LOCAL_NOW + 300,
    });
  });

  it('clamps to lower bound 30s when eta - lead < 30', async () => {
    // ETA = 305s, > windowSec (300), eta - probeLead = 5 → clamp to 30.
    // To get ETA exactly 305s with rate 30 pts/min, remaining = 152.5 pts → leader = 1647.5.
    const stats = mockStats({ leaderPoints: 1647.5 });
    const { deps } = buildDeps({ stats });
    const result = await runProbe(buildBattleState({ start: ROUND_START }), deps);
    expect(result).toMatchObject({
      kind: 'reschedule',
      phase: 'probe',
      nextActionAt: LOCAL_NOW + 30,
    });
  });

  it('clamps to upper bound 600s when eta - lead > 600', async () => {
    // T85 → 30 pts/min. Pick a low leader-points so ETA - lead > 600 → clamp to 600.
    // ETA must satisfy eta - 300 > 600 → eta > 900s. leader=1300 → remaining=500 → ETA=1000s.
    const stats = mockStats({ leaderPoints: 1300 });
    const { deps } = buildDeps({ stats });
    const result = await runProbe(buildBattleState({ start: ROUND_START }), deps);
    expect(result).toMatchObject({
      kind: 'reschedule',
      phase: 'probe',
      nextActionAt: LOCAL_NOW + 600,
    });
  });

  it('on fetch error, reschedules probe in 60s and preserves lastEtaSec', async () => {
    const { deps } = buildDeps({ throwErr: new Error('boom') });
    const state = buildBattleState({ start: ROUND_START, lastEtaSec: 999 });
    const result = await runProbe(state, deps);
    expect(result).toEqual({
      kind: 'reschedule',
      phase: 'probe',
      nextActionAt: LOCAL_NOW + 60,
      lastEtaSec: 999,
    });
  });
});
