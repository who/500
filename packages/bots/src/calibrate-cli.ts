/**
 * Thin entrypoint for the play-log calibrator (fh-azx.3): `pnpm learn:calibrate`.
 * All the logic lives in calibrate.ts (and is unit-tested there); this file
 * only parses process argv and runs it, so importing calibrate.ts never
 * launches a calibration run.
 */
import { runCalibrate } from './calibrate.js';

runCalibrate(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
