/**
 * Constrained world sampler — acceptance criteria for the Hard-bot
 * determinization core:
 *
 *   AC-1  10k sampled worlds from a mid-play fixture all satisfy every
 *         void / hand-size / played-card constraint.
 *   AC-2  Unconstrained early-auction sampling distributes each unseen card
 *         across hidden seats uniformly within statistical tolerance.
 *   AC-3  Constraint extraction from a constructed trick history detects
 *         exactly the planted voids.
 *
 * Plus the packet's edge cases: void semantics for the joker and bowers,
 * caller-supplied card restrictions, 1-2 unknown cards late in a hand,
 * nulla / slam sat-out seats excluded from dealing, and the double-nulla
 * pass-through on both sides. All fixtures are seeded and deterministic.
 *
 * The last block covers the imperfect-memory wiring (fh-8jf.2): a forgotten
 * card returns to the unseen pool and can be dealt back into a hidden hand,
 * while everything certain — own hand, own discards, the current trick and
 * the one before it, every permanent-salience card — never does.
 */

import { describe, expect, it } from 'vitest';
import type { Action, Card, GameState } from '@five-hundred/engine';
import {
  DNULLA,
  JOKER,
  NULLA,
  NUM,
  PASS,
  applyAction,
  bid,
  initHandFromDeal,
  makeRng,
  newGame,
  toActSeat,
} from '@five-hundred/engine';
import type { HardMemoryParams, ObservedConstraints, SampledWorld } from '../src/index.js';
import {
  DEFAULT_PARAMS,
  MediumPolicy,
  botAction,
  countsAsSuit,
  deriveConstraints,
  isPermanent,
  sampleWorld,
} from '../src/index.js';

const S = (r: number): Card => r - 4;
const C = (r: number): Card => 11 + r - 4;
const D = (r: number): Card => 22 + r - 4;
const H = (r: number): Card => 33 + r - 4;

function apply(state: GameState, action: Action): GameState {
  const result = applyAction(state, action);
  if (!result.ok) throw new Error(`${action.type}: ${result.error.message}`);
  return result.state;
}

/** Play cards in table order, reading the acting seat from the state. */
function playCards(state: GameState, cards: readonly Card[]): GameState {
  for (const card of cards) {
    const seat = toActSeat(state);
    if (seat === null) throw new Error('nobody to act');
    state = apply(state, { type: 'playCard', seat, card });
  }
  return state;
}

/**
 * Crafted deal: seat 0 holds ten spades, seat 1 clubs without the jack
 * (the left bower of spades must stay out of a spade-void hand), seat 2
 * diamonds, seat 3 hearts; the middle holds the four aces' worth of gaps
 * plus the joker.
 */
