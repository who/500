/**
 * BotParams — the single, versioned home for every tunable strategy constant
 * the bots use (fh-sja.1). Gathering the Medium suit-strength weights, the
 * bid/indicate/nulla/slam thresholds, the endgame-aggression knobs, and the
 * Hard rollout gates into one typed object is the foundation the learning
 * epic (fh-sja) builds on: the arena's A-vs-B matches (fh-sja.3) and the
 * calibration fitters (fh-sja.5) vary these numbers and nothing else.
 *
 * The checked-in defaults live in params/default.json and reproduce the
 * pre-externalization behavior EXACTLY — every value here is byte-identical to
 * the module constant it replaced, so a seeded sim with DEFAULT_PARAMS digests
 * the same as it did before (AC-1). A git-ignored overlay (params/local.json
 * by default) is deep-merged over the defaults at load; a malformed or
 * version-incompatible overlay is rejected loudly and the defaults stand
 * (AC-2), so a bad tuning artifact can never silently corrupt play.
 *
 * Versioning: PARAMS_SCHEMA_VERSION is stamped into default.json's
 * `schemaVersion` and pinned into every logged game's per-seat provenance
 * (@five-hundred/learn PlayerMeta.paramsSchemaVersion). An overlay whose
 * schemaVersion does not match is treated as forward-incompatible and
 * discarded rather than half-understood.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  CALIBRATION_KEY,
  OVERLAY_KEY,
  parseCalibration,
  validateCalibration,
  type CalibrationArtifact,
} from '@five-hundred/learn';
import defaultParamsJson from '../params/default.json' with { type: 'json' };

/**
 * Bumped whenever the BotParams shape changes incompatibly (a key is removed
 * or its meaning changes). An overlay must carry the matching version or it is
 * rejected at load.
 */
export const PARAMS_SCHEMA_VERSION = 1;

/** Oracle _suit_strength weights (five_hundred.py 249-271). */
export interface SuitStrengthParams {
  /** Joker: one guaranteed trick. */
  readonly joker: number;
  /** Either bower (right/left). */
  readonly bower: number;
  /** Trump Q or better (bowers scored above). */
  readonly trumpHonor: number;
  /** Any lower natural trump. */
  readonly trumpLow: number;
  /** Off-trump ace. */
  readonly sideAce: number;
  /** Off-trump king. */
  readonly sideKing: number;
  /** No-trump ace. */
  readonly ntAce: number;
  /** No-trump king. */
  readonly ntKing: number;
  /** No-trump queen. */
  readonly ntQueen: number;
}

/** choose_bid thresholds (five_hundred.py 278-298) plus the fh-c6i/fh-zpg tunings. */
export interface BiddingParams {
  /** Tuned bid headroom: maxLevel = min(10, trunc(est + headroom)) (fh-c6i). */
  readonly headroom: number;
  /** Minimum est to indicate a suit, and the promise an indication makes. */
  readonly indicateEst: number;
  /** Discounted support credit a receiver adds for a partner indication (fh-zpg). */
  readonly partnerIndicationBonus: number;
  /** Lowness at or above which a lose-all bid is considered. */
  readonly nullaLowness: number;
  /** Highest rank allowed in hand for a lose-all bid (11 = jack). */
  readonly nullaMaxRank: number;
}

/** consider_slam threshold (five_hundred.py 346). */
export interface SlamParams {
  /** suitStrength at or above which the declarer slams. */
  readonly est: number;
}

/** Endgame-aggression knobs (fh-e52), with no oracle counterpart. */
export interface EndgameParams {
  /** Value of the cheapest winning bid (7S = 140). */
  readonly cheapestContract: number;
  /** Extra headroom when the opponents can end the game by winning this auction. */
  readonly headroom: number;
  /** Extra headroom once the opponents can also go out on defender tricks. */
  readonly desperateHeadroom: number;
  /** Opponent score from which four defender tricks end the game. */
  readonly desperateScore: number;
}

/** Hard-bot rollout bidding gates (hard/bidding.ts, fh-7hw.3 / fh-c6i). */
export interface HardBiddingParams {
  /** Shared rollout worlds per bid/slam decision. */
  readonly rolloutWorlds: number;
  /** EV edge over the pass baseline required to bid. */
  readonly bidMargin: number;
  /** EV edge of the slam variant over non-slam required to declare. */
  readonly slamMargin: number;
  /** NULLA candidate lowness gate (looser than Medium's own). */
  readonly nullaCandLowness: number;
  /** NULLA candidate max rank (12 = queen). */
  readonly nullaCandMaxRank: number;
  /** DNULLA candidate lowness gate (Medium's full gate). */
  readonly dnullaCandLowness: number;
  /** DNULLA candidate max rank (11 = jack). */
  readonly dnullaCandMaxRank: number;
  /** Rejection tries when conditioning worlds on a partner indication. */
  readonly indWorldTries: number;
}

