/**
 * Hard-bot rollout keep/discard evaluation (PRD 4.3 exchange) — chooseKeeps
 * by determinized rollout: generate candidate keep-sets heuristically
 * (Medium's chooseKeeps plus a swap neighborhood around the keep/discard
 * boundary), evaluate every candidate over the SAME N sampled worlds with
 * Medium play-outs on all four seats, and pick the argmax. A port and
 * extension of the oracle's evaluate_keeps / _play_fixed (five_hundred.py
 * 597-646): where the oracle scores make-rate on numbered bids only, this
 * evaluator scores expected declarer-side points delta (capturing defender
 * point leakage and slam stakes — packet decision) and generalizes the
 * play-out to every contract class by re-entering the engine's own exchange
 * and play loop instead of a bespoke trick loop:
 *
 *   NUM      scripted auction, slam declined, keeps scripted, Medium play.
 *   slam-16  detected by holding 16 cards: the partner's surrendered card is
 *            scripted back through giveCard so the declarer holds the exact
 *            16, then keeps 10 solo.
 *   NULLA    partner sits out; the candidate list adds nothing beyond the
 *            lose-all base and its swaps.
 *   DNULLA   the declarer's 5 discards travel to the sampled partner, whose
 *            Medium chooseKeeps runs INSIDE the play-out — so a candidate is
 *            scored on what its pass-through does to the partner (packet
 *            edge case).
 *
 * Shared worlds across candidates are deliberate variance reduction: Medium
 * policies are deterministic, so two candidates differing in one card are
 * compared on identical layouts. Ties break first-in-order (strict argmax)
 * for determinism; identical (cards, contract, seed) always yield identical
 * keeps (AC-3).
 *
 * The Policy-facing signature is chooseKeeps(cards, contract, rng): the seat
 * is unknown, so the holder is always modeled as the declarer at seat 0. The
 * one caller this mis-models is the DNULLA partner's own keep (their
 * discards die instead of passing through), for whom declarer-modeling is a
 * safe proxy: both are scored by the same lose-all play-out.
 *
 * Pure and synchronous given (cards, contract, rng) — no clock, no I/O —
 * so the fh-7hw.4 worker leaf can wrap it and adapt `worlds` to its time
 * budget without touching this file.
 */

import type { Bid, Card, GameState, Rng } from '@five-hundred/engine';
import {
  DECK,
  JOKER,
  NUM,
  cardPower,
  cardRank,
  cardSuit,
  initHandFromDeal,
  isLoseAll,
  partnerOf,
  trumpOf,
} from '@five-hundred/engine';
import { MediumPolicy } from '../medium.js';
import { DEFAULT_PARAMS, type BotParams } from '../params.js';
import type { Policy } from '../policy.js';
import { driveHand } from '../sim.js';
import {
  ME,
  mustApply,
  scriptAuction,
  scriptedOpener,
  sideZeroDelta,
  worldDeal,
} from './bidding.js';
import type { ObservedConstraints, SampledWorld } from './worlds.js';
import { sampleWorld } from './worlds.js';

// The keep gates below now live in BotParams (hardKeeps group, fh-sja.1); the
// names re-exported here are the checked-in defaults. A HardPolicy threads its
// own BotParams into every function here.

/**
 * Default worlds per keep decision — the packet's floor of 30; fh-7hw.4
 * adapts upward from here against its time budget.
 */
export const KEEP_WORLDS = DEFAULT_PARAMS.hardKeeps.keepWorlds;
/** Kept cards nearest the keep/discard boundary eligible to swap out. */
export const MARGINAL_KEEPS = DEFAULT_PARAMS.hardKeeps.marginalKeeps;
/** Discarded cards nearest the boundary eligible to swap in. */
export const NEAR_MARGINAL_DISCARDS = DEFAULT_PARAMS.hardKeeps.nearMarginalDiscards;
/** Candidate cap (base + swaps), per the packet's ~12. */
export const MAX_CANDIDATES = DEFAULT_PARAMS.hardKeeps.maxCandidates;

