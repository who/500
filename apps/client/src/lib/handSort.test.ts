import { describe, expect, it } from 'vitest';
import { JOKER, NT, NULLA, NUM, bid, cardName, makeCard } from '@five-hundred/engine';
import { sortHand, suitDisplayOrder } from './handSort.ts';

const names = (cards: readonly number[]) => cards.map(cardName);

describe('suitDisplayOrder', () => {
  it('alternates colors with no trump', () => {
    expect(suitDisplayOrder(null)).toEqual([0, 2, 1, 3]); // S D C H
  });

  it('puts trump first and its color-mate in the middle', () => {
    expect(suitDisplayOrder(3)).toEqual([3, 0, 2, 1]); // H S D C
    expect(suitDisplayOrder(0)).toEqual([0, 2, 1, 3]); // S D C H
  });
});

describe('sortHand', () => {
  it('sorts by suit then rank descending with no contract, joker last', () => {
    const hand = [
      makeCard(1, 14), // AC
      makeCard(0, 4), // 4S
      JOKER,
      makeCard(0, 13), // KS
      makeCard(2, 10), // 10D
      makeCard(3, 12), // QH
    ];
    expect(names(sortHand(hand, null))).toEqual(['KS', '4S', '10D', 'AC', 'QH', 'JOKER']);
  });

  it('groups trump first with the left bower between right bower and ace', () => {
    const hand = [
      makeCard(3, 14), // AH
      makeCard(2, 11), // JD — left bower for hearts
      makeCard(3, 11), // JH — right bower
      makeCard(3, 5), // 5H
      makeCard(0, 14), // AS
      makeCard(2, 14), // AD
    ];
    // Hearts trump: H group first (JH, JD, AH, 5H), then S, D (bower gone), C.
    expect(names(sortHand(hand, bid(NUM, 8, 3)))).toEqual(['JH', 'JD', 'AH', '5H', 'AS', 'AD']);
  });

  it('leaves jacks in their natural suits when their color is not trump', () => {
    const hand = [
      makeCard(2, 11), // JD
      makeCard(0, 11), // JS — trump jack (right bower)
      makeCard(1, 11), // JC — left bower for spades
      makeCard(2, 14), // AD
    ];
    // Spades trump: JS then JC lead the trump group; JD stays a plain diamond.
    expect(names(sortHand(hand, bid(NUM, 7, 0)))).toEqual(['JS', 'JC', 'AD', 'JD']);
  });

  it('keeps the joker rightmost when a trump contract exists', () => {
    const hand = [JOKER, makeCard(3, 14), makeCard(3, 11)];
    expect(names(sortHand(hand, bid(NUM, 8, 3)))).toEqual(['JH', 'AH', 'JOKER']);
  });

  it('has no trump group in NT and nulla; joker still rightmost', () => {
    const hand = [makeCard(1, 11), JOKER, makeCard(0, 11), makeCard(2, 6)];
    for (const contract of [bid(NUM, 8, NT), bid(NULLA)]) {
      expect(names(sortHand(hand, contract))).toEqual(['JS', '6D', 'JC', 'JOKER']);
    }
  });

  it('does not mutate the input hand', () => {
    const hand = [makeCard(0, 4), makeCard(0, 14)];
    sortHand(hand, null);
    expect(names(hand)).toEqual(['4S', 'AS']);
  });
});
