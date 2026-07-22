/**
 * Hard-beats-Medium strength gate — the M7 exit criterion (fh-7hw.5, PRD
 * sections 4.3, 7.3): Hard partnerships must beat Medium partnerships in at
 * least 60% of 200 seeded headless games, measured for both side
 * assignments (AC-1, AC-3).
 *
 * In-suite world budget: the shipped defaults (bidWorlds 16, keepWorlds 30,
 * play.worlds 20). This suite used to run a reduced 8/10/8 budget for speed,
 * "as the packet's resolved decision allows because the gate passes at it" —
 * but fh-61z made Medium partner-aware in the trick (it no longer ruffs or
 * overtakes its own partner's winners), which turns Medium into a materially
 * stronger opponent AND a sharper rollout model on both sides. Against that
 * Medium the reduced budget no longer clears the gate, so the suite now runs
 * at the real shipping budget, where it clears comfortably. The sweep at
 * seed 7, 200 games per side, with the fh-61z Medium:
 *
 *   budget (bid/keep/play)   Hard as side 0   Hard as side 1
 *   16/30/20 (this suite)         68.0%            65.5%
 *   14/24/16                      65.0%            59.0%
 *   12/20/12                      60.0%            62.5%
 *   10/14/10                      63.0%            61.5%
 *    8/10/8  (old suite)          62.5%            58.0%
 *
 * Win rate is noisy and non-monotonic in the budget at this sample size, so
 * the defaults (the only row that clears 60% on both sides with margin) are
 * the robust choice. The gate is reproducible via the CLI (AC-2):
 *   pnpm --filter @five-hundred/bots sim:hard -- --games 200 --seed 7
 */

import { describe, expect, it } from 'vitest';
// simulateGamesYielding, not simulateGames: each side's 200-game loop runs
// ~35s, and fully synchronous it starves the vitest worker's RPC channel
// ('[vitest-worker]: Timeout calling onTaskUpdate' -> exit 1 despite all
// tests passing, fh-vrj). Same rng stream, so results are bit-identical.
import { HardPolicy, MediumPolicy, simulateGamesYielding } from '../src/index.js';

const GAMES = 200;
const SEED = 7;
const GATE = 0.6;

/** In-suite budget: the shipped defaults (see the sweep table above). */
const SUITE_BUDGET = {
  bidWorlds: 16,
  keepWorlds: 30,
  play: { worlds: 20 },
} as const;

const hard = (): HardPolicy => new HardPolicy(SUITE_BUDGET);

describe('Hard-beats-Medium strength gate', () => {
  it(`Hard as side 0 wins >= 60% of ${GAMES} games`, { timeout: 180_000 }, async () => {
    const policies = [hard(), new MediumPolicy(), hard(), new MediumPolicy()];
    const wins = await simulateGamesYielding(GAMES, policies, SEED);
    expect(wins[0] + wins[1]).toBe(GAMES);
    expect(wins[0] / GAMES).toBeGreaterThanOrEqual(GATE);
  });

  it(`Hard as side 1 wins >= 60% of ${GAMES} games`, { timeout: 180_000 }, async () => {
    const policies = [new MediumPolicy(), hard(), new MediumPolicy(), hard()];
    const wins = await simulateGamesYielding(GAMES, policies, SEED);
    expect(wins[0] + wins[1]).toBe(GAMES);
    expect(wins[1] / GAMES).toBeGreaterThanOrEqual(GATE);
  });
});
