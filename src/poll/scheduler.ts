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
