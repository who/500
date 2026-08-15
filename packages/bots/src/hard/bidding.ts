/**
 * Hard-bot rollout bidding (PRD 4.3 bidding) — chooseBid and considerSlam
 * estimate the value of each candidate contract by Monte Carlo rollout:
 * sample complete worlds of the unseen cards (the fh-7hw.1 sampler), script
 * the auction so the candidate becomes the contract, then play the hand out
 * with Medium policies on every seat and average the point differential for
 * the bidder's side. The best candidate is bid only when its EV beats the
 * pass baseline by a safety margin.
 *
 * Recorded planning decisions (issue fh-7hw.3), all tunable only at the
 * strength gate:
 *   - Candidates: each strain at the minimum currently-available level, plus
 *     one level up when the Medium max-level formula says the hand is strong;
 *     strains hopeless by that formula (min level > maxLevel + 1) are pruned.
 *     NULLA / DNULLA are gated on own-hand lowness, and DNULLA additionally
 *     on the engine's legality precondition — the partner must already have
 *     bid regular NULLA this auction (fh-17b, BidContext.mayDoubleNulla).
 *   - Rollout proxy: the declarer's keeps use Medium's chooseKeeps (cheap
 *     proxy bounding cost); all four seats play with Medium policies.
 *   - Pass baseline: ONE shared world played out with this seat passing and
 *     Medium bidders elsewhere (single-world cheap heuristic, not a full
 *     opponent rollout); a dead auction scores as an unchanged game (0 at
 *     level scores). In endgame states (fh-e52) the baseline averages over
 *     all sampled worlds instead — there the pass/bid call is the decision.
 *   - Safety margin: +10 expected points (BID_MARGIN, tuned down from the
 *     packet's +25 by fh-c6i — see the constant); slam declares on a +25 EV
 *     edge of the slam variant over the non-slam variant (SLAM_MARGIN).
 *   - Auction worlds ignore prior NUM bids as constraints (documented
 *     simplification per the leaf's non-goals), but a partner indication
 *     conditions the sampled partner hand and its strain always stays a
 *     candidate (fh-zpg) — see samplePartnerIndicationWorld.
 *
 * Everything is pure and synchronous: worlds come from the injected Rng and
 * the world count is a caller option — the 1s time budget and its adaptive
 * world count belong to the integration leaf (fh-7hw.4), which cannot live
 * here without touching the clock and breaking seed-determinism (AC-3).
 */

import type { Bid, Card, GameState, Rng } from '@five-hundred/engine';
import {
  DECK,
  DNULLA,
  IND,
  JOKER,
  LADDER,
  NULLA,
  NUM,
  PASS,
  WIN_SCORE,
  applyAction,
  applyHandResult,
  bid,
  bidKey,
  bidValue,
  cardRank,
  initHandFromDeal,
  ladderIndex,
  mayDoubleNulla,
  partnerOf,
} from '@five-hundred/engine';
import { MediumPolicy, endgameHeadroom } from '../medium.js';
import { DEFAULT_PARAMS, type BotParams } from '../params.js';
import type { BidContext, Policy } from '../policy.js';
import { driveHand } from '../sim.js';
import type { CalibrationArtifact } from '@five-hundred/learn';
import type { CallObservation } from './priors.js';
import { sampleHiddenWorld } from './priors.js';
import type { ObservedConstraints, SampledWorld } from './worlds.js';
import { sampleWorld } from './worlds.js';

// Every gate below now lives in BotParams (hardBidding group, fh-sja.1); the
// names re-exported here are the checked-in defaults, kept for downstream
// imports. A HardPolicy threads its own BotParams into every function here.

/** Default shared rollout worlds per decision (fh-7hw.4 adapts this). */
export const ROLLOUT_WORLDS = DEFAULT_PARAMS.hardBidding.rolloutWorlds;
/**
 * EV edge over the pass baseline required to bid. Originally +25, which with
 * noisy small-world rollouts suppressed close-but-positive bids and passed
 * out 6.5% of 4-Hard auctions (fh-c6i). At +10 the measured 4-Hard numbers
 * (sim-cli --hands 500 --seed 0 --policies HHHH, re-baselined under the
 * one-pass auction, fh-8i7) are redeal rate 4.4%, 7+ contract rate 95.0% of
 * deals, set rate 32.0%, and the Hard-beats-Medium strength gate stays
 * green (both sides >= 60% at the suite budget).
 */
