import { describe, expect, it, vi } from 'vitest';
import { OwnerPager } from '../owner-pager.js';

const buildPager = (opts?: { now?: () => number; threshold?: number; cooldownSec?: number }) => {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const pager = new OwnerPager({
    api: { sendMessage } as never,
    ownerTelegramId: 1n,
    threshold: opts?.threshold ?? 3,
    cooldownSec: opts?.cooldownSec ?? 3600,
    now: opts?.now ?? (() => 1000),
  });
  return { pager, sendMessage };
};

describe('OwnerPager', () => {
  it('does not page on the first or second consecutive failure', async () => {
    const { pager, sendMessage } = buildPager();
    await pager.recordFailure('campaigns', new Error('boom'));
    await pager.recordFailure('campaigns', new Error('boom'));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('pages on the third consecutive failure', async () => {
    const { pager, sendMessage } = buildPager();
    for (let i = 0; i < 3; i++) await pager.recordFailure('campaigns', new Error('boom'));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe(1);
    expect(text).toMatch(/campaigns/);
    expect(text).toMatch(/boom/);
  });

  it('resets the counter on recordSuccess so a new 3-streak pages again after cooldown', async () => {
    let now = 1000;
    const { pager, sendMessage } = buildPager({ now: () => now });
    for (let i = 0; i < 3; i++) await pager.recordFailure('campaigns', new Error('e1'));
    expect(sendMessage).toHaveBeenCalledTimes(1);

    pager.recordSuccess('campaigns');
    // Within cooldown — even another 3-streak should NOT page again.
    for (let i = 0; i < 3; i++) await pager.recordFailure('campaigns', new Error('e2'));
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Past the cooldown — pages again.
    now += 3601;
    pager.recordSuccess('campaigns');
    for (let i = 0; i < 3; i++) await pager.recordFailure('campaigns', new Error('e3'));
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('tracks per-source counters independently', async () => {
    const { pager, sendMessage } = buildPager();
    await pager.recordFailure('campaigns', new Error('a'));
    await pager.recordFailure('campaigns', new Error('a'));
    await pager.recordFailure('battle-stats', new Error('b'));
    await pager.recordFailure('battle-stats', new Error('b'));
    expect(sendMessage).not.toHaveBeenCalled();
    await pager.recordFailure('campaigns', new Error('a'));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toMatch(/campaigns/);
  });

  it('swallows sendMessage errors (does not recurse the pager)', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('telegram down'));
    const pager = new OwnerPager({
      api: { sendMessage } as never,
      ownerTelegramId: 1n,
      threshold: 3,
      cooldownSec: 3600,
      now: () => 1000,
    });
    await pager.recordFailure('campaigns', new Error('x'));
    await pager.recordFailure('campaigns', new Error('x'));
    await expect(pager.recordFailure('campaigns', new Error('x'))).resolves.toBeUndefined();
  });
});
