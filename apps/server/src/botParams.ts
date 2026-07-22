/**
 * Server-side learned-overlay surface (fh-sja.6). The self-play tuner
 * (fh-sja.4) writes a git-ignored BotParams overlay to
 * packages/bots/params/local.json; this module loads it ONCE at process start
 * and exposes it to the two consumers that surface learning in the product:
 *
 *   - the lobby (rooms.ts) reports {@link OVERLAY_VERSION} as the "learned vX"
 *     tag and defaults new rooms' `adaptiveBots` to {@link OVERLAY_PRESENT};
 *   - the Hard worker pool (workers/hardPool.ts) threads {@link overlayJson}
 *     into each Hard decision a room opted into.
 *
 * With no overlay present, everything below is inert: OVERLAY_PRESENT is false,
 * the version is null, and Hard seats run the checked-in DEFAULT_PARAMS exactly
 * as they did before this leaf. The load is loud-on-failure (loadOverlayInfo
 * warns and falls back to defaults), so a corrupt artifact never breaks the
 * server — it just ships the shipped bot.
 */

import { loadOverlayInfo } from '@five-hundred/bots';

const info = loadOverlayInfo();

/** True when a valid learned overlay was loaded (defaults otherwise). */
export const OVERLAY_PRESENT = info.present;

/** The learned overlay's version tag for the lobby, or null when absent. */
export const OVERLAY_VERSION: string | null = info.version;

/**
 * The effective Hard params serialized for the worker request. Computed once
 * (the overlay is process-global). null when no overlay is present, so the
 * pool sends nothing and the worker builds its default HardPolicy.
 */
export const overlayJson: string | null = OVERLAY_PRESENT ? JSON.stringify(info.params) : null;
