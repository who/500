/**
 * Medium bot spec — the issue's acceptance criteria:
 *   AC-1: suitStrength / lowness match pinned oracle values on fixed hands.
 *   AC-2: TS Medium reproduces the recorded Python HeuristicPolicy decisions
 *         on the 100-context fixture exactly (fixtures/medium-decisions.jsonl,
 *         regenerated only by `uv run python gen_medium_fixture.py` at the
 *         repo root).
 *   AC-3: 4 Medium bots complete 500 seeded hands with zero illegal actions
 *         and at least one nulla contract. The criterion's "at least one
 *         slam" cannot happen in a faithful port: the slam gate (est >= 8.0)
 *         is unreachable under random deals — trace_500.py documents a max
 *         observed strength of ~6.9 over 5000 hands, and a 200k-pickup scan
 *         during this port peaked at 7.8. Slam coverage is instead pinned
 *         directly (the gate fires on a constructed >= 8.0 pickup) and the
 *         full declare -> partner card -> 16-card keep -> solo play flow is
 *         driven end-to-end through the engine by a threshold-lowered test
 *         subclass. Recorded as a plan-gap on fh-f2a.2.
 *
 * The GameState -> Policy driver is copied from easy.spec.ts; the sim
 * harness leaf promotes it to shared code.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Action, Bid, BidKind, Card, GameState, Rng, TrickPlay } from '@five-hundred/engine';
import {
  JOKER,
  NULLA,
  NUM,
  applyAction,
  bid,
  legalPlaysFor,
  makeCard,
  makeRng,
  newGame,
  toActSeat,
} from '@five-hundred/engine';
import type { Policy } from '../src/index.js';
import { MediumPolicy } from '../src/index.js';

// ---------------------------------------------------------------------------
// GameState -> Policy driver (mirrors the oracle's play_hand call sites)
// ---------------------------------------------------------------------------

function botAction(state: GameState, policies: readonly Policy[], rng: Rng): Action {
  if (state.phase === 'handScored') return { type: 'nextHand', seat: 0 };
  const seat = toActSeat(state);
  if (seat === null) throw new Error(`no seat to act during ${state.phase}`);
  const policy = policies[seat] as Policy;
  const contract = state.contract as Bid;
  const hand = state.hands[seat] ?? [];
  switch (state.phase) {
    case 'auction': {
      const auction = state.auction;
      if (auction === null) throw new Error('auction phase without auction state');
      const mayIndicate = auction.declarer === null && !auction.indicated[seat];
      return {
        type: 'bid',
        seat,
        bid: policy.chooseBid(hand, auction.ladderPos, mayIndicate, rng),
      };
    }
    case 'slamDecision':
      return policy.considerSlam(hand, contract, rng)
        ? { type: 'declareSlam', seat }
        : { type: 'declineSlam', seat };
    case 'partnerCard':
      return { type: 'giveCard', seat, card: policy.giveBestCard(hand, contract, rng) };
    case 'middleExchange':
      return { type: 'discardKeeps', seat, keeps: policy.chooseKeeps(hand, contract, rng) };
    case 'play': {
      const play = state.play;
      if (play === null) throw new Error('play phase without play state');
      const legal = legalPlaysFor(play, seat);
      const card = policy.choosePlay(
        seat,
        play.hands[seat] ?? [],
        legal,
        play.plays,
        play.trump,
        play.ledSuit,
        contract,
        rng,
      );
      if (card === JOKER && play.trump === null && play.ledSuit === null) {
        const rest = (play.hands[seat] ?? []).filter((c) => c !== JOKER);
        return {
          type: 'playCard',
          seat,
          card,
          jokerSuit: policy.chooseJokerSuit(rest, contract, rng),
        };
      }
      return { type: 'playCard', seat, card };
    }
    default:
      throw new Error(`no bot action for phase ${state.phase}`);
  }
}

interface HeadlessRun {
  readonly hands: number;
  readonly contractKinds: BidKind[];
  readonly slams: number;
}

/** Drive a table of `policies` through applyAction until `targetHands` score. */
function runHeadless(
  policies: readonly Policy[],
  firstSeed: number,
  targetHands: number,
  rngSeed: number,
): HeadlessRun {
  const rng = makeRng(rngSeed);
  const contractKinds: BidKind[] = [];
  let slams = 0;
  let hands = 0;
  let seed = firstSeed;
  let state = newGame(seed);
  const maxSteps = targetHands * 2000;
  for (let step = 0; hands < targetHands; step++) {
    if (step >= maxSteps) throw new Error(`stuck in ${state.phase} after ${step} steps`);
    if (state.phase === 'gameOver') {
      state = newGame(++seed);
      continue;
    }
    const action = botAction(state, policies, rng);
    const result = applyAction(state, action);
    if (!result.ok) {
      throw new Error(
        `illegal bot action ${action.type} by seat ${action.seat}: ${result.error.message}`,
      );
    }
    if (action.type === 'declareSlam') slams++;
    if (result.state.phase === 'handScored' && state.phase === 'play') {
      hands++;
      contractKinds.push((state.contract as Bid).kind);
    }
    state = result.state;
  }
  return { hands, contractKinds, slams };
}

