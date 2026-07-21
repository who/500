/**
 * Hard-bot rollout keep/discard evaluation — acceptance criteria for
 * fh-7hw.2:
 *
 *   AC-1  On constructed fixtures Hard chooseKeeps beats Medium chooseKeeps
 *         in evaluated expected points (self-consistency: Medium's keep is
 *         always a candidate, so the argmax can never score below it on the
 *         shared worlds; a pinned fixture shows a strict improvement).
 *   AC-2  Nulla, dnulla, and slam-16 contexts produce valid 10-card keeps
 *         with the correct special-case behavior (weakest-10 on dominant
 *         lose-all fixtures, 10-from-16 solo keep after a slam).
 *   AC-3  Identical (cards, contract, seed) inputs always produce identical
 *         keeps, and the shared-world evaluator itself is deterministic.
 *
 * Plus the packet's structural requirements on candidate generation: Medium's
 * keep leads the candidate list, the swap neighborhood stays within the
 * MAX_CANDIDATES cap, and every candidate is a legal 10-card subset.
 */

import { describe, expect, it } from 'vitest';
import type { Bid, Card } from '@five-hundred/engine';
import { DNULLA, JOKER, NULLA, NUM, bid, makeRng } from '@five-hundred/engine';
import {
  KEEP_WORLDS,
  MAX_CANDIDATES,
  MediumPolicy,
  candidateKeeps,
  chooseKeepsByRollout,
  evaluateKeeps,
  playoutKeeps,
  sampleKeepWorlds,
} from '../src/index.js';

const S = (r: number): Card => r - 4;
const C = (r: number): Card => 11 + r - 4;
const D = (r: number): Card => 22 + r - 4;
const H = (r: number): Card => 33 + r - 4;

const medium = new MediumPolicy();
const asc = (a: Card, b: Card): number => a - b;
const sortedSet = (cards: readonly Card[]): Card[] => [...cards].sort(asc);

const EIGHT_HEARTS = bid(NUM, 8, 3);

/**
 * Dominant 8H pickup: joker, both bowers, A-K-Q-10-9 of trump and two side
 * aces make the strong 10 obvious; the 5 side rags are pure discards.
 */
const STRONG_15: Card[] = [
  JOKER, H(11), D(11), H(14), H(13), H(12), H(10), H(9), S(14), C(14),
  S(4), S(5), C(4), C(5), D(4),
];
const STRONG_KEEP = sortedSet([
  JOKER, H(11), D(11), H(14), H(13), H(12), H(10), H(9), S(14), C(14),
]);

/**
 * 8H pickup where Medium's void-building heuristic keeps the wrong boundary
 * card: found by seeded search, pinned here. Hard's rollout swaps Medium's
 * QS out for the KC, which is worth roughly +80 expected points on fresh
 * shared worlds.
 */
const IMPROVABLE_15: Card[] = [
  S(5), S(8), S(12), S(14), C(10), C(13), C(14), D(7), D(10), D(11),
  H(8), H(9), H(11), H(12), H(14),
];

/** Ten rags plus five court cards: the weakest-10 lose-all keep is dominant. */
const LOW_15: Card[] = [
  S(4), S(5), C(4), C(5), C(6), D(4), D(5), H(4), H(5), H(6),
  S(13), C(13), D(13), H(13), H(12),
];

/** Slam pickup of 16: joker, left bower, every heart, and three side aces. */
const SLAM_16: Card[] = [
  JOKER, D(11), S(14), C(14), D(14),
  ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(H),
];

function expectValidKeep(keep: readonly Card[], from: readonly Card[]): void {
  expect(keep).toHaveLength(10);
  expect(new Set(keep).size).toBe(10);
  for (const c of keep) expect(from).toContain(c);
}

describe('candidateKeeps', () => {
  it('leads with the Medium keep and stays within the cap', () => {
    for (const [cards, contract] of [
      [STRONG_15, EIGHT_HEARTS],
      [LOW_15, bid(NULLA)],
      [SLAM_16, EIGHT_HEARTS],
    ] as const) {
      const candidates = candidateKeeps(cards, contract);
      expect(candidates.length).toBeGreaterThan(1);
      expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
      expect(sortedSet(candidates[0] as Card[])).toEqual(
        sortedSet(medium.chooseKeeps(cards, contract)),
      );
      const seen = new Set<string>();
      for (const cand of candidates) {
        expectValidKeep(cand, cards);
        seen.add(sortedSet(cand).join(','));
      }
      expect(seen.size).toBe(candidates.length); // swaps never collide
    }
  });

  it('includes the lose-all weakest-10 base on nulla and dnulla', () => {
    for (const contract of [bid(NULLA), bid(DNULLA)]) {
      const base = candidateKeeps(LOW_15, contract)[0] as Card[];
      expect(sortedSet(base)).toEqual(sortedSet(medium.chooseKeeps(LOW_15, contract)));
    }
  });
});

