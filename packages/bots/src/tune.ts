/**
 * Self-play tuner (fh-sja.4): `pnpm learn:tune`. Wires the generic CEM
 * optimizer in @five-hundred/learn to the real Hard-vs-Hard arena and the
 * BotParams vector, so an unattended run searches strategy constants against
 * self-play fitness and, only if the winner clears the SPRT promotion gate,
 * writes a candidate overlay the existing loader consumes.
 *
 *   pnpm learn:tune                                  # tune Hard, default budget
 *   pnpm learn:tune -- --generations 20 --population 32 --eval-games 40
 *   pnpm learn:tune -- --game-budget 200000          # overnight, budget-capped
 *   pnpm learn:tune -- --state run.tuner-state.json  # resume a killed run
 *   pnpm learn:tune -- --tier medium --allow-medium  # Medium (NOT shipped)
 *
 * Fitness is the candidate's mirrored win-rate vs the incumbent over
 * `--eval-games` seeds (seat bias cancelled by replaying each seed swapped).
 * The whole run is a pure function of `--seed`; `--state` persists after every
 * generation so a killed run resumes bit-for-bit from where it stopped (AC-1).
 *
 * The final report prints the shipped-vs-tuned param diffs and the win-rate
 * trajectory vs BOTH the incumbent (the fitness signal) and the frozen anchor
 * (a per-generation probe). The overlay is written ONLY when the best candidate
 * beats the incumbent AND does not regress vs the anchor under a fresh SPRT
 * confirmation match — otherwise the run is report-only (AC-2).
 *
 * Tiers: Hard is the shipped target and writes params/local.json (git-ignored,
 * picked up by loadParams). Medium is tunable behind `--tier medium
 * --allow-medium` for experiments, but its overlay is written to a separate,
 * NON-auto-loaded path with a loud warning — the tier-stability guardrail keeps
 * a Medium tuning artifact off the shipped path (fh-sja epic non-goal).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { makeRng } from '@five-hundred/engine';
import {
  type CemOptions,
  type Dimension,
  type FitnessFn,
  type MatchRunner,
  type TunerState,
  buildReport,
  initialState,
  promoteIfBetter,
  runCem,
} from '@five-hundred/learn';
import {
  type BotParams,
  DEFAULT_PARAMS,
  PARAMS_SCHEMA_VERSION,
  type PartialBotParams,
  loadParams,
  mergeParams,
} from './params.js';
import { makeHardMatchRunner } from './arena-runner.js';

// ---------------------------------------------------------------------------
// Tunable parameter vectors (which BotParams leaves each tier searches)
// ---------------------------------------------------------------------------

/** One tunable BotParams leaf: its group/key location and its search bounds. */
export interface TunableLeaf {
  readonly group: keyof Omit<BotParams, 'schemaVersion'>;
  readonly key: string;
  readonly min: number;
  readonly max: number;
  /** Generation-0 sampling std around the shipped value. */
  readonly std: number;
}

/**
 * Hard's strategy knobs, restricted to the `hardBidding.*` group ON PURPOSE:
 * these leaves are read only by the Hard rollout bidder (hard/bidding.ts) and
 * by no other tier. Tuning them therefore CANNOT alter Easy or Medium play even
 * if the resulting overlay is loaded — the tier-stability guardrail that makes
 * AC-3 hold structurally rather than by convention. The shared thresholds
 * (`bidding.*`, `slam.*`, `suitStrength.*`) that Medium also consults are
 * deliberately excluded here; they belong to the Medium tier's own vector.
 * World counts (rolloutWorlds/keepWorlds/...) are compute budget, not strategy,
 * and are pinned by the runner, so they are excluded too.
 */
export const HARD_LEAVES: readonly TunableLeaf[] = [
  { group: 'hardBidding', key: 'bidMargin', min: -10, max: 40, std: 12 },
  { group: 'hardBidding', key: 'slamMargin', min: 0, max: 60, std: 15 },
  { group: 'hardBidding', key: 'nullaCandLowness', min: 7.0, max: 9.0, std: 0.6 },
  { group: 'hardBidding', key: 'dnullaCandLowness', min: 8.0, max: 9.2, std: 0.4 },
];

