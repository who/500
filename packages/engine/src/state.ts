/**
 * GameState assembly — one pure state machine tying deal, auction, exchange,
 * play, and scoring together behind applyAction / legalActions /
 * redactedView / serializeGame (PRD section 3.6).
 *
 * Everything on GameState is pure JSON (no classes, Maps, or functions), so
 * states survive structured clone, WS transport, and JSON round-trips. That
 * rules out holding a live Rng closure, so the state carries `seed` plus
 * `dealsDrawn` and re-derives each deal by replaying the mulberry32 stream —
 * dealing is therefore internal: no state ever rests in the `dealing` phase.
 *
 * applyAction is a reducer returning a Result with a typed error (never
 * throwing) so the server can map invalid commands straight to protocol
 * errors. Oracle cross-checks: play_one_hand redeal loop (five_hundred.py
 * 521-531) and play_game rotation (537-555); one resolved divergence — on a
 * dead auction the oracle redeals with the same first bidder, while this
 * engine rotates the dealer (issue fh-qsk.7 resolved decision).
 */

import type { AuctionState } from './auction.js';
import { applyAuctionAction, auctionResult, initAuction, legalBids } from './auction.js';
import type { Bid } from './bids.js';
import { bidKey, bidName } from './bids.js';
import type { Card } from './cards.js';
import { JOKER } from './cards.js';
import type { Deal } from './deal.js';
import { deal } from './deal.js';
import type { ExchangePhase, ExchangeState } from './exchange.js';
import {
  declareSlam as exchangeDeclareSlam,
  discardKeeps as exchangeDiscardKeeps,
  giveCard as exchangeGiveCard,
  initExchange,
  partnerOf,
  toAct as exchangeToAct,
} from './exchange.js';
import type { PlayState, Trick, TrickPlay } from './play.js';
import { initPlay, legalPlaysFor, playCard as playPlayCard, playDone, playToAct } from './play.js';
import { makeRng } from './rng.js';
import type { GameScore, HandResult } from './scoring.js';
import { applyHandResult, initGame as initGameScore, scorePlay } from './scoring.js';

/**
 * Game phase. `dealing` is transient — nextHand (and the auto redeal) deal
 * internally and land directly in `auction`, so no returned state ever rests
 * in it; it is part of the union so consumers can model the full lifecycle.
 */
export type Phase =
  | 'dealing'
  | 'auction'
  | 'middleExchange'
  | 'slamDecision'
  | 'partnerCard'
  | 'play'
  | 'handScored'
  | 'gameOver';

/** Player commands. Every action names the seat performing it. */
export type Action =
  | { readonly type: 'bid'; readonly seat: number; readonly bid: Bid }
  | { readonly type: 'declareSlam'; readonly seat: number }
  | { readonly type: 'declineSlam'; readonly seat: number }
  | { readonly type: 'giveCard'; readonly seat: number; readonly card: Card }
  | { readonly type: 'discardKeeps'; readonly seat: number; readonly keeps: readonly Card[] }
  | {
      readonly type: 'playCard';
      readonly seat: number;
      readonly card: Card;
      /** Required exactly when leading the joker with no trump suit. */
      readonly jokerSuit?: number;
    }
  | { readonly type: 'nextHand'; readonly seat: number };

export type ActionType = Action['type'];

export type EngineErrorCode =
  | 'gameOver' // terminal state: nothing is legal
  | 'badSeat' // seat outside 0-3, or a sat-out seat trying to play
  | 'badPhase' // action type does not belong to the current phase
  | 'notYourTurn'
  | 'illegalMove'; // right actor and phase, but the move itself is illegal

export interface EngineError {
  readonly code: EngineErrorCode;
  readonly message: string;
}

export type ApplyResult =
  | { readonly ok: true; readonly state: GameState }
  | { readonly ok: false; readonly error: EngineError };

