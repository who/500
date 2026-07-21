/**
 * Hard-bot determinization core (PRD 4.3) — sample complete deals of the
 * unseen cards to hidden seats, uniformly at random but consistent with
 * everything the viewing seat has observed: cards already played, revealed
 * voids (a seat that failed to follow the led effective suit holds none of
 * it), hand sizes, and exchange knowledge (a declarer who absorbed the
 * middle knows the discards; the double-nulla partner knows the 5 passed
 * cards).
 *
 * Extends the oracle's evaluate_keeps unseen-card dealing (five_hundred.py
 * 597-615: unseen = DECK minus my 15, shuffle, slice to the other seats)
 * with the play-phase constraints above. Two-stage sampler: rejection
 * sampling first — a plain shuffle is exactly uniform over consistent
 * worlds — then a constructive fallback (most-constrained cards placed
 * first into capacity-weighted destinations) so pathological constraint
 * sets still terminate; CONSTRUCT_TRIES failures throw, because an
 * unsatisfiable constraint set means the extraction is buggy, not that a
 * fallback should paper over it.
 *
 * Everything here is pure given (constraints, rng) and plain JSON data —
 * no Maps or classes cross the interface — so the sampler runs identically
 * in worker threads and the main thread and never mutates engine state.
 *
 * Known gap (PLAN-GAP, recorded on the state-assembly issue): once a
 * double-nulla exchange completes, the engine drops ExchangeState.passed,
 * so during play the declarer's knowledge that the 5 passed cards sit with
 * the partner or the discards is not derivable from GameState. While the
 * exchange is still live (partner-discard phase) the constraint is
 * extracted; consumers with side knowledge can also append to `restricted`
 * before sampling.
 */

import type { Card, GameState, Rng } from '@five-hundred/engine';
import { DECK, DNULLA, effectiveSuit, partnerOf, trumpOf } from '@five-hundred/engine';

/** One hidden seat the sampler must deal a hand to. */
export interface HiddenSeat {
  readonly seat: number;
  /** Cards the seat currently holds (its public hand count). */
  readonly count: number;
  /** Effective suits the seat has been observed void in. */
  readonly voidSuits: readonly number[];
}

/** A card that may only sit with some seats; the dead pool is always allowed. */
export interface CardRestriction {
  readonly card: Card;
  readonly seats: readonly number[];
}

/** Everything one seat knows about where the unseen cards may be. */
export interface ObservedConstraints {
  readonly viewer: number;
  readonly trump: number | null;
  /** Location-unknown cards, ascending. Cards beyond the seat counts are dead. */
  readonly unseen: readonly Card[];
  readonly seats: readonly HiddenSeat[];
  readonly restricted: readonly CardRestriction[];
}

/** One sampled world: full hands for the hidden seats, rest to the dead pool. */
export interface SampledWorld {
  /** Hand per seat, ascending; null for the viewer and undealt (sat-out) seats. */
  readonly hands: readonly (readonly Card[] | null)[];
  /** Unseen cards dealt to no hidden seat: discards, middle, sat-out hands. */
  readonly dead: readonly Card[];
}

/**
 * Whether a card belongs to `suit` for following purposes — the void-suit
 * membership test. Mirrors legal_plays semantics exactly: under a trump
 * contract the joker and left bower count as trump (a trump-void seat holds
 * neither), and with no trump the joker follows every suit (a seat void in
 * anything cannot hold it).
 */
export function countsAsSuit(card: Card, suit: number, trump: number | null): boolean {
  return effectiveSuit(card, trump, suit) === suit;
}

/**
 * Extract the viewing seat's constraints from a full GameState, reading only
 * seat-visible information: the own hand, the public trick history, public
 * hand counts and active seats, plus discards/passed cards when the viewer
 * is the seat that saw them.
 */
