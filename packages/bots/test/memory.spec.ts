/**
 * Memory-filter specs (fh-8jf.1). The forgetting curve is the one place bot
 * card-counting is allowed to be wrong, so what it must NEVER get wrong is
 * pinned here: the never-forget window (own hand, current + previous trick),
 * the cards a human always tracks (aces, trumps, joker), monotonicity within a
 * hand (a forgotten card never comes back), and per-(seed, seat) determinism.
 */

import type { Card, TrickPlay } from '@five-hundred/engine';
import { DECK, JOKER, cardRank, effectiveSuit, makeCard, makeRng } from '@five-hundred/engine';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMS,
  type MemoryHistory,
  type MemoryTrick,
  cardSalience,
  isPermanent,
  memorySeed,
  mergeParams,
  rememberHistory,
  validateParams,
} from '../src/index.js';

const MEM = DEFAULT_PARAMS.hardMemory;
const TRUMP = 0; // spades
const [S, C, D, H] = [0, 1, 2, 3];

/**
 * Deal the pack into four 10-card hands (5 cards dead: middle + discards) and
 * have every seat play its cards in dealt order. The plays are not legal
 * follows — the memory filter is a pure function of the history and never
 * consults the rules — but they give a realistic 40-card, 10-trick history.
 */
function dealtTricks(seed: number): { hands: Card[][]; tricks: MemoryTrick[] } {
  const pool = [...DECK];
  makeRng(seed).shuffle(pool);
  const hands = [0, 1, 2, 3].map((s) => pool.slice(s * 10, s * 10 + 10));
  const tricks: MemoryTrick[] = [];
  for (let t = 0; t < 10; t++) {
    const plays: TrickPlay[] = [0, 1, 2, 3].map((seat) => ({
      seat,
      card: (hands[seat] as Card[])[t] as Card,
    }));
    tricks.push({ ledSuit: effectiveSuit((plays[0] as TrickPlay).card, TRUMP, null), plays });
  }
  return { hands, tricks };
}

/**
 * The history as of `done` completed tricks, with `inProgress` plays already
 * made to the next one. The viewer's hand is whatever it has not yet played.
 */
function historyAt(
  seed: number,
  seat: number,
  done: number,
  inProgress = 0,
): MemoryHistory & { readonly all: readonly MemoryTrick[] } {
  const { hands, tricks } = dealtTricks(seed);
  const current =
    inProgress > 0
      ? {
          ledSuit: (tricks[done] as MemoryTrick).ledSuit,
          plays: (tricks[done] as MemoryTrick).plays.slice(0, inProgress),
        }
      : null;
  const played = done + (inProgress > seat ? 1 : 0);
  return {
    seat,
    seed: memorySeed(seed, 0, seat),
    trump: TRUMP,
    hand: (hands[seat] as Card[]).slice(played),
    tricks: tricks.slice(0, done),
    current,
    all: tricks,
  };
}

/** Every card played to a completed trick, in play order. */
function playedCards(history: MemoryHistory): Card[] {
  return history.tricks.flatMap((t) => t.plays.map((p) => p.card));
}

describe('cardSalience / isPermanent (AC-1c: the cards a human always tracks)', () => {
  it('marks the joker, both bowers, every ace and every trump permanent', () => {
    expect(isPermanent(JOKER, TRUMP, MEM)).toBe(true);
    expect(isPermanent(makeCard(TRUMP, 11), TRUMP, MEM)).toBe(true); // right bower
    expect(isPermanent(makeCard(C, 11), TRUMP, MEM)).toBe(true); // left bower (same colour)
    for (const suit of [S, C, D, H]) {
      expect(isPermanent(makeCard(suit, 14), TRUMP, MEM)).toBe(true);
    }
    for (const rank of [4, 7, 10, 12, 13]) {
      expect(isPermanent(makeCard(TRUMP, rank), TRUMP, MEM)).toBe(true);
    }
  });

  it('leaves off-suit spot cards forgettable, and grades them by rank', () => {
    expect(isPermanent(makeCard(D, 4), TRUMP, MEM)).toBe(false);
    expect(isPermanent(makeCard(D, 10), TRUMP, MEM)).toBe(false);
    expect(isPermanent(makeCard(D, 11), TRUMP, MEM)).toBe(false);
    expect(cardSalience(makeCard(D, 10), TRUMP, MEM)).toBeGreaterThan(
      cardSalience(makeCard(D, 4), TRUMP, MEM),
    );
    expect(cardSalience(makeCard(D, 13), TRUMP, MEM)).toBeGreaterThan(
      cardSalience(makeCard(D, 11), TRUMP, MEM),
    );
  });

  it('has no trump to promote in a no-trump contract, but still knows the joker', () => {
    expect(isPermanent(JOKER, null, MEM)).toBe(true);
    expect(isPermanent(makeCard(S, 14), null, MEM)).toBe(true);
    expect(isPermanent(makeCard(S, 11), null, MEM)).toBe(false); // just a jack now
    expect(isPermanent(makeCard(S, 4), null, MEM)).toBe(false);
  });
});

