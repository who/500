/**
 * Hard-bot rollout card play (PRD 4.3 play) — choosePlay by determinized
 * rollout: derive the viewing seat's constraints from the live GameState
 * (fh-7hw.1), sample complete worlds of the hidden hands, and score every
 * legal card by applying it and playing the hand out with Medium policies on
 * all four seats, averaging the viewer-side points delta. Worlds are shared
 * across the candidate cards (the same variance reduction the keeps leaf
 * uses); ties break first-in-legal-order, so identical (state, seed, worlds)
 * always pick the identical card.
 *
 * The arg-max does not get the last word: a card only beats Medium's
 * heuristic pick if its paired advantage clears both an absolute floor and a
 * multiple of that advantage's own standard error (see pickCard). Where the
 * search really separates the cards the gate is invisible; where it is
 * guessing, Medium's tactical rules decide instead of the noise.
 *
 * Two modes on one code path:
 *   fixed   `worlds: n` (default the 20-world floor) — no clock is ever
 *           consulted, for headless sim and determinism-first tests.
 *   budget  `deadlineMs` — adaptive M: keep adding worlds until the deadline
 *           or the PLAY_WORLDS_CAP, checking the clock between worlds. If the
 *           deadline passes before PLAY_WORLDS_FLOOR worlds finished, the
 *           average is too noisy to trust and the decision falls back to
 *           Medium's choice; onDecision reports it so the caller can log
 *           (packet requirement — this module itself stays I/O-free).
 *
 * One-legal-card turns return instantly with no sampling and no clock
 * (packet edge case). Everything here is pure given (state, rng, options) —
 * the wall clock enters only through the injectable `now`, so the fh-7hw.4
 * worker leaf wires Date.now while tests script it.
 */

import type { Action, Card, GameState, Rng } from '@five-hundred/engine';
import { JOKER, isLoseAll, legalPlaysFor, playToAct } from '@five-hundred/engine';
import { MediumPolicy } from '../medium.js';
import { DEFAULT_PARAMS, type BotParams } from '../params.js';
import type { Policy } from '../policy.js';
import { driveHand } from '../sim.js';
import { mustApply } from './bidding.js';
import type { SampledWorld } from './worlds.js';
import { deriveConstraints, sampleWorld } from './worlds.js';

// The world-count knobs below now live in BotParams (hardPlay group,
// fh-sja.1); the names re-exported here are the checked-in defaults. A
// HardPolicy threads its own BotParams into choosePlayByRollout.

/** Fewest worlds a rollout average may rest on; also the fixed-mode default. */
export const PLAY_WORLDS_FLOOR = DEFAULT_PARAMS.hardPlay.worldsFloor;
/** Most worlds a budget-mode decision samples even with time to spare (PRD 4.3). */
export const PLAY_WORLDS_CAP = DEFAULT_PARAMS.hardPlay.worldsCap;

/** How a rollout decision went; budget-mode telemetry for logging/benching. */
export interface HardPlayDecision {
  readonly seat: number;
  /** Worlds fully evaluated (0 when the single-legal-card shortcut fired). */
  readonly worldsDone: number;
  readonly elapsedMs: number;
  /** True when the budget missed the floor and Medium chose instead. */
  readonly fellBack: boolean;
}

export interface HardPlayOptions {
  /** Fixed world count (min 1); ignored when deadlineMs is set. */
  readonly worlds?: number;
  /** Wall-clock budget: adapt the world count to this many milliseconds. */
  readonly deadlineMs?: number;
  /** Budget-mode floor before the Medium fallback. */
  readonly minWorlds?: number;
  /** Budget-mode cap. */
  readonly maxWorlds?: number;
  /** Clock (budget mode only); defaults to Date.now. */
  readonly now?: () => number;
  /** Called once per multi-card decision with what the rollout achieved. */
  readonly onDecision?: (decision: HardPlayDecision) => void;
  /** Strategy constants; defaults to DEFAULT_PARAMS. */
  readonly params?: BotParams;
}

const MEDIUM = new MediumPolicy();
const POLICIES: readonly Policy[] = [MEDIUM, MEDIUM, MEDIUM, MEDIUM];

/** Four Medium seats sharing the given params (the default-fast-path reuses POLICIES). */
function playPolicies(params: BotParams): readonly Policy[] {
  if (params === DEFAULT_PARAMS) return POLICIES;
  const m = new MediumPolicy(params);
  return [m, m, m, m];
}

/** Points delta for `seat`'s side out of a scored hand. */
export function sideDeltaFor(state: GameState, seat: number): number {
  const res = state.handResult;
  if (res === null) throw new Error('rollout ended without a hand result');
  return res.declarer % 2 === seat % 2
    ? res.declarerDelta - res.defenderDelta
    : res.defenderDelta - res.declarerDelta;
}

/**
 * Secondary reward per own-side trick, so the rollout keeps a gradient once
 * the contract's made/set result is already settled and the points delta is
 * flat (fh-w6c). On lose-all contracts fewer own tricks is the goal for both
 * sides, so the signal negates. `trickWeight` is bounded well under the
 * cheapest contract's make/set swing, so this can never outweigh the actual
 * result — it only orders lines the points term rates equal.
 */
