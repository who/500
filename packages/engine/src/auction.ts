/**
 * Incremental auction state machine mirroring run_auction in the Python
 * oracle (five_hundred.py 384-411): bids climb the ladder, each player may
 * indicate once while no winning bid exists, and the auction ends after
 * 3 consecutive quiet actions with a declarer or 4 without one (redeal).
 */

import {
  Bid,
  DNULLA,
  IND,
  LADDER,
  NULLA,
  NUM,
  PASS,
  bid,
  ladderIndex,
} from './bids.js';

export interface Indication {
  readonly seat: number;
  readonly bid: Bid;
}

export interface AuctionState {
  readonly ladderPos: number; // -1 until a winning bid is made
  readonly declarer: number | null;
  readonly indications: readonly Indication[];
  readonly indicated: readonly boolean[]; // one flag per seat
  readonly consecutiveQuiet: number;
  readonly turn: number;
  readonly done: boolean;
}

export interface AuctionResult {
  readonly contract: Bid | null; // null => redeal
  readonly declarer: number | null;
  readonly indications: readonly Indication[];
}

export function initAuction(first: number): AuctionState {
  return {
    ladderPos: -1,
    declarer: null,
    indications: [],
    indicated: [false, false, false, false],
    consecutiveQuiet: 0,
    turn: first,
    done: false,
  };
}

function mayIndicate(state: AuctionState, seat: number): boolean {
  return state.declarer === null && !state.indicated[seat];
}

/**
 * Bids the seat may legally make right now: every ladder bid strictly above
 * ladderPos, an indication in each strain while indicating is allowed, and
 * PASS. Empty when the auction is over or it is not the seat's turn.
 */
export function legalBids(state: AuctionState, seat: number): Bid[] {
  if (state.done || seat !== state.turn) return [];
  const legal: Bid[] = LADDER.slice(state.ladderPos + 1);
  if (mayIndicate(state, seat)) {
    for (let s = 0; s < 5; s++) legal.push(bid(IND, 6, s));
  }
  legal.push(bid(PASS));
  return legal;
}

/**
 * Apply one auction action, returning the next state. Quiet-count
 * bookkeeping matches the oracle exactly: an illegal or too-low bid counts
 * as a pass, and an indication resets the quiet count just like a winning
 * bid does.
 */
export function applyAuctionAction(state: AuctionState, seat: number, action: Bid): AuctionState {
  if (state.done) throw new Error('auction is over');
  if (seat !== state.turn) throw new Error(`not seat ${seat}'s turn`);

  let { ladderPos, declarer, indications, indicated, consecutiveQuiet } = state;
  if (action.kind === NUM || action.kind === NULLA || action.kind === DNULLA) {
    const idx = ladderIndex(action);
    if (idx !== undefined && idx > ladderPos) {
      ladderPos = idx;
      declarer = seat;
      consecutiveQuiet = 0;
    } else {
      consecutiveQuiet += 1; // illegal/low bid treated as a pass
    }
  } else if (action.kind === IND && mayIndicate(state, seat)) {
    indicated = indicated.map((f, i) => (i === seat ? true : f));
    indications = [...indications, { seat, bid: action }];
    consecutiveQuiet = 0; // an indication keeps the auction alive
  } else {
    consecutiveQuiet += 1;
  }

  const done =
    (declarer !== null && consecutiveQuiet >= 3) ||
    (declarer === null && consecutiveQuiet >= 4);
  return {
    ladderPos,
    declarer,
    indications,
    indicated,
    consecutiveQuiet,
    turn: (seat + 1) % 4,
    done,
  };
}

/** Terminal outcome of a finished auction, or null while it is running. */
export function auctionResult(state: AuctionState): AuctionResult | null {
  if (!state.done) return null;
  return {
    contract: state.declarer !== null ? (LADDER[state.ladderPos] as Bid) : null,
    declarer: state.declarer,
    indications: state.indications,
  };
}
