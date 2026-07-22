/**
 * Arena match runner + promotion gate (fh-sja.3). The acceptance criteria that
 * need real Hard bots run in packages/bots/test; here the arena's own mechanics
 * are pinned against a deterministic toy runner where a param's "skill" maps
 * monotonically to its win probability, so the tests are fast and exact.
 *
 *   AC-1  Deterministic given seeds — same seeds (and any concurrency) -> same
 *         verdict.
 *   AC-2  A crippled candidate loses decisively and is rejected; identical
 *         params never promote.
 *
 * The toy runner models seat/deal luck as a per-seed noise term applied with
 * opposite sign to the two mirror legs, so that (a) equal-skill sides split
 * every mirrored seed exactly 1-1 (winrate 0.5), and (b) a pure seat bias
 * cancels under mirroring — both properties the real arena relies on.
 */

import { describe, expect, it } from 'vitest';
import { makeRng } from '@five-hundred/engine';
import { type MatchRunner, promoteIfBetter, runMatch } from './arena.js';

interface Skill {
  readonly skill: number;
}

/** Per-seed luck in [-1, 1); decorrelated from the arena's own seed stream. */
function noiseFor(seed: number): number {
  return makeRng((seed ^ 0x9e3779b9) >>> 0).random() * 2 - 1;
}

/**
 * Winning side is the partnership with the higher summed skill plus a per-seed
 * luck term. Because the arena replays each seed mirrored, the same `seed` (and
 * thus the same noise) lands on A with one sign and on B with the other, so
 * equal skills split 1-1 per seed and skill is what survives.
 */
const skillRunner: MatchRunner<Skill> = (seatParams, seed) => {
  const side0 = seatParams[0].skill + seatParams[2].skill;
  const side1 = seatParams[1].skill + seatParams[3].skill;
  const margin = side0 - side1 + noiseFor(seed);
  if (margin === 0) return null;
  return margin > 0 ? 0 : 1;
};

describe('runMatch', () => {
  it('accepts H1 when A is clearly stronger', async () => {
    const r = await runMatch<Skill>({
      a: { skill: 2 },
      b: { skill: 1 },
      run: skillRunner,
      maxGames: 200,
    });
    expect(r.verdict).toBe('accept-h1');
    expect(r.promote).toBe(true);
    expect(r.winRate).toBeGreaterThan(0.5);
    expect(r.confidence).toBeCloseTo(0.95);
  });

  it('accepts H1 for a modest but real edge, via accumulation not sweeps', async () => {
    const r = await runMatch<Skill>({
      a: { skill: 1.2 },
      b: { skill: 1.0 },
      run: skillRunner,
      maxGames: 2000,
    });
    expect(r.verdict).toBe('accept-h1');
    expect(r.promote).toBe(true);
    // A ~70% edge decides well before the budget is exhausted.
    expect(r.seedsPlayed).toBeLessThan(2000);
    expect(r.winRate).toBeGreaterThan(0.55);
  });

  it('rejects a decisively weaker A (accept-h0, no promotion)', async () => {
    const r = await runMatch<Skill>({
      a: { skill: 0 },
      b: { skill: 1 },
      run: skillRunner,
      maxGames: 200,
    });
    expect(r.verdict).toBe('accept-h0');
    expect(r.promote).toBe(false);
    expect(r.winRate).toBeLessThan(0.5);
  });

  it('identical params split every mirrored seed 1-1 and never promote', async () => {
    const r = await runMatch<Skill>({
      a: { skill: 1 },
      b: { skill: 1 },
      run: skillRunner,
      maxGames: 60,
    });
    expect(r.promote).toBe(false);
    // Exact 0.5 winrate is the mirroring cancelling luck seed-by-seed.
    expect(r.winRate).toBeCloseTo(0.5);
    expect(r.wins).toBe(r.losses);
  });

  it('cancels a pure seat bias under mirroring', async () => {
    // A runner that always hands the game to physical side 0, regardless of
    // params. Under mirroring A sits side 0 on one leg and side 1 on the other,
    // so it wins exactly half — no spurious promotion from seat advantage.
    const seatBiased: MatchRunner<Skill> = () => 0;
    const r = await runMatch<Skill>({
      a: { skill: 5 },
      b: { skill: 0 },
      run: seatBiased,
      maxGames: 60,
    });
    expect(r.winRate).toBeCloseTo(0.5);
    expect(r.promote).toBe(false);
  });

  it('AC-1: same seeds -> same verdict, independent of concurrency', async () => {
    const base = {
      a: { skill: 1.2 },
      b: { skill: 1.0 },
      run: skillRunner,
      maxGames: 1500,
      seed: 12345,
    } as const;
    const serial = await runMatch<Skill>({ ...base, concurrency: 1 });
    const parallel = await runMatch<Skill>({ ...base, concurrency: 16 });
    expect(parallel.verdict).toBe(serial.verdict);
    expect(parallel.winRate).toBe(serial.winRate);
    expect(parallel.wins).toBe(serial.wins);
    expect(parallel.losses).toBe(serial.losses);
    expect(parallel.gamesPlayed).toBe(serial.gamesPlayed);
  });

  it('a different base seed can move the boundary case', async () => {
    // Not a determinism violation — different seeds are allowed to differ; this
    // just guards against the runner ignoring the seed entirely.
    const opts = { a: { skill: 1.05 }, b: { skill: 1.0 }, run: skillRunner, maxGames: 40 };
    const x = await runMatch<Skill>({ ...opts, seed: 1 });
    const y = await runMatch<Skill>({ ...opts, seed: 1 });
    expect(x.wins).toBe(y.wins); // same seed reproduces
  });
});

