/**
 * HardPolicy — the assembled Hard bot (PRD 4.3): rollout bidding and slam
 * (fh-7hw.3), rollout keeps (fh-7hw.2), and rollout card play (this leaf),
 * over the constrained world sampler (fh-7hw.1). The API is synchronous and
 * pure given the injected Rng, exactly like Easy/Medium, so the headless sim
 * harness drives it unchanged; the server never calls it on the event loop —
 * the fh-7hw.4 worker pool runs it inside a worker thread with a wall-clock
 * play budget wired through `play.deadlineMs`.
 *
 * Card play needs the full GameState (trick history and observed voids feed
 * the world sampler), which the Policy choosePlay signature cannot carry, so
 * HardPolicy implements the StateAwarePolicy seam: state-holding drivers use
 * choosePlayFromState, while the state-blind choosePlay path degrades to the
 * Medium heuristic (it has nothing to determinize from).
 *
 * giveBestCard keeps the oracle base-class rule and chooseJokerSuit keeps
 * Medium's shortest-suit rule — both are single-card heuristics the packet
 * leaves out of rollout scope, and the play rollout evaluates joker leads
 * with the same suit rule so the searched line is the played line.
 */

import type { Bid, Card, GameState, Rng, TrickPlay } from '@five-hundred/engine';
import { JOKER } from '@five-hundred/engine';
import { MediumPolicy } from '../medium.js';
import type { PlayChoice, StateAwarePolicy } from '../policy.js';
import { defaultGiveBestCard } from '../policy.js';
import { chooseBidByRollout, considerSlamByRollout } from './bidding.js';
import { chooseKeepsByRollout } from './keeps.js';
import type { HardPlayOptions } from './play.js';
import { choosePlayByRollout } from './play.js';

export interface HardPolicyOptions {
  /** Worlds per bid / slam decision; defaults to ROLLOUT_WORLDS. */
  readonly bidWorlds?: number;
  /** Worlds per keep decision; defaults to KEEP_WORLDS. */
  readonly keepWorlds?: number;
  /** Card-play rollout config (fixed worlds or a wall-clock deadline). */
  readonly play?: HardPlayOptions;
}

const ascending = (a: Card, b: Card): number => a - b;

export class HardPolicy implements StateAwarePolicy {
  private readonly medium = new MediumPolicy();

  constructor(private readonly options: HardPolicyOptions = {}) {}

  chooseBid(hand: readonly Card[], ladderPos: number, mayIndicate: boolean, rng: Rng): Bid {
    return chooseBidByRollout(hand, ladderPos, mayIndicate, rng, {
      worlds: this.options.bidWorlds,
    });
  }

  chooseKeeps(cards: readonly Card[], contract: Bid, rng: Rng): Card[] {
    return chooseKeepsByRollout(cards, contract, rng, { worlds: this.options.keepWorlds });
  }

  considerSlam(hand15: readonly Card[], contract: Bid, rng: Rng): boolean {
    return considerSlamByRollout(hand15, contract, rng, { worlds: this.options.bidWorlds });
  }

  giveBestCard(hand: readonly Card[], contract: Bid): Card {
    return defaultGiveBestCard([...hand].sort(ascending), contract);
  }

  chooseJokerSuit(hand: readonly Card[]): number {
    return this.medium.chooseJokerSuit(hand);
  }

  /**
   * State-blind Policy path: without a GameState there is no world to sample,
   * so play like Medium. Real Hard play enters through choosePlayFromState.
   */
  choosePlay(
    seat: number,
    hand: readonly Card[],
    legal: readonly Card[],
    trickPlays: readonly TrickPlay[],
    trump: number | null,
    ledSuit: number | null,
    contract: Bid,
  ): Card {
    return this.medium.choosePlay(seat, hand, legal, trickPlays, trump, ledSuit, contract);
  }

  choosePlayFromState(state: GameState, seat: number, rng: Rng): PlayChoice {
    const card = choosePlayByRollout(state, seat, rng, this.options.play);
    const play = state.play;
    if (
      play !== null &&
      card === JOKER &&
      play.trump === null &&
      play.ledSuit === null
    ) {
      const rest = (play.hands[seat] ?? []).filter((c) => c !== JOKER);
      return { card, jokerSuit: this.chooseJokerSuit(rest) };
    }
    return { card };
  }
}
