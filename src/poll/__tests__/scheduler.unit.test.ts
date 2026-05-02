import { describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../scheduler.js';
import type { BattleState } from '../types.js';

const buildState = (overrides: Partial<BattleState> & { battleId: bigint; zoneId: number; nextAt: number }): BattleState => ({
  battleId: overrides.battleId,
  zoneId: overrides.zoneId,
  phase: overrides.phase ?? 'probe',
  start: overrides.start ?? 0,
  invName: overrides.invName ?? 'A',
  defName: overrides.defName ?? 'B',
  region: overrides.region ?? 'R',
  lastEtaSec: overrides.lastEtaSec ?? null,
  nextActionAt: overrides.nextAt,
});

describe('Scheduler', () => {
  it('tick returns nothing when no entries are due', () => {
    const now = vi.fn().mockReturnValue(100);
    const s = new Scheduler({ now });
    s.upsert(buildState({ battleId: 1n, zoneId: 1, nextAt: 200 }));
    expect(s.tick()).toEqual([]);
  });

  it('tick drains entries whose nextActionAt <= now', () => {
    const clock = 100;
    const s = new Scheduler({ now: () => clock });
    s.upsert(buildState({ battleId: 1n, zoneId: 1, nextAt: 50 }));
    s.upsert(buildState({ battleId: 2n, zoneId: 2, nextAt: 100 }));
    s.upsert(buildState({ battleId: 3n, zoneId: 3, nextAt: 200 }));
    const due = s.tick();
    expect(due.map((d) => d.battleId).sort()).toEqual([1n, 2n].sort());
    expect(s.size()).toBe(1);
    expect(s.has(3n, 3)).toBe(true);
  });

  it('tick returns due entries in nextActionAt-ascending order', () => {
    const s = new Scheduler({ now: () => 1000 });
    s.upsert(buildState({ battleId: 1n, zoneId: 1, nextAt: 500 }));
    s.upsert(buildState({ battleId: 2n, zoneId: 2, nextAt: 100 }));
    s.upsert(buildState({ battleId: 3n, zoneId: 3, nextAt: 300 }));
    const due = s.tick();
    expect(due.map((d) => d.battleId)).toEqual([2n, 3n, 1n]);
  });

  it('upsert with same (battleId, zoneId) replaces — index size stays the same', () => {
    const s = new Scheduler({ now: () => 0 });
    s.upsert(buildState({ battleId: 1n, zoneId: 1, nextAt: 100, phase: 'probe' }));
    s.upsert(buildState({ battleId: 1n, zoneId: 1, nextAt: 200, phase: 'monitor' }));
    expect(s.size()).toBe(1);
    expect(s.snapshot()[0]?.phase).toBe('monitor');
    expect(s.snapshot()[0]?.nextActionAt).toBe(200);
  });

  it('remove deletes the battle from both index and heap', () => {
    const s = new Scheduler({ now: () => 0 });
    s.upsert(buildState({ battleId: 1n, zoneId: 1, nextAt: 100 }));
    s.upsert(buildState({ battleId: 2n, zoneId: 2, nextAt: 200 }));
    s.remove(1n, 1);
    expect(s.size()).toBe(1);
    expect(s.has(1n, 1)).toBe(false);
    expect(s.has(2n, 2)).toBe(true);
  });

  it('remove on a missing battle is a no-op', () => {
    const s = new Scheduler({ now: () => 0 });
    s.upsert(buildState({ battleId: 1n, zoneId: 1, nextAt: 100 }));
    s.remove(99n, 99);
    expect(s.size()).toBe(1);
  });

  it('drained entries leave the index until re-upserted', () => {
    const s = new Scheduler({ now: () => 100 });
    s.upsert(buildState({ battleId: 1n, zoneId: 1, nextAt: 50 }));
    s.tick();
    expect(s.has(1n, 1)).toBe(false);
    s.upsert(buildState({ battleId: 1n, zoneId: 1, nextAt: 200 }));
    expect(s.has(1n, 1)).toBe(true);
  });
});
