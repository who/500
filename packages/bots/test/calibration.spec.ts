/**
 * Calibration from logged games (fh-sja.5) — the acceptance criteria that need
 * the real engine/sim and the Hard world sampler, which live in this package
 * (the fitter's pure mechanics are covered in packages/learn):
 *
 *   AC-1  Calibration on a self-play sim corpus reproduces the corpus's own
 *         make-rate out of sample within tolerance.
 *   AC-2  A synthetic corpus of biased 'human' bids measurably shifts the
 *         prior-conditioned world sampler's hidden hands.
 *   AC-3  (covered in learn) — spot-checked here: no prior -> plain sampler.
 *   AC-4  Arena SPRT: the calibrated params overlay does not regress vs the
 *         uncalibrated incumbent (no significant loss over a seeded match).
 *
 * All fixtures are seeded and deterministic.
 */

import { describe, expect, it } from 'vitest';
import type { Card, GameState, Rng } from '@five-hundred/engine';
import { DECK, NUM, bid, makeRng } from '@five-hundred/engine';
import {
  type GameRecord,
  type PlayerMeta,
  GameRecorder,
  deriveParamsOverlay,
  fitCalibration,
  makeProbability,
  runSprt,
  suitStrength,
} from '@five-hundred/learn';
import {
  type CallObservation,
  type ObservedConstraints,
  type Policy,
  samplePriorConditionedWorld,
  sampleWorld,
} from '../src/index.js';
import { DEFAULT_PARAMS, mergeParams, type BotParams } from '../src/params.js';
import { MediumPolicy } from '../src/medium.js';
import { playGameRecording } from '../src/sim.js';

// --- self-play corpus ------------------------------------------------------

const KINDS = ['medium', 'medium', 'medium', 'medium'] as const;
function players(): PlayerMeta[] {
  return KINDS.map((kind, seat) => ({ seat, kind, paramsSchemaVersion: 1, overlayHash: null }));
}
function mediumPolicies(params: BotParams = DEFAULT_PARAMS): Policy[] {
  return KINDS.map(() => new MediumPolicy(params));
}

/** Play `n` seeded Medium self-play games into a corpus of GameRecords. */
function selfPlayCorpus(n: number, baseSeed: number): GameRecord[] {
  const rng = makeRng(baseSeed);
  const out: GameRecord[] = [];
  for (let i = 0; i < n; i++) {
    const gameSeed = rng.int(0x100000000);
    const recorder = new GameRecorder({
      source: 'sim',
      gameId: `${baseSeed}-${i}`,
      seed: gameSeed,
      createdAt: null,
      players: players(),
    });
    const final = playGameRecording(mediumPolicies(), rng, gameSeed, (s) => recorder.recordHand(s));
    out.push(recorder.finish(final));
  }
  return out;
}

/** Empirical make-rate of the numbered contracts in a corpus. */
function empiricalMakeRate(records: readonly GameRecord[]): { made: number; total: number } {
  let made = 0;
  let total = 0;
  for (const g of records) {
    for (const h of g.hands) {
      if (h.result.contract.kind === NUM) {
        total += 1;
        if (h.result.made) made += 1;
      }
    }
  }
  return { made, total };
}

