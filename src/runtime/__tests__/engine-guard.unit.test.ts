import { describe, expect, it, vi } from 'vitest';
import { guardEngineClient } from '../engine-guard.js';

interface BuildOpts {
  canaryIntervalMs?: number;
  reminderIntervalMs?: number;
}

function build(opts: BuildOpts = {}) {
  let nowMs = 1_700_000_000_000;
  const inner = {
    listCampaigns: vi.fn().mockResolvedValue({ time: 1 }),
    getBattleStats: vi.fn().mockResolvedValue({ zone_finished: false }),
  };
  const pager = {
    recordFailure: vi.fn().mockResolvedValue(undefined),
    recordSuccess: vi.fn(),
  };
  const notifyOwner = vi.fn().mockResolvedValue(undefined);
  const guarded = guardEngineClient(inner as never, {
    pager,
    notifyOwner,
    now: () => nowMs,
    ...opts,
  });
  return { inner, pager, notifyOwner, guarded, advance: (ms: number) => { nowMs += ms; } };
}

describe('guardEngineClient — pager pass-through (wrap-client parity)', () => {
  it('forwards listCampaigns and reports success', async () => {
    const { guarded, pager } = build();
    expect(await guarded.listCampaigns()).toEqual({ time: 1 });
    expect(pager.recordSuccess).toHaveBeenCalledWith('campaigns');
    expect(pager.recordFailure).not.toHaveBeenCalled();
  });

  it('forwards listCampaigns errors and reports failure', async () => {
    const { guarded, pager, inner } = build();
    const err = new Error('boom');
    inner.listCampaigns.mockRejectedValueOnce(err);
    await expect(guarded.listCampaigns()).rejects.toBe(err);
    expect(pager.recordFailure).toHaveBeenCalledWith('campaigns', err);
  });

  it('forwards getBattleStats and reports success', async () => {
    const { guarded, pager, inner } = build();
    expect(await guarded.getBattleStats(1n, 2n, 11)).toEqual({ zone_finished: false });
    expect(inner.getBattleStats).toHaveBeenCalledWith(1n, 2n, 11);
    expect(pager.recordSuccess).toHaveBeenCalledWith('battle-stats');
  });

  it('forwards getBattleStats errors and reports failure', async () => {
    const { guarded, pager, inner } = build();
    const err = new Error('http 500');
    inner.getBattleStats.mockRejectedValueOnce(err);
    await expect(guarded.getBattleStats(1n, 2n, 11)).rejects.toBe(err);
    expect(pager.recordFailure).toHaveBeenCalledWith('battle-stats', err);
  });
});