export function deriveConstraints(state: GameState, viewer: number): ObservedConstraints {
  if (!Number.isInteger(viewer) || viewer < 0 || viewer > 3) {
    throw new Error(`viewer must be a seat 0-3, got ${String(viewer)}`);
  }
  if (state.phase === 'dealing' || state.phase === 'handScored' || state.phase === 'gameOver') {
    throw new Error(`no hidden world to sample during ${state.phase}`);
  }
  const trump = state.contract !== null ? trumpOf(state.contract) : null;

  const seen = new Set<Card>(state.hands[viewer]);
  const play = state.play;
  if (play !== null) {
    for (const t of play.tricks) for (const p of t.plays) seen.add(p.card);
    for (const p of play.plays) seen.add(p.card);
  }
  // Discards are known to whoever made them: the declarer, except in double
  // nulla where the pile that survives is the partner's second discard.
  if (state.declarer !== null && state.discards.length > 0) {
    const owner =
      state.contract?.kind === DNULLA ? partnerOf(state.declarer) : state.declarer;
    if (viewer === owner) for (const c of state.discards) seen.add(c);
  }

  // Voids from failure to follow, over completed tricks and the one in
  // progress. Monotone: a seat out of an effective suit never regains it.
  const voids: Set<number>[] = [new Set(), new Set(), new Set(), new Set()];
  if (play !== null) {
    const tricks: { ledSuit: number; plays: readonly { seat: number; card: Card }[] }[] =
      play.tricks.map((t) => ({ ledSuit: t.ledSuit, plays: t.plays }));
    if (play.ledSuit !== null && play.plays.length > 0) {
      tricks.push({ ledSuit: play.ledSuit, plays: play.plays });
    }
    for (const t of tricks) {
      for (const p of t.plays) {
        if (p.seat !== viewer && !countsAsSuit(p.card, t.ledSuit, trump)) {
          (voids[p.seat] as Set<number>).add(t.ledSuit);
        }
      }
    }
  }

  // Sat-out seats are not in activeSeats: their untouched cards are never
  // dealt and fall through to the dead pool.
  const seats: HiddenSeat[] = state.activeSeats
    .filter((s) => s !== viewer)
    .map((seat) => ({
      seat,
      count: (state.hands[seat] ?? []).length,
      voidSuits: [...(voids[seat] as Set<number>)].sort((a, b) => a - b),
    }));

  // Double nulla, partner still discarding: the declarer knows the 5 cards
  // just passed are in the partner's 15. (Dropped by the engine once the
  // exchange completes — see the header PLAN-GAP note.)
  const restricted: CardRestriction[] = [];
  const passed = state.exchange?.passed;
  if (passed != null && viewer === state.declarer && state.declarer !== null) {
    const partner = partnerOf(state.declarer);
    for (const c of passed) {
      if (!seen.has(c)) restricted.push({ card: c, seats: [partner] });
    }
  }

  const unseen = DECK.filter((c) => !seen.has(c));
  const need = seats.reduce((n, s) => n + s.count, 0);
  if (need > unseen.length) {
    throw new Error(
      `constraint extraction is inconsistent: ${need} cards to deal but only ` +
        `${unseen.length} unseen`,
    );
  }
  return { viewer, trump, unseen, seats, restricted };
}

/** Shuffle-and-check attempts before falling back to constructive dealing. */
export const REJECTION_TRIES = 500;
/** Constructive attempts before declaring the constraints unsatisfiable. */
export const CONSTRUCT_TRIES = 1000;

function assemble(
  seats: readonly HiddenSeat[],
  perSeat: readonly (readonly Card[])[],
  dead: readonly Card[],
): SampledWorld {
  const hands: (readonly Card[] | null)[] = [null, null, null, null];
  seats.forEach((s, i) => {
    hands[s.seat] = [...(perSeat[i] as readonly Card[])].sort((a, b) => a - b);
  });
  return { hands, dead: [...dead].sort((a, b) => a - b) };
}

