/**
 * Entrypoint for `pnpm learn:ab-bower`. Logic lives in ab-bower.ts so tests
 * can parse flags without launching a match.
 */
import { runAbBower } from './ab-bower.js';

runAbBower(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
