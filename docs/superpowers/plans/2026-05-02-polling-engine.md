# Polling Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the three-layer polling engine — campaigns scan → adaptive ETA probe → in-window monitoring with match-check — that feeds detected matches into `MatchesService.maybeAlert`. After this plan + the entrypoint plan, the bot can actually fire alerts.

**Architecture:** A `PollingEngine` class owns three async loops:
1. **Campaigns scan** — every `POLL_CAMPAIGNS_SEC` (default 60s), calls `ErepClient.listCampaigns`, applies the T85+ filter, enqueues newly-seen battles into the scheduler's min-heap.
2. **Scheduler tick** — every 1s, drains all heap entries whose `nextActionAt <= now`. Each entry's phase (`probe` or `monitor`) decides which worker runs.
3. **Cleanup** — once per 24h, calls `AlertedRoundsRepo.pruneOlderThan({ olderThanHours: 48 })`.

The probe worker makes one auth'd `getBattleStats` call, computes refined ETA via the ramp-rate model, and either:
- Promotes the battle to **monitor** phase if ETA ≤ `WINDOW_SECONDS` (300).
- Re-schedules itself in `clamp(eta_s - PROBE_LEAD_SEC, 30, 600)` seconds otherwise.

The monitor worker makes the same `getBattleStats` call but additionally builds the per-hunter match list (using a per-scan victim-map snapshot from `VictimRepo`), then calls `MatchesService.maybeAlert` for each hunter that has matches. **Hysteresis**: per `REVIEW_NOTES.md` §3.2, the monitor de-promotes the battle back to **probe** when refined ETA > `WINDOW_SECONDS`.

A battle is removed from the heap entirely when:
- The next campaigns scan no longer lists this `(battleId, zoneId)` (round closed or div changed).
- `getBattleStats` returns `zone_finished: true`.

**Tech Stack:** TypeScript strict / NodeNext ESM, Node ≥20.6, vitest. New dependency: **none** — we'll write a small generic min-heap inline (well-tested), avoiding pulling a `tinyqueue`-style dep for ~30 lines of code.

**Open question carried from SPEC §13.3** — the units of `domination` in `battle-stats.division.{countryId}.{zoneId}.domination`. The KB notes "Can exceed 100, representing accumulated domination points" but the example shows percentage-like values (90, 0, 83.7646). The plan assumes these are **round-points (0–1800)** because the ETA algorithm needs them. **Verification step in Task 5**: add a `scripts/inspect-battle-stats.ts` that fetches a real T85+ live battle and dumps the response so the user (or this agent in a follow-up) can confirm the units and adjust `eta.ts` if wrong. The math change is one line.

**Out of scope:**
- The actual `bot.start()` and engine wiring — entrypoint plan.
- Owner DM on 3-consecutive-failures (SPEC §5.3) — defer to entrypoint plan; this plan logs the failures, the entrypoint observes the logs and pages.

---

## File map

**Created:**
- `src/poll/types.ts` — `BattlePhase`, `BattleState`, `MatchInput`, etc.
- `src/poll/eta.ts` — `rampRateAtMinute`, `computeRefinedEta`
- `src/poll/min-heap.ts` — generic min-heap used by the scheduler
- `src/poll/scheduler.ts` — `Scheduler` class wrapping the heap + 1s tick
- `src/poll/campaigns-scan.ts` — campaigns-list polling + T85+ filter
- `src/poll/probe.ts` — single-shot ETA probe worker
- `src/poll/monitor.ts` — in-window scan worker with match-check
- `src/poll/matching.ts` — pure `findMatchesForBattle(stats, victimMap, ...)` function
- `src/poll/cleanup.ts` — daily prune
- `src/poll/index.ts` — `PollingEngine` factory + `start()` / `stop()`
- `src/poll/__tests__/eta.unit.test.ts`
- `src/poll/__tests__/min-heap.unit.test.ts`
- `src/poll/__tests__/scheduler.unit.test.ts`
- `src/poll/__tests__/campaigns-scan.unit.test.ts`
- `src/poll/__tests__/matching.unit.test.ts`
- `src/poll/__tests__/probe.unit.test.ts`
- `src/poll/__tests__/monitor.unit.test.ts`
- `src/poll/__tests__/cleanup.unit.test.ts`
- `src/poll/__tests__/engine.unit.test.ts`
- `scripts/inspect-battle-stats.ts` — manual verification helper

