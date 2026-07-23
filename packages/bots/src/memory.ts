/**
 * Memory filter (fh-8jf.1) — the seeded forgetting curve that turns a seat's
 * TRUE observation history into the fuzzed view it actually plays from.
 *
 * Bots see the whole trick history and, left alone, count cards perfectly:
 * every spot card from trick one is still "seen" at trick ten, so a Hard bot
 * places the last low club with certainty a human never has. This module is
 * the one place that imperfection is modelled, and it is deliberately a pure
 * function of (history, seed, params) — no state carried between calls, no
 * mutation of engine data — so a rollout can re-derive the same remembered
 * view thousands of times inside one decision without drift.
 *
 * The curve: each card played is rolled ONCE, at hand start in effect, for a
 * retention horizon in tricks, as f(salience, suit). Salience is the card's
 * memorability — the joker, the bowers, aces and (under a trump contract)
 * every trump sit at or above `permanentSalience` and are simply never
 * forgotten; kings fade late, low spot cards fade fast. A card played to
 * trick t is remembered iff `currentTrick - t < horizon`. Because the horizon
 * is rolled from a hash of (seed, seat, card) rather than drawn from a stream,
 * it does not depend on how many times or in what order this function runs,
 * and because the age only ever grows, a forgotten card can never come back
 * mid-hand (AC-2: monotone, no flicker).
 *
 * Voids get their own, much longer horizon with a slight deep-past decay: "he
 * ruffed hearts on the second trick" is the kind of fact that sticks, but not
 * forever. A void is re-observed each time the seat fails to follow again,
 * which refreshes it — new evidence, not flicker.
 *
 * Never forgotten, whatever the roll: the seat's own remaining hand, anything
 * it knows privately (its own discards), the trick in progress, and the
 * immediately preceding trick (`graceTricks`).
 *
 * Per-seat and independent: the seed is mixed with the seat, so partners
 * forget different cards. Nothing here is shared between seats — there is no
 * table memory, which is the point of the parent epic (fh-8jf).
 */

import type { Card, GameState, TrickPlay } from '@five-hundred/engine';
import { JOKER, cardRank, effectiveSuit, makeRng, trumpOf } from '@five-hundred/engine';
import type { HardMemoryParams } from './params.js';

/** A trick as the memory filter needs it: what was led and who played what. */
export interface MemoryTrick {
  /** Effective suit led; null only for a trick in progress before the lead. */
  readonly ledSuit: number | null;
  readonly plays: readonly TrickPlay[];
}

/** One seat's true observation history — the input to the forgetting curve. */
export interface MemoryHistory {
  /** The remembering seat; its own cards and voids are never forgotten. */
  readonly seat: number;
  /** Per-seat memory seed; see {@link memorySeed}. */
  readonly seed: number;
  /** Trump suit, or null for NT / (double) nulla. */
  readonly trump: number | null;
  /** Cards the seat still holds. */
  readonly hand: readonly Card[];
  /** Other cards this seat knows privately (its own discards), if any. */
  readonly known?: readonly Card[];
  /** Completed tricks, oldest first. */
  readonly tricks: readonly MemoryTrick[];
  /** The trick in progress, or null when a trick has just completed. */
  readonly current: MemoryTrick | null;
}

/** What the seat believes it has seen. Plain data — safe to cache and reuse. */
export interface RememberedView {
  /** Remembered cards (own hand included), ascending. */
  readonly seen: readonly Card[];
  /** Remembered voids per seat 0-3, each a list of effective suits, ascending. */
  readonly voids: readonly (readonly number[])[];
}

/** Roll namespaces, so a card's horizon and a void's never share a draw. */
const KIND_CARD = 0;
const KIND_VOID = 1;

/**
 * How memorable a card is, in [0, ~1.6]. Rank ladder plus a trump bonus: the
 * suit that everyone is watching is the suit everyone remembers. At or above
 * `permanentSalience` the card is retained for the whole hand.
 */
export function cardSalience(card: Card, trump: number | null, p: HardMemoryParams): number {
  if (card === JOKER) return p.jokerSalience;
  const rank = cardRank(card) as number;
  const isTrump = trump !== null && effectiveSuit(card, trump, trump) === trump;
  let base: number;
  // Either bower — the trump jack and its same-colour twin.
  if (rank === 11 && isTrump) base = p.bowerSalience;
  else if (rank === 14) base = p.aceSalience;
  else if (rank === 13) base = p.kingSalience;
  else if (rank === 12) base = p.queenSalience;
  else if (rank === 11) base = p.jackSalience;
  else base = p.spotSalience + (rank - 4) * p.spotRankStep;
  return isTrump ? base + p.trumpBonus : base;
}

/** True for cards the seat keeps for the whole hand however old they get. */
export function isPermanent(card: Card, trump: number | null, p: HardMemoryParams): boolean {
  return cardSalience(card, trump, p) >= p.permanentSalience;
}

/**
 * Retention horizon in tricks for one played card: `base + salience * span`,
 * jittered by the card's own roll so two seats (and two spot cards of the same
 * rank) do not fade in lockstep. Floored at `graceTricks + 1` so the never-
 * forget window can never be undercut by a hostile param set.
 */
