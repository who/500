/**
 * CEM tuner engine tests (fh-sja.4). The optimizer is exercised against a
 * synthetic, noise-free fitness (negative squared distance to a hidden target)
 * so its mechanics — convergence, determinism, and resumability — can be
 * asserted exactly, independent of the real (noisy, slow) arena oracle. The
 * real Hard-bot end-to-end acceptance run lives in packages/bots/test.
 */

import { describe, expect, it } from 'vitest';
import {
  type CemOptions,
  type Dimension,
  type FitnessFn,
  buildReport,
  initialState,
  runCem,
  stepGeneration,
} from './tuner.js';

const DIMS: Dimension[] = [
  { name: 'x', min: -10, max: 10, initMean: 0, initStd: 4 },
  { name: 'y', min: -10, max: 10, initMean: 0, initStd: 4 },
];

const TARGET = [3.5, -2.25];

/** Deterministic bowl: fitness peaks (score 0) at TARGET, no noise, no games. */
const bowl: FitnessFn = (vector) => {
  let sq = 0;
  for (let i = 0; i < vector.length; i++) {
    const d = (vector[i] as number) - (TARGET[i] as number);
    sq += d * d;
  }
  return { score: -sq, games: 4 };
};

function opts(over: Partial<CemOptions> = {}): CemOptions {
  return {
    dimensions: DIMS,
    populationSize: 40,
    eliteFrac: 0.25,
    generations: 20,
    seed: 12345,
    smoothing: 0.8,
    minStdFrac: 0.001,
    ...over,
  };
}

describe('CEM tuner engine', () => {
  it('converges toward the hidden optimum (AC-1 optimizer works)', async () => {
    const final = await runCem(opts(), bowl);
    expect(final.best).not.toBeNull();
    const v = final.best!.vector;
    expect(v[0]).toBeCloseTo(TARGET[0] as number, 1);
    expect(v[1]).toBeCloseTo(TARGET[1] as number, 1);
    // The distribution mean should also have homed in.
    expect(final.mean[0]).toBeCloseTo(TARGET[0] as number, 1);
    expect(final.mean[1]).toBeCloseTo(TARGET[1] as number, 1);
  });

  it('is a pure function of the seed (AC-1 reproducible)', async () => {
    const a = await runCem(opts(), bowl);
    const b = await runCem(opts(), bowl);
    expect(b.best!.vector).toEqual(a.best!.vector);
    expect(b.mean).toEqual(a.mean);
    expect(b.totalGames).toBe(a.totalGames);
  });

  it('is independent of evaluation concurrency (AC-1 determinism)', async () => {
    const seq = await runCem(opts({ evalConcurrency: 1 }), bowl);
    const par = await runCem(opts({ evalConcurrency: 8 }), bowl);
    expect(par.best!.vector).toEqual(seq.best!.vector);
    expect(par.history.map((h) => h.bestScore)).toEqual(seq.history.map((h) => h.bestScore));
  });

  it('resuming from a persisted mid-run state matches a fresh full run (AC-1 resumable)', async () => {
    const full = await runCem(opts({ generations: 12 }), bowl);

    // Run 5 generations, capture the state, then resume for the remaining 7.
    let saved = initialState(opts({ generations: 12 }));
    for (let g = 0; g < 5; g++) saved = await stepGeneration(saved, opts({ generations: 12 }), bowl);
    const resumed = await runCem(opts({ generations: 12 }), bowl, {}, saved);

    expect(resumed.generation).toBe(full.generation);
    expect(resumed.best!.vector).toEqual(full.best!.vector);
    expect(resumed.mean).toEqual(full.mean);
    expect(resumed.history.map((h) => h.bestScore)).toEqual(full.history.map((h) => h.bestScore));
  });

  it('rejects a resume whose config no longer matches the state', async () => {
    const saved = initialState(opts());
    await expect(runCem(opts({ seed: 999 }), bowl, {}, saved)).rejects.toThrow(/config mismatch/);
  });

  it('stops at the game budget between generations', async () => {
    // 40 candidates * 4 games = 160 games/generation; budget stops after gen 1.
    const final = await runCem(opts({ generations: 20, gameBudget: 150 }), bowl);
    expect(final.generation).toBe(1);
    expect(final.totalGames).toBeGreaterThanOrEqual(150);
  });

  it('never regresses the best-so-far across generations (ratchet)', async () => {
    const final = await runCem(opts(), bowl);
    let prev = -Infinity;
    let runningBest = -Infinity;
    for (const h of final.history) {
      runningBest = Math.max(runningBest, h.bestScore);
      // The running best is monotone non-decreasing.
      expect(runningBest).toBeGreaterThanOrEqual(prev);
      prev = runningBest;
    }
    expect(final.best!.score).toBeCloseTo(runningBest, 10);
  });

  it('builds a report with shipped-vs-tuned diffs and a trajectory', async () => {
    const o = opts({ generations: 6 });
    const final = await runCem(o, bowl);
    const report = buildReport(o, final);
    expect(report.dimensions).toHaveLength(2);
    expect(report.dimensions[0]!.name).toBe('x');
    expect(report.dimensions[0]!.shipped).toBe(0);
    // Tuned x moved toward the target.
    expect(Math.abs(report.dimensions[0]!.tuned - (TARGET[0] as number))).toBeLessThan(1);
    expect(report.trajectory).toHaveLength(6);
    expect(report.generationsRun).toBe(6);
  });
});
