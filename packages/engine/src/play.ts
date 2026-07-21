/**
 * Trick play phase — action-driven port of the play_hand trick loop
 * (five_hundred.py 472-491). The oracle plays all 10 tricks inside one
 * closed function; here each card is a discrete playCard action so humans
 * can act at each step:
 *
 *   - The declarer leads trick 1 (documented oracle assumption, line 471).
 *   - Seats rotate over activeSeats only; a sat-out partner never acts.
 *   - Leading the joker when trump is null (NT, nulla, dnulla) requires the
 *     leader to name a suit via jokerSuit; a joker played to a trick that is
 *     already led silently assumes the led suit through effectiveSuit.
 *   - The trick winner is the highest cardPower and leads the next trick.
 *
 * All 10 completed tricks are retained on the state for the last-trick UI
 * peek and for parity assertions against the oracle.
 */

import type { Bid } from './bids.js';
import { trumpOf } from './bids.js';
import type { Card } from './cards.js';
import { JOKER, cardName } from './cards.js';
import { cardPower, effectiveSuit, legalPlays } from './tricks.js';

export interface TrickPlay {
  readonly seat: number;
  readonly card: Card;
}

export interface Trick {
  readonly leader: number;
  readonly ledSuit: number;
  readonly plays: readonly TrickPlay[];
  readonly winner: number;
}

export interface PlayState {
  readonly contract: Bid;
  readonly declarer: number;
  readonly trump: number | null;
  readonly activeSeats: readonly number[];
  /** All four hands; sit-out seats keep their untouched cards. */
  readonly hands: readonly (readonly Card[])[];
  /** Leader of the trick in progress. */
  readonly leader: number;
  /** Effective suit led to the trick in progress, null before the lead. */
  readonly ledSuit: number | null;
  /** Cards played to the trick in progress, in seat order from the leader. */
  readonly plays: readonly TrickPlay[];
  /** Completed tricks, oldest first; play is done after 10. */
  readonly tricks: readonly Trick[];
  /** Tricks won per side (index = seat % 2). */
  readonly sideTricks: readonly [number, number];
}

/** Enter play from a finished exchange: the declarer leads trick 1. */
export function initPlay(
  hands: readonly (readonly Card[])[],
  contract: Bid,
  declarer: number,
  activeSeats: readonly number[],
): PlayState {
  for (const s of activeSeats) {
    if (hands[s]?.length !== 10) {
      throw new Error(`seat ${s} must start play with 10 cards`);
    }
  }
  if (!activeSeats.includes(declarer)) {
    throw new Error('declarer must be an active seat');
  }
  return {
    contract,
    declarer,
    trump: trumpOf(contract),
    activeSeats,
    hands: hands.map((h) => [...h]),
    leader: declarer,
    ledSuit: null,
    plays: [],
    tricks: [],
    sideTricks: [0, 0],
  };
}

/** Active seats in play order for the trick in progress (leader first). */
export function trickOrder(state: PlayState): number[] {
  const i = state.activeSeats.indexOf(state.leader);
  return [...state.activeSeats.slice(i), ...state.activeSeats.slice(0, i)];
}

/** Seat that must play next, or null once all 10 tricks are done. */
export function playToAct(state: PlayState): number | null {
  if (playDone(state)) return null;
  return trickOrder(state)[state.plays.length] ?? null;
}

export function playDone(state: PlayState): boolean {
  return state.tricks.length === 10;
}

/** Legal cards for the acting seat (mirrors legal_plays over the led suit). */
export function legalPlaysFor(state: PlayState, seat: number): Card[] {
  return legalPlays(state.hands[seat] ?? [], state.trump, state.ledSuit);
}

/**
 * Play a card for the acting seat. jokerSuit is required exactly when the
 * card is the joker, it leads the trick, and trump is null — the one case
 * where the oracle asks its policy to name a suit (five_hundred.py 483-487).
 */
export function playCard(
  state: PlayState,
  seat: number,
  card: Card,
  jokerSuit?: number,
): PlayState {
  const actor = playToAct(state);
  if (actor === null) throw new Error('play is over');
  if (seat !== actor) throw new Error(`not seat ${seat}'s turn`);
  if (!legalPlaysFor(state, seat).includes(card)) {
    throw new Error(`${cardName(card)} is not a legal play for seat ${seat}`);
  }

  const namesSuit = state.ledSuit === null && card === JOKER && state.trump === null;
  if (namesSuit) {
    if (jokerSuit === undefined) throw new Error('leading the joker requires jokerSuit');
    if (!Number.isInteger(jokerSuit) || jokerSuit < 0 || jokerSuit > 3) {
      throw new Error(`jokerSuit must be a suit index 0-3, got ${jokerSuit}`);
    }
  } else if (jokerSuit !== undefined) {
    throw new Error('jokerSuit is only allowed when leading the joker with no trump');
  }

  const ledSuit =
    state.ledSuit !== null
      ? state.ledSuit
      : namesSuit
        ? (jokerSuit as number)
        : (effectiveSuit(card, state.trump, null) as number);
  const hands = state.hands.map((h, s) => (s === seat ? h.filter((c) => c !== card) : h));
  const plays = [...state.plays, { seat, card }];

  if (plays.length < state.activeSeats.length) {
    return { ...state, hands, ledSuit, plays };
  }

  // Trick complete: highest power wins and leads the next trick. The first
  // strict max mirrors Python's max(); powers can only tie at 0, and the
  // leader's card is always above 0, so the winner is unambiguous.
  let winner = plays[0]!;
  for (const p of plays) {
    if (cardPower(p.card, state.trump, ledSuit) > cardPower(winner.card, state.trump, ledSuit)) {
      winner = p;
    }
  }
  const w = winner.seat % 2;
  const sideTricks: [number, number] = [
    state.sideTricks[0] + (w === 0 ? 1 : 0),
    state.sideTricks[1] + (w === 1 ? 1 : 0),
  ];
  return {
    ...state,
    hands,
    leader: winner.seat,
    ledSuit: null,
    plays: [],
    tricks: [...state.tricks, { leader: state.leader, ledSuit, plays, winner: winner.seat }],
    sideTricks,
  };
}
