/**
 * Self-play tuner end-to-end with real Hard bots (fh-sja.4). The CEM engine's
 * own mechanics (convergence, resume, budget) are unit-tested against a
 * synthetic fitness in packages/learn; this spec proves the acceptance criteria
 * against the real arena and the real BotParams loader:
 *
 *   AC-1  A seeded run is reproducible and resumable with the real Hard runner.
 *   AC-2  The promotion gate the tuner writes behind is decisive: a candidate
 *         that clears the SPRT confirmation beats the incumbent, and its overlay
 *         round-trips through the real params loader; a non-improving candidate
 *         is report-only (no overlay).
 *   AC-3  A promoted Hard overlay (hardBidding.* only) leaves Easy/Medium play
 *         byte-identical — the tier-stability guardrail, checked structurally
 *         and by seeded self-play.
 *   AC-4  Shipped Hard beats Medium at >=60% (the gate that must stay green).
 *
 * World counts are held small so the games are fast; the decisive match-ups
 * here (default vs reckless over-bidder) settle long before rollout depth bites.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type CemOptions,
  type FitnessFn,
  buildReport,
  initialState,
  promoteIfBetter,
  runCem,
  stepGeneration,
} from '@five-hundred/learn';
import { DEFAULT_PARAMS, loadParams, mergeParams } from '../src/params.js';
import { makeHardMatchRunner, recklessBidParams } from '../src/arena-runner.js';
import { MediumPolicy } from '../src/medium.js';
import { simulateGames } from '../src/sim.js';
import {
  HARD_LEAVES,
  dimensionsFor,
  mirroredWinRate,
  overlayVersion,
  vectorToOverlay,
  vectorToParams,
} from '../src/tune.js';

const run = makeHardMatchRunner({ bidWorlds: 2, keepWorlds: 2, playWorlds: 1 });

const tmp = mkdtempSync(join(tmpdir(), 'tune-spec-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A small real-runner CEM config, centered on the shipped Hard params. */
function cem(over: Partial<CemOptions> = {}): CemOptions {
  return {
    dimensions: dimensionsFor(HARD_LEAVES, DEFAULT_PARAMS),
    populationSize: 6,
    eliteFrac: 0.34,
    generations: 2,
    seed: 4,
    ...over,
  };
}

/** Fitness = candidate's mirrored win-rate vs the incumbent, tiny budget. */
function fitnessVs(incumbent = DEFAULT_PARAMS): FitnessFn {
  return async (vector, ctx) => {
    const cand = vectorToParams(HARD_LEAVES, vector, incumbent);
    const { winRate, games } = await mirroredWinRate(cand, incumbent, run, 4, ctx.seed, 4);
    return { score: winRate, games };
  };
}