/** Medium never draws from the Rng; a throwing stub proves it. */
const noRng: Rng = {
  random: () => {
    throw new Error('MediumPolicy must not draw randomness');
  },
  int: () => {
    throw new Error('MediumPolicy must not draw randomness');
  },
  shuffle: () => {
    throw new Error('MediumPolicy must not draw randomness');
  },
};

const HEARTS10 = bid(NUM, 10, 3);
const medium = new MediumPolicy();

// ---------------------------------------------------------------------------
// AC-1: pinned oracle strength / lowness values on fixed hands
// ---------------------------------------------------------------------------

// Hand A: joker, both red bowers, AH KH 5H, AS, KC, QD, 4S.
const HAND_A = [0, 10, 20, 29, 30, 34, 40, 42, 43, JOKER];
// Hand B: no joker; NT-flavored honors AS AC KD QH over low fill.
const HAND_B = [1, 5, 10, 13, 17, 21, 22, 31, 36, 41];
// Hand C: nulla-shaped — every suit's 4 and 5, plus 6S and 7C, no joker.
const HAND_C = [0, 1, 2, 11, 12, 14, 22, 23, 33, 34];
// Hand D: hand C's shape but with the joker replacing 6S/7C fill.
const HAND_D = [0, 1, 2, 11, 12, 22, 23, 33, 34, JOKER];

