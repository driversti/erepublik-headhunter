import { afterEach, describe, expect, it, vi } from 'vitest';
import { LivenessSignal, LivenessWatchdog } from '../liveness.js';
import { MemoryLogger } from '../../erep/logger.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('LivenessSignal', () => {
  it('starts healthy at construction', () => {
    let now = 1_000;
    const sig = new LivenessSignal(() => now);
    expect(sig.staleMs()).toBe(0);
    expect(sig.isHealthy(60_000)).toBe(true);
  });

  it('staleMs() grows with wall-clock time', () => {
    let now = 1_000;
    const sig = new LivenessSignal(() => now);
    now = 4_000;
    expect(sig.staleMs()).toBe(3_000);
  });

  it('recordSuccess() resets the timer', () => {
    let now = 1_000;
    const sig = new LivenessSignal(() => now);
    now = 100_000;
    expect(sig.staleMs()).toBe(99_000);
    sig.recordSuccess();
    expect(sig.staleMs()).toBe(0);
  });

  it('isHealthy() flips at the threshold boundary', () => {
    let now = 0;
    const sig = new LivenessSignal(() => now);
    now = 59_999;
    expect(sig.isHealthy(60_000)).toBe(true);
    now = 60_000;
    expect(sig.isHealthy(60_000)).toBe(false);
  });
});

describe('LivenessWatchdog', () => {
  it('does not exit while the signal is fresh', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const signal = new LivenessSignal();
    const wd = new LivenessWatchdog({
      signal,
      restartMs: 60_000,
      checkIntervalMs: 1_000,
      exit,
    });
    wd.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(exit).not.toHaveBeenCalled();
    wd.stop();
  });

  it('exits when staleness crosses the restart threshold', async () => {
    vi.useFakeTimers();
    let now = 0;
    const exit = vi.fn();
    const signal = new LivenessSignal(() => now);
    const wd = new LivenessWatchdog({
      signal,
      restartMs: 60_000,
      checkIntervalMs: 1_000,
      exit,
    });
    wd.start();
    // Advance both the timer driver and the clock so staleMs() also moves.
    now = 60_500;
    await vi.advanceTimersByTimeAsync(60_500);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('does not exit if recordSuccess keeps resetting the signal', async () => {
    vi.useFakeTimers();
    let now = 0;
    const exit = vi.fn();
    const signal = new LivenessSignal(() => now);
    const wd = new LivenessWatchdog({
      signal,
      restartMs: 60_000,
      checkIntervalMs: 1_000,
      exit,
    });
    wd.start();
    for (let i = 0; i < 5; i += 1) {
      now += 30_000;
      signal.recordSuccess();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(exit).not.toHaveBeenCalled();
    wd.stop();
  });

  it('logs liveness.restart before calling exit', async () => {
    vi.useFakeTimers();
    let now = 0;
    const exit = vi.fn();
    const logger = new MemoryLogger();
    const signal = new LivenessSignal(() => now);
    const wd = new LivenessWatchdog({
      signal,
      restartMs: 30_000,
      checkIntervalMs: 1_000,
      exit,
      logger,
    });
    wd.start();
    now = 31_000;
    await vi.advanceTimersByTimeAsync(31_000);
    const entry = logger.entries.find((e) => e.msg === 'liveness.restart');
    expect(entry).toBeTruthy();
    expect(entry?.level).toBe('error');
  });

  it('stops the timer before exit so it does not loop in tests', async () => {
    vi.useFakeTimers();
    let now = 0;
    const exit = vi.fn();
    const signal = new LivenessSignal(() => now);
    const wd = new LivenessWatchdog({
      signal,
      restartMs: 10_000,
      checkIntervalMs: 1_000,
      exit,
    });
    wd.start();
    now = 11_000;
    await vi.advanceTimersByTimeAsync(11_000);
    expect(exit).toHaveBeenCalledTimes(1);
    // Even though the signal is still stale, more ticks must not fire.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('start() is idempotent', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const signal = new LivenessSignal();
      const wd = new LivenessWatchdog({
        signal,
        restartMs: 10_000,
        checkIntervalMs: 1_000,
        exit: vi.fn(),
      });
      wd.start();
      wd.start();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      wd.stop();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