export interface HardKeepsOptions {
  /** Worlds sampled per decision, shared across candidates. Min 1. */
  readonly worlds?: number;
  /** Strategy constants; defaults to DEFAULT_PARAMS. */
  readonly params?: BotParams;
}

const ascending = (a: Card, b: Card): number => a - b;

const MEDIUM = new MediumPolicy();
const POLICIES: readonly Policy[] = [MEDIUM, MEDIUM, MEDIUM, MEDIUM];

/** Four Medium seats sharing the given params (the default-fast-path reuses POLICIES). */
function keepsPolicies(params: BotParams): readonly Policy[] {
  if (params === DEFAULT_PARAMS) return POLICIES;
  const m = new MediumPolicy(params);
  return [m, m, m, m];
}

/**
 * Candidate keep-sets: Medium's chooseKeeps as the base (for lose-all that
 * IS the weakest-10 keep the packet requires), then the swap neighborhood —
 * each of the most marginal kept cards exchanged for each near-marginal
 * discard, nearest-the-boundary swaps first, capped at MAX_CANDIDATES.
 * Distinct (out, in) pairs always produce distinct sets, so no dedup is
 * needed; the order (base first, then by boundary distance) is what the
 * first-in-order tie break resolves against.
 */
export function candidateKeeps(
  cards: readonly Card[],
  contract: Bid,
  params: BotParams = DEFAULT_PARAMS,
): Card[][] {
  const sorted = [...cards].sort(ascending);
  const base = new MediumPolicy(params).chooseKeeps(sorted, contract);
  const keepSet = new Set(base);
  const discards = sorted.filter((c) => !keepSet.has(c));
  const trump = trumpOf(contract);
  // How strongly a card wants to stay kept: raw rank-lowness under lose-all
  // (joker strongest, mirroring Medium's keep rule), own-suit-led power
  // otherwise.
  const keepDesire = isLoseAll(contract)
    ? (c: Card): number => -(c === JOKER ? 99 : (cardRank(c) as number))
    : (c: Card): number => cardPower(c, trump, cardSuit(c));
  const hk = params.hardKeeps;
  const outs = [...base].sort((a, b) => keepDesire(a) - keepDesire(b)).slice(0, hk.marginalKeeps);
  const ins = [...discards]
    .sort((a, b) => keepDesire(b) - keepDesire(a))
    .slice(0, hk.nearMarginalDiscards);
  const pairs: [number, number][] = [];
  for (let i = 0; i < outs.length; i++) {
    for (let j = 0; j < ins.length; j++) pairs.push([i, j]);
  }
  pairs.sort((p, q) => p[0] + p[1] - (q[0] + q[1]) || p[0] - q[0]);
  const candidates: Card[][] = [[...base]];
  for (const [i, j] of pairs) {
    if (candidates.length >= hk.maxCandidates) break;
    const out = outs[i] as Card;
    const inn = ins[j] as Card;
    candidates.push([...base.filter((c) => c !== out), inn].sort(ascending));
  }
  return candidates;
}

/**
 * Exchange-time constraints: nothing has been observed yet, so every unseen
 * card may sit anywhere. Holding 16 means a slam happened — the partner
 * surrendered a card, so their sampled hand is one short (the surrendered
 * card is scripted back in by the play-out).
 */
function keepsConstraints(sorted: readonly Card[], contract: Bid): ObservedConstraints {
  const seen = new Set(sorted);
  const partner = partnerOf(ME);
  return {
    viewer: ME,
    trump: trumpOf(contract),
    unseen: DECK.filter((c) => !seen.has(c)),
    seats: [1, 2, 3].map((seat) => ({
      seat,
      count: sorted.length === 16 && seat === partner ? 9 : 10,
      voidSuits: [],
    })),
    restricted: [],
  };
}

/** Sample `n` shared worlds for a keep decision (exposed for AC-1 specs). */
export function sampleKeepWorlds(
  cards: readonly Card[],
  contract: Bid,
  n: number,
  rng: Rng,
): SampledWorld[] {
  const constraints = keepsConstraints([...cards].sort(ascending), contract);
  const worlds: SampledWorld[] = [];
  for (let i = 0; i < n; i++) worlds.push(sampleWorld(constraints, rng));
  return worlds;
}

