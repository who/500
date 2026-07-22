/**
 * Hard-bot rollout bidding — acceptance criteria for fh-7hw.3:
 *
 *   AC-1  Fixture hands produce sensible contracts: strong hearts bids
 *         hearts, garbage passes, a uniformly-low no-joker hand finds nulla,
 *         a near-certain slam declares while a marginal one does not.
 *   AC-2  Every bid/slam decision over 1000 seeded auction contexts is legal
 *         per engine legalBids.
 *   AC-3  Decisions are deterministic under a fixed seed.
 *
 * Plus the packet's edge cases: ladder top leaves only pass, the Medium
 * indication rule fires verbatim on the pass path, and candidate generation
 * only ever proposes legal raises.
 */

import { describe, expect, it } from 'vitest';
import type { AuctionState, Bid, Card, GameState } from '@five-hundred/engine';
import {
  DECK,
  IND,
  JOKER,
  LADDER,
  NULLA,
  NUM,
  PASS,
  bid,
  bidKey,
  ladderIndex,
  legalBids,
  makeRng,
} from '@five-hundred/engine';
import type { ObservedConstraints } from '../src/index.js';
import {
  GAME_WIN_VALUE,
  MediumPolicy,
  candidateBids,
  chooseBidByRollout,
  considerSlamByRollout,
  samplePartnerIndicationWorld,
  sampleWorld,
  sideZeroGameValue,
} from '../src/index.js';

const S = (r: number): Card => r - 4;
const C = (r: number): Card => 11 + r - 4;
const D = (r: number): Card => 22 + r - 4;
const H = (r: number): Card => 33 + r - 4;

/** Strong hearts: joker, both bowers, A-K-Q-10-9 of trump, two side aces. */
const STRONG_HEARTS: Card[] = [
  JOKER,
  H(11),
  D(11),
  H(14),
  H(13),
  H(12),
  H(10),
  H(9),
  S(14),
  C(14),
];

/** Garbage: queen-high everywhere, too strong-ranked for nulla, no tricks. */
const GARBAGE: Card[] = [S(12), S(9), S(7), C(12), C(8), C(6), D(12), D(9), H(7), H(5)];

/** Uniformly low, no joker, nothing above a 7: a natural nulla hand. */
const LOW_NULLA: Card[] = [S(4), S(5), S(6), C(4), C(5), C(7), D(4), D(6), H(4), H(5)];

/** All 11 hearts plus joker, left bower, and two side aces: 15 for 8H. */
const SLAM_CERTAIN_15: Card[] = [
  JOKER,
  D(11),
  S(14),
  C(14),
  ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(H),
];

/** Decent 7S pickup, but the joker and both bowers are all outstanding. */
const SLAM_MARGINAL_15: Card[] = [
  S(14),
  S(13),
  S(12),
  S(10),
  S(9),
  S(8),
  S(7),
  H(14),
  H(13),
  C(4),
  C(5),
  C(6),
  D(4),
  D(5),
  D(6),
];

/** Minimal consistent auction state: seat 0 to act at the given position. */
function auctionAt(ladderPos: number, mayIndicate: boolean): AuctionState {
  return {
    ladderPos,
    declarer: ladderPos >= 0 ? 1 : null,
    indications: [],
    indicated: [ladderPos < 0 ? !mayIndicate : false, false, false, false],
    history: [],
    turn: 0,
    done: false,
  };
}

function isLegalAt(b: Bid, ladderPos: number, mayIndicate: boolean): boolean {
  const key = bidKey(b);
  return legalBids(auctionAt(ladderPos, mayIndicate), 0).some((l) => bidKey(l) === key);
}

const NO_SIGNALS = { seat: 0, indications: [], scores: [0, 0] } as const;

