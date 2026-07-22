/**
 * Easy bot spec — the issue's acceptance criteria:
 *   AC-1: 4 Easy bots complete 500 seeded headless hands, zero illegal actions.
 *   AC-2: over 10k seeded bid decisions Easy never emits NULLA, DNULLA, or a
 *         slam declaration.
 *   AC-3: guardrail unit cases — partner-boss-card restraint and lose-all
 *         ducking, plus their forced-play fallbacks.
 * The GameState -> Policy driver lives here for now; the sim harness leaf
 * promotes it to shared code.
 */

import { describe, expect, it } from 'vitest';
import type { Action, Bid, Card, GameState, Rng } from '@five-hundred/engine';
import {
  DNULLA,
  JOKER,
  LADDER,
  NULLA,
  NUM,
  applyAction,
  bid,
  legalPlaysFor,
  makeCard,
  makeRng,
  newGame,
  partnerOf,
  toActSeat,
} from '@five-hundred/engine';
import type { Policy } from '../src/index.js';
import { EasyPolicy, defaultGiveBestCard } from '../src/index.js';

// ---------------------------------------------------------------------------
// GameState -> Policy driver (mirrors the oracle's play_hand call sites)
// ---------------------------------------------------------------------------

function botAction(state: GameState, policies: readonly Policy[], rng: Rng): Action {
  if (state.phase === 'handScored') return { type: 'nextHand', seat: 0 };
  const seat = toActSeat(state);
  if (seat === null) throw new Error(`no seat to act during ${state.phase}`);
  const policy = policies[seat] as Policy;
  const contract = state.contract as Bid;
  const hand = state.hands[seat] ?? [];
  switch (state.phase) {
    case 'auction': {
      const auction = state.auction;
      if (auction === null) throw new Error('auction phase without auction state');
      const mayIndicate = auction.declarer === null && !auction.indicated[seat];
      return {
        type: 'bid',
        seat,
        bid: policy.chooseBid(
          hand,
          auction.ladderPos,
          mayIndicate,
          { seat, indications: auction.indications, scores: state.game.scores },
          rng,
        ),
      };
    }
    case 'slamDecision':
      return policy.considerSlam(hand, contract, rng)
        ? { type: 'declareSlam', seat }
        : { type: 'declineSlam', seat };
    case 'partnerCard':
      return { type: 'giveCard', seat, card: policy.giveBestCard(hand, contract, rng) };
    case 'middleExchange':
      return { type: 'discardKeeps', seat, keeps: policy.chooseKeeps(hand, contract, rng) };
    case 'play': {
      const play = state.play;
      if (play === null) throw new Error('play phase without play state');
      const legal = legalPlaysFor(play, seat);
      const card = policy.choosePlay(
        seat,
        play.hands[seat] ?? [],
        legal,
        play.plays,
        play.trump,
        play.ledSuit,
        contract,
        { declarer: play.declarer, tricks: play.tricks },
        rng,
      );
      if (card === JOKER && play.trump === null && play.ledSuit === null) {
        const rest = (play.hands[seat] ?? []).filter((c) => c !== JOKER);
        return {
          type: 'playCard',
          seat,
          card,
          jokerSuit: policy.chooseJokerSuit(rest, contract, rng),
        };
      }
      return { type: 'playCard', seat, card };
    }
    default:
      throw new Error(`no bot action for phase ${state.phase}`);
  }
}

interface HeadlessRun {
  readonly hands: number;
  readonly actions: Action[];
}

/** Drive Easy tables through applyAction until `targetHands` are scored. */
function runHeadless(firstSeed: number, targetHands: number, rngSeed: number): HeadlessRun {
  const policies = [new EasyPolicy(), new EasyPolicy(), new EasyPolicy(), new EasyPolicy()];
  const rng = makeRng(rngSeed);
  const actions: Action[] = [];
  let hands = 0;
  let seed = firstSeed;
  let state = newGame(seed);
  const maxSteps = targetHands * 2000;
  for (let step = 0; hands < targetHands; step++) {
    if (step >= maxSteps) throw new Error(`stuck in ${state.phase} after ${step} steps`);
    if (state.phase === 'gameOver') {
      state = newGame(++seed);
      continue;
    }
    const action = botAction(state, policies, rng);
    const result = applyAction(state, action);
    if (!result.ok) {
      throw new Error(
        `illegal bot action ${action.type} by seat ${action.seat}: ${result.error.message}`,
      );
    }
    actions.push(action);
    if (result.state.phase === 'handScored' && state.phase === 'play') hands++;
    state = result.state;
  }
  return { hands, actions };
}