describe('chooseKeepsByRollout (AC-1)', () => {
  it('keeps the dominant 10 on an obviously-strong pickup', () => {
    const keep = chooseKeepsByRollout(STRONG_15, EIGHT_HEARTS, makeRng(42), { worlds: 30 });
    expect(sortedSet(keep)).toEqual(STRONG_KEEP);
  });

  it('never evaluates below the Medium keep on the shared worlds', () => {
    // Self-consistency by construction: Medium's keep is candidate 0, so the
    // argmax matches or beats it on the very worlds the choice used. Verify
    // on independently sampled worlds instead, where it must still hold for
    // a fixture with a clear best keep.
    const worlds = sampleKeepWorlds(STRONG_15, EIGHT_HEARTS, 30, makeRng(77));
    const rng = makeRng(78);
    const hard = chooseKeepsByRollout(STRONG_15, EIGHT_HEARTS, makeRng(42), { worlds: 30 });
    const evHard = evaluateKeeps(STRONG_15, hard, EIGHT_HEARTS, worlds, rng);
    const evMed = evaluateKeeps(
      STRONG_15,
      medium.chooseKeeps(STRONG_15, EIGHT_HEARTS),
      EIGHT_HEARTS,
      worlds,
      rng,
    );
    expect(evHard).toBeGreaterThanOrEqual(evMed);
  });

  it('strictly beats Medium on the pinned improvable fixture', () => {
    const hard = chooseKeepsByRollout(IMPROVABLE_15, EIGHT_HEARTS, makeRng(1003), {
      worlds: 24,
    });
    const med = sortedSet(medium.chooseKeeps(IMPROVABLE_15, EIGHT_HEARTS));
    expect(sortedSet(hard)).not.toEqual(med);
    const worlds = sampleKeepWorlds(IMPROVABLE_15, EIGHT_HEARTS, 40, makeRng(558));
    const rng = makeRng(559);
    const evHard = evaluateKeeps(IMPROVABLE_15, hard, EIGHT_HEARTS, worlds, rng);
    const evMed = evaluateKeeps(IMPROVABLE_15, med, EIGHT_HEARTS, worlds, rng);
    expect(evHard).toBeGreaterThan(evMed);
  });
});

describe('special contract contexts (AC-2)', () => {
  it('nulla keeps the weakest 10 on a dominant lose-all fixture', () => {
    const keep = chooseKeepsByRollout(LOW_15, bid(NULLA), makeRng(7), { worlds: 16 });
    expectValidKeep(keep, LOW_15);
    expect(sortedSet(keep)).toEqual(sortedSet(medium.chooseKeeps(LOW_15, bid(NULLA))));
  });

  it('dnulla keeps are valid and score the pass-through partner keep', () => {
    const keep = chooseKeepsByRollout(LOW_15, bid(DNULLA), makeRng(9), { worlds: 12 });
    expectValidKeep(keep, LOW_15);
    // The play-out itself must survive the partner's Medium keep of the
    // passed-through 15 and produce a finite side-0 score.
    const worlds = sampleKeepWorlds(LOW_15, bid(DNULLA), 1, makeRng(10));
    const score = playoutKeeps(LOW_15, keep, bid(DNULLA), worlds[0]!, makeRng(11));
    expect(Number.isFinite(score)).toBe(true);
  });

  it('slam-16 keeps 10 of the 16 with the partner sat out', () => {
    const keep = chooseKeepsByRollout(SLAM_16, EIGHT_HEARTS, makeRng(3), { worlds: 12 });
    expectValidKeep(keep, SLAM_16);
    const worlds = sampleKeepWorlds(SLAM_16, EIGHT_HEARTS, 1, makeRng(4));
    // Partner's sampled hand is one card short: the surrendered card is
    // scripted back through the engine give-card flow.
    expect(worlds[0]!.hands[2]).toHaveLength(9);
    const score = playoutKeeps(SLAM_16, keep, EIGHT_HEARTS, worlds[0]!, makeRng(5));
    expect(Number.isFinite(score)).toBe(true);
  });

  it('rejects hand sizes no exchange can produce', () => {
    expect(() =>
      chooseKeepsByRollout(STRONG_15.slice(0, 10), EIGHT_HEARTS, makeRng(1)),
    ).toThrow(/15 or 16/);
    expect(() => chooseKeepsByRollout(SLAM_16, bid(NULLA), makeRng(1))).toThrow(/slam/);
  });
});

describe('determinism (AC-3)', () => {
  it('identical (cards, contract, seed) produce identical keeps', () => {
    const cases: readonly (readonly [readonly Card[], Bid])[] = [
      [STRONG_15, EIGHT_HEARTS],
      [IMPROVABLE_15, EIGHT_HEARTS],
      [LOW_15, bid(NULLA)],
      [LOW_15, bid(DNULLA)],
      [SLAM_16, EIGHT_HEARTS],
    ];
    for (const [cards, contract] of cases) {
      const a = chooseKeepsByRollout(cards, contract, makeRng(1234), { worlds: 12 });
      const b = chooseKeepsByRollout(cards, contract, makeRng(1234), { worlds: 12 });
      expect(a).toEqual(b);
    }
  });

  it('the evaluator is deterministic over fixed shared worlds', () => {
    const worlds = sampleKeepWorlds(IMPROVABLE_15, EIGHT_HEARTS, 10, makeRng(21));
    const keep = medium.chooseKeeps(IMPROVABLE_15, EIGHT_HEARTS);
    const a = evaluateKeeps(IMPROVABLE_15, keep, EIGHT_HEARTS, worlds, makeRng(22));
    const b = evaluateKeeps(IMPROVABLE_15, keep, EIGHT_HEARTS, worlds, makeRng(22));
    expect(a).toBe(b);
  });

  it('exposes the packet floor of 30 worlds as the default', () => {
    expect(KEEP_WORLDS).toBe(30);
  });
});
