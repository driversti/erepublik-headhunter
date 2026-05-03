import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gracefulShutdown, _resetShutdownForTests } from '../shutdown.js';

beforeEach(() => _resetShutdownForTests());

const buildDeps = () => {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      bot: { stop: vi.fn().mockImplementation(async () => void calls.push('bot.stop')) },
      engine: { stop: vi.fn().mockImplementation(() => void calls.push('engine.stop')) },
      http: { close: vi.fn().mockImplementation(async () => void calls.push('http.close')) },
      pool: { end: vi.fn().mockImplementation(async () => void calls.push('pool.end')) },
    },
  };
};

describe('gracefulShutdown', () => {
  it('runs steps in order: bot.stop → engine.stop → http.close → pool.end', async () => {
    const { calls, deps } = buildDeps();
    await gracefulShutdown(deps);
    expect(calls).toEqual(['bot.stop', 'engine.stop', 'http.close', 'pool.end']);
  });

  it('continues to the next step even if one step throws', async () => {
    const { calls, deps } = buildDeps();
    deps.engine.stop.mockImplementation(() => {
      calls.push('engine.stop.threw');
      throw new Error('bang');
    });
    await gracefulShutdown(deps);
    expect(calls).toContain('http.close');
    expect(calls).toContain('pool.end');
  });

  it('is idempotent — second call is a no-op', async () => {
    const { deps } = buildDeps();
    await gracefulShutdown(deps);
    await gracefulShutdown(deps);
    expect(deps.bot.stop).toHaveBeenCalledTimes(1);
    expect(deps.pool.end).toHaveBeenCalledTimes(1);
  });

  it('stops keepAlive between engine.stop and http.close when provided', async () => {
    const { calls, deps } = buildDeps();
    const keepAlive = {
      stop: vi.fn().mockImplementation(() => void calls.push('keepAlive.stop')),
    };
    await gracefulShutdown({ ...deps, keepAlive });
    expect(keepAlive.stop).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'bot.stop',
      'engine.stop',
      'keepAlive.stop',
      'http.close',
      'pool.end',
    ]);
  });
});
