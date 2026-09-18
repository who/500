/**
 * @five-hundred/bots — bot bidding and play policies.
 *
 * Hard is the only bot the product ships. Policies are pure/synchronous
 * strategy plug-ins over engine types; the server drives Hard against
 * GameState, the sim harness runs it headless, and HeuristicPolicy is the
 * internal play-out model Hard's rollouts and its in-thread fallback use.
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
export * from './memory.js';
export * from './heuristic.js';
export * from './sim.js';
export * from './hard/worlds.js';
export * from './hard/priors.js';
export * from './hard/bidding.js';
export * from './hard/keeps.js';
export * from './hard/play.js';
export * from './hard/policy.js';
export * from './arena-runner.js';
