import { describe, expect, it } from 'vitest';
import {
  DNULLA,
  ExchangeState,
  NULLA,
  NUM,
  bid,
  declareSlam,
  discardKeeps,
  exchangeResult,
  giveCard,
  initExchange,
  partnerOf,
  toAct,
} from '../src/index.js';

// Deterministic layout: seat s holds s*10..s*10+9, the middle is 40..44.
const HANDS = [0, 1, 2, 3].map((s) => Array.from({ length: 10 }, (_, i) => s * 10 + i));
const MIDDLE = [40, 41, 42, 43, 44];

function sorted(cards: readonly number[]): number[] {
  return [...cards].sort((a, b) => a - b);
}

describe('NUM contract', () => {
  it('picks up the middle and offers the slam first', () => {
    const state = initExchange(HANDS, MIDDLE, bid(NUM, 8, 2), 1);
    expect(state.phase).toBe('SLAM_OFFER');
    expect(toAct(state)).toBe(1);
    expect(state.hands[1]).toEqual(sorted([...HANDS[1], ...MIDDLE]));
    expect(state.hands[1]).toHaveLength(15);
  });

  it('declined slam: keep 10 of 15, all four seats active (AC-1)', () => {
    let state = initExchange(HANDS, MIDDLE, bid(NUM, 8, 2), 1);
    state = declareSlam(state, false);
    expect(state.phase).toBe('DECLARER_DISCARD');
    const keeps = [10, 11, 12, 13, 14, 40, 41, 42, 43, 44]; // all 5 middle cards kept: legal
    state = discardKeeps(state, 1, keeps);
    expect(state.phase).toBe('DONE');
    for (const s of [0, 1, 2, 3]) expect(state.hands[s]).toHaveLength(10);
    expect(state.hands[1]).toEqual(sorted(keeps));
    expect(exchangeResult(state)).toEqual({
      activeSeats: [0, 1, 2, 3],
      slam: false,
      discards: [15, 16, 17, 18, 19],
    });
  });

  it('slam: partner gives a card, declarer keeps 10 of 16, partner sits out (AC-1)', () => {
    let state = initExchange(HANDS, MIDDLE, bid(NUM, 10, 4), 1);
    state = declareSlam(state, true);
    expect(state.phase).toBe('GIVE_CARD');
    expect(state.slam).toBe(true);
    expect(toAct(state)).toBe(3); // partner of seat 1
    state = giveCard(state, 35);
    expect(state.hands[1]).toContain(35);
    expect(state.hands[1]).toHaveLength(16);
    expect(state.hands[3]).toHaveLength(9);
    state = discardKeeps(state, 1, [10, 11, 12, 13, 14, 35, 40, 41, 42, 43]);
    expect(state.phase).toBe('DONE');
    expect(exchangeResult(state)).toEqual({
      activeSeats: [0, 1, 2],
      slam: true,
      discards: [15, 16, 17, 18, 19, 44], // 6 cards: the extra returns to the middle discards
    });
    for (const s of [0, 1, 2]) expect(state.hands[s]).toHaveLength(10);
    expect(state.hands[3]).toHaveLength(9); // sit-out seat keeps its cards
  });

  it('rejects giving a card the partner does not hold', () => {
    const state = declareSlam(initExchange(HANDS, MIDDLE, bid(NUM, 7, 0), 0), true);
    expect(() => giveCard(state, 5)).toThrow(/not in partner hand/);
  });

  it('offers the slam exactly once', () => {
    const declined = declareSlam(initExchange(HANDS, MIDDLE, bid(NUM, 7, 0), 0), false);
    expect(() => declareSlam(declined, true)).toThrow(/not on offer/);
  });
});

