/**
 * Endgame recovery eval (fh-e52 AC-3): seeded full games with 4 Hard bots,
 * measuring how often a side that hits a losing position (opponents >= 440
 * while it trails) still wins the game.
 *
 *   node --import tsx src/endgame-eval.ts --games 200 --seed 7
 *
 * With --start a,b every game instead BEGINS at scores [a, b] (side 0
 * trailing) and the metric is side 0's win rate. This is the fair
 * before/after comparison: in organic games the score-aware policies change
 * WHICH positions get reached (denial makes losing games crawl through the
 * flag zone instead of ending before it), so the conditional recovery rate
 * shifts denominator; a fixed start holds the position distribution equal.
 *
 *   node --import tsx src/endgame-eval.ts --games 200 --seed 7 --start 100,450
 *
 * World budget matches the hardStrength suite (8/10/8) so runs finish in
 * suite-scale time; the metric compares like-for-like across code versions.
 */

import type { GameState } from '@five-hundred/engine';
import { applyAction, makeRng, newGame } from '@five-hundred/engine';
import { HardPolicy } from './hard/policy.js';
import { MAX_GAME_HANDS, driveHand } from './sim.js';

const SUITE_BUDGET = { bidWorlds: 8, keepWorlds: 10, play: { worlds: 8 } } as const;
const LOSING_OPP_SCORE = 440;

function intFlag(args: string[], name: string, fallback: number): number {
  const i = args.lastIndexOf(name);
  if (i === -1) return fallback;
  const value = Number(args[i + 1]);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} needs a non-negative integer`);
  }
  return value;
}

function startFlag(args: string[]): [number, number] | null {
  const i = args.lastIndexOf('--start');
  if (i === -1) return null;
  const parts = (args[i + 1] ?? '').split(',').map(Number);
  const [a, b] = parts;
  if (parts.length !== 2 || !Number.isInteger(a) || !Number.isInteger(b)) {
    throw new Error('--start needs two comma-separated integers, e.g. --start 100,450');
  }
  return [a as number, b as number];
}

const args = process.argv.slice(2);
const games = intFlag(args, '--games', 200);
const seed = intFlag(args, '--seed', 7);
const start = startFlag(args);

const rng = makeRng(seed);
let attempts = 0;
let recoveries = 0;
let gamesWithLosingPos = 0;
let side0Wins = 0;

for (let i = 0; i < games; i++) {
  const policies = [0, 1, 2, 3].map(() => new HardPolicy(SUITE_BUDGET));
  let state = newGame(rng.int(0x100000000));
  if (start !== null) {
    state = { ...state, game: { ...state.game, scores: start } } as GameState;
  }
  const flagged = [false, false];
  let winner: number;
  for (;;) {
    for (const side of [0, 1]) {
      const my = state.game.scores[side] as number;
      const opp = state.game.scores[1 - side] as number;
      if (opp >= LOSING_OPP_SCORE && my < opp) flagged[side] = true;
    }
    try {
      state = driveHand(state, policies, rng);
    } catch (err) {
      console.error(
        `game ${i}, hand ${state.handNumber}, scores [${state.game.scores.join(', ')}]: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    if (state.game.winner !== null) {
      winner = state.game.winner;
      break;
    }
    if (state.handNumber + 1 >= MAX_GAME_HANDS) {
      winner = state.game.scores[0] >= state.game.scores[1] ? 0 : 1;
      break;
    }
    const next = applyAction(state, { type: 'nextHand', seat: 0 });
    if (!next.ok) throw new Error(`nextHand rejected: ${next.error.message}`);
    state = next.state;
  }
  if (winner === 0) side0Wins++;
  if (flagged[0] === true || flagged[1] === true) gamesWithLosingPos++;
  for (const side of [0, 1]) {
    if (flagged[side] === true) {
      attempts++;
      if (winner === side) recoveries++;
    }
  }
  if ((i + 1) % 50 === 0) {
    console.log(
      start !== null
        ? `${i + 1}/${games} games: side 0 won ${side0Wins} so far`
        : `${i + 1}/${games} games: ${recoveries}/${attempts} recoveries so far`,
    );
  }
}

if (start !== null) {
  const rate = ((100 * side0Wins) / games).toFixed(1);
  console.log(
    `seed ${seed}, ${games} games (HHHH, budget 8/10/8) from fixed start ` +
      `[${start.join(', ')}]: trailing side 0 won ${side0Wins}/${games} (${rate}%)`,
  );
} else {
  const rate = attempts > 0 ? ((100 * recoveries) / attempts).toFixed(1) : 'n/a';
  console.log(
    `seed ${seed}, ${games} games (HHHH, budget 8/10/8): ` +
      `${gamesWithLosingPos} games reached a losing position (opp >= ${LOSING_OPP_SCORE}, trailing); ` +
      `trailing side recovered ${recoveries}/${attempts} (${rate}%)`,
  );
}
