/**
 * Bot strength gate — the issue's acceptance criterion AC-2 and the PRD's
 * M3 acceptance bar (sections 4.4, 8): Medium partnerships must beat Easy
 * partnerships in at least 60% of 200 seeded headless games.
 *
 * Seats: Medium on side 0 (seats 0 and 2), Easy on side 1 (seats 1 and 3).
 * The seed is fixed so the gate is deterministic; the Hard bot reuses this
 * harness with its own threshold later.
 */

import { describe, expect, it } from 'vitest';
import { EasyPolicy, MediumPolicy, simulateGames } from '../src/index.js';

const GAMES = 200;
const SEED = 1;

describe('Medium-beats-Easy strength gate', () => {
  it(`Medium side wins >= 60% of ${GAMES} games`, () => {
    const policies = [new MediumPolicy(), new EasyPolicy(), new MediumPolicy(), new EasyPolicy()];
    const wins = simulateGames(GAMES, policies, SEED);
    expect(wins[0] + wins[1]).toBe(GAMES);
    expect(wins[0] / GAMES).toBeGreaterThanOrEqual(0.6);
  });
});
