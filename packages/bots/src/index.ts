/**
 * @five-hundred/bots — bot bidding and play policies.
 *
 * Policies are pure/synchronous strategy plug-ins over engine types; the
 * server drives them against GameState, the sim harness runs them headless,
 * and the Hard bot reuses them as rollout opponent models.
 */
import { ENGINE_NAME } from '@five-hundred/engine';

export const BOTS_NAME = '@five-hundred/bots';

/** Proves the workspace dependency on the engine package is wired. */
export function engineDependencyName(): string {
  return ENGINE_NAME;
}

export * from './params.js';
export * from './policy.js';
export * from './helpers.js';
export * from './easy.js';
export * from './medium.js';
export * from './sim.js';
export * from './hard/worlds.js';
export * from './hard/priors.js';
export * from './hard/bidding.js';
export * from './hard/keeps.js';
export * from './hard/play.js';
export * from './hard/policy.js';
export * from './arena-runner.js';
