/**
 * Play-log calibrate CLI (fh-azx.3): `pnpm learn:calibrate`. Fits a
 * calibration artifact and a bidding.headroom overlay from GameRecords,
 * then writes them only when the SPRT gate promotes — or immediately
 * under test-only `--skip-sprt`.
 *
 * Logic lives here so tests can call {@link runCalibrate} with fixture
 * paths and an injectable promote gate; the thin `calibrate-cli.ts`
 * entrypoint is what operators invoke.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type GameRecord,
  type GameStore,
  type PromotionDecision,
  type PromoteOptions,
  type StoreEnv,
  CALIBRATION_KEY,
  OVERLAY_KEY,
  createGameStore,
  deriveParamsOverlay,
  fitCalibration,
  promoteIfBetter,
  readGameRecordsSync,
  serializeCalibration,
} from '@five-hundred/learn';
import { applyLearnedVersion } from './applyOverlay.js';
import { makeHardMatchRunner } from './arena-runner.js';
import {
  type BotParams,
  type PartialBotParams,
  DEFAULT_PARAMS,
  PARAMS_SCHEMA_VERSION,
  loadParams,
  mergeParams,
} from './params.js';
import { overlayVersion } from './tune.js';

/** Flags `pnpm learn:calibrate -- --help` must document. */
export const CALIBRATE_HELP = `Usage: pnpm learn:calibrate -- [options]

Fit a Hard overlay and calibration.json from a play-log corpus.
Writes local.json and calibration.json to --out-dir only when the
fitted overlay clears the SPRT promotion gate (or --skip-sprt).

Options:
  --in <jsonl>         Local JSONL GameRecord corpus
  --store              Read the corpus from the game store (AWS env)
  --out-dir <dir>      Output directory (default: packages/bots/params)
  --upload             Also put artifacts/overlay.json and artifacts/calibration.json
                       After a successful upload, bump FH_LEARNED_VERSION on
                       the game service (RAILWAY_TOKEN, optional
                       FH_GAME_SERVICE_ID / FH_RAILWAY_PROJECT_ID /
                       FH_RAILWAY_ENVIRONMENT_ID). Missing token warns and
                       still exits 0.
  --confirm-games <n>  SPRT confirmation budget (default: 80)
  --seed <n>           SPRT seed (default: 0)
  --skip-sprt          Test-only: write without running promoteIfBetter
  --help               Show this help
`;

const DEFAULT_OUT_DIR = 'packages/bots/params';
const DEFAULT_CONFIRM_GAMES = 80;

export type PromoteFn = (
  candidate: BotParams,
  incumbent: BotParams,
  anchor: BotParams,
  options: PromoteOptions<BotParams>,
) => Promise<PromotionDecision>;

export interface CalibrateHooks {
  /** Replace the live SPRT gate (tests inject a stub; production omits this). */
  readonly promoteIfBetter?: PromoteFn;
  /** Incumbent loader; defaults to {@link loadParams}. */
  readonly loadParams?: () => BotParams;
  /** Store factory for `--store` / `--upload`. */
  readonly createGameStore?: (env: StoreEnv) => GameStore | null;
  /**
   * Post-upload Railway bump. Tests inject a stub; production calls
   * {@link applyLearnedVersion}.
   */
  readonly applyLearnedVersion?: (version: string, env: StoreEnv) => Promise<void>;
  readonly env?: StoreEnv;
  readonly log?: (line: string) => void;
}