describe('AC-1 fixture hands', () => {
  it('bids a strong contract on the strong hearts hand', () => {
    // Hearts (est 6.75) or no-trumps (joker plus three aces) are both
    // sound here; the fh-c6i tuned candidate set lets the rollout weigh the
    // higher-scoring NT, so pin only "a numbered contract in one of them".
    const b = chooseBidByRollout(STRONG_HEARTS, -1, true, NO_SIGNALS, makeRng(1));
    expect(b.kind).toBe(NUM);
    expect([3, 4]).toContain(b.strain);
  });

  it('passes the garbage hand at every position', () => {
    // No candidate survives pruning and est is far below the indication
    // threshold, so this is deterministic without any rollout.
    for (const ladderPos of [-1, 4, 10, LADDER.length - 1]) {
      const b = chooseBidByRollout(GARBAGE, ladderPos, ladderPos < 0, NO_SIGNALS, makeRng(2));
      expect(b.kind).toBe(PASS);
    }
  });

  it('finds nulla on the uniformly-low no-joker hand', () => {
    const b = chooseBidByRollout(LOW_NULLA, -1, true, NO_SIGNALS, makeRng(3));
    expect(b.kind).toBe(NULLA);
  });

  it('declares the near-certain slam and declines the marginal one', () => {
    expect(considerSlamByRollout(SLAM_CERTAIN_15, bid(NUM, 8, 3), makeRng(4))).toBe(true);
    expect(considerSlamByRollout(SLAM_MARGINAL_15, bid(NUM, 7, 0), makeRng(5))).toBe(false);
  });

  it('never offers a slam on a non-NUM contract', () => {
    expect(considerSlamByRollout(SLAM_CERTAIN_15, bid(NULLA), makeRng(6))).toBe(false);
  });
});

describe('AC-2 legality over 1000 seeded auction contexts', () => {
  it('every chooseBid output is in the engine legal set', () => {
    const rng = makeRng(42);
    const decide = makeRng(43);
    for (let i = 0; i < 1000; i++) {
      const pool = [...DECK];
      rng.shuffle(pool);
      const hand = pool.slice(0, 10);
      const ladderPos = rng.int(LADDER.length + 1) - 1; // -1 .. ladder top
      const mayIndicate = ladderPos < 0 && rng.random() < 0.5;
      const b = chooseBidByRollout(hand, ladderPos, mayIndicate, NO_SIGNALS, decide, { worlds: 2 });
      expect(
        isLegalAt(b, ladderPos, mayIndicate),
        `context ${i}: ${bidKey(b)} illegal at ladderPos ${ladderPos}`,
      ).toBe(true);
    }
  });

  it('every candidate is a legal raise before any rollout runs', () => {
    const rng = makeRng(44);
    for (let i = 0; i < 500; i++) {
      const pool = [...DECK];
      rng.shuffle(pool);
      const ladderPos = rng.int(LADDER.length + 1) - 1;
      for (const c of candidateBids(pool.slice(0, 10), ladderPos)) {
        expect((ladderIndex(c) as number) > ladderPos).toBe(true);
      }
    }
  });

  it('every considerSlam decision is a plain boolean and never throws', () => {
    const rng = makeRng(45);
    const decide = makeRng(46);
    for (let i = 0; i < 64; i++) {
      const pool = [...DECK];
      rng.shuffle(pool);
      const contract = bid(NUM, 7 + rng.int(4), rng.int(5));
      const answer = considerSlamByRollout(pool.slice(0, 15), contract, decide, { worlds: 2 });
      expect(typeof answer).toBe('boolean');
    }
  });
});

describe('AC-3 determinism under a fixed seed', () => {
  it('chooseBid repeats exactly across identical rng streams', () => {
    const contexts: [Card[], number, boolean][] = [];
    const gen = makeRng(47);
    for (let i = 0; i < 5; i++) {
      const pool = [...DECK];
      gen.shuffle(pool);
      contexts.push([pool.slice(0, 10), gen.int(10) - 1, gen.random() < 0.5]);
    }
    contexts.push([STRONG_HEARTS, -1, true], [LOW_NULLA, -1, true]);
    const first = makeRng(48);
    const second = makeRng(48);
    for (const [hand, ladderPos, mayIndicate] of contexts) {
      const a = chooseBidByRollout(hand, ladderPos, mayIndicate && ladderPos < 0, NO_SIGNALS, first, {
        worlds: 4,
      });
      const b = chooseBidByRollout(hand, ladderPos, mayIndicate && ladderPos < 0, NO_SIGNALS, second, {
        worlds: 4,
      });
      expect(bidKey(a)).toBe(bidKey(b));
    }
  });

  it('considerSlam repeats exactly across identical rng streams', () => {
    const a = considerSlamByRollout(SLAM_MARGINAL_15, bid(NUM, 7, 0), makeRng(49), { worlds: 4 });
    const b = considerSlamByRollout(SLAM_MARGINAL_15, bid(NUM, 7, 0), makeRng(49), { worlds: 4 });
    expect(a).toBe(b);
  });
});