export interface GameState {
  /** RNG seed for the whole game; deals are re-derived from it on demand. */
  readonly seed: number;
  /** Deals consumed from the seed stream so far, including redeals. */
  readonly dealsDrawn: number;
  /** 0-based index of the current hand; a redeal does not advance it. */
  readonly handNumber: number;
  /** Seat that dealt this hand; bidding starts on the dealer's left. */
  readonly dealer: number;
  readonly phase: Phase;
  /** All four hands; sat-out seats keep their untouched cards. */
  readonly hands: readonly (readonly Card[])[];
  /** The 5-card middle, [] once the declarer has picked it up. */
  readonly middle: readonly Card[];
  /** Face-down discards, filled when the exchange completes. */
  readonly discards: readonly Card[];
  /** Auction record for this hand (public); kept once the auction is done. */
  readonly auction: AuctionState | null;
  readonly contract: Bid | null;
  readonly declarer: number | null;
  readonly slam: boolean;
  readonly activeSeats: readonly number[];
  /** Live exchange sub-state, null outside the exchange phases. */
  readonly exchange: ExchangeState | null;
  /** Live play sub-state, kept through handScored for the score breakdown. */
  readonly play: PlayState | null;
  /** Result of the last completed hand (handScored / gameOver). */
  readonly handResult: HandResult | null;
  readonly game: GameScore;
}

/**
 * Replay the seed stream to produce deal `index` (cheap: 45 swaps each).
 * Exported so game-log tooling can reconstruct a hand's pristine deal from
 * `(seed, dealsDrawn - 1)` after play has emptied the live hands.
 */
export function drawDeal(seed: number, index: number): Deal {
  const rng = makeRng(seed);
  let d = deal(rng);
  for (let i = 0; i < index; i++) d = deal(rng);
  return d;
}

/** Deal the next hand from the stream and open its auction. */
function enterAuction(
  seed: number,
  dealsDrawn: number,
  handNumber: number,
  dealer: number,
  game: GameScore,
): GameState {
  const d = drawDeal(seed, dealsDrawn);
  return {
    seed,
    dealsDrawn: dealsDrawn + 1,
    handNumber,
    dealer,
    phase: 'auction',
    hands: d.hands,
    middle: d.middle,
    discards: [],
    auction: initAuction((dealer + 1) % 4),
    contract: null,
    declarer: null,
    slam: false,
    activeSeats: [0, 1, 2, 3],
    exchange: null,
    play: null,
    handResult: null,
    game,
  };
}

/**
 * Start a game: deal hand 0 and enter its auction. The default dealer of
 * seat 3 puts the first bid on seat 0, matching the oracle's play_game.
 */
export function newGame(seed: number, dealer = 3): GameState {
  return enterAuction(seed >>> 0, 0, 0, ((dealer % 4) + 4) % 4, initGameScore());
}

/**
 * Test-only: enter an auction directly from a recorded deal, bypassing the
 * seed stream. The parity replayer uses this to reconstruct hands from
 * Python oracle traces; `first` is the seat that opens the auction.
 */
export function initHandFromDeal(
  hands: readonly (readonly Card[])[],
  middle: readonly Card[],
  first: number,
): GameState {
  if (hands.length !== 4 || hands.some((h) => h.length !== 10) || middle.length !== 5) {
    throw new Error('a deal is 4 hands of 10 cards plus a 5-card middle');
  }
  if (!Number.isInteger(first) || first < 0 || first > 3) {
    throw new Error(`first bidder must be a seat 0-3, got ${String(first)}`);
  }
  return {
    seed: 0,
    dealsDrawn: 0,
    handNumber: 0,
    dealer: (first + 3) % 4,
    phase: 'auction',
    hands: hands.map((h) => [...h]),
    middle: [...middle],
    discards: [],
    auction: initAuction(first),
    contract: null,
    declarer: null,
    slam: false,
    activeSeats: [0, 1, 2, 3],
    exchange: null,
    play: null,
    handResult: null,
    game: initGameScore(),
  };
}

function exchangeGamePhase(phase: ExchangePhase): Phase {
  switch (phase) {
    case 'SLAM_OFFER':
      return 'slamDecision';
    case 'GIVE_CARD':
      return 'partnerCard';
    case 'DECLARER_DISCARD':
    case 'PARTNER_DISCARD':
      return 'middleExchange';
    case 'DONE':
      throw new Error('a finished exchange has no resting game phase');
  }
}

/**
 * Seat that must act, or null when no single seat holds the turn: during
 * handScored any seat may apply nextHand, and gameOver accepts nothing.
 */