describe('AC-1: calibration reproduces the sim make-rate out of sample', () => {
  it('predicted make-probability matches the held-out empirical rate within tolerance', () => {
    const train = selfPlayCorpus(70, 1);
    const test = selfPlayCorpus(40, 9999);
    const art = fitCalibration(train, { minSamples: 20 });

    // Out-of-sample calibration: average predicted P(make) over the test hands
    // vs the actual test make-rate. A well-calibrated model tracks it closely.
    let predSum = 0;
    let n = 0;
    let actualMade = 0;
    for (const g of test) {
      for (const h of g.hands) {
        const c = h.result.contract;
        const declarer = h.result.declarer;
        if (c.kind !== NUM || h.deal.hands[declarer] === undefined) continue;
        const strength = suitStrength(h.deal.hands[declarer] as readonly Card[], c.strain);
        const seatPos = (declarer - h.firstBidder + 4) % 4;
        const p = makeProbability(art, { strain: c.strain, level: c.level, strength, seatPos });
        if (p === null) continue;
        predSum += p;
        actualMade += h.result.made ? 1 : 0;
        n += 1;
      }
    }
    expect(n).toBeGreaterThan(50);
    const predicted = predSum / n;
    const actual = actualMade / n;
    // Aggregate calibration error under 8 percentage points.
    expect(Math.abs(predicted - actual)).toBeLessThan(0.08);

    // And the global fitted rate equals the training empirical rate exactly.
    const emp = empiricalMakeRate(train);
    const globalP = makeProbability(art, { strain: 99, level: 99, strength: -1, seatPos: 9 });
    // strain 99 has no cell -> falls back to the global rate.
    expect(globalP).not.toBeNull();
    expect(globalP as number).toBeCloseTo(emp.made / emp.total, 5);
  });
});

// --- AC-2: biased priors shift the sampler --------------------------------

const card = (suit: number, rank: number): number => suit * 11 + (rank - 4);
// A hand with essentially no spade strength (all low, no honours/bowers).
const VERY_WEAK = [
  card(0, 4), card(0, 5), card(0, 6), card(2, 4), card(2, 5),
  card(2, 6), card(2, 7), card(3, 4), card(3, 5), card(3, 6),
];

/** Synthetic corpus: every human strain-0 numbered bid comes from a weak hand. */
function biasedHumanCorpus(nHands: number): GameRecord[] {
  const games: GameRecord[] = [];
  for (let i = 0; i < nHands; i++) {
    const hands: Card[][] = [[], [], [], []];
    hands[1] = [...VERY_WEAK];
    const record: GameRecord = {
      v: 1,
      source: 'sim',
      gameId: `bias-${i}`,
      seed: i,
      createdAt: null,
      players: [
        { seat: 0, kind: 'hard', paramsSchemaVersion: 1, overlayHash: null },
        { seat: 1, kind: 'human', paramsSchemaVersion: null, overlayHash: null },
        { seat: 2, kind: 'hard', paramsSchemaVersion: 1, overlayHash: null },
        { seat: 3, kind: 'hard', paramsSchemaVersion: 1, overlayHash: null },
      ],
      hands: [
        {
          handNumber: 0,
          dealer: 0,
          firstBidder: 1,
          redeals: 0,
          deal: { hands, middle: [] },
          auction: {
            calls: [{ seat: 1, bid: bid(NUM, 7, 0) }],
            indications: [],
            contract: bid(NUM, 7, 0),
            declarer: 1,
          },
          slam: false,
          activeSeats: [0, 1, 2, 3],
          discards: [],
          tricks: [],
          result: {
            contract: bid(NUM, 7, 0),
            declarer: 1,
            slam: false,
            made: false,
            declarerDelta: 0,
            defenderDelta: 0,
            declarerSideTricks: 0,
            defenderSideTricks: 0,
          },
          scoresAfter: [0, 0],
        },
      ],
      winner: null,
      finalScores: [0, 0],
    };
    games.push(record);
  }
  return games;
}

/** Auction-time constraints: viewer 0 holds `myTen`, seats 1-3 hold 10 each. */
function auctionConstraints(myTen: readonly Card[]): ObservedConstraints {
  const seen = new Set(myTen);
  return {
    viewer: 0,
    trump: null,
    unseen: DECK.filter((c) => !seen.has(c)),
    seats: [1, 2, 3].map((seat) => ({ seat, count: 10, voidSuits: [] })),
    restricted: [],
  };
}

function meanSeatStrength(
  draw: (rng: Rng) => { hands: readonly (readonly Card[] | null)[] },
  seat: number,
  strain: number,
  samples: number,
  rng: Rng,
): number {
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const w = draw(rng);
    sum += suitStrength((w.hands[seat] ?? []) as readonly Card[], strain);
  }
  return sum / samples;
}