function numFlag(args: string[], name: string, dflt: number): number {
  const i = args.lastIndexOf(name);
  if (i === -1) return dflt;
  const v = Number(args[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`${name} needs a number, got ${String(args[i + 1])}`);
  return v;
}

function strFlag(args: string[], name: string): string | undefined {
  const i = args.lastIndexOf(name);
  if (i === -1) return undefined;
  const raw = args[i + 1];
  if (raw === undefined || raw.startsWith('--')) throw new Error(`${name} needs a value`);
  return raw;
}

function dedupeByGameId(batches: readonly (readonly GameRecord[])[]): GameRecord[] {
  const seen = new Set<string>();
  const out: GameRecord[] = [];
  for (const batch of batches) {
    for (const rec of batch) {
      if (seen.has(rec.gameId)) continue;
      seen.add(rec.gameId);
      out.push(rec);
    }
  }
  return out;
}

/**
 * Run the calibrator from a parsed argv (everything after `learn:calibrate --`).
 * Importing this module never launches a run. Throws on usage or I/O errors
 * so the CLI exits 1; thin-corpus skip and a refused promote return normally
 * (exit 0) and write nothing.
 */
export async function runCalibrate(args: string[], hooks: CalibrateHooks = {}): Promise<void> {
  const log = hooks.log ?? ((line: string) => console.log(line));

  if (args.includes('--help') || args.includes('-h')) {
    log(CALIBRATE_HELP);
    return;
  }

  const inPath = strFlag(args, '--in');
  const useStore = args.includes('--store');
  if (inPath === undefined && !useStore) {
    throw new Error('usage: provide --in <jsonl> and/or --store');
  }

  const outDir = strFlag(args, '--out-dir') ?? DEFAULT_OUT_DIR;
  const upload = args.includes('--upload');
  const skipSprt = args.includes('--skip-sprt');
  const confirmGames = numFlag(args, '--confirm-games', DEFAULT_CONFIRM_GAMES);
  const seed = numFlag(args, '--seed', 0);

  const makeStore = hooks.createGameStore ?? ((env: StoreEnv) => createGameStore(env));
  const env = hooks.env ?? process.env;
  let store: GameStore | null = null;
  if (useStore || upload) {
    store = makeStore(env);
    if (store === null) {
      throw new Error('--store/--upload requires a configured game store');
    }
  }

  const batches: GameRecord[][] = [];
  if (inPath !== undefined) batches.push(readGameRecordsSync(inPath));
  if (useStore && store !== null) batches.push(await store.readGames());
  const records = dedupeByGameId(batches);

  const artifact = fitCalibration(records);
  if (artifact.meta.makeSamples < artifact.minSamples) {
    const need = artifact.minSamples - artifact.meta.makeSamples;
    const sources: string[] = [];
    if (useStore) sources.push('source=store');
    if (inPath !== undefined) sources.push(`in=${inPath}`);
    log('skipped: thin corpus');
    log(
      `[calibrate] games=${artifact.meta.games} hands=${artifact.meta.hands} ` +
        `makeSamples=${artifact.meta.makeSamples} minSamples=${artifact.minSamples}` +
        (sources.length > 0 ? ` ${sources.join(' ')}` : ''),
    );
    log(`need ${need} more numbered (7–10) hands to fit`);
    log('numbered contracts count; nulla / redeals / unfinished games do not');
    return;
  }

  const fitted = deriveParamsOverlay(artifact, {
    schemaVersion: PARAMS_SCHEMA_VERSION,
    baseHeadroom: DEFAULT_PARAMS.bidding.headroom,
  });
  const overlay: PartialBotParams & { readonly version: string } = {
    ...fitted,
    version: overlayVersion(fitted as PartialBotParams),
  };

  log(
    `[calibrate] games=${artifact.meta.games} hands=${artifact.meta.hands} ` +
      `makeSamples=${artifact.meta.makeSamples} minSamples=${artifact.minSamples}`,
  );
  log(
    `[calibrate] bidding.headroom ${DEFAULT_PARAMS.bidding.headroom} -> ` +
      `${overlay.bidding?.headroom ?? DEFAULT_PARAMS.bidding.headroom}`,
  );

  let promote = skipSprt;
  if (!skipSprt) {
    const incumbent = (hooks.loadParams ?? loadParams)();
    const candidate = mergeParams(DEFAULT_PARAMS, overlay);
    const run = makeHardMatchRunner();
    const gate = hooks.promoteIfBetter ?? promoteIfBetter<BotParams>;
    log(`[calibrate] running SPRT confirmation match (maxGames=${confirmGames})...`);
    const decision = await gate(candidate, incumbent, DEFAULT_PARAMS, {
      run,
      maxGames: confirmGames,
      seed: (seed ^ 0x1234abcd) >>> 0,
    });
    log(
      `confirmation vs incumbent: winRate ${(100 * decision.vsIncumbent.winRate).toFixed(1)}% ` +
        `verdict ${decision.vsIncumbent.verdict} (${decision.vsIncumbent.gamesPlayed} games)`,
    );
    if (decision.vsAnchor) {
      log(
        `confirmation anchor probe: anchor winRate ${(100 * decision.vsAnchor.winRate).toFixed(1)}% ` +
          `verdict ${decision.vsAnchor.verdict}`,
      );
    }
    promote = decision.promote;
  }

  if (!promote) {
    log('❌ NOT PROMOTED — candidate did not clear the SPRT gate; report-only, no overlay written.');
    return;
  }

  mkdirSync(outDir, { recursive: true });
  const overlayPath = join(outDir, 'local.json');
  const calibrationPath = join(outDir, 'calibration.json');
  writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));
  writeFileSync(calibrationPath, serializeCalibration(artifact));

  if (upload && store !== null) {
    await store.putJson(OVERLAY_KEY, overlay);
    await store.putJson(CALIBRATION_KEY, artifact);
    const apply =
      hooks.applyLearnedVersion ??
      ((version: string, applyEnv: StoreEnv) =>
        applyLearnedVersion(version, applyEnv, { warn: log, log }));
    try {
      await apply(overlay.version, env);
    } catch (err) {
      log(
        `[calibrate] applyLearnedVersion failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  log(`✅ PROMOTED — wrote overlay ${overlay.version} to ${overlayPath}`);
  log(`   calibration → ${calibrationPath}`);
}