export function trickBonus(state: GameState, seat: number, trickWeight: number): number {
  const res = state.handResult;
  if (res === null) throw new Error('rollout ended without a hand result');
  const ownTricks = res.declarer % 2 === seat % 2 ? res.declarerSideTricks : res.defenderSideTricks;
  return trickWeight * (isLoseAll(res.contract) ? -ownTricks : ownTricks);
}

/**
 * The state as it would be if the sampled world were the truth: hidden active
 * seats take their sampled hands, the viewer and sat-out seats keep their
 * real ones (sat-out cards never act and never score, so their identity is
 * irrelevant to the play-out).
 */
export function determinize(state: GameState, world: SampledWorld): GameState {
  const play = state.play;
  if (play === null) throw new Error('can only determinize a state in play');
  const hands = play.hands.map((h, s) => world.hands[s] ?? h);
  return { ...state, hands, play: { ...play, hands } };
}

/** Play `card` in the determinized state and Medium the hand to its score. */
function playout(
  base: GameState,
  action: Action,
  seat: number,
  rng: Rng,
  policies: readonly Policy[],
  trickWeight: number,
): number {
  const scored = driveHand(mustApply(base, action), policies, rng);
  return sideDeltaFor(scored, seat) + trickBonus(scored, seat, trickWeight);
}

/**
 * Hard choosePlay: rollout EV per legal card over shared sampled worlds,
 * first-best wins. Requires `seat` to hold the turn of a state in play.
 */
export function choosePlayByRollout(
  state: GameState,
  seat: number,
  rng: Rng,
  options: HardPlayOptions = {},
): Card {
  const play = state.play;
  const contract = state.contract;
  if (state.phase !== 'play' || play === null || contract === null) {
    throw new Error(`cannot roll out a play during ${state.phase}`);
  }
  if (playToAct(play) !== seat) {
    throw new Error(`seat ${seat} does not hold the turn`);
  }
  const legal = legalPlaysFor(play, seat);
  const first = legal[0];
  if (first === undefined) throw new Error(`seat ${seat} has no legal play`);
  if (legal.length === 1) return first; // instant: no sampling, no clock

  const params = options.params ?? DEFAULT_PARAMS;
  const medium = params === DEFAULT_PARAMS ? MEDIUM : new MediumPolicy(params);
  const policies = playPolicies(params);
  const trickWeight = params.hardPlay.trickWeight;
  const deadline = options.deadlineMs;
  const now = options.now ?? Date.now;
  const start = deadline !== undefined ? now() : 0;
  const floor = Math.max(1, options.minWorlds ?? params.hardPlay.worldsFloor);
  const cap =
    deadline !== undefined
      ? Math.max(floor, options.maxWorlds ?? params.hardPlay.worldsCap)
      : Math.max(1, options.worlds ?? params.hardPlay.worldsFloor);

  // A joker led with no trump names a suit; the choice depends only on the
  // viewer's own fixed hand, so make it once and reuse it in every world.
  // HardPolicy.chooseJokerSuit applies the same rule, so the evaluated line
  // matches what the bot would actually play.
  const actionFor = (card: Card): Action => {
    if (card === JOKER && play.trump === null && play.ledSuit === null) {
      const rest = (play.hands[seat] ?? []).filter((c) => c !== JOKER);
      return { type: 'playCard', seat, card, jokerSuit: medium.chooseJokerSuit(rest) };
    }
    return { type: 'playCard', seat, card };
  };
  const actions = legal.map(actionFor);

  // Medium's card depends only on the (unmutated) decision state, so it is
  // fixed before any sampling — which lets every world score its paired
  // difference against it as it goes (see pickCard).
  //
  // This one Medium call is a REAL decision on the REAL history (the tiebreak
  // reference and the budget-miss fallback), unlike the simulator seats in
  // `policies`, which play out sampled worlds and must keep full information.
  // It therefore takes a memory as soon as Hard has one to give it: the seam
  // and the hand number are wired (fh-8jf.3), and fh-8jf.2 — which decides how
  // Hard seeds and enables its own memory in deriveConstraints — swaps this
  // `medium` for `medium.withMemory(seed)` so the two never disagree about
  // which cards are gone.
  const mediumCard = medium.choosePlay(
    seat,
    play.hands[seat] ?? [],
    legal,
    play.plays,
    play.trump,
    play.ledSuit,
    contract,
    { declarer: play.declarer, tricks: play.tricks, handNumber: state.handNumber },
  );
  const mediumIdx = legal.indexOf(mediumCard);

  const constraints = deriveConstraints(state, seat);
  const totals = legal.map(() => 0);
  const diffSq = legal.map(() => 0);
  const scores = legal.map(() => 0);
  let worldsDone = 0;
  while (worldsDone < cap) {
    if (deadline !== undefined && now() - start >= deadline) break;
    const base = determinize(state, sampleWorld(constraints, rng));
    for (let i = 0; i < actions.length; i++) {
      scores[i] = playout(base, actions[i] as Action, seat, rng, policies, trickWeight);
      totals[i] = (totals[i] as number) + (scores[i] as number);
    }
    if (mediumIdx >= 0) {
      const ref = scores[mediumIdx] as number;
      for (let i = 0; i < scores.length; i++) {
        const d = (scores[i] as number) - ref;
        diffSq[i] = (diffSq[i] as number) + d * d;
      }
    }
    worldsDone++;
  }

  const elapsedMs = deadline !== undefined ? now() - start : 0;
  if (deadline !== undefined && worldsDone < floor) {
    // Too few worlds to trust the averages: the budget was missed, so take
    // Medium's heuristic choice instead (packet fallback, reported for logs).
    options.onDecision?.({ seat, worldsDone, elapsedMs, fellBack: true });
    return mediumCard;
  }
  options.onDecision?.({ seat, worldsDone, elapsedMs, fellBack: false });
  return pickCard(
    legal,
    { totals, diffSq, worldsDone, mediumIdx },
    {
      eps: params.hardPlay.mediumTiebreakEps,
      z: params.hardPlay.mediumTiebreakZ,
    },
  );
}

