/**
 * Server-side learned-overlay surface (fh-sja.6 / fh-azx.4). Loads the
 * overlay and calibration ONCE at process start: FH_OVERLAY_PATH /
 * FH_CALIBRATION_PATH, else store artifacts/overlay.json and
 * artifacts/calibration.json, else packages/bots/params/local.json for the
 * overlay (calibration has no checked-in default).
 *
 *   - the lobby (rooms.ts) reports {@link OVERLAY_VERSION} as the "learned vX"
 *     tag and defaults new rooms' `adaptiveBots` to {@link OVERLAY_PRESENT};
 *   - the Hard worker pool (workers/hardPool.ts) threads {@link overlayJson}
 *     into each Hard decision a room opted into;
 *   - {@link calibrationJson} is the boot-time blob for the sampler child.
 *
 * Missing or invalid artifacts stay at shipped defaults / null and never
 * crash boot. The load is loud-on-failure.
 */

import {
  loadCalibrationInfo,
  loadOverlayInfo,
  type LoadParamsOptions,
} from '@five-hundred/bots';
import {
  CALIBRATION_KEY,
  OVERLAY_KEY,
  createGameStore,
  type StoreEnv,
} from '@five-hundred/learn';

async function prefetchStore(
  env: StoreEnv,
): Promise<((key: string) => unknown) | undefined> {
  const store = createGameStore(env);
  if (store === null) return undefined;
  const cache = new Map<string, unknown>();
  const errors = new Map<string, unknown>();
  for (const key of [OVERLAY_KEY, CALIBRATION_KEY] as const) {
    try {
      cache.set(key, await store.getJson(key));
    } catch (err) {
      errors.set(key, err);
    }
  }
  return (key) => {
    if (errors.has(key)) throw errors.get(key);
    return cache.has(key) ? cache.get(key) : null;
  };
}

/** Assemble the process-global bot-param exports from already-loaded artifacts. */
export function loadServerBotParams(options: LoadParamsOptions = {}): {
  readonly OVERLAY_PRESENT: boolean;
  readonly OVERLAY_VERSION: string | null;
  readonly overlayJson: string | null;
  readonly calibrationJson: string | null;
} {
  const info = loadOverlayInfo(options);
  const calibration = loadCalibrationInfo(options);
  return {
    OVERLAY_PRESENT: info.present,
    OVERLAY_VERSION: info.version,
    overlayJson: info.present ? JSON.stringify(info.params) : null,
    calibrationJson: calibration === null ? null : JSON.stringify(calibration),
  };
}

const boot = loadServerBotParams({
  env: process.env,
  readStore: await prefetchStore(process.env),
});

/** True when a valid learned overlay was loaded (defaults otherwise). */
export const OVERLAY_PRESENT = boot.OVERLAY_PRESENT;

/** The learned overlay's version tag for the lobby, or null when absent. */
export const OVERLAY_VERSION: string | null = boot.OVERLAY_VERSION;

/**
 * The effective Hard params serialized for the worker request. Computed once
 * (the overlay is process-global). null when no overlay is present, so the
 * pool sends nothing and the worker builds its default HardPolicy.
 */
export const overlayJson: string | null = boot.overlayJson;

/** Serialized calibration artifact, or null when absent/invalid. */
export const calibrationJson: string | null = boot.calibrationJson;