**Modified:**
- `src/db/repos/victims.ts` — add `listAllForMatching(): Promise<Array<{ hunter: bigint; citizen: bigint }>>` (returns dense pairs across all hunters, used by the monitor's per-scan map build)
- `src/db/__tests__/victims.integration.test.ts` — test for the new method
- `src/erep/index.ts` — re-export the existing `Battle` type (already done in Plan 2; just verify)
- `.env.example` — add the new env vars (POLL_CAMPAIGNS_SEC etc.)
- `src/config.ts` — add the new env vars (with safe numeric defaults)

---

## Task 1: ETA module + types + min-heap

**Files:**
- Create: `src/poll/types.ts`
- Create: `src/poll/eta.ts`
- Create: `src/poll/min-heap.ts`
- Create: `src/poll/__tests__/eta.unit.test.ts`
- Create: `src/poll/__tests__/min-heap.unit.test.ts`

### `src/poll/types.ts`

```ts
/** What kind of work is due for this battle on the next tick. */
export type BattlePhase = 'probe' | 'monitor';

/** Per-battle in-memory state. The scheduler holds one of these per active battle. */
export interface BattleState {
  battleId: bigint;
  /** Air-division zone id (key in campaigns response `battle.div`). */
  zoneId: number;
  /** Current phase. Re-evaluated each scan; can flip back to 'probe' (hysteresis). */
  phase: BattlePhase;
  /** Per-round start timestamp (battle-level, from campaigns response). */
  start: number;
  /** Country IDs and names (cached from campaigns scan to avoid relooking-up the country map). */
  invName: string;
  defName: string;
  region: string;
  /** Last refined ETA in seconds (informational; for /status). */
  lastEtaSec: number | null;
  /** Last in-memory `nextActionAt` (Unix seconds). */
  nextActionAt: number;
}

/** Result of computeRefinedEta — used by probe + monitor to decide phase + reschedule. */
export interface EtaResult {
  /** Seconds remaining until the round ends, OR Infinity when no side is currently
   *  accumulating points (wall is tied or contested in a way that nobody leads). */
  etaSec: number;
  /** Country id holding the wall (informational; used to render the alert message). */
  leaderCountryId: number;
  /** The leader's current round-point total (0–1800). */
  leaderPoints: number;
  /** Current ramp rate at the read-time, in points/min. */
  currentRatePm: number;
}
```

### `src/poll/eta.ts`

```ts
import type { BattleStatsResponse } from '../erep/types/battle-stats.js';
import type { EtaResult } from './types.js';

/** SPEC §8 ramp rate, in points per minute. */
export function rampRateAtMinute(elapsedMin: number): number {
  if (elapsedMin <= 30) return 10;
  if (elapsedMin <= 60) return 20;
  if (elapsedMin <= 90) return 30;
  return 60;
}

/**
 * Computes refined ETA from a battle-stats response and the campaigns-supplied
 * round-start + server-now timestamps.
 *
 * **Domination units assumption** (SPEC §13.3 — verify against live data):
 * we assume `division.{countryId}.{zoneId}.domination` is the per-country round
 * points (0–1800). If a real fetch shows it's actually a percentage 0-100,
 * change the `pointsFromDomination` helper to multiply by 18.
 */
export function computeRefinedEta(input: {
  stats: BattleStatsResponse;
  zoneId: number;
  /** From campaigns response: per-round start. */
  roundStartUnix: number;
  /** From campaigns response: top-level `time`. */
  serverNowUnix: number;
}): EtaResult | null {
  const zoneKey = String(input.zoneId);
  const leaderCountryId = input.stats.division.bar[zoneKey];
  if (leaderCountryId === undefined) return null;

  const leaderPoints = pointsFor(input.stats, leaderCountryId, zoneKey);
  if (leaderPoints === null) return null;

  const elapsedMin = Math.max(0, (input.serverNowUnix - input.roundStartUnix) / 60);
  const currentRatePm = rampRateAtMinute(elapsedMin);

  const remainingPoints = Math.max(0, 1800 - leaderPoints);
  if (remainingPoints === 0) {
    // Round just hit 1800 (or response is stale); ETA effectively zero.
    return { etaSec: 0, leaderCountryId, leaderPoints, currentRatePm };
  }

  const etaSec = (remainingPoints / currentRatePm) * 60;
  return { etaSec, leaderCountryId, leaderPoints, currentRatePm };
}

function pointsFor(stats: BattleStatsResponse, countryId: number, zoneKey: string): number | null {
  const countryEntry = (stats.division as Record<string, unknown>)[String(countryId)];
  if (!countryEntry || typeof countryEntry !== 'object') return null;
  const zoneEntry = (countryEntry as Record<string, unknown>)[zoneKey];
  if (!zoneEntry || typeof zoneEntry !== 'object') return null;
  const dom = (zoneEntry as { domination?: unknown }).domination;
  if (typeof dom !== 'number') return null;
  return dom;
}
```

### `src/poll/min-heap.ts`

```ts
/**
 * Generic min-heap. Items are compared by a caller-supplied keyFn returning
 * a number; smallest key bubbles to the top. Used by the scheduler to find
 * the next battle whose nextActionAt has elapsed.
 */
export class MinHeap<T> {
  private heap: T[] = [];

  constructor(private readonly keyFn: (item: T) => number) {}

  size(): number {
    return this.heap.length;
  }

  peek(): T | undefined {
    return this.heap[0];
  }

  push(item: T): void {
    this.heap.push(item);
    this.siftUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** O(n) — replaces the entire heap with a new set; used by the scheduler
   *  to rebuild after a scan that adds/removes battles in bulk. */
  replaceAll(items: Iterable<T>): void {
    this.heap = [...items];
    // Heapify bottom-up.
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) {
      this.siftDown(i);
    }
  }

  toArray(): T[] {
    return [...this.heap];
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keyFn(this.heap[i]!) >= this.keyFn(this.heap[parent]!)) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent]!, this.heap[i]!];
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      const l = i * 2 + 1;
      const r = i * 2 + 2;
      let smallest = i;
      if (l < n && this.keyFn(this.heap[l]!) < this.keyFn(this.heap[smallest]!)) smallest = l;
      if (r < n && this.keyFn(this.heap[r]!) < this.keyFn(this.heap[smallest]!)) smallest = r;
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest]!, this.heap[i]!];
      i = smallest;
    }
  }
}
```

### Tests

**`src/poll/__tests__/min-heap.unit.test.ts`:**

```ts
import { describe, expect, it } from 'vitest';
import { MinHeap } from '../min-heap.js';

const intHeap = () => new MinHeap<number>((n) => n);

describe('MinHeap', () => {
  it('push/pop returns elements in ascending order', () => {
    const h = intHeap();
    [5, 2, 8, 1, 9, 3].forEach((n) => h.push(n));
    const popped: number[] = [];
    while (h.size() > 0) popped.push(h.pop()!);
    expect(popped).toEqual([1, 2, 3, 5, 8, 9]);
  });

  it('peek returns the smallest without removing', () => {
    const h = intHeap();
    h.push(5);
    h.push(2);
    expect(h.peek()).toBe(2);
    expect(h.size()).toBe(2);
  });

  it('pop on empty returns undefined', () => {
    expect(intHeap().pop()).toBeUndefined();
  });

  it('replaceAll re-heapifies the input', () => {
    const h = intHeap();
    h.push(100);
    h.replaceAll([7, 3, 9, 1, 5]);
    expect(h.peek()).toBe(1);
    expect(h.size()).toBe(5);
  });

  it('uses the custom keyFn', () => {
    interface Job {
      due: number;
      label: string;
    }
    const h = new MinHeap<Job>((j) => j.due);
    h.push({ due: 30, label: 'b' });
    h.push({ due: 10, label: 'a' });
    h.push({ due: 20, label: 'c' });
    expect(h.pop()?.label).toBe('a');
    expect(h.pop()?.label).toBe('c');
    expect(h.pop()?.label).toBe('b');
  });
});
```

**`src/poll/__tests__/eta.unit.test.ts`:**

```ts
import { describe, expect, it } from 'vitest';
import { rampRateAtMinute, computeRefinedEta } from '../eta.js';
import type { BattleStatsResponse } from '../../erep/types/battle-stats.js';

describe('rampRateAtMinute', () => {
  it.each([
    [0, 10],
    [30, 10],
    [31, 20],
    [60, 20],
    [61, 30],
    [90, 30],
    [91, 60],
    [119, 60],
  ])('elapsed=%d → rate=%d pts/min', (elapsed, expected) => {
    expect(rampRateAtMinute(elapsed)).toBe(expected);
  });
});

const mockStats = (overrides: {
  zoneKey?: string;
  leader?: number;
  leaderPoints?: number;
  defenderPoints?: number;
}): BattleStatsResponse => {
  const zoneKey = overrides.zoneKey ?? '38158390';
  const leader = overrides.leader ?? 72;
  const defender = leader === 72 ? 52 : 72;
  return {
    stats: { personal: [], current: {}, overall: [] },
    zone_finished: false,
    division: {
      created_at: 0,
      bar: { [zoneKey]: leader },
      domination: { [zoneKey]: 0 },
      defence_shield: { [zoneKey]: 0 },
      [String(leader)]: { [zoneKey]: { domination: overrides.leaderPoints ?? 0, won: 0 } },
      [String(defender)]: { [zoneKey]: { domination: overrides.defenderPoints ?? 0, won: 0 } },
    } as never,
    fightersData: {},
    opponentsInQueue: 0,
    isInQueue: false,
    campaigns: [],
    epicBattle: 0,
    activeEffects: [],
    battleEffects: {},
    maxHit: 0,
    most_contested: [],
    battle_zone_situation: { [zoneKey]: 0 },
  };
};

describe('computeRefinedEta', () => {
  it('returns ETA when leader has accumulated points and is rising at the current ramp', () => {
    // T85: rate = 30 pts/min. Leader at 1500; remaining 300; ETA = 300/30 * 60 = 600s = 10 min.
    const result = computeRefinedEta({
      stats: mockStats({ leader: 72, leaderPoints: 1500 }),
      zoneId: 38158390,
      roundStartUnix: 1000,
      serverNowUnix: 1000 + 85 * 60,
    });
    expect(result).not.toBeNull();
    expect(result!.etaSec).toBeCloseTo(600, 0);
    expect(result!.leaderCountryId).toBe(72);
    expect(result!.leaderPoints).toBe(1500);
    expect(result!.currentRatePm).toBe(30);
  });

  it('returns ETA=0 when leader has reached 1800 already', () => {
    const result = computeRefinedEta({
      stats: mockStats({ leader: 72, leaderPoints: 1800 }),
      zoneId: 38158390,
      roundStartUnix: 1000,
      serverNowUnix: 1000 + 85 * 60,
    });
    expect(result?.etaSec).toBe(0);
  });

  it('uses the 60 pts/min rate after T90', () => {
    // T100: rate = 60 pts/min. Leader at 600; remaining 1200; ETA = 1200/60 * 60 = 1200s = 20 min.
    // Capped by the round itself at T120 → 20 min remaining; equal here.
    const result = computeRefinedEta({
      stats: mockStats({ leader: 72, leaderPoints: 600 }),
      zoneId: 38158390,
      roundStartUnix: 1000,
      serverNowUnix: 1000 + 100 * 60,
    });
    expect(result?.currentRatePm).toBe(60);
    expect(result?.etaSec).toBeCloseTo(1200, 0);
  });

  it('returns null when bar lacks the zone (e.g. round just ended)', () => {
    const stats = mockStats({});
    delete (stats.division.bar as Record<string, number>)['38158390'];
    expect(
      computeRefinedEta({
        stats,
        zoneId: 38158390,
        roundStartUnix: 1000,
        serverNowUnix: 1000 + 85 * 60,
      }),
    ).toBeNull();
  });

  it('returns null when leader country has no per-zone domination entry', () => {
    const stats = mockStats({ leader: 72, leaderPoints: 1000 });
    delete ((stats.division as Record<string, unknown>)['72'] as Record<string, unknown>)['38158390'];
    expect(
      computeRefinedEta({
        stats,
        zoneId: 38158390,
        roundStartUnix: 1000,
        serverNowUnix: 1000 + 85 * 60,
      }),
    ).toBeNull();
  });
});
```

### Steps

- [ ] **Step 1: Create types + eta + min-heap files**

Create all three source files with the contents above.

- [ ] **Step 2: Write tests**

Create both test files with the contents above.

- [ ] **Step 3: Run + typecheck**

Run: `npm test -- 'eta\\.unit|min-heap\\.unit' && npm run typecheck`
Expected: 5 + 5 = ~13 PASS (the `it.each` for rampRate counts as 8 cases); typecheck silent.

- [ ] **Step 4: Commit**

```bash
git add src/poll/types.ts src/poll/eta.ts src/poll/min-heap.ts src/poll/__tests__/eta.unit.test.ts src/poll/__tests__/min-heap.unit.test.ts
git commit -m "feat(poll): add ETA module + min-heap + battle-state types"
```

---

## Task 2: Scheduler

**Files:**
- Create: `src/poll/scheduler.ts`
- Create: `src/poll/__tests__/scheduler.unit.test.ts`

The `Scheduler` class wraps the min-heap with a `tick()` method that drains all due entries. It does NOT own the timer — the engine calls `tick()` from a `setInterval`. This makes it deterministic and unit-testable.

### `src/poll/scheduler.ts`

```ts
import { MinHeap } from './min-heap.js';
import type { BattleState } from './types.js';

export interface SchedulerDeps {
  /** Time source — `Date.now() / 1000` in production. */
  now: () => number;
}

/**
 * Min-heap-backed work queue keyed by `BattleState.nextActionAt`. The engine
 * calls `tick()` once per second; tick returns the list of battles whose
 * action is due NOW. The caller is responsible for processing them and
 * re-scheduling (call `upsert` with the updated state).
 */
export class Scheduler {
  private readonly heap: MinHeap<BattleState>;
  /** Map for upsert dedup + fast lookup. Keyed by `${battleId}:${zoneId}`. */
  private readonly index = new Map<string, BattleState>();

  constructor(private readonly deps: SchedulerDeps) {
    this.heap = new MinHeap<BattleState>((s) => s.nextActionAt);
  }

  size(): number {
    return this.heap.size();
  }

  has(battleId: bigint, zoneId: number): boolean {
    return this.index.has(this.keyFor(battleId, zoneId));
  }

  /**
   * Adds a battle if not already tracked, OR updates the existing entry
   * (replacing nextActionAt + phase). Always re-heapifies because a state
   * may have moved earlier OR later.
   */
  upsert(state: BattleState): void {
    this.index.set(this.keyFor(state.battleId, state.zoneId), state);
    this.heap.replaceAll(this.index.values());
  }

  /** Removes a battle. No-op if not tracked. */
  remove(battleId: bigint, zoneId: number): void {
    if (this.index.delete(this.keyFor(battleId, zoneId))) {
      this.heap.replaceAll(this.index.values());
    }
  }

  /**
   * Drains all due entries (`nextActionAt <= now`) and returns them. The
   * caller is responsible for re-scheduling drained entries via `upsert`,
   * or removing them via `remove`. Drained entries are temporarily out of
   * the index until the caller re-asserts them.
   */
  tick(): BattleState[] {
    const now = this.deps.now();
    const due: BattleState[] = [];
    while (this.heap.size() > 0 && this.heap.peek()!.nextActionAt <= now) {
      const state = this.heap.pop()!;
      this.index.delete(this.keyFor(state.battleId, state.zoneId));
      due.push(state);
    }
    return due;
  }

  /** Snapshot for /status output. */
  snapshot(): BattleState[] {
    return this.heap.toArray();
  }

  private keyFor(battleId: bigint, zoneId: number): string {
    return `${battleId}:${zoneId}`;
  }
}
```

### `src/poll/__tests__/scheduler.unit.test.ts`

```ts
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
    let clock = 100;
    const s = new Scheduler({ now: () => clock });
    s.upsert(buildState({ battleId: 1n, zoneId: 1, nextAt: 50 }));
    s.upsert(buildState({ battleId: 2n, zoneId: 2, nextAt: 100 }));
    s.upsert(buildState({ battleId: 3n, zoneId: 3, nextAt: 200 }));
    const due = s.tick();
    expect(due.map((d) => d.battleId)).toEqual([1n, 2n]);
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
```

### Steps

- [ ] **Step 1**: Create `scheduler.ts` and the test file with the contents above.
- [ ] **Step 2**: Run `npm test -- scheduler.unit && npm run typecheck`. Expect 7 PASS, typecheck silent.
- [ ] **Step 3**: Commit:

```bash
git add src/poll/scheduler.ts src/poll/__tests__/scheduler.unit.test.ts
git commit -m "feat(poll): add Scheduler (min-heap + tick draining)"
```

---

## Task 3: Campaigns scan + matching helper + listAllForMatching

**Files:**
- Create: `src/poll/campaigns-scan.ts`
- Create: `src/poll/matching.ts`
- Create: `src/poll/__tests__/campaigns-scan.unit.test.ts`
- Create: `src/poll/__tests__/matching.unit.test.ts`
- Modify: `src/db/repos/victims.ts` — add `listAllForMatching`
- Modify: `src/db/__tests__/victims.integration.test.ts`

### `src/db/repos/victims.ts` — add to the class

```ts
/** Returns `[{hunter, citizen}, ...]` across ALL hunters. The polling engine
 *  calls this once per scan to build the in-memory victim → hunters map. */
async listAllForMatching(): Promise<Array<{ hunter: bigint; citizen: bigint }>> {
  const { rows } = await this.pool.query<{
    hunter_telegram_id: string;
    citizen_id: string;
  }>(`SELECT hunter_telegram_id, citizen_id FROM victims`);
  return rows.map((r) => ({
    hunter: BigInt(r.hunter_telegram_id),
    citizen: BigInt(r.citizen_id),
  }));
}
```

### `src/poll/matching.ts`

```ts
import type { BattleStatsResponse } from '../erep/types/battle-stats.js';
import { flattenTopDamage } from '../erep/types/battle-stats.js';

export interface VictimMap {
  /** citizenId → set of hunter Telegram IDs that listed this citizen. */
  byCitizen: Map<bigint, Set<bigint>>;
}

export function buildVictimMap(rows: Array<{ hunter: bigint; citizen: bigint }>): VictimMap {
  const byCitizen = new Map<bigint, Set<bigint>>();
  for (const { hunter, citizen } of rows) {
    let set = byCitizen.get(citizen);
    if (!set) {
      set = new Set();
      byCitizen.set(citizen, set);
    }
    set.add(hunter);
  }
  return { byCitizen };
}

export interface PerHunterMatch {
  hunterTelegramId: bigint;
  victims: Array<{
    citizenId: number;
    /** Damage from top_damage entry — used to sort and to render `infl ...M`. */
    influence: number;
    /** Country side ('inv' for invader country, 'def' for defender). */
    side: 'inv' | 'def';
    /** Top-damage rank (1 = highest), or null if not exposed by the response. */
    airRank: number | null;
    /** Resolved name from fightersData (falls back to citizenId-as-string when missing). */
    name: string;
  }>;
}

/**
 * Walks the air-division top_damage list and groups matches by hunter.
 * Returns one entry per hunter that had ≥1 victim in the round.
 *
 * `airRank` is derived from the position of each fighter within their side's
 * top_damage array, since the array is documented as already sorted by damage
 * (descending) per the KB.
 */
export function findMatchesForBattle(input: {
  stats: BattleStatsResponse;
  zoneId: number;
  invCountryId: number;
  defCountryId: number;
  victims: VictimMap;
}): PerHunterMatch[] {
  const matchesByHunter = new Map<bigint, PerHunterMatch>();

  // Walk all top_damage entries (across both sides + per-zone splits) for div 11.
  const all = flattenTopDamage(input.stats, input.zoneId, 11);
  // Per-side rank: iterate per-side, computing rank by position in the sorted array.
  const perSide = groupBySide(all, input.invCountryId, input.defCountryId);

  for (const [side, entries] of perSide) {
    entries.forEach((entry, idx) => {
      const hunterSet = input.victims.byCitizen.get(BigInt(entry.citizen_id));
      if (!hunterSet) return;
      const fighterCard = input.stats.fightersData[String(entry.citizen_id)];
      const name = fighterCard?.name ?? String(entry.citizen_id);
      for (const hunterId of hunterSet) {
        let bucket = matchesByHunter.get(hunterId);
        if (!bucket) {
          bucket = { hunterTelegramId: hunterId, victims: [] };
          matchesByHunter.set(hunterId, bucket);
        }
        bucket.victims.push({
          citizenId: entry.citizen_id,
          influence: entry.damage,
          side,
          airRank: idx + 1,
          name,
        });
      }
    });
  }

  return [...matchesByHunter.values()];
}

function groupBySide(
  entries: ReturnType<typeof flattenTopDamage>,
  invId: number,
  defId: number,
): Map<'inv' | 'def', typeof entries> {
  const inv: typeof entries = [];
  const def: typeof entries = [];
  for (const e of entries) {
    if (e.side_country_id === invId) inv.push(e);
    else if (e.side_country_id === defId) def.push(e);
    // else: ally fighters — current spec ignores.
  }
  return new Map([
    ['inv', inv],
    ['def', def],
  ]);
}
```

### `src/poll/campaigns-scan.ts`

```ts
import type { CampaignsResponse } from '../erep/types/campaigns.js';
import { findAirZoneId } from '../erep/types/campaigns.js';
import type { BattleState } from './types.js';

export interface CampaignsScanInput {
  campaigns: CampaignsResponse;
  /** Lower bound on round elapsed (seconds). Per SPEC §4.4 the cutoff is 5100s (T85+). */
  minElapsedSec: number;
}

export interface CampaignsScanOutput {
  /** Battles to keep / introduce. Keys are `${battleId}:${zoneId}`. Values
   *  carry the descriptive fields the polling engine needs to render alerts. */
  active: Map<string, NewBattleSeed>;
}

export interface NewBattleSeed {
  battleId: bigint;
  zoneId: number;
  start: number;
  invName: string;
  defName: string;
  region: string;
}

/**
 * Pure function: walks the campaigns response and returns the set of battles
 * whose air round meets the T85+ cutoff. Caller diff this against the
 * scheduler's current set to decide what to add/remove.
 */
export function scanCampaigns(input: CampaignsScanInput): CampaignsScanOutput {
  const active = new Map<string, NewBattleSeed>();
  const serverNow = input.campaigns.time;

  for (const battle of Object.values(input.campaigns.battles)) {
    const elapsed = serverNow - battle.start;
    if (elapsed < input.minElapsedSec) continue;

    const airZoneId = findAirZoneId(battle);
    if (airZoneId === null) continue;
    const air = battle.div[airZoneId]!;
    if (air.division_end || air.end !== null) continue; // Round already closed.

    const invName = input.campaigns.countries[String(battle.inv.id)]?.name ?? String(battle.inv.id);
    const defName = input.campaigns.countries[String(battle.def.id)]?.name ?? String(battle.def.id);

    active.set(`${battle.id}:${air.id}`, {
      battleId: BigInt(battle.id),
      zoneId: air.id,
      start: battle.start,
      invName,
      defName,
      region: battle.region.name,
    });
  }

  return { active };
}

/** Helper: builds the initial BattleState for a newly-detected battle (entry probe). */
export function seedToInitialState(seed: NewBattleSeed, now: number): BattleState {
  return {
    battleId: seed.battleId,
    zoneId: seed.zoneId,
    phase: 'probe',
    start: seed.start,
    invName: seed.invName,
    defName: seed.defName,
    region: seed.region,
    lastEtaSec: null,
    /** Probe immediately (within the next tick). */
    nextActionAt: now,
  };
}
```

### Tests

**`src/poll/__tests__/campaigns-scan.unit.test.ts`** — verifies:
1. T85+ filter keeps elapsed ≥ minElapsedSec (5100s default).
2. Battles without an air division (no `div: 11`) are excluded.
3. Battles whose air round has `division_end: true` or `end !== null` are excluded.
4. Country names from the `countries` map are used; falls back to the country id string when missing.
5. `seedToInitialState` puts `nextActionAt = now` and `phase = 'probe'`.

**`src/poll/__tests__/matching.unit.test.ts`** — verifies:
1. `buildVictimMap` groups `[{hunter, citizen}]` rows into a `byCitizen` map of sets.
2. `findMatchesForBattle` returns one entry per hunter that has ≥1 victim in the fighters list.
3. Multiple victims for one hunter are combined into a single `PerHunterMatch`.
4. Same victim can be on multiple hunters' lists — multiple `PerHunterMatch` entries are returned.
5. `airRank` is the 1-indexed position within the side's top_damage array.
6. `side` is correctly assigned by `side_country_id` matching `invCountryId` or `defCountryId`.
7. `name` falls back to the citizen-id string when `fightersData` lacks the entry.
8. Fighters not in any victim list yield no match entries.

(Implementer subagent: write ~10 tests across the two files using `mockStats`-like builders. Use minimal fixtures; rely on the existing `flattenTopDamage` to walk `stats.current`. Reference `src/erep/__tests__/fixtures/battle-stats-d11.json` for the response shape.)

### Steps

- [ ] **Step 1**: Implement `victims.ts` change + integration test (1 test: `listAllForMatching` returns dense `[{hunter, citizen}]` pairs across hunters).
- [ ] **Step 2**: Implement `matching.ts` + tests.
- [ ] **Step 3**: Implement `campaigns-scan.ts` + tests.
- [ ] **Step 4**: Run `npm test -- 'campaigns-scan|matching\\.unit' && npm run test:db -- victims && npm run typecheck`. Expect all PASS.
- [ ] **Step 5**: Commit:

```bash
git add src/db/repos/victims.ts src/db/__tests__/victims.integration.test.ts src/poll/matching.ts src/poll/campaigns-scan.ts src/poll/__tests__/matching.unit.test.ts src/poll/__tests__/campaigns-scan.unit.test.ts
git commit -m "feat(poll): add campaigns-scan + matching helpers; victims.listAllForMatching"
```

---

## Task 4: Probe + Monitor workers

**Files:**
- Create: `src/poll/probe.ts`
- Create: `src/poll/monitor.ts`
- Create: `src/poll/__tests__/probe.unit.test.ts`
- Create: `src/poll/__tests__/monitor.unit.test.ts`

### `src/poll/probe.ts`

```ts
import type { Logger } from '../erep/logger.js';
import type { ErepClient } from '../erep/client.js';
import { computeRefinedEta } from './eta.js';
import type { BattlePhase, BattleState } from './types.js';

export interface ProbeDeps {
  client: Pick<ErepClient, 'getBattleStats'>;
  /** Server-now provider — campaigns response `time` cached by the engine. */
  serverNow: () => number;
  /** Local-now provider, used to compute nextActionAt. Defaults to seconds-since-epoch. */
  localNow: () => number;
  logger?: Logger;
  /** Window threshold in seconds (default 300 per SPEC). */
  windowSec: number;
  /** Probe lead in seconds (default 300 per SPEC). */
  probeLeadSec: number;
}

export type ProbeOutcome =
  | { kind: 'remove' } // round closed; engine should drop the battle.
  | { kind: 'reschedule'; phase: BattlePhase; nextActionAt: number; lastEtaSec: number | null };

/**
 * Single ETA probe. Fetches battle-stats once, computes refined ETA, and
 * returns what the engine should do next:
 *   - `remove` if zone_finished or computeRefinedEta cannot resolve a leader.
 *   - `reschedule` with phase='monitor' if ETA ≤ window.
 *   - `reschedule` with phase='probe' otherwise, with nextActionAt =
 *     localNow + clamp(eta_s - probeLeadSec, 30, 600).
 */
export async function runProbe(state: BattleState, deps: ProbeDeps): Promise<ProbeOutcome> {
  let stats;
  try {
    stats = await deps.client.getBattleStats(state.battleId, state.zoneId, 11);
  } catch (err) {
    deps.logger?.warn('poll.probe.fetch_failed', {
      battleId: state.battleId.toString(),
      zoneId: state.zoneId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Re-try in 60s — transient errors should not drop the battle.
    return { kind: 'reschedule', phase: 'probe', nextActionAt: deps.localNow() + 60, lastEtaSec: state.lastEtaSec };
  }
  if (stats.zone_finished) return { kind: 'remove' };

  const eta = computeRefinedEta({
    stats,
    zoneId: state.zoneId,
    roundStartUnix: state.start,
    serverNowUnix: deps.serverNow(),
  });
  if (!eta) return { kind: 'remove' };

  if (eta.etaSec <= deps.windowSec) {
    // Promote to monitor immediately (in-window).
    return {
      kind: 'reschedule',
      phase: 'monitor',
      nextActionAt: deps.localNow(),
      lastEtaSec: eta.etaSec,
    };
  }

  // Schedule next probe per SPEC §4.4: clamp(eta - probeLead, 30, 600) seconds.
  const delay = Math.min(600, Math.max(30, eta.etaSec - deps.probeLeadSec));
  return {
    kind: 'reschedule',
    phase: 'probe',
    nextActionAt: deps.localNow() + delay,
    lastEtaSec: eta.etaSec,
  };
}
```

### `src/poll/monitor.ts`

```ts
import type { Logger } from '../erep/logger.js';
import type { ErepClient } from '../erep/client.js';
import type { MatchesService, MatchAlertInput } from '../services/matches.js';
import { computeRefinedEta } from './eta.js';
import { findMatchesForBattle, type VictimMap } from './matching.js';
import type { BattleState } from './types.js';

export interface MonitorDeps {
  client: Pick<ErepClient, 'getBattleStats'>;
  matches: Pick<MatchesService, 'maybeAlert'>;
  /** Returns the latest victim-map snapshot. Built once per scan by the engine. */
  victims: () => VictimMap;
  /** Country ids for this battle's invader/defender — supplied by the engine
   *  from the cached campaigns response. */
  countriesFor: (battleId: bigint) => { inv: number; def: number } | null;
  serverNow: () => number;
  localNow: () => number;
  logger?: Logger;
  windowSec: number;
  monitorIntervalSec: number;
  probeLeadSec: number;
}

export type MonitorOutcome =
  | { kind: 'remove' }
  | { kind: 'reschedule'; phase: 'monitor' | 'probe'; nextActionAt: number; lastEtaSec: number | null };

/**
 * In-window scan: fetches battle-stats, recomputes ETA, finds matches, and
 * fires `MatchesService.maybeAlert` per matched hunter. Hysteresis: if ETA
 * climbs back above `windowSec`, demote to 'probe' (per REVIEW_NOTES.md §3.2).
 */
export async function runMonitor(state: BattleState, deps: MonitorDeps): Promise<MonitorOutcome> {
  let stats;
  try {
    stats = await deps.client.getBattleStats(state.battleId, state.zoneId, 11);
  } catch (err) {
    deps.logger?.warn('poll.monitor.fetch_failed', {
      battleId: state.battleId.toString(),
      zoneId: state.zoneId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: 'reschedule',
      phase: 'monitor',
      nextActionAt: deps.localNow() + deps.monitorIntervalSec,
      lastEtaSec: state.lastEtaSec,
    };
  }
  if (stats.zone_finished) return { kind: 'remove' };

  const eta = computeRefinedEta({
    stats,
    zoneId: state.zoneId,
    roundStartUnix: state.start,
    serverNowUnix: deps.serverNow(),
  });
  if (!eta) return { kind: 'remove' };

  // Hysteresis: if ETA back-flipped above the window, demote to probe.
  if (eta.etaSec > deps.windowSec) {
    const delay = Math.min(600, Math.max(30, eta.etaSec - deps.probeLeadSec));
    return {
      kind: 'reschedule',
      phase: 'probe',
      nextActionAt: deps.localNow() + delay,
      lastEtaSec: eta.etaSec,
    };
  }

  // Find matches and fire alerts.
  const countries = deps.countriesFor(state.battleId);
  if (countries) {
    const perHunter = findMatchesForBattle({
      stats,
      zoneId: state.zoneId,
      invCountryId: countries.inv,
      defCountryId: countries.def,
      victims: deps.victims(),
    });
    const wallDom = stats.division.domination[String(state.zoneId)] ?? 0;
    const wallHolderId = stats.division.bar[String(state.zoneId)] ?? countries.inv;
    const wallHolderName =
      wallHolderId === countries.inv ? state.invName : wallHolderId === countries.def ? state.defName : String(wallHolderId);
    for (const hunterMatch of perHunter) {
      const alert: MatchAlertInput = {
        hunter: { telegramId: hunterMatch.hunterTelegramId },
        battle: {
          battleId: state.battleId,
          zoneId: state.zoneId,
          invName: state.invName,
          defName: state.defName,
          region: state.region,
        },
        timing: {
          etaMinutes: Math.max(0, Math.round(eta.etaSec / 60)),
          wallDom: Math.round(wallDom),
          wallHolder: wallHolderName,
        },
        matchedVictims: hunterMatch.victims.map((v) => ({
          citizenId: v.citizenId,
          name: v.name,
          side: v.side,
          influence: v.influence,
          airRank: v.airRank,
        })),
      };
      // maybeAlert is resilient (returns 'sent' / 'already_alerted' / 'send_failed');
      // we don't need to do anything per outcome here — the dedup repo + the
      // sender's logger handle observability.
      await deps.matches.maybeAlert(alert);
    }
  }

  return {
    kind: 'reschedule',
    phase: 'monitor',
    nextActionAt: deps.localNow() + deps.monitorIntervalSec,
    lastEtaSec: eta.etaSec,
  };
}
```

### Tests

For brevity, the plan does not enumerate every test case here. Aim for:

**`src/poll/__tests__/probe.unit.test.ts`** (~6 tests):
1. zone_finished → `remove`
2. computeRefinedEta returns null → `remove`
3. ETA ≤ windowSec → reschedule to `monitor` with `nextActionAt = localNow()`
4. ETA > windowSec → reschedule to `probe` with `nextActionAt = localNow + clamp(eta-probeLead, 30, 600)`
5. ETA > windowSec but `eta - probeLead < 30` → clamps to 30
6. fetch error → reschedule to `probe` with +60s delay (transient retry)

**`src/poll/__tests__/monitor.unit.test.ts`** (~6 tests):
1. zone_finished → `remove`
2. ETA back > windowSec → demote to `probe` (hysteresis)
3. Match-check fires `maybeAlert` once per matched hunter
4. No matches → no `maybeAlert` calls
5. countriesFor returns null → still reschedules monitor but skips alerts
6. fetch error → keeps `monitor` phase, +monitorIntervalSec delay

The implementer subagent uses `vi.fn` mocks for `client.getBattleStats`, `matches.maybeAlert`, `victims()`, `countriesFor()`. The `mockStats` builder from Task 1's eta tests can be reused (extract to a shared `_helpers.ts` if needed).

### Steps

- [ ] **Step 1**: Implement `probe.ts` + `monitor.ts`.
- [ ] **Step 2**: Implement test files (~12 tests total).
- [ ] **Step 3**: Run `npm test -- 'probe\\.unit|monitor\\.unit' && npm run typecheck`. Expect all PASS.
- [ ] **Step 4**: Commit:

```bash
git add src/poll/probe.ts src/poll/monitor.ts src/poll/__tests__/probe.unit.test.ts src/poll/__tests__/monitor.unit.test.ts
git commit -m "feat(poll): add probe + monitor workers (with hysteresis)"
```

---

## Task 5: Cleanup + PollingEngine factory + config + verification script

**Files:**
- Create: `src/poll/cleanup.ts`
- Create: `src/poll/index.ts` — `PollingEngine` factory + `start`/`stop`
- Create: `src/poll/__tests__/cleanup.unit.test.ts`
- Create: `src/poll/__tests__/engine.unit.test.ts`
- Create: `scripts/inspect-battle-stats.ts` — manual KB verification helper
- Modify: `src/config.ts` — add poll-related env vars
- Modify: `src/__tests__/config.unit.test.ts` — extend
- Modify: `.env.example` — append poll-related vars

### `src/config.ts` — extend with poll vars

Add to the schema:

```ts
POLL_CAMPAIGNS_SEC: z.string().default('60').refine((s) => /^[0-9]+$/.test(s), 'POLL_CAMPAIGNS_SEC must be numeric'),
POLL_INWINDOW_SEC: z.string().default('30').refine((s) => /^[0-9]+$/.test(s), 'POLL_INWINDOW_SEC must be numeric'),
WINDOW_SECONDS: z.string().default('300').refine((s) => /^[0-9]+$/.test(s), 'WINDOW_SECONDS must be numeric'),
PROBE_LEAD_SEC: z.string().default('300').refine((s) => /^[0-9]+$/.test(s), 'PROBE_LEAD_SEC must be numeric'),
CANDIDATE_MIN_ELAPSED_SEC: z.string().default('5100').refine((s) => /^[0-9]+$/.test(s), 'CANDIDATE_MIN_ELAPSED_SEC must be numeric'),
```

Extend `Config` and `loadConfig` to expose them as `pollCampaignsSec`, `pollInwindowSec`, `windowSeconds`, `probeLeadSec`, `candidateMinElapsedSec` (all `number`).

Append to `.env.example`:

```
# Polling cadences (defaults match SPEC §11; rarely need to override).
# POLL_CAMPAIGNS_SEC=60
# POLL_INWINDOW_SEC=30
# WINDOW_SECONDS=300
# PROBE_LEAD_SEC=300
# CANDIDATE_MIN_ELAPSED_SEC=5100
```

Update `config.unit.test.ts` to verify defaults work (one new test: `loadConfig({ minimal env without poll vars }).pollCampaignsSec === 60`).

### `src/poll/cleanup.ts`

```ts
import type { Logger } from '../erep/logger.js';
import type { AlertedRoundsRepo } from '../db/repos/alerted-rounds.js';

/** Daily cleanup job. Returns the number of rows deleted. */
export async function runCleanup(deps: {
  alertedRounds: Pick<AlertedRoundsRepo, 'pruneOlderThan'>;
  olderThanHours?: number;
  logger?: Logger;
}): Promise<number> {
  const olderThanHours = deps.olderThanHours ?? 48;
  try {
    const removed = await deps.alertedRounds.pruneOlderThan({ olderThanHours });
    deps.logger?.info('poll.cleanup.done', { removed, olderThanHours });
    return removed;
  } catch (err) {
    deps.logger?.error('poll.cleanup.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
```

### `src/poll/index.ts`

```ts
import type { Logger } from '../erep/logger.js';
import { SilentLogger } from '../erep/logger.js';
import type { ErepClient } from '../erep/client.js';
import type { VictimRepo } from '../db/repos/victims.js';
import type { AlertedRoundsRepo } from '../db/repos/alerted-rounds.js';
import type { MatchesService } from '../services/matches.js';
import type { CampaignsResponse } from '../erep/types/campaigns.js';
import { Scheduler } from './scheduler.js';
import { scanCampaigns, seedToInitialState } from './campaigns-scan.js';
import { buildVictimMap, type VictimMap } from './matching.js';
import { runProbe } from './probe.js';
import { runMonitor } from './monitor.js';
import { runCleanup } from './cleanup.js';

export interface PollingEngineDeps {
  client: ErepClient;
  victims: VictimRepo;
  alertedRounds: AlertedRoundsRepo;
  matches: MatchesService;
  logger?: Logger;
  /** Cadences; all in seconds. */
  pollCampaignsSec?: number;
  pollInwindowSec?: number;
  windowSeconds?: number;
  probeLeadSec?: number;
  candidateMinElapsedSec?: number;
  /** Time sources, overridable for tests. */
  localNow?: () => number;
}

/**
 * Owns the three polling loops. `start()` kicks off all three; `stop()` clears
 * all timers. Single-process lifecycle — the entrypoint is responsible for
 * graceful shutdown via process signal handlers.
 */
export class PollingEngine {
  private campaignsTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  private latestCampaigns: CampaignsResponse | null = null;
  private latestVictims: VictimMap = { byCitizen: new Map() };
  private readonly scheduler: Scheduler;
  private readonly log: Logger;

  /** Map of `${battleId}:${zoneId}` → invariants from the latest campaigns scan
   *  that the workers need at probe/monitor time (country ids for matching). */
  private readonly battleInfo = new Map<string, { invId: number; defId: number }>();

  /** Counters for /status. */
  private campaignsScans = 0;
  private probeRuns = 0;
  private monitorRuns = 0;

  constructor(private readonly deps: PollingEngineDeps) {
    this.log = deps.logger ?? new SilentLogger();
    this.scheduler = new Scheduler({ now: this.localNow.bind(this) });
  }

  start(): void {
    if (this.campaignsTimer) return; // Idempotent.
    // Kick the first campaigns scan immediately, then on a timer.
    void this.runCampaignsScan();
    this.campaignsTimer = setInterval(
      () => void this.runCampaignsScan(),
      (this.deps.pollCampaignsSec ?? 60) * 1000,
    );
    this.tickTimer = setInterval(() => void this.runTick(), 1000);
    // Cleanup every 24h.
    this.cleanupTimer = setInterval(
      () => void runCleanup({ alertedRounds: this.deps.alertedRounds, ...(this.deps.logger && { logger: this.log }) }),
      24 * 60 * 60 * 1000,
    );
  }

  stop(): void {
    if (this.campaignsTimer) clearInterval(this.campaignsTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.campaignsTimer = this.tickTimer = this.cleanupTimer = null;
  }

  /** /status snapshot. */
  snapshot(): {
    inFlight: number;
    campaignsScans: number;
    probeRuns: number;
    monitorRuns: number;
    latestCampaignsTime: number | null;
  } {
    return {
      inFlight: this.scheduler.size(),
      campaignsScans: this.campaignsScans,
      probeRuns: this.probeRuns,
      monitorRuns: this.monitorRuns,
      latestCampaignsTime: this.latestCampaigns?.time ?? null,
    };
  }

  // -- internal ---------------------------------------------------------------

  private localNow(): number {
    return this.deps.localNow ? this.deps.localNow() : Math.floor(Date.now() / 1000);
  }

  private serverNow(): number {
    return this.latestCampaigns?.time ?? this.localNow();
  }

  private async runCampaignsScan(): Promise<void> {
    this.campaignsScans += 1;
    let campaigns: CampaignsResponse;
    try {
      campaigns = await this.deps.client.listCampaigns();
    } catch (err) {
      this.log.warn('poll.campaigns.fetch_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.latestCampaigns = campaigns;

    // Refresh victim map.
    try {
      const rows = await this.deps.victims.listAllForMatching();
      this.latestVictims = buildVictimMap(rows);
    } catch (err) {
      this.log.warn('poll.victims.refresh_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const { active } = scanCampaigns({
      campaigns,
      minElapsedSec: this.deps.candidateMinElapsedSec ?? 5100,
    });

    // Add new battles, refresh battleInfo, drop battles no longer in campaigns.
    for (const [key, seed] of active) {
      this.battleInfo.set(key, { invId: this.invIdFromCampaigns(seed.battleId, campaigns), defId: this.defIdFromCampaigns(seed.battleId, campaigns) });
      if (!this.scheduler.has(seed.battleId, seed.zoneId)) {
        this.scheduler.upsert(seedToInitialState(seed, this.localNow()));
      }
    }
    // Drop scheduler entries no longer in `active`.
    for (const state of this.scheduler.snapshot()) {
      const key = `${state.battleId}:${state.zoneId}`;
      if (!active.has(key)) {
        this.scheduler.remove(state.battleId, state.zoneId);
        this.battleInfo.delete(key);
      }
    }
  }

  private invIdFromCampaigns(battleId: bigint, campaigns: CampaignsResponse): number {
    return campaigns.battles[battleId.toString()]?.inv.id ?? 0;
  }

  private defIdFromCampaigns(battleId: bigint, campaigns: CampaignsResponse): number {
    return campaigns.battles[battleId.toString()]?.def.id ?? 0;
  }

  private async runTick(): Promise<void> {
    const due = this.scheduler.tick();
    if (due.length === 0) return;
    // Process serially per battle; bound concurrency loosely (5 in flight) to
    // avoid bursts when many entries fire on the same tick.
    const workers: Promise<void>[] = [];
    for (const state of due) {
      workers.push(this.processOne(state));
      if (workers.length >= 5) {
        await Promise.all(workers);
        workers.length = 0;
      }
    }
    if (workers.length > 0) await Promise.all(workers);
  }

  private async processOne(state: import('./types.js').BattleState): Promise<void> {
    const probeLeadSec = this.deps.probeLeadSec ?? 300;
    const windowSec = this.deps.windowSeconds ?? 300;
    if (state.phase === 'probe') {
      this.probeRuns += 1;
      const outcome = await runProbe(state, {
        client: this.deps.client,
        serverNow: this.serverNow.bind(this),
        localNow: this.localNow.bind(this),
        ...(this.deps.logger && { logger: this.log }),
        windowSec,
        probeLeadSec,
      });
      this.applyOutcome(state, outcome);
    } else {
      this.monitorRuns += 1;
      const outcome = await runMonitor(state, {
        client: this.deps.client,
        matches: this.deps.matches,
        victims: () => this.latestVictims,
        countriesFor: (id) => {
          const info = this.battleInfo.get(`${id}:${state.zoneId}`);
          return info ? { inv: info.invId, def: info.defId } : null;
        },
        serverNow: this.serverNow.bind(this),
        localNow: this.localNow.bind(this),
        ...(this.deps.logger && { logger: this.log }),
        windowSec,
        monitorIntervalSec: this.deps.pollInwindowSec ?? 30,
        probeLeadSec,
      });
      this.applyOutcome(state, outcome);
    }
  }

  private applyOutcome(
    state: import('./types.js').BattleState,
    outcome: { kind: 'remove' } | { kind: 'reschedule'; phase: 'probe' | 'monitor'; nextActionAt: number; lastEtaSec: number | null },
  ): void {
    if (outcome.kind === 'remove') {
      this.battleInfo.delete(`${state.battleId}:${state.zoneId}`);
      return; // already popped from scheduler in tick().
    }
    this.scheduler.upsert({
      ...state,
      phase: outcome.phase,
      nextActionAt: outcome.nextActionAt,
      lastEtaSec: outcome.lastEtaSec,
    });
  }
}

/** Convenience factory. */
export function createPollingEngine(deps: PollingEngineDeps): PollingEngine {
  return new PollingEngine(deps);
}
```

### `scripts/inspect-battle-stats.ts`

```ts
/**
 * Manual KB-verification helper. Usage:
 *   npm run demo:inspect-battle-stats -- <battleId> <zoneId>
 *
 * Fetches a real battle-stats response and prints its `division.bar`,
 * `division.domination`, and per-country `division.{id}.{zoneId}.domination`
 * fields. Use the output to confirm the polling engine's domination-units
 * assumption (currently: per-country domination is treated as 0–1800 round
 * points). If real values exceed 1800, the assumption is wrong and
 * `src/poll/eta.ts` needs adjustment (multiply by 18 if percentage).
 */
import { AuthManager, ErepClient, FileSessionStore } from '../src/erep/index.js';

const battleId = Number(process.argv[2]);
const zoneId = Number(process.argv[3]);
if (!battleId || !zoneId) {
  console.error('Usage: npm run demo:inspect-battle-stats -- <battleId> <zoneId>');
  process.exit(1);
}

const email = process.env.EREP_EMAIL;
const password = process.env.EREP_PASSWORD;
if (!email || !password) {
  console.error('EREP_EMAIL and EREP_PASSWORD must be set');
  process.exit(1);
}
const auth = new AuthManager({ email, password, store: new FileSessionStore('./data/session.json') });
const client = new ErepClient({ auth });

const res = await client.getBattleStats(battleId, zoneId, 11);
const zoneKey = String(zoneId);
console.log('division.bar:', res.division.bar);
console.log('division.domination:', res.division.domination);
console.log('zone_finished:', res.zone_finished);
console.log('per-country domination:');
for (const key of Object.keys(res.division)) {
  if (!/^[0-9]+$/.test(key)) continue;
  const entry = (res.division as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
  if (!entry) continue;
  const z = entry[zoneKey] as { domination?: number; won?: number } | undefined;
  if (z) console.log(`  country ${key}: domination=${z.domination}, won=${z.won}`);
}
console.log('NOTE: if any per-country domination value > 100, the engine\'s 0-1800 assumption is correct.');
console.log('      If all values are ≤ 100, treat them as percentage and multiply by 18 in src/poll/eta.ts.');
```

Add npm script to `package.json`:

```json
"demo:inspect-battle-stats": "node --env-file=.env --import tsx scripts/inspect-battle-stats.ts"
```

### Tests

**`src/poll/__tests__/cleanup.unit.test.ts`** (~3 tests): happy path, error path, custom hours.

**`src/poll/__tests__/engine.unit.test.ts`** (~5 tests, integration-style with all-mocked deps):
1. `start()` is idempotent — calling twice doesn't double-register timers.
2. `start()` then immediate `runCampaignsScan` populates `latestCampaigns`.
3. `snapshot()` returns the correct counters after some scans/probes.
4. Battle no longer in campaigns → scheduler entry is removed on next scan.
5. `stop()` clears all timers (verify by calling `start`, `stop`, and confirming `setInterval` mocks were cleared).

The implementer subagent uses `vi.useFakeTimers()` to control time, mocks `client.listCampaigns`, mocks the repos, and asserts behaviour. Reference `src/db/__tests__/_pg.ts` for the testcontainers pattern (NOT used here — pure unit tests with mocks).

### Steps

- [ ] **Step 1**: Implement config extension + .env.example update + config tests.
- [ ] **Step 2**: Implement `cleanup.ts` + tests.
- [ ] **Step 3**: Implement `index.ts` (engine factory) + tests.
- [ ] **Step 4**: Implement `scripts/inspect-battle-stats.ts` + add npm script.
- [ ] **Step 5**: Run `npm test && npm run typecheck && npm run test:db`. Expect full unit suite + integration suite all PASS; typecheck silent.
- [ ] **Step 6**: Commit:

```bash
git add src/poll/cleanup.ts src/poll/index.ts src/poll/__tests__/cleanup.unit.test.ts src/poll/__tests__/engine.unit.test.ts src/config.ts src/__tests__/config.unit.test.ts .env.example scripts/inspect-battle-stats.ts package.json
git commit -m "feat(poll): add cleanup + PollingEngine factory + config + inspect script"
```

---

## Definition of done

- `npm test` passes (unit suite — including all new poll tests).
- `npm run test:db` still passes (the new `victims.listAllForMatching` integration test plus everything that already passed).
- `npm run typecheck` is silent.
- `src/poll/index.ts` exports `PollingEngine` + `createPollingEngine` factory.
- The engine's `start()` is idempotent and `stop()` clears all timers.
- Hysteresis works: monitor → probe demotion when ETA back > windowSec.
- `scripts/inspect-battle-stats.ts` exists for live verification of the SPEC §13.3 domination units.

## Next plans (suggested order)

1. **Mini App + HTTP server** — Express + initData HMAC + `/api/victims*` calling `VictimService`.
2. **Docker compose + entrypoint glue** — `src/index.ts` that ties config + repos + services + bot + polling + http together; Dockerfile; `docker-compose.yml`. After this, `docker compose up -d` runs the bot end-to-end.
