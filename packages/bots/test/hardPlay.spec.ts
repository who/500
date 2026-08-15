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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Action, Bid, Card, GameState } from '@five-hundred/engine';
import {
  JOKER,
  NULLA,
  NUM,
  PASS,
  applyAction,
  bid,
  cardSuit,
  initHandFromDeal,
  legalPlaysFor,
  makeCard,
  makeRng,
  newGame,
  toActSeat,
} from '@five-hundred/engine';
import { pickCard, sideDeltaFor, trickBonus, type RolloutTally } from '../src/hard/play.js';
import type { BotParams, HardPlayDecision } from '../src/index.js';
import {
  DEFAULT_PARAMS,
  HardPolicy,
  MediumPolicy,
  botAction,
  choosePlayByRollout,
  hasStatePlay,
  mergeParams,
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

  it('with no artifact, an explicit undefined calibration stays on the uniform path', () => {
    const [decision] = collectDecisions(0xd0d0, 1, (legal) => legal.length > 2);
    if (decision === undefined) throw new Error('no multi-card decision found');
    const pick = (calibration?: undefined) =>
      choosePlayByRollout(decision.state, decision.seat, makeRng(42), {
        worlds: 5,
        now: neverClock,
        calibration,
      });
    expect(pick(undefined)).toBe(pick());
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
      { declarer: play.declarer, tricks: play.tricks },
    );
    expect(card).toBe(medium);
  });

  // fh-8jf.3 AC-2: the rollout plays out SAMPLED worlds, where full
  // information is that world's truth rather than clairvoyance, so no
  // simulator seat is given a memory. The memory curve lives entirely in
  // params.hardMemory, so rewriting it to the most brutal setting there is
  // must leave the decision bit-identical — if a simulator seat ever picked up
  // a memory, this is the test that would catch it.
  it('AC-2: the memory curve does not reach the rollout simulator (fh-8jf.3)', () => {
    const [decision] = collectDecisions(0xd0d0, 1, (legal) => legal.length > 2);
    if (decision === undefined) throw new Error('no multi-card decision found');
    const forgetful = mergeParams(DEFAULT_PARAMS, {
      hardMemory: { permanentSalience: 99, baseHorizon: 0, salienceHorizon: 0, jitter: 0 },
    });
    const pick = (params: BotParams): Card =>
      choosePlayByRollout(decision.state, decision.seat, makeRng(42), {
        worlds: 5,
        now: neverClock,
        params,
      });
    expect(pick(forgetful)).toBe(pick(DEFAULT_PARAMS));
  });

  // fh-8jf.2: with a memory the seat derives its worlds through the
  // forgetting curve, so a card it has forgotten can be dealt back into a
  // hidden hand. A curve that forgets NOTHING must therefore leave the
  // decision exactly where perfect recall left it — memory changes the play
  // only through the curve, never through the wiring.
  it('AC-4: memory with a total-recall curve is identical to no memory', () => {
    const [decision] = collectDecisions(0xd0d0, 1, (legal) => legal.length > 2);
    if (decision === undefined) throw new Error('no multi-card decision found');
    const totalRecall = mergeParams(DEFAULT_PARAMS, {
      hardMemory: { permanentSalience: 0, voidHorizon: 999 },
    });
    const bare = choosePlayByRollout(decision.state, decision.seat, makeRng(42), {
      worlds: 5,
      now: neverClock,
    });
    const remembered = choosePlayByRollout(decision.state, decision.seat, makeRng(42), {
      worlds: 5,
      now: neverClock,
      params: totalRecall,
      memory: { seed: 0x8f2 },
    });
    expect(remembered).toBe(bare);
  });

  it('AC-4: a memory-enabled decision is legal and deterministic', () => {
    const decisions = collectDecisions(0x8f2, 6, (legal) => legal.length > 2);
    for (const { state, seat, legal } of decisions) {
      const pick = (): Card =>
        choosePlayByRollout(state, seat, makeRng(9), {
          worlds: 4,
          now: neverClock,
          memory: { seed: 0x5eed },
        });
      const card = pick();
      expect(legal).toContain(card);
      expect(pick()).toBe(card);
    }
  }, 30_000);
});

