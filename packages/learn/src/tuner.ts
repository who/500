/**
 * Self-play tuner: a cross-entropy method (CEM) optimizer over a numeric
 * parameter vector, driven by a black-box fitness oracle (fh-sja.4). The
 * concrete oracle is the A-vs-B arena (fh-sja.3): each candidate vector is
 * decoded into BotParams, matched against the incumbent, and scored by its
 * mirrored win-rate. That wiring — and the BotParams encode/decode — lives in
 * @five-hundred/bots (tune-cli.ts), because the dependency runs bots -> learn:
 * this module knows only about numeric vectors and an injected {@link FitnessFn},
 * exactly as the arena knows only about an injected MatchRunner.
 *
 * Why CEM and not SPSA? Both are gradient-free, which the non-goal ("no
 * gradient frameworks") requires. SPSA estimates a descent direction from two
 * noisy loss evaluations per step; with the arena's Bernoulli win-rate as the
 * loss, that gradient is buried in match-to-match noise and needs careful
 * step-size / perturbation schedules to be stable. CEM instead ranks a whole
 * population by fitness and refits the sampling distribution to the elite
 * fraction — it only needs the *order* of candidates, not a differenced
 * magnitude, so it is far more tolerant of the arena's noisy, expensive,
 * ordinal signal. It is also embarrassingly parallel (a generation's
 * candidates evaluate independently) and has no learning-rate to hand-tune,
 * which matters for an unattended overnight run.
 *
 * Determinism & resumability (AC-1): the run is a pure function of the base
 * seed. Each generation's sampling RNG is seeded from (baseSeed, generation),
 * and each candidate's fitness seed from (baseSeed, generation, index), so a
 * generation reproduces bit-for-bit regardless of evaluation order or
 * concurrency. Because nothing depends on wall-clock or a serialized PRNG
 * cursor, resuming from a persisted {@link TunerState} at generation k and
 * running to N is identical to a fresh 0..N run — the CLI just re-enters the
 * loop where it left off.
 */

import { makeRng, type Rng } from '@five-hundred/engine';

/** Bumped when the persisted {@link TunerState} shape changes incompatibly. */
export const TUNER_STATE_VERSION = 1;

/** One tunable scalar: its label, hard bounds, and initial search Gaussian. */
export interface Dimension {
  /** Human-readable label (e.g. a dotted BotParams path). */
  readonly name: string;
  /** Inclusive lower clamp; samples never go below this. */
  readonly min: number;
  /** Inclusive upper clamp; samples never go above this. */
  readonly max: number;
  /** Center of the generation-0 sampling Gaussian (usually the shipped value). */
  readonly initMean: number;
  /** Std of the generation-0 sampling Gaussian. */
  readonly initStd: number;
}

/** Context handed to the fitness oracle so it can seed deterministically. */
export interface FitnessContext {
  /** Zero-based generation index. */
  readonly generation: number;
  /** Candidate index within the generation. */
  readonly index: number;
  /** Deterministic seed derived from (baseSeed, generation, index). */
  readonly seed: number;
}

/** What the oracle returns: a higher-is-better score and games it consumed. */
export interface FitnessResult {
  /** Fitness; the CEM ranks candidates by this (higher = better). */
  readonly score: number;
  /** Games played to produce the score, for the game-budget accounting. */
  readonly games: number;
}

/** Evaluate one candidate vector. May be async (the arena runs games). */
export type FitnessFn = (
  vector: readonly number[],
  ctx: FitnessContext,
) => FitnessResult | Promise<FitnessResult>;

export interface CemOptions {
  /** The parameter vector's dimensions, in a fixed order. */
  readonly dimensions: readonly Dimension[];
  /** Candidates sampled per generation. */
  readonly populationSize: number;
  /** Fraction (0,1] of the population kept as elites for the refit. */
  readonly eliteFrac: number;
  /** Hard cap on generations for this run (the budget). */
  readonly generations: number;
  /** Base seed; the whole run is a pure function of this. */
  readonly seed: number;
  /**
   * Mean/std update smoothing in [0,1]: new = s*elite + (1-s)*old. Lower moves
   * the distribution more cautiously (less overfit to one noisy generation).
   * Default 0.7.
   */
  readonly smoothing?: number;
  /**
   * Std floor as a fraction of each dimension's (max-min), so the search never
   * collapses to a point and can still escape a noisy local optimum. Default
   * 0.03.
   */
  readonly minStdFrac?: number;
  /** How many candidates to evaluate concurrently. Default 1 (sequential). */
  readonly evalConcurrency?: number;
  /**
   * Optional total-games budget: after a generation whose cumulative games meet
   * or exceed this, the loop stops (in addition to the generation cap). Null =
   * unbounded. The stop is checked between generations so a generation is never
   * left half-scored.
   */
  readonly gameBudget?: number | null;
  /**
   * Optional wall-clock budget in ms, checked between generations against
   * {@link RunHooks.now}. Null = unbounded.
   */
  readonly timeBudgetMs?: number | null;
}

