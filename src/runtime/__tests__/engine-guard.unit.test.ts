import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, VerificationGateError } from '../../erep/errors.js';
import { guardEngineClient } from '../engine-guard.js';

const gate403 = () =>
  new AuthRequiredError('GET /en/military/battle-stats/1/11/2 still failed auth after re-login (status_403).', 403);

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

describe('guardEngineClient — verification gate', () => {
  it('opens the gate on AuthRequiredError(403): rethrows, then blocks without network', async () => {
    const { guarded, inner } = build();
    inner.getBattleStats.mockRejectedValueOnce(gate403());

    await expect(guarded.getBattleStats(1n, 2n, 11)).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(guarded.getBattleStats(1n, 2n, 11)).rejects.toBeInstanceOf(VerificationGateError);
    // Only the opening call reached the network.
    expect(inner.getBattleStats).toHaveBeenCalledTimes(1);
  });

  it('does NOT open the gate for non-403 AuthRequiredError', async () => {
    const { guarded, inner } = build();
    inner.getBattleStats.mockRejectedValueOnce(
      new AuthRequiredError('GET /x still failed auth after re-login (redirect_to_login).', 302),
    );
    await expect(guarded.getBattleStats(1n, 2n, 11)).rejects.toBeInstanceOf(AuthRequiredError);
    // Next call passes through to the (succeeding) inner mock.
    expect(await guarded.getBattleStats(1n, 2n, 11)).toEqual({ zone_finished: false });
    expect(inner.getBattleStats).toHaveBeenCalledTimes(2);
  });

  it('freezes pager counters while gated (blocked calls feed nothing)', async () => {
    const { guarded, pager, inner } = build();
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});
    pager.recordFailure.mockClear();
    pager.recordSuccess.mockClear();

    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});
    expect(pager.recordFailure).not.toHaveBeenCalled();
    expect(pager.recordSuccess).not.toHaveBeenCalled();
  });

  it('lets one canary through per interval; failed canary keeps the gate and stays silent', async () => {
    const { guarded, pager, inner, advance } = build();
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});
    pager.recordFailure.mockClear();

    advance(600_001); // canary due
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await expect(guarded.getBattleStats(1n, 2n, 11)).rejects.toBeInstanceOf(AuthRequiredError);
    expect(inner.getBattleStats).toHaveBeenCalledTimes(2); // opening call + canary
    expect(pager.recordFailure).not.toHaveBeenCalled();    // expected-while-gated

    // Immediately after the failed canary we're blocked again.
    await expect(guarded.getBattleStats(1n, 2n, 11)).rejects.toBeInstanceOf(VerificationGateError);
  });

  it('clears the gate on canary success and resumes normal accounting', async () => {
    const { guarded, pager, inner, advance } = build();
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});

    advance(600_001);
    expect(await guarded.getBattleStats(1n, 2n, 11)).toEqual({ zone_finished: false });
    expect(pager.recordSuccess).toHaveBeenCalledWith('battle-stats');

    // Fully back to normal: next call passes through immediately.
    expect(await guarded.getBattleStats(1n, 2n, 11)).toEqual({ zone_finished: false });
    expect(inner.getBattleStats).toHaveBeenCalledTimes(3);
  });

  it('never gates listCampaigns', async () => {
    const { guarded, inner } = build();
    inner.getBattleStats.mockRejectedValueOnce(gate403());
    await guarded.getBattleStats(1n, 2n, 11).catch(() => {});
    expect(await guarded.listCampaigns()).toEqual({ time: 1 });
    expect(inner.listCampaigns).toHaveBeenCalledTimes(1);
  });
});