export const BID_MARGIN = DEFAULT_PARAMS.hardBidding.bidMargin;
/** EV edge of the slam variant over non-slam required to declare. */
export const SLAM_MARGIN = DEFAULT_PARAMS.hardBidding.slamMargin;

export interface HardBidOptions {
  /** Worlds sampled per decision, shared across candidates. Min 1. */
  readonly worlds?: number;
  /** EV edge over pass required to bid. */
  readonly margin?: number;
  /** EV edge of slam over non-slam required to declare. */
  readonly slamMargin?: number;
  /** Strategy constants; defaults to DEFAULT_PARAMS. */
  readonly params?: BotParams;
  /** Loaded calibration; absent/null keeps the uniform (or fh-zpg) sampler. */
  readonly calibration?: CalibrationArtifact | null;
  /** Auction-call evidence for the prior-conditioned sampler. */
  readonly observations?: readonly CallObservation[];
}

const ascending = (a: Card, b: Card): number => a - b;

/** The rollout seat: worlds are always sampled from seat 0's point of view. */
export const ME = 0;

/** The rollout seat's partner in the remapped world (partnerOf(ME)). */
export const ROLLOUT_PARTNER = 2;

/**
 * Rejection tries when conditioning worlds on a partner indication; after
 * this many misses the strongest sampled partner hand is kept, so the bias
 * survives even when the promise is unreachable given the visible cards.
 */
export const IND_WORLD_TRIES = DEFAULT_PARAMS.hardBidding.indWorldTries;

/**
 * Sample a world whose partner hand honors an indication of `strain`: keep
 * the first sample whose partner suitStrength meets the indication promise
 * (bidding.indicateEst), else the strongest of hardBidding.indWorldTries draws
 * (fh-zpg).
 */
export function samplePartnerIndicationWorld(
  constraints: ObservedConstraints,
  strain: number,
  rng: Rng,
  params: BotParams = DEFAULT_PARAMS,
): SampledWorld {
  const opponent = new MediumPolicy(params);
  let best: SampledWorld | null = null;
  let bestEst = -Infinity;
  for (let t = 0; t < params.hardBidding.indWorldTries; t++) {
    const world = sampleWorld(constraints, rng);
    const est = opponent.suitStrength(world.hands[ROLLOUT_PARTNER] ?? [], strain);
    if (est >= params.bidding.indicateEst) return world;
    if (est > bestEst) {
      best = world;
      bestEst = est;
    }
  }
  return best as SampledWorld;
}

/** Medium everywhere, with seat 0's slam answer scripted per variant. */
class ScriptedSlamMedium extends MediumPolicy {
  constructor(
    private readonly slamAnswer: boolean,
    params: BotParams = DEFAULT_PARAMS,
  ) {
    super(params);
  }
  override considerSlam(): boolean {
    return this.slamAnswer;
  }
}

const OPPONENT = new MediumPolicy();

function rolloutPolicies(slamAnswer: boolean, params: BotParams = DEFAULT_PARAMS): readonly Policy[] {
  const opponent = params === DEFAULT_PARAMS ? OPPONENT : new MediumPolicy(params);
  return [new ScriptedSlamMedium(slamAnswer, params), opponent, opponent, opponent];
}

/** Auction-time constraints: nothing is known beyond the viewer's own cards. */
function unseenConstraints(myCards: readonly Card[]): ObservedConstraints {
  const seen = new Set(myCards);
  return {
    viewer: ME,
    trump: null,
    unseen: DECK.filter((c) => !seen.has(c)),
    seats: [1, 2, 3].map((seat) => ({ seat, count: 10, voidSuits: [] })),
    restricted: [],
  };
}

/** Apply an engine action that a rollout script knows must be legal. */
export function mustApply(
  state: GameState,
  action: Parameters<typeof applyAction>[1],
): GameState {
  const result = applyAction(state, action);
  if (!result.ok) {
    throw new Error(`rollout action ${action.type} rejected: ${result.error.message}`);
  }
  return result.state;
}

