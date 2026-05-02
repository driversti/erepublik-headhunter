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
