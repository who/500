/**
 * dealPattern: five packet recipes for the client deal choreography (fh-8t1).
 *
 * Each recipe is a sequence of uniform rotations. In one rotation every
 * player receives the same packet size N; the middle is either omitted or
 * appended last. N never exceeds 3. A full deal is 4×10 plus a 5-card
 * middle (45 cards). The recipe is picked once per hand from a seed mixed
 * out of public view fields — the redacted view has no game seed.
 */

import { makeRng } from '@five-hundred/engine';

/** Packet size cap: never deal more than 3 to a recipient in one packet. */
export const MAX_PACKET = 3;

/** Cards each player is owed when the deal finishes. */
export const CARDS_PER_PLAYER = 10;

/** Face-down middle (kitty) size. */
export const MIDDLE_CARDS = 5;

/** A full deal is 4×10 plus a 5-card middle = 45. */
export const DEAL_TOTAL = 45;

export interface Rotation {
  /** Cards each of the four players receives this rotation. */
  readonly n: number;
  /** Cards the middle receives this rotation (0 = omitted entirely). */
  readonly middle: number;
}

export type Recipe = readonly Rotation[];

/**
 * Five house recipes. Packet size is uniform around the four players;
 * the middle is last in a rotation that still owes it cards.
 */
export const RECIPES: readonly Recipe[] = [
  // 3 around + 3 middle; 2 around + 2 middle; then 1 around ×5
  [{ n: 3, middle: 3 }, { n: 2, middle: 2 }, ...ones(5)],
  // 2 around + 2 middle; 2 around + 2 middle; 1 around + 1 middle; then 1 around ×5
  [{ n: 2, middle: 2 }, { n: 2, middle: 2 }, { n: 1, middle: 1 }, ...ones(5)],
  // 1 around + 1 middle ×5; then 1 around ×5
  [{ n: 1, middle: 1 }, { n: 1, middle: 1 }, { n: 1, middle: 1 }, { n: 1, middle: 1 }, { n: 1, middle: 1 }, ...ones(5)],
  // 3 around; 3 around; 2 around + 2 middle; 1 around + 1 middle; 1 around + 2 middle
  [
    { n: 3, middle: 0 },
    { n: 3, middle: 0 },
    { n: 2, middle: 2 },
    { n: 1, middle: 1 },
    { n: 1, middle: 2 },
  ],
  // 2 around; 3 around + 3 middle; 2 around + 2 middle; then 1 around ×3
  [{ n: 2, middle: 0 }, { n: 3, middle: 3 }, { n: 2, middle: 2 }, ...ones(3)],
];

function ones(count: number): Rotation[] {
  return Array.from({ length: count }, () => ({ n: 1, middle: 0 }));
}

export type DealDest = { readonly kind: 'seat'; readonly seat: number } | { readonly kind: 'middle' };

export interface Packet {
  readonly dest: DealDest;
  readonly count: number;
}

/** Left of dealer, then clockwise: LHO, partner, RHO, dealer. */
export function clockwiseFromDealer(dealer: number): readonly number[] {
  return [(dealer + 1) % 4, (dealer + 2) % 4, (dealer + 3) % 4, dealer];
}

/** Expand a recipe into sequential packets; middle is last in each rotation that includes it. */
export function expandPackets(recipe: Recipe, dealer: number): Packet[] {
  const order = clockwiseFromDealer(dealer);
  const packets: Packet[] = [];
  for (const rot of recipe) {
    for (const seat of order) {
      packets.push({ dest: { kind: 'seat', seat }, count: rot.n });
    }
    if (rot.middle > 0) {
      packets.push({ dest: { kind: 'middle' }, count: rot.middle });
    }
  }
  return packets;
}

/** Mix public view fields into a 32-bit seed (no server seed on the redacted view). */
export function dealSeed(handNumber: number, redeals: number, dealer: number): number {
  return (((handNumber + 1) * 0x9e3779b9) ^ ((redeals + 1) * 0x85ebca6b) ^ ((dealer + 1) * 0xc2b2ae35)) >>> 0;
}

export function pickRecipeIndex(seed: number): number {
  return seed % RECIPES.length;
}

export function pickRecipe(seed: number): Recipe {
  return RECIPES[pickRecipeIndex(seed)] as Recipe;
}

export interface CardJitter {
  /** Signed rotation in degrees, magnitude in [8, 15]. */
  readonly rotate: number;
  /** Extra start delay in ms so two packets are not clones. */
  readonly delay: number;
  /** Lateral arc offset in px at mid-flight. */
  readonly arc: number;
}

/** Deterministic per-card variance from (seed, packet, card index). */
export function cardJitter(seed: number, packet: number, card: number): CardJitter {
  const rng = makeRng((seed ^ Math.imul(packet + 1, 0x9e3779b9) ^ Math.imul(card + 1, 0x85ebca6b)) >>> 0);
  const mag = 8 + rng.random() * 7;
  const sign = rng.random() < 0.5 ? -1 : 1;
  return {
    rotate: sign * mag,
    delay: rng.random() * 40,
    arc: (rng.random() - 0.5) * 24,
  };
}

/**
 * Totals for a recipe. `max` is the largest packet size (players or middle);
 * it must stay ≤ 3 and the card count must be 45.
 */
export function recipeTotals(recipe: Recipe): { total: number; max: number; perPlayer: number; middle: number } {
  let total = 0;
  let max = 0;
  let perPlayer = 0;
  let middle = 0;
  for (const rot of recipe) {
    if (rot.n > max) max = rot.n;
    if (rot.middle > max) max = rot.middle;
    total += rot.n * 4 + rot.middle;
    perPlayer += rot.n;
    middle += rot.middle;
  }
  return { total, max, perPlayer, middle };
}