/** Point differential for side 0 (the rollout seat's side) of a scored hand. */
export function sideZeroDelta(state: GameState): number {
  const res = state.handResult;
  if (res === null) throw new Error('rollout ended without a hand result');
  return res.declarer % 2 === 0
    ? res.declarerDelta - res.defenderDelta
    : res.defenderDelta - res.declarerDelta;
}

/**
 * Terminal value of a game-ending rollout outcome (fh-e52). Set to
 * WIN_SCORE so that near the endgame a conceded game (-500) outweighs any
 * ordinary contract swing and the comparison approximates game-win
 * probability — a longshot bid with negative point EV is correct when
 * passing loses the game outright. Deliberately NOT larger: at WIN_SCORE a
 * dnulla or 10-level outcome that ends a game from level scores maps to
 * exactly its point value, so bidding away from the endgame does not get
 * globally louder.
 */
export const GAME_WIN_VALUE = WIN_SCORE;

/**
 * Rollout value for side 0 given the real game score (side-0 oriented): the
 * post-hand score differential, folded through the engine's own win /
 * out-the-back check. Game-ending outcomes pin to +-GAME_WIN_VALUE and the
 * differential clamps at the same bound, so near the endgame a hand that
 * WINS the game beats any point-safe continuation from a lost position —
 * the trailing side reaches for 9s, 10s, and slams instead of banking
 * points that never add up to 500 in time. At any fixed score the
 * differential is sideZeroDelta plus a constant, so candidate ranking and
 * the pass margin away from the game boundary are exactly the pre-fh-e52
 * behavior.
 */
export function sideZeroGameValue(
  state: GameState,
  scores: readonly [number, number],
): number {
  const res = state.handResult;
  if (res === null) throw new Error('rollout ended without a hand result');
  const after = applyHandResult({ scores: [scores[0], scores[1]], winner: null }, res);
  if (after.winner === 0) return GAME_WIN_VALUE;
  if (after.winner === 1) return -GAME_WIN_VALUE;
  const diff = after.scores[0] - after.scores[1];
  return Math.max(-GAME_WIN_VALUE, Math.min(GAME_WIN_VALUE, diff));
}

/**
 * Seat that opens a scripted rollout auction for `contract`. Normally ME,
 * who simply bids it; a double nulla only answers a partner's nulla
 * (fh-17b), so those worlds are dealt with ME's partner opening — the seat
 * order is fully scripted either way, and ME still ends up the declarer.
 */
export function scriptedOpener(contract: Bid): number {
  return contract.kind === DNULLA ? partnerOf(ME) : ME;
}

/** Assemble a rollout deal: my cards at seat 0, the world's hands elsewhere. */
export function worldDeal(
  myTen: readonly Card[],
  world: SampledWorld,
  middle: readonly Card[],
  first: number = ME,
): GameState {
  const hands = [
    [...myTen],
    [...(world.hands[1] as readonly Card[])],
    [...(world.hands[2] as readonly Card[])],
    [...(world.hands[3] as readonly Card[])],
  ];
  return initHandFromDeal(hands, middle, first);
}

/**
 * Script the auction so seat 0 wins `winning` unopposed: everyone else
 * passes, except that a DNULLA is set up by ME's partner opening NULLA —
 * the only call sequence in which a double nulla is legal (fh-17b). Deal
 * such a world with `scriptedOpener(winning)` as the first bidder.
 */
export function scriptAuction(state: GameState, winning: Bid): GameState {
  const opener = state.auction?.turn ?? ME;
  for (let i = 0; i < 4; i++) {
    const seat = (opener + i) % 4;
    const call =
      seat === ME
        ? winning
        : winning.kind === DNULLA && seat === partnerOf(ME)
          ? bid(NULLA)
          : bid(PASS);
    state = mustApply(state, { type: 'bid', seat, bid: call });
  }
  return state;
}

/**
 * EV of winning `candidate` in one world: scripted auction, Medium-proxy
 * exchange (slam declined — the slam decision is rolled out separately at
 * the exchange), Medium play-out on all seats.
 */