describe('NULLA contract', () => {
  it('partner sits out, no slam offer, declarer keeps 10 of 15 (AC-1)', () => {
    let state = initExchange(HANDS, MIDDLE, bid(NULLA), 2);
    expect(state.phase).toBe('DECLARER_DISCARD'); // slam is never offered
    expect(() => declareSlam(state, true)).toThrow(/not on offer/);
    expect(state.activeSeats).toEqual([1, 2, 3]); // partner (seat 0) sits out
    state = discardKeeps(state, 2, [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect(state.phase).toBe('DONE');
    expect(exchangeResult(state)).toEqual({
      activeSeats: [1, 2, 3],
      slam: false,
      discards: [40, 41, 42, 43, 44],
    });
    for (const s of [1, 2, 3]) expect(state.hands[s]).toHaveLength(10);
    expect(state.hands[0]).toHaveLength(10); // sit-out hand untouched
  });
});

describe('DNULLA contract', () => {
  it('passes the exact 5 discards to the partner, all seats active (AC-1, AC-2)', () => {
    let state = initExchange(HANDS, MIDDLE, bid(DNULLA), 0);
    expect(state.phase).toBe('DECLARER_DISCARD');
    const keeps = [0, 1, 2, 3, 4, 40, 41, 42, 43, 44];
    state = discardKeeps(state, 0, keeps);
    expect(state.phase).toBe('PARTNER_DISCARD');
    expect(toAct(state)).toBe(2);
    expect(state.passed).toEqual([5, 6, 7, 8, 9]); // the exact 5 discards
    expect(state.hands[2]).toEqual(sorted([...HANDS[2], 5, 6, 7, 8, 9]));
    expect(state.hands[2]).toHaveLength(15);

    state = discardKeeps(state, 2, [5, 6, 7, 8, 9, 20, 21, 22, 23, 24]);
    expect(state.phase).toBe('DONE');
    expect(exchangeResult(state)).toEqual({
      activeSeats: [0, 1, 2, 3],
      slam: false,
      discards: [25, 26, 27, 28, 29],
    });
    for (const s of [0, 1, 2, 3]) expect(state.hands[s]).toHaveLength(10);
  });

  it('rejects the partner discarding out of turn before the pass-through', () => {
    const state = initExchange(HANDS, MIDDLE, bid(DNULLA), 0);
    expect(() => discardKeeps(state, 2, HANDS[2])).toThrow(/discard/);
  });
});

describe('invalid keeps are rejected with no state change (AC-3)', () => {
  function freshDiscardState(): ExchangeState {
    return declareSlam(initExchange(HANDS, MIDDLE, bid(NUM, 7, 0), 0), false);
  }

  it.each([
    ['9 cards', [0, 1, 2, 3, 4, 5, 6, 7, 8]],
    ['11 cards', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 40]],
    ['a card not held', [0, 1, 2, 3, 4, 5, 6, 7, 8, 15]],
    ['a duplicated card', [0, 1, 2, 3, 4, 5, 6, 7, 8, 8]],
  ])('rejects keeping %s', (_label, keeps) => {
    const state = freshDiscardState();
    const frozen = JSON.stringify(state);
    expect(() => discardKeeps(state, 0, keeps)).toThrow();
    expect(JSON.stringify(state)).toBe(frozen);
  });

  it('rejects a discard from the wrong seat', () => {
    const state = freshDiscardState();
    expect(() => discardKeeps(state, 1, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19])).toThrow(
      /discard/,
    );
  });

  it('rejects actions out of phase', () => {
    const offer = initExchange(HANDS, MIDDLE, bid(NUM, 7, 0), 0);
    expect(() => discardKeeps(offer, 0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toThrow(/no discard/);
    expect(() => giveCard(offer, 20)).toThrow(/no card is owed/);
    const done = discardKeeps(declareSlam(offer, false), 0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(toAct(done)).toBeNull();
    expect(() => discardKeeps(done, 0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toThrow(/no discard/);
  });
});

describe('mechanics', () => {
  it('rejects entering the exchange with a non-contract bid', () => {
    expect(() => initExchange(HANDS, MIDDLE, bid('PASS'), 0)).toThrow(/not a playable/);
  });

  it('exposes partnerOf as (seat+2)%4 like the oracle', () => {
    expect([0, 1, 2, 3].map(partnerOf)).toEqual([2, 3, 0, 1]);
  });

  it('does not mutate the input hands or prior states', () => {
    const hands = HANDS.map((h) => [...h]);
    const state = initExchange(hands, MIDDLE, bid(NUM, 7, 0), 0);
    const frozen = JSON.stringify(state);
    declareSlam(state, true);
    expect(hands).toEqual(HANDS);
    expect(JSON.stringify(state)).toBe(frozen);
  });

  it('round-trips through JSON (protocol-plain state)', () => {
    let state = initExchange(HANDS, MIDDLE, bid(DNULLA), 1);
    state = discardKeeps(state, 1, [10, 11, 12, 13, 14, 40, 41, 42, 43, 44]);
    const revived = JSON.parse(JSON.stringify(state)) as ExchangeState;
    expect(revived).toEqual(state);
    expect(toAct(revived)).toBe(toAct(state));
  });
});
