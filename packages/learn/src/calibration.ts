/**
 * Calibration from a logged corpus (fh-sja.5). Two learned artifacts, both fit
 * with plain counting-and-shrinkage — no ML dependency, no matrix library:
 *
 *  1. A **make-probability model**: P(make | strength estimate, contract
 *     strain, contract level, seat position) for numbered contracts, as binned
 *     counts shrunk toward coarser marginals. It replaces the hand-tuned bid
 *     thresholds with a calibrated expected value — {@link deriveParamsOverlay}
 *     turns it into a BotParams overlay the existing loader consumes.
 *
 *  2. **Behavior priors**: the distribution of a seat's hand strength
 *     conditional on the call it made (pass / indication / numbered bid),
 *     fitted separately per policy kind (human vs each bot tier). Hard's world
 *     sampler conditions its hidden-hand draws on these (extends the fh-zpg
 *     rule-based conditioning to a learned one) via {@link priorLogDensity}.
 *
 * Everything is graceful under thin data: a cell below {@link minSamples}
 * returns null and the caller keeps its current (hand-tuned) behavior, so a
 * sparse or empty corpus can never make the bots worse than the defaults. The
 * artifact is a versioned plain-JSON object; {@link validateCalibration} is the
 * loud-fallback gate mirroring the BotParams overlay loader.
 */

import type { Card } from '@five-hundred/engine';
import { IND, NUM, PASS } from '@five-hundred/engine';
import type { GameRecord, PolicyKind } from './schema.js';
import {
  DEFAULT_STRENGTH_WEIGHTS,
  STRENGTH_BUCKET_WIDTH,
  type StrengthWeights,
  bestStrength,
  strengthBucket,
  suitStrength,
} from './strength.js';

/** Bumped when the artifact shape changes incompatibly. */
export const CALIBRATION_SCHEMA_VERSION = 1;

/** Default minimum observations before a fitted cell is trusted over fallback. */
export const DEFAULT_MIN_SAMPLES = 30;

/** Beta pseudo-count: how hard a fitted cell is pulled toward its fallback. */
export const DEFAULT_SHRINKAGE = 20;

/** A binned Bernoulli tally: `made` successes out of `n` trials. */
export interface MakeCell {
  readonly n: number;
  readonly made: number;
}

/**
 * The make model as a flat map from an aggregation key to its tally. Keys are
 * built by {@link makeKey} at every specificity from `strain|level|bucket|seat`
 * down to the global `*`, so a lookup can fall back coarser when a fine cell is
 * thin. `''` (the empty key) is the global tally.
 */
export interface MakeModel {
  readonly cells: Readonly<Record<string, MakeCell>>;
}

/** A strength histogram: total count, per-bucket counts, and moments. */
export interface PriorHistogram {
  readonly n: number;
  /** strengthBucket index -> count. Sparse. */
  readonly buckets: Readonly<Record<number, number>>;
  /** Sum of raw strengths, for the mean. */
  readonly sum: number;
  /** Sum of squared strengths, for the variance. */
  readonly sumSq: number;
}

/** Behavior priors keyed by `${policyKind}|${callClass}`. */
export interface BehaviorPriors {
  readonly histograms: Readonly<Record<string, PriorHistogram>>;
  /** Bucket width the histograms were built with (for consumer alignment). */
  readonly bucketWidth: number;
}

