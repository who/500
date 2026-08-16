/**
 * Arena end-to-end with real Hard bots (fh-sja.3). The params-generic arena
 * mechanics (mirroring, SPRT, promotion gate) are unit-tested in
 * packages/learn; this spec wires the real {@link makeHardMatchRunner} into
 * {@link runMatch} / {@link promoteIfBetter} to prove the acceptance criteria
 * against actual games:
 *
 *   AC-1  Deterministic given seeds — the same seeds reproduce the same match.
 *   AC-2  Crippled params (reckless over-bidding) lose decisively and are
 *         rejected; identical params do not promote.
 *
 * World counts are held tiny so the games are fast; the verdicts here are
 * about lopsided match-ups (default bidding vs a side that recklessly
 * over-bids and is set every hand), decisive long before rollout depth matters.
 */

import { describe, expect, it } from 'vitest';
import { promoteIfBetter, runMatch } from '@five-hundred/learn';
import { DEFAULT_PARAMS } from '../src/params.js';
import { makeHardMatchRunner, recklessBidParams } from '../src/arena-runner.js';

// A very small world budget: fast, and plenty for a landslide match-up.
const run = makeHardMatchRunner({ bidWorlds: 2, keepWorlds: 2, playWorlds: 1 });

/**
 * SPRT seed budget for the crippled-candidate tests. The reckless side is a
 * decisive loser but not a landslide one — it wins ~42% of mirrored games
 * (measured over 500 games at seeds 7 and 21), which the p0=0.5 / p1=0.55 test
 * needs ~70 seeds on average to reject. The original budget of 80 seeds sat
 * right on that boundary, so an unrelated play-side change (fh-1em, which
 * stopped the declarer's partner leading trump) reshuffled the early games and
 * left the verdict at 'continue' with the win rate still at 42% over a longer
 * run. The budget is a cap, not a game count — a decisive match still stops as
 * soon as the llr crosses — so raising it buys headroom for free.
 */
const CRIPPLED_MAX_SEEDS = 200;

// Skipped under CI (fh-xj5): GitHub Actions runs unit and light integration
// tests only, and these SPRT matches play tens of real Hard-vs-Hard games
// (GitHub sets CI=true; a shell with CI exported skips it too). The suite
// stays part of a plain local `pnpm --filter @five-hundred/bots test`.
describe.skipIf(process.env.CI === 'true')('Hard-vs-Hard arena', () => {
  it('AC-2: a reckless-overbid side loses decisively and is rejected', async () => {
    const crippled = recklessBidParams();
    // Candidate = crippled, incumbent = default: candidate must be rejected.
    const r = await runMatch({
      a: crippled,
      b: DEFAULT_PARAMS,
      run,
      maxGames: CRIPPLED_MAX_SEEDS,
      seed: 7,
      concurrency: 4,
    });
    expect(r.verdict).toBe('accept-h0');
    expect(r.promote).toBe(false);
    expect(r.winRate).toBeLessThan(0.5);
  }, 60_000);

  it('AC-2: promoteIfBetter rejects the crippled candidate at the incumbent gate', async () => {
    const d = await promoteIfBetter(
      recklessBidParams(),
      DEFAULT_PARAMS,
      DEFAULT_PARAMS,
      { run, maxGames: CRIPPLED_MAX_SEEDS, seed: 7, concurrency: 4 },
    );
    expect(d.promote).toBe(false);
    expect(d.vsIncumbent.verdict).toBe('accept-h0');
    expect(d.vsAnchor).toBeNull(); // short-circuited: never reached the anchor
  }, 60_000);

  it('AC-2: identical params do not promote', async () => {
    const d = await promoteIfBetter(
      DEFAULT_PARAMS,
      DEFAULT_PARAMS,
      DEFAULT_PARAMS,
      { run, maxGames: 60, seed: 3, concurrency: 4 },
    );
    expect(d.promote).toBe(false);
    expect(d.vsIncumbent.promote).toBe(false);
  }, 60_000);

  it('AC-1: same seeds reproduce the same match verdict and counts', async () => {
    const opts = {
      a: recklessBidParams(),
      b: DEFAULT_PARAMS,
      run,
      maxGames: 30,
      seed: 99,
    } as const;
    const first = await runMatch({ ...opts, concurrency: 1 });
    const second = await runMatch({ ...opts, concurrency: 8 });
    expect(second.verdict).toBe(first.verdict);
    expect(second.wins).toBe(first.wins);
    expect(second.losses).toBe(first.losses);
    expect(second.gamesPlayed).toBe(first.gamesPlayed);
  }, 60_000);
});
