/**
 * The learn-side strength copy must agree with the bots MediumPolicy formula
 * (fh-sja.5): the fitter and the world sampler both bucket on this number, and
 * it must reproduce the oracle _suit_strength weights byte-for-byte.
 */

import { describe, expect, it } from 'vitest';
import { JOKER } from '@five-hundred/engine';
import {
  DEFAULT_STRENGTH_WEIGHTS,
  bestStrength,
  strengthBucket,
  suitStrength,
} from './strength.js';

// Engine card id = suit*11 + (rank-4); rank 14=ace ... 11=jack. Suit 0=spades.
const card = (suit: number, rank: number): number => suit * 11 + (rank - 4);

describe('suitStrength', () => {
  it('scores the joker as one guaranteed trick regardless of strain', () => {
    expect(suitStrength([JOKER], 0)).toBeCloseTo(DEFAULT_STRENGTH_WEIGHTS.joker);
    expect(suitStrength([JOKER], 4)).toBeCloseTo(DEFAULT_STRENGTH_WEIGHTS.joker);
  });

  it('scores a trump ace as a trump honour, a side ace as a side ace', () => {
    const trumpAce = suitStrength([card(0, 14)], 0); // spades trump, spade ace
    const sideAce = suitStrength([card(1, 14)], 0); // spades trump, club ace
    expect(trumpAce).toBeCloseTo(DEFAULT_STRENGTH_WEIGHTS.trumpHonor);
    expect(sideAce).toBeCloseTo(DEFAULT_STRENGTH_WEIGHTS.sideAce);
  });

  it('scores the left bower as a bower under its trump', () => {
    // Jack of clubs (suit 1) is the left bower when spades (suit 0) is trump.
    expect(suitStrength([card(1, 11)], 0)).toBeCloseTo(DEFAULT_STRENGTH_WEIGHTS.bower);
  });

  it('scores no-trump honours only under NT', () => {
    const ntAce = suitStrength([card(2, 14)], 4);
    expect(ntAce).toBeCloseTo(DEFAULT_STRENGTH_WEIGHTS.ntAce);
  });
});

describe('bestStrength', () => {
  it('is the max over all five strains', () => {
    const hand = [card(0, 14), card(0, 13), card(0, 12)]; // strong in spades
    expect(bestStrength(hand)).toBeGreaterThanOrEqual(suitStrength(hand, 1));
    expect(bestStrength(hand)).toBe(
      Math.max(...[0, 1, 2, 3, 4].map((s) => suitStrength(hand, s))),
    );
  });
});

describe('strengthBucket', () => {
  it('clamps non-positive strength to bucket 0 and grows with width', () => {
    expect(strengthBucket(-1)).toBe(0);
    expect(strengthBucket(0)).toBe(0);
    expect(strengthBucket(0.4, 0.5)).toBe(0);
    expect(strengthBucket(0.6, 0.5)).toBe(1);
    expect(strengthBucket(2.0, 0.5)).toBe(4);
  });
});
