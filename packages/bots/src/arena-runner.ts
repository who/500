/**
 * Hard-vs-Hard arena runner (fh-sja.3). Bridges the params-generic match
 * arena in @five-hundred/learn to real games: given the four seats' BotParams
 * and a seed, it builds a HardPolicy per seat and plays one full game through
 * the sim harness, returning the winning side. This is the {@link MatchRunner}
 * the learn arena and the self-play tuner (fh-sja.4) inject.
 *
 * It lives in @five-hundred/bots, not learn, because the dependency runs
 * bots -> learn (bots may build policies from learn's types, learn may not
 * reach back for HardPolicy). The arena's mirroring, SPRT, and promotion gate
 * stay in learn; only the "actually play a Hard game" step is here.
 *
 * Determinism: HardPolicy is pure given its Rng, and the whole game runs off a
 * single makeRng(seed) stream (matching sim.ts playGame), so the same seat
 * params + seed always produce the same winner — the property the arena's
 * AC-1 determinism guarantee rests on.
 */

import { makeRng } from '@five-hundred/engine';
import type { MatchRunner } from '@five-hundred/learn';
import { type BotParams, DEFAULT_PARAMS } from './params.js';
import { HardPolicy, type HardPolicyOptions } from './hard/policy.js';
import { playGameRecording } from './sim.js';

export interface HardRunnerOptions {
  /** Worlds per bid/slam decision (small = fast). Defaults to HardPolicy's. */
  readonly bidWorlds?: number;
  /** Worlds per keep decision. Defaults to HardPolicy's. */
  readonly keepWorlds?: number;
  /** Fixed worlds per card-play decision. Defaults to HardPolicy's. */
  readonly playWorlds?: number;
}

/** Build a HardPolicy for one seat from its params + the shared world budget. */
function seatPolicy(params: BotParams, opts: HardRunnerOptions): HardPolicy {
  const hard: HardPolicyOptions = { params };
  if (opts.bidWorlds !== undefined) (hard as { bidWorlds?: number }).bidWorlds = opts.bidWorlds;
  if (opts.keepWorlds !== undefined) (hard as { keepWorlds?: number }).keepWorlds = opts.keepWorlds;
  if (opts.playWorlds !== undefined) {
    (hard as { play?: { worlds: number } }).play = { worlds: opts.playWorlds };
  }
  return new HardPolicy(hard);
}

/**
 * A {@link MatchRunner} over BotParams that plays one full Hard-vs-Hard game.
 * Returns the winning side (0 = seats 0/2, 1 = seats 1/3); a game that hits the
 * hand cap without a 500-point winner is resolved by most-points-wins (ties to
 * side 0), so the runner never returns a draw — every game is a decisive SPRT
 * observation.
 */
export function makeHardMatchRunner(
  options: HardRunnerOptions = {},
): MatchRunner<BotParams> {
  return (seatParams, seed) => {
    const policies = [
      seatPolicy(seatParams[0], options),
      seatPolicy(seatParams[1], options),
      seatPolicy(seatParams[2], options),
      seatPolicy(seatParams[3], options),
    ];
    const rng = makeRng(seed);
    const state = playGameRecording(policies, rng, seed, () => {});
    if (state.game.winner !== null) return state.game.winner === 0 ? 0 : 1;
    // Hand cap reached: most points wins, ties to side 0 (oracle play_game).
    return state.game.scores[0] >= state.game.scores[1] ? 0 : 1;
  };
}

/**
 * A crippled BotParams that bids recklessly: a hugely negative Hard rollout bid
 * margin means the best-EV candidate always clears the (now trivially low) pass
 * baseline, so the side declares a contract on every hand regardless of its
 * hand strength, over-reaches, and is set again and again — a decisive,
 * points-hemorrhaging loser. Used by the arena sanity test (AC-2) as the
 * "obviously worse" configuration that must lose and be rejected.
 *
 * Note on the AC's "e.g. never bid" phrasing: an *always-pass* side is NOT a
 * decisive loser in this engine — it becomes a permanent defender, and against
 * shallow-rollout declarers that get set often, passive defending actually wins
 * a slight majority. Reckless over-bidding is the config that loses decisively,
 * so that is what this fixture uses.
 */
export function recklessBidParams(base: BotParams = DEFAULT_PARAMS): BotParams {
  return {
    ...base,
    hardBidding: { ...base.hardBidding, bidMargin: -1e12 },
  };
}
