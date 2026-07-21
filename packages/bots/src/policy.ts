/**
 * Policy — the decision interface every bot implements, mirroring the
 * Python oracle's Policy base class (five_hundred.py 192-215) typed
 * against engine types with an injected Rng.
 *
 * Policies must stay pure and synchronous: the same policy object runs in
 * the server bot driver, in the headless sim harness, and inside Hard-bot
 * rollouts as an opponent model, so nothing here may touch ambient
 * randomness, the clock, or I/O — every random draw comes from the Rng
 * argument.
 *
 * One divergence from the Python signature: choosePlay also receives the
 * acting seat, because trick plays carry seats and partner-aware guardrails
 * (Easy) and heuristics (Medium) need to know which play is the partner's.
 */

import type { Bid, Card, Rng, TrickPlay } from '@five-hundred/engine';
import { cardPower, cardSuit, trumpOf } from '@five-hundred/engine';

export interface Policy {
  /**
   * Bid decision. ladderPos is the auction's current LADDER index (-1 while
   * no winning bid exists); mayIndicate is whether a 6-level indication is
   * still legal for this seat.
   */
  chooseBid(hand: readonly Card[], ladderPos: number, mayIndicate: boolean, rng: Rng): Bid;

  /** Return exactly 10 cards to keep from 15 (or 16 after a slam). */
  chooseKeeps(cards: readonly Card[], contract: Bid, rng: Rng): Card[];

  /** Answer the one-time slam offer on a won NUM contract. */
  considerSlam(hand15: readonly Card[], contract: Bid, rng: Rng): boolean;

  /** Partner surrenders their best card for a slam. */
  giveBestCard(hand: readonly Card[], contract: Bid, rng: Rng): Card;

  /** Name a suit when leading the joker with no trump (hand excludes it). */
  chooseJokerSuit(hand: readonly Card[], contract: Bid, rng: Rng): number;

  /**
   * Pick a card from `legal`. trickPlays are the cards already played to the
   * trick in progress, in play order; ledSuit is null when leading.
   */
  choosePlay(
    seat: number,
    hand: readonly Card[],
    legal: readonly Card[],
    trickPlays: readonly TrickPlay[],
    trump: number | null,
    ledSuit: number | null,
    contract: Bid,
    rng: Rng,
  ): Card;
}

/**
 * Python base-class giveBestCard: strongest card by power, each card rated
 * as if its own suit were led (so plain suit cards rank by 1000 + rank).
 */
export function defaultGiveBestCard(hand: readonly Card[], contract: Bid): Card {
  const trump = trumpOf(contract);
  let best: Card | undefined;
  let bestPower = -1;
  for (const c of hand) {
    const power = cardPower(c, trump, cardSuit(c));
    if (power > bestPower) {
      best = c;
      bestPower = power;
    }
  }
  if (best === undefined) throw new Error('cannot give a card from an empty hand');
  return best;
}

/** Python base-class chooseJokerSuit: a uniform-random suit. */
export function defaultChooseJokerSuit(rng: Rng): number {
  return rng.int(4);
}
