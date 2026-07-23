/**
 * Scripted game driver shared by state.spec.ts and redaction.spec.ts:
 * drives a full game through applyAction only, with a deterministic policy —
 * the hand's first bidder makes the scenario's contract bid, everyone else
 * passes, discards keep the 10 lowest held cards, and play always takes the
 * first legal action. (A DNULLA scenario needs two bidders: the first bidder
 * opens NULLA so their partner may legally answer with the double.) Every
 * reachable state is collected for the specs.
 */

import type { Action, Bid, GameState } from '../src/index.js';
import {
  DNULLA,
  NULLA,
  PASS,
  applyAction,
  bid,
  legalActions,
  newGame,
  partnerOf,
  toActSeat,
} from '../src/index.js';

export interface Scenario {
  /** Bid the first bidder of every hand makes. */
  readonly contract: Bid;
  /** Answer to the slam offer (NUM contracts only). */
  readonly slam?: boolean;
}

export interface Drive {
  readonly states: GameState[];
  readonly final: GameState;
}

export function chooseAction(state: GameState, scenario: Scenario): Action {
  const seat = toActSeat(state);
  switch (state.phase) {
    case 'auction': {
      if (seat === null || state.auction === null) throw new Error('auction without a turn');
      const firstBidder = (state.dealer + 1) % 4;
      // A double nulla is legal only for a seat whose partner already bid
      // nulla (fh-17b), so that scenario is opened by the first bidder's
      // NULLA and won by their partner two calls later.
      if (scenario.contract.kind === DNULLA) {
        if (seat === firstBidder) return { type: 'bid', seat, bid: bid(NULLA) };
        if (seat === partnerOf(firstBidder)) {
          return { type: 'bid', seat, bid: scenario.contract };
        }
        return { type: 'bid', seat, bid: bid(PASS) };
      }
      if (seat === firstBidder && state.auction.declarer === null) {
        return { type: 'bid', seat, bid: scenario.contract };
      }
      return { type: 'bid', seat, bid: bid(PASS) };
    }
    case 'slamDecision': {
      if (seat === null) throw new Error('slam offer without a declarer');
      return { type: scenario.slam ? 'declareSlam' : 'declineSlam', seat };
    }
    case 'partnerCard': {
      const card = seat !== null ? state.hands[seat]?.[0] : undefined;
      if (seat === null || card === undefined) throw new Error('no card to give');
      return { type: 'giveCard', seat, card };
    }
    case 'middleExchange': {
      const held = seat !== null ? state.hands[seat] : undefined;
      if (seat === null || held === undefined) throw new Error('no hand to discard from');
      return { type: 'discardKeeps', seat, keeps: held.slice(0, 10) };
    }
    case 'play': {
      const action = seat !== null ? legalActions(state, seat)[0] : undefined;
      if (action === undefined) throw new Error('no legal play');
      return action;
    }
    case 'handScored':
      return { type: 'nextHand', seat: 0 };
    default:
      throw new Error(`no scripted action for phase ${state.phase}`);
  }
}

/** Drive a game to gameOver, returning every state along the way. */
export function driveGame(seed: number, scenario: Scenario, maxSteps = 20_000): Drive {
  let state = newGame(seed);
  const states: GameState[] = [state];
  for (let step = 0; state.phase !== 'gameOver'; step++) {
    if (step >= maxSteps) throw new Error(`game did not terminate (stuck in ${state.phase})`);
    const action = chooseAction(state, scenario);
    const result = applyAction(state, action);
    if (!result.ok) {
      throw new Error(`${action.type} by seat ${action.seat} rejected: ${result.error.message}`);
    }
    state = result.state;
    states.push(state);
  }
  return { states, final: state };
}