describe('rememberHistory (AC-1: what the seat still believes it has seen)', () => {
  it('never forgets its own hand, the current trick, or the previous trick', () => {
    for (const seed of [1, 7, 42, 999, 65535]) {
      for (const seat of [0, 1, 2, 3]) {
        const history = historyAt(seed, seat, 9, 2);
        const seen = new Set(rememberHistory(history, MEM).seen);
        for (const card of history.hand) expect(seen.has(card)).toBe(true);
        for (const p of history.current?.plays ?? []) expect(seen.has(p.card)).toBe(true);
        // Trick 8 is the immediately preceding one (graceTricks = 1).
        for (const p of (history.tricks[8] as MemoryTrick).plays) {
          expect(seen.has(p.card)).toBe(true);
        }
      }
    }
  });

  it('drops some old low spot cards by the end of the hand', () => {
    let forgotten = 0;
    for (const seed of [1, 7, 42, 999, 65535]) {
      const history = historyAt(seed, 0, 9, 0);
      const seen = new Set(rememberHistory(history, MEM).seen);
      for (const card of playedCards(history)) {
        if (!seen.has(card)) {
          forgotten++;
          // Only forgettable cards may go: never an ace, a trump or the joker.
          expect(isPermanent(card, TRUMP, MEM)).toBe(false);
        }
      }
    }
    expect(forgotten).toBeGreaterThan(0);
  });

  it('retains every ace, trump and the joker for the whole hand', () => {
    for (const seed of [1, 7, 42, 999, 65535]) {
      const history = historyAt(seed, 2, 9, 3);
      const seen = new Set(rememberHistory(history, MEM).seen);
      for (const card of playedCards(history)) {
        const rank = cardRank(card);
        const isTrump = effectiveSuit(card, TRUMP, TRUMP) === TRUMP;
        if (card === JOKER || isTrump || rank === 14) expect(seen.has(card)).toBe(true);
      }
    }
  });

  it('remembers everything while the history is still inside the grace window', () => {
    const history = historyAt(11, 1, 1, 2);
    const seen = new Set(rememberHistory(history, MEM).seen);
    for (const card of playedCards(history)) expect(seen.has(card)).toBe(true);
  });
});

describe('rememberHistory (AC-2: monotone and per-hand stable)', () => {
  it('gives byte-identical output for identical (seed, seat, history)', () => {
    for (const seat of [0, 3]) {
      const history = historyAt(42, seat, 7, 1);
      expect(rememberHistory(history, MEM)).toEqual(rememberHistory(history, MEM));
    }
  });

  it('never lets a forgotten card come back later in the hand', () => {
    for (const seed of [1, 7, 42, 999, 65535]) {
      for (const seat of [0, 2]) {
        const gone = new Set<Card>();
        for (let done = 1; done <= 10; done++) {
          const history = historyAt(seed, seat, done, 0);
          const seen = new Set(rememberHistory(history, MEM).seen);
          for (const card of gone) expect(seen.has(card)).toBe(false);
          for (const card of playedCards(history)) if (!seen.has(card)) gone.add(card);
        }
        expect(gone.size).toBeGreaterThan(0);
      }
    }
  });

  it('forgets independently per seat — partners share no memory', () => {
    const forgottenBy = (seat: number): string => {
      const history = historyAt(42, seat, 9, 0);
      const seen = new Set(rememberHistory(history, MEM).seen);
      // Played cards only: no seat holds them, so any difference is memory.
      return playedCards(history)
        .filter((c) => !seen.has(c))
        .sort((a, b) => a - b)
        .join(',');
    };
    const views = [0, 1, 2, 3].map(forgottenBy);
    expect(new Set(views).size).toBeGreaterThan(1);
  });

  it('re-rolls the curve each hand, so one hand is not a template for the next', () => {
    const base = historyAt(42, 0, 9, 0);
    const forget = (seed: number): number =>
      playedCards(base).filter((c) => !new Set(rememberHistory({ ...base, seed }, MEM).seen).has(c))
        .length;
    const counts = [0, 1, 2, 3, 4].map((hand) => forget(memorySeed(42, hand, 0)));
    expect(new Set(counts).size).toBeGreaterThan(1);
  });
});

/**
 * Voids: crafted rather than dealt, so the age of each observation is exact.
 * Trick 0 is the only informative one — seats 1 and 2 both fail to follow
 * diamonds. The filler tricks that age it are all-follow (no new voids); their
 * ranks repeat across tricks, which is harmless because nothing here reads the
 * seen-set.
 */
