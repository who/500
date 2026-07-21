import { describe, expect, it } from 'vitest';
import {
  DECK,
  JOKER,
  cardPower,
  effectiveSuit,
  legalPlays,
  makeCard,
  makeRng,
} from '../src/index.js';

const S = 0;
const C = 1;
const D = 2;
const H = 3;

describe('tricks', () => {
  // AC-1: bower ordering with hearts trump, ported from the oracle _self_test.
  it('orders joker > right bower > left bower > trump ace with hearts trump', () => {
    expect(cardPower(JOKER, H, S)).toBeGreaterThan(cardPower(makeCard(H, 11), H, S));
    expect(cardPower(makeCard(H, 11), H, S)).toBeGreaterThan(cardPower(makeCard(D, 11), H, S));
    expect(cardPower(makeCard(D, 11), H, S)).toBeGreaterThan(cardPower(makeCard(H, 14), H, S));
  });

  it('uses the exact oracle power constants', () => {
    expect(cardPower(JOKER, H, S)).toBe(3000);
    expect(cardPower(makeCard(H, 11), H, S)).toBe(2999); // right bower
    expect(cardPower(makeCard(D, 11), H, S)).toBe(2998); // left bower
    expect(cardPower(makeCard(H, 9), H, S)).toBe(2009); // plain trump: 2000 + rank
    expect(cardPower(makeCard(S, 14), H, S)).toBe(1014); // led suit: 1000 + rank
    expect(cardPower(makeCard(C, 14), H, S)).toBe(0); // off-suit
  });

  it('left bower follows trump, not its printed suit', () => {
    expect(effectiveSuit(makeCard(D, 11), H, D)).toBe(H);
    // The other jack of the same color as diamonds is the heart jack.
    expect(effectiveSuit(makeCard(H, 11), D, H)).toBe(D);
    // With no trump, jacks keep their printed suit.
    expect(effectiveSuit(makeCard(D, 11), null, D)).toBe(D);
  });

  it('joker is trump in trump hands and the led suit in NT-type hands', () => {
    expect(effectiveSuit(JOKER, H, S)).toBe(H);
    expect(effectiveSuit(JOKER, null, S)).toBe(S);
    // Leading in NT while holding the joker: no led suit yet.
    expect(effectiveSuit(JOKER, null, null)).toBeNull();
  });

  // AC-2: joker blocks sluffing in NT but is an ordinary trump in trump hands.
  it('forces the joker as the only follower under NT, allows sluffing under trump', () => {
    const hand = [JOKER, makeCard(C, 9)];
    expect(legalPlays(hand, null, S)).toEqual([JOKER]);
    expect(new Set(legalPlays(hand, H, S))).toEqual(new Set(hand));
  });

  it('allows sluffing when void in the led suit and holding no joker', () => {
    const hand = [makeCard(C, 9), makeCard(D, 12)];
    expect(legalPlays(hand, H, S)).toEqual(hand);
  });

  it('left bower must follow a trump lead', () => {
    const hand = [makeCard(D, 11), makeCard(S, 14)];
    expect(legalPlays(hand, H, H)).toEqual([makeCard(D, 11)]);
  });

  it('returns the whole hand when leading', () => {
    const hand = [JOKER, makeCard(S, 4), makeCard(H, 14)];
    expect(legalPlays(hand, H, null)).toEqual(hand);
    expect(legalPlays(hand, null, null)).toEqual(hand);
  });

  // AC-3: followers-else-anything over random hands vs a brute-force reference.
  it('matches a brute-force follower reference over random hands', () => {
    const rng = makeRng(0xf500);
    const trumps: (number | null)[] = [null, S, C, D, H];
    for (let trial = 0; trial < 200; trial++) {
      const deck = [...DECK];
      rng.shuffle(deck);
      const hand = deck.slice(0, 10);
      const trump = trumps[rng.int(trumps.length)] as number | null;
      const ledSuit = rng.int(4);

      const followers = hand.filter((c) => effectiveSuit(c, trump, ledSuit) === ledSuit);
      const expected = followers.length > 0 ? followers : hand;
      expect(legalPlays(hand, trump, ledSuit)).toEqual(expected);

      // Every legal play is in hand, and if any follower exists, only
      // followers are legal.
      const legal = legalPlays(hand, trump, ledSuit);
      for (const c of legal) expect(hand).toContain(c);
      if (followers.length > 0) {
        for (const c of legal) {
          expect(effectiveSuit(c, trump, ledSuit)).toBe(ledSuit);
        }
      }
    }
  });
});
