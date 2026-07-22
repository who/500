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
 *     NULLA / DNULLA are gated on own-hand lowness — there is no partner
 *     signaling model, so DNULLA never triggers off a partner's bid.
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
  partnerOf,
} from '@five-hundred/engine';
import {
  BID_HEADROOM,
  CHEAPEST_CONTRACT,
  DESPERATE_SCORE,
  INDICATE_EST,
  MediumPolicy,
  endgameHeadroom,
} from '../medium.js';
import type { BidContext, Policy } from '../policy.js';
import { driveHand } from '../sim.js';
import type { ObservedConstraints, SampledWorld } from './worlds.js';
import { sampleWorld } from './worlds.js';

/** Default shared rollout worlds per decision (fh-7hw.4 adapts this). */
export const ROLLOUT_WORLDS = 16;
/**
 * EV edge over the pass baseline required to bid. Originally +25, which with
 * noisy small-world rollouts suppressed close-but-positive bids and passed
 * out 6.5% of 4-Hard auctions (fh-c6i). At +10 the measured 4-Hard numbers
 * (sim-cli --hands 500 --seed 0 --policies HHHH) are redeal rate 4.4%,
 * 7+ contract rate 95.0% of deals, set rate 35.4%, and the Hard-beats-Medium
 * strength gate stays green (both sides >= 60% at the suite budget).
 */
export const BID_MARGIN = 10;
/** EV edge of the slam variant over non-slam required to declare. */
export const SLAM_MARGIN = 25;

// Candidate gates for the lose-all contracts. NULLA is looser than Medium's
// own 8.6/jack gate so the rollout, not the heuristic, gets the final say;
// DNULLA demands Medium's full gate because the partner's half is unknown.
const NULLA_CAND_LOWNESS = 8.0;
const NULLA_CAND_MAX_RANK = 12; // nothing above a queen
const DNULLA_CAND_LOWNESS = 8.6;
const DNULLA_CAND_MAX_RANK = 11; // nothing above a jack