describe('HardPolicy', () => {
  it('exposes the state-aware play seam (and Medium does not)', () => {
    expect(hasStatePlay(new HardPolicy())).toBe(true);
    expect(hasStatePlay(new MediumPolicy())).toBe(false);
  });

  it('plays full hands through the headless sim harness with a memory (fh-8jf.2)', () => {
    const hard = new HardPolicy({
      bidWorlds: 2,
      keepWorlds: 2,
      play: { worlds: 2 },
      memory: { seed: 0x8f2 },
    });
    const medium = new MediumPolicy();
    const result = simulateHands(2, [hard, medium, medium, medium], 0x5eed);
    const hands = Object.values(result.contracts).reduce((n, s) => n + s.n, 0);
    expect(hands).toBe(2);
  }, 30_000);

  it('plays full hands through the headless sim harness, worker-free', () => {
    const hard = new HardPolicy({ bidWorlds: 2, keepWorlds: 2, play: { worlds: 2 } });
    const medium = new MediumPolicy();
    const result = simulateHands(2, [hard, medium, medium, medium], 0x5eed);
    const hands = Object.values(result.contracts).reduce((n, s) => n + s.n, 0);
    expect(hands).toBe(2);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Secondary trick term (fh-w6c): the rollout keeps a gradient once the
// contract's made/set result is settled, so it plays for tricks / damage
// control. trickBonus/sideDeltaFor read only handResult, so we exercise them
// against synthetic scored states rather than a full rollout.
// ---------------------------------------------------------------------------
describe('rollout secondary trick term (fh-w6c)', () => {
  // A scored state carrying only the fields sideDeltaFor/trickBonus read.
  const scored = (r: {
    contract: Bid;
    declarer: number;
    declarerDelta: number;
    defenderDelta: number;
    declarerSideTricks: number;
    defenderSideTricks: number;
  }): GameState => ({ handResult: { ...r, slam: false, made: false } }) as unknown as GameState;

  const numbered = bid(NUM, 8, 2); // 8 Diamonds
  const nulla = bid(NULLA);

  it('rewards the scored side per own trick on numbered contracts', () => {
    // Declarer set either way; the only difference is tricks taken.
    const few = scored({
      contract: numbered,
      declarer: 0,
      declarerDelta: -280,
      defenderDelta: 70,
      declarerSideTricks: 3,
      defenderSideTricks: 7,
    });
    const many = scored({
      contract: numbered,
      declarer: 0,
      declarerDelta: -280,
      defenderDelta: 30,
      declarerSideTricks: 7,
      defenderSideTricks: 3,
    });
    // Declarer is seat 0 (same side). Points already prefer `many`; the term
    // must reinforce, not fight, that ordering.
    const scoreFew = sideDeltaFor(few, 0) + trickBonus(few, 0, 8);
    const scoreMany = sideDeltaFor(many, 0) + trickBonus(many, 0, 8);
    expect(scoreMany).toBeGreaterThan(scoreFew);
    // The bonus alone favors 7 own tricks over 3 by (7-3)*8 = 32.
    expect(trickBonus(many, 0, 8) - trickBonus(few, 0, 8)).toBe(32);
  });

  it('negates the term on lose-all contracts (fewer own tricks is the goal)', () => {
    const declTook2 = scored({
      contract: nulla,
      declarer: 0,
      declarerDelta: -250,
      defenderDelta: 20,
      declarerSideTricks: 2,
      defenderSideTricks: 8,
    });
    // Declarer side (seat 0) wants FEWER own tricks on nulla: bonus negative.
    expect(trickBonus(declTook2, 0, 8)).toBe(-16);
    // A defender (seat 1) also wants fewer own tricks (force them on declarer).
    expect(trickBonus(declTook2, 1, 8)).toBe(-8 * 8);
  });

  it('never flips a make into a set, whatever the trick differential', () => {
    // Line A makes the contract taking the bare 8 tricks; line B sets it but
    // sweeps all 10. With trickWeight 8 the term (bounded by 10*8=80) must not
    // overcome the make/set swing (bidValue ~= 280 here).
    const makeThin = scored({
      contract: numbered,
      declarer: 0,
      declarerDelta: 280,
      defenderDelta: 20,
      declarerSideTricks: 8,
      defenderSideTricks: 2,
    });
    const setFat = scored({
      contract: numbered,
      declarer: 0,
      declarerDelta: -280,
      defenderDelta: 0,
      declarerSideTricks: 10,
      defenderSideTricks: 0,
    });
    const scoreMake = sideDeltaFor(makeThin, 0) + trickBonus(makeThin, 0, 8);
    const scoreSet = sideDeltaFor(setFat, 0) + trickBonus(setFat, 0, 8);
    expect(scoreMake).toBeGreaterThan(scoreSet);
  });
});

// ---------------------------------------------------------------------------
// Medium-tiebreak selection (fh-vkr / fh-hg4 / fh-4ww): when the rollout cannot
// clearly separate its pick from Medium's tactically-sound card, defer to
// Medium. The gate is the absolute floor `eps` OR `z` standard errors of the
// paired (best - Medium) difference, whichever is larger, so pickCard stays a
// pure, deterministic function of the tally it is handed.
// ---------------------------------------------------------------------------
describe('rollout Medium-tiebreak (fh-vkr, fh-hg4, fh-4ww)', () => {
  const GATE = { eps: 5, z: 2 };

  /**
   * A tally for one sampled world (so `diffSq` is just the squared paired
   * difference): with a single world the variance term is 0 by construction
   * and the gate collapses to the absolute floor.
   */
  const oneWorld = (totals: readonly number[], mediumIdx: number): RolloutTally => ({
    totals,
    diffSq: totals.map((t) => (t - (totals[mediumIdx] as number)) ** 2),
    worldsDone: 1,
    mediumIdx,
  });

  it("NT: prefers Medium's boss over the arg-max low card on a near-tie", () => {
    // legal ascending: a low card (index 0) and an ace/boss (index 1). The
    // rollout rates them within eps (cash-now vs cash-later is a wash under a
    // weak simulator); bare arg-max would keep the low card.
    const legal = [4, 10]; // 8S(low), AS(boss) — ascending card ints
    // Without the tiebreak the low card (higher EV) wins; with it, Medium's AS.
    expect(pickCard(legal, oneWorld([102, 100], 1), GATE)).toBe(10);
  });

  it("trump: prefers Medium's side card over the arg-max low trump on a near-tie", () => {
    // A non-declarer whose Medium pick is a side card; the arg-max lands on a
    // low trump within eps. pickCard must return the side card (fh-hg4).
    const legal = [1, 25]; // 5S (a spade/trump), 6D (a side card)
    expect(pickCard(legal, oneWorld([58, 55], 1), GATE)).toBe(25);
  });

  it('never overrides a rollout pick that is clearly better than Medium’s', () => {
    // Medium's card trails the best by more than eps, and every world agreed
    // (zero variance) -> trust the rollout.
    const legal = [4, 10];
    expect(pickCard(legal, oneWorld([120, 100], 1), GATE)).toBe(4);
  });

  it('is a no-op when Medium already picks the arg-max card', () => {
    expect(pickCard([4, 10], oneWorld([100, 130], 1), GATE)).toBe(10);
  });

  it('is deterministic: identical inputs return the identical card', () => {
    const tally = oneWorld([90, 88, 91], 1);
    expect(pickCard([4, 10, 25], tally, GATE)).toBe(pickCard([4, 10, 25], tally, GATE));
  });

  it('fh-4ww: a lead the worlds disagreed about is not enough, however big', () => {
    // 100 worlds, the best card ahead of Medium's by a mean of 20 points — far
    // clear of eps — but with a paired spread so wide the mean is inside 2
    // standard errors. sum(d) = 2000 and sum(d^2) = 4_000_000 give
    // sd = 200 and se = 20, so 2*se = 40 > 20: Medium's card holds.
    const legal = [4, 10];
    const tally: RolloutTally = {
      totals: [2000, 0],
      diffSq: [4_000_000, 0],
      worldsDone: 100,
      mediumIdx: 1,
    };
    expect(pickCard(legal, tally, GATE)).toBe(10);
    // The same 20-point lead, this time with the worlds nearly unanimous
    // (sum(d^2) = 41_000 -> sd ~= 3.2, se ~= 0.32), clears the gate.
    expect(pickCard(legal, { ...tally, diffSq: [41_000, 0] }, GATE)).toBe(4);
  });

  it('fh-4ww: z = 0 restores the pure-eps gate', () => {
    const legal = [4, 10];
    const wide: RolloutTally = {
      totals: [2000, 0],
      diffSq: [4_000_000, 0],
      worldsDone: 100,
      mediumIdx: 1,
    };
    expect(pickCard(legal, wide, { eps: 5, z: 0 })).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// fh-4ww: the two misplays a human flagged from the debug panel (fh-q2m) in
// game 74a62326, replayed from the logged deal through the real engine.
//
// Flag 1 — hand 0, trick 2. Contract 7C, declarer seat 2, on lead holding
//   4S 6S 8S QS | 7C QC AC | KH. It led 8S. The declarer was NOT out of trump:
//   it held A-Q-7 of clubs with three trumps (K-10-9) still unseen, so the
//   human's "should have got all trump out first" was right on the cards.
//   Medium's fh-n2n draw already said AC; Hard's rollout rates the whole hand
//   dead level and its arg-max shipped a low spade. Now: AC, every seed.
//
// Flag 2 — hand 4, trick 2. Contract 7NT, declarer seat 1; DEFENDER seat 2 on
//   lead holding 6C 8C JC | 7D 8D 10D QD | 6H. It led 7D, and Medium would
//   have bled 6C — the fh-2wt cash-from-the-top branch was gated to the
//   declaring side. Widened to every seat, Medium leads QD (top of the longest
//   suit, joker still unseen so nothing is boss); Hard follows.
// ---------------------------------------------------------------------------
interface FlaggedHand {
  readonly handNumber: number;
  readonly note: string;
  readonly firstBidder: number;
  readonly deal: { readonly hands: readonly (readonly Card[])[]; readonly middle: readonly Card[] };
  readonly calls: readonly { readonly seat: number; readonly bid: Bid }[];
  readonly declarer: number;
  readonly discards: readonly Card[];
  /** Tricks as [seat, card] pairs in play order. */
  readonly tricks: readonly (readonly (readonly [number, Card])[])[];
}

const FLAGGED: readonly FlaggedHand[] = (
  JSON.parse(readFileSync(new URL('./fixtures/flagged-hands.json', import.meta.url), 'utf8')) as {
    hands: FlaggedHand[];
  }
).hands;

/** Replay a logged hand from its deal and stop on the flagged decision. */
function replayTo(hand: FlaggedHand, trickIndex: number, ply: number): GameState {
  const step = (s: GameState, action: Action): GameState => {
    const r = applyAction(s, action);
    if (!r.ok) throw new Error(`replay stalled: ${r.error.message}`);
    return r.state;
  };
  let state = initHandFromDeal(hand.deal.hands, hand.deal.middle, hand.firstBidder);
  for (const call of hand.calls)
    state = step(state, { type: 'bid', seat: call.seat, bid: call.bid });
  if (state.phase === 'slamDecision') {
    state = step(state, { type: 'declineSlam', seat: hand.declarer });
  }
  if (state.phase === 'middleExchange') {
    // The log records the discards, so the keeps are the other 10 of the 15.
    const held = [...(state.exchange?.hands[hand.declarer] ?? [])];
    const pending = [...hand.discards];
    const keeps = held.filter((c) => {
      const i = pending.indexOf(c);
      if (i < 0) return true;
      pending.splice(i, 1);
      return false;
    });
    state = step(state, { type: 'discardKeeps', seat: hand.declarer, keeps });
  }
  for (const [t, trick] of hand.tricks.entries()) {
    for (const [p, [seat, card]] of trick.entries()) {
      if (t === trickIndex && p === ply) return state;
      state = step(state, { type: 'playCard', seat, card });
    }
  }
  throw new Error('the logged hand ended before that decision');
}

/** Medium's card at a decision state, with the arguments Hard feeds it. */
function mediumCardAt(state: GameState, seat: number): Card {
  const play = state.play;
  if (play === null || state.contract === null) throw new Error('not in play');
  return new MediumPolicy().choosePlay(
    seat,
    play.hands[seat] ?? [],
    legalPlaysFor(play, seat),
    play.plays,
    play.trump,
    play.ledSuit,
    state.contract,
    { declarer: play.declarer, tricks: play.tricks },
  );
}

const picksOver = (state: GameState, seat: number, worlds: number, seeds: number): Card[] =>
  Array.from({ length: seeds }, (_, i) =>
    choosePlayByRollout(state, seat, makeRng(i + 1), { worlds }),
  );

describe('flagged misplays from game 74a62326 (fh-4ww)', () => {
  const SPADE_8 = makeCard(0, 8);
  const CLUB_7 = makeCard(1, 7);
  const CLUB_Q = makeCard(1, 12);
  const CLUB_A = makeCard(1, 14);
  const DIAMOND_7 = makeCard(2, 7);
  const DIAMOND_Q = makeCard(2, 12);

  describe('flag 1: the declarer led a side suit with trump still out', () => {
    const state = replayTo(FLAGGED[0] as FlaggedHand, 2, 0);
    const SEAT = 2;

    it('AC-3: the declarer was holding trump, so the lead was not forced', () => {
      const play = state.play;
      if (play === null) throw new Error('not in play');
      expect(toActSeat(state)).toBe(SEAT);
      expect(play.trump).toBe(1); // clubs
      expect(play.declarer).toBe(SEAT);
      expect(play.hands[SEAT]).toEqual(expect.arrayContaining([CLUB_7, CLUB_Q, CLUB_A]));
      // ...and trump was still outstanding: 13 trumps (11 clubs + JS + joker),
      // 3 in hand, 7 on the table, so 3 unseen.
      const seen = new Set<Card>(play.hands[SEAT] ?? []);
      for (const t of play.tricks) for (const p of t.plays) seen.add(p.card);
      const outTrumps = [...Array(45).keys()].filter(
        (c) => !seen.has(c) && (c === JOKER || cardSuit(c) === 1 || c === makeCard(0, 11)),
      );
      expect(outTrumps).toHaveLength(3);
    });

    it('draws with the top trump instead of the flagged 8S', () => {
      expect(mediumCardAt(state, SEAT)).toBe(CLUB_A);
      expect(picksOver(state, SEAT, 60, 10)).toEqual(Array<Card>(10).fill(CLUB_A));
    });

    it('never replays the flagged card, at the shipping world budget', () => {
      // 20 worlds is the shipped play budget — the widest paired standard
      // error, so the hardest case for the gate.
      const picks = picksOver(state, SEAT, 20, 25);
      expect(picks).not.toContain(SPADE_8);
      expect(picks.filter((c) => c === CLUB_A).length).toBeGreaterThanOrEqual(20);
    });
  });

  describe('flag 2: a defender led low in no-trump', () => {
    const state = replayTo(FLAGGED[1] as FlaggedHand, 2, 0);
    const SEAT = 2;

    it('AC-2: the flagged seat is a DEFENDER on lead in NT', () => {
      const play = state.play;
      if (play === null) throw new Error('not in play');
      expect(toActSeat(state)).toBe(SEAT);
      expect(play.trump).toBeNull();
      expect(play.declarer).toBe(1);
      expect(SEAT % 2).not.toBe(play.declarer % 2);
      expect(play.ledSuit).toBeNull();
    });

    it('leads the top of its longest suit, not the lowest card in hand', () => {
      expect(mediumCardAt(state, SEAT)).toBe(DIAMOND_Q);
      expect(picksOver(state, SEAT, 60, 10)).toEqual(Array<Card>(10).fill(DIAMOND_Q));
    });

    it('never replays the flagged 7D, at the shipping world budget', () => {
      // 20 worlds is the shipped play budget, where the paired standard error
      // is widest and a stray arg-max is likeliest. The flagged card is gone
      // outright and QD is the overwhelming majority; the handful of stragglers
      // (measured: 3x 6C, 1x 6H over these 25 seeds) is the residual noise the
      // gate tolerates rather than a return of the pattern.
      const picks = picksOver(state, SEAT, 20, 25);
      expect(picks).not.toContain(DIAMOND_7);
      expect(picks.filter((c) => c === DIAMOND_Q).length).toBeGreaterThanOrEqual(18);
    });
  });
});