/** Hard-bot rollout keep/discard gates (hard/keeps.ts, fh-7hw.2). */
export interface HardKeepsParams {
  /** Shared worlds per keep decision. */
  readonly keepWorlds: number;
  /** Kept cards nearest the boundary eligible to swap out. */
  readonly marginalKeeps: number;
  /** Discarded cards nearest the boundary eligible to swap in. */
  readonly nearMarginalDiscards: number;
  /** Candidate keep-set cap (base + swaps). */
  readonly maxCandidates: number;
}

/** Hard-bot rollout card-play world counts (hard/play.ts, fh-7hw.4). */
export interface HardPlayParams {
  /** Fewest worlds a rollout average may rest on; also the fixed-mode default. */
  readonly worldsFloor: number;
  /** Most worlds a budget-mode decision samples. */
  readonly worldsCap: number;
  /**
   * Secondary reward added to each playout's points delta, per own-side trick
   * (negated on lose-all contracts, where fewer own tricks is the goal). Gives
   * the rollout a gradient when the contract result is already decided so the
   * bot still plays for tricks / damage control (fh-w6c). Kept below the
   * cheapest contract's make/set swing so it can never prefer a set with more
   * tricks over a make.
   */
  readonly trickWeight: number;
  /**
   * Absolute floor, in points, for the margin by which the rollout's best card
   * must beat Medium's heuristic card before Hard is allowed to prefer it
   * (fh-vkr/fh-hg4). Inside the floor, play Medium's card: it catches the
   * decisions the search rates dead level and hands them to a tactically sound
   * choice. Kept below trickWeight so a pick that truly wins more tricks is
   * never overridden on the floor alone.
   */
  readonly mediumTiebreakEps: number;
  /**
   * Standard errors of the paired (best - Medium) rollout difference that the
   * same margin must ALSO clear (fh-4ww). The absolute floor could not size
   * itself to the state: at a noisy decision the paired mean's own spread is
   * tens of points, so noise cleared any floor small enough to be safe
   * elsewhere and the arg-max shipped a low-card lead. Scaling the gate by the
   * measured standard error makes it tight where the search separates the
   * cards and wide where it is guessing. 0 restores the pure-`eps` behaviour.
   */
  readonly mediumTiebreakZ: number;
}

/**
 * Human-memory knobs (memory.ts, fh-8jf.1): the seeded forgetting curve a
 * seat's observation history is filtered through before any card-counting
 * happens. Salience is the memorability of a card in [0, ~1.6]; a horizon is
 * measured in tricks.
 *
 * The shipped values were calibrated in fh-8jf.4 and are what BOTH tiers play
 * off on the server; the measured behaviour they buy (13.8% of played cards
 * dropped, nothing salient ever lost, Hard still beating Medium at the 60%
 * gate) is pinned in test/memoryCalibration.spec.ts, and loosening them is a
 * working difficulty dial — see that spec's LOOSE_MEMORY overlay.
 */
export interface HardMemoryParams {
  /** Salience of the joker — the single most memorable card in the pack. */
  readonly jokerSalience: number;
  /** Either bower (right/left), under a trump contract. */
  readonly bowerSalience: number;
  /** Any ace. */
  readonly aceSalience: number;
  /** Any king. */
  readonly kingSalience: number;
  /** Any queen. */
  readonly queenSalience: number;
  /** A jack that is not a bower. */
  readonly jackSalience: number;
  /** A 4 — the least memorable card there is. */
  readonly spotSalience: number;
  /** Added per rank above the 4, so a 10 sticks slightly better than a 5. */
  readonly spotRankStep: number;
  /** Added for any card that counts as trump (joker and left bower included). */
  readonly trumpBonus: number;
  /** Salience at or above which a card is retained for the whole hand. */
  readonly permanentSalience: number;
  /** Retention horizon, in tricks, of a card with zero salience. */
  readonly baseHorizon: number;
  /** Tricks of retention added per unit of salience. */
  readonly salienceHorizon: number;
  /** Fractional spread of the per-card horizon roll (0 = no jitter). */
  readonly jitter: number;
  /** Tricks back that are never forgotten (1 = the immediately preceding one). */
  readonly graceTricks: number;
  /** Retention horizon, in tricks, of an observed void. */
  readonly voidHorizon: number;
  /** Fraction of the void horizon the deep-past roll may shave off. */
  readonly voidDecay: number;
}

