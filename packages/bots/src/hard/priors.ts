/**
 * Learned-prior conditioning for the Hard world sampler (fh-sja.5). The fh-zpg
 * conditioning kept, of a few draws, the first partner hand whose suitStrength
 * met a hand-tuned promise; this generalises that from one hard rule to a
 * calibrated distribution. Given the auction calls the hidden seats actually
 * made — and a {@link CalibrationArtifact} fitted per policy kind (human vs
 * each bot tier, fh-sja.5) — it keeps, of several uniform draws, the world
 * whose hidden hands are jointly most typical of those calls under the priors.
 *
 * It degrades to the plain uniform sampler exactly when the priors are thin:
 * an observation whose (policy, call) class has too few samples contributes
 * nothing, and if no observation has a usable prior the function samples once
 * and returns — no wasted draws, no behavior change from the pre-artifact bot
 * (the graceful-fallback guarantee, fh-sja.5 AC-3).
 */

import type { Card, Rng } from '@five-hundred/engine';
import { PASS } from '@five-hundred/engine';
import {
  type CalibrationArtifact,
  type PolicyKind,
  type PriorSummary,
  bestStrength,
  priorFor,
  priorLogDensity,
  suitStrength,
} from '@five-hundred/learn';
import { type ObservedConstraints, type SampledWorld, sampleWorld } from './worlds.js';

/** One hidden seat's observed auction call, the evidence a prior conditions on. */
export interface CallObservation {
  readonly seat: number;
  readonly policyKind: PolicyKind;
  /** The engine Bid.kind that seat played (PASS / IND / NUM / …). */
  readonly callKind: string;
  /** The bid's strain (ignored for PASS). */
  readonly strain: number;
}

/** Default uniform draws to keep-best over, matching indWorldTries in spirit. */
export const DEFAULT_PRIOR_TRIES = 20;

/** The seat's strength in the sense the fitter recorded for this call class. */
function observedStrength(
  world: SampledWorld,
  obs: CallObservation,
  weights: CalibrationArtifact['weights'],
): number {
  const hand = (world.hands[obs.seat] ?? []) as readonly Card[];
  if (obs.callKind === PASS) return bestStrength(hand, weights);
  return suitStrength(hand, obs.strain, weights);
}

/**
 * Sample a world biased toward the learned priors for the observed calls. Keeps
 * the best of {@link DEFAULT_PRIOR_TRIES} uniform draws by summed prior
 * log-density; falls back to a single uniform draw when no observation carries
 * a usable prior. Pure given (constraints, observations, artifact, rng).
 */
export function samplePriorConditionedWorld(
  constraints: ObservedConstraints,
  observations: readonly CallObservation[],
  artifact: CalibrationArtifact,
  rng: Rng,
  tries: number = DEFAULT_PRIOR_TRIES,
): SampledWorld {
  // Resolve each observation's prior once; drop the ones too thin to trust.
  const active: { obs: CallObservation; prior: PriorSummary }[] = [];
  for (const obs of observations) {
    const prior = priorFor(artifact, obs.policyKind, obs.callKind, obs.strain);
    if (prior !== null) active.push({ obs, prior });
  }
  if (active.length === 0) return sampleWorld(constraints, rng);

  let best: SampledWorld | null = null;
  let bestScore = -Infinity;
  const draws = Math.max(1, tries);
  for (let t = 0; t < draws; t++) {
    const world = sampleWorld(constraints, rng);
    let score = 0;
    for (const { obs, prior } of active) {
      score += priorLogDensity(prior, observedStrength(world, obs, artifact.weights));
    }
    if (score > bestScore) {
      best = world;
      bestScore = score;
    }
  }
  return best as SampledWorld;
}

/**
 * Hidden-hand determinization: prior-conditioned when a calibration artifact
 * is loaded, otherwise the uniform {@link sampleWorld}. Bidding, keeps, and
 * play all go through this so a missing artifact stays byte-identical to
 * today's sampler (fh-azx.5).
 */
export function sampleHiddenWorld(
  constraints: ObservedConstraints,
  rng: Rng,
  artifact?: CalibrationArtifact | null,
  observations: readonly CallObservation[] = [],
): SampledWorld {
  if (artifact === undefined || artifact === null) return sampleWorld(constraints, rng);
  return samplePriorConditionedWorld(constraints, observations, artifact, rng);
}

/**
 * Rotate table-seat observations into the Hard rollout frame, where the
 * viewer is always seat 0. Bidding and keeps sample that way; play keeps
 * table seats via deriveConstraints. Identity when `viewer` is 0.
 */
export function remapCallObservations(
  observations: readonly CallObservation[],
  viewer: number,
): CallObservation[] {
  const shift = ((viewer % 4) + 4) % 4;
  if (shift === 0) return [...observations];
  return observations.map((obs) => ({
    ...obs,
    seat: (obs.seat - shift + 4) % 4,
  }));
}

/** Resolve a seat's policy kind: unknown seats are Hard, never guessed human. */
export function policyKindForSeat(
  policyKinds: readonly (PolicyKind | string | null | undefined)[] | undefined,
  seat: number,
): PolicyKind {
  const k = policyKinds?.[seat];
  if (k === 'human' || k === 'easy' || k === 'medium' || k === 'hard') return k;
  return 'hard';
}

/**
 * Build {@link CallObservation}s from the public auction log. Skips the
 * viewer and any seat not in `hiddenSeats` (sat-out partners are not hidden
 * seats — do not invent an observation for them). Empty/missing auction
 * yields no observations, so {@link samplePriorConditionedWorld} falls back
 * to one uniform draw.
 */
export function observationsFromAuction(
  auction:
    | {
        readonly history: readonly {
          readonly seat: number;
          readonly bid: { readonly kind: string; readonly strain: number };
        }[];
      }
    | null
    | undefined,
  viewer: number,
  policyKinds?: readonly (PolicyKind | string | null | undefined)[],
  hiddenSeats?: readonly number[],
): CallObservation[] {
  if (auction === null || auction === undefined) return [];
  const allowed = hiddenSeats === undefined ? null : new Set(hiddenSeats);
  const out: CallObservation[] = [];
  for (const entry of auction.history) {
    if (entry.seat === viewer) continue;
    if (allowed !== null && !allowed.has(entry.seat)) continue;
    out.push({
      seat: entry.seat,
      policyKind: policyKindForSeat(policyKinds, entry.seat),
      callKind: entry.bid.kind,
      strain: entry.bid.strain,
    });
  }
  return out;
}