describe('edge cases', () => {
  it('returns pass at the ladder top where nothing can be raised', () => {
    const b = chooseBidByRollout(STRONG_HEARTS, LADDER.length - 1, false, NO_SIGNALS, makeRng(50));
    expect(b.kind).toBe(PASS);
  });

  it('indicates the best suit on the pass path per the Medium rule', () => {
    // An unreachable margin forces the pass path even on a strong hand; the
    // indication rule (est >= 4.5, suit strains only) then takes over.
    const withIndication = chooseBidByRollout(STRONG_HEARTS, -1, true, NO_SIGNALS, makeRng(51), {
      margin: 1e9,
    });
    expect(withIndication.kind).toBe(IND);
    expect(withIndication.strain).toBe(3);
    const without = chooseBidByRollout(STRONG_HEARTS, -1, false, NO_SIGNALS, makeRng(51), { margin: 1e9 });
    expect(without.kind).toBe(PASS);
  });

  it('never proposes dnulla without an extremely low own hand', () => {
    // Own-hand gate only (no partner signaling model): a hand with a queen
    // may reach the nulla candidate but never the dnulla one.
    const queenHigh = [S(4), S(5), S(12), C(4), C(5), C(6), D(4), D(5), H(4), H(5)];
    const kinds = candidateBids(queenHigh, -1).map((c) => c.kind);
    expect(kinds).not.toContain('DNULLA');
  });
});