const CRAFTED_HANDS: Card[][] = [
  [4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(S),
  [4, 5, 6, 7, 8, 9, 10, 12, 13, 14].map(C),
  [4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(D),
  [4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(H),
];
const CRAFTED_MIDDLE: Card[] = [S(14), C(11), D(14), H(14), JOKER];
const CRAFTED_KEEPS: Card[] = [S(6), S(7), S(8), S(9), S(10), S(11), S(12), S(13), S(14), JOKER];

/**
 * Seat 0 wins a scripted auction with `winning`, others pass — except for a
 * double nulla, which is legal only as an answer to the partner's nulla
 * (fh-17b), so that deal opens with seat 2 and its NULLA.
 */
function craftedAuction(winning: ReturnType<typeof bid>): GameState {
  const dnulla = winning.kind === DNULLA;
  const first = dnulla ? 2 : 0;
  let st = initHandFromDeal(CRAFTED_HANDS, CRAFTED_MIDDLE, first);
  for (let i = 0; i < 4; i++) {
    const seat = (first + i) % 4;
    const call = seat === 0 ? winning : dnulla && seat === 2 ? bid(NULLA) : bid(PASS);
    st = apply(st, { type: 'bid', seat, bid: call });
  }
  return st;
}

/** 7S by seat 0, slam declined, spades+joker kept: play phase, trump spades. */
function craftedSpadesGame(): GameState {
  let st = craftedAuction(bid(NUM, 7, 0));
  st = apply(st, { type: 'declineSlam', seat: 0 });
  st = apply(st, { type: 'discardKeeps', seat: 0, keeps: CRAFTED_KEEPS });
  expect(st.phase).toBe('play');
  return st;
}

/** Flag any constraint the world violates; null when fully consistent. */
function violation(cons: ObservedConstraints, world: SampledWorld): string | null {
  const unseen = new Set(cons.unseen);
  const dealt: Card[] = [];
  const only = new Map(cons.restricted.map((r) => [r.card, new Set(r.seats)]));
  for (const s of cons.seats) {
    const hand = world.hands[s.seat];
    if (hand == null) return `seat ${s.seat} has no hand`;
    if (hand.length !== s.count) return `seat ${s.seat} holds ${hand.length}, wants ${s.count}`;
    for (const c of hand) {
      if (!unseen.has(c)) return `seat ${s.seat} holds seen card ${c}`;
      for (const v of s.voidSuits) {
        if (countsAsSuit(c, v, cons.trump)) return `seat ${s.seat} void ${v} holds ${c}`;
      }
      const allow = only.get(c);
      if (allow !== undefined && !allow.has(s.seat)) return `restricted ${c} at seat ${s.seat}`;
    }
    dealt.push(...hand);
  }
  dealt.push(...world.dead);
  const all = [...dealt].sort((a, b) => a - b);
  const want = [...cons.unseen].sort((a, b) => a - b);
  if (all.length !== want.length || all.some((c, i) => c !== want[i])) {
    return 'dealt cards + dead pool is not a partition of the unseen cards';
  }
  return null;
}

/**
 * AC-1 fixture: Medium bots drive a fresh game into mid-play (6 completed
 * tricks); the first seed whose trick history reveals at least one void for
 * some active viewer is used. Seeded and deterministic.
 */
function midPlayFixture(): { cons: ObservedConstraints } {
  const policies = [
    new MediumPolicy(),
    new MediumPolicy(),
    new MediumPolicy(),
    new MediumPolicy(),
  ];
  for (let seed = 1; seed <= 60; seed++) {
    const rng = makeRng(seed);
    let st = newGame(seed);
    let guard = 0;
    while (!(st.phase === 'play' && st.play !== null && st.play.tricks.length >= 6)) {
      if (guard++ > 10_000) throw new Error('fixture drive did not converge');
      st = apply(st, botAction(st, policies, rng));
    }
    for (const viewer of st.activeSeats) {
      const cons = deriveConstraints(st, viewer);
      if (cons.seats.length >= 2 && cons.seats.some((s) => s.voidSuits.length > 0)) {
        return { cons };
      }
    }
  }
  throw new Error('no mid-play fixture with observed voids in seeds 1-60');
}

describe('deriveConstraints (AC-3: planted voids)', () => {
  it('detects exactly the planted voids from the trick history', () => {
    let st = craftedSpadesGame();
    // Trick 1: spades led, seats 1-3 cannot follow — three planted voids.
    st = playCards(st, [S(6), C(4), D(4), H(4)]);
    // Trick 2: spades again; no new voids may appear.
    st = playCards(st, [S(7), C(5), D(5), H(5)]);

    const cons = deriveConstraints(st, 0);
    expect(cons.trump).toBe(0);
    expect(cons.seats.map((s) => s.seat)).toEqual([1, 2, 3]);
    for (const s of cons.seats) {
      expect(s.voidSuits).toEqual([0]);
      expect(s.count).toBe(8);
    }
    expect(cons.restricted).toEqual([]);
    // Declarer saw 15 and knows the discards: 8 in hand + 5 discarded +
    // 8 played leaves 24 unseen.
    expect(cons.unseen).toHaveLength(24);

    // A seat that followed suit is not void: from seat 1's view the
    // declarer (who followed spades by leading them) shows no voids.
    const fromSeat1 = deriveConstraints(st, 1);
    const declarerModel = fromSeat1.seats.find((s) => s.seat === 0);
    expect(declarerModel?.voidSuits).toEqual([]);
    // The non-declarer cannot see the discards: 5 more cards are unseen.
    expect(fromSeat1.unseen).toHaveLength(29);
  });
});

describe('sampleWorld (AC-1: constraints hold over 10k mid-play worlds)', () => {
  it('every sampled world satisfies every constraint', () => {
    const { cons } = midPlayFixture();
    const rng = makeRng(42);
    for (let i = 0; i < 10_000; i++) {
      const bad = violation(cons, sampleWorld(cons, rng));
      if (bad !== null) throw new Error(`world ${i}: ${bad}`);
    }
  });
});

describe('sampleWorld (AC-2: unconstrained auction sampling is uniform)', () => {
  it('spreads each unseen card across hidden seats within tolerance', () => {
    const st = newGame(7);
    const cons = deriveConstraints(st, 0);
    expect(cons.unseen).toHaveLength(35);
    expect(cons.seats.map((s) => s.count)).toEqual([10, 10, 10]);
    expect(cons.seats.every((s) => s.voidSuits.length === 0)).toBe(true);

    const n = 20_000;
    const rng = makeRng(99);
    const hits = new Map<Card, number[]>(cons.unseen.map((c) => [c, [0, 0, 0, 0]]));
    for (let i = 0; i < n; i++) {
      const world = sampleWorld(cons, rng);
      cons.seats.forEach((s, si) => {
        for (const c of world.hands[s.seat] ?? []) (hits.get(c) as number[])[si] += 1;
      });
      for (const c of world.dead) (hits.get(c) as number[])[3] += 1;
    }
    // P(card at a given hidden seat) = 10/35; P(dead) = 5/35. With n=20k the
    // per-cell sd is ~0.003, so a 0.02 tolerance is ~6 sigma.
    for (const [card, counts] of hits) {
      for (let si = 0; si < 3; si++) {
        expect(Math.abs((counts[si] as number) / n - 10 / 35), `card ${card} seat ${si}`)
          .toBeLessThan(0.02);
      }
      expect(Math.abs((counts[3] as number) / n - 5 / 35), `card ${card} dead`)
        .toBeLessThan(0.02);
    }
  });
});

describe('void semantics (joker and bowers)', () => {
  const base: ObservedConstraints = {
    viewer: 0,
    trump: 3, // hearts; SAME_COLOR[3] = 2, so JD is the left bower
    unseen: [H(4), H(5), H(6), H(7), H(8), D(11), H(11), JOKER, C(4), C(5), C(6), D(4), D(5)],
    seats: [
      { seat: 1, count: 4, voidSuits: [3] },
      { seat: 2, count: 4, voidSuits: [] },
      { seat: 3, count: 4, voidSuits: [2] },
    ],
    restricted: [],
  };

  it('a trump-void seat never receives trump, the joker, or either bower', () => {
    const rng = makeRng(5);
    let leftBowerAtSeat3 = 0;
    for (let i = 0; i < 500; i++) {
      const world = sampleWorld(base, rng);
      expect(violation(base, world)).toBeNull();
      for (const c of world.hands[1] ?? []) {
        expect(countsAsSuit(c, 3, 3), `card ${c} counts as trump`).toBe(false);
      }
      // Seat 3 is void in printed diamonds, but JD is effectively a heart
      // and may legally sit there.
      if ((world.hands[3] ?? []).includes(D(11))) leftBowerAtSeat3 += 1;
    }
    expect(leftBowerAtSeat3).toBeGreaterThan(0);
  });

  it('with no trump, any void excludes the joker', () => {
    const cons: ObservedConstraints = {
      viewer: 0,
      trump: null,
      unseen: [C(4), C(5), C(6), D(4), D(5), D(6), JOKER, H(4), H(5)],
      seats: [
        { seat: 1, count: 3, voidSuits: [1] },
        { seat: 2, count: 3, voidSuits: [] },
      ],
      restricted: [],
    };
    const rng = makeRng(6);
    for (let i = 0; i < 500; i++) {
      const world = sampleWorld(cons, rng);
      expect(violation(cons, world)).toBeNull();
      expect(world.hands[1]).not.toContain(JOKER);
    }
  });
});

describe('restricted cards and degenerate pools', () => {
  it('a restricted card only ever sits with its allowed seat or the dead pool', () => {
    const cons: ObservedConstraints = {
      viewer: 0,
      trump: null,
      unseen: [S(4), S(5), S(6), C(4), C(5), C(6), D(4)],
      seats: [
        { seat: 1, count: 3, voidSuits: [] },
        { seat: 2, count: 3, voidSuits: [] },
      ],
      restricted: [{ card: S(4), seats: [2] }],
    };
    const rng = makeRng(11);
    for (let i = 0; i < 300; i++) {
      const world = sampleWorld(cons, rng);
      expect(violation(cons, world)).toBeNull();
      expect(world.hands[1]).not.toContain(S(4));
    }
  });

  it('handles 1-2 unknown cards late in a hand, including forced deals', () => {
    const cons: ObservedConstraints = {
      viewer: 0,
      trump: null,
      unseen: [S(4), H(4)],
      seats: [
        { seat: 1, count: 1, voidSuits: [0] },
        { seat: 2, count: 1, voidSuits: [] },
      ],
      restricted: [],
    };
    const rng = makeRng(12);
    for (let i = 0; i < 50; i++) {
      const world = sampleWorld(cons, rng);
      expect(world.hands[1]).toEqual([H(4)]);
      expect(world.hands[2]).toEqual([S(4)]);
      expect(world.dead).toEqual([]);
    }
  });

  it('throws on an unsatisfiable constraint set instead of looping', () => {
    const cons: ObservedConstraints = {
      viewer: 0,
      trump: null,
      unseen: [S(4), S(5)],
      seats: [
        { seat: 1, count: 1, voidSuits: [0] },
        { seat: 2, count: 1, voidSuits: [0] },
      ],
      restricted: [],
    };
    expect(() => sampleWorld(cons, makeRng(13))).toThrow(/unsatisfiable/);
  });
});

describe('sat-out seats and the double-nulla pass-through', () => {
  it('nulla: the sat-out partner is never dealt to; their cards go dead', () => {
    let st = craftedAuction(bid(NULLA));
    st = apply(st, { type: 'discardKeeps', seat: 0, keeps: CRAFTED_KEEPS });
    expect(st.phase).toBe('play');
    expect(st.activeSeats).toEqual([0, 1, 3]);

    const cons = deriveConstraints(st, 1);
    expect(cons.seats.map((s) => s.seat)).toEqual([0, 3]);
    expect(cons.unseen).toHaveLength(35);
    const world = sampleWorld(cons, makeRng(21));
    expect(world.hands[2]).toBeNull();
    // Dead pool: the sat-out partner's 10 plus the 5 discards.
    expect(world.dead).toHaveLength(15);
  });

  it('slam: the partner sits out with 9 after giving a card', () => {
    let st = craftedAuction(bid(NUM, 7, 0));
    st = apply(st, { type: 'declareSlam', seat: 0 });
    st = apply(st, { type: 'giveCard', seat: 2, card: D(13) });
    st = apply(st, { type: 'discardKeeps', seat: 0, keeps: CRAFTED_KEEPS });
    expect(st.phase).toBe('play');
    expect(st.activeSeats).toEqual([0, 1, 3]);

    // Declarer view: 10 in hand, 6 known discards; dead = partner's 9.
    const cons = deriveConstraints(st, 0);
    expect(cons.seats.map((s) => s.seat)).toEqual([1, 3]);
    expect(cons.unseen).toHaveLength(29);
    expect(sampleWorld(cons, makeRng(22)).dead).toHaveLength(9);
  });

  it('dnulla declarer knows the passed 5 sit with the partner while it discards', () => {
    let st = craftedAuction(bid(DNULLA));
    st = apply(st, { type: 'discardKeeps', seat: 0, keeps: CRAFTED_KEEPS });
    expect(st.phase).toBe('middleExchange'); // partner now holds 15

    const passed = [S(4), S(5), C(11), D(14), H(14)];
    const cons = deriveConstraints(st, 0);
    expect(cons.restricted.map((r) => r.card).sort((a, b) => a - b)).toEqual(passed);
    expect(cons.seats.find((s) => s.seat === 2)?.count).toBe(15);

    const rng = makeRng(23);
    for (let i = 0; i < 100; i++) {
      const world = sampleWorld(cons, rng);
      expect(violation(cons, world)).toBeNull();
      for (const c of passed) expect(world.hands[2]).toContain(c);
    }
  });

  it('dnulla partner has seen all 15, so the passed cards are never unseen', () => {
    let st = craftedAuction(bid(DNULLA));
    st = apply(st, { type: 'discardKeeps', seat: 0, keeps: CRAFTED_KEEPS });
    // Partner keeps its original diamonds, discarding the 5 passed cards.
    st = apply(st, { type: 'discardKeeps', seat: 2, keeps: CRAFTED_HANDS[2] as Card[] });
    expect(st.phase).toBe('play');

    const cons = deriveConstraints(st, 2);
    expect(cons.unseen).toHaveLength(30);
    for (const c of [S(4), S(5), C(11), D(14), H(14)]) {
      expect(cons.unseen).not.toContain(c);
    }
    expect(cons.seats.map((s) => s.count)).toEqual([10, 10, 10]);
  });
});

// ---------------------------------------------------------------------------
// Imperfect memory (fh-8jf.2)
// ---------------------------------------------------------------------------

/**
 * A retention curve that forgets nothing: every card clears permanentSalience
 * and no void ever decays. Constraints derived through it must equal the
 * perfect-recall ones exactly — the pin that the memory path and the true-
 * history path are the same derivation with a different view in front of it.
 */
const TOTAL_RECALL: HardMemoryParams = {
  ...DEFAULT_PARAMS.hardMemory,
  permanentSalience: 0,
  voidHorizon: 999,
};

/**
 * The crafted spades game driven deep enough for the early tricks to fade.
 * Seat 0 (the declarer) holds every spade, so it leads and wins every trick
 * while the other three shed low side cards — exactly the already-played spot
 * cards the filter is meant to lose. Seven completed tricks, then two cards of
 * the eighth, so the never-forget window (the trick in progress and the one
 * before it) is exercised too.
 */
function deepSpadesGame(): GameState {
  let st = craftedSpadesGame();
  for (let t = 0; t < 7; t++) {
    st = playCards(st, [S(6 + t), C(4 + t), D(4 + t), H(4 + t)]);
  }
  return playCards(st, [S(13), C(12)]);
}

/** Medium bots drive game `seed` to six completed tricks. */
function midPlayState(seed: number): GameState {
  const medium = new MediumPolicy();
  const policies = [medium, medium, medium, medium];
  const rng = makeRng(seed);
  let st = newGame(seed);
  for (let guard = 0; !(st.play !== null && st.play.tricks.length >= 6); guard++) {
    if (guard > 10_000) throw new Error('fixture drive did not converge');
    st = apply(st, botAction(st, policies, rng));
  }
  return st;
}

describe('deriveConstraints with imperfect memory (fh-8jf.2)', () => {
  it('AC-1: forgotten low cards return to unseen and get dealt to hidden hands', () => {
    const st = deepSpadesGame();
    const perfect = deriveConstraints(st, 0);
    const cons = deriveConstraints(st, 0, { seed: 0xbeef });

    // Forgetting only ever ADDS to the unseen pool, never removes.
    for (const c of perfect.unseen) expect(cons.unseen).toContain(c);
    const forgotten = cons.unseen.filter((c) => !perfect.unseen.includes(c));
    expect(forgotten.length).toBeGreaterThan(0);
    // Hand counts are public and stay exact whatever the seat forgot.
    expect(cons.seats.map((s) => s.count)).toEqual(perfect.seats.map((s) => s.count));
    // Nothing salient is ever lost: no trump, no permanent-salience card.
    for (const c of forgotten) {
      expect(isPermanent(c, cons.trump, DEFAULT_PARAMS.hardMemory), `card ${c}`).toBe(false);
      expect(countsAsSuit(c, 0, cons.trump), `card ${c} is trump`).toBe(false);
    }

    // ...and the sampler puts them back into hidden hands, which is the whole
    // point: the bot plays on as if they might still be live.
    const rng = makeRng(3);
    const replaced = new Set<Card>();
    for (let i = 0; i < 200; i++) {
      const world = sampleWorld(cons, rng);
      expect(violation(cons, world)).toBeNull();
      for (const s of cons.seats) {
        for (const c of world.hands[s.seat] ?? []) {
          if (forgotten.includes(c)) replaced.add(c);
        }
      }
    }
    expect(replaced.size).toBeGreaterThan(0);
  });

  it('AC-2: own hand, own discards and the last two tricks are never unseen', () => {
    const st = deepSpadesGame();
    const play = st.play;
    if (play === null) throw new Error('fixture is not in play');
    const last = play.tricks[play.tricks.length - 1];
    if (last === undefined) throw new Error('fixture has no completed trick');
    const recent = [...play.plays, ...last.plays].map((p) => p.card);

    for (let seed = 1; seed <= 25; seed++) {
      const cons = deriveConstraints(st, 0, { seed });
      const unseen = new Set(cons.unseen);
      for (const c of st.hands[0] ?? []) expect(unseen.has(c), `own ${c}`).toBe(false);
      // Seat 0 is the declarer, so the five discards are its own knowledge.
      for (const c of st.discards) expect(unseen.has(c), `discard ${c}`).toBe(false);
      for (const c of recent) expect(unseen.has(c), `recent ${c}`).toBe(false);
      for (const t of play.tricks) {
        for (const p of t.plays) {
          if (isPermanent(p.card, cons.trump, DEFAULT_PARAMS.hardMemory)) {
            expect(unseen.has(p.card), `permanent ${p.card}`).toBe(false);
          }
        }
      }
    }
  });

  it('AC-3: constraints stay satisfiable across a seeded sweep', () => {
    for (let fixture = 1; fixture <= 5; fixture++) {
      const st = midPlayState(fixture);
      for (const viewer of st.activeSeats) {
        for (let seed = 1; seed <= 4; seed++) {
          const cons = deriveConstraints(st, viewer, { seed });
          const rng = makeRng(seed * 31 + viewer);
          for (let i = 0; i < 40; i++) {
            expect(violation(cons, sampleWorld(cons, rng))).toBeNull();
          }
        }
      }
    }
  }, 30_000);

  it('AC-4: deterministic in (state, viewer, seed), and total recall is the true view', () => {
    const st = deepSpadesGame();
    expect(deriveConstraints(st, 0, { seed: 0xbeef })).toEqual(
      deriveConstraints(st, 0, { seed: 0xbeef }),
    );
    // The memory path with a curve that forgets nothing reproduces the
    // perfect-recall derivation card for card and void for void.
    for (let fixture = 1; fixture <= 5; fixture++) {
      const state = midPlayState(fixture);
      for (const viewer of state.activeSeats) {
        expect(deriveConstraints(state, viewer, { seed: viewer, params: TOTAL_RECALL })).toEqual(
          deriveConstraints(state, viewer),
        );
      }
    }
  }, 30_000);

  it('is a difficulty dial: a harsher curve forgets strictly more', () => {
    const st = deepSpadesGame();
    const harsh: HardMemoryParams = {
      ...DEFAULT_PARAMS.hardMemory,
      permanentSalience: 99,
      baseHorizon: 0,
      salienceHorizon: 0,
      jitter: 0,
      voidHorizon: 0,
    };
    const perfect = deriveConstraints(st, 0);
    const dial = deriveConstraints(st, 0, { seed: 5, params: harsh });
    const normal = deriveConstraints(st, 0, { seed: 5 });
    expect(dial.unseen.length).toBeGreaterThan(normal.unseen.length);
    expect(normal.unseen.length).toBeGreaterThan(perfect.unseen.length);
    // Even at its harshest the floor holds: the grace window keeps the two
    // most recent tricks, so the eight cards on the table stay seen.
    const play = st.play;
    if (play === null) throw new Error('fixture is not in play');
    const last = play.tricks[play.tricks.length - 1];
    for (const p of [...play.plays, ...(last?.plays ?? [])]) {
      expect(dial.unseen).not.toContain(p.card);
    }
    // Voids can fade too — the spade voids here were re-observed on the trick
    // in progress, so they survive even this.
    for (const s of dial.seats) expect(s.voidSuits).toEqual([0]);
  });
});

describe('bench note (informational)', () => {
  it('records samples/sec on the mid-play fixture for budget tuning', () => {
    const { cons } = midPlayFixture();
    const rng = makeRng(77);
    const n = 5000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) sampleWorld(cons, rng);
    const perSec = Math.round((n / (performance.now() - t0)) * 1000);
    console.log(`worlds sampler: ~${perSec} samples/sec (mid-play fixture)`);
    expect(perSec).toBeGreaterThan(0);
  });
});
