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
  IND,
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
import { DEFAULT_PARAMS, MediumPolicy, ORACLE_BID_HEADROOM, mergeParams } from '../src/index.js';

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
        bid: policy.chooseBid(
          hand,
          auction.ladderPos,
          mayIndicate,
          { seat, indications: auction.indications, scores: state.game.scores },
          rng,
        ),
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
        { declarer: play.declarer, tricks: play.tricks },
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
/** Oracle-headroom instance: replays the fixture's choose_bid contexts. */
const oracleMedium = new MediumPolicy(
  mergeParams(DEFAULT_PARAMS, { bidding: { headroom: ORACLE_BID_HEADROOM } }),
);
const NO_SIGNALS = { seat: 0, indications: [], scores: [0, 0] } as const;
/**
 * Play context that makes seat 0 a DEFENDER with no history — the declarer-side
 * trump-drawing branch (fh-n2n) never fires, so these calls pin the original
 * oracle behavior (which is exactly what the parity fixture recorded).
 */
const DEFENDER_CTX = { declarer: 1, tricks: [] } as const;

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
    expect(medium.chooseBid(HAND_A, -1, true, NO_SIGNALS, noRng)).toEqual(bid(NUM, 7, 2));
    expect(medium.chooseBid(HAND_B, -1, true, NO_SIGNALS, noRng)).toEqual(bid('PASS'));
    expect(medium.chooseBid(HAND_C, -1, true, NO_SIGNALS, noRng)).toEqual(bid(NULLA));
    // D is even lower on average but the joker vetoes nulla.
    expect(medium.chooseBid(HAND_D, -1, true, NO_SIGNALS, noRng)).toEqual(bid('PASS'));
  });

  it('only bids nulla while the nulla rung is still above ladderPos', () => {
    const nullaIdx = 5; // LADDER: 7S..7NT then NULLA
    expect(medium.chooseBid(HAND_C, nullaIdx - 1, false, NO_SIGNALS, noRng)).toEqual(bid(NULLA));
    expect(medium.chooseBid(HAND_C, nullaIdx, false, NO_SIGNALS, noRng)).toEqual(bid('PASS'));
  });
});

// ---------------------------------------------------------------------------
// fh-zpg: a partner indication is a received signal, not just a sent one
// ---------------------------------------------------------------------------

describe('partner indication support (fh-zpg)', () => {
  // Hearts support without an own opening: JH KH 6H 5H (est 2.95 in hearts),
  // AS as the only side trick. Every strain sits below the 4.5 needed to
  // open or indicate, so alone this hand passes.
  const SUPPORT_HAND = [
    makeCard(3, 11),
    makeCard(3, 13),
    makeCard(3, 6),
    makeCard(3, 5),
    makeCard(0, 14),
    makeCard(0, 5),
    makeCard(1, 6),
    makeCard(1, 7),
    makeCard(2, 4),
    makeCard(2, 8),
  ];
  const partnerHearts = { seat: 0, indications: [{ seat: 2, bid: bid(IND, 6, 3) }], scores: [0, 0] } as const;

  it('passes the support hand when nobody has indicated', () => {
    expect(medium.chooseBid(SUPPORT_HAND, -1, true, NO_SIGNALS, noRng)).toEqual(bid('PASS'));
  });

  it('bids 7H on the same hand after partner indicates hearts', () => {
    expect(medium.chooseBid(SUPPORT_HAND, -1, true, partnerHearts, noRng)).toEqual(
      bid(NUM, 7, 3),
    );
  });

  it('ignores the identical indication from an opponent', () => {
    const opponentHearts = { seat: 0, indications: [{ seat: 1, bid: bid(IND, 6, 3) }], scores: [0, 0] } as const;
    expect(medium.chooseBid(SUPPORT_HAND, -1, true, opponentHearts, noRng)).toEqual(bid('PASS'));
  });

  it('does not abandon a clearly stronger own suit for the signal', () => {
    // HAND_A bids 7D on raw strength 5.45; partner's spade indication lifts
    // spades only to 3.15 + 2.0 = 5.15, so the own diamond plan holds.
    const partnerSpades = { seat: 0, indications: [{ seat: 2, bid: bid(IND, 6, 0) }], scores: [0, 0] } as const;
    expect(medium.chooseBid(HAND_A, -1, true, partnerSpades, noRng)).toEqual(bid(NUM, 7, 2));
  });
});

