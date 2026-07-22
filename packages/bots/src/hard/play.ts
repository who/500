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
import { JOKER, legalPlaysFor, playToAct } from '@five-hundred/engine';
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
): number {
  const scored = driveHand(mustApply(base, action), policies, rng);
  return sideDeltaFor(scored, seat);
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

  const constraints = deriveConstraints(state, seat);
  const totals = legal.map(() => 0);
  let worldsDone = 0;
  while (worldsDone < cap) {
    if (deadline !== undefined && now() - start >= deadline) break;
    const base = determinize(state, sampleWorld(constraints, rng));
    for (let i = 0; i < actions.length; i++) {
      totals[i] = (totals[i] as number) + playout(base, actions[i] as Action, seat, rng, policies);
    }
    worldsDone++;
  }

  const elapsedMs = deadline !== undefined ? now() - start : 0;
  if (deadline !== undefined && worldsDone < floor) {
    // Too few worlds to trust the averages: the budget was missed, so take
    // Medium's heuristic choice instead (packet fallback, reported for logs).
    options.onDecision?.({ seat, worldsDone, elapsedMs, fellBack: true });
    return medium.choosePlay(
      seat,
      play.hands[seat] ?? [],
      legal,
      play.plays,
      play.trump,
      play.ledSuit,
      contract,
      { declarer: play.declarer, tricks: play.tricks },
    );
  }
  options.onDecision?.({ seat, worldsDone, elapsedMs, fellBack: false });
  let best = first;
  let bestEV = -Infinity;
  for (let i = 0; i < legal.length; i++) {
    const ev = (totals[i] as number) / worldsDone;
    if (ev > bestEV) {
      best = legal[i] as Card;
      bestEV = ev;
    }
  }
  return best;
}
