import { describe, expect, it } from 'vitest';
import {
  DNULLA,
  IND,
  LADDER,
  NT,
  NULLA,
  NUM,
  PASS,
  bid,
  bidName,
  bidValue,
  isLoseAll,
  ladderIndex,
  trumpOf,
} from '../src/index.js';

const idx = (b: Parameters<typeof ladderIndex>[0]) => ladderIndex(b) as number;

describe('ladder', () => {
  it('contains 22 bids, each with a unique index', () => {
    expect(LADDER).toHaveLength(22);
    const indices = LADDER.map((b) => ladderIndex(b));
    expect(indices).toEqual(Array.from({ length: 22 }, (_, i) => i));
  });

  it('places NULLA directly above 7NT and below all 8-bids', () => {
    expect(idx(bid(NULLA))).toBe(idx(bid(NUM, 7, NT)) + 1);
    expect(idx(bid(NULLA))).toBeLessThan(idx(bid(NUM, 8, 0)));
  });

  it('places DNULLA between 10D and 10H, with 10NT highest', () => {
    expect(idx(bid(NUM, 10, 2))).toBeLessThan(idx(bid(DNULLA)));
    expect(idx(bid(DNULLA))).toBeLessThan(idx(bid(NUM, 10, 3)));
    expect(idx(bid(NUM, 10, 3))).toBeLessThan(idx(bid(NUM, 10, NT)));
    expect(idx(bid(NUM, 10, NT))).toBe(LADDER.length - 1);
  });

  it('returns undefined for non-ladder bids', () => {
    expect(ladderIndex(bid(PASS))).toBeUndefined();
    expect(ladderIndex(bid(IND, 6, 0))).toBeUndefined();
  });
});

describe('bidValue', () => {
  it('matches the full Avondale table from the rules doc', () => {
    const table: Record<number, number[]> = {
      7: [140, 160, 180, 200, 220],
      8: [240, 260, 280, 300, 320],
      9: [340, 360, 380, 400, 420],
      10: [440, 460, 480, 500, 520],
    };
    for (const [level, values] of Object.entries(table)) {
      for (let strain = 0; strain < 5; strain++) {
        expect(bidValue(bid(NUM, Number(level), strain))).toBe(values[strain]);
      }
    }
  });

  // The oracle _self_test spot checks (7S=140, 10NT=520) live in rules.spec.ts.

  it('scores NULLA 250, DNULLA 500, and IND/PASS 0', () => {
    expect(bidValue(bid(NULLA))).toBe(250);
    expect(bidValue(bid(DNULLA))).toBe(500);
    expect(bidValue(bid(IND, 6, 2))).toBe(0);
    expect(bidValue(bid(PASS))).toBe(0);
  });
});

describe('contract helpers', () => {
  it('trumpOf returns the suit for suited NUM bids, null otherwise', () => {
    expect(trumpOf(bid(NUM, 8, 3))).toBe(3);
    expect(trumpOf(bid(NUM, 10, NT))).toBeNull();
    expect(trumpOf(bid(NULLA))).toBeNull();
    expect(trumpOf(bid(DNULLA))).toBeNull();
  });

  it('isLoseAll is true only for NULLA and DNULLA', () => {
    expect(isLoseAll(bid(NULLA))).toBe(true);
    expect(isLoseAll(bid(DNULLA))).toBe(true);
    expect(isLoseAll(bid(NUM, 7, 0))).toBe(false);
    expect(isLoseAll(bid(PASS))).toBe(false);
  });

  it('formats bid names like the Python oracle', () => {
    expect(bidName(bid(NUM, 7, 0))).toBe('7S');
    expect(bidName(bid(NUM, 10, NT))).toBe('10NT');
    expect(bidName(bid(IND, 6, 3))).toBe('6H (indication)');
    expect(bidName(bid(NULLA))).toBe('NULLA');
  });
});