// ---------------------------------------------------------------------------
// fh-e52: endgame aggression — the game score relaxes the bid gate
// ---------------------------------------------------------------------------

describe('endgame aggression (fh-e52)', () => {
  // JH KH 6H 5H (hearts est 2.20: bower, honor, two lows) over junk. Below
  // the est >= 3.0 opening bar at the tuned headroom (fh-c6i), inside the
  // stretched gate (2.20 + 4.0 + 1.5 >= 7) once the opponents threaten to
  // go out.
  const STRETCH_HAND = [
    makeCard(3, 11),
    makeCard(3, 13),
    makeCard(3, 6),
    makeCard(3, 5),
    makeCard(0, 4),
    makeCard(0, 5),
    makeCard(1, 6),
    makeCard(1, 7),
    makeCard(2, 4),
    makeCard(2, 8),
  ];
  // QH 6H 5H over junk (hearts est 1.25): one tier weaker, so it needs the
  // desperate stretch (opp >= 460, 1.25 + 4.0 + 2.5 >= 7) rather than the
  // plain endgame one (1.25 + 4.0 + 1.5 < 7).
  const WEAK_HAND = [
    makeCard(3, 12),
    makeCard(3, 6),
    makeCard(3, 5),
    makeCard(0, 4),
    makeCard(0, 5),
    makeCard(1, 6),
    makeCard(1, 7),
    makeCard(2, 4),
    makeCard(2, 8),
    makeCard(2, 9),
  ];
  const at = (seat: number, scores: readonly [number, number]) =>
    ({ seat, indications: [], scores }) as const;

  it('passes the stretch hand at level scores', () => {
    expect(medium.chooseBid(STRETCH_HAND, -1, false, at(0, [0, 0]), noRng)).toEqual(bid('PASS'));
  });

  it('bids 7H on the same hand when the opponents can win off this auction', () => {
    expect(medium.chooseBid(STRETCH_HAND, -1, false, at(0, [0, 400]), noRng)).toEqual(
      bid(NUM, 7, 3),
    );
  });

  it('activates exactly when opp score + cheapest contract reaches 500', () => {
    expect(medium.chooseBid(STRETCH_HAND, -1, false, at(0, [0, 350]), noRng)).toEqual(bid('PASS'));
    expect(medium.chooseBid(STRETCH_HAND, -1, false, at(0, [0, 360]), noRng)).toEqual(
      bid(NUM, 7, 3),
    );
  });

  it('orients the threat by the seat side, not raw score order', () => {
    // Same 400 on side 0: an opponent seat stretches, a side-0 seat does not.
    expect(medium.chooseBid(STRETCH_HAND, -1, false, at(1, [400, 0]), noRng)).toEqual(
      bid(NUM, 7, 3),
    );
    expect(medium.chooseBid(STRETCH_HAND, -1, false, at(0, [400, 0]), noRng)).toEqual(
      bid('PASS'),
    );
  });

  it('stretches further once defender tricks alone can end the game', () => {
    expect(medium.chooseBid(WEAK_HAND, -1, false, at(0, [0, 400]), noRng)).toEqual(bid('PASS'));
    expect(medium.chooseBid(WEAK_HAND, -1, false, at(0, [0, 460]), noRng)).toEqual(
      bid(NUM, 7, 3),
    );
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
          // Bidding POLICY diverges from the oracle by design (fh-c6i tuned
          // headroom); parity replays at the oracle's own headroom, which
          // pins everything else about choose_bid exactly.
          const b = oracleMedium.chooseBid(
            rec.hand as Card[],
            rec.ladder_pos as number,
            rec.may_indicate as boolean,
            NO_SIGNALS,
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
              DEFENDER_CTX,
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
      medium.choosePlay(0, legal, legal, plays, null, ledSpades, bid(NULLA), DEFENDER_CTX, noRng),
    ).toBe(makeCard(0, 10));
  });

  it('lose-all: forced to win, sheds the most dangerous card', () => {
    const plays = [{ seat: 1, card: makeCard(0, 5) }];
    const legal = [makeCard(0, 13), makeCard(0, 14)];
    expect(
      medium.choosePlay(0, legal, legal, plays, null, ledSpades, bid(NULLA), DEFENDER_CTX, noRng),
    ).toBe(makeCard(0, 14));
  });

  it('numbered: wins as cheaply as possible', () => {
    const plays = [{ seat: 1, card: makeCard(0, 10) }];
    const legal = [makeCard(0, 5), makeCard(0, 11), makeCard(0, 14)];
    expect(
      medium.choosePlay(0, legal, legal, plays, 3, ledSpades, HEARTS10, DEFENDER_CTX, noRng),
    ).toBe(makeCard(0, 11));
  });

  it('numbered: cannot win, sheds the cheapest card', () => {
    const plays = [{ seat: 1, card: makeCard(0, 14) }];
    const legal = [makeCard(0, 5), makeCard(0, 11)];
    expect(
      medium.choosePlay(0, legal, legal, plays, 3, ledSpades, HEARTS10, DEFENDER_CTX, noRng),
    ).toBe(makeCard(0, 5));
  });
});

