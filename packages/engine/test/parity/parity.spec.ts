/**
 * Parity gate over the committed 200-hand oracle fixture (fh-gty.2).
 *
 * AC-1: the fixture replays with zero divergence in the normal test run.
 * AC-3: corrupted trace lines fail with a diagnostic naming the hand index,
 *       phase, and expected vs actual values.
 *
 * The fixture (see fixtures/README.md for the exact regeneration command)
 * was seed-picked to cover every packet edge case: redeal-only auctions,
 * NULLA sit-outs, DNULLA pass-through, 16-card slam keeps, oracle bids the
 * TS engine scores as passes, and a joker led to a no-trump-type trick.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ParityError, replayTrace } from './replay.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/trace-stress-s19-200.jsonl', import.meta.url));

function fixtureLines(): string[] {
  return readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l !== '');
}

/** Corrupt the first line matching `match` and return the mutated trace. */
function corrupt(lines: string[], match: RegExp, edit: (line: string) => string): string[] {
  const i = lines.findIndex((l) => match.test(l));
  expect(i).toBeGreaterThanOrEqual(0);
  return [...lines.slice(0, i), edit(lines[i] as string), ...lines.slice(i + 1)];
}

describe('parity fixture (AC-1)', () => {
  it('replays all 200 hands with zero divergence', async () => {
    const stats = await replayTrace(fixtureLines());
    expect(stats.hands).toBe(200);
    expect(stats.handResults).toBe(200);
    expect(stats.tricks).toBe(200 * 10);
    expect(stats.plays).toBeGreaterThan(200 * 30); // 3-handed tricks exist
    expect(stats.lines).toBe(fixtureLines().length);
  });

  it('covers every packet edge case', () => {
    const text = fixtureLines().join('\n');
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    expect(count(/"redeal":true/g)).toBe(591);
    expect(count(/"type":"auction_result".*?"kind":"NULLA"/g)).toBe(77);
    expect(count(/"type":"auction_result".*?"kind":"DNULLA"/g)).toBe(61);
    expect(count(/"type":"exchange".*?"slam":true/g)).toBe(17);
    expect(count(/"named_suit":[0-9]/g)).toBe(1);
  });
});

describe('divergence diagnostics (AC-3)', () => {
  it('a corrupted trick winner names hand, phase, and expected vs actual', async () => {
    const lines = corrupt(fixtureLines(), /"type":"trick_winner"/, (l) => {
      const rec = JSON.parse(l) as { winner: number };
      rec.winner = (rec.winner + 1) % 4;
      return JSON.stringify(rec);
    });
    const err = await replayTrace(lines).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ParityError);
    const parity = err as ParityError;
    expect(parity.message).toMatch(/hand \d+/);
    expect(parity.message).toMatch(/phase play/);
    expect(parity.message).toMatch(/trick winner expected=\d actual=\d/);
    expect(parity.hand).toBeGreaterThanOrEqual(0);
    expect(parity.expected).not.toBe(parity.actual);
  });

  it('a corrupted legal-play set is caught before the card is played', async () => {
    const lines = corrupt(fixtureLines(), /"type":"play".*"legal":\[\d+,/, (l) => {
      const rec = JSON.parse(l) as { legal: number[] };
      rec.legal = rec.legal.slice(1); // drop one recorded legal card
      return JSON.stringify(rec);
    });
    await expect(replayTrace(lines)).rejects.toThrow(/legal plays expected=\[.*\] actual=\[.*\]/);
  });

  it('a corrupted hand delta names the scoring divergence', async () => {
    const lines = corrupt(fixtureLines(), /"type":"hand_result"/, (l) => {
      const rec = JSON.parse(l) as { declarer_delta: number };
      rec.declarer_delta += 10;
      return JSON.stringify(rec);
    });
    await expect(replayTrace(lines)).rejects.toThrow(
      /hand \d+ .*declarer delta expected=-?\d+ actual=-?\d+/,
    );
  });
});
