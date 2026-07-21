import { describe, expect, it } from 'vitest';
import {
  DECK,
  JOKER,
  N_CARDS,
  RANKS,
  SAME_COLOR,
  SUITS,
  cardName,
  cardRank,
  cardSuit,
  makeCard,
} from '../src/index.js';

describe('cards', () => {
  it('has a 45-card deck of consecutive integers', () => {
    expect(N_CARDS).toBe(45);
    expect(DECK).toHaveLength(45);
    expect([...DECK]).toEqual(Array.from({ length: 45 }, (_, i) => i));
  });

  it('round-trips encode/decode for all 44 suited cards', () => {
    for (let suit = 0; suit < 4; suit++) {
      for (const rank of RANKS) {
        const c = makeCard(suit, rank);
        expect(cardSuit(c)).toBe(suit);
        expect(cardRank(c)).toBe(rank);
      }
    }
    // Every non-joker deck card decodes and re-encodes to itself.
    for (const c of DECK) {
      if (c === JOKER) continue;
      expect(makeCard(cardSuit(c) as number, cardRank(c) as number)).toBe(c);
    }
  });

  it('joker suit and rank are null', () => {
    expect(JOKER).toBe(44);
    expect(cardSuit(JOKER)).toBeNull();
    expect(cardRank(JOKER)).toBeNull();
    expect(cardName(JOKER)).toBe('JOKER');
  });

  it('names cards like the Python oracle', () => {
    expect(cardName(makeCard(0, 4))).toBe('4S');
    expect(cardName(makeCard(1, 10))).toBe('10C');
    expect(cardName(makeCard(2, 11))).toBe('JD');
    expect(cardName(makeCard(3, 14))).toBe('AH');
  });

  it('pairs same-color suits', () => {
    expect(SUITS).toEqual(['S', 'C', 'D', 'H']);
    expect(SAME_COLOR[0]).toBe(1);
    expect(SAME_COLOR[1]).toBe(0);
    expect(SAME_COLOR[2]).toBe(3);
    expect(SAME_COLOR[3]).toBe(2);
  });
});
