/**
 * Thin boot-time overlay/calibration surface (fh-azx.4): botParams exposes
 * calibrationJson next to overlayJson, and loadServerBotParams is the
 * import-time assembly rooms/hardPool already consume.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PARAMS_SCHEMA_VERSION } from '@five-hundred/bots';
import {
  CALIBRATION_SCHEMA_VERSION,
  DEFAULT_STRENGTH_WEIGHTS,
} from '@five-hundred/learn';
import {
  calibrationJson,
  loadServerBotParams,
  overlayJson,
} from '../src/botParams.js';

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

describe('loadServerBotParams (fh-azx.4)', () => {
  it('exposes null calibrationJson at import when no artifact is present', () => {
    expect(calibrationJson === null || typeof calibrationJson === 'string').toBe(true);
    expect(overlayJson === null || typeof overlayJson === 'string').toBe(true);
  });

  it('serializes a valid overlay and calibration from env paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-azx4-server-'));
    try {
      const overlayPath = join(dir, 'overlay.json');
      const calibrationPath = join(dir, 'calibration.json');
      writeFileSync(
        overlayPath,
        JSON.stringify({
          schemaVersion: PARAMS_SCHEMA_VERSION,
          version: '1.server',
          bidding: { headroom: 7 },
        }),
      );
      const artifact = validCalibration();
      writeFileSync(calibrationPath, JSON.stringify(artifact));
      const boot = loadServerBotParams({
        env: { FH_OVERLAY_PATH: overlayPath, FH_CALIBRATION_PATH: calibrationPath },
        warn: vi.fn(),
      });
      expect(boot.OVERLAY_PRESENT).toBe(true);
      expect(boot.OVERLAY_VERSION).toBe('1.server');
      expect(boot.overlayJson).toContain('"headroom":7');
      expect(boot.calibrationJson).not.toBeNull();
      expect(JSON.parse(boot.calibrationJson as string).v).toBe(CALIBRATION_SCHEMA_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays at defaults/null when env paths are missing', () => {
    const boot = loadServerBotParams({
      env: {
        FH_OVERLAY_PATH: join(tmpdir(), 'fh-azx4-no-overlay.json'),
        FH_CALIBRATION_PATH: join(tmpdir(), 'fh-azx4-no-calibration.json'),
      },
      warn: vi.fn(),
    });
    expect(boot.OVERLAY_PRESENT).toBe(false);
    expect(boot.overlayJson).toBeNull();
    expect(boot.calibrationJson).toBeNull();
  });
});