/** The versioned calibration artifact — plain JSON, overlay-loadable. */
export interface CalibrationArtifact {
  readonly v: number;
  /** The strength weights the fitter bucketed under; consumers must match. */
  readonly weights: StrengthWeights;
  readonly minSamples: number;
  readonly shrinkage: number;
  readonly make: MakeModel;
  readonly priors: BehaviorPriors;
  /** Provenance: games/hands the fit rests on and the corpus policy mix. */
  readonly meta: {
    readonly games: number;
    readonly hands: number;
    readonly makeSamples: number;
    readonly priorSamples: number;
  };
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

export interface FitOptions {
  readonly weights?: StrengthWeights;
  readonly minSamples?: number;
  readonly shrinkage?: number;
  readonly bucketWidth?: number;
}

/** The four make-model specificities, most specific first (see MakeModel). */
export function makeKey(
  strain: number,
  level: number,
  bucket: number,
  seatPos: number,
): string {
  return `${strain}|${level}|${bucket}|${seatPos}`;
}
function makeKeysFor(strain: number, level: number, bucket: number, seatPos: number): string[] {
  return [
    makeKey(strain, level, bucket, seatPos),
    `${strain}|${level}|${bucket}|*`,
    `${strain}|${level}|*|*`,
    `${strain}|*|*|*`,
    '', // global
  ];
}

/** Call class for the behavior priors: pass / ind:<strain> / bid:<strain>. */
export function callClass(kind: string, strain: number): string | null {
  if (kind === PASS) return 'pass';
  if (kind === IND) return `ind:${strain}`;
  if (kind === NUM) return `bid:${strain}`;
  return null; // nulla / dnulla: not conditioned on (misere strength is lowness)
}

/**
 * Fit both artifacts from a corpus. Pure: no clock, no I/O. Each hand yields
 * one make sample (if it has a numbered contract with a known declarer) and up
 * to four prior samples (one per non-nulla auction call).
 */
export function fitCalibration(
  records: readonly GameRecord[],
  options: FitOptions = {},
): CalibrationArtifact {
  const weights = options.weights ?? DEFAULT_STRENGTH_WEIGHTS;
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  const shrinkage = options.shrinkage ?? DEFAULT_SHRINKAGE;
  const bucketWidth = options.bucketWidth ?? STRENGTH_BUCKET_WIDTH;

  const cells: Record<string, { n: number; made: number }> = {};
  const bump = (key: string, made: boolean): void => {
    const c = cells[key] ?? { n: 0, made: 0 };
    c.n += 1;
    if (made) c.made += 1;
    cells[key] = c;
  };

  const hists: Record<string, { n: number; buckets: Record<number, number>; sum: number; sumSq: number }> = {};
  const observe = (cls: string, strength: number): void => {
    const h = hists[cls] ?? { n: 0, buckets: {}, sum: 0, sumSq: 0 };
    h.n += 1;
    h.sum += strength;
    h.sumSq += strength * strength;
    const b = strengthBucket(strength, bucketWidth);
    h.buckets[b] = (h.buckets[b] ?? 0) + 1;
    hists[cls] = h;
  };

  let hands = 0;
  let makeSamples = 0;
  let priorSamples = 0;

  for (const game of records) {
    const kinds: PolicyKind[] = [];
    for (const p of game.players) kinds[p.seat] = p.kind;
    for (const hand of game.hands) {
      hands += 1;
      const deal = hand.deal.hands;

      // Make sample: numbered contract with a known declarer.
      const contract = hand.result.contract;
      const declarer = hand.result.declarer;
      if (contract.kind === NUM && Number.isInteger(declarer) && deal[declarer] !== undefined) {
        const strain = contract.strain;
        const level = contract.level;
        const strength = suitStrength(deal[declarer] as readonly Card[], strain, weights);
        const bucket = strengthBucket(strength, bucketWidth);
        const seatPos = (declarer - hand.firstBidder + 4) % 4;
        for (const key of makeKeysFor(strain, level, bucket, seatPos)) bump(key, hand.result.made);
        makeSamples += 1;
      }

      // Behavior priors: one sample per non-nulla call.
      for (const call of hand.auction.calls) {
        const seat = call.seat;
        const kind = kinds[seat];
        const cards = deal[seat];
        if (kind === undefined || cards === undefined) continue;
        const cls = callClass(call.bid.kind, call.bid.strain);
        if (cls === null) continue;
        let strength: number;
        if (call.bid.kind === PASS) strength = bestStrength(cards, weights);
        else strength = suitStrength(cards, call.bid.strain, weights);
        observe(`${kind}|${cls}`, strength);
        priorSamples += 1;
      }
    }
  }

  return {
    v: CALIBRATION_SCHEMA_VERSION,
    weights,
    minSamples,
    shrinkage,
    make: { cells },
    priors: {
      histograms: hists,
      bucketWidth,
    },
    meta: { games: records.length, hands, makeSamples, priorSamples },
  };
}

// ---------------------------------------------------------------------------
// Make-probability lookup
// ---------------------------------------------------------------------------

/** Beta-shrunk estimate of a cell toward a fallback rate with pseudo-count k. */
function shrink(cell: MakeCell, fallbackRate: number, k: number): number {
  return (cell.made + k * fallbackRate) / (cell.n + k);
}

export interface MakeFeatures {
  readonly strain: number;
  readonly level: number;
  readonly strength: number;
  readonly seatPos: number;
  readonly bucketWidth?: number;
}

/**
 * Calibrated P(make) for a numbered contract, or null when even the global
 * tally is below minSamples (an empty/thin corpus — the caller keeps its
 * hand-tuned behavior, AC-3). Walks from the most specific cell to the
 * coarsest, using the finest cell that clears minSamples and shrinking it
 * toward the global make-rate so a cell sitting exactly at the threshold is
 * not trusted blindly.
 */
export function makeProbability(
  artifact: CalibrationArtifact,
  features: MakeFeatures,
): number | null {
  const cells = artifact.make.cells;
  const global = cells[''];
  if (global === undefined || global.n < artifact.minSamples) return null;
  const globalRate = global.made / global.n;
  const bucket = strengthBucket(features.strength, features.bucketWidth ?? artifact.priors.bucketWidth);
  for (const key of makeKeysFor(features.strain, features.level, bucket, features.seatPos)) {
    const cell = cells[key];
    if (cell !== undefined && cell.n >= artifact.minSamples) {
      return shrink(cell, globalRate, artifact.shrinkage);
    }
  }
  return globalRate;
}

/** The raw (unshrunk) make-rate of a cell, or null if absent. For validation. */
export function rawMakeRate(
  artifact: CalibrationArtifact,
  strain: number,
  level: number,
  bucket: number,
  seatPos: number,
): number | null {
  const cell = artifact.make.cells[makeKey(strain, level, bucket, seatPos)];
  return cell === undefined ? null : cell.made / cell.n;
}

// ---------------------------------------------------------------------------
// Behavior-prior lookup (world-sampler conditioning)
// ---------------------------------------------------------------------------

export interface PriorSummary {
  readonly n: number;
  readonly mean: number;
  readonly std: number;
  readonly histogram: PriorHistogram;
  readonly bucketWidth: number;
}

/**
 * The prior for a seat's strength given the call it made under `policyKind`,
 * or null when the (policy, call) class has fewer than minSamples observations
 * — the sampler then draws uniformly, exactly as before this artifact existed.
 */
export function priorFor(
  artifact: CalibrationArtifact,
  policyKind: PolicyKind,
  callKind: string,
  strain: number,
): PriorSummary | null {
  const cls = callClass(callKind, strain);
  if (cls === null) return null;
  const h = artifact.priors.histograms[`${policyKind}|${cls}`];
  if (h === undefined || h.n < artifact.minSamples) return null;
  const mean = h.sum / h.n;
  const variance = Math.max(0, h.sumSq / h.n - mean * mean);
  return {
    n: h.n,
    mean,
    std: Math.sqrt(variance),
    histogram: h,
    bucketWidth: artifact.priors.bucketWidth,
  };
}

/**
 * Laplace-smoothed log-density of a strength value under a prior histogram.
 * Used by the world sampler to weight a candidate hidden hand: a sampled hand
 * whose strength is typical for the observed call scores higher than an
 * atypical one, so keeping the best of several draws biases the sampled world
 * toward the learned behavior. Smoothing (+1 per bucket over the observed
 * range) keeps a never-seen bucket from vetoing an otherwise plausible world.
 */
export function priorLogDensity(prior: PriorSummary, strength: number): number {
  const b = strengthBucket(strength, prior.bucketWidth);
  const observedBuckets = Object.keys(prior.histogram.buckets).length;
  const span = Math.max(1, observedBuckets);
  const count = prior.histogram.buckets[b] ?? 0;
  // +1 smoothing over the observed support plus this bucket if it is new.
  const smoothedDenom = prior.n + span + (prior.histogram.buckets[b] === undefined ? 1 : 0);
  return Math.log((count + 1) / smoothedDenom);
}

// ---------------------------------------------------------------------------
// BotParams overlay derivation
// ---------------------------------------------------------------------------

/**
 * A recursively-partial BotParams overlay: the same shape the bots' overlay
 * loader deep-merges. Kept structural (no import of the bots type) so learn
 * stays free of a back-dependency on bots.
 */
export type ParamsOverlay = {
  readonly schemaVersion?: number;
  readonly bidding?: { readonly headroom?: number };
  readonly slam?: { readonly est?: number };
};

export interface OverlayOptions {
  /** BotParams schema version to stamp on the overlay. */
  readonly schemaVersion: number;
  /** Current headroom to nudge from. */
  readonly baseHeadroom: number;
  /**
   * Target make-rate the calibrated bidding aims for. A bot that makes far
   * more than this is bidding too safely (leaving points on the table); far
   * less is over-reaching. Default 0.5.
   */
  readonly targetMakeRate?: number;
  /** Max absolute headroom nudge, so a noisy corpus cannot swing play wildly. */
  readonly maxNudge?: number;
}

/**
 * Turn the calibrated make-rate into a BotParams overlay that nudges bidding
 * headroom toward the target make-rate — the "calibrated expected values
 * replace hand-tuned thresholds" of the objective. Returns an empty overlay
 * (identity after merge) when the corpus is too thin to trust, so calibration
 * never regresses the defaults on sparse data (AC-3). The nudge is bounded by
 * `maxNudge` so even a well-populated but skewed corpus moves play gently.
 */
export function deriveParamsOverlay(
  artifact: CalibrationArtifact,
  options: OverlayOptions,
): ParamsOverlay {
  const global = artifact.make.cells[''];
  if (global === undefined || global.n < artifact.minSamples) {
    return { schemaVersion: options.schemaVersion };
  }
  const target = options.targetMakeRate ?? 0.5;
  const maxNudge = options.maxNudge ?? 1.0;
  const rate = global.made / global.n;
  // Over-safe (rate > target) -> bid higher -> more headroom; over-reaching ->
  // less. Scale by the gap and clamp. One headroom point ~ one contract level.
  const nudge = clamp((rate - target) * 2, -maxNudge, maxNudge);
  const headroom = options.baseHeadroom + nudge;
  return {
    schemaVersion: options.schemaVersion,
    bidding: { headroom },
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// ---------------------------------------------------------------------------
// Validation / serialization (loud-fallback overlay loader)
// ---------------------------------------------------------------------------

export type CalibrationValidation =
  | { readonly ok: true; readonly artifact: CalibrationArtifact }
  | { readonly ok: false; readonly error: string };

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Structurally validate a parsed artifact and reject a version this build does
 * not understand — the loud-fallback gate a consumer uses before trusting a
 * loaded overlay, mirroring BotParams.validateParams.
 */
export function validateCalibration(candidate: unknown): CalibrationValidation {
  if (candidate === null || typeof candidate !== 'object') {
    return { ok: false, error: 'calibration must be an object' };
  }
  const c = candidate as Record<string, unknown>;
  if (c.v !== CALIBRATION_SCHEMA_VERSION) {
    return { ok: false, error: `v ${String(c.v)} != expected ${CALIBRATION_SCHEMA_VERSION}` };
  }
  if (!isFiniteNumber(c.minSamples) || !isFiniteNumber(c.shrinkage)) {
    return { ok: false, error: 'minSamples/shrinkage must be finite numbers' };
  }
  const weights = c.weights as Record<string, unknown> | undefined;
  if (weights === undefined || typeof weights !== 'object') {
    return { ok: false, error: 'missing weights' };
  }
  for (const k of ['joker', 'bower', 'trumpHonor', 'trumpLow', 'sideAce', 'sideKing', 'ntAce', 'ntKing', 'ntQueen']) {
    if (!isFiniteNumber(weights[k])) return { ok: false, error: `weights.${k} not finite` };
  }
  const make = c.make as Record<string, unknown> | undefined;
  if (make === undefined || typeof make.cells !== 'object' || make.cells === null) {
    return { ok: false, error: 'missing make.cells' };
  }
  const priors = c.priors as Record<string, unknown> | undefined;
  if (
    priors === undefined ||
    typeof priors.histograms !== 'object' ||
    priors.histograms === null ||
    !isFiniteNumber(priors.bucketWidth)
  ) {
    return { ok: false, error: 'missing/invalid priors' };
  }
  return { ok: true, artifact: candidate as CalibrationArtifact };
}

/** One-line JSON, like the game-log writer. */
export function serializeCalibration(artifact: CalibrationArtifact): string {
  return JSON.stringify(artifact);
}

/** Parse + validate; throws on a bad artifact so a caller can fall back loudly. */
export function parseCalibration(text: string): CalibrationArtifact {
  const result = validateCalibration(JSON.parse(text));
  if (!result.ok) throw new Error(`invalid calibration artifact: ${result.error}`);
  return result.artifact;
}
