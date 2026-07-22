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

export interface LoadParamsOptions {
  /**
   * Overlay file path; defaults to {@link DEFAULT_OVERLAY_PATH} resolved from
   * this package's root. Pass an absolute path in callers with a different cwd.
   */
  readonly overlayPath?: string;
  /** Reads and JSON-parses the overlay; returns null when it does not exist. */
  readonly readOverlay?: (path: string) => unknown;
  /** Loud warning sink (defaults to console.warn), so tests can capture it. */
  readonly warn?: (message: string) => void;
}

/**
 * Load the effective params: defaults with the optional overlay merged in. Any
 * failure — unreadable file, malformed JSON, wrong schema version, a non-finite
 * leaf after merge — logs a loud warning and returns DEFAULT_PARAMS unchanged.
 * With no overlay present, returns DEFAULT_PARAMS silently.
 */
export function loadParams(options: LoadParamsOptions = {}): BotParams {
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const path = options.overlayPath ?? resolveDefaultOverlayPath();
  const read = options.readOverlay ?? defaultReadOverlay;

  let raw: unknown;
  try {
    raw = read(path);
  } catch (err) {
    warn(`[BotParams] overlay ${path} unreadable, using defaults: ${errText(err)}`);
    return DEFAULT_PARAMS;
  }
  if (raw === null || raw === undefined) return DEFAULT_PARAMS; // no overlay: defaults

  if (typeof raw !== 'object') {
    warn(`[BotParams] overlay ${path} is not an object, using defaults`);
    return DEFAULT_PARAMS;
  }
  const overlay = raw as PartialBotParams;
  // A version mismatch on the overlay is a hard reject: we will not merge a
  // shape we may not understand.
  if (overlay.schemaVersion !== undefined && overlay.schemaVersion !== PARAMS_SCHEMA_VERSION) {
    warn(
      `[BotParams] overlay ${path} schemaVersion ${String(overlay.schemaVersion)} != ` +
        `${PARAMS_SCHEMA_VERSION}, using defaults`,
    );
    return DEFAULT_PARAMS;
  }
  const merged = mergeParams(DEFAULT_PARAMS, overlay);
  const result = validateParams(merged);
  if (!result.ok) {
    warn(`[BotParams] overlay ${path} invalid (${result.error}), using defaults`);
    return DEFAULT_PARAMS;
  }
  return deepFreeze(result.params);
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