/** Rng stub: fixed random() stream value, smallest int() draw. */
function stubRng(randomValue: number): Rng {
  return {
    random: () => randomValue,
    int: (n) => Math.min(0, n - 1),
    shuffle: () => undefined,
  };
}

const HEARTS = bid(NUM, 8, 3); // hearts trump
const NULLA_BID = bid(NULLA);
const NO_SIGNALS = { seat: 0, indications: [], scores: [0, 0] } as const;
// Easy ignores the play context entirely; any well-formed one will do.
const PLAY_CTX = { declarer: 1, tricks: [] } as const;

describe('AC-1: headless Easy table', () => {
  it('4 Easy bots complete 500 seeded hands with zero illegal actions', () => {
    const run = runHeadless(1, 500, 20260721);
    expect(run.hands).toBe(500);
  });
});

describe('AC-2: Easy never bids nulla, double nulla, or a slam', () => {
  it('never emits NULLA or DNULLA over 10k seeded bid decisions', () => {
    const easy = new EasyPolicy();
    const rng = makeRng(99);
    for (let i = 0; i < 10_000; i++) {
      // Cycle every ladder position (-1 .. top) so both nulla rungs are the
      // next step many times over.
      const ladderPos = (i % (LADDER.length + 1)) - 1;
      const b = easy.chooseBid([], ladderPos, i % 2 === 0, NO_SIGNALS, rng);
      expect(b.kind).not.toBe(NULLA);
      expect(b.kind).not.toBe(DNULLA);
    }
  });

  it('steps over the nulla rungs to the next NUM bid', () => {
    const easy = new EasyPolicy();
    const always = stubRng(0); // random() = 0 < bidProb: always raises
    const nullaIdx = LADDER.findIndex((b) => b.kind === NULLA);
    const dnullaIdx = LADDER.findIndex((b) => b.kind === DNULLA);
    expect(easy.chooseBid([], nullaIdx - 1, false, NO_SIGNALS, always)).toEqual(
      LADDER[nullaIdx + 1],
    );
    expect(easy.chooseBid([], dnullaIdx - 1, false, NO_SIGNALS, always)).toEqual(
      LADDER[dnullaIdx + 1],
    );
  });

  it('passes at the top of the ladder instead of overflowing', () => {
    const easy = new EasyPolicy();
    const b = easy.chooseBid([], LADDER.length - 1, false, NO_SIGNALS, stubRng(0));
    expect(b.kind).toBe('PASS');
  });

  it('never declares a slam over 10k decisions', () => {
    const easy = new EasyPolicy();
    const rng = makeRng(7);
    for (let i = 0; i < 10_000; i++) {
      expect(easy.considerSlam([], HEARTS, rng)).toBe(false);
    }
  });
});

describe('AC-3: guardrail (a) — partner-boss-card restraint', () => {
  const seat = 0;
  const partner = partnerOf(seat); // seat 2
  const ledSpades = 0;
  const aceSpades = makeCard(0, 14);
  const lowSpade = makeCard(0, 5);
  const trumpFive = makeCard(3, 5);

  it('never beats the partner when a legal non-beating card exists', () => {
    const easy = new EasyPolicy();
    const rng = makeRng(11);
    const plays = [
      { seat: 1, card: makeCard(0, 10) },
      { seat: partner, card: aceSpades }, // partner holds the trick
    ];
    for (let i = 0; i < 200; i++) {
      const pick = easy.choosePlay(
        seat,
        [lowSpade, trumpFive],
        [lowSpade, trumpFive],
        plays,
        3,
        ledSpades,
        HEARTS,
        PLAY_CTX,
        rng,
      );
      expect(pick).toBe(lowSpade); // 5H would trump the partner's ace
    }
  });

  it('does not restrain against a winning opponent', () => {
    const easy = new EasyPolicy();
    const rng = makeRng(12);
    const plays = [{ seat: 1, card: aceSpades }]; // opponent holds the trick
    const picks = new Set<Card>();
    for (let i = 0; i < 200; i++) {
      picks.add(
        easy.choosePlay(
          seat,
          [lowSpade, trumpFive],
          [lowSpade, trumpFive],
          plays,
          3,
          ledSpades,
          HEARTS,
          PLAY_CTX,
          rng,
        ),
      );
    }
    expect(picks).toEqual(new Set([lowSpade, trumpFive]));
  });

  it('falls back to uniform-random legal when every legal card beats the partner', () => {
    const easy = new EasyPolicy();
    const rng = makeRng(13);
    const plays = [{ seat: partner, card: aceSpades }];
    const winners = [makeCard(3, 11), JOKER]; // right bower and joker both win
    const picks = new Set<Card>();
    for (let i = 0; i < 200; i++) {
      picks.add(easy.choosePlay(seat, winners, winners, plays, 3, ledSpades, HEARTS, PLAY_CTX, rng));
    }
    expect(picks).toEqual(new Set(winners));
  });
});