describe('partner indication signal (fh-zpg)', () => {
  // Auction-time constraints as seen from GARBAGE: nothing known beyond the
  // own ten cards, three hidden seats of ten.
  const constraints: ObservedConstraints = {
    viewer: 0,
    trump: null,
    unseen: DECK.filter((c) => !GARBAGE.includes(c)),
    seats: [1, 2, 3].map((seat) => ({ seat, count: 10, voidSuits: [] })),
    restricted: [],
  };
  const medium = new MediumPolicy();

  it('conditioned sampling deals materially stronger partner hands in the strain', () => {
    const plain = makeRng(60);
    const conditioned = makeRng(60);
    const samples = 30;
    let plainSum = 0;
    let condSum = 0;
    for (let i = 0; i < samples; i++) {
      plainSum += medium.suitStrength(sampleWorld(constraints, plain).hands[2] ?? [], 3);
      condSum += medium.suitStrength(
        samplePartnerIndicationWorld(constraints, 3, conditioned).hands[2] ?? [],
        3,
      );
    }
    const plainMean = plainSum / samples;
    const condMean = condSum / samples;
    expect(condMean).toBeGreaterThan(plainMean + 0.75);
    // The conditioned mean should sit near the indication promise (est 4.5).
    expect(condMean).toBeGreaterThan(3.5);
  });

  it('keeps the partner-indicated strain in the candidate set', () => {
    // Garbage prunes every strain on own strength alone (AC-1 above); the
    // partner's hearts signal keeps 7H in for the rollout to judge.
    expect(candidateBids(GARBAGE, -1).some((b) => b.kind === NUM && b.strain === 3)).toBe(false);
    const withSignal = candidateBids(GARBAGE, -1, 3);
    expect(withSignal.some((b) => b.kind === NUM && b.strain === 3)).toBe(true);
    // Forced candidates are still legal raises only.
    for (const c of withSignal) expect((ladderIndex(c) as number) > -1).toBe(true);
    expect(candidateBids(GARBAGE, LADDER.length - 1, 3)).toEqual([]);
  });

  it('chooseBid stays legal and deterministic under a partner indication', () => {
    const ctx = { seat: 0, indications: [{ seat: 2, bid: bid(IND, 6, 3) }], scores: [0, 0] } as const;
    const a = chooseBidByRollout(GARBAGE, -1, true, ctx, makeRng(61), { worlds: 4 });
    const b = chooseBidByRollout(GARBAGE, -1, true, ctx, makeRng(61), { worlds: 4 });
    expect(bidKey(a)).toBe(bidKey(b));
    expect(isLegalAt(a, -1, true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fh-e52: endgame awareness — rollout values fold through the game score
// ---------------------------------------------------------------------------

describe('endgame game-value mapping (fh-e52)', () => {
  /** Minimal scored state: sideZeroGameValue only reads handResult. */
  const scored = (
    declarer: number,
    made: boolean,
    declarerDelta: number,
    defenderDelta: number,
  ): GameState =>
    ({
      handResult: {
        contract: bid(NUM, 7, 0),
        declarer,
        slam: false,
        made,
        declarerDelta,
        defenderDelta,
        declarerSideTricks: 7,
        defenderSideTricks: 3,
      },
    }) as unknown as GameState;

  it('is exactly the point differential when nothing can end the game', () => {
    expect(sideZeroGameValue(scored(0, true, 140, 30), [100, 100])).toBe(110);
  });

  it('collapses an opponent game-out to -GAME_WIN_VALUE', () => {
    // Opponents at 360 making 7S cross 500 on contract value alone.
    expect(sideZeroGameValue(scored(1, true, 140, 30), [0, 360])).toBe(-GAME_WIN_VALUE);
  });

  it('sees the defender-trick out even when we take the contract', () => {
    // We declare and make, but four defender tricks lift 460 to 500 — the
    // rules nuance the packet pins: taking the contract is not absolute
    // protection at opp >= 460.
    expect(sideZeroGameValue(scored(0, true, 200, 40), [0, 460])).toBe(-GAME_WIN_VALUE);
  });

  it('collapses our own game-out to +GAME_WIN_VALUE', () => {
    expect(sideZeroGameValue(scored(0, true, 200, 30), [400, 0])).toBe(GAME_WIN_VALUE);
  });
});

describe('endgame bidding aggression (fh-e52)', () => {
  // A five-card spade suit (K-Q-10-7-5) with a side ace and king: every
  // strain still prunes at level scores (the safety margin over passEV holds),
  // so the pass is deterministic; the endgame stretch reopens the 8-level for
  // the rollout, which judges the spade game a better shot than conceding.
  //
  // The old fixture (H J-Q + low fill) no longer flips: fh-61z made Medium
  // partner-aware in the trick, so the rollout's own defenders stopped
  // sabotaging their partner — with competent defense, passing that weak hand
  // is the higher-EV line even at [0,490] (passEV -438 vs a hopeless contract
  // at -500). The old NUM was propped up entirely by the bot's bad defense
  // making passing look catastrophic. This hand still genuinely flips under
  // the corrected play, preserving the test's intent. The A/K top rank keeps
  // the nulla candidate gate shut.
  const STRETCH_HAND: Card[] = [
    S(5),
    S(7),
    S(10),
    S(12),
    S(13),
    C(10),
    C(12),
    D(4),
    D(14),
    H(13),
  ];

  it('passes the stretch hand at level scores', () => {
    const b = chooseBidByRollout(STRETCH_HAND, -1, false, NO_SIGNALS, makeRng(70));
    expect(b.kind).toBe(PASS);
  });

  it('bids on the same hand and seed when the opponents are one hand out', () => {
    const ctx = { seat: 0, indications: [], scores: [0, 440] } as const;
    const b = chooseBidByRollout(STRETCH_HAND, -1, false, ctx, makeRng(70));
    expect(b.kind).toBe(NUM);
  });

  it('stays deterministic and legal under endgame scores', () => {
    const ctx = { seat: 0, indications: [], scores: [0, 460] } as const;
    const a = chooseBidByRollout(STRETCH_HAND, -1, false, ctx, makeRng(71), { worlds: 4 });
    const b = chooseBidByRollout(STRETCH_HAND, -1, false, ctx, makeRng(71), { worlds: 4 });
    expect(bidKey(a)).toBe(bidKey(b));
    expect(isLegalAt(a, -1, false)).toBe(true);
  });
});