export interface HardBidOptions {
  /** Worlds sampled per decision, shared across candidates. Min 1. */
  readonly worlds?: number;
  /** EV edge over pass required to bid. */
  readonly margin?: number;
  /** EV edge of slam over non-slam required to declare. */
  readonly slamMargin?: number;
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
export const IND_WORLD_TRIES = 20;

/**
 * Sample a world whose partner hand honors an indication of `strain`: keep
 * the first sample whose partner suitStrength meets the indication promise
 * (INDICATE_EST), else the strongest of IND_WORLD_TRIES draws (fh-zpg).
 */
export function samplePartnerIndicationWorld(
  constraints: ObservedConstraints,
  strain: number,
  rng: Rng,
): SampledWorld {
  let best: SampledWorld | null = null;
  let bestEst = -Infinity;
  for (let t = 0; t < IND_WORLD_TRIES; t++) {
    const world = sampleWorld(constraints, rng);
    const est = OPPONENT.suitStrength(world.hands[ROLLOUT_PARTNER] ?? [], strain);
    if (est >= INDICATE_EST) return world;
    if (est > bestEst) {
      best = world;
      bestEst = est;
    }
  }
  return best as SampledWorld;
}

/** Medium everywhere, with seat 0's slam answer scripted per variant. */
class ScriptedSlamMedium extends MediumPolicy {
  constructor(private readonly slamAnswer: boolean) {
    super();
  }
  override considerSlam(): boolean {
    return this.slamAnswer;
  }
}

const OPPONENT = new MediumPolicy();

function rolloutPolicies(slamAnswer: boolean): readonly Policy[] {
  return [new ScriptedSlamMedium(slamAnswer), OPPONENT, OPPONENT, OPPONENT];
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

/** Assemble a rollout deal: my cards at seat 0, the world's hands elsewhere. */
export function worldDeal(
  myTen: readonly Card[],
  world: SampledWorld,
  middle: readonly Card[],
): GameState {
  const hands = [
    [...myTen],
    [...(world.hands[1] as readonly Card[])],
    [...(world.hands[2] as readonly Card[])],
    [...(world.hands[3] as readonly Card[])],
  ];
  return initHandFromDeal(hands, middle, ME);
}

/** Script the auction so seat 0 wins `winning` unopposed. */
export function scriptAuction(state: GameState, winning: Bid): GameState {
  state = mustApply(state, { type: 'bid', seat: ME, bid: winning });
  for (const seat of [1, 2, 3]) {
    state = mustApply(state, { type: 'bid', seat, bid: bid(PASS) });
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
): number {
  let st = scriptAuction(worldDeal(myTen, world, world.dead), candidate);
  st = driveHand(st, rolloutPolicies(false), rng);
  return sideZeroGameValue(st, scores);
}

/**
 * Pass baseline in one world: this seat always passes while the other three
 * bid with Medium; a dead auction is a redeal, worth 0. The auction is
 * driven manually (not via driveHand) because the engine's auto-redeal on
 * the fourth quiet action would deal fresh cards unrelated to the world.
 */
function rolloutPass(
  myTen: readonly Card[],
  world: SampledWorld,
  rng: Rng,
  scores: readonly [number, number],
): number {
  // MediumPolicy.chooseBid is deterministic and declares no rng parameter.
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
        : OPPONENT.chooseBid(st.hands[seat] ?? [], auction.ladderPos, mayIndicate, {
            seat,
            indications: auction.indications,
            scores,
          });
    if (b.kind === PASS && auction.declarer === null && auction.consecutiveQuiet === 3) {
      // Fourth quiet action with no winner: redeal at the same scores, so
      // the value is the unchanged (clamped) differential.
      const diff = scores[0] - scores[1];
      return Math.max(-GAME_WIN_VALUE, Math.min(GAME_WIN_VALUE, diff));
    }
    st = mustApply(st, { type: 'bid', seat, bid: b });
  }
  st = driveHand(st, rolloutPolicies(false), rng);
  return sideZeroGameValue(st, scores);
}

/**
 * Candidate contracts from the ladder position and hand shape: per strain
 * the minimum available level (plus one up when strong), NULLA / DNULLA when
 * the own hand passes the lowness gates. Every candidate is a legal raise.
 * A partner-indicated strain is never pruned (fh-zpg): the rollout over
 * indication-conditioned worlds, not the own-hand formula, judges it.
 */
export function candidateBids(
  hand: readonly Card[],
  ladderPos: number,
  indicatedStrain: number | null = null,
  extraHeadroom = 0,
): Bid[] {
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
      Math.trunc(OPPONENT.suitStrength(sorted, s) + BID_HEADROOM + extraHeadroom),
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
    const lowness = OPPONENT.lowness(sorted);
    const maxRank = Math.max(...sorted.map((c) => cardRank(c) as number));
    if (lowness >= NULLA_CAND_LOWNESS && maxRank <= NULLA_CAND_MAX_RANK) {
      if ((ladderIndex(bid(NULLA)) as number) > ladderPos) candidates.push(bid(NULLA));
    }
    if (lowness >= DNULLA_CAND_LOWNESS && maxRank <= DNULLA_CAND_MAX_RANK) {
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
  const worlds = Math.max(1, options.worlds ?? ROLLOUT_WORLDS);
  const margin = options.margin ?? BID_MARGIN;
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
      const strength = OPPONENT.suitStrength(sorted, s);
      if (strength > est) {
        bestStrain = s;
        est = strength;
      }
    }
    if (mayIndicate && est >= INDICATE_EST && bestStrain < 4) return bid(IND, 6, bestStrain);
    return bid(PASS);
  };

  const stretch = endgameHeadroom(context);
  const candidates = candidateBids(sorted, ladderPos, partnerStrain, stretch);
  // From a DESPERATE losing endgame (opponents go out on defender tricks, so
  // failing a denial bid costs nothing extra), also offer each strain's
  // cheapest GAME-WINNING level and let the rollout decide whether the
  // moonshot beats the slow bleed (fh-e52). Not in the wider stretch band:
  // there a crashed moonshot feeds the leaders 10/trick and digs the hole
  // faster than passing would — deny at the 7/8 level instead.
  if (myScores[1] >= DESPERATE_SCORE && myScores[0] < myScores[1]) {
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
  const sampled: SampledWorld[] = [];
  for (let i = 0; i < worlds; i++) {
    sampled.push(
      partnerStrain === null
        ? sampleWorld(constraints, rng)
        : samplePartnerIndicationWorld(constraints, partnerStrain, rng),
    );
  }

  // The one-world pass baseline is fine mid-game, but in the endgame the
  // pass/bid call IS the decision, and one world flips it on a coin toss
  // (redeal vs opponents closing out the game) — average over all sampled
  // worlds there instead (fh-e52).
  let passEV: number;
  if (stretch > 0) {
    let passTotal = 0;
    for (const world of sampled) passTotal += rolloutPass(sorted, world, rng, myScores);
    passEV = passTotal / sampled.length;
  } else {
    passEV = rolloutPass(sorted, sampled[0] as SampledWorld, rng, myScores);
  }
  let best: Bid | null = null;
  let bestEV = -Infinity;
  for (const candidate of candidates) {
    let total = 0;
    for (const world of sampled) {
      total += rolloutContract(sorted, world, candidate, rng, myScores);
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
    if (myScores[0] + CHEAPEST_CONTRACT >= WIN_SCORE && bestEV >= nearCertain) return best;
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
): number {
  let st = scriptAuction(worldDeal(my15.slice(0, 10), world, my15.slice(10)), contract);
  st = driveHand(st, rolloutPolicies(slam), rng);
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
  const worlds = Math.max(1, options.worlds ?? ROLLOUT_WORLDS);
  const slamMargin = options.slamMargin ?? SLAM_MARGIN;
  const sorted = [...hand15].sort(ascending);
  const constraints = unseenConstraints(sorted);
  let diff = 0;
  for (let i = 0; i < worlds; i++) {
    const world = sampleWorld(constraints, rng);
    diff += rolloutSlamVariant(sorted, world, contract, true, rng);
    diff -= rolloutSlamVariant(sorted, world, contract, false, rng);
  }
  return diff / worlds >= slamMargin;
}