describe('AC-2: biased human priors shift the sampled worlds', () => {
  it('conditioning on a weak-human bid lowers the seat’s sampled strength', () => {
    const art = fitCalibration(biasedHumanCorpus(80), { minSamples: 20 });
    const myTen = DECK.slice(0, 10);
    const constraints = auctionConstraints(myTen);
    const obs: CallObservation[] = [
      { seat: 1, policyKind: 'human', callKind: NUM, strain: 0 },
    ];
    const SAMPLES = 400;

    const uncond = meanSeatStrength(
      (rng) => sampleWorld(constraints, rng),
      1,
      0,
      SAMPLES,
      makeRng(7),
    );
    const cond = meanSeatStrength(
      (rng) => samplePriorConditionedWorld(constraints, obs, art, rng, 25),
      1,
      0,
      SAMPLES,
      makeRng(7),
    );

    // The learned 'human bids weak' prior pulls seat 1's sampled spade strength
    // measurably below the uniform baseline.
    expect(cond).toBeLessThan(uncond - 0.3);
  });

  it('AC-3 spot check: with no usable prior the sampler is the plain uniform draw', () => {
    const art = fitCalibration([], { minSamples: 20 }); // empty -> no priors
    const myTen = DECK.slice(0, 10);
    const constraints = auctionConstraints(myTen);
    const obs: CallObservation[] = [
      { seat: 1, policyKind: 'human', callKind: NUM, strain: 0 },
    ];
    // Same rng seed -> identical world to the plain sampler (no keep-best).
    const a = samplePriorConditionedWorld(constraints, obs, art, makeRng(3), 25);
    const b = sampleWorld(constraints, makeRng(3));
    expect(a.hands).toEqual(b.hands);
  });
});

// --- AC-4: SPRT arena no-regression ---------------------------------------

/** Terminal winner side of one seeded game (most points on a tie). */
function gameWinner(policies: readonly Policy[], seed: number): 0 | 1 {
  const rng = makeRng(seed);
  const st: GameState = playGameRecording(policies, rng, seed, () => {});
  if (st.game.winner !== null) return st.game.winner === 0 ? 0 : 1;
  return st.game.scores[0] >= st.game.scores[1] ? 0 : 1;
}

describe('AC-4: calibrated params do not regress vs the uncalibrated incumbent', () => {
  it('a mirrored SPRT match finds no significant loss for the calibrated overlay', () => {
    // Calibrate from a self-play corpus, derive a bounded bidding overlay.
    const corpus = selfPlayCorpus(60, 100);
    const art = fitCalibration(corpus, { minSamples: 20 });
    const overlay = deriveParamsOverlay(art, {
      schemaVersion: DEFAULT_PARAMS.schemaVersion,
      baseHeadroom: DEFAULT_PARAMS.bidding.headroom,
      maxNudge: 0.5,
    });
    const calibrated = mergeParams(DEFAULT_PARAMS, overlay);
    const incumbent = DEFAULT_PARAMS;

    // Mirrored seats cancel first-bidder bias: alternate which side is
    // calibrated per game. `incWin` true = the uncalibrated side won.
    const GAMES = 120;
    const outcomes: (boolean | null)[] = [];
    for (let g = 0; g < GAMES; g++) {
      const calSide = g % 2;
      const policies: Policy[] = [0, 1, 2, 3].map((seat) =>
        new MediumPolicy(seat % 2 === calSide ? calibrated : incumbent),
      );
      const winner = gameWinner(policies, 5000 + g);
      outcomes.push(winner === (1 - calSide)); // did the incumbent side win?
    }

    // H1 = "incumbent wins >= 55%" = a calibration regression. The gate passes
    // unless the test decisively concludes the calibrated side is worse.
    const result = runSprt(outcomes);
    expect(result.verdict).not.toBe('accept-h1');
    // Backstop: the incumbent's raw win-rate is not lopsided.
    expect(result.winRate).toBeLessThan(0.6);
  });
});
