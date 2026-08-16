/**
 * Local A/B: weaker left bower vs equal bowers, in the Hard-vs-Hard arena.
 *
 *   pnpm learn:ab-bower
 *   pnpm learn:ab-bower -- --games 80 --seed 7
 *   pnpm learn:ab-bower -- --right 0.95 --left 0.90 --equal 0.95
 *   pnpm learn:ab-bower -- --strength-only
 *   pnpm learn:ab-bower -- --memory-only
 *
 * Side A is the split (right/left). Side B is equal. Each seed is played
 * twice with seats swapped so the first-bidder edge cancels. The SPRT
 * verdict is whether A is stronger than B — same gate as learn:tune.
 *
 * Why two knobs: `hardMemory.*BowerSalience` only changes what Hard
 * forgets. At the shipped curve, 0.90 and 0.95 both sit above
 * permanentSalience once trumpBonus is added, so a memory-only split
 * will not change play. `suitStrength.leftBower` / `rightBower` change
 * how much a bower is worth when bidding and estimating — that is the
 * difference you will actually see in win rate. The default run applies
 * both so the numbers you type match the names you used.
 */

import { runMatch, type MatchResult } from '@five-hundred/learn';
import { makeHardMatchRunner } from './arena-runner.js';
import { DEFAULT_PARAMS, mergeParams, type BotParams, type PartialBotParams } from './params.js';

export interface AbBowerOptions {
  readonly right: number;
  readonly left: number;
  readonly equal: number;
  readonly applyStrength: boolean;
  readonly applyMemory: boolean;
  readonly maxGames: number;
  readonly seed: number;
  readonly concurrency: number;
  readonly bidWorlds: number;
  readonly keepWorlds: number;
  readonly playWorlds: number;
}

export const DEFAULT_AB_BOWER: AbBowerOptions = {
  right: 0.95,
  left: 0.9,
  equal: 0.95,
  applyStrength: true,
  applyMemory: true,
  maxGames: 40,
  seed: 1,
  concurrency: 4,
  bidWorlds: 6,
  keepWorlds: 6,
  playWorlds: 3,
};

/** Overlay that sets only the requested bower leaves. */
export function bowerOverlay(
  right: number,
  left: number,
  applyStrength: boolean,
  applyMemory: boolean,
): PartialBotParams {
  return {
    schemaVersion: DEFAULT_PARAMS.schemaVersion,
    ...(applyStrength ? { suitStrength: { rightBower: right, leftBower: left } } : {}),
    ...(applyMemory
      ? { hardMemory: { rightBowerSalience: right, leftBowerSalience: left } }
      : {}),
  };
}

export function candidateParams(opts: AbBowerOptions): BotParams {
  return mergeParams(DEFAULT_PARAMS, bowerOverlay(opts.right, opts.left, opts.applyStrength, opts.applyMemory));
}

export function equalParams(opts: AbBowerOptions): BotParams {
  return mergeParams(DEFAULT_PARAMS, bowerOverlay(opts.equal, opts.equal, opts.applyStrength, opts.applyMemory));
}

function numFlag(args: string[], name: string, fallback: number): number {
  const i = args.lastIndexOf(name);
  if (i === -1) return fallback;
  const raw = args[i + 1];
  const value = Number(raw);
  if (raw === undefined || raw.startsWith('--') || !Number.isFinite(value)) {
    throw new Error(`${name} needs a number`);
  }
  return value;
}

export function parseAbBowerArgs(args: string[]): AbBowerOptions {
  const strengthOnly = args.includes('--strength-only');
  const memoryOnly = args.includes('--memory-only');
  if (strengthOnly && memoryOnly) {
    throw new Error('use only one of --strength-only / --memory-only');
  }
  return {
    right: numFlag(args, '--right', DEFAULT_AB_BOWER.right),
    left: numFlag(args, '--left', DEFAULT_AB_BOWER.left),
    equal: numFlag(args, '--equal', DEFAULT_AB_BOWER.equal),
    applyStrength: !memoryOnly,
    applyMemory: !strengthOnly,
    maxGames: numFlag(args, '--games', DEFAULT_AB_BOWER.maxGames),
    seed: numFlag(args, '--seed', DEFAULT_AB_BOWER.seed),
    concurrency: numFlag(args, '--concurrency', DEFAULT_AB_BOWER.concurrency),
    bidWorlds: numFlag(args, '--bid-worlds', DEFAULT_AB_BOWER.bidWorlds),
    keepWorlds: numFlag(args, '--keep-worlds', DEFAULT_AB_BOWER.keepWorlds),
    playWorlds: numFlag(args, '--play-worlds', DEFAULT_AB_BOWER.playWorlds),
  };
}

function describeArm(label: string, params: BotParams, opts: AbBowerOptions): string {
  const bits: string[] = [];
  if (opts.applyStrength) {
    bits.push(`suitStrength R=${params.suitStrength.rightBower} L=${params.suitStrength.leftBower}`);
  }
  if (opts.applyMemory) {
    bits.push(
      `memory R=${params.hardMemory.rightBowerSalience} L=${params.hardMemory.leftBowerSalience}`,
    );
  }
  return `${label}: ${bits.join('; ') || 'no knobs (pass --strength-only or drop --memory-only)'}`;
}

function formatResult(result: MatchResult): string {
  const rate = (100 * result.winRate).toFixed(1);
  const conf = (100 * result.confidence).toFixed(1);
  return (
    `verdict=${result.verdict}  A-better=${result.promote ? 'yes' : 'no'}  ` +
    `A win rate ${rate}%  (${result.wins}–${result.losses} decisive, ` +
    `${result.gamesPlayed} games / ${result.seedsPlayed} seeds, confidence ${conf}%)`
  );
}

export async function runAbBower(args: string[]): Promise<MatchResult> {
  const opts = parseAbBowerArgs(args);
  const a = candidateParams(opts);
  const b = equalParams(opts);
  console.log(
    `[ab-bower] A = split right=${opts.right} left=${opts.left}  ` +
      `B = equal ${opts.equal}  maxSeeds=${opts.maxGames} seed=${opts.seed}  ` +
      `worlds ${opts.bidWorlds}/${opts.keepWorlds}/${opts.playWorlds}`,
  );
  console.log(`[ab-bower] ${describeArm('A', a, opts)}`);
  console.log(`[ab-bower] ${describeArm('B', b, opts)}`);
  if (opts.applyMemory && !opts.applyStrength) {
    console.log(
      '[ab-bower] note: 0.90 and 0.95 memory both stay permanent at shipped ' +
        'trumpBonus/permanentSalience — expect a coin-flip. Use the default ' +
        '(both knobs) or --strength-only to change bidding.',
    );
  }

  const result = await runMatch({
    a,
    b,
    run: makeHardMatchRunner({
      bidWorlds: opts.bidWorlds,
      keepWorlds: opts.keepWorlds,
      playWorlds: opts.playWorlds,
    }),
    maxGames: opts.maxGames,
    seed: opts.seed,
    concurrency: opts.concurrency,
  });
  console.log(`[ab-bower] ${formatResult(result)}`);
  if (result.verdict === 'accept-h1') {
    console.log('[ab-bower] split looks stronger than equal (SPRT accepted H1).');
  } else if (result.verdict === 'accept-h0') {
    console.log('[ab-bower] split was not shown to be stronger (SPRT accepted H0).');
  } else {
    console.log('[ab-bower] budget exhausted still undecided — raise --games.');
  }
  return result;
}