// ---------------------------------------------------------------------------
// fh-n2n AC-2: declarer-side trump drawing
// ---------------------------------------------------------------------------

describe('declarer-side trump drawing (fh-n2n)', () => {
  // Hearts trump: the 13 trump cards are the joker, JH (right bower),
  // JD (left bower), and hearts 4-10, Q, K, A.
  const HEARTS = 3;
  const JOKER_CARD = JOKER;
  const RIGHT_BOWER = makeCard(3, 11);
  const LEFT_BOWER = makeCard(2, 11);
  const ACE_SPADES = makeCard(0, 14);
  const KING_SPADES = makeCard(0, 13);
  const FIVE_CLUBS = makeCard(1, 5);
  const HAND = [JOKER_CARD, RIGHT_BOWER, ACE_SPADES, KING_SPADES, FIVE_CLUBS];

  /** A completed trick; only `plays` matters to Medium's card counting. */
  const trick = (cards: readonly Card[]) => ({
    leader: 1,
    ledSuit: HEARTS,
    plays: cards.map((card, i) => ({ seat: (1 + i) % 4, card })),
    winner: 1,
  });

  // 8 natural hearts down: KH, AH, and the left bower are still out.
  const eightHeartsDown = [
    trick([makeCard(3, 4), makeCard(3, 5), makeCard(3, 6), makeCard(3, 7)]),
    trick([makeCard(3, 8), makeCard(3, 9), makeCard(3, 10), makeCard(3, 12)]),
  ];
  // All 11 trumps outside the bot's hand are down: none are live anymore.
  const allTrumpsDown = [
    ...eightHeartsDown,
    trick([makeCard(3, 13), makeCard(3, 14), LEFT_BOWER, makeCard(0, 4)]),
  ];

  it('leads boss trump on consecutive leads while opponents may hold trump', () => {
    expect(
      medium.choosePlay(0, HAND, HAND, [], HEARTS, null, HEARTS10, { declarer: 0, tricks: [] }, noRng),
    ).toBe(JOKER_CARD);
    expect(
      medium.choosePlay(
        0,
        HAND,
        HAND,
        [],
        HEARTS,
        null,
        HEARTS10,
        { declarer: 0, tricks: eightHeartsDown },
        noRng,
      ),
    ).toBe(JOKER_CARD);
  });

  // fh-1em AC-1: the draw is the WINNING BIDDER's alone. The partner holds the
  // same joker + right bower here and still must not lead trump.
  it("declarer's partner does NOT draw trump, even holding the boss trumps", () => {
    expect(
      medium.choosePlay(2, HAND, HAND, [], HEARTS, null, HEARTS10, { declarer: 0, tricks: [] }, noRng),
    ).toBe(KING_SPADES);
  });

  it('switches to cashing side winners once trump is exhausted', () => {
    expect(
      medium.choosePlay(
        0,
        HAND,
        HAND,
        [],
        HEARTS,
        null,
        HEARTS10,
        { declarer: 0, tricks: allTrumpsDown },
        noRng,
      ),
    ).toBe(ACE_SPADES);
  });

  it('draws from surplus trump length even without the boss', () => {
    // 9 trumps down, only the joker is out; three low trumps beat it on length.
    const nineDown = [
      trick([makeCard(3, 7), makeCard(3, 8), makeCard(3, 9), makeCard(3, 10)]),
      trick([makeCard(3, 12), makeCard(3, 13), makeCard(3, 14), RIGHT_BOWER]),
      trick([LEFT_BOWER, makeCard(0, 4), makeCard(0, 5), makeCard(0, 6)]),
    ];
    const hand = [makeCard(3, 4), makeCard(3, 5), makeCard(3, 6), ACE_SPADES];
    expect(
      medium.choosePlay(
        0,
        hand,
        hand,
        [],
        HEARTS,
        null,
        HEARTS10,
        { declarer: 0, tricks: nineDown },
        noRng,
      ),
    ).toBe(makeCard(3, 6));
  });

  it('draws trump from a strong holding without the joker (fh-61z gate retune)', () => {
    // Right bower + three low trumps, joker unseen. The fh-n2n gate refused
    // here: the right bower is not boss over ALL unseen trumps (the joker is
    // out there somewhere), and 4 own trumps never exceeded the 9 unseen —
    // even though most of those 9 sit with the partner or in the middle.
    const hand = [
      RIGHT_BOWER,
      makeCard(3, 4),
      makeCard(3, 5),
      makeCard(3, 6),
      ACE_SPADES,
      KING_SPADES,
      FIVE_CLUBS,
    ];
    expect(
      medium.choosePlay(0, hand, hand, [], HEARTS, null, HEARTS10, { declarer: 0, tricks: [] }, noRng),
    ).toBe(RIGHT_BOWER);
  });

  it('does not bleed a lone low trump into a war it cannot win', () => {
    const hand = [makeCard(3, 4), ACE_SPADES, FIVE_CLUBS];
    expect(
      medium.choosePlay(0, hand, hand, [], HEARTS, null, HEARTS10, { declarer: 0, tricks: [] }, noRng),
    ).toBe(ACE_SPADES);
  });

  it('as a defender the old lead is unchanged', () => {
    expect(
      medium.choosePlay(0, HAND, HAND, [], HEARTS, null, HEARTS10, DEFENDER_CTX, noRng),
    ).toBe(KING_SPADES);
  });

  // fh-1em AC-2: the anti-trump-lead rule is explicit for defenders too, not
  // just an accident of the power sort.
  it('a defender holding trump and side cards leads a side card', () => {
    const hand = [JOKER_CARD, RIGHT_BOWER, LEFT_BOWER, makeCard(3, 14), FIVE_CLUBS];
    const chosen = medium.choosePlay(
      0,
      hand,
      hand,
      [],
      HEARTS,
      null,
      HEARTS10,
      DEFENDER_CTX,
      noRng,
    );
    expect(chosen).toBe(FIVE_CLUBS);
  });

  it('a defender void in side suits is allowed the forced trump lead', () => {
    const hand = [JOKER_CARD, RIGHT_BOWER, makeCard(3, 4)];
    const chosen = medium.choosePlay(
      0,
      hand,
      hand,
      [],
      HEARTS,
      null,
      HEARTS10,
      DEFENDER_CTX,
      noRng,
    );
    expect(hand).toContain(chosen);
    expect(chosen).toBe(makeCard(3, 4)); // cheapest trump, not the boss
  });

  it("the declarer's partner void in side suits may also lead trump", () => {
    const hand = [makeCard(3, 4), makeCard(3, 5)];
    const chosen = medium.choosePlay(
      2,
      hand,
      hand,
      [],
      HEARTS,
      null,
      HEARTS10,
      { declarer: 0, tricks: [] },
      noRng,
    );
    expect(chosen).toBe(makeCard(3, 4));
  });
});