/** Medium's suit-strength weights plus its bid thresholds (experimental). */
export const MEDIUM_LEAVES: readonly TunableLeaf[] = [
  { group: 'suitStrength', key: 'joker', min: 0.5, max: 1.5, std: 0.2 },
  { group: 'suitStrength', key: 'bower', min: 0.4, max: 1.2, std: 0.2 },
  { group: 'suitStrength', key: 'trumpHonor', min: 0.2, max: 0.9, std: 0.15 },
  { group: 'suitStrength', key: 'trumpLow', min: 0.1, max: 0.7, std: 0.15 },
  { group: 'suitStrength', key: 'sideAce', min: 0.4, max: 1.0, std: 0.15 },
  { group: 'suitStrength', key: 'sideKing', min: 0.0, max: 0.6, std: 0.15 },
  { group: 'suitStrength', key: 'ntAce', min: 0.5, max: 1.1, std: 0.15 },
  { group: 'suitStrength', key: 'ntKing', min: 0.1, max: 0.8, std: 0.15 },
  { group: 'suitStrength', key: 'ntQueen', min: 0.0, max: 0.5, std: 0.15 },
  { group: 'bidding', key: 'headroom', min: 1, max: 7, std: 1.2 },
  { group: 'bidding', key: 'indicateEst', min: 2.5, max: 6.5, std: 1.0 },
  { group: 'slam', key: 'est', min: 6, max: 10, std: 1.0 },
];

/** Read a leaf's shipped value from a base BotParams. */
function leafValue(base: BotParams, leaf: TunableLeaf): number {
  return (base[leaf.group] as unknown as Record<string, number>)[leaf.key] as number;
}

/** Build the CEM dimensions for a tier, centered on the incumbent's values. */
export function dimensionsFor(leaves: readonly TunableLeaf[], base: BotParams): Dimension[] {
  return leaves.map((leaf) => ({
    name: `${leaf.group}.${leaf.key}`,
    min: leaf.min,
    max: leaf.max,
    initMean: leafValue(base, leaf),
    initStd: leaf.std,
  }));
}

/** Turn a search vector into a BotParams overlay (schema-stamped, mergeable). */
export function vectorToOverlay(leaves: readonly TunableLeaf[], vector: readonly number[]): PartialBotParams {
  const overlay: Record<string, Record<string, number>> = {};
  leaves.forEach((leaf, i) => {
    (overlay[leaf.group] ??= {})[leaf.key] = vector[i] as number;
  });
  return { schemaVersion: PARAMS_SCHEMA_VERSION, ...overlay } as PartialBotParams;
}

/**
 * A short, deterministic version tag for an overlay: `<schema>.<hash>` where
 * the hash is FNV-1a over the overlay's numeric leaves in stable key order.
 * Pure — identical params always stamp the same tag — so it doubles as a
 * content fingerprint the lobby shows as "learned v<tag>".
 */
