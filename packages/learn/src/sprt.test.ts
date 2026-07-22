/**
 * The SPRT primitive (fh-sja.5, shared with the arena fh-sja.3). Deterministic
 * given the outcome stream: a clearly-winning stream accepts H1, a clearly-
 * losing one accepts H0, and a coin-flip stream stays inconclusive over a
 * bounded budget (the no-regression pass condition).
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SPRT, runSprt, sprtInit, sprtObserve } from './sprt.js';

function stream(winRate: number, n: number): boolean[] {
  // Deterministic Bernoulli-ish stream: every 1/winRate-th outcome is a win.
  const out: boolean[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += winRate;
    if (acc >= 1) {
      out.push(true);
      acc -= 1;
    } else {
      out.push(false);
    }
  }
  return out;
}

describe('runSprt', () => {
  it('accepts H1 for a decisively winning stream', () => {
    const r = runSprt(stream(0.8, 500));
    expect(r.verdict).toBe('accept-h1');
    expect(r.winRate).toBeGreaterThan(0.5);
  });

  it('accepts H0 for a decisively losing stream', () => {
    const r = runSprt(stream(0.2, 500));
    expect(r.verdict).toBe('accept-h0');
  });

  it('stays inconclusive at exactly the boundary win-rate over a bounded budget', () => {
    // Between p0=0.5 and p1=0.55 the test needs many games; a short stream at
    // ~0.5 must not spuriously decide either way.
    const r = runSprt(stream(0.5, 40));
    expect(r.verdict).toBe('continue');
  });

  it('is deterministic: same stream -> same verdict', () => {
    const s = stream(0.75, 300);
    expect(runSprt(s)).toEqual(runSprt(s));
  });

  it('draws carry no information', () => {
    let st = sprtInit();
    st = sprtObserve(st, null);
    st = sprtObserve(st, null);
    expect(st).toEqual(sprtInit());
  });

  it('freezes once decided', () => {
    let st = sprtInit();
    for (const w of stream(0.9, 500)) st = sprtObserve(st, w);
    const decided = st;
    expect(decided.verdict).toBe('accept-h1');
    // Further observations do not move a decided test.
    expect(sprtObserve(decided, false)).toEqual(decided);
  });

  it('exposes the configured boundaries via the default config', () => {
    expect(DEFAULT_SPRT.p0).toBe(0.5);
    expect(DEFAULT_SPRT.p1).toBe(0.55);
  });
});
