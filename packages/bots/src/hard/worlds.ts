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
 * worlds — then a constructive fallback (hands filled most-constrained-seat
 * first, the dead pool taking the leftovers) so pathological constraint sets
 * still terminate; CONSTRUCT_TRIES failures throw with the constraint set in
 * the message, because an unsatisfiable set means the extraction is buggy —
 * the true world always satisfies it — and the dump is what makes such a
 * crash reproducible from a log line.
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
 *
 * Imperfect memory (fh-8jf.2): deriveConstraints takes an optional per-seat
 * memory, and with one it builds the seen-set and the voids from the
 * REMEMBERED view (memory.ts) rather than the true history. This is where the
 * epic's central trick lands — a forgotten card is not tracked as a special
 * kind of belief, it simply falls out of `seen` and back into `unseen`, so
 * the sampler may deal it to a hidden hand and the bot plays the rest of the
 * hand as if it might still be live. Constraints stay satisfiable by
 * construction: forgetting only ADDS to `unseen` and only REMOVES voids, so
 * every world consistent with the true history is still consistent here (the
 * forgotten cards go to the dead pool), and the counts, which are public, are
 * never fuzzed.
 */

import type { Card, GameState, Rng } from '@five-hundred/engine';
import { DECK, DNULLA, effectiveSuit, partnerOf, trumpOf } from '@five-hundred/engine';
import type { RememberedView } from '../memory.js';
import { memoryHistoryFromState, memorySeed, rememberHistory } from '../memory.js';
import { DEFAULT_PARAMS, type HardMemoryParams } from '../params.js';

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

/** Per-seat imperfect memory for constraint derivation (fh-8jf.2). */
export interface ConstraintMemory {
  /**
   * Base seed the forgetting rolls hang off — normally the game seed. Mixed
   * with the hand number and the viewing seat by {@link memorySeed}, exactly
   * as MediumPolicy.withMemory does, so a Hard seat and the Medium reference
   * it consults never disagree about which cards are gone.
   */
  readonly seed: number;
  /** Retention curve; defaults to the checked-in DEFAULT_PARAMS.hardMemory. */
  readonly params?: HardMemoryParams;
}

/**
 * The viewer's TRUE observations, in the shape the memory filter returns —
 * perfect recall, the pre-fh-8jf.2 behaviour and still the default. Voids come
 * from failure to follow, over completed tricks and the one in progress, and
 * are monotone: a seat out of an effective suit never regains it.
 */
function observedView(
  state: GameState,
  viewer: number,
  trump: number | null,
  known: readonly Card[],
): RememberedView {
  const seen = new Set<Card>(state.hands[viewer]);
  for (const c of known) seen.add(c);
  const play = state.play;
  const voids: Set<number>[] = [new Set(), new Set(), new Set(), new Set()];
  if (play !== null) {
    for (const t of play.tricks) for (const p of t.plays) seen.add(p.card);
    for (const p of play.plays) seen.add(p.card);
    const tricks: { ledSuit: number; plays: readonly { seat: number; card: Card }[] }[] =
      play.tricks.map((t) => ({ ledSuit: t.ledSuit, plays: t.plays }));
    if (play.ledSuit !== null && play.plays.length > 0) {
      tricks.push({ ledSuit: play.ledSuit, plays: play.plays });
    }
    for (const t of tricks) {
      for (const p of t.plays) {
        if (!countsAsSuit(p.card, t.ledSuit, trump)) (voids[p.seat] as Set<number>).add(t.ledSuit);
      }
    }
  }
  return {
    seen: [...seen].sort((a, b) => a - b),
    voids: voids.map((s) => [...s].sort((a, b) => a - b)),
  };
}

/**
 * Extract the viewing seat's constraints from a full GameState, reading only
 * seat-visible information: the own hand, the public trick history, public
 * hand counts and active seats, plus discards/passed cards when the viewer
 * is the seat that saw them.
 *
 * With a `memory` the observations run through the forgetting curve first
 * (fh-8jf.2): forgotten cards return to `unseen` and faded voids stop
 * constraining, so the sampled worlds carry the seat's uncertainty instead of
 * a card-counter's certainty. What is public or private-but-certain is never
 * fuzzed — the hand counts, the viewer's own hand, and its own discards.
 */
