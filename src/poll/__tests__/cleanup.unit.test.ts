import { describe, expect, it, vi } from 'vitest';
import { runCleanup } from '../cleanup.js';
import { MemoryLogger } from '../../erep/logger.js';

describe('runCleanup', () => {
  it('default olderThanHours = 48 and returns the prune count', async () => {
    const pruneOlderThan = vi.fn().mockResolvedValue(7);
    const removed = await runCleanup({ alertedRounds: { pruneOlderThan } });
    expect(removed).toBe(7);
    expect(pruneOlderThan).toHaveBeenCalledWith({ olderThanHours: 48 });
  });

  it('honours custom olderThanHours', async () => {
    const pruneOlderThan = vi.fn().mockResolvedValue(0);
    await runCleanup({ alertedRounds: { pruneOlderThan }, olderThanHours: 24 });
    expect(pruneOlderThan).toHaveBeenCalledWith({ olderThanHours: 24 });
  });

  it('catches errors, logs, and returns 0', async () => {
    const pruneOlderThan = vi.fn().mockRejectedValue(new Error('db down'));
    const logger = new MemoryLogger();
    const removed = await runCleanup({ alertedRounds: { pruneOlderThan }, logger });
    expect(removed).toBe(0);
    expect(logger.entries.some((e) => e.level === 'error' && e.msg === 'poll.cleanup.failed')).toBe(true);
  });
});