/** Every tunable strategy constant, versioned and deep-mergeable. */
export interface BotParams {
  readonly schemaVersion: number;
  readonly suitStrength: SuitStrengthParams;
  readonly bidding: BiddingParams;
  readonly slam: SlamParams;
  readonly endgame: EndgameParams;
  readonly hardBidding: HardBiddingParams;
  readonly hardKeeps: HardKeepsParams;
  readonly hardPlay: HardPlayParams;
  readonly hardMemory: HardMemoryParams;
}

/**
 * The checked-in defaults, frozen so a policy can never mutate the shared
 * object out from under another. Byte-identical to the pre-fh-sja.1 constants.
 */
export const DEFAULT_PARAMS: BotParams = deepFreeze(defaultParamsJson as BotParams);

/** The numeric-leaf groups every valid BotParams must carry. */
const GROUP_KEYS: readonly (keyof Omit<BotParams, 'schemaVersion'>)[] = [
  'suitStrength',
  'bidding',
  'slam',
  'endgame',
  'hardBidding',
  'hardKeeps',
  'hardPlay',
  'hardMemory',
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** A recursively-partial overlay: any subset of the leaves may be supplied. */
export type PartialBotParams = {
  readonly schemaVersion?: number;
} & {
  readonly [K in keyof Omit<BotParams, 'schemaVersion'>]?: Partial<BotParams[K]>;
};

/**
 * Deep-merge `overlay` over `base`, one group deep (the shape is fixed at two
 * levels, so a full recursive merge is unnecessary). Only known leaves are
 * copied; unknown keys in the overlay are ignored, which is what keeps a
 * forward-dated overlay from injecting garbage.
 */
export function mergeParams(base: BotParams, overlay: PartialBotParams): BotParams {
  const merged: Record<string, unknown> = { schemaVersion: base.schemaVersion };
  for (const group of GROUP_KEYS) {
    const baseGroup = base[group] as unknown as Record<string, number>;
    const overlayGroup = overlay[group] as Record<string, number> | undefined;
    const out: Record<string, number> = { ...baseGroup };
    if (overlayGroup !== undefined) {
      for (const key of Object.keys(baseGroup)) {
        if (typeof overlayGroup[key] === 'number') out[key] = overlayGroup[key] as number;
      }
    }
    merged[group] = out;
  }
  return merged as unknown as BotParams;
}

export type ValidationResult =
  | { readonly ok: true; readonly params: BotParams }
  | { readonly ok: false; readonly error: string };

/**
 * Validate a candidate params object: the schema version must match, every
 * group and every numeric leaf the default declares must be present and
 * finite. Returns a typed result rather than throwing so the loader can fall
 * back loudly instead of crashing the process.
 */
export function validateParams(candidate: unknown): ValidationResult {
  if (candidate === null || typeof candidate !== 'object') {
    return { ok: false, error: 'params must be an object' };
  }
  const c = candidate as Record<string, unknown>;
  if (c.schemaVersion !== PARAMS_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `schemaVersion ${String(c.schemaVersion)} != expected ${PARAMS_SCHEMA_VERSION}`,
    };
  }
  for (const group of GROUP_KEYS) {
    const g = c[group];
    if (g === null || typeof g !== 'object') {
      return { ok: false, error: `missing or non-object group "${group}"` };
    }
    const defGroup = DEFAULT_PARAMS[group] as unknown as Record<string, number>;
    const gv = g as Record<string, unknown>;
    for (const key of Object.keys(defGroup)) {
      const v = gv[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return { ok: false, error: `${group}.${key} must be a finite number, got ${String(v)}` };
      }
    }
  }
  return { ok: true, params: candidate as BotParams };
}

/** Default git-ignored overlay location, relative to this package's root. */
export const DEFAULT_OVERLAY_PATH = 'params/local.json';

/** Explicit overlay file; when set, store and {@link DEFAULT_OVERLAY_PATH} are not consulted. */
export const OVERLAY_PATH_ENV = 'FH_OVERLAY_PATH';

