/**
 * @five-hundred/bots — bot bidding and play policies.
 *
 * Placeholder module: policies land in later issues.
 */
import { ENGINE_NAME } from '@five-hundred/engine';

export const BOTS_NAME = '@five-hundred/bots';

/** Proves the workspace dependency on the engine package is wired. */
export function engineDependencyName(): string {
  return ENGINE_NAME;
}
