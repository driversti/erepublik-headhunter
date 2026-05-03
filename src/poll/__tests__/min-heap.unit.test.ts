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