// ---------------------------------------------------------------------------
// fh-2wt: declarer-side lead in a no-trump contract cashes from the top
// ---------------------------------------------------------------------------

describe('declarer-side no-trump lead (fh-2wt)', () => {
  const NT_CONTRACT = bid(NUM, 8, 4); // strain 4 = no-trump, so trump === null
  const ACE_SPADES = makeCard(0, 14);
  const KING_SPADES = makeCard(0, 13);
  const ACE_CLUBS = makeCard(1, 14);
  const FIVE_DIAMONDS = makeCard(2, 5);
  const SIX_DIAMONDS = makeCard(2, 6);
  const SEVEN_DIAMONDS = makeCard(2, 7);

  /** A completed trick; only `plays` matters to Medium's card counting. */
  const trick = (cards: readonly Card[]) => ({
    leader: 1,
    ledSuit: 0,
    plays: cards.map((card, i) => ({ seat: (1 + i) % 4, card })),
    winner: 1,
  });
  // A trick that has already put the joker face-up on the table.
  const jokerSeen = [trick([JOKER, makeCard(3, 4), makeCard(3, 5), makeCard(3, 6)])];

  it('leads the joker first while holding it (ultimate cashing lead)', () => {
    const hand = [JOKER, ACE_SPADES, ACE_CLUBS, FIVE_DIAMONDS];
    expect(
      medium.choosePlay(0, hand, hand, [], null, null, NT_CONTRACT, { declarer: 0, tricks: [] }, noRng),
    ).toBe(JOKER);
  });

  it('cashes the top side boss once the joker has been seen', () => {
    const hand = [ACE_SPADES, KING_SPADES, ACE_CLUBS, FIVE_DIAMONDS];
    expect(
      medium.choosePlay(
        0,
        hand,
        hand,
        [],
        null,
        null,
        NT_CONTRACT,
        { declarer: 0, tricks: jokerSeen },
        noRng,
      ),
    ).toBe(ACE_SPADES);
  });

  it('AC-2: with the joker unseen, aces are not bosses — leads high from the longest suit', () => {
    const hand = [ACE_SPADES, ACE_CLUBS, FIVE_DIAMONDS, SIX_DIAMONDS, SEVEN_DIAMONDS];
    // Boss path would cash an ace; joker-aware detection rejects it and the
    // lead-from-strength path opens the top of the 3-card diamond suit.
    expect(
      medium.choosePlay(0, hand, hand, [], null, null, NT_CONTRACT, { declarer: 0, tricks: [] }, noRng),
    ).toBe(SEVEN_DIAMONDS);
  });

  it('never opens with its lowest card as NT declarer', () => {
    const hand = [FIVE_DIAMONDS, SIX_DIAMONDS, SEVEN_DIAMONDS, ACE_SPADES, ACE_CLUBS];
    const card = medium.choosePlay(
      0,
      hand,
      hand,
      [],
      null,
      null,
      NT_CONTRACT,
      { declarer: 0, tricks: [] },
      noRng,
    );
    expect(card).not.toBe(FIVE_DIAMONDS);
  });

  it('as an NT defender the legacy lead is unchanged (branch is declarer-only)', () => {
    const FIVE_SPADES = makeCard(0, 5);
    const hand = [FIVE_SPADES, ACE_CLUBS];
    // Declarer would open the ace; a defender keeps the legacy firstMinBy lead.
    expect(
      medium.choosePlay(0, hand, hand, [], null, null, NT_CONTRACT, { declarer: 1, tricks: [] }, noRng),
    ).toBe(FIVE_SPADES);
  });
});

