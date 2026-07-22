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