export function toActSeat(state: GameState): number | null {
  switch (state.phase) {
    case 'auction':
      return state.auction !== null && !state.auction.done ? state.auction.turn : null;
    case 'slamDecision':
    case 'partnerCard':
    case 'middleExchange':
      return state.exchange !== null ? exchangeToAct(state.exchange) : null;
    case 'play':
      return state.play !== null ? playToAct(state.play) : null;
    case 'dealing':
    case 'handScored':
    case 'gameOver':
      return null;
  }
}

/**
 * Exact legal actions for the seat, empty when it cannot act. One exception
 * to exactness: the C(15,10) keep-sets of a discard are too many to
 * enumerate, so a single template action with `keeps: []` stands for
 * "keep any 10 distinct cards you hold".
 */
export function legalActions(state: GameState, seat: number): Action[] {
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) return [];
  switch (state.phase) {
    case 'auction': {
      if (state.auction === null) return [];
      return legalBids(state.auction, seat).map((b): Action => ({ type: 'bid', seat, bid: b }));
    }
    case 'slamDecision':
      if (seat !== state.declarer) return [];
      return [
        { type: 'declareSlam', seat },
        { type: 'declineSlam', seat },
      ];
    case 'partnerCard': {
      if (state.declarer === null || seat !== partnerOf(state.declarer)) return [];
      return (state.hands[seat] ?? []).map((card): Action => ({ type: 'giveCard', seat, card }));
    }
    case 'middleExchange': {
      if (state.exchange === null || seat !== exchangeToAct(state.exchange)) return [];
      return [{ type: 'discardKeeps', seat, keeps: [] }];
    }
    case 'play': {
      const play = state.play;
      if (play === null || seat !== playToAct(play)) return [];
      const actions: Action[] = [];
      for (const card of legalPlaysFor(play, seat)) {
        if (card === JOKER && play.trump === null && play.ledSuit === null) {
          for (let s = 0; s < 4; s++) actions.push({ type: 'playCard', seat, card, jokerSuit: s });
        } else {
          actions.push({ type: 'playCard', seat, card });
        }
      }
      return actions;
    }
    case 'handScored':
      return [{ type: 'nextHand', seat }];
    case 'dealing':
    case 'gameOver':
      return [];
  }
}

function fail(code: EngineErrorCode, message: string): ApplyResult {
  return { ok: false, error: { code, message } };
}

/** Apply one action. Pure: returns the next state or a typed error. */
export function applyAction(state: GameState, action: Action): ApplyResult {
  const seat = action.seat;
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) {
    return fail('badSeat', `seat must be an integer 0-3, got ${String(seat)}`);
  }
  if (state.phase === 'gameOver') {
    return fail('gameOver', 'the game is over; no further actions are legal');
  }
  try {
    switch (action.type) {
      case 'bid':
        return applyBid(state, seat, action.bid);
      case 'declareSlam':
        return applySlamAnswer(state, seat, true);
      case 'declineSlam':
        return applySlamAnswer(state, seat, false);
      case 'giveCard':
        return applyGiveCard(state, seat, action.card);
      case 'discardKeeps':
        return applyDiscardKeeps(state, seat, action.keeps);
      case 'playCard':
        return applyPlayCard(state, seat, action.card, action.jokerSuit);
      case 'nextHand':
        return applyNextHand(state);
    }
  } catch (err) {
    // Sub-modules throw on illegal moves; surface them as typed errors.
    return fail('illegalMove', err instanceof Error ? err.message : String(err));
  }
  return fail('badPhase', `unknown action type ${String((action as { type?: unknown }).type)}`);
}