describe('AC-1: pinned suit strength and lowness', () => {
  it('suitStrength matches the oracle per strain (identical float ops)', () => {
    expect(medium.suitStrength(HAND_A, 0)).toBe(3.1500000000000004);
    expect(medium.suitStrength(HAND_A, 1)).toBe(3.3);
    expect(medium.suitStrength(HAND_A, 2)).toBe(5.45);
    expect(medium.suitStrength(HAND_A, 3)).toBe(5.35);
    expect(medium.suitStrength(HAND_A, 4)).toBe(4.0);
    expect(medium.suitStrength(HAND_B, 2)).toBe(2.4000000000000004);
    expect(medium.suitStrength(HAND_B, 3)).toBe(2.6500000000000004);
    expect(medium.suitStrength(HAND_B, 4)).toBe(2.5);
    expect(medium.suitStrength(HAND_C, 0)).toBe(1.0499999999999998);
    expect(medium.suitStrength(HAND_C, 4)).toBe(0.0);
    expect(medium.suitStrength(HAND_D, 0)).toBe(2.0500000000000003);
    expect(medium.suitStrength(HAND_D, 4)).toBe(1.0);
  });

  it('lowness matches the oracle', () => {
    expect(medium.lowness(HAND_A)).toBe(3.8);
    expect(medium.lowness(HAND_B)).toBe(5.6);
    expect(medium.lowness(HAND_C)).toBe(10.1);
    expect(medium.lowness(HAND_D)).toBe(9.3);
  });

  it('derives the pinned bids: 7D on A, PASS on B, NULLA on C, PASS on D', () => {
    // A: best strain D at 5.45 (both red jacks are bowers for diamonds too,
    // and hearts' honors count for less than two side aces).
    expect(medium.chooseBid(HAND_A, -1, true, noRng)).toEqual(bid(NUM, 7, 2));
    expect(medium.chooseBid(HAND_B, -1, true, noRng)).toEqual(bid('PASS'));
    expect(medium.chooseBid(HAND_C, -1, true, noRng)).toEqual(bid(NULLA));
    // D is even lower on average but the joker vetoes nulla.
    expect(medium.chooseBid(HAND_D, -1, true, noRng)).toEqual(bid('PASS'));
  });

  it('only bids nulla while the nulla rung is still above ladderPos', () => {
    const nullaIdx = 5; // LADDER: 7S..7NT then NULLA
    expect(medium.chooseBid(HAND_C, nullaIdx - 1, false, noRng)).toEqual(bid(NULLA));
    expect(medium.chooseBid(HAND_C, nullaIdx, false, noRng)).toEqual(bid('PASS'));
  });
});

// ---------------------------------------------------------------------------
// AC-2: exact replay of the 100-context oracle fixture
// ---------------------------------------------------------------------------

interface FixtureBid {
  readonly kind: BidKind;
  readonly level: number;
  readonly strain: number;
}

interface FixtureRecord {
  readonly v: number;
  readonly i: number;
  readonly method: string;
  readonly result: FixtureBid | Card[] | Card | number | boolean;
  readonly hand?: Card[];
  readonly hand15?: Card[];
  readonly cards?: Card[];
  readonly legal?: Card[];
  readonly trick_plays?: [number, Card][];
  readonly trump?: number | null;
  readonly led_suit?: number | null;
  readonly ladder_pos?: number;
  readonly may_indicate?: boolean;
  readonly contract?: FixtureBid;
}

