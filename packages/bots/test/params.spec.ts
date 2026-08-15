/**
 * BotParams loader/merge/validation specs (fh-sja.1 AC-2): the overlay is
 * deep-merged over the checked-in defaults and validated, and any malformed or
 * version-incompatible overlay falls back loudly to DEFAULT_PARAMS. Also pins
 * default.json against the constants the bots re-export, so the AC-1
 * byte-identity guarantee cannot silently drift (a default.json edit that
 * changes a value fails these).
 *
 * fh-azx.4 extends the loader with FH_OVERLAY_PATH / FH_CALIBRATION_PATH and
 * an injected store reader; AC-1..AC-3 live in the lookup-rung block below.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CALIBRATION_KEY,
  CALIBRATION_SCHEMA_VERSION,
  DEFAULT_STRENGTH_WEIGHTS,
  OVERLAY_KEY,
} from '@five-hundred/learn';
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
  loadCalibrationInfo,
  loadOverlayInfo,
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

describe('loadOverlayInfo (fh-sja.6 overlay metadata)', () => {
  it('reports absence when there is no overlay', () => {
    const warn = vi.fn();
    const info = loadOverlayInfo({ readOverlay: () => null, warn });
    expect(info.present).toBe(false);
    expect(info.version).toBeNull();
    expect(info.params).toBe(DEFAULT_PARAMS);
    expect(warn).not.toHaveBeenCalled();
  });

  it('surfaces the overlay version and merged params when present', () => {
    const info = loadOverlayInfo({
      readOverlay: () => ({
        schemaVersion: PARAMS_SCHEMA_VERSION,
        version: '1.deadbeef',
        hardBidding: { bidMargin: 3 },
      }),
    });
    expect(info.present).toBe(true);
    expect(info.version).toBe('1.deadbeef');
    expect(info.params.hardBidding.bidMargin).toBe(3);
  });

  it('reports present with a null version when the overlay omits one', () => {
    const info = loadOverlayInfo({
      readOverlay: () => ({ schemaVersion: PARAMS_SCHEMA_VERSION, hardBidding: { bidMargin: 3 } }),
    });
    expect(info.present).toBe(true);
    expect(info.version).toBeNull();
  });

  it('reports absence (never a version) when the overlay is invalid', () => {
    const warn = vi.fn();
    const info = loadOverlayInfo({
      readOverlay: () => ({ schemaVersion: 999, version: 'x', hardBidding: { bidMargin: 3 } }),
      warn,
    });
    expect(info.present).toBe(false);
    expect(info.version).toBeNull();
    expect(info.params).toBe(DEFAULT_PARAMS);
    expect(warn).toHaveBeenCalledOnce();
  });
});

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'fh-azx4-'));
}

function validOverlay(version: string) {
  return {
    schemaVersion: PARAMS_SCHEMA_VERSION,
    version,
    bidding: { headroom: 8 },
  };
}

function validCalibration() {
  return {
    v: CALIBRATION_SCHEMA_VERSION,
    weights: DEFAULT_STRENGTH_WEIGHTS,
    minSamples: 30,
    shrinkage: 20,
    make: { cells: {} },
    priors: { histograms: {}, bucketWidth: 0.5 },
    meta: { games: 0, hands: 0, makeSamples: 0, priorSamples: 0 },
  };
}

describe('loadOverlayInfo path/store rungs (fh-azx.4)', () => {
  it('AC-1: FH_OVERLAY_PATH at a valid overlay reports present with that version', () => {
    const dir = scratchDir();
    try {
      const path = join(dir, 'overlay.json');
      writeFileSync(path, JSON.stringify(validOverlay('1.ac1')));
      const info = loadOverlayInfo({ env: { FH_OVERLAY_PATH: path }, warn: vi.fn() });
      expect(info.present).toBe(true);
      expect(info.version).toBe('1.ac1');
      expect(info.params.bidding.headroom).toBe(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC-2: invalid overlay JSON at FH_OVERLAY_PATH yields present false and defaults', () => {
    const dir = scratchDir();
    try {
      const path = join(dir, 'bad.json');
      writeFileSync(path, '{not json');
      const warn = vi.fn();
      const info = loadOverlayInfo({ env: { FH_OVERLAY_PATH: path }, warn });
      expect(info.present).toBe(false);
      expect(info.params).toBe(DEFAULT_PARAMS);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain('unreadable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC-2: schemaVersion mismatch at FH_OVERLAY_PATH yields present false and defaults', () => {
    const dir = scratchDir();
    try {
      const path = join(dir, 'mismatch.json');
      writeFileSync(
        path,
        JSON.stringify({ ...validOverlay('1.nope'), schemaVersion: PARAMS_SCHEMA_VERSION + 1 }),
      );
      const warn = vi.fn();
      const info = loadOverlayInfo({ env: { FH_OVERLAY_PATH: path }, warn });
      expect(info.present).toBe(false);
      expect(info.params).toBe(DEFAULT_PARAMS);
      expect(warn.mock.calls[0]?.[0]).toContain('schemaVersion');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not fall through to store when FH_OVERLAY_PATH is set to a missing file', () => {
    const info = loadOverlayInfo({
      env: { FH_OVERLAY_PATH: join(tmpdir(), 'fh-azx4-missing-overlay.json') },
      readStore: () => validOverlay('1.store'),
      warn: vi.fn(),
    });
    expect(info.present).toBe(false);
    expect(info.params).toBe(DEFAULT_PARAMS);
  });

  it('uses the store overlay when path env is unset', () => {
    const info = loadOverlayInfo({
      env: {},
      readStore: (key) => (key === OVERLAY_KEY ? validOverlay('1.store') : null),
      readOverlay: () => null,
      warn: vi.fn(),
    });
    expect(info.present).toBe(true);
    expect(info.version).toBe('1.store');
  });

  it('falls through to the default overlay path when the store returns null', () => {
    const info = loadOverlayInfo({
      env: {},
      readStore: () => null,
      readOverlay: () => validOverlay('1.local'),
      warn: vi.fn(),
    });
    expect(info.present).toBe(true);
    expect(info.version).toBe('1.local');
  });

  it('lets overlayPath override FH_OVERLAY_PATH', () => {
    const dir = scratchDir();
    try {
      const envPath = join(dir, 'env.json');
      const overridePath = join(dir, 'override.json');
      writeFileSync(envPath, JSON.stringify(validOverlay('1.env')));
      writeFileSync(overridePath, JSON.stringify(validOverlay('1.override')));
      const info = loadOverlayInfo({
        env: { FH_OVERLAY_PATH: envPath },
        overlayPath: overridePath,
        warn: vi.fn(),
      });
      expect(info.version).toBe('1.override');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadCalibrationInfo (fh-azx.4)', () => {
  it('AC-3: returns a parsed artifact from a valid file', () => {
    const dir = scratchDir();
    try {
      const path = join(dir, 'calibration.json');
      const artifact = validCalibration();
      writeFileSync(path, JSON.stringify(artifact));
      const loaded = loadCalibrationInfo({ env: { FH_CALIBRATION_PATH: path }, warn: vi.fn() });
      expect(loaded).toEqual(artifact);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC-3: returns null from a missing file', () => {
    const loaded = loadCalibrationInfo({
      env: { FH_CALIBRATION_PATH: join(tmpdir(), 'fh-azx4-missing-calibration.json') },
      warn: vi.fn(),
    });
    expect(loaded).toBeNull();
  });

  it('returns null and warns when the artifact schema version mismatches', () => {
    const warn = vi.fn();
    const loaded = loadCalibrationInfo({
      env: {},
      calibrationPath: 'injected.json',
      readCalibration: () => ({ ...validCalibration(), v: CALIBRATION_SCHEMA_VERSION + 1 }),
      warn,
    });
    expect(loaded).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toContain('invalid');
  });

  it('uses the store artifact when path env is unset', () => {
    const artifact = validCalibration();
    const loaded = loadCalibrationInfo({
      env: {},
      readStore: (key) => (key === CALIBRATION_KEY ? artifact : null),
      warn: vi.fn(),
    });
    expect(loaded).toEqual(artifact);
  });

  it('returns null when the store has no calibration (no default file)', () => {
    const loaded = loadCalibrationInfo({
      env: {},
      readStore: () => null,
      readOverlay: () => validCalibration(),
      warn: vi.fn(),
    });
    expect(loaded).toBeNull();
  });
});
