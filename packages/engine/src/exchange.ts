/**
 * Exchange (middle pickup) phase — action-driven port of _exchange_middle
 * (five_hundred.py 430-462). The oracle runs the whole exchange inside one
 * closed function; here it is split into discrete actions so humans can act
 * at each step:
 *
 *   NUM    declarer picks up the middle (15), is offered a slam exactly once
 *          (declareSlam), then keeps 10 (discardKeeps). On a slam the partner
 *          must first surrender their best card (giveCard), the declarer keeps
 *          10 from 16, and the partner sits out (solo).
 *   NULLA  declarer picks up the middle (15) and keeps 10; the partner sits
 *          out. No slam is offered.
 *   DNULLA declarer picks up the middle (15) and keeps 10; the exact 5
 *          discards travel to the partner, who then holds 15 and keeps 10.
 *          All four seats stay active. No slam is offered.
 *
 * After the exchange every active seat holds exactly 10 cards.
 */

import type { Bid } from './bids.js';
import { DNULLA, NULLA, NUM } from './bids.js';
import type { Card } from './cards.js';
import { cardName } from './cards.js';

export type ExchangePhase =
  | 'SLAM_OFFER' // declarer answers the one-time slam offer (NUM only)
  | 'GIVE_CARD' // partner surrenders their best card after a slam
  | 'DECLARER_DISCARD' // declarer keeps 10 via discardKeeps
  | 'PARTNER_DISCARD' // DNULLA partner keeps 10 from the passed-through 15
  | 'DONE';

export interface ExchangeState {
  readonly contract: Bid;
  readonly declarer: number;
  readonly phase: ExchangePhase;
  /** All four hands; sit-out seats keep their cards (activeSeats marks them). */
  readonly hands: readonly (readonly Card[])[];
  readonly slam: boolean;
  /**
   * Face-down middle discards, filled when the exchange completes. Stored
   * (not shown in redacted views) because the slam extra card is folded back
   * into this pile per the rules doc.
   */
  readonly discards: readonly Card[];
  /** The 5 cards travelling declarer -> partner in DNULLA, null otherwise. */
  readonly passed: readonly Card[] | null;
  readonly activeSeats: readonly number[];
}

export interface ExchangeResult {
  readonly activeSeats: readonly number[];
  readonly slam: boolean;
  readonly discards: readonly Card[];
}

export function partnerOf(seat: number): number {
  return (seat + 2) % 4;
}

/** Enter the exchange from an auction result: declarer picks up the middle. */
export function initExchange(
  hands: readonly (readonly Card[])[],
  middle: readonly Card[],
  contract: Bid,
  declarer: number,
): ExchangeState {
  if (contract.kind !== NUM && contract.kind !== NULLA && contract.kind !== DNULLA) {
    throw new Error(`${contract.kind} is not a playable contract`);
  }
  const partner = partnerOf(declarer);
  const next = hands.map((h, s) =>
    s === declarer ? [...h, ...middle].sort((a, b) => a - b) : [...h],
  );
  return {
    contract,
    declarer,
    phase: contract.kind === NUM ? 'SLAM_OFFER' : 'DECLARER_DISCARD',
    hands: next,
    slam: false,
    discards: [],
    passed: null,
    activeSeats:
      contract.kind === NULLA
        ? [0, 1, 2, 3].filter((s) => s !== partner) // partner sits out
        : [0, 1, 2, 3],
  };
}

/** Seat that must act next, or null once the exchange is done. */
export function toAct(state: ExchangeState): number | null {
  switch (state.phase) {
    case 'SLAM_OFFER':
    case 'DECLARER_DISCARD':
      return state.declarer;
    case 'GIVE_CARD':
    case 'PARTNER_DISCARD':
      return partnerOf(state.declarer);
    case 'DONE':
      return null;
  }
}

/** Answer the one-time slam offer. Declining moves straight to the discard. */
export function declareSlam(state: ExchangeState, slam: boolean): ExchangeState {
  if (state.phase !== 'SLAM_OFFER') throw new Error('slam is not on offer');
  if (!slam) return { ...state, phase: 'DECLARER_DISCARD' };
  const partner = partnerOf(state.declarer);
  return {
    ...state,
    slam: true,
    phase: 'GIVE_CARD',
    activeSeats: state.activeSeats.filter((s) => s !== partner), // solo
  };
}

/** Partner surrenders their best card to the slamming declarer (16 held). */
export function giveCard(state: ExchangeState, card: Card): ExchangeState {
  if (state.phase !== 'GIVE_CARD') throw new Error('no card is owed');
  const partner = partnerOf(state.declarer);
  if (!state.hands[partner]?.includes(card)) {
    throw new Error(`cannot give ${cardName(card)}: not in partner hand`);
  }
  const hands = state.hands.map((h, s) => {
    if (s === partner) return h.filter((c) => c !== card);
    if (s === state.declarer) return [...h, card].sort((a, b) => a - b);
    return h;
  });
  return { ...state, hands, phase: 'DECLARER_DISCARD' };
}

/**
 * Keep exactly 10 of the held cards and discard the rest. In DNULLA the
 * declarer's discards travel on to the partner instead of leaving play.
 */
export function discardKeeps(
  state: ExchangeState,
  seat: number,
  keeps: readonly Card[],
): ExchangeState {
  if (state.phase !== 'DECLARER_DISCARD' && state.phase !== 'PARTNER_DISCARD') {
    throw new Error('no discard is due');
  }
  if (seat !== toAct(state)) throw new Error(`not seat ${seat}'s discard`);
  const held = state.hands[seat] ?? [];
  const keepSet = new Set(keeps);
  if (keeps.length !== 10 || keepSet.size !== 10) {
    throw new Error('must keep exactly 10 distinct cards');
  }
  for (const c of keeps) {
    if (!held.includes(c)) throw new Error(`cannot keep ${cardName(c)}: not held`);
  }
  const discards = held.filter((c) => !keepSet.has(c));
  const hands = state.hands.map((h, s) => (s === seat ? [...keeps].sort((a, b) => a - b) : h));

  if (state.phase === 'DECLARER_DISCARD' && state.contract.kind === DNULLA) {
    const partner = partnerOf(state.declarer);
    const passedOn = hands.map((h, s) =>
      s === partner ? [...h, ...discards].sort((a, b) => a - b) : h,
    );
    return { ...state, hands: passedOn, passed: discards, phase: 'PARTNER_DISCARD' };
  }

  // mirror of the oracle's closing assert (five_hundred.py 461)
  for (const s of state.activeSeats) {
    if (hands[s]?.length !== 10) throw new Error('keeps must total 10');
  }
  return { ...state, hands, discards, phase: 'DONE' };
}

/** Terminal outcome of a finished exchange, or null while it is running. */
export function exchangeResult(state: ExchangeState): ExchangeResult | null {
  if (state.phase !== 'DONE') return null;
  return { activeSeats: state.activeSeats, slam: state.slam, discards: state.discards };
}
