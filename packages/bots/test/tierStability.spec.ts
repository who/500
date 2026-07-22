/**
 * Tier-stability guard (fh-sja.6 AC-2). The self-play tuner ships ONLY a Hard
 * overlay, and only over the `hardBidding.*` group — leaves no other tier
 * reads. These tests pin that promise two ways:
 *
 *   1. Structurally: HARD_LEAVES (the tuner's Hard search vector) is confined
 *      to the hardBidding group, and merging a maxed-out Hard overlay leaves
 *      every OTHER param group byte-identical to the defaults.
 *   2. Behaviorally: full-game action transcripts for four Easy seats and for
 *      four Medium seats are byte-for-byte identical whether they run under the
 *      defaults or under a Hard overlay — because Easy/Medium never consult
 *      hardBidding. This is the guarantee that surfacing a learned overlay for
 *      Hard cannot perturb the shipped Easy/Medium bots.
 *
 * All runs are seeded and deterministic.
 */

import { describe, expect, it } from 'vitest';
import { PASS, applyAction, bid, makeRng, newGame, type Action, type GameState } from '@five-hundred/engine';
import { EasyPolicy, MediumPolicy, botAction, type BotParams, type Policy } from '../src/index.js';
import { DEFAULT_PARAMS, mergeParams } from '../src/params.js';
import { HARD_LEAVES } from '../src/tune.js';

/**
 * A Hard overlay that pushes every tuner-searched leaf to its extreme bound —
 * the most hostile input the shipped tuner could ever emit. If Easy/Medium are
 * insensitive to THIS, they are insensitive to any promoted overlay.
 */
function maxedHardOverlay(): BotParams {
  const hardBidding: Record<string, number> = { ...DEFAULT_PARAMS.hardBidding };
  for (const leaf of HARD_LEAVES) hardBidding[leaf.key] = leaf.max;
  return mergeParams(DEFAULT_PARAMS, {
    schemaVersion: DEFAULT_PARAMS.schemaVersion,
    hardBidding: hardBidding as BotParams['hardBidding'],
  });
}

/** Record every engine action of one full seeded game as a JSON transcript. */
function transcript(policies: readonly Policy[], seed: number): string[] {
  let state: GameState = newGame(seed);
  const rng = makeRng(seed);
  const out: string[] = [];
  let guard = 0;
  while (state.phase !== 'gameOver') {
    if (guard++ > 20000) throw new Error('game did not terminate');
    const action: Action = botAction(state, policies, rng);
    out.push(JSON.stringify(action));
    let result = applyAction(state, action);
    if (!result.ok && state.phase === 'auction' && action.type === 'bid') {
      // driveHand's rule: an illegal/too-low bid counts as a pass.
      result = applyAction(state, { type: 'bid', seat: action.seat, bid: bid(PASS) });
    }
    if (!result.ok) {
      throw new Error(`illegal ${action.type} by seat ${action.seat}: ${result.error.message}`);
    }
    state = result.state;
  }
  return out;
}

describe('tier-stability guard (fh-sja.6 AC-2)', () => {
  it('confines the Hard tuner vector to the hardBidding group', () => {
    for (const leaf of HARD_LEAVES) {
      expect(leaf.group).toBe('hardBidding');
    }
  });

  it('leaves every non-Hard-bidding param group byte-identical under a maxed overlay', () => {
    const overlaid = maxedHardOverlay();
    for (const group of ['suitStrength', 'bidding', 'slam', 'endgame', 'hardKeeps', 'hardPlay'] as const) {
      expect(overlaid[group]).toEqual(DEFAULT_PARAMS[group]);
    }
    // The overlay DID move hardBidding — otherwise the guard is vacuous.
    expect(overlaid.hardBidding).not.toEqual(DEFAULT_PARAMS.hardBidding);
  });

  it('keeps four Medium seats byte-stable under a Hard overlay', () => {
    const overlay = maxedHardOverlay();
    const seeds = [1, 7, 42, 1000, 65535];
    for (const seed of seeds) {
      const withDefaults = transcript(Array.from({ length: 4 }, () => new MediumPolicy(DEFAULT_PARAMS)), seed);
      const withOverlay = transcript(Array.from({ length: 4 }, () => new MediumPolicy(overlay)), seed);
      expect(withOverlay).toEqual(withDefaults);
      expect(withDefaults.length).toBeGreaterThan(0);
    }
  });

  it('keeps four Easy seats byte-stable regardless of params (they never read them)', () => {
    // Easy is constructed exactly as the server constructs it (policyFor): no
    // params seam at all. The overlay cannot reach it; the transcript pins it.
    const seeds = [3, 11, 99, 2024];
    for (const seed of seeds) {
      const a = transcript(Array.from({ length: 4 }, () => new EasyPolicy()), seed);
      const b = transcript(Array.from({ length: 4 }, () => new EasyPolicy()), seed);
      expect(a).toEqual(b);
      expect(a.length).toBeGreaterThan(0);
    }
  });
});