/** Explicit calibration file; when set, store is not consulted. There is no default artifact. */
export const CALIBRATION_PATH_ENV = 'FH_CALIBRATION_PATH';

export interface LoadParamsOptions {
  /**
   * Overlay file path override. Wins over {@link OVERLAY_PATH_ENV}, the store,
   * and {@link DEFAULT_OVERLAY_PATH}.
   */
  readonly overlayPath?: string;
  /** Calibration file path override. Wins over {@link CALIBRATION_PATH_ENV} and the store. */
  readonly calibrationPath?: string;
  /**
   * Env for path/store lookup. Defaults to `process.env`. Pass a plain object
   * in tests so a developer's shell env cannot change the rung under test.
   */
  readonly env?: Record<string, string | undefined>;
  /** Reads and JSON-parses a file; returns null when it does not exist. */
  readonly readOverlay?: (path: string) => unknown;
  /** Filesystem reader for calibration; defaults to {@link readOverlay} or the real fs. */
  readonly readCalibration?: (path: string) => unknown;
  /**
   * Sync store getter (tests inject; boot prefetches). Returning null on
   * {@link OVERLAY_KEY} falls through to {@link DEFAULT_OVERLAY_PATH}.
   */
  readonly readStore?: (key: string) => unknown;
  /** Loud warning sink (defaults to console.warn), so tests can capture it. */
  readonly warn?: (message: string) => void;
}

/**
 * The result of loading the effective params, carrying enough metadata for the
 * product to surface learning: whether a valid overlay was actually applied
 * ({@link present}) and the human-readable version tag it carried
 * ({@link version}, e.g. the lobby's "learned vX"). `params` is always safe to
 * use — it falls back to {@link DEFAULT_PARAMS} on any failure.
 */
export interface OverlayInfo {
  /** True only when a valid overlay was found, merged, and validated. */
  readonly present: boolean;
  /** The overlay's `version` string when present and a non-empty string, else null. */
  readonly version: string | null;
  /** Effective params: defaults with the overlay merged in, or defaults alone. */
  readonly params: BotParams;
}

const NO_OVERLAY: OverlayInfo = { present: false, version: null, params: DEFAULT_PARAMS };

type ArtifactSource = { readonly label: string; readonly read: () => unknown };

/**
 * Overlay lookup: explicit path, else {@link OVERLAY_PATH_ENV}, else store
 * {@link OVERLAY_KEY}, else {@link DEFAULT_OVERLAY_PATH}. An explicit path or
 * env path that is missing does not fall through.
 */
function overlaySources(
  options: LoadParamsOptions,
  readFile: (path: string) => unknown,
): Iterable<ArtifactSource> {
  const env = options.env ?? process.env;
  if (options.overlayPath !== undefined) {
    return [{ label: options.overlayPath, read: () => readFile(options.overlayPath as string) }];
  }
  const envPath = env[OVERLAY_PATH_ENV];
  if (envPath !== undefined && envPath !== '') {
    return [{ label: envPath, read: () => readFile(envPath) }];
  }
  const sources: ArtifactSource[] = [];
  if (options.readStore !== undefined) {
    const readStore = options.readStore;
    sources.push({ label: OVERLAY_KEY, read: () => readStore(OVERLAY_KEY) });
  }
  const fallback = resolveDefaultOverlayPath();
  sources.push({ label: fallback, read: () => readFile(fallback) });
  return sources;
}

/**
 * Calibration lookup: explicit path, else {@link CALIBRATION_PATH_ENV}, else
 * store {@link CALIBRATION_KEY}. No checked-in default artifact.
 */
function calibrationSources(
  options: LoadParamsOptions,
  readFile: (path: string) => unknown,
): Iterable<ArtifactSource> {
  const env = options.env ?? process.env;
  if (options.calibrationPath !== undefined) {
    return [
      { label: options.calibrationPath, read: () => readFile(options.calibrationPath as string) },
    ];
  }
  const envPath = env[CALIBRATION_PATH_ENV];
  if (envPath !== undefined && envPath !== '') {
    return [{ label: envPath, read: () => readFile(envPath) }];
  }
  if (options.readStore !== undefined) {
    const readStore = options.readStore;
    return [{ label: CALIBRATION_KEY, read: () => readStore(CALIBRATION_KEY) }];
  }
  return [];
}

