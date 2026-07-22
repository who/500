/**
 * Incremental auction state machine mirroring run_auction in the Python
 * oracle (single round per 500-house-rules.md, Bidding): exactly four calls,
 * one per player in seat order starting left of the dealer, the dealer
 * calling last. Bids climb the ladder; a player may indicate while no
 * winning bid exists. No winning bid after the fourth call means a redeal —
 * the dealer's pass in that spot IS the throw-in choice.
 */

import {
  type Bid,
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

/** One applied auction action, in table order. Same shape as Indication. */
export interface AuctionEntry {
  readonly seat: number;
  readonly bid: Bid;
}

export interface AuctionState {
  readonly ladderPos: number; // -1 until a winning bid is made
  readonly declarer: number | null;
  readonly indications: readonly Indication[];
  readonly indicated: readonly boolean[]; // one flag per seat
  /** Every action applied so far, in order — the public auction log. */
  readonly history: readonly AuctionEntry[];
  readonly turn: number;
  /** True once all four calls are in — a 5th call is illegal. */
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
    history: [],
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
 * Apply one auction action, returning the next state. Bookkeeping matches
 * the oracle exactly: an illegal or too-low bid counts as a pass, and the
 * auction is done once four calls are in regardless of what they were.
 */
export function applyAuctionAction(state: AuctionState, seat: number, action: Bid): AuctionState {
  if (state.done) throw new Error('auction is over');
  if (seat !== state.turn) throw new Error(`not seat ${seat}'s turn`);

  let { ladderPos, declarer, indications, indicated } = state;
  if (action.kind === NUM || action.kind === NULLA || action.kind === DNULLA) {
    const idx = ladderIndex(action);
    if (idx !== undefined && idx > ladderPos) {
      ladderPos = idx;
      declarer = seat;
    }
    // else: illegal/low bid treated as a pass
  } else if (action.kind === IND && mayIndicate(state, seat)) {
    indicated = indicated.map((f, i) => (i === seat ? true : f));
    indications = [...indications, { seat, bid: action }];
  }

  const history = [...state.history, { seat, bid: action }];
  return {
    ladderPos,
    declarer,
    indications,
    indicated,
    history,
    turn: (seat + 1) % 4,
    done: history.length >= 4,
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
