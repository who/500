/**
 * Hand-strength estimation, reimplemented here (fh-sja.5) rather than imported
 * from @five-hundred/bots because the dependency runs the other way — bots
 * depends on learn, so learn may not depend back on it. The formula is a
 * byte-faithful copy of MediumPolicy.suitStrength (packages/bots/src/medium.ts
 * 181-203, itself the oracle _suit_strength, five_hundred.py 245-271); the
 * default weights below are identical to params/default.json's `suitStrength`.
 *
 * A calibration artifact records the exact weights it was fit under, so a
 * consumer bucketing a live hand reproduces the same strength value the fitter
 * saw — the fitter and the world sampler must agree on the number or the
 * priors index the wrong cells.
 */

import type { Card } from '@five-hundred/engine';
import { JOKER, NT, SAME_COLOR, cardRank, cardSuit } from '@five-hundred/engine';

/** The nine oracle _suit_strength weights, mirroring bots' SuitStrengthParams. */
export interface StrengthWeights {
  readonly joker: number;
  readonly bower: number;
  readonly trumpHonor: number;
  readonly trumpLow: number;
  readonly sideAce: number;
  readonly sideKing: number;
  readonly ntAce: number;
  readonly ntKing: number;
  readonly ntQueen: number;
}

/** Byte-identical to params/default.json `suitStrength` (the frozen defaults). */
export const DEFAULT_STRENGTH_WEIGHTS: StrengthWeights = Object.freeze({
  joker: 1.0,
  bower: 0.95,
  trumpHonor: 0.55,
  trumpLow: 0.35,
  sideAce: 0.75,
  sideKing: 0.25,
  ntAce: 0.9,
  ntKing: 0.5,
  ntQueen: 0.2,
});

/**
 * Rough expected tricks with `strain` (0..3 = trump suit, 4 = NT) as the
 * strain. A faithful copy of MediumPolicy.suitStrength: bowers, trump honours,
 * side aces/kings under a trump; aces/kings/queens under no-trump.
 */
export function suitStrength(
  hand: readonly Card[],
  strain: number,
  weights: StrengthWeights = DEFAULT_STRENGTH_WEIGHTS,
): number {
  const trump = strain !== NT ? strain : null;
  let score = 0.0;
  if (hand.includes(JOKER)) score += weights.joker;
  for (const c of hand) {
    if (c === JOKER) continue;
    const s = cardSuit(c) as number;
    const r = cardRank(c) as number;
    if (trump !== null) {
      if (r === 11 && (s === trump || s === SAME_COLOR[trump])) score += weights.bower;
      else if (s === trump) score += r >= 12 ? weights.trumpHonor : weights.trumpLow;
      else if (r === 14) score += weights.sideAce;
      else if (r === 13) score += weights.sideKing;
    } else {
      if (r === 14) score += weights.ntAce;
      else if (r === 13) score += weights.ntKing;
      else if (r === 12) score += weights.ntQueen;
    }
  }
  return score;
}

/** The strongest strain estimate for a hand — how strong it could ever bid. */
export function bestStrength(
  hand: readonly Card[],
  weights: StrengthWeights = DEFAULT_STRENGTH_WEIGHTS,
): number {
  let best = -Infinity;
  for (let s = 0; s < 5; s++) {
    const est = suitStrength(hand, s, weights);
    if (est > best) best = est;
  }
  return best;
}

/**
 * Discretise a strength estimate into a histogram bucket index. Strength runs
 * roughly 0..10; a width of {@link STRENGTH_BUCKET_WIDTH} gives ~30 cells,
 * enough resolution for the make curve without starving each cell of samples.
 * Negative estimates clamp to 0; the top is open-ended (a monster hand lands
 * in the last populated bucket for whatever the corpus produced).
 */
export const STRENGTH_BUCKET_WIDTH = 0.5;

export function strengthBucket(strength: number, width = STRENGTH_BUCKET_WIDTH): number {
  if (!Number.isFinite(strength) || strength <= 0) return 0;
  return Math.floor(strength / width);
}