/**
 * What the shared-world sampling loop learned about each legal card: the
 * summed playout score, and the summed SQUARE of each world's paired
 * difference against Medium's card. The paired sum itself is not carried —
 * summing `score_i - score_m` world by world is exactly `totals[i] -
 * totals[mediumIdx]` — but the squares cannot be recovered after the fact, so
 * they are accumulated inline.
 */
export interface RolloutTally {
  readonly totals: readonly number[];
  readonly diffSq: readonly number[];
  readonly worldsDone: number;
  /** Index of Medium's card in `legal`, or -1 if it is somehow not legal. */
  readonly mediumIdx: number;
}

/** How hard the rollout must beat Medium's card before it is allowed to. */
export interface TiebreakGate {
  /** Absolute floor, in points, under which a lead is never enough. */
  readonly eps: number;
  /** Standard errors of the paired difference the lead must also clear. */
  readonly z: number;
}

/**
 * Arg-max over averaged rollout scores, but defer to Medium's card when the
 * rollout cannot clearly separate its pick from it (fh-vkr, fh-hg4, fh-4ww).
 *
 * The rollout evaluates every candidate on the SAME sampled worlds (common
 * random numbers), so the paired difference `score_i - score_medium` is the
 * quantity to test: absolute EVs swing by hundreds of points world to world,
 * but most of that swing is the deal, and it cancels in the pair. When the
 * search is genuinely indifferent (cash-now vs cash-later, draw-trump vs
 * lead-side under a weak Medium simulator), that difference is noise around
 * zero — and a bare arg-max then keeps whichever card noise happened to
 * favour, which for the lowest-index legal card means the lowest card / a low
 * trump. Deferring to Medium instead injects its cash-from-top (fh-2wt),
 * trump-draw (fh-n2n), and don't-lead-trump (fh-1em) discipline into Hard
 * exactly where Hard's own search is blind.
 *
 * A fixed `eps` alone could not do that job (fh-4ww): the real spread of the
 * paired mean at these states is tens of points, so a threshold small enough
 * to be safe at a well-separated decision never fires at a noisy one — game
 * 74a62326 hand 0 still led a low spade off A-Q-x of trump about a third of
 * the time. So the gate is noise-aware: the lead must clear `z` standard
 * errors of its OWN paired difference as well as the absolute floor `eps`.
 * Where the rollout truly separates the cards the standard error collapses
 * and the gate is just `eps`; where it is guessing, the standard error is
 * large and Medium's card wins. Zero variance (every world agreed) leaves the
 * bare `eps` floor, so a unanimous real edge is never overridden.
 */
export function pickCard(legal: readonly Card[], tally: RolloutTally, gate: TiebreakGate): Card {
  const { totals, diffSq, worldsDone, mediumIdx } = tally;
  let bestIdx = 0;
  let bestEV = -Infinity;
  for (let i = 0; i < legal.length; i++) {
    const ev = (totals[i] as number) / worldsDone;
    if (ev > bestEV) {
      bestIdx = i;
      bestEV = ev;
    }
  }
  const best = legal[bestIdx] as Card;
  if (mediumIdx < 0 || mediumIdx === bestIdx) return best;

  // Paired mean and its standard error. Summing (score_i - score_m) world by
  // world telescopes to the difference of the totals, so only the squares had
  // to be carried.
  const n = worldsDone;
  const mean = ((totals[bestIdx] as number) - (totals[mediumIdx] as number)) / n;
  const variance =
    n > 1 ? Math.max(0, ((diffSq[bestIdx] as number) - n * mean * mean) / (n - 1)) : 0;
  const stdErr = Math.sqrt(variance / n);
  return mean <= Math.max(gate.eps, gate.z * stdErr) ? (legal[mediumIdx] as Card) : best;
}