/** A scored candidate. */
export interface Candidate {
  readonly vector: number[];
  readonly score: number;
  readonly games: number;
}

/** A per-generation summary, the backbone of the win-rate trajectory report. */
export interface GenerationRecord {
  readonly generation: number;
  /** Sampling mean AFTER this generation's refit. */
  readonly mean: number[];
  /** Sampling std AFTER this generation's refit. */
  readonly std: number[];
  /** Best candidate score seen this generation. */
  readonly bestScore: number;
  /** Mean score over this generation's elites. */
  readonly eliteMeanScore: number;
  /** Best candidate vector this generation. */
  readonly bestVector: number[];
  /** Games consumed this generation. */
  readonly games: number;
}

/** The full, JSON-serializable, resumable optimizer state. */
export interface TunerState {
  readonly version: number;
  /** Guards a resume against a config that no longer matches. */
  readonly configHash: string;
  /** Completed generations; the next generation to run is this index. */
  readonly generation: number;
  /** Current sampling mean (one per dimension). */
  readonly mean: number[];
  /** Current sampling std (one per dimension). */
  readonly std: number[];
  /** Best candidate over the whole run so far, or null before generation 0. */
  readonly best: Candidate | null;
  /** Cumulative games consumed. */
  readonly totalGames: number;
  /** One record per completed generation. */
  readonly history: GenerationRecord[];
}

export interface RunHooks {
  /** Called after each generation with the new state — persist it here. */
  readonly onGeneration?: (state: TunerState) => void | Promise<void>;
  /** Wall-clock source for the time budget; defaults to a monotone counter-free stub. */
  readonly now?: () => number;
}