/**
 * Draw one complete world consistent with the constraints. The rejection
 * path is exactly uniform over consistent worlds; the constructive fallback
 * (reached only under heavy constraints) is approximately uniform. Throws
 * when no consistent world can be built — a bug signal from the extraction
 * or the caller-supplied restrictions, never an expected outcome.
 */
export function sampleWorld(constraints: ObservedConstraints, rng: Rng): SampledWorld {
  const { unseen, seats, trump } = constraints;
  const need = seats.reduce((n, s) => n + s.count, 0);
  if (need > unseen.length) {
    throw new Error(`cannot deal ${need} cards from ${unseen.length} unseen`);
  }

  const restrictedTo = new Map<Card, Set<number>>();
  for (const r of constraints.restricted) restrictedTo.set(r.card, new Set(r.seats));
  const allowed = (card: Card, seat: HiddenSeat): boolean => {
    const only = restrictedTo.get(card);
    if (only !== undefined && !only.has(seat.seat)) return false;
    for (const v of seat.voidSuits) {
      if (countsAsSuit(card, v, trump)) return false;
    }
    return true;
  };

  const pool = [...unseen];
  for (let t = 0; t < REJECTION_TRIES; t++) {
    rng.shuffle(pool);
    let off = 0;
    let ok = true;
    outer: for (const s of seats) {
      for (let i = 0; i < s.count; i++) {
        if (!allowed(pool[off + i] as Card, s)) {
          ok = false;
          break outer;
        }
      }
      off += s.count;
    }
    if (ok) {
      const perSeat: Card[][] = [];
      let at = 0;
      for (const s of seats) {
        perSeat.push(pool.slice(at, at + s.count));
        at += s.count;
      }
      return assemble(seats, perSeat, pool.slice(at));
    }
  }

  for (let t = 0; t < CONSTRUCT_TRIES; t++) {
    const world = tryConstruct(constraints, allowed, rng);
    if (world !== null) return world;
  }
  throw new Error(
    'sampleWorld: no consistent world found after constructive retries — ' +
      'the constraint set is unsatisfiable (extraction bug?)',
  );
}

/**
 * One constructive attempt: place the most-constrained cards first, each
 * into a destination drawn weighted by remaining capacity (the dead pool is
 * a destination like any other). Null on a dead end; the caller retries.
 */
function tryConstruct(
  constraints: ObservedConstraints,
  allowed: (card: Card, seat: HiddenSeat) => boolean,
  rng: Rng,
): SampledWorld | null {
  const { unseen, seats } = constraints;
  const caps = seats.map((s) => s.count);
  let deadCap = unseen.length - caps.reduce((n, c) => n + c, 0);

  // Shuffle for randomness, then a stable sort brings restricted cards to
  // the front while preserving the shuffled order within each tier.
  const order = [...unseen];
  rng.shuffle(order);
  const options = (card: Card): number =>
    seats.reduce((n, s) => n + (allowed(card, s) ? 1 : 0), 0) + (deadCap > 0 ? 1 : 0);
  order.sort((a, b) => options(a) - options(b));

  const perSeat: Card[][] = seats.map(() => []);
  const dead: Card[] = [];
  for (const card of order) {
    let total = deadCap;
    for (let i = 0; i < seats.length; i++) {
      if ((caps[i] as number) > 0 && allowed(card, seats[i] as HiddenSeat)) {
        total += caps[i] as number;
      }
    }
    if (total === 0) return null;
    let r = rng.int(total);
    let placed = false;
    for (let i = 0; i < seats.length; i++) {
      const cap = caps[i] as number;
      if (cap === 0 || !allowed(card, seats[i] as HiddenSeat)) continue;
      if (r < cap) {
        (perSeat[i] as Card[]).push(card);
        caps[i] = cap - 1;
        placed = true;
        break;
      }
      r -= cap;
    }
    if (!placed) {
      dead.push(card);
      deadCap -= 1;
    }
  }
  return assemble(seats, perSeat, dead);
}
