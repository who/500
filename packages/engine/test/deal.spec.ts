import { describe, expect, it } from 'vitest';
import { N_CARDS, deal, makeRng } from '../src/index.js';

describe('makeRng', () => {
  it('is deterministic for a given seed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 100; i++) {
      expect(a.random()).toBe(b.random());
    }
  });

  it('two instances do not share state', () => {
    const a = makeRng(7);
    const b = makeRng(7);
    a.random();
    a.random();
    expect(b.random()).toBe(makeRng(7).random());
  });

  it('random() stays in [0, 1)', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 10_000; i++) {
      const x = rng.random();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('int(n) covers [0, n) and never returns n', () => {
    const rng = makeRng(123);
    const counts = new Array(5).fill(0);
    for (let i = 0; i < 50_000; i++) {
      const v = rng.int(5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
      counts[v]++;
    }
    // Roughly uniform: each bucket within 10% of the expected 10k.
    for (const c of counts) {
      expect(c).toBeGreaterThan(9_000);
      expect(c).toBeLessThan(11_000);
    }
  });

  it('shuffle handles empty and 1-length arrays', () => {
    const rng = makeRng(9);
    const empty: number[] = [];
    rng.shuffle(empty);
    expect(empty).toEqual([]);
    const one = [3];
    rng.shuffle(one);
    expect(one).toEqual([3]);
  });

  it('shuffle permutes without losing elements', () => {
    const rng = makeRng(5);
    const arr = Array.from({ length: 20 }, (_, i) => i);
    rng.shuffle(arr);
    expect([...arr].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
  });
});

describe('deal', () => {
  it('is deterministic under a fixed seed (AC-1)', () => {
    const first = deal(makeRng(42));
    const second = deal(makeRng(42));
    expect(second).toEqual(first);
    expect(first).toMatchSnapshot();
  });

  it('partitions all 45 cards into 4x10 sorted hands + 5 middle (AC-2)', () => {
    for (const seed of [0, 1, 42, 0xdeadbeef]) {
      const { hands, middle } = deal(makeRng(seed));
      expect(hands).toHaveLength(4);
      for (const hand of hands) {
        expect(hand).toHaveLength(10);
        expect([...hand].sort((a, b) => a - b)).toEqual(hand);
      }
      expect(middle).toHaveLength(5);
      const all = [...hands.flat(), ...middle];
      expect(new Set(all).size).toBe(N_CARDS);
      for (const c of all) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThan(N_CARDS);
      }
    }
  });

  it('consecutive deals from one rng differ', () => {
    const rng = makeRng(42);
    const first = deal(rng);
    const second = deal(rng);
    expect(second).not.toEqual(first);
  });
});