const FIXTURE: FixtureRecord[] = readFileSync(
  new URL('./fixtures/medium-decisions.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as FixtureRecord);

const toBid = (b: FixtureBid): Bid => bid(b.kind, b.level, b.strain);
const toPlays = (plays: readonly [number, Card][]): TrickPlay[] =>
  plays.map(([seat, card]) => ({ seat, card }));

describe('AC-2: 100-context oracle decision parity', () => {
  it('loads exactly 100 contexts covering every Policy method', () => {
    expect(FIXTURE).toHaveLength(100);
    expect(new Set(FIXTURE.map((r) => r.method))).toEqual(
      new Set([
        'choose_bid',
        'choose_keeps',
        'consider_slam',
        'give_best_card',
        'choose_joker_suit',
        'choose_play',
      ]),
    );
  });

  it.each(FIXTURE.map((r) => [r.i, r.method, r] as const))(
    'context %i (%s) matches the oracle decision',
    (_i, method, rec) => {
      switch (method) {
        case 'choose_bid': {
          const b = medium.chooseBid(
            rec.hand as Card[],
            rec.ladder_pos as number,
            rec.may_indicate as boolean,
            noRng,
          );
          const want = rec.result as FixtureBid;
          expect({ kind: b.kind, level: b.level, strain: b.strain }).toEqual(want);
          break;
        }
        case 'choose_keeps':
          expect(
            medium.chooseKeeps(rec.cards as Card[], toBid(rec.contract as FixtureBid), noRng),
          ).toEqual(rec.result);
          break;
        case 'consider_slam':
          expect(
            medium.considerSlam(rec.hand15 as Card[], toBid(rec.contract as FixtureBid), noRng),
          ).toBe(rec.result);
          break;
        case 'give_best_card':
          expect(
            medium.giveBestCard(rec.hand as Card[], toBid(rec.contract as FixtureBid)),
          ).toBe(rec.result);
          break;
        case 'choose_joker_suit':
          expect(
            medium.chooseJokerSuit(rec.hand as Card[], toBid(rec.contract as FixtureBid), noRng),
          ).toBe(rec.result);
          break;
        case 'choose_play':
          expect(
            medium.choosePlay(
              0,
              rec.hand as Card[],
              rec.legal as Card[],
              toPlays(rec.trick_plays as [number, Card][]),
              rec.trump as number | null,
              rec.led_suit as number | null,
              toBid(rec.contract as FixtureBid),
              noRng,
            ),
          ).toBe(rec.result);
          break;
        default:
          throw new Error(`unknown fixture method ${method}`);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// AC-3: headless Medium table
// ---------------------------------------------------------------------------

describe('AC-3: headless Medium table', () => {
  it('4 Medium bots complete 500 seeded hands, zero illegal actions, >= 1 nulla', () => {
    const table = [new MediumPolicy(), new MediumPolicy(), new MediumPolicy(), new MediumPolicy()];
    const run = runHeadless(table, 1, 500, 20260721);
    expect(run.hands).toBe(500);
    expect(run.contractKinds.filter((k) => k === NULLA).length).toBeGreaterThanOrEqual(1);
    // Faithful Medium never reaches the est >= 8.0 slam gate on random
    // deals (see header); the flow is covered by the two tests below.
    expect(run.slams).toBe(0);
  });

  it('the slam gate fires on a >= 8.0 pickup (pinned est ~8.5)', () => {
    // Joker, JD (left bower), every heart, and two side aces.
    const monster = [
      JOKER,
      makeCard(2, 11),
      ...Array.from({ length: 11 }, (_, i) => makeCard(3, i + 4)),
      makeCard(0, 14),
      makeCard(1, 14),
    ];
    expect(medium.suitStrength(monster, 3)).toBe(8.499999999999998); // oracle repr
    expect(medium.considerSlam(monster, HEARTS10, noRng)).toBe(true);
    // Not on a nulla-type contract, and not below the threshold.
    expect(medium.considerSlam(monster, bid(NULLA), noRng)).toBe(false);
  });

  it('drives the full slam flow legally end-to-end (lowered test threshold)', () => {
    // Medium machinery, easier gate: proves declare -> partner card ->
    // 16-card keep -> solo play stays legal through the real engine.
    class SlamProneMedium extends MediumPolicy {
      override considerSlam(hand15: readonly Card[], contract: Bid): boolean {
        if (contract.kind !== NUM) return false;
        return this.suitStrength(hand15, contract.strain) >= 5.5;
      }
    }
    const table = [
      new SlamProneMedium(),
      new SlamProneMedium(),
      new SlamProneMedium(),
      new SlamProneMedium(),
    ];
    const run = runHeadless(table, 1, 100, 424242);
    expect(run.hands).toBe(100);
    expect(run.slams).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Ported-branch edges (keeps pinned against oracle runs)
// ---------------------------------------------------------------------------

describe('chooseKeeps branches', () => {
  it('void-building: dumps the shortest weak side suit first, ace floor holds', () => {
    // Hearts trump; sides: S x3 (top A), C x3 (top Q), D x4 (top K).
    // Dump order C then S; the ace of spades survives the floor.
    const cards = [2, 5, 10, 11, 14, 19, 22, 26, 28, 31, 34, 40, 42, 43, JOKER];
    expect(medium.chooseKeeps(cards, HEARTS10, noRng)).toEqual([
      10, 22, 26, 28, 31, 34, 40, 42, 43, JOKER,
    ]);
  });

  it('fallback: still returns exactly 10 when the void-builder runs dry', () => {
    // 11 hearts + joker + JD + two side ACES: no side card is under the ace
    // floor, so the fallback sheds the aces then the lowest trumps.
    const cards = [10, 21, 29, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, JOKER];
    expect(medium.chooseKeeps(cards, HEARTS10, noRng)).toEqual([
      29, 36, 37, 38, 39, 40, 41, 42, 43, JOKER,
    ]);
  });

  it('lose-all: keeps the ten weakest, rank-sorted, joker strongest', () => {
    const cards = [0, 1, 2, 6, 8, 11, 14, 16, 20, 23, 24, 26, 29, 33, 43];
    expect(medium.chooseKeeps(cards, bid(NULLA), noRng)).toEqual([
      0, 11, 33, 1, 23, 2, 24, 14, 26, 16,
    ]);
  });

  it('keeps 10 from a 16-card post-slam pickup', () => {
    const cards = Array.from({ length: 16 }, (_, i) => (i * 2) as Card);
    const keeps = medium.chooseKeeps(cards, HEARTS10, noRng);
    expect(keeps).toHaveLength(10);
    expect(new Set(keeps).size).toBe(10);
    for (const c of keeps) expect(cards).toContain(c);
  });

  it('handles a hand that is all one suit', () => {
    const cards = Array.from({ length: 11 }, (_, i) => makeCard(0, i + 4)).concat([
      makeCard(1, 4),
      makeCard(1, 5),
      makeCard(1, 6),
      makeCard(1, 7),
    ]);
    const spades = bid(NUM, 8, 0);
    const keeps = medium.chooseKeeps(cards, spades, noRng);
    expect(keeps).toHaveLength(10);
    // All four weak clubs and the lowest spade go.
    expect(keeps.every((c) => c <= 10)).toBe(true);
  });
});

describe('choosePlay branches', () => {
  const ledSpades = 0;

  it('lose-all: ducks with the biggest still-losing card', () => {
    const plays = [{ seat: 1, card: makeCard(0, 12) }]; // QS holds the trick
    const legal = [makeCard(0, 5), makeCard(0, 10), makeCard(0, 14)];
    expect(
      medium.choosePlay(0, legal, legal, plays, null, ledSpades, bid(NULLA), noRng),
    ).toBe(makeCard(0, 10));
  });

  it('lose-all: forced to win, sheds the most dangerous card', () => {
    const plays = [{ seat: 1, card: makeCard(0, 5) }];
    const legal = [makeCard(0, 13), makeCard(0, 14)];
    expect(
      medium.choosePlay(0, legal, legal, plays, null, ledSpades, bid(NULLA), noRng),
    ).toBe(makeCard(0, 14));
  });

  it('numbered: wins as cheaply as possible', () => {
    const plays = [{ seat: 1, card: makeCard(0, 10) }];
    const legal = [makeCard(0, 5), makeCard(0, 11), makeCard(0, 14)];
    expect(
      medium.choosePlay(0, legal, legal, plays, 3, ledSpades, HEARTS10, noRng),
    ).toBe(makeCard(0, 11));
  });

  it('numbered: cannot win, sheds the cheapest card', () => {
    const plays = [{ seat: 1, card: makeCard(0, 14) }];
    const legal = [makeCard(0, 5), makeCard(0, 11)];
    expect(
      medium.choosePlay(0, legal, legal, plays, 3, ledSpades, HEARTS10, noRng),
    ).toBe(makeCard(0, 5));
  });
});

describe('chooseJokerSuit', () => {
  it('names the shortest held suit, first suit on ties', () => {
    const hand = [makeCard(0, 5), makeCard(0, 9), makeCard(1, 12), makeCard(2, 7)];
    expect(medium.chooseJokerSuit(hand, bid(NUM, 8, 4), noRng)).toBe(3); // void hearts
    expect(medium.chooseJokerSuit([makeCard(3, 4)], bid(NULLA), noRng)).toBe(0); // S,C,D all 0
  });
});