/**
 * Play one world out with `keeps` as the scripted keep-set and Medium
 * policies everywhere, returning the side-0 points delta — the generalized
 * _play_fixed. The exchange is re-entered through the engine (scripted
 * auction, scripted slam answer / give-card / declarer discard), then
 * driveHand finishes the hand: for DNULLA that includes the sampled
 * partner's Medium keep of the passed-through 15.
 */
export function playoutKeeps(
  cards: readonly Card[],
  keeps: readonly Card[],
  contract: Bid,
  world: SampledWorld,
  rng: Rng,
  params: BotParams = DEFAULT_PARAMS,
): number {
  const sorted = [...cards].sort(ascending);
  let st: GameState;
  if (sorted.length === 16) {
    // Slam: deal 15 of the 16 as hand+middle and route the 16th through the
    // partner, whose give is scripted (Medium would surrender its own best
    // card, which need not be ours). Which card plays the "given" role is
    // arbitrary — the declarer ends up holding the same 16 either way.
    const give = sorted[sorted.length - 1] as Card;
    const rest = sorted.filter((c) => c !== give);
    const partner = partnerOf(ME);
    const hands = [
      rest.slice(0, 10),
      [...(world.hands[1] as readonly Card[])],
      [...(world.hands[partner] as readonly Card[]), give].sort(ascending),
      [...(world.hands[3] as readonly Card[])],
    ];
    st = scriptAuction(initHandFromDeal(hands, rest.slice(10), ME), contract);
    st = mustApply(st, { type: 'declareSlam', seat: ME });
    st = mustApply(st, { type: 'giveCard', seat: partner, card: give });
  } else {
    st = scriptAuction(
      worldDeal(sorted.slice(0, 10), world, sorted.slice(10), scriptedOpener(contract)),
      contract,
    );
    if (contract.kind === NUM) st = mustApply(st, { type: 'declineSlam', seat: ME });
  }
  st = mustApply(st, { type: 'discardKeeps', seat: ME, keeps: [...keeps] });
  st = driveHand(st, keepsPolicies(params), rng);
  return sideZeroDelta(st);
}

/** Mean side-0 points delta of one keep-set over the shared worlds. */
export function evaluateKeeps(
  cards: readonly Card[],
  keeps: readonly Card[],
  contract: Bid,
  worlds: readonly SampledWorld[],
  rng: Rng,
  params: BotParams = DEFAULT_PARAMS,
): number {
  if (worlds.length === 0) throw new Error('evaluateKeeps needs at least one world');
  let total = 0;
  for (const w of worlds) total += playoutKeeps(cards, keeps, contract, w, rng, params);
  return total / worlds.length;
}

/**
 * Hard chooseKeeps: candidates from the swap neighborhood, evaluated over
 * shared sampled worlds by expected points, first-best wins.
 */
export function chooseKeepsByRollout(
  cards: readonly Card[],
  contract: Bid,
  rng: Rng,
  options: HardKeepsOptions = {},
): Card[] {
  const sorted = [...cards].sort(ascending);
  if (sorted.length !== 15 && sorted.length !== 16) {
    throw new Error(`chooseKeeps expects 15 or 16 held cards, got ${sorted.length}`);
  }
  if (sorted.length === 16 && contract.kind !== NUM) {
    throw new Error('only a slammed numbered contract holds 16 cards');
  }
  const params = options.params ?? DEFAULT_PARAMS;
  const n = Math.max(1, options.worlds ?? params.hardKeeps.keepWorlds);
  const candidates = candidateKeeps(sorted, contract, params);
  const worlds = sampleKeepWorlds(sorted, contract, n, rng);
  let best = candidates[0] as Card[];
  let bestEV = -Infinity;
  for (const cand of candidates) {
    const ev = evaluateKeeps(sorted, cand, contract, worlds, rng, params);
    if (ev > bestEV) {
      best = cand;
      bestEV = ev;
    }
  }
  return [...best];
}