function rolloutContract(
  myTen: readonly Card[],
  world: SampledWorld,
  candidate: Bid,
  rng: Rng,
  scores: readonly [number, number],
  params: BotParams = DEFAULT_PARAMS,
): number {
  let st = scriptAuction(
    worldDeal(myTen, world, world.dead, scriptedOpener(candidate)),
    candidate,
  );
  st = driveHand(st, rolloutPolicies(false, params), rng);
  return sideZeroGameValue(st, scores);
}

/**
 * Pass baseline in one world: this seat always passes while the other three
 * bid with Medium; a dead auction is a redeal, worth 0. The auction is
 * driven manually (not via driveHand) because the engine's auto-redeal on
 * a dead fourth call would deal fresh cards unrelated to the world.
 */
function rolloutPass(
  myTen: readonly Card[],
  world: SampledWorld,
  rng: Rng,
  scores: readonly [number, number],
  params: BotParams = DEFAULT_PARAMS,
): number {
  // MediumPolicy.chooseBid is deterministic and declares no rng parameter.
  const opponent = params === DEFAULT_PARAMS ? OPPONENT : new MediumPolicy(params);
  let st = worldDeal(myTen, world, world.dead);
  let guard = 0;
  while (st.phase === 'auction') {
    if (++guard > 200) throw new Error('pass rollout auction failed to terminate');
    const auction = st.auction;
    if (auction === null) throw new Error('auction phase without auction state');
    const seat = auction.turn;
    const mayIndicate = auction.declarer === null && !auction.indicated[seat];
    // Rollout seat parity matches the side-0-oriented scores, so the modeled
    // opponents see the same endgame pressure the real ones would (fh-e52).
    const b: Bid =
      seat === ME
        ? bid(PASS)
        : opponent.chooseBid(st.hands[seat] ?? [], auction.ladderPos, mayIndicate, {
            seat,
            indications: auction.indications,
            scores,
            mayDoubleNulla: mayDoubleNulla(auction, seat),
          });
    if (
      auction.declarer === null &&
      auction.history.length === 3 &&
      (b.kind === PASS || b.kind === IND)
    ) {
      // Fourth call cannot produce a winner: redeal at the same scores, so
      // the value is the unchanged (clamped) differential.
      const diff = scores[0] - scores[1];
      return Math.max(-GAME_WIN_VALUE, Math.min(GAME_WIN_VALUE, diff));
    }
    st = mustApply(st, { type: 'bid', seat, bid: b });
  }
  st = driveHand(st, rolloutPolicies(false, params), rng);
  return sideZeroGameValue(st, scores);
}

/**
 * Candidate contracts from the ladder position and hand shape: per strain
 * the minimum available level (plus one up when strong), NULLA / DNULLA when
 * the own hand passes the lowness gates. Every candidate is a legal raise.
 * A partner-indicated strain is never pruned (fh-zpg): the rollout over
 * indication-conditioned worlds, not the own-hand formula, judges it.
 * DNULLA is offered only when `mayDoubleNulla` says the partner already bid
 * regular nulla — the engine refuses it otherwise (fh-17b).
 */
export function candidateBids(
  hand: readonly Card[],
  ladderPos: number,
  indicatedStrain: number | null = null,
  extraHeadroom = 0,
  params: BotParams = DEFAULT_PARAMS,
  mayDoubleNulla = false,
): Bid[] {
  const opponent = new MediumPolicy(params);
  const sorted = [...hand].sort(ascending);
  const candidates: Bid[] = [];
  for (let s = 0; s < 5; s++) {
    let lowest: Bid | null = null;
    for (let i = ladderPos + 1; i < LADDER.length; i++) {
      const b = LADDER[i] as Bid;
      if (b.kind === NUM && b.strain === s) {
        lowest = b;
        break;
      }
    }
    if (lowest === null) continue;
    const maxLevel = Math.min(
      10,
      Math.trunc(opponent.suitStrength(sorted, s) + params.bidding.headroom + extraHeadroom),
    );
    // Prune strains the Medium formula puts more than one level out of
    // reach; the rollout gets to stretch exactly one level past Medium.
    if (s !== indicatedStrain && lowest.level > maxLevel + 1) continue;
    candidates.push(lowest);
    if (lowest.level < 10 && maxLevel >= lowest.level + 1) {
      candidates.push(bid(NUM, lowest.level + 1, s));
    }
  }
  if (!sorted.includes(JOKER) && sorted.length > 0) {
    const lowness = opponent.lowness(sorted);
    const maxRank = Math.max(...sorted.map((c) => cardRank(c) as number));
    const hb = params.hardBidding;
    if (lowness >= hb.nullaCandLowness && maxRank <= hb.nullaCandMaxRank) {
      if ((ladderIndex(bid(NULLA)) as number) > ladderPos) candidates.push(bid(NULLA));
    }
    if (mayDoubleNulla && lowness >= hb.dnullaCandLowness && maxRank <= hb.dnullaCandMaxRank) {
      if ((ladderIndex(bid(DNULLA)) as number) > ladderPos) candidates.push(bid(DNULLA));
    }
  }
  return candidates;
}

