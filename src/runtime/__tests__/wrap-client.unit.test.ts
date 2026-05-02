import { describe, expect, it, vi } from 'vitest';
import { wrapClientForPager } from '../wrap-client.js';

const buildPager = () => ({
  recordFailure: vi.fn().mockResolvedValue(undefined),
  recordSuccess: vi.fn(),
});

describe('wrapClientForPager', () => {
  it('forwards listCampaigns and reports success', async () => {
    const inner = { listCampaigns: vi.fn().mockResolvedValue({ time: 1 }), getBattleStats: vi.fn() };
    const pager = buildPager();
    const wrapped = wrapClientForPager(inner as never, pager);
    const res = await wrapped.listCampaigns();
    expect(res).toEqual({ time: 1 });
    expect(pager.recordSuccess).toHaveBeenCalledWith('campaigns');
    expect(pager.recordFailure).not.toHaveBeenCalled();
  });

  it('forwards listCampaigns errors and reports failure', async () => {
    const err = new Error('boom');
    const inner = { listCampaigns: vi.fn().mockRejectedValue(err), getBattleStats: vi.fn() };
    const pager = buildPager();
    const wrapped = wrapClientForPager(inner as never, pager);
    await expect(wrapped.listCampaigns()).rejects.toBe(err);
    expect(pager.recordFailure).toHaveBeenCalledWith('campaigns', err);
    expect(pager.recordSuccess).not.toHaveBeenCalled();
  });

  it('forwards getBattleStats and reports success', async () => {
    const inner = { listCampaigns: vi.fn(), getBattleStats: vi.fn().mockResolvedValue({ zone_finished: false }) };
    const pager = buildPager();
    const wrapped = wrapClientForPager(inner as never, pager);
    const res = await wrapped.getBattleStats(1n, 2n, 11);
    expect(res).toEqual({ zone_finished: false });
    expect(inner.getBattleStats).toHaveBeenCalledWith(1n, 2n, 11);
    expect(pager.recordSuccess).toHaveBeenCalledWith('battle-stats');
  });

  it('forwards getBattleStats errors and reports failure', async () => {
    const err = new Error('http 500');
    const inner = { listCampaigns: vi.fn(), getBattleStats: vi.fn().mockRejectedValue(err) };
    const pager = buildPager();
    const wrapped = wrapClientForPager(inner as never, pager);
    await expect(wrapped.getBattleStats(1n, 2n, 11)).rejects.toBe(err);
    expect(pager.recordFailure).toHaveBeenCalledWith('battle-stats', err);
  });
});
