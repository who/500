/**
 * Calibration fitter (fh-sja.5). These pure tests pin the mechanics against a
 * synthetic corpus with a KNOWN injected make-rate and a KNOWN behavior bias:
 *
 *  - AC-1 (in spirit): the fitted make model recovers the injected per-cell
 *    make-rate within tolerance; the real self-play-corpus reproduction runs in
 *    packages/bots where the sim lives.
 *  - AC-3: a thin/empty corpus yields null probabilities and an identity
 *    overlay, so the bots keep their hand-tuned behavior.
 *  - The behavior priors separate human from bot by policy kind.
 *  - Versioned artifact: round-trips through serialize/validate and rejects a
 *    foreign version.
 */

import { describe, expect, it } from 'vitest';
import { NUM, PASS, bid } from '@five-hundred/engine';
import type { AuctionCall, GameRecord, HandRecord, PolicyKind } from './schema.js';
import { CALIBRATION_SCHEMA_VERSION } from './calibration.js';
import {
  deriveParamsOverlay,
  fitCalibration,
  makeProbability,
  parseCalibration,
  priorFor,
  serializeCalibration,
  validateCalibration,
} from './calibration.js';
import { suitStrength } from './strength.js';

const card = (suit: number, rank: number): number => suit * 11 + (rank - 4);
// Weak: seven low spades (all trump-low) plus three honourless side cards.
const WEAK_SPADES = [4, 5, 6, 7, 8, 9, 10]
  .map((r) => card(0, r))
  .concat([card(2, 4), card(2, 5), card(1, 4)]);
// Strong: spade honours + bowers + side aces.
const STRONG_SPADES = [
  card(0, 14), card(0, 13), card(0, 12), card(0, 11), card(0, 10), card(0, 9),
  card(1, 11), card(1, 14), card(1, 13), card(2, 14),
];

function hand(
  declarer: number,
  declarerHand: number[],
  made: boolean,
  calls: AuctionCall[] = [],
): HandRecord {
  const hands = [[], [], [], []].map((h, s) => (s === declarer ? declarerHand : h)) as number[][];
  return {
    handNumber: 0,
    dealer: 3,
    firstBidder: 0,
    redeals: 0,
    deal: { hands, middle: [] },
    auction: {
      calls,
      indications: [],
      contract: bid(NUM, 8, 0),
      declarer,
    },
    slam: false,
    activeSeats: [0, 1, 2, 3],
    discards: [],
    tricks: [],
    result: {
      contract: bid(NUM, 8, 0),
      declarer,
      slam: false,
      made,
      declarerDelta: made ? 240 : -240,
      defenderDelta: 0,
      declarerSideTricks: 0,
      defenderSideTricks: 0,
    },
    scoresAfter: [0, 0],
  };
}

function game(kinds: PolicyKind[], hands: HandRecord[]): GameRecord {
  return {
    v: 1,
    source: 'sim',
    gameId: 'g',
    seed: 1,
    createdAt: null,
    players: kinds.map((kind, seat) => ({
      seat,
      kind,
      paramsSchemaVersion: null,
      overlayHash: null,
    })),
    hands,
    winner: null,
    finalScores: [0, 0],
  };
}

const KINDS: PolicyKind[] = ['medium', 'medium', 'medium', 'medium'];

describe('make model (AC-1 in spirit: recovers the injected make-rate)', () => {
  it('recovers a 70% make-rate for a well-populated cell within tolerance', () => {
    const hands: HandRecord[] = [];
    for (let i = 0; i < 100; i++) hands.push(hand(0, WEAK_SPADES, i < 70));
    const art = fitCalibration([game(KINDS, hands)]);
    const strength = suitStrength(WEAK_SPADES, 0);
    const p = makeProbability(art, { strain: 0, level: 8, strength, seatPos: 0 });
    expect(p).not.toBeNull();
    expect(p as number).toBeGreaterThan(0.6);
    expect(p as number).toBeLessThan(0.8);
  });

  it('distinguishes a strong cell from a weak one', () => {
    const hands: HandRecord[] = [];
    for (let i = 0; i < 100; i++) hands.push(hand(0, WEAK_SPADES, i < 30));
    for (let i = 0; i < 100; i++) hands.push(hand(0, STRONG_SPADES, i < 90));
    const art = fitCalibration([game(KINDS, hands)]);
    const weak = makeProbability(art, {
      strain: 0,
      level: 8,
      strength: suitStrength(WEAK_SPADES, 0),
      seatPos: 0,
    });
    const strong = makeProbability(art, {
      strain: 0,
      level: 8,
      strength: suitStrength(STRONG_SPADES, 0),
      seatPos: 0,
    });
    expect(strong as number).toBeGreaterThan(weak as number);
  });
});