describe('AC-3: guardrail (b) — lose-all ducking', () => {
  const ledSpades = 0;
  const tenSpades = makeCard(0, 10);
  const sevenSpades = makeCard(0, 7);
  const aceSpades = makeCard(0, 14);
  const kingSpades = makeCard(0, 13);

  it('always ducks under the current winner when it can', () => {
    const easy = new EasyPolicy();
    const rng = makeRng(21);
    const plays = [{ seat: 1, card: tenSpades }];
    for (let i = 0; i < 200; i++) {
      const pick = easy.choosePlay(
        0,
        [sevenSpades, aceSpades],
        [sevenSpades, aceSpades],
        plays,
        null,
        ledSpades,
        NULLA_BID,
        PLAY_CTX,
        rng,
      );
      expect(pick).toBe(sevenSpades);
    }
  });

  it('falls back to uniform-random legal when only winners are legal', () => {
    const easy = new EasyPolicy();
    const rng = makeRng(22);
    const plays = [{ seat: 1, card: tenSpades }];
    const winners = [aceSpades, kingSpades];
    const picks = new Set<Card>();
    for (let i = 0; i < 200; i++) {
      picks.add(
        easy.choosePlay(0, winners, winners, plays, null, ledSpades, NULLA_BID, PLAY_CTX, rng),
      );
    }
    expect(picks).toEqual(new Set(winners));
  });

  it('leads uniformly at random (no duck target yet)', () => {
    const easy = new EasyPolicy();
    const rng = makeRng(23);
    const hand = [sevenSpades, aceSpades];
    const picks = new Set<Card>();
    for (let i = 0; i < 200; i++) {
      picks.add(easy.choosePlay(0, hand, hand, [], null, null, NULLA_BID, PLAY_CTX, rng));
    }
    expect(picks).toEqual(new Set(hand));
  });
});

describe('Policy surface', () => {
  it('chooseKeeps returns exactly 10 distinct held cards from 15', () => {
    const easy = new EasyPolicy();
    for (let seed = 0; seed < 20; seed++) {
      const cards = Array.from({ length: 15 }, (_, i) => i as Card);
      const keeps = easy.chooseKeeps(cards, HEARTS, makeRng(seed));
      expect(keeps).toHaveLength(10);
      expect(new Set(keeps).size).toBe(10);
      for (const c of keeps) expect(cards).toContain(c);
    }
  });

  it('giveBestCard surrenders the strongest card by power', () => {
    // Right bower outranks a plain-suit ace under a hearts contract...
    expect(defaultGiveBestCard([makeCard(0, 14), makeCard(3, 11)], HEARTS)).toBe(makeCard(3, 11));
    // ...the joker beats everything...
    expect(defaultGiveBestCard([makeCard(3, 11), JOKER], HEARTS)).toBe(JOKER);
    // ...and with no trump each card rates in its own suit, so highest rank wins.
    expect(defaultGiveBestCard([makeCard(0, 14), makeCard(3, 13)], bid(NUM, 8, 4))).toBe(
      makeCard(0, 14),
    );
  });

  it('chooseJokerSuit names a real suit from the injected Rng only', () => {
    const easy = new EasyPolicy();
    const rng = makeRng(31);
    for (let i = 0; i < 100; i++) {
      const s = easy.chooseJokerSuit([], HEARTS, rng);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(3);
    }
  });
});

describe('determinism', () => {
  it('replays an identical action stream under the same seeds', () => {
    const a = runHeadless(5, 25, 424242);
    const b = runHeadless(5, 25, 424242);
    expect(a.actions).toEqual(b.actions);
    expect(a.hands).toBe(b.hands);
  });
});
