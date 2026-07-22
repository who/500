/**
 * Hard-beats-Medium strength gate — the M7 exit criterion (fh-7hw.5, PRD
 * sections 4.3, 7.3): Hard partnerships must beat Medium partnerships in at
 * least 60% of 200 seeded headless games, measured for both side
 * assignments (AC-1, AC-3).
 *
 * In-suite world budget: bidWorlds 8, keepWorlds 10, play.worlds 8 — reduced
 * from the shipped defaults (16 / 30 / 20) purely for suite runtime (~11s per
 * side vs ~25s), as the packet's resolved decision allows because the gate
 * passes at it. No tuning of the shipped constants was needed; the sweep at
 * seed 7, 200 games per side:
 *
 *   budget (bid/keep/play)   Hard as side 0   Hard as side 1
 *   16/30/20 (defaults)           97.5%            97.0%
 *    8/10/8  (this suite)         96.0%            94.5%
 *    4/5/4                        92.5%            89.0%
 *
 * The full-budget row is reproducible via the CLI (AC-2):
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

/** Reduced-but-documented in-suite budget (see the sweep table above). */
const SUITE_BUDGET = {
  bidWorlds: 8,
  keepWorlds: 10,
  play: { worlds: 8 },
} as const;

const hard = (): HardPolicy => new HardPolicy(SUITE_BUDGET);

describe('Hard-beats-Medium strength gate', () => {
  it(`Hard as side 0 wins >= 60% of ${GAMES} games`, { timeout: 120_000 }, async () => {
    const policies = [hard(), new MediumPolicy(), hard(), new MediumPolicy()];
    const wins = await simulateGamesYielding(GAMES, policies, SEED);
    expect(wins[0] + wins[1]).toBe(GAMES);
    expect(wins[0] / GAMES).toBeGreaterThanOrEqual(GATE);
  });

  it(`Hard as side 1 wins >= 60% of ${GAMES} games`, { timeout: 120_000 }, async () => {
    const policies = [new MediumPolicy(), hard(), new MediumPolicy(), hard()];
    const wins = await simulateGamesYielding(GAMES, policies, SEED);
    expect(wins[0] + wins[1]).toBe(GAMES);
    expect(wins[1] / GAMES).toBeGreaterThanOrEqual(GATE);
  });
});