function interpretOverlay(
  raw: unknown,
  label: string,
  warn: (message: string) => void,
): OverlayInfo {
  if (typeof raw !== 'object') {
    warn(`[BotParams] overlay ${label} is not an object, using defaults`);
    return NO_OVERLAY;
  }
  const overlay = raw as PartialBotParams;
  // A version mismatch on the overlay is a hard reject: we will not merge a
  // shape we may not understand.
  if (overlay.schemaVersion !== undefined && overlay.schemaVersion !== PARAMS_SCHEMA_VERSION) {
    warn(
      `[BotParams] overlay ${label} schemaVersion ${String(overlay.schemaVersion)} != ` +
        `${PARAMS_SCHEMA_VERSION}, using defaults`,
    );
    return NO_OVERLAY;
  }
  const merged = mergeParams(DEFAULT_PARAMS, overlay);
  const result = validateParams(merged);
  if (!result.ok) {
    warn(`[BotParams] overlay ${label} invalid (${result.error}), using defaults`);
    return NO_OVERLAY;
  }
  const rawVersion = (raw as { version?: unknown }).version;
  const version = typeof rawVersion === 'string' && rawVersion.length > 0 ? rawVersion : null;
  return { present: true, version, params: deepFreeze(result.params) };
}

function interpretCalibration(
  raw: unknown,
  label: string,
  warn: (message: string) => void,
): CalibrationArtifact | null {
  try {
    if (typeof raw === 'string') {
      return parseCalibration(raw);
    }
    const result = validateCalibration(raw);
    if (!result.ok) {
      warn(`[BotParams] calibration ${label} invalid (${result.error}), ignoring`);
      return null;
    }
    return result.artifact;
  } catch (err) {
    warn(`[BotParams] calibration ${label} unreadable, ignoring: ${errText(err)}`);
    return null;
  }
}

/**
 * Load the effective params plus overlay metadata: defaults with the optional
 * overlay merged in. Lookup is explicit path, then {@link OVERLAY_PATH_ENV},
 * then store {@link OVERLAY_KEY}, then {@link DEFAULT_OVERLAY_PATH}. Any
 * failure — unreadable file, malformed JSON, wrong schema version, a
 * non-finite leaf after merge — logs a loud warning and reports
 * `present: false` with DEFAULT_PARAMS unchanged. With no overlay present,
 * reports `present: false` silently.
 */
export function loadOverlayInfo(options: LoadParamsOptions = {}): OverlayInfo {
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const readFile = options.readOverlay ?? defaultReadOverlay;

  for (const src of overlaySources(options, readFile)) {
    let raw: unknown;
    try {
      raw = src.read();
    } catch (err) {
      warn(`[BotParams] overlay ${src.label} unreadable, using defaults: ${errText(err)}`);
      return NO_OVERLAY;
    }
    if (raw === null || raw === undefined) continue;
    return interpretOverlay(raw, src.label, warn);
  }
  return NO_OVERLAY;
}

/**
 * Load a {@link CalibrationArtifact}: explicit path, then
 * {@link CALIBRATION_PATH_ENV}, then store {@link CALIBRATION_KEY}, else null.
 * Missing or invalid artifacts warn (when readable-but-bad) and return null.
 */
export function loadCalibrationInfo(options: LoadParamsOptions = {}): CalibrationArtifact | null {
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const readFile = options.readCalibration ?? options.readOverlay ?? defaultReadOverlay;

  for (const src of calibrationSources(options, readFile)) {
    let raw: unknown;
    try {
      raw = src.read();
    } catch (err) {
      warn(`[BotParams] calibration ${src.label} unreadable, ignoring: ${errText(err)}`);
      return null;
    }
    if (raw === null || raw === undefined) continue;
    return interpretCalibration(raw, src.label, warn);
  }
  return null;
}

/**
 * Load just the effective params (defaults with the optional overlay merged
 * in). A thin wrapper over {@link loadOverlayInfo} for callers that do not need
 * the presence/version metadata.
 */
export function loadParams(options: LoadParamsOptions = {}): BotParams {
  return loadOverlayInfo(options).params;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve the default overlay path from this module's location (params/../). */
function resolveDefaultOverlayPath(): string {
  // src/params.ts -> package root is one directory up from src.
  const here = new URL('.', import.meta.url);
  return new URL(`../${DEFAULT_OVERLAY_PATH}`, here).pathname;
}

/** Read + parse the overlay with node's fs; returns null when absent. */
function defaultReadOverlay(path: string): unknown {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}
