import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeepAlive } from '../keep-alive.js';
import { MemoryLogger } from '../../erep/logger.js';
import { LoginLockedOutError } from '../../erep/errors.js';

afterEach(() => {
  vi.useRealTimers();
});

const buildAuth = (impl?: () => Promise<string>) => {
  const getErpk = vi.fn(impl ?? (async () => 'erpk-token'));
  return { auth: { getErpk } as { getErpk: () => Promise<string> }, getErpk };
};

describe('KeepAlive', () => {
  it('does not call getErpk before the interval elapses', async () => {
    vi.useFakeTimers();
    const { auth, getErpk } = buildAuth();
    const ka = new KeepAlive({ auth, intervalMs: 60_000 });
    ka.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(getErpk).not.toHaveBeenCalled();
    ka.stop();
  });

  it('calls getErpk once per interval tick', async () => {
    vi.useFakeTimers();
    const { auth, getErpk } = buildAuth();
    const ka = new KeepAlive({ auth, intervalMs: 60_000 });
    ka.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getErpk).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getErpk).toHaveBeenCalledTimes(2);
    ka.stop();
  });

  it('logs auth.keep_alive.ok on success', async () => {
    vi.useFakeTimers();
    const { auth } = buildAuth();
    const logger = new MemoryLogger();
    const ka = new KeepAlive({ auth, intervalMs: 60_000, logger });
    ka.start();
    await vi.advanceTimersByTimeAsync(60_000);
    ka.stop();
    expect(logger.entries.some((e) => e.level === 'debug' && e.msg === 'auth.keep_alive.ok')).toBe(true);
  });

  it('logs auth.keep_alive.skipped_lockout on LoginLockedOutError without crashing', async () => {
    vi.useFakeTimers();
    const { auth, getErpk } = buildAuth(async () => {
      throw new LoginLockedOutError(30_000);
    });
    const logger = new MemoryLogger();
    const ka = new KeepAlive({ auth, intervalMs: 60_000, logger });
    ka.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getErpk).toHaveBeenCalledTimes(1);
    expect(
      logger.entries.find((e) => e.msg === 'auth.keep_alive.skipped_lockout'),
    ).toBeTruthy();
    // Subsequent tick still fires.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getErpk).toHaveBeenCalledTimes(2);
    ka.stop();
  });

  it('logs auth.keep_alive.failed on other errors and keeps ticking', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { auth, getErpk } = buildAuth(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'erpk-token';
    });
    const logger = new MemoryLogger();
    const ka = new KeepAlive({ auth, intervalMs: 60_000, logger });
    ka.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      logger.entries.find((e) => e.msg === 'auth.keep_alive.failed'),
    ).toBeTruthy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getErpk).toHaveBeenCalledTimes(2);
    expect(
      logger.entries.find((e) => e.msg === 'auth.keep_alive.ok'),
    ).toBeTruthy();
    ka.stop();
  });

  it('stop() cancels further ticks', async () => {
    vi.useFakeTimers();
    const { auth, getErpk } = buildAuth();
    const ka = new KeepAlive({ auth, intervalMs: 60_000 });
    ka.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getErpk).toHaveBeenCalledTimes(1);
    ka.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(getErpk).toHaveBeenCalledTimes(1);
  });

  it('start() is idempotent — calling twice does not double-register the timer', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const { auth, getErpk } = buildAuth();
      const ka = new KeepAlive({ auth, intervalMs: 60_000 });
      ka.start();
      ka.start();
      expect(setIntervalSpy.mock.calls.length).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getErpk).toHaveBeenCalledTimes(1);
      ka.stop();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it('does not start an overlapping tick if the previous one is still in flight', async () => {
    vi.useFakeTimers();
    let resolveFirst: (v: string) => void = () => {};
    let inFlightCalls = 0;
    const getErpk = vi.fn(async () => {
      inFlightCalls += 1;
      if (inFlightCalls === 1) {
        return await new Promise<string>((res) => {
          resolveFirst = res;
        });
      }
      return 'erpk';
    });
    const ka = new KeepAlive({ auth: { getErpk }, intervalMs: 60_000 });
    ka.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getErpk).toHaveBeenCalledTimes(1);
    // Another interval elapses while the first call is still pending.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getErpk).toHaveBeenCalledTimes(1);
    // Resolve the first call; next interval should fire normally.
    resolveFirst('erpk');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getErpk).toHaveBeenCalledTimes(2);
    ka.stop();
  });
});