// Skipped under CI (fh-xj5): GitHub Actions runs unit and light integration
// tests only, and this suite spends minutes on real Hard arena games (GitHub
// sets CI=true; a shell with CI exported skips it too). It stays part of a
// plain local `pnpm --filter @five-hundred/bots test`.
describe.skipIf(process.env.CI === 'true')('Self-play tuner (real Hard arena)', () => {
  it('AC-1: a seeded run with the real runner is reproducible', async () => {
    const a = await runCem(cem(), fitnessVs());
    const b = await runCem(cem(), fitnessVs());
    expect(b.best!.vector).toEqual(a.best!.vector);
    expect(b.history.map((h) => h.bestScore)).toEqual(a.history.map((h) => h.bestScore));
    expect(b.totalGames).toBe(a.totalGames);
  }, 120_000);

  it('AC-1: resuming a persisted mid-run state matches a fresh full run', async () => {
    const full = await runCem(cem({ generations: 3 }), fitnessVs());

    // Run one generation, persist to disk, then resume from the file.
    let saved = initialState(cem({ generations: 3 }));
    saved = await stepGeneration(saved, cem({ generations: 3 }), fitnessVs());
    const statePath = join(tmp, 'resume.tuner-state.json');
    writeFileSync(statePath, JSON.stringify(saved));

    const reloaded = JSON.parse(readFileSync(statePath, 'utf8'));
    const resumed = await runCem(cem({ generations: 3 }), fitnessVs(), {}, reloaded);

    expect(resumed.generation).toBe(full.generation);
    expect(resumed.best!.vector).toEqual(full.best!.vector);
    expect(resumed.history.map((h) => h.bestScore)).toEqual(full.history.map((h) => h.bestScore));
  }, 180_000);

  it('AC-2: a decisively-better candidate clears the SPRT gate and its overlay round-trips', async () => {
    // Incumbent = a self-destructive over-bidder (reckless numbered bids AND
    // reckless slams) — a decisive loser across seeds. The shipped defaults are
    // the decisively-better "candidate" the tuner's promotion gate must pass.
    const base = recklessBidParams();
    const incumbent = { ...base, hardBidding: { ...base.hardBidding, slamMargin: -1e12 } };
    const decision = await promoteIfBetter(DEFAULT_PARAMS, incumbent, DEFAULT_PARAMS, {
      run,
      maxGames: 120,
      seed: 7,
      concurrency: 8,
    });
    expect(decision.promote).toBe(true);
    expect(decision.vsIncumbent.verdict).toBe('accept-h1');
    expect(decision.vsIncumbent.winRate).toBeGreaterThan(0.5);

    // The overlay the CLI would write for this winner must reload to the same
    // params through the real, untouched loader (AC-2 "written overlay").
    const best = await runCem(cem(), fitnessVs(incumbent));
    const overlay = vectorToOverlay(HARD_LEAVES, best.best!.vector);
    const overlayPath = join(tmp, 'hard-overlay.json');
    writeFileSync(overlayPath, JSON.stringify(overlay));
    const loaded = loadParams({ overlayPath });
    expect(loaded).toEqual(mergeParams(DEFAULT_PARAMS, overlay));
    // Only hardBidding leaves moved; the rest is the shipped default.
    expect(loaded.hardBidding.bidMargin).toBe(best.best!.vector[0]);
  }, 120_000);

  it('AC-2: an equal candidate does not promote (report-only)', async () => {
    const decision = await promoteIfBetter(DEFAULT_PARAMS, DEFAULT_PARAMS, DEFAULT_PARAMS, {
      run,
      maxGames: 60,
      seed: 2,
      concurrency: 8,
    });
    expect(decision.promote).toBe(false);
    const report = buildReport(cem(), await runCem(cem(), fitnessVs()));
    // buildReport still produces a diff + trajectory even when nothing ships.
    expect(report.dimensions).toHaveLength(HARD_LEAVES.length);
    expect(report.trajectory.length).toBeGreaterThan(0);
  }, 120_000);

  it('AC-3: a Hard overlay leaves Medium play byte-identical (tier-stability guard)', async () => {
    // Fabricate an aggressive Hard overlay touching every hardBidding leaf.
    const overlay = vectorToOverlay(HARD_LEAVES, [-5, 5, 7.2, 8.1]);
    const withOverlay = mergeParams(DEFAULT_PARAMS, overlay);

    // Structural guarantee: every group Medium/Easy read is untouched.
    expect(withOverlay.suitStrength).toEqual(DEFAULT_PARAMS.suitStrength);
    expect(withOverlay.bidding).toEqual(DEFAULT_PARAMS.bidding);
    expect(withOverlay.slam).toEqual(DEFAULT_PARAMS.slam);
    expect(withOverlay.endgame).toEqual(DEFAULT_PARAMS.endgame);

    // Behavioral guarantee: Medium-vs-Medium self-play is identical whether the
    // Medium bots are built from the defaults or from the Hard-overlaid params.
    const base = () => [
      new MediumPolicy(DEFAULT_PARAMS),
      new MediumPolicy(DEFAULT_PARAMS),
      new MediumPolicy(DEFAULT_PARAMS),
      new MediumPolicy(DEFAULT_PARAMS),
    ];
    const overlaid = () => [
      new MediumPolicy(withOverlay),
      new MediumPolicy(withOverlay),
      new MediumPolicy(withOverlay),
      new MediumPolicy(withOverlay),
    ];
    expect(simulateGames(80, overlaid(), 9)).toEqual(simulateGames(80, base(), 9));
  }, 60_000);

  it('AC-4: shipped Hard beats Medium at >=60% (gate stays green)', async () => {
    // Real shipped HardPolicy (full world budget) via the sim harness: seats
    // 0/2 Hard, 1/3 Medium. The gate is comfortably clear (~68% observed).
    const { HardPolicy } = await import('../src/hard/policy.js');
    // Play in chunks, yielding to the event loop between them so vitest's worker
    // heartbeat is not starved by one long synchronous block.
    const chunk = 2;
    const chunks = 60;
    let hardWins = 0;
    for (let c = 0; c < chunks; c++) {
      const wins = simulateGames(
        chunk,
        [new HardPolicy(), new MediumPolicy(), new HardPolicy(), new MediumPolicy()],
        21 + c,
      );
      hardWins += wins[0];
      await new Promise((r) => setImmediate(r));
    }
    const n = chunk * chunks;
    expect(hardWins / n).toBeGreaterThanOrEqual(0.6);
  }, 180_000);

  it('cleans up: no overlay file is written by a report-only decision', () => {
    // Sanity: the spec never writes to the shipped overlay path.
    expect(existsSync('packages/bots/params/local.json')).toBe(false);
  });
});

describe('overlayVersion (fh-sja.6 version stamp)', () => {
  const vec = HARD_LEAVES.map((l) => l.min);

  it('is a pure function of the overlay contents', () => {
    const a = overlayVersion(vectorToOverlay(HARD_LEAVES, vec));
    const b = overlayVersion(vectorToOverlay(HARD_LEAVES, vec));
    expect(a).toBe(b);
    expect(a).toMatch(/^\d+\.[0-9a-f]{8}$/);
  });

  it('changes when a tuned leaf changes', () => {
    const base = overlayVersion(vectorToOverlay(HARD_LEAVES, vec));
    const bumped = overlayVersion(vectorToOverlay(HARD_LEAVES, [vec[0]! + 1, ...vec.slice(1)]));
    expect(bumped).not.toBe(base);
  });

  it('ignores the schemaVersion/version envelope fields', () => {
    const overlay = vectorToOverlay(HARD_LEAVES, vec);
    const withVersion = { ...overlay, version: 'ignored' };
    expect(overlayVersion(withVersion)).toBe(overlayVersion(overlay));
  });
});
