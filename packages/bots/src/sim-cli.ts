/**
 * Manual tuning CLI for the headless sim harness.
 *
 *   pnpm --filter @five-hundred/bots sim -- --hands 5000
 *   pnpm --filter @five-hundred/bots sim -- --games 200 --policies MEME
 *   pnpm --filter @five-hundred/bots sim -- --hands 5000 --seed 7 --policies MMMM
 *   pnpm --filter @five-hundred/bots sim:hard -- --games 200 --seed 7
 *
 * --policies is one letter per seat (E = Easy, M = Medium, H = Hard at the
 * full default world budget); defaults are MMMM for --hands and MEME (Medium
 * side 0 vs Easy side 1) for --games. sim:hard is the fh-7hw.5 strength-gate
 * run: it front-loads --games 200 --policies HMHM, and later flags win, so
 * appended --games/--seed/--policies override those defaults.
 *
 * Every --hands run ends with the fh-c6i auction-health summary (redeal
 * rate, 7+ contract rate, set rate). The bid-timidity gates are measured at
 * seed 0:
 *   AC-1  --hands 5000 --seed 0                 (4 Medium)
 *   AC-2  --hands 500 --seed 0 --policies HHHH  (4 Hard)
 *
 * Game logging (fh-sja.2): `--games N --log <path>` appends one JSONL
 * GameRecord per game to <path> using the shared packages/learn schema, for a
 * headless self-play corpus. `--log` is only honoured in --games mode.
 */

import { makeRng } from '@five-hundred/engine';
import { GameRecorder, appendGameRecordSync, type PolicyKind } from '@five-hundred/learn';
import { EasyPolicy } from './easy.js';
import { HardPolicy } from './hard/policy.js';
import { MediumPolicy } from './medium.js';
import type { Policy } from './policy.js';
import { playGameRecording, printStats, simulateGames, simulateHands } from './sim.js';

function intFlag(args: string[], name: string): number | undefined {
  const i = args.lastIndexOf(name);
  if (i === -1) return undefined;
  const raw = args[i + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} needs a non-negative integer, got ${String(raw)}`);
  }
  return value;
}

function parsePolicies(spec: string): Policy[] {
  if (!/^[EMH]{4}$/.test(spec)) {
    throw new Error(`--policies needs 4 letters from E/M/H, got ${spec}`);
  }
  return [...spec].map((ch) =>
    ch === 'E' ? new EasyPolicy() : ch === 'H' ? new HardPolicy() : new MediumPolicy(),
  );
}

function strFlag(args: string[], name: string): string | undefined {
  const i = args.lastIndexOf(name);
  if (i === -1) return undefined;
  const raw = args[i + 1];
  if (raw === undefined || raw.startsWith('--')) {
    throw new Error(`${name} needs a value`);
  }
  return raw;
}

/** One log-schema policy kind per seat, derived from the --policies letters. */
function policyKinds(spec: string): PolicyKind[] {
  return [...spec].map((ch) => (ch === 'E' ? 'easy' : ch === 'H' ? 'hard' : 'medium'));
}

/**
 * Play `n` games and append one GameRecord per game to `path` (fh-sja.2 AC-2:
 * the sim emits the same schema headlessly). Returns wins per side so the CLI
 * can still print its summary line.
 */
function simulateGamesLogged(
  n: number,
  policies: readonly Policy[],
  kinds: readonly PolicyKind[],
  seed: number,
  path: string,
): [number, number] {
  const rng = makeRng(seed);
  const players = kinds.map((kind, s) => ({
    seat: s,
    kind,
    paramsSchemaVersion: null,
    overlayHash: null,
  }));
  const wins: [number, number] = [0, 0];
  for (let i = 0; i < n; i++) {
    const gameSeed = rng.int(0x100000000);
    const recorder = new GameRecorder({
      source: 'sim',
      gameId: `${seed}-${i}`,
      seed: gameSeed,
      createdAt: null,
      players,
    });
    const final = playGameRecording(policies, rng, gameSeed, (s) => recorder.recordHand(s));
    appendGameRecordSync(path, recorder.finish(final));
    const side: 0 | 1 =
      final.game.winner !== null
        ? final.game.winner === 0
          ? 0
          : 1
        : final.game.scores[0] >= final.game.scores[1]
          ? 0
          : 1;
    wins[side] += 1;
  }
  return wins;
}

const args = process.argv.slice(2);
const games = intFlag(args, '--games');
const hands = intFlag(args, '--hands');
const seed = intFlag(args, '--seed') ?? 0;
const spec = args[args.lastIndexOf('--policies') + 1];
const logPath = strFlag(args, '--log');

if (games !== undefined) {
  const chosen = args.includes('--policies') ? (spec ?? '') : 'MEME';
  const policies = parsePolicies(chosen);
  const wins =
    logPath === undefined
      ? simulateGames(games, policies, seed)
      : simulateGamesLogged(games, policies, policyKinds(chosen), seed, logPath);
  const rate = games > 0 ? ((100 * wins[0]) / games).toFixed(1) : 'n/a';
  if (logPath !== undefined) console.log(`logged ${games} games to ${logPath}`);
  console.log(`side 0 wins ${wins[0]}, side 1 wins ${wins[1]} (side 0 rate ${rate}%)`);
} else {
  const policies = parsePolicies(args.includes('--policies') ? (spec ?? '') : 'MMMM');
  printStats(simulateHands(hands ?? 5000, policies, seed));
}