/**
 * Hard chooseBid: rollout EV per candidate over shared worlds, bid the best
 * candidate when it beats the pass baseline by the margin; otherwise fall
 * back to the Medium indication rule verbatim (est >= 4.5, suit strains
 * only, one per auction via mayIndicate) and pass. A partner indication in
 * `context` conditions the sampled worlds (partner hands honor the promise)
 * and keeps that strain in the candidate set (fh-zpg).
 */
export function chooseBidByRollout(
  hand: readonly Card[],
  ladderPos: number,
  mayIndicate: boolean,
  context: BidContext,
  rng: Rng,
  options: HardBidOptions = {},
): Bid {
  const params = options.params ?? DEFAULT_PARAMS;
  const worlds = Math.max(1, options.worlds ?? params.hardBidding.rolloutWorlds);
  const margin = options.margin ?? params.hardBidding.bidMargin;
  const opponent = new MediumPolicy(params);
  const sorted = [...hand].sort(ascending);
  const partnerInd = context.indications.find((i) => i.seat === partnerOf(context.seat));
  const partnerStrain = partnerInd !== undefined ? partnerInd.bid.strain : null;
  // Game score oriented to the rollout's frame, where this seat's side is
  // side 0 (fh-e52); candidate pruning widens by the same endgame headroom
  // Medium uses so longshot contracts reach the rollout at all.
  const myScores: readonly [number, number] =
    context.seat % 2 === 0
      ? context.scores
      : [context.scores[1], context.scores[0]];

  const indicationOrPass = (): Bid => {
    let bestStrain = 0;
    let est = -Infinity;
    for (let s = 0; s < 5; s++) {
      const strength = opponent.suitStrength(sorted, s);
      if (strength > est) {
        bestStrain = s;
        est = strength;
      }
    }
    if (mayIndicate && est >= params.bidding.indicateEst && bestStrain < 4) {
      return bid(IND, 6, bestStrain);
    }
    return bid(PASS);
  };

  const stretch = endgameHeadroom(context, params);
  const candidates = candidateBids(
    sorted,
    ladderPos,
    partnerStrain,
    stretch,
    params,
    context.mayDoubleNulla === true,
  );
  // From a DESPERATE losing endgame (opponents go out on defender tricks, so
  // failing a denial bid costs nothing extra), also offer each strain's
  // cheapest GAME-WINNING level and let the rollout decide whether the
  // moonshot beats the slow bleed (fh-e52). Not in the wider stretch band:
  // there a crashed moonshot feeds the leaders 10/trick and digs the hole
  // faster than passing would — deny at the 7/8 level instead.
  if (myScores[1] >= params.endgame.desperateScore && myScores[0] < myScores[1]) {
    const needed = WIN_SCORE - myScores[0];
    for (let s = 0; s < 5; s++) {
      for (let i = ladderPos + 1; i < LADDER.length; i++) {
        const b = LADDER[i] as Bid;
        if (b.kind !== NUM || b.strain !== s || bidValue(b) < needed) continue;
        if (!candidates.some((c) => bidKey(c) === bidKey(b))) candidates.push(b);
        break;
      }
    }
  }
  if (candidates.length === 0) return indicationOrPass();

  const constraints = unseenConstraints(sorted);
  const artifact = options.calibration;
  const observations = options.observations ?? [];
  const sampled: SampledWorld[] = [];
  for (let i = 0; i < worlds; i++) {
    sampled.push(
      artifact !== undefined && artifact !== null
        ? sampleHiddenWorld(constraints, rng, artifact, observations)
        : partnerStrain === null
          ? sampleWorld(constraints, rng)
          : samplePartnerIndicationWorld(constraints, partnerStrain, rng, params),
    );
  }

  // The one-world pass baseline is fine mid-game, but in the endgame the
  // pass/bid call IS the decision, and one world flips it on a coin toss
  // (redeal vs opponents closing out the game) — average over all sampled
  // worlds there instead (fh-e52).
  let passEV: number;
  if (stretch > 0) {
    let passTotal = 0;
    for (const world of sampled) passTotal += rolloutPass(sorted, world, rng, myScores, params);
    passEV = passTotal / sampled.length;
  } else {
    passEV = rolloutPass(sorted, sampled[0] as SampledWorld, rng, myScores, params);
  }
  let best: Bid | null = null;
  let bestEV = -Infinity;
  for (const candidate of candidates) {
    let total = 0;
    for (const world of sampled) {
      total += rolloutContract(sorted, world, candidate, rng, myScores, params);
    }
    const ev = total / sampled.length;
    if (ev > bestEV) {
      best = candidate;
      bestEV = ev;
    }
  }
  if (best !== null && bestEV >= passEV + margin) return best;
  // Near the game boundary the value scale saturates at +-GAME_WIN_VALUE and
  // a fixed margin over passEV stops being satisfiable, which can deadlock a
  // table of Hard bots into passing out every redeal (fh-e52):
  //  - Desperate: passing is a near-certain game loss, so any candidate that
  //    is strictly better than passing is correct even without the margin.
  //  - Close-out: a made contract wins the game outright; when the rollout
  //    calls the bid a near-certain win, take it rather than pass on a
  //    saturated passEV that models the opponents bidding when they may not.
  if (best !== null) {
    const nearCertain = GAME_WIN_VALUE * 0.9;
    if (stretch > 0 && passEV <= -nearCertain && bestEV > passEV) return best;
    if (myScores[0] + params.endgame.cheapestContract >= WIN_SCORE && bestEV >= nearCertain) {
      return best;
    }
  }
  return indicationOrPass();
}