export function deriveConstraints(
  state: GameState,
  viewer: number,
  memory?: ConstraintMemory,
): ObservedConstraints {
  if (!Number.isInteger(viewer) || viewer < 0 || viewer > 3) {
    throw new Error(`viewer must be a seat 0-3, got ${String(viewer)}`);
  }
  if (state.phase === 'dealing' || state.phase === 'handScored' || state.phase === 'gameOver') {
    throw new Error(`no hidden world to sample during ${state.phase}`);
  }
  const trump = state.contract !== null ? trumpOf(state.contract) : null;

  // Discards are known to whoever made them: the declarer, except in double
  // nulla where the pile that survives is the partner's second discard. They
  // are the seat's own private knowledge, so the filter never forgets them.
  const known: Card[] = [];
  if (state.declarer !== null && state.discards.length > 0) {
    const owner =
      state.contract?.kind === DNULLA ? partnerOf(state.declarer) : state.declarer;
    if (viewer === owner) known.push(...state.discards);
  }

  const view =
    memory === undefined
      ? observedView(state, viewer, trump, known)
      : rememberHistory(
          memoryHistoryFromState(state, viewer, {
            seed: memorySeed(memory.seed, state.handNumber, viewer),
            known,
          }),
          memory.params ?? DEFAULT_PARAMS.hardMemory,
        );
  const seen = new Set<Card>(view.seen);

  // Sat-out seats are not in activeSeats: their untouched cards are never
  // dealt and fall through to the dead pool. Counts are public — a seat that
  // forgot a card still knows how many cards everyone holds.
  const seats: HiddenSeat[] = state.activeSeats
    .filter((s) => s !== viewer)
    .map((seat) => ({
      seat,
      count: (state.hands[seat] ?? []).length,
      voidSuits: view.voids[seat] ?? [],
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
  // The set is dumped verbatim: the true world always satisfies it, so getting
  // here is a bug in the extraction or in tryConstruct, and the only way to
  // debug one from a server log is to be able to replay the exact set
  // (fh-8jf.4's AC-3b fixture came out of one of these lines).
  throw new Error(
    'sampleWorld: no consistent world found after constructive retries — the ' +
      `constraint set is unsatisfiable (extraction bug?): ${JSON.stringify(constraints)}`,
  );
}

/**
 * One constructive attempt: fill the hidden HANDS from the pool and let the
 * dead pool take whatever is left over.
 *
 * The dead pool has no constraints and exactly the leftover capacity, so the
 * only real problem is the bipartite one — give every seat `count` cards it is
 * allowed to hold — and every card spent on the dead pool is a card that
 * cannot answer it. The earlier version of this routine treated dead as a
 * destination like any other, drawn with weight `deadCap`; late in a hand with
 * imperfect memory (fh-8jf.4) that weight dominates — the pool is fat with
 * forgotten cards while the seats hold one or two each — so the few cards a
 * heavily-void seat could take were usually buried in the dead pool before its
 * turn came, and 1000 attempts could all dead-end on a constraint set the TRUE
 * world satisfies by definition.
 *
 * Seats are filled one card at a time, always serving the seat with the least
 * slack (allowed candidates minus cards still needed) first, and each card is
 * drawn from a shuffled pool with a bias toward the cards fewest OTHER needy
 * seats could use. A seat whose candidates no longer cover its count fails the
 * attempt immediately rather than dealing into a corner. Null on a dead end;
 * the caller retries.
 */
function tryConstruct(
  constraints: ObservedConstraints,
  allowed: (card: Card, seat: HiddenSeat) => boolean,
  rng: Rng,
): SampledWorld | null {
  const { unseen, seats } = constraints;
  const pool = [...unseen];
  rng.shuffle(pool);
  const taken = pool.map(() => false);
  const need = seats.map((s) => s.count);
  const perSeat: Card[][] = seats.map(() => []);
  // Precomputed allowance grid: `fits[i][j]` is "seat i may hold pool card j".
  const fits = seats.map((s) => pool.map((c) => allowed(c, s)));

  for (;;) {
    // The neediest seat: fewest spare candidates for the cards it still needs.
    let pick = -1;
    let slack = Number.POSITIVE_INFINITY;
    for (let i = 0; i < seats.length; i++) {
      if ((need[i] as number) === 0) continue;
      const row = fits[i] as boolean[];
      let avail = 0;
      for (let j = 0; j < pool.length; j++) if (!(taken[j] as boolean) && (row[j] as boolean)) avail++;
      if (avail < (need[i] as number)) return null; // this branch cannot be completed
      const spare = avail - (need[i] as number);
      if (spare < slack) {
        slack = spare;
        pick = i;
      }
    }
    if (pick === -1) break; // every seat is full

    // Among that seat's candidates, prefer one the other needy seats do not
    // want; the shuffle above is what randomizes ties, so this stays a sample
    // rather than a fixed deal.
    const row = fits[pick] as boolean[];
    let best = -1;
    let bestDemand = Number.POSITIVE_INFINITY;
    for (let j = 0; j < pool.length; j++) {
      if ((taken[j] as boolean) || !(row[j] as boolean)) continue;
      let demand = 0;
      for (let i = 0; i < seats.length; i++) {
        if (i !== pick && (need[i] as number) > 0 && ((fits[i] as boolean[])[j] as boolean)) demand++;
      }
      if (demand < bestDemand) {
        bestDemand = demand;
        best = j;
        if (demand === 0) break;
      }
    }
    if (best === -1) return null;
    taken[best] = true;
    need[pick] = (need[pick] as number) - 1;
    (perSeat[pick] as Card[]).push(pool[best] as Card);
  }

  const dead = pool.filter((_, j) => !(taken[j] as boolean));
  return assemble(seats, perSeat, dead);
}
