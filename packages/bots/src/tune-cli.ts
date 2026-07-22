/**
 * Thin entrypoint for the self-play tuner (fh-sja.4): `pnpm learn:tune`. All
 * the logic lives in tune.ts (and is unit-tested there); this file only parses
 * process argv and runs it, so importing tune.ts never launches a tuning run.
 */
import { runTune } from './tune.js';

runTune(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
