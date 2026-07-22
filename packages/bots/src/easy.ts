/**
 * Easy bot — port of the oracle's RandomPolicy (five_hundred.py 218-238)
 * plus the PRD guardrails that keep it legal-looking without making it
 * strong (PRD 4.1: Easy is deliberately beatable):
 *
 *   (a) if the partner currently holds the trick, never beat them while a
 *       legal non-beating card exists;
 *   (b) on lose-all contracts (nulla / double nulla) prefer a card that
 *       loses the trick as it stands, when one exists;
 *   and per PRD section 10 it never bids NULLA or DNULLA and never
 *   declares a slam.
 *
 * When a guardrail cannot be satisfied legally (only winners in the legal
 * set), it falls back to uniform-random legal.
 */

import type { Bid, Card, Rng, TrickPlay } from '@five-hundred/engine';
import { IND, LADDER, PASS, bid, isLoseAll, partnerOf } from '@five-hundred/engine';
import { bestPlaySoFar, losingPlays } from './helpers.js';
import type { BidContext, PlayContext, Policy } from './policy.js';
import { defaultChooseJokerSuit, defaultGiveBestCard } from './policy.js';

export class EasyPolicy implements Policy {
  constructor(
    private readonly bidProb = 0.15,
    private readonly indicateProb = 0.05,
  ) {}

  chooseBid(
    _hand: readonly Card[],
    ladderPos: number,
    mayIndicate: boolean,
    _context: BidContext,
    rng: Rng,
  ): Bid {
    // Timid ladder step, but never onto a nulla rung: step over them so the
    // occasional raise still lands on the next NUM bid.
    let next = ladderPos + 1;
    while (next < LADDER.length && isLoseAll(LADDER[next] as Bid)) next++;
    if (next < LADDER.length && rng.random() < this.bidProb) {
      return LADDER[next] as Bid;
    }
    if (mayIndicate && rng.random() < this.indicateProb) {
      return bid(IND, 6, rng.int(5));
    }
    return bid(PASS);
  }

  chooseKeeps(cards: readonly Card[], _contract: Bid, rng: Rng): Card[] {
    const pool = [...cards];
    rng.shuffle(pool);
    return pool.slice(0, 10);
  }

  considerSlam(): boolean {
    return false; // Easy never goes solo
  }

  giveBestCard(hand: readonly Card[], contract: Bid): Card {
    return defaultGiveBestCard(hand, contract);
  }

  chooseJokerSuit(_hand: readonly Card[], _contract: Bid, rng: Rng): number {
    return defaultChooseJokerSuit(rng);
  }

  choosePlay(
    seat: number,
    _hand: readonly Card[],
    legal: readonly Card[],
    trickPlays: readonly TrickPlay[],
    trump: number | null,
    ledSuit: number | null,
    contract: Bid,
    _context: PlayContext,
    rng: Rng,
  ): Card {
    if (legal.length === 0) throw new Error('choosePlay requires a non-empty legal set');

    if (isLoseAll(contract)) {
      // Guardrail (b): duck when a losing card exists (no basis when leading).
      const losing = losingPlays(legal, trickPlays, trump, ledSuit);
      if (losing.length > 0) return losing[rng.int(losing.length)] as Card;
      return legal[rng.int(legal.length)] as Card;
    }

    // Guardrail (a): partner holds the trick — do not beat their card while
    // a non-beating legal card exists (following suit may force a winner).
    const best = bestPlaySoFar(trickPlays, trump, ledSuit);
    if (best !== null && best.seat === partnerOf(seat)) {
      const under = losingPlays(legal, trickPlays, trump, ledSuit);
      if (under.length > 0) return under[rng.int(under.length)] as Card;
    }
    return legal[rng.int(legal.length)] as Card;
  }
}
