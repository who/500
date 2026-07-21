/**
 * Full-scale parity CLI (AC-2): stream a trace_500.py .jsonl file through
 * the replayer and report zero divergence or the first ParityError.
 *
 *   python trace_500.py --seed 7 --hands 10000 > /tmp/t.jsonl
 *   pnpm --filter @five-hundred/engine parity /tmp/t.jsonl
 *
 * Exit codes: 0 zero divergence, 1 divergence, 2 usage/IO error.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { ParityError, replayTrace } from './replay.js';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: pnpm --filter @five-hundred/engine parity <trace.jsonl>');
  process.exit(2);
}

const lines = createInterface({
  input: createReadStream(path, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

try {
  const stats = await replayTrace(lines);
  console.log(
    `parity OK: zero divergence over ${stats.hands} hands ` +
      `(${stats.deals} deals, ${stats.redeals} redeals, ` +
      `${stats.auctionActions} auction actions, ${stats.exchanges} exchanges, ` +
      `${stats.plays} plays, ${stats.tricks} tricks, ` +
      `${stats.handResults} hand results, ${stats.lines} trace lines)`,
  );
} catch (err) {
  if (err instanceof ParityError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(String(err));
  process.exit(2);
}