function applyBid(state: GameState, seat: number, theBid: Bid): ApplyResult {
  const auction = state.auction;
  if (state.phase !== 'auction' || auction === null) {
    return fail('badPhase', `cannot bid during ${state.phase}`);
  }
  if (seat !== auction.turn) {
    return fail('notYourTurn', `it is seat ${auction.turn}'s turn to bid, not seat ${seat}'s`);
  }
  const key = bidKey(theBid);
  if (!legalBids(auction, seat).some((b) => bidKey(b) === key)) {
    return fail('illegalMove', `${bidName(theBid)} is not a legal bid for seat ${seat}`);
  }

  const next = applyAuctionAction(auction, seat, theBid);
  if (!next.done) {
    return { ok: true, state: { ...state, auction: next } };
  }
  const result = auctionResult(next);
  if (result === null || result.contract === null || result.declarer === null) {
    // Dead auction: auto redeal, preserving game scores and rotating the
    // dealer (documented divergence from the oracle's fixed first bidder).
    return {
      ok: true,
      state: enterAuction(
        state.seed,
        state.dealsDrawn,
        state.handNumber,
        (state.dealer + 1) % 4,
        state.game,
      ),
    };
  }
  const exchange = initExchange(state.hands, state.middle, result.contract, result.declarer);
  return {
    ok: true,
    state: {
      ...state,
      phase: exchangeGamePhase(exchange.phase),
      hands: exchange.hands,
      middle: [],
      auction: next,
      contract: result.contract,
      declarer: result.declarer,
      slam: exchange.slam,
      activeSeats: exchange.activeSeats,
      exchange,
    },
  };
}

/** Fold an exchange step back into the game; entering play once it is done. */
function withExchange(state: GameState, exchange: ExchangeState): GameState {
  if (exchange.phase !== 'DONE') {
    return {
      ...state,
      phase: exchangeGamePhase(exchange.phase),
      hands: exchange.hands,
      slam: exchange.slam,
      activeSeats: exchange.activeSeats,
      exchange,
    };
  }
  const play = initPlay(exchange.hands, exchange.contract, exchange.declarer, exchange.activeSeats);
  return {
    ...state,
    phase: 'play',
    hands: play.hands,
    discards: exchange.discards,
    slam: exchange.slam,
    activeSeats: exchange.activeSeats,
    exchange: null,
    play,
  };
}

function applySlamAnswer(state: GameState, seat: number, slam: boolean): ApplyResult {
  if (state.phase !== 'slamDecision' || state.exchange === null) {
    return fail('badPhase', `no slam is on offer during ${state.phase}`);
  }
  if (seat !== state.declarer) {
    return fail('notYourTurn', `only the declarer (seat ${state.declarer}) answers the slam offer`);
  }
  return { ok: true, state: withExchange(state, exchangeDeclareSlam(state.exchange, slam)) };
}

function applyGiveCard(state: GameState, seat: number, card: Card): ApplyResult {
  if (state.phase !== 'partnerCard' || state.exchange === null) {
    return fail('badPhase', `no card is owed during ${state.phase}`);
  }
  const actor = exchangeToAct(state.exchange);
  if (seat !== actor) {
    return fail('notYourTurn', `seat ${actor} must surrender the card, not seat ${seat}`);
  }
  return { ok: true, state: withExchange(state, exchangeGiveCard(state.exchange, card)) };
}

function applyDiscardKeeps(state: GameState, seat: number, keeps: readonly Card[]): ApplyResult {
  if (state.phase !== 'middleExchange' || state.exchange === null) {
    return fail('badPhase', `no discard is due during ${state.phase}`);
  }
  const actor = exchangeToAct(state.exchange);
  if (seat !== actor) {
    return fail('notYourTurn', `seat ${actor} must discard, not seat ${seat}`);
  }
  return { ok: true, state: withExchange(state, exchangeDiscardKeeps(state.exchange, seat, keeps)) };
}

function applyPlayCard(
  state: GameState,
  seat: number,
  card: Card,
  jokerSuit?: number,
): ApplyResult {
  const current = state.play;
  if (state.phase !== 'play' || current === null) {
    return fail('badPhase', `cannot play a card during ${state.phase}`);
  }
  if (!state.activeSeats.includes(seat)) {
    return fail('badSeat', `seat ${seat} is sitting this hand out`);
  }
  const actor = playToAct(current);
  if (seat !== actor) {
    return fail('notYourTurn', `it is seat ${actor}'s turn to play, not seat ${seat}'s`);
  }
  const play = playPlayCard(current, seat, card, jokerSuit);
  if (!playDone(play)) {
    return { ok: true, state: { ...state, hands: play.hands, play } };
  }
  const handResult = scorePlay(play, state.slam);
  const game = applyHandResult(state.game, handResult);
  return {
    ok: true,
    state: { ...state, phase: 'handScored', hands: play.hands, play, handResult, game },
  };
}