/**
 * One considerSlam rollout world, slam or non-slam variant. The 15 held
 * cards are split 10/5 into "dealt hand" and "middle" purely to re-enter the
 * engine's exchange — the declarer immediately re-absorbs the middle, so the
 * split is arbitrary and cannot leak information.
 */
function rolloutSlamVariant(
  my15: readonly Card[],
  world: SampledWorld,
  contract: Bid,
  slam: boolean,
  rng: Rng,
  params: BotParams = DEFAULT_PARAMS,
): number {
  let st = scriptAuction(
    worldDeal(my15.slice(0, 10), world, my15.slice(10), scriptedOpener(contract)),
    contract,
  );
  st = driveHand(st, rolloutPolicies(slam, params), rng);
  return sideZeroDelta(st);
}

/**
 * Hard considerSlam: on the actual 15 after the pickup, roll the slam and
 * non-slam variants out over the same worlds (partner's surrendered card and
 * sat-out hand covered by the world) and declare only when the slam EV edge
 * clears the margin.
 */
export function considerSlamByRollout(
  hand15: readonly Card[],
  contract: Bid,
  rng: Rng,
  options: HardBidOptions = {},
): boolean {
  if (contract.kind !== NUM) return false;
  if (hand15.length !== 15) {
    throw new Error(`considerSlam expects the 15 picked-up cards, got ${hand15.length}`);
  }
  const params = options.params ?? DEFAULT_PARAMS;
  const worlds = Math.max(1, options.worlds ?? params.hardBidding.rolloutWorlds);
  const slamMargin = options.slamMargin ?? params.hardBidding.slamMargin;
  const sorted = [...hand15].sort(ascending);
  const constraints = unseenConstraints(sorted);
  let diff = 0;
  for (let i = 0; i < worlds; i++) {
    const world = sampleHiddenWorld(
      constraints,
      rng,
      options.calibration,
      options.observations ?? [],
    );
    diff += rolloutSlamVariant(sorted, world, contract, true, rng, params);
    diff -= rolloutSlamVariant(sorted, world, contract, false, rng, params);
  }
  return diff / worlds >= slamMargin;
}