export function overlayVersion(overlay: PartialBotParams): string {
  const groups = Object.keys(overlay)
    .filter((k) => k !== 'schemaVersion' && k !== 'version')
    .sort();
  const parts: string[] = [];
  for (const g of groups) {
    const leaves = overlay[g as keyof PartialBotParams] as Record<string, number> | undefined;
    if (leaves === undefined) continue;
    for (const key of Object.keys(leaves).sort()) parts.push(`${g}.${key}=${leaves[key]}`);
  }
  let h = 0x811c9dc5;
  const canonical = parts.join('|');
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${PARAMS_SCHEMA_VERSION}.${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/** Decode a vector into a full BotParams by merging its overlay over `base`. */
export function vectorToParams(
  leaves: readonly TunableLeaf[],
  vector: readonly number[],
  base: BotParams,
): BotParams {
  return mergeParams(base, vectorToOverlay(leaves, vector));
}

// ---------------------------------------------------------------------------
// Fixed-budget mirrored fitness (win-rate of A vs B over N seeds)
// ---------------------------------------------------------------------------

const A_SEATS: [number, number] = [0, 2];
const B_SEATS: [number, number] = [1, 3];

function seatParams(a: BotParams, b: BotParams, aSeats: [number, number]): [BotParams, BotParams, BotParams, BotParams] {
  const seats: BotParams[] = [b, b, b, b];
  seats[aSeats[0]] = a;
  seats[aSeats[1]] = a;
  return seats as [BotParams, BotParams, BotParams, BotParams];
}

/**
 * Play `seeds` mirrored games (A on 0/2 then A on 1/3) and return A's win-rate.
 * Unlike the SPRT arena this plays a FIXED count so scores are comparable
 * across candidates — the ordinal signal the CEM ranks on. Seat bias cancels
 * because every seed is replayed with the sides swapped.
 */
export async function mirroredWinRate(
  a: BotParams,
  b: BotParams,
  run: MatchRunner<BotParams>,
  seeds: number,
  matchSeed: number,
  concurrency: number,
): Promise<{ winRate: number; games: number }> {
  const seedRng = makeRng(matchSeed);
  const legs: { sp: [BotParams, BotParams, BotParams, BotParams]; aSeats: [number, number]; seed: number }[] = [];
  for (let i = 0; i < seeds; i++) {
    const seed = seedRng.int(0x100000000);
    legs.push({ sp: seatParams(a, b, A_SEATS), aSeats: A_SEATS, seed });
    legs.push({ sp: seatParams(a, b, B_SEATS), aSeats: B_SEATS, seed });
  }
  let wins = 0;
  let decisive = 0;
  const width = Math.max(1, concurrency);
  for (let start = 0; start < legs.length; start += width) {
    const batch = legs.slice(start, start + width);
    const winners = await Promise.all(batch.map((l) => run(l.sp, l.seed)));
    winners.forEach((w, i) => {
      if (w === null) return;
      const l = batch[i]!;
      const aWon = w === 0 ? l.aSeats[0] === 0 : l.aSeats[0] === 1;
      decisive += 1;
      if (aWon) wins += 1;
    });
  }
  return { winRate: decisive > 0 ? wins / decisive : 0.5, games: legs.length };
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function numFlag(args: string[], name: string, dflt: number): number {
  const i = args.lastIndexOf(name);
  if (i === -1) return dflt;
  const v = Number(args[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`${name} needs a number, got ${String(args[i + 1])}`);
  return v;
}

function strFlag(args: string[], name: string): string | undefined {
  const i = args.lastIndexOf(name);
  if (i === -1) return undefined;
  const raw = args[i + 1];
  if (raw === undefined || raw.startsWith('--')) throw new Error(`${name} needs a value`);
  return raw;
}

interface PersistedRun {
  readonly tuner: TunerState;
  readonly anchorTrajectory: { readonly generation: number; readonly winRate: number }[];
}

function loadRun(path: string): PersistedRun | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as PersistedRun;
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

/**
 * Run the tuner from a parsed argv (everything after `learn:tune --`). Kept
 * side-effect-free at import time — the thin `tune-cli.ts` entrypoint is what
 * invokes it — so tests can import the module's helpers without launching a run.
 */
export async function runTune(args: string[]): Promise<void> {
  const tier = strFlag(args, '--tier') ?? 'hard';
  if (tier !== 'hard' && tier !== 'medium') {
    throw new Error(`--tier must be hard|medium, got ${tier}`);
  }
  if (tier === 'medium' && !args.includes('--allow-medium')) {
    throw new Error(
      'Refusing to tune Medium without --allow-medium: Medium is a stability-' +
        'guarded tier and its overlay is NOT shipped (fh-sja epic non-goal).',
    );
  }

  const leaves = tier === 'hard' ? HARD_LEAVES : MEDIUM_LEAVES;

  // Incumbent = current effective params (defaults + any active overlay);
  // anchor = the frozen shipped defaults the ratchet never regresses against.
  const incumbent = args.includes('--from-defaults') ? DEFAULT_PARAMS : loadParams();
  const anchor = DEFAULT_PARAMS;

  const seed = numFlag(args, '--seed', 0);
  const generations = numFlag(args, '--generations', 12);
  const population = numFlag(args, '--population', 24);
  const eliteFrac = numFlag(args, '--elite-frac', 0.25);
  const evalGames = numFlag(args, '--eval-games', 24);
  const concurrency = numFlag(args, '--concurrency', 8);
  const evalConcurrency = numFlag(args, '--eval-concurrency', 1);
  const gameBudget = args.includes('--game-budget') ? numFlag(args, '--game-budget', 0) : null;
  const timeBudgetMs = args.includes('--time-budget-ms') ? numFlag(args, '--time-budget-ms', 0) : null;
  const bidWorlds = numFlag(args, '--bid-worlds', 6);
  const keepWorlds = numFlag(args, '--keep-worlds', 6);
  const playWorlds = numFlag(args, '--play-worlds', 3);
  const confirmGames = numFlag(args, '--confirm-games', 200);

  const outPath =
    strFlag(args, '--out') ??
    (tier === 'hard' ? 'packages/bots/params/local.json' : 'packages/bots/params/medium-tuned.json');
  const statePath = strFlag(args, '--state') ?? `${outPath}.tuner-state.json`;
  const fresh = args.includes('--fresh');

  const run = makeHardMatchRunner({ bidWorlds, keepWorlds, playWorlds });

  const cem: CemOptions = {
    dimensions: dimensionsFor(leaves, incumbent),
    populationSize: population,
    eliteFrac,
    generations,
    seed,
    evalConcurrency,
    gameBudget,
    timeBudgetMs,
  };

  const fitness: FitnessFn = async (vector, ctx) => {
    const cand = vectorToParams(leaves, vector, incumbent);
    const { winRate, games } = await mirroredWinRate(cand, incumbent, run, evalGames, ctx.seed, concurrency);
    return { score: winRate, games };
  };

  // Resume unless --fresh: the persisted state file replays bit-for-bit.
  const prior = fresh ? undefined : loadRun(statePath);
  let anchorTrajectory = prior?.anchorTrajectory ?? [];
  let state = prior?.tuner ?? initialState(cem);

  console.log(
    `[tune] tier=${tier} incumbent=${incumbent === DEFAULT_PARAMS ? 'defaults' : 'overlay'} ` +
      `dims=${leaves.length} pop=${population} gens=${generations} evalGames=${evalGames} ` +
      `seed=${seed}${prior ? ` (resuming at gen ${state.generation})` : ''}`,
  );

  const onGeneration = async (s: TunerState): Promise<void> => {
    // Per-generation anchor probe: the gen-best vs the frozen anchor, so the
    // report shows the trajectory vs BOTH incumbent (fitness) and anchor.
    const genRec = s.history[s.history.length - 1]!;
    const best = vectorToParams(leaves, genRec.bestVector, incumbent);
    const anchorSeed = (seed ^ 0x9e3779b9 ^ genRec.generation) >>> 0;
    const { winRate } = await mirroredWinRate(best, anchor, run, evalGames, anchorSeed, concurrency);
    anchorTrajectory = [
      ...anchorTrajectory.filter((t) => t.generation !== genRec.generation),
      { generation: genRec.generation, winRate },
    ];
    writeFileSync(statePath, JSON.stringify({ tuner: s, anchorTrajectory }, null, 2));
    console.log(
      `[tune] gen ${genRec.generation}: best vs incumbent ${pct(genRec.bestScore)} ` +
        `| vs anchor ${pct(winRate)} | elite mean ${pct(genRec.eliteMeanScore)} ` +
        `| games ${s.totalGames}`,
    );
  };

  state = await runCem(cem, fitness, { onGeneration }, state);

  // -------------------------------------------------------------------------
  // Report + SPRT-gated overlay write
  // -------------------------------------------------------------------------
  const report = buildReport(cem, state);
  console.log('\n=== Tuner report ===');
  console.log(`generations run: ${report.generationsRun}   total games: ${report.totalGames}`);
  console.log('\nparam diffs (shipped -> tuned):');
  for (const d of report.dimensions) {
    const arrow = d.delta === 0 ? '=' : d.delta > 0 ? '↑' : '↓';
    console.log(`  ${d.name.padEnd(26)} ${d.shipped.toFixed(3)} -> ${d.tuned.toFixed(3)}  ${arrow}${Math.abs(d.delta).toFixed(3)}`);
  }
  console.log('\nwin-rate trajectory (gen: vs incumbent | vs anchor):');
  for (const t of report.trajectory) {
    const anchorWr = anchorTrajectory.find((a) => a.generation === t.generation)?.winRate;
    console.log(`  gen ${String(t.generation).padStart(2)}: ${pct(t.bestScore)} | ${anchorWr === undefined ? '  n/a' : pct(anchorWr)}`);
  }

  if (report.best === null) {
    console.log('\nno candidate evaluated; nothing to promote.');
    return;
  }

  const candidate = vectorToParams(leaves, report.best.vector, incumbent);
  console.log(`\n[tune] running SPRT confirmation match (maxGames=${confirmGames})...`);
  const decision = await promoteIfBetter(candidate, incumbent, anchor, {
    run,
    maxGames: confirmGames,
    seed: (seed ^ 0x1234abcd) >>> 0,
    concurrency,
  });

  console.log(
    `\nconfirmation vs incumbent: winRate ${pct(decision.vsIncumbent.winRate)} ` +
      `verdict ${decision.vsIncumbent.verdict} (${decision.vsIncumbent.gamesPlayed} games)`,
  );
  if (decision.vsAnchor) {
    console.log(
      `confirmation anchor probe: anchor winRate ${pct(decision.vsAnchor.winRate)} ` +
        `verdict ${decision.vsAnchor.verdict} (regressed=${decision.vsAnchor.verdict === 'accept-h1'})`,
    );
  }

  if (decision.promote) {
    const overlay = vectorToOverlay(leaves, report.best.vector);
    // Stamp a deterministic version so the product can surface which learned
    // overlay a room is running (fh-sja.6 lobby tag). The hash is a pure
    // function of the tuned leaves, so identical params always stamp the same
    // version and a changed param always changes it.
    const stamped = { ...overlay, version: overlayVersion(overlay) };
    writeFileSync(outPath, JSON.stringify(stamped, null, 2));
    console.log(`\n✅ PROMOTED — wrote candidate overlay ${stamped.version} to ${outPath}`);
    if (tier === 'medium') {
      console.log(
        '⚠️  Medium overlay is EXPERIMENTAL and NOT auto-loaded/shipped ' +
          '(tier-stability guardrail). Ship via fh-sja.6 only after review.',
      );
    }
  } else {
    console.log('\n❌ NOT PROMOTED — candidate did not clear the SPRT gate; report-only, no overlay written.');
  }
}