describe('behavior priors separate policy kinds', () => {
  it('captures humans bidding weaker than bots in the same strain', () => {
    const games: GameRecord[] = [];
    // Seat 0 = human bidding weak hands; seat 1 = medium bidding strong hands.
    for (let i = 0; i < 60; i++) {
      const calls: AuctionCall[] = [
        { seat: 0, bid: bid(NUM, 7, 0) },
        { seat: 1, bid: bid(NUM, 8, 0) },
      ];
      const h = hand(1, STRONG_SPADES, true, calls);
      // Override seat 0's dealt hand to the weak one for the prior sample.
      (h.deal.hands as number[][])[0] = WEAK_SPADES;
      games.push(game(['human', 'medium', 'human', 'medium'], [h]));
    }
    const art = fitCalibration(games, { minSamples: 10 });
    const human = priorFor(art, 'human', NUM, 0);
    const bot = priorFor(art, 'medium', NUM, 0);
    expect(human).not.toBeNull();
    expect(bot).not.toBeNull();
    expect((human as { mean: number }).mean).toBeLessThan((bot as { mean: number }).mean);
  });
});

describe('thin-data fallback (AC-3)', () => {
  it('returns null probability when the corpus is empty', () => {
    const art = fitCalibration([]);
    expect(makeProbability(art, { strain: 0, level: 8, strength: 3, seatPos: 0 })).toBeNull();
  });

  it('returns null probability below minSamples', () => {
    const hands = [hand(0, WEAK_SPADES, true), hand(0, WEAK_SPADES, false)];
    const art = fitCalibration([game(KINDS, hands)], { minSamples: 30 });
    expect(makeProbability(art, { strain: 0, level: 8, strength: 3, seatPos: 0 })).toBeNull();
  });

  it('returns null prior below minSamples', () => {
    const calls: AuctionCall[] = [{ seat: 0, bid: bid(PASS) }];
    const art = fitCalibration([game(KINDS, [hand(1, WEAK_SPADES, true, calls)])], {
      minSamples: 30,
    });
    expect(priorFor(art, 'medium', PASS, 0)).toBeNull();
  });

  it('derives an identity overlay (headroom unchanged) from a thin corpus', () => {
    const art = fitCalibration([], { minSamples: 30 });
    const overlay = deriveParamsOverlay(art, { schemaVersion: 1, baseHeadroom: 4.0 });
    expect(overlay.bidding).toBeUndefined();
    expect(overlay.schemaVersion).toBe(1);
  });

  it('derives a bounded overlay from a populated corpus', () => {
    const hands: HandRecord[] = [];
    for (let i = 0; i < 100; i++) hands.push(hand(0, WEAK_SPADES, i < 90)); // over-safe: 90% make
    const art = fitCalibration([game(KINDS, hands)]);
    const overlay = deriveParamsOverlay(art, {
      schemaVersion: 1,
      baseHeadroom: 4.0,
      maxNudge: 1.0,
    });
    // 90% make > 50% target -> nudge up, clamped to +1.0.
    expect(overlay.bidding?.headroom).toBeGreaterThan(4.0);
    expect(overlay.bidding?.headroom).toBeLessThanOrEqual(5.0);
  });
});

describe('versioned artifact', () => {
  it('round-trips through serialize/parse', () => {
    const art = fitCalibration([game(KINDS, [hand(0, WEAK_SPADES, true)])]);
    const back = parseCalibration(serializeCalibration(art));
    expect(back.v).toBe(CALIBRATION_SCHEMA_VERSION);
    expect(back.meta.hands).toBe(1);
  });

  it('rejects a foreign schema version', () => {
    const art = fitCalibration([]);
    const bad = { ...art, v: 999 };
    const res = validateCalibration(bad);
    expect(res.ok).toBe(false);
  });
});
