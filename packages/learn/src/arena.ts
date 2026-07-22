/**
 * Arena — an A-vs-B parameter match runner with an SPRT promotion gate
 * (fh-sja.3). Two BotParams configurations play a stream of seeded games; the
 * arena decides, as early as the evidence allows, whether A is measurably
 * stronger than B, and gates promotion behind both a win over the incumbent
 * and a no-regression check against a frozen reference anchor.
 *
 * Seat bias is real in 500 (the first bidder has an edge), so each seed is
 * played MIRRORED: game 1 seats A at {0,2} and B at {1,3}; game 2 swaps them.
 * A win by the same physical seats in both legs cancels the seat advantage,
 * leaving only the parameter difference. Both legs feed the SPRT from A's
 * perspective, so a genuinely stronger A accumulates evidence twice as fast as
 * an unmirrored run while the seat edge nets out.
 *
 * Dependency direction: @five-hundred/bots depends on @five-hundred/learn, not
 * the other way round (see strength.ts), so this module cannot import HardPolicy
 * to actually play a game. Instead the caller injects a {@link MatchRunner} that
 * maps the four seats' params + a seed to the winning side. The runner is where
 * the real Hard-bot game (and its worker pool) lives; the arena owns only the
 * mirroring, the bounded-concurrency scheduling, and the sequential SPRT fold.
 * The acceptance tests that need real Hard bots run in packages/bots/test; the
 * arena's own mechanics are covered here against a deterministic toy runner.
 *
 * Determinism (AC-1): the same seeds and the same runner always yield the same
 * verdict, regardless of the concurrency setting. Games run in fixed-size
 * batches; within a batch they may complete out of order, but their outcomes
 * are folded into the SPRT in strict seed-then-leg order, and the test stops at
 * the first batch that reaches a verdict. Concurrency changes wall-clock time,
 * never the result.
 */

import { makeRng } from '@five-hundred/engine';
import {
  DEFAULT_SPRT,
  type SprtConfig,
  type SprtResult,
  sprtInit,
  sprtObserve,
} from './sprt.js';

/** The two teams' seats. A owns the 0/2 partnership, B owns 1/3 (leg 1). */
export const SIDE_A_SEATS: readonly [number, number] = [0, 2];
export const SIDE_B_SEATS: readonly [number, number] = [1, 3];

/**
 * Play one game with the given per-seat params at `seed` and return the winning
 * SIDE index (0 = the 0/2 partnership, 1 = the 1/3 partnership), or `null` for a
 * draw (no side reached the target and points tied). May be async — the runner
 * is where a worker pool, if any, lives. Must be a pure function of its inputs
 * for the arena's determinism guarantee to hold.
 */
export type MatchRunner<P> = (
  seatParams: readonly [P, P, P, P],
  seed: number,
) => (0 | 1 | null) | Promise<0 | 1 | null>;

export interface MatchOptions<P> {
  /** Side A ("candidate") params. */
  readonly a: P;
  /** Side B ("incumbent") params. */
  readonly b: P;
  /** Plays one game and reports the winning side. */
  readonly run: MatchRunner<P>;
  /** Max number of SEEDS to draw before giving up undecided. */
  readonly maxGames: number;
  /** Base seed for the deterministic per-game seed stream. */
  readonly seed?: number;
  /** SPRT hypotheses / error rates; defaults to {@link DEFAULT_SPRT}. */
  readonly sprt?: SprtConfig;
  /**
   * Play each seed mirrored (A and B swap seats) to cancel seat bias. Default
   * true. Disable only for a runner that is already seat-symmetric.
   */
  readonly mirror?: boolean;
  /**
   * How many games to run concurrently per batch (the worker-pool width). The
   * verdict is independent of this — it only bounds in-flight games. Default 4.
   */
  readonly concurrency?: number;
}

export interface MatchResult extends SprtResult {
  /** True iff the test decided A is stronger (SPRT accepted H1). */
  readonly promote: boolean;
  /** Total games actually played (both mirror legs count). */
  readonly gamesPlayed: number;
  /** Seeds consumed before the test stopped. */
  readonly seedsPlayed: number;
  /**
   * Confidence in the reached verdict: 1 - alpha for an H1 (A-better) decision,
   * 1 - beta for an H0 (not-better) decision, or the fraction of the way the
   * log-likelihood ratio has travelled toward its nearer boundary while still
   * `continue` — a rough progress read for an inconclusive run.
   */
  readonly confidence: number;
}

/** Seat assignment for one leg: A on `aSeats`, B on the other two. */
function assignSeats<P>(a: P, b: P, aSeats: readonly [number, number]): [P, P, P, P] {
  const seats: P[] = [b, b, b, b];
  seats[aSeats[0]] = a;
  seats[aSeats[1]] = a;
  return seats as [P, P, P, P];
}

/**
 * One seeded, possibly-mirrored trial: the list of (seatParams, aSeats) legs to
 * play for a single seed. Each leg's outcome is interpreted from A's view by
 * checking whether the winning side is the one A sat in.
 */
interface Leg<P> {
  readonly seed: number;
  readonly seatParams: readonly [P, P, P, P];
  readonly aSeats: readonly [number, number];
}

function legsForSeed<P>(a: P, b: P, seed: number, mirror: boolean): Leg<P>[] {
  const legs: Leg<P>[] = [
    { seed, seatParams: assignSeats(a, b, SIDE_A_SEATS), aSeats: SIDE_A_SEATS },
  ];
  if (mirror) {
    legs.push({ seed, seatParams: assignSeats(a, b, SIDE_B_SEATS), aSeats: SIDE_B_SEATS });
  }
  return legs;
}