export function cardHorizon(
  card: Card,
  history: Pick<MemoryHistory, 'seat' | 'seed' | 'trump'>,
  p: HardMemoryParams,
): number {
  const salience = cardSalience(card, history.trump, p);
  if (salience >= p.permanentSalience) return Number.POSITIVE_INFINITY;
  const u = roll(history.seed, history.seat, KIND_CARD, card);
  const horizon = (p.baseHorizon + salience * p.salienceHorizon) * (1 + p.jitter * (2 * u - 1));
  return Math.max(horizon, p.graceTricks + 1);
}

/**
 * Retention horizon for one observed void. High by default (a revealed void is
 * a loud, structural fact) with a slight decay so the deepest past is not
 * perfectly reliable.
 */
export function voidHorizon(
  seat: number,
  suit: number,
  history: Pick<MemoryHistory, 'seat' | 'seed'>,
  p: HardMemoryParams,
): number {
  const u = roll(history.seed, history.seat, KIND_VOID, seat * 8 + suit);
  return Math.max(p.voidHorizon * (1 - p.voidDecay * u), p.graceTricks + 1);
}

/**
 * Apply the forgetting curve to one seat's history.
 *
 * Deterministic in (history, params): identical inputs give an identical view,
 * and as the hand advances the seen-set only shrinks (per card), so a bot that
 * has forgotten the 5 of clubs stays consistent about it for the rest of the
 * hand.
 */
export function rememberHistory(history: MemoryHistory, p: HardMemoryParams): RememberedView {
  const { trump, tricks } = history;
  // Index of the trick in progress = the number of completed tricks; a card
  // from completed trick t therefore has age `current - t` >= 1.
  const now = tricks.length;

  const seen = new Set<Card>(history.hand);
  for (const c of history.known ?? []) seen.add(c);
  for (const play of history.current?.plays ?? []) seen.add(play.card);

  const voidAt = new Map<number, number>(); // seat * 8 + suit -> latest trick seen
  const observeVoids = (trick: MemoryTrick, at: number): void => {
    if (trick.ledSuit === null) return;
    for (const play of trick.plays) {
      if (effectiveSuit(play.card, trump, trick.ledSuit) !== trick.ledSuit) {
        voidAt.set(play.seat * 8 + trick.ledSuit, at);
      }
    }
  };

  tricks.forEach((trick, t) => {
    const age = now - t;
    for (const play of trick.plays) {
      if (age <= p.graceTricks || age < cardHorizon(play.card, history, p)) seen.add(play.card);
    }
    observeVoids(trick, t);
  });
  if (history.current !== null) observeVoids(history.current, now);

  const voids: number[][] = [[], [], [], []];
  for (const [key, at] of voidAt) {
    const seat = Math.floor(key / 8);
    const suit = key % 8;
    const age = now - at;
    const remembered =
      seat === history.seat || age <= p.graceTricks || age < voidHorizon(seat, suit, history, p);
    if (remembered) (voids[seat] as number[]).push(suit);
  }

  return {
    seen: [...seen].sort((a, b) => a - b),
    voids: voids.map((s) => s.sort((a, b) => a - b)),
  };
}

/**
 * Per-seat memory seed. Mixing the hand number in gives each hand a fresh set
 * of rolls (a seat that forgot the 5C this hand is not doomed to forget it
 * every hand); mixing the seat in makes partners forget independently.
 */
export function memorySeed(baseSeed: number, handNumber: number, seat: number): number {
  return mix32(mix32(baseSeed >>> 0, handNumber >>> 0), seat >>> 0);
}

/**
 * Build one seat's history straight from a GameState, reading only what that
 * seat can legally see: its own hand, the public trick history, and the
 * discards it made itself. Callers that already hold a redacted view can build
 * {@link MemoryHistory} directly instead.
 */
export function memoryHistoryFromState(
  state: GameState,
  seat: number,
  options: { readonly seed?: number; readonly known?: readonly Card[] } = {},
): MemoryHistory {
  const play = state.play;
  const trump = state.contract !== null ? trumpOf(state.contract) : null;
  return {
    seat,
    seed: options.seed ?? memorySeed(state.seed, state.handNumber, seat),
    trump,
    hand: state.hands[seat] ?? [],
    known: options.known,
    tricks: play === null ? [] : play.tricks.map((t) => ({ ledSuit: t.ledSuit, plays: t.plays })),
    current:
      play === null || play.plays.length === 0
        ? null
        : { ledSuit: play.ledSuit, plays: play.plays },
  };
}

/** One uniform draw in [0, 1) keyed by (seed, seat, namespace, key). */
function roll(seed: number, seat: number, kind: number, key: number): number {
  return makeRng(mix32(mix32(seed >>> 0, seat * 2 + kind), key >>> 0)).random();
}

/** 32-bit avalanche mix, so adjacent keys give uncorrelated rolls. */
function mix32(a: number, b: number): number {
  let h = (a ^ Math.imul(b ^ (b >>> 16), 0x45d9f3b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
