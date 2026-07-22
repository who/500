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

import type { Bid, Card, GameState, Indication, Rng, TrickPlay } from '@five-hundred/engine';
import { cardPower, cardSuit, trumpOf } from '@five-hundred/engine';

/**
 * What a bidder knows about the auction beyond the ladder position: its own
 * seat and every indication made so far (an indication is a signal to the
 * partner, so policies need the seat to tell partner signals from opponents').
 * `scores` is the cumulative game score per side (index = seat % 2) so a
 * policy can weigh the auction against the game state (fh-e52) — e.g. bid a
 * longshot rather than hand the opponents a game-winning contract.
 */
export interface BidContext {
  readonly seat: number;
  readonly indications: readonly Indication[];
  readonly scores: readonly [number, number];
}

export interface Policy {
  /**
   * Bid decision. ladderPos is the auction's current LADDER index (-1 while
   * no winning bid exists); mayIndicate is whether a 6-level indication is
   * still legal for this seat; context carries the auction's indications so
   * a policy can answer its partner's signal.
   */
  chooseBid(
    hand: readonly Card[],
    ladderPos: number,
    mayIndicate: boolean,
    context: BidContext,
    rng: Rng,
  ): Bid;

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

/** A play decision that may name a suit (joker led with no trump). */
export interface PlayChoice {
  readonly card: Card;
  readonly jokerSuit?: number;
}

/**
 * A policy whose play decision needs the full (unredacted) GameState — trick
 * history, hand counts, discards — rather than choosePlay's local view. The
 * Hard bot's determinized rollouts are the one implementor: sampling hidden
 * worlds requires everything the seat has observed, which the Policy
 * choosePlay signature deliberately omits. Drivers that hold a full state
 * (the sim harness, the server's worker pool) prefer this seam when present;
 * state-blind callers still get the Policy contract via choosePlay.
 */
export interface StateAwarePolicy extends Policy {
  choosePlayFromState(state: GameState, seat: number, rng: Rng): PlayChoice;
}

export function hasStatePlay(policy: Policy): policy is StateAwarePolicy {
  return typeof (policy as Partial<StateAwarePolicy>).choosePlayFromState === 'function';
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
