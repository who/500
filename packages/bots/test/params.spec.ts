/**
 * BotParams loader/merge/validation specs (fh-sja.1 AC-2): the overlay is
 * deep-merged over the checked-in defaults and validated, and any malformed or
 * version-incompatible overlay falls back loudly to DEFAULT_PARAMS. Also pins
 * default.json against the constants the bots re-export, so the AC-1
 * byte-identity guarantee cannot silently drift (a default.json edit that
 * changes a value fails these).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BID_HEADROOM,
  BID_MARGIN,
  CHEAPEST_CONTRACT,
  DEFAULT_OVERLAY_PATH,
  DEFAULT_PARAMS,
  DESPERATE_HEADROOM,
  DESPERATE_SCORE,
  ENDGAME_HEADROOM,
  INDICATE_EST,
  KEEP_WORLDS,
  MAX_CANDIDATES,
  PARAMS_SCHEMA_VERSION,
  PARTNER_INDICATION_BONUS,
  PLAY_WORLDS_CAP,
  PLAY_WORLDS_FLOOR,
  ROLLOUT_WORLDS,
  SLAM_MARGIN,
  loadParams,
  mergeParams,
  validateParams,
} from '../src/index.js';

describe('DEFAULT_PARAMS (AC-1 anchor)', () => {
  it('carries the current schema version', () => {
    expect(DEFAULT_PARAMS.schemaVersion).toBe(PARAMS_SCHEMA_VERSION);
  });

  it('reproduces the re-exported Medium constants byte-for-byte', () => {
    expect(DEFAULT_PARAMS.bidding.headroom).toBe(BID_HEADROOM);
    expect(DEFAULT_PARAMS.bidding.indicateEst).toBe(INDICATE_EST);
    expect(DEFAULT_PARAMS.bidding.partnerIndicationBonus).toBe(PARTNER_INDICATION_BONUS);
    expect(DEFAULT_PARAMS.endgame.cheapestContract).toBe(CHEAPEST_CONTRACT);
    expect(DEFAULT_PARAMS.endgame.headroom).toBe(ENDGAME_HEADROOM);
    expect(DEFAULT_PARAMS.endgame.desperateHeadroom).toBe(DESPERATE_HEADROOM);
    expect(DEFAULT_PARAMS.endgame.desperateScore).toBe(DESPERATE_SCORE);
  });

  it('reproduces the re-exported Hard constants byte-for-byte', () => {
    expect(DEFAULT_PARAMS.hardBidding.rolloutWorlds).toBe(ROLLOUT_WORLDS);
    expect(DEFAULT_PARAMS.hardBidding.bidMargin).toBe(BID_MARGIN);
    expect(DEFAULT_PARAMS.hardBidding.slamMargin).toBe(SLAM_MARGIN);
    expect(DEFAULT_PARAMS.hardKeeps.keepWorlds).toBe(KEEP_WORLDS);
    expect(DEFAULT_PARAMS.hardKeeps.maxCandidates).toBe(MAX_CANDIDATES);
    expect(DEFAULT_PARAMS.hardPlay.worldsFloor).toBe(PLAY_WORLDS_FLOOR);
    expect(DEFAULT_PARAMS.hardPlay.worldsCap).toBe(PLAY_WORLDS_CAP);
  });

  it('is frozen so a policy cannot mutate the shared object', () => {
    expect(Object.isFrozen(DEFAULT_PARAMS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PARAMS.suitStrength)).toBe(true);
  });
});

describe('mergeParams', () => {
  it('overrides only the supplied leaves', () => {
    const merged = mergeParams(DEFAULT_PARAMS, { bidding: { headroom: 9 } });
    expect(merged.bidding.headroom).toBe(9);
    // Sibling leaves and other groups are untouched.
    expect(merged.bidding.indicateEst).toBe(DEFAULT_PARAMS.bidding.indicateEst);
    expect(merged.suitStrength).toEqual(DEFAULT_PARAMS.suitStrength);
  });

  it('ignores unknown keys in the overlay', () => {
    const merged = mergeParams(DEFAULT_PARAMS, {
      // @ts-expect-error unknown leaf is deliberately not in the schema
      bidding: { headroom: 5, madeUpKnob: 42 },
    });
    expect(merged.bidding.headroom).toBe(5);
    expect((merged.bidding as Record<string, unknown>).madeUpKnob).toBeUndefined();
  });

  it('does not mutate the base', () => {
    mergeParams(DEFAULT_PARAMS, { slam: { est: 1 } });
    expect(DEFAULT_PARAMS.slam.est).not.toBe(1);
  });
});

describe('validateParams', () => {
  it('accepts the defaults', () => {
    const r = validateParams(DEFAULT_PARAMS);
    expect(r.ok).toBe(true);
  });

  it('rejects a wrong schema version', () => {
    const r = validateParams({ ...DEFAULT_PARAMS, schemaVersion: 999 });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-finite leaf', () => {
    const bad = mergeParams(DEFAULT_PARAMS, {}) as { suitStrength: { joker: number } };
    bad.suitStrength.joker = Number.NaN;
    const r = validateParams(bad);
    expect(r.ok).toBe(false);
  });

  it('rejects a missing group', () => {
    const bad: Record<string, unknown> = { ...DEFAULT_PARAMS };
    delete bad.hardPlay;
    const r = validateParams(bad);
    expect(r.ok).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(validateParams(null).ok).toBe(false);
    expect(validateParams(42).ok).toBe(false);
  });
});

describe('loadParams', () => {
  it('returns the defaults when no overlay exists', () => {
    const warn = vi.fn();
    const params = loadParams({ readOverlay: () => null, warn });
    expect(params).toBe(DEFAULT_PARAMS);
    expect(warn).not.toHaveBeenCalled();
  });

  it('deep-merges a valid overlay', () => {
    const warn = vi.fn();
    const params = loadParams({
      readOverlay: () => ({ hardBidding: { bidMargin: 3 } }),
      warn,
    });
    expect(params.hardBidding.bidMargin).toBe(3);
    expect(params.bidding.headroom).toBe(DEFAULT_PARAMS.bidding.headroom);
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts an overlay that carries the matching schema version', () => {
    const params = loadParams({
      readOverlay: () => ({ schemaVersion: PARAMS_SCHEMA_VERSION, slam: { est: 6 } }),
      warn: vi.fn(),
    });
    expect(params.slam.est).toBe(6);
  });

  it('rejects an overlay with a mismatched schema version, loudly', () => {
    const warn = vi.fn();
    const params = loadParams({
      readOverlay: () => ({ schemaVersion: PARAMS_SCHEMA_VERSION + 1, slam: { est: 6 } }),
      warn,
    });
    expect(params).toBe(DEFAULT_PARAMS);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('schemaVersion');
  });

  it('falls back loudly when the overlay is unreadable', () => {
    const warn = vi.fn();
    const params = loadParams({
      readOverlay: () => {
        throw new Error('EACCES');
      },
      warn,
    });
    expect(params).toBe(DEFAULT_PARAMS);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('unreadable');
  });

  it('drops a non-numeric leaf silently, keeping the default value', () => {
    const warn = vi.fn();
    const params = loadParams({
      readOverlay: () => ({ bidding: { headroom: 'lots' } }),
      warn,
    });
    // A string leaf is not copied by the merge (only numbers are), so the value
    // stays the default and the merged object is still valid — no warning.
    expect(params.bidding.headroom).toBe(DEFAULT_PARAMS.bidding.headroom);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back loudly when a merged leaf is a non-finite number (NaN/Infinity)', () => {
    const warn = vi.fn();
    // NaN is a number, so it survives the merge and only validation catches it.
    const params = loadParams({
      readOverlay: () => ({ bidding: { headroom: Number.NaN } }),
      warn,
    });
    expect(params).toBe(DEFAULT_PARAMS);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('invalid');
  });

  it('falls back loudly when the overlay is not an object', () => {
    const warn = vi.fn();
    const params = loadParams({ readOverlay: () => 'garbage', warn });
    expect(params).toBe(DEFAULT_PARAMS);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('exposes a git-ignored default overlay path under params/', () => {
    expect(DEFAULT_OVERLAY_PATH).toBe('params/local.json');
  });
});