function applyNextHand(state: GameState): ApplyResult {
  if (state.phase !== 'handScored') {
    return fail('badPhase', `cannot advance to the next hand during ${state.phase}`);
  }
  if (state.game.winner !== null) {
    return { ok: true, state: { ...state, phase: 'gameOver' } };
  }
  return {
    ok: true,
    state: enterAuction(
      state.seed,
      state.dealsDrawn,
      state.handNumber + 1,
      (state.dealer + 1) % 4,
      state.game,
    ),
  };
}

/** The trick in progress, as every seat may see it. */
export interface CurrentTrickView {
  readonly leader: number;
  readonly ledSuit: number | null;
  readonly plays: readonly TrickPlay[];
}

/**
 * Everything one seat may know. No card id from another hand, the middle,
 * or the discards ever appears here — only own cards and cards already
 * played to a trick, plus counts for everything hidden.
 */
export interface RedactedView {
  readonly seat: number;
  readonly phase: Phase;
  readonly handNumber: number;
  readonly dealer: number;
  /**
   * Total dead-auction redeals this game (monotonic; a redeal does not
   * advance handNumber). Clients toast a redeal by watching it increment.
   */
  readonly redeals: number;
  readonly toAct: number | null;
  /** The viewer's own cards. */
  readonly hand: readonly Card[];
  /** Cards held per seat — counts only. */
  readonly handCounts: readonly number[];
  readonly middleCount: number;
  readonly discardCount: number;
  readonly contract: Bid | null;
  readonly declarer: number | null;
  readonly slam: boolean;
  readonly activeSeats: readonly number[];
  /** The auction is fully public (it contains bids, never cards). */
  readonly auction: AuctionState | null;
  readonly trick: CurrentTrickView | null;
  /** Last completed trick, for the UI peek. */
  readonly lastTrick: Trick | null;
  /** Tricks won per side (index = seat % 2). */
  readonly sideTricks: readonly [number, number];
  readonly tricksPlayed: number;
  readonly scores: readonly [number, number];
  readonly winner: number | null;
  readonly handResult: HandResult | null;
}

/** Per-seat view of the state with all hidden cards redacted to counts. */
export function redactedView(state: GameState, seat: number): RedactedView {
  const play = state.play;
  const lastTrick =
    play !== null && play.tricks.length > 0
      ? (play.tricks[play.tricks.length - 1] ?? null)
      : null;
  return {
    seat,
    phase: state.phase,
    handNumber: state.handNumber,
    dealer: state.dealer,
    // Each hand consumes one deal; anything beyond handNumber+1 was a redeal.
    // (Test-only states from initHandFromDeal have dealsDrawn 0, hence max.)
    redeals: Math.max(0, state.dealsDrawn - state.handNumber - 1),
    toAct: toActSeat(state),
    hand: [...(state.hands[seat] ?? [])],
    handCounts: state.hands.map((h) => h.length),
    middleCount: state.middle.length,
    discardCount: state.discards.length,
    contract: state.contract,
    declarer: state.declarer,
    slam: state.slam,
    activeSeats: [...state.activeSeats],
    auction: state.auction,
    trick:
      play !== null && !playDone(play)
        ? { leader: play.leader, ledSuit: play.ledSuit, plays: play.plays }
        : null,
    lastTrick,
    sideTricks: play !== null ? play.sideTricks : [0, 0],
    tricksPlayed: play !== null ? play.tricks.length : 0,
    scores: state.game.scores,
    winner: state.game.winner,
    handResult: state.handResult,
  };
}

export const STATE_FORMAT_VERSION = 1;

/** JSON-encode a state inside a versioned envelope. */
export function serializeGame(state: GameState): string {
  return JSON.stringify({ v: STATE_FORMAT_VERSION, state });
}

/** Decode a serialized state, rejecting unknown envelope versions. */
export function deserializeGame(json: string): GameState {
  const parsed: unknown = JSON.parse(json);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    (parsed as { v?: unknown }).v !== STATE_FORMAT_VERSION ||
    typeof (parsed as { state?: unknown }).state !== 'object' ||
    (parsed as { state?: unknown }).state === null
  ) {
    throw new Error(`not a serialized game state (want envelope v${STATE_FORMAT_VERSION})`);
  }
  return (parsed as { state: GameState }).state;
}