function voidHistory(seed: number, viewer: number, done: number): MemoryHistory {
  const tricks: MemoryTrick[] = [
    {
      ledSuit: D,
      plays: [
        { seat: 0, card: makeCard(D, 4) },
        { seat: 1, card: makeCard(H, 4) },
        { seat: 2, card: makeCard(H, 5) },
        { seat: 3, card: makeCard(D, 5) },
      ],
    },
  ];
  for (let t = 1; t < 10; t++) {
    const suit = [C, D, H][t % 3] as number;
    tricks.push({
      ledSuit: suit,
      plays: [0, 1, 2, 3].map((seat) => ({ seat, card: makeCard(suit, 6 + seat) })),
    });
  }
  return {
    seat: viewer,
    seed: memorySeed(seed, 0, viewer),
    trump: TRUMP,
    hand: [],
    tricks: tricks.slice(0, done),
    current: null,
  };
}

describe('rememberHistory voids (high retention, slight deep-past decay)', () => {
  it('records a fresh void for every seat that failed to follow', () => {
    const view = rememberHistory(voidHistory(5, 0, 1), MEM);
    expect(view.voids[1]).toEqual([D]);
    expect(view.voids[2]).toEqual([D]);
    expect(view.voids[0]).toEqual([]);
    expect(view.voids[3]).toEqual([]);
  });

  it('holds a mid-hand void with certainty — the decay is deep-past only', () => {
    for (let seed = 1; seed <= 200; seed++) {
      // Trick 0's void, six tricks later: inside every possible roll.
      expect(rememberHistory(voidHistory(seed, 0, 7), MEM).voids[1]).toEqual([D]);
    }
  });

  it('keeps the oldest void more often than not, but not always', () => {
    let kept = 0;
    const seeds = Array.from({ length: 200 }, (_, i) => i + 1);
    for (const seed of seeds) {
      if (rememberHistory(voidHistory(seed, 0, 9), MEM).voids[1]?.length === 1) kept++;
    }
    expect(kept).toBeGreaterThan(seeds.length / 2);
    expect(kept).toBeLessThan(seeds.length);
  });

  it('never forgets its own void — a seat knows what it is out of', () => {
    for (let seed = 1; seed <= 200; seed++) {
      expect(rememberHistory(voidHistory(seed, 2, 9), MEM).voids[2]).toEqual([D]);
    }
  });

  it('never lets a forgotten void come back while the evidence is unchanged', () => {
    for (let seed = 1; seed <= 40; seed++) {
      let gone = false;
      for (let done = 1; done <= 10; done++) {
        const has = rememberHistory(voidHistory(seed, 0, done), MEM).voids[1]?.length === 1;
        if (gone) expect(has).toBe(false);
        if (!has) gone = true;
      }
    }
  });
});

describe('BotParams.hardMemory (AC-3)', () => {
  it('ships every retention knob in the checked-in defaults', () => {
    for (const key of [
      'jokerSalience',
      'bowerSalience',
      'aceSalience',
      'kingSalience',
      'queenSalience',
      'jackSalience',
      'spotSalience',
      'spotRankStep',
      'trumpBonus',
      'permanentSalience',
      'baseHorizon',
      'salienceHorizon',
      'jitter',
      'graceTricks',
      'voidHorizon',
      'voidDecay',
    ] as const) {
      expect(Number.isFinite(MEM[key])).toBe(true);
    }
    expect(Object.isFrozen(MEM)).toBe(true);
  });

  it('is deep-mergeable leaf by leaf', () => {
    const merged = mergeParams(DEFAULT_PARAMS, { hardMemory: { voidHorizon: 3 } });
    expect(merged.hardMemory.voidHorizon).toBe(3);
    expect(merged.hardMemory.baseHorizon).toBe(MEM.baseHorizon);
    expect(merged.hardPlay).toEqual(DEFAULT_PARAMS.hardPlay);
    expect(validateParams(merged).ok).toBe(true);
  });

  it('is validated: a missing group or a non-finite leaf is rejected', () => {
    const withoutGroup: Record<string, unknown> = { ...DEFAULT_PARAMS };
    delete withoutGroup.hardMemory;
    expect(validateParams(withoutGroup).ok).toBe(false);

    const bad = mergeParams(DEFAULT_PARAMS, {}) as { hardMemory: { jitter: number } };
    bad.hardMemory.jitter = Number.NaN;
    expect(validateParams(bad).ok).toBe(false);
  });

  it('lets a tuned overlay turn memory off entirely (perfect recall)', () => {
    const perfect = mergeParams(DEFAULT_PARAMS, {
      hardMemory: { permanentSalience: 0, baseHorizon: 99 },
    }).hardMemory;
    const history = historyAt(42, 0, 9, 0);
    const seen = new Set(rememberHistory(history, perfect).seen);
    for (const card of playedCards(history)) expect(seen.has(card)).toBe(true);
  });
});