// ---------------------------------------------------------------------------
// fh-61z defect B: partner guardrail in the follow logic
// ---------------------------------------------------------------------------

describe('partner guardrail (fh-61z)', () => {
  // Hearts trump throughout; the bot sits at seat 0, partner at seat 2.
  const HEARTS = 3;
  const ACE_SPADES = makeCard(0, 14);
  const KING_SPADES = makeCard(0, 13);
  const QUEEN_SPADES = makeCard(0, 12);
  const LED_SPADES = 0;
  /** A completed trick; only the played cards matter to the card counting. */
  const trick = (cards: readonly Card[]) => ({
    leader: 1,
    ledSuit: LED_SPADES,
    plays: cards.map((card, i) => ({ seat: (1 + i) % 4, card })),
    winner: 1,
  });

  it('void behind the partner winning ace: sluffs, never ruffs', () => {
    // Partner led the ace of spades, seat 3 followed low; the bot is void
    // with a trump in hand and seat 1 still to act.
    const plays = [
      { seat: 2, card: ACE_SPADES },
      { seat: 3, card: makeCard(0, 5) },
    ];
    const hand = [makeCard(3, 5), makeCard(1, 4), makeCard(1, 6)];
    expect(
      medium.choosePlay(
        0,
        hand,
        hand,
        plays,
        HEARTS,
        LED_SPADES,
        HEARTS10,
        { declarer: 1, tricks: [] },
        noRng,
      ),
    ).toBe(makeCard(1, 4));
  });

  it('following behind the partner boss honor: plays low', () => {
    // The ace of spades is down, the bot holds the king, so the partner's
    // queen is boss over anything the last seat could hold. The old logic
    // overtook with the king anyway.
    const gone = trick([ACE_SPADES, makeCard(0, 4), makeCard(0, 6), makeCard(0, 7)]);
    const plays = [
      { seat: 2, card: QUEEN_SPADES },
      { seat: 3, card: makeCard(0, 8) },
    ];
    const hand = [KING_SPADES, makeCard(0, 5), makeCard(1, 6)];
    const legal = [KING_SPADES, makeCard(0, 5)];
    expect(
      medium.choosePlay(
        0,
        hand,
        legal,
        plays,
        HEARTS,
        LED_SPADES,
        HEARTS10,
        { declarer: 1, tricks: [gone] },
        noRng,
      ),
    ).toBe(makeCard(0, 5));
  });

  it('partner winning with a non-boss card: overtaking with the boss is still allowed', () => {
    // Same trick, but the unseen king can beat the partner's queen and the
    // bot's ace beats the king — third-hand-high still applies.
    const plays = [
      { seat: 2, card: QUEEN_SPADES },
      { seat: 3, card: makeCard(0, 8) },
    ];
    const hand = [ACE_SPADES, makeCard(0, 5), makeCard(1, 6)];
    const legal = [ACE_SPADES, makeCard(0, 5)];
    expect(
      medium.choosePlay(
        0,
        hand,
        legal,
        plays,
        HEARTS,
        LED_SPADES,
        HEARTS10,
        { declarer: 1, tricks: [] },
        noRng,
      ),
    ).toBe(ACE_SPADES);
  });

  it('last to act behind a winning partner: always ducks', () => {
    // Nobody plays after the bot, so the partner's queen keeps the trick no
    // matter what is unseen.
    const plays = [
      { seat: 1, card: makeCard(0, 4) },
      { seat: 2, card: QUEEN_SPADES },
      { seat: 3, card: makeCard(0, 8) },
    ];
    const hand = [ACE_SPADES, makeCard(0, 5), makeCard(1, 6)];
    const legal = [ACE_SPADES, makeCard(0, 5)];
    expect(
      medium.choosePlay(
        0,
        hand,
        legal,
        plays,
        HEARTS,
        LED_SPADES,
        HEARTS10,
        { declarer: 1, tricks: [] },
        noRng,
      ),
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
