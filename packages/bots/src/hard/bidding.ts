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
 *     opponent rollout); a dead auction counts as 0 points (redeal).
 *   - Safety margin: +25 expected points (BID_MARGIN); slam declares on a
 *     +25 EV edge of the slam variant over the non-slam variant (SLAM_MARGIN).
 *   - Auction worlds ignore prior bids as constraints (documented
 *     simplification per the leaf's non-goals).
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
  applyAction,
  bid,
  cardRank,
  initHandFromDeal,
  ladderIndex,
} from '@five-hundred/engine';
import { BID_HEADROOM, INDICATE_EST, MediumPolicy } from '../medium.js';
import type { Policy } from '../policy.js';
import { driveHand } from '../sim.js';
import type { ObservedConstraints, SampledWorld } from './worlds.js';
import { sampleWorld } from './worlds.js';

/** Default shared rollout worlds per decision (fh-7hw.4 adapts this). */
export const ROLLOUT_WORLDS = 16;
/** EV edge over the pass baseline required to bid (packet decision: +25). */
export const BID_MARGIN = 25;
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
): number {
  let st = scriptAuction(worldDeal(myTen, world, world.dead), candidate);
  st = driveHand(st, rolloutPolicies(false), rng);
  return sideZeroDelta(st);
}

/**
 * Pass baseline in one world: this seat always passes while the other three
 * bid with Medium; a dead auction is a redeal, worth 0. The auction is
 * driven manually (not via driveHand) because the engine's auto-redeal on
 * the fourth quiet action would deal fresh cards unrelated to the world.
 */
function rolloutPass(myTen: readonly Card[], world: SampledWorld, rng: Rng): number {
  // MediumPolicy.chooseBid is deterministic and declares no rng parameter.
  let st = worldDeal(myTen, world, world.dead);
  let guard = 0;
  while (st.phase === 'auction') {
    if (++guard > 200) throw new Error('pass rollout auction failed to terminate');
    const auction = st.auction;
    if (auction === null) throw new Error('auction phase without auction state');
    const seat = auction.turn;
    const mayIndicate = auction.declarer === null && !auction.indicated[seat];
    const b: Bid =
      seat === ME
        ? bid(PASS)
        : OPPONENT.chooseBid(st.hands[seat] ?? [], auction.ladderPos, mayIndicate);
    if (b.kind === PASS && auction.declarer === null && auction.consecutiveQuiet === 3) {
      return 0; // fourth quiet action with no winner: redeal
    }
    st = mustApply(st, { type: 'bid', seat, bid: b });
  }
  st = driveHand(st, rolloutPolicies(false), rng);
  return sideZeroDelta(st);
}

/**
 * Candidate contracts from the ladder position and hand shape: per strain
 * the minimum available level (plus one up when strong), NULLA / DNULLA when
 * the own hand passes the lowness gates. Every candidate is a legal raise.
 */
export function candidateBids(hand: readonly Card[], ladderPos: number): Bid[] {
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
    const maxLevel = Math.min(10, Math.trunc(OPPONENT.suitStrength(sorted, s) + BID_HEADROOM));
    // Prune strains the Medium formula puts more than one level out of
    // reach; the rollout gets to stretch exactly one level past Medium.
    if (lowest.level > maxLevel + 1) continue;
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
 * only, one per auction via mayIndicate) and pass.
 */
export function chooseBidByRollout(
  hand: readonly Card[],
  ladderPos: number,
  mayIndicate: boolean,
  rng: Rng,
  options: HardBidOptions = {},
): Bid {
  const worlds = Math.max(1, options.worlds ?? ROLLOUT_WORLDS);
  const margin = options.margin ?? BID_MARGIN;
  const sorted = [...hand].sort(ascending);

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

  const candidates = candidateBids(sorted, ladderPos);
  if (candidates.length === 0) return indicationOrPass();

  const constraints = unseenConstraints(sorted);
  const sampled: SampledWorld[] = [];
  for (let i = 0; i < worlds; i++) sampled.push(sampleWorld(constraints, rng));

  const passEV = rolloutPass(sorted, sampled[0] as SampledWorld, rng);
  let best: Bid | null = null;
  let bestEV = -Infinity;
  for (const candidate of candidates) {
    let total = 0;
    for (const world of sampled) total += rolloutContract(sorted, world, candidate, rng);
    const ev = total / sampled.length;
    if (ev > bestEV) {
      best = candidate;
      bestEV = ev;
    }
  }
  if (best !== null && bestEV >= passEV + margin) return best;
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