/** A deterministic 32-bit mix of the given integers (FNV-1a style). */
export function mixSeed(...values: readonly number[]): number {
  let h = 0x811c9dc5;
  for (const v of values) {
    h ^= v >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A stable, order-sensitive hash of the CEM options that affect the run. */
export function hashConfig(opts: CemOptions): string {
  const parts: number[] = [
    opts.populationSize,
    Math.round(opts.eliteFrac * 1e6),
    opts.seed,
    Math.round((opts.smoothing ?? 0.7) * 1e6),
    Math.round((opts.minStdFrac ?? 0.03) * 1e6),
  ];
  for (const d of opts.dimensions) {
    for (const s of d.name) parts.push(s.charCodeAt(0));
    parts.push(
      Math.round(d.min * 1e3),
      Math.round(d.max * 1e3),
      Math.round(d.initMean * 1e3),
      Math.round(d.initStd * 1e3),
    );
  }
  return mixSeed(...parts).toString(16);
}

/** Box-Muller (polar) standard-normal sampler over an injected uniform Rng. */
function gaussianSampler(rng: Rng): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rng.random() * 2 - 1;
      v = rng.random() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Run `fn` over `items` with at most `width` in flight; results keep order. */
async function mapPool<T, R>(
  items: readonly T[],
  width: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const w = Math.max(1, Math.min(width, items.length));
  for (let k = 0; k < w; k++) {
    workers.push(
      (async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          out[i] = await fn(items[i] as T, i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

/** The fresh state before generation 0: mean/std from the dimensions. */
export function initialState(opts: CemOptions): TunerState {
  return {
    version: TUNER_STATE_VERSION,
    configHash: hashConfig(opts),
    generation: 0,
    mean: opts.dimensions.map((d) => d.initMean),
    std: opts.dimensions.map((d) => d.initStd),
    best: null,
    totalGames: 0,
    history: [],
  };
}

/**
 * Sample and score ONE generation from `state`, returning the refit successor
 * state. Pure given (opts, fitness, state) — the sampling and fitness seeds are
 * derived from (opts.seed, state.generation, index), so the result is identical
 * regardless of `evalConcurrency` or evaluation order.
 */
export async function stepGeneration(
  state: TunerState,
  opts: CemOptions,
  fitness: FitnessFn,
): Promise<TunerState> {
  const dims = opts.dimensions;
  const gen = state.generation;
  const sampleRng = makeRng(mixSeed(opts.seed, gen, 0x5a3d));
  const gauss = gaussianSampler(sampleRng);

  // Sample the population. The current mean is always evaluated as candidate 0
  // (an "incumbent probe") so a generation can never score worse than staying
  // put — the best-so-far ratchet then never regresses on noise alone.
  const vectors: number[][] = [];
  for (let i = 0; i < opts.populationSize; i++) {
    if (i === 0) {
      vectors.push(dims.map((d, k) => clamp(state.mean[k] as number, d.min, d.max)));
      continue;
    }
    vectors.push(
      dims.map((d, k) => clamp((state.mean[k] as number) + gauss() * (state.std[k] as number), d.min, d.max)),
    );
  }

  const results = await mapPool(vectors, opts.evalConcurrency ?? 1, (vector, index) =>
    Promise.resolve(
      fitness(vector, { generation: gen, index, seed: mixSeed(opts.seed, gen, index) }),
    ),
  );

  const scored: Candidate[] = vectors.map((vector, i) => ({
    vector,
    score: (results[i] as FitnessResult).score,
    games: (results[i] as FitnessResult).games,
  }));
  const gamesThisGen = scored.reduce((a, c) => a + c.games, 0);

  // Rank by score desc; ties broken by index for a stable, deterministic order.
  const order = scored
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.score - a.c.score) || (a.i - b.i));
  const eliteCount = Math.max(2, Math.min(scored.length, Math.round(scored.length * opts.eliteFrac)));
  const elites = order.slice(0, eliteCount).map((o) => o.c);

  // Refit: elite mean/std per dimension, smoothed toward the old distribution
  // and floored so the search never collapses to a point.
  const s = opts.smoothing ?? 0.7;
  const minStdFrac = opts.minStdFrac ?? 0.03;
  const newMean: number[] = [];
  const newStd: number[] = [];
  for (let k = 0; k < dims.length; k++) {
    let sum = 0;
    for (const e of elites) sum += e.vector[k] as number;
    const em = sum / elites.length;
    let varSum = 0;
    for (const e of elites) {
      const dx = (e.vector[k] as number) - em;
      varSum += dx * dx;
    }
    const eStd = Math.sqrt(varSum / elites.length);
    const d = dims[k] as Dimension;
    newMean.push(clamp(s * em + (1 - s) * (state.mean[k] as number), d.min, d.max));
    const floor = minStdFrac * (d.max - d.min);
    newStd.push(Math.max(floor, s * eStd + (1 - s) * (state.std[k] as number)));
  }

  const genBest = order[0]?.c as Candidate;
  const eliteMeanScore = elites.reduce((a, c) => a + c.score, 0) / elites.length;
  const best =
    state.best === null || genBest.score > state.best.score ? genBest : state.best;

  const record: GenerationRecord = {
    generation: gen,
    mean: newMean,
    std: newStd,
    bestScore: genBest.score,
    eliteMeanScore,
    bestVector: genBest.vector,
    games: gamesThisGen,
  };

  return {
    version: TUNER_STATE_VERSION,
    configHash: state.configHash,
    generation: gen + 1,
    mean: newMean,
    std: newStd,
    best,
    totalGames: state.totalGames + gamesThisGen,
    history: [...state.history, record],
  };
}

/**
 * Drive the CEM loop from `initial` (or a fresh state) to the generation cap or
 * a budget stop. `hooks.onGeneration` fires after each refit with the new
 * state — persist it there for resumability. Returns the final state.
 *
 * A resumed run MUST pass the same `opts`; `initial.configHash` is checked
 * against the options and a mismatch throws rather than silently mixing two
 * search configurations into one state file.
 */
export async function runCem(
  opts: CemOptions,
  fitness: FitnessFn,
  hooks: RunHooks = {},
  initial?: TunerState,
): Promise<TunerState> {
  const expectedHash = hashConfig(opts);
  let state = initial ?? initialState(opts);
  if (state.configHash !== expectedHash) {
    throw new Error(
      `tuner resume config mismatch: state ${state.configHash} != options ${expectedHash}`,
    );
  }
  const now = hooks.now ?? (() => 0);
  const start = now();
  while (state.generation < opts.generations) {
    state = await stepGeneration(state, opts, fitness);
    if (hooks.onGeneration) await hooks.onGeneration(state);
    if (opts.gameBudget != null && state.totalGames >= opts.gameBudget) break;
    if (opts.timeBudgetMs != null && now() - start >= opts.timeBudgetMs) break;
  }
  return state;
}

/** A per-dimension shipped-vs-tuned diff, for the final report. */
export interface DimensionReport {
  readonly name: string;
  readonly shipped: number;
  readonly tuned: number;
  readonly delta: number;
}

export interface TunerReport {
  readonly dimensions: DimensionReport[];
  readonly trajectory: {
    readonly generation: number;
    readonly bestScore: number;
    readonly eliteMeanScore: number;
  }[];
  readonly best: Candidate | null;
  readonly generationsRun: number;
  readonly totalGames: number;
}

/** Summarize a finished (or resumed) run into a reportable diff + trajectory. */
export function buildReport(opts: CemOptions, state: TunerState): TunerReport {
  const best = state.best;
  const dimensions: DimensionReport[] = opts.dimensions.map((d, k) => {
    const tuned = best ? (best.vector[k] as number) : d.initMean;
    return { name: d.name, shipped: d.initMean, tuned, delta: tuned - d.initMean };
  });
  return {
    dimensions,
    trajectory: state.history.map((h) => ({
      generation: h.generation,
      bestScore: h.bestScore,
      eliteMeanScore: h.eliteMeanScore,
    })),
    best,
    generationsRun: state.generation,
    totalGames: state.totalGames,
  };
}
