/**
 * Hard-bot rollout card play + HardPolicy assembly — the bots-side
 * acceptance criteria of fh-7hw.4:
 *
 *   AC-1  Budget respected: across a seeded 50-decision run over real
 *         mid-play states, every decision returns within deadlineMs + 100ms
 *         slack (and always a legal card).
 *
 * Plus the packet's edge cases and invariants: one-legal-card turns return
 * instantly without sampling or clock reads, fixed-world mode never touches
 * the clock at all (headless determinism), identical (state, seed, worlds)
 * pick the identical card, a busted budget falls back to Medium's choice and
 * reports it, and the assembled HardPolicy drives full hands through the
 * headless sim harness via the StateAwarePolicy seam.
 */

import { describe, expect, it } from 'vitest';
import type { Card, GameState } from '@five-hundred/engine';
import {
  PASS,
  applyAction,
  bid,
  legalPlaysFor,
  makeRng,
  newGame,
  toActSeat,
} from '@five-hundred/engine';
import type { HardPlayDecision } from '../src/index.js';
import {
  HardPolicy,
  MediumPolicy,
  botAction,
  choosePlayByRollout,
  hasStatePlay,
  simulateHands,
} from '../src/index.js';

interface PlayDecision {
  readonly state: GameState;
  readonly seat: number;
  readonly legal: readonly Card[];
}

/**
 * Walk seeded Medium-vs-Medium games and capture play-phase decision points
 * (fresh games chain on gameOver so any `want` is reachable).
 */
function collectDecisions(
  seed: number,
  want: number,
  filter: (legal: readonly Card[]) => boolean,
): PlayDecision[] {
  const rng = makeRng(seed);
  const medium = new MediumPolicy();
  const policies = [medium, medium, medium, medium];
  const out: PlayDecision[] = [];
  let game = 0;
  let state = newGame(seed);
  for (let guard = 0; out.length < want; guard++) {
    if (guard > 200_000) throw new Error('not enough play decisions in the seeded walk');
    if (state.phase === 'gameOver') {
      state = newGame(seed + ++game);
      continue;
    }
    if (state.phase === 'play') {
      const seat = toActSeat(state);
      if (seat === null || state.play === null) throw new Error('play without an actor');
      const legal = legalPlaysFor(state.play, seat);
      if (filter(legal)) out.push({ state, seat, legal });
    }
    const action = botAction(state, policies, rng);
    let result = applyAction(state, action);
    if (!result.ok && state.phase === 'auction' && action.type === 'bid') {
      result = applyAction(state, { type: 'bid', seat: action.seat, bid: bid(PASS) });
    }
    if (!result.ok) throw new Error(`walk stalled: ${result.error.message}`);
    state = result.state;
  }
  return out;
}

const neverClock = (): number => {
  throw new Error('the clock must not be consulted');
};

describe('choosePlayByRollout', () => {
  it('AC-1: a seeded 50-decision run stays within the budget (+100ms slack)', () => {
    const budget = 60;
    const decisions = collectDecisions(0xac1, 50, (legal) => legal.length > 1);
    const rng = makeRng(0xac1);
    let fallbacks = 0;
    for (const { state, seat, legal } of decisions) {
      const t0 = Date.now();
      const card = choosePlayByRollout(state, seat, rng, {
        deadlineMs: budget,
        onDecision: (d: HardPlayDecision) => {
          if (d.fellBack) fallbacks++;
        },
      });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThanOrEqual(budget + 100);
      expect(legal).toContain(card);
    }
    // The budget shortfall path is allowed but must stay the exception.
    expect(fallbacks).toBeLessThan(decisions.length);
  }, 60_000);

  it('returns the only legal card instantly, sampling nothing', () => {
    const [decision] = collectDecisions(0x0e11, 1, (legal) => legal.length === 1);
    if (decision === undefined) throw new Error('no forced-card decision found');
    // A throwing clock proves the shortcut fires before any budget handling.
    const card = choosePlayByRollout(decision.state, decision.seat, makeRng(1), {
      deadlineMs: 1000,
      now: neverClock,
    });
    expect(card).toBe(decision.legal[0]);
  });

  it('fixed-world mode is clock-free and deterministic', () => {
    const [decision] = collectDecisions(0xd0d0, 1, (legal) => legal.length > 2);
    if (decision === undefined) throw new Error('no multi-card decision found');
    const pick = (): Card =>
      choosePlayByRollout(decision.state, decision.seat, makeRng(42), {
        worlds: 5,
        now: neverClock,
      });
    const first = pick();
    expect(decision.legal).toContain(first);
    expect(pick()).toBe(first);
  });

  it('falls back to the Medium choice when the budget cannot fit the floor', () => {
    const [decision] = collectDecisions(0xfa11, 1, (legal) => legal.length > 2);
    if (decision === undefined) throw new Error('no multi-card decision found');
    const { state, seat, legal } = decision;
    const play = state.play;
    if (play === null || state.contract === null) throw new Error('not in play');
    const reports: HardPlayDecision[] = [];
    const card = choosePlayByRollout(state, seat, makeRng(7), {
      deadlineMs: 0,
      onDecision: (d) => reports.push(d),
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ seat, worldsDone: 0, fellBack: true });
    const medium = new MediumPolicy().choosePlay(
      seat,
      play.hands[seat] ?? [],
      legal,
      play.plays,
      play.trump,
      play.ledSuit,
      state.contract,
    );
    expect(card).toBe(medium);
  });
});

describe('HardPolicy', () => {
  it('exposes the state-aware play seam (and Medium does not)', () => {
    expect(hasStatePlay(new HardPolicy())).toBe(true);
    expect(hasStatePlay(new MediumPolicy())).toBe(false);
  });

  it('plays full hands through the headless sim harness, worker-free', () => {
    const hard = new HardPolicy({ bidWorlds: 2, keepWorlds: 2, play: { worlds: 2 } });
    const medium = new MediumPolicy();
    const stats = simulateHands(2, [hard, medium, medium, medium], 0x5eed);
    const hands = Object.values(stats).reduce((n, s) => n + s.n, 0);
    expect(hands).toBe(2);
  }, 30_000);
});