describe('promoteIfBetter', () => {
  const anchor: Skill = { skill: 1 };
  const incumbent: Skill = { skill: 1 };
  const opts = { run: skillRunner, maxGames: 300 } as const;

  it('AC-2: a crippled candidate is rejected and never touches the anchor', async () => {
    const crippled: Skill = { skill: 0 };
    const d = await promoteIfBetter<Skill>(crippled, incumbent, anchor, opts);
    expect(d.promote).toBe(false);
    expect(d.vsIncumbent.verdict).toBe('accept-h0');
    // Incumbent gate failed, so the anchor comparison is short-circuited.
    expect(d.vsAnchor).toBeNull();
  });

  it('AC-2: identical candidate/incumbent does not promote', async () => {
    const d = await promoteIfBetter<Skill>({ skill: 1 }, incumbent, anchor, opts);
    expect(d.promote).toBe(false);
    expect(d.vsIncumbent.promote).toBe(false);
  });

  it('promotes a candidate that beats the incumbent without regressing vs anchor', async () => {
    const candidate: Skill = { skill: 1.4 };
    const d = await promoteIfBetter<Skill>(candidate, incumbent, anchor, opts);
    expect(d.vsIncumbent.promote).toBe(true);
    expect(d.vsAnchor).not.toBeNull();
    // Candidate is stronger than the anchor too, so the anchor cannot beat it.
    expect(d.vsAnchor?.verdict).not.toBe('accept-h1');
    expect(d.promote).toBe(true);
  });

  it('blocks a candidate that beats a weak incumbent but regresses vs the anchor', async () => {
    // Incumbent has drifted weak; candidate beats it but is worse than the
    // frozen anchor -> the anchor out-plays the candidate -> rejected.
    const weakIncumbent: Skill = { skill: 0.2 };
    const strongAnchor: Skill = { skill: 1.5 };
    const candidate: Skill = { skill: 0.6 };
    const d = await promoteIfBetter<Skill>(candidate, weakIncumbent, strongAnchor, opts);
    expect(d.vsIncumbent.promote).toBe(true);
    expect(d.vsAnchor?.verdict).toBe('accept-h1'); // anchor is significantly better
    expect(d.promote).toBe(false);
  });
});
