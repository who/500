/**
 * Manual tuning CLI for the headless sim harness.
 *
 *   pnpm --filter @five-hundred/bots sim -- --hands 5000
 *   pnpm --filter @five-hundred/bots sim -- --games 200 --policies MEME
 *   pnpm --filter @five-hundred/bots sim -- --hands 5000 --seed 7 --policies MMMM
 *
 * --policies is one letter per seat (E = Easy, M = Medium); defaults are
 * MMMM for --hands and MEME (Medium side 0 vs Easy side 1) for --games.
 */

import { EasyPolicy } from './easy.js';
import { MediumPolicy } from './medium.js';
import type { Policy } from './policy.js';
import { printStats, simulateGames, simulateHands } from './sim.js';

function intFlag(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const raw = args[i + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} needs a non-negative integer, got ${String(raw)}`);
  }
  return value;
}

function parsePolicies(spec: string): Policy[] {
  if (!/^[EM]{4}$/.test(spec)) {
    throw new Error(`--policies needs 4 letters from E/M, got ${spec}`);
  }
  return [...spec].map((ch) => (ch === 'E' ? new EasyPolicy() : new MediumPolicy()));
}

const args = process.argv.slice(2);
const games = intFlag(args, '--games');
const hands = intFlag(args, '--hands');
const seed = intFlag(args, '--seed') ?? 0;
const spec = args[args.indexOf('--policies') + 1];

if (games !== undefined) {
  const policies = parsePolicies(args.includes('--policies') ? (spec ?? '') : 'MEME');
  const wins = simulateGames(games, policies, seed);
  const rate = games > 0 ? ((100 * wins[0]) / games).toFixed(1) : 'n/a';
  console.log(`side 0 wins ${wins[0]}, side 1 wins ${wins[1]} (side 0 rate ${rate}%)`);
} else {
  const policies = parsePolicies(args.includes('--policies') ? (spec ?? '') : 'MMMM');
  printStats(simulateHands(hands ?? 5000, policies, seed));
}