/** A finished side index mapped to A's win/loss/draw outcome for the SPRT. */
function outcomeForA(winningSide: 0 | 1 | null, aSeats: readonly [number, number]): boolean | null {
  if (winningSide === null) return null;
  const aWon = winningSide === 0 ? aSeats[0] === 0 : aSeats[0] === 1;
  return aWon;
}

function confidenceFor(result: SprtResult, cfg: SprtConfig): number {
  if (result.verdict === 'accept-h1') return 1 - cfg.alpha;
  if (result.verdict === 'accept-h0') return 1 - cfg.beta;
  // Undecided: how far the llr has travelled toward its nearer boundary.
  const upper = Math.log((1 - cfg.beta) / cfg.alpha);
  const lower = Math.log(cfg.beta / (1 - cfg.alpha));
  const span = result.llr >= 0 ? upper : lower;
  return span === 0 ? 0 : Math.min(1, Math.max(0, result.llr / span));
}

/**
 * Run an A-vs-B match to an SPRT verdict. Plays seeded (mirrored) games in
 * bounded-concurrency batches, folding outcomes into the SPRT in a fixed order
 * and stopping at the first batch that decides. Returns the running win-rate,
 * decisive game count, verdict, and whether A should be considered stronger.
 *
 * An inconclusive run (budget exhausted, verdict still `continue`) reports
 * `promote: false` — "not shown to be better" is not a promotion.
 */
export async function runMatch<P>(options: MatchOptions<P>): Promise<MatchResult> {
  const cfg = options.sprt ?? DEFAULT_SPRT;
  const mirror = options.mirror ?? true;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const legsPerSeed = mirror ? 2 : 1;

  const seedRng = makeRng(options.seed ?? 0);
  let state = sprtInit();
  let gamesPlayed = 0;
  let seedsPlayed = 0;
  let seedsDrawn = 0;

  // Batch seeds so at most `concurrency` games are in flight, but always fold
  // results in seed-then-leg order for a concurrency-independent verdict.
  const seedsPerBatch = Math.max(1, Math.ceil(concurrency / legsPerSeed));

  outer: while (seedsDrawn < options.maxGames && state.verdict === 'continue') {
    const batch: Leg<P>[] = [];
    const batchSeeds = Math.min(seedsPerBatch, options.maxGames - seedsDrawn);
    for (let i = 0; i < batchSeeds; i++) {
      const seed = seedRng.int(0x100000000);
      seedsDrawn += 1;
      batch.push(...legsForSeed(options.a, options.b, seed, mirror));
    }

    // Fire the whole batch concurrently, then fold in array (seed-then-leg)
    // order — completion order does not affect the fold.
    const winners = await Promise.all(
      batch.map((leg) => options.run(leg.seatParams, leg.seed)),
    );

    let seedOfLastFold = -1;
    for (let i = 0; i < batch.length; i++) {
      const leg = batch[i] as Leg<P>;
      gamesPlayed += 1;
      if (leg.seed !== seedOfLastFold) {
        seedsPlayed += 1;
        seedOfLastFold = leg.seed;
      }
      state = sprtObserve(state, outcomeForA(winners[i] as 0 | 1 | null, leg.aSeats), cfg);
      if (state.verdict !== 'continue') break outer;
    }
  }

  const decisiveGames = state.wins + state.losses;
  const result: SprtResult = {
    ...state,
    decisiveGames,
    winRate: decisiveGames > 0 ? state.wins / decisiveGames : 0.5,
  };
  return {
    ...result,
    promote: state.verdict === 'accept-h1',
    gamesPlayed,
    seedsPlayed,
    confidence: confidenceFor(result, cfg),
  };
}

export type PromotionDecision = {
  /** Promote iff A beats the incumbent AND does not regress vs the anchor. */
  readonly promote: boolean;
  /** Candidate-vs-incumbent match (must accept H1 to promote). */
  readonly vsIncumbent: MatchResult;
  /**
   * Anchor-vs-candidate match, run from the ANCHOR's perspective: if the anchor
   * is significantly better (accepts H1) the candidate has regressed and is
   * rejected. Absent when the incumbent gate already failed (short-circuit).
   */
  readonly vsAnchor: MatchResult | null;
};

export interface PromoteOptions<P> {
  readonly run: MatchRunner<P>;
  readonly maxGames: number;
  readonly seed?: number;
  readonly sprt?: SprtConfig;
  readonly mirror?: boolean;
  readonly concurrency?: number;
}

/**
 * Promotion gate: `candidate` replaces `incumbent` only if it is measurably
 * stronger than the incumbent AND has not regressed against the frozen
 * reference `anchor`. The anchor guards against a candidate that beats a
 * drifted incumbent while quietly losing ground to the known-good baseline —
 * the ratchet the tuner (fh-sja.4) leans on to only ever move forward.
 *
 * The incumbent gate is checked first and short-circuits: a candidate that is
 * not better than the incumbent is rejected without spending games on the
 * anchor comparison.
 */
export async function promoteIfBetter<P>(
  candidate: P,
  incumbent: P,
  anchor: P,
  options: PromoteOptions<P>,
): Promise<PromotionDecision> {
  const shared = {
    run: options.run,
    maxGames: options.maxGames,
    seed: options.seed,
    sprt: options.sprt,
    mirror: options.mirror,
    concurrency: options.concurrency,
  };
  const vsIncumbent = await runMatch<P>({ a: candidate, b: incumbent, ...shared });
  if (!vsIncumbent.promote) {
    return { promote: false, vsIncumbent, vsAnchor: null };
  }
  // Anchor's perspective: does the frozen baseline out-play the candidate?
  const vsAnchor = await runMatch<P>({ a: anchor, b: candidate, ...shared });
  const regressed = vsAnchor.verdict === 'accept-h1';
  return { promote: !regressed, vsIncumbent, vsAnchor };
}
