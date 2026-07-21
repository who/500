import { describe, expect, it } from 'vitest';
import {
  JOKER,
  NULLA,
  NUM,
  NT,
  PlayState,
  bid,
  initPlay,
  legalPlaysFor,
  playCard,
  playDone,
  playToAct,
  scorePlay,
  trickOrder,
} from '../src/index.js';

// Card encoding: suit*11 + (rank-4). Suit blocks: S=0..10, C=11..21,
// D=22..32, H=33..43, JOKER=44.
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

// Layout A: seat 0 holds the joker; suits are cleanly partitioned.
const HANDS_A = [
  [JOKER, ...range(0, 9)], // 9 spades + joker
  [...range(22, 5), ...range(11, 5)], // 5 diamonds, 5 clubs
  [...range(33, 5), ...range(16, 5)], // 5 hearts, 5 clubs
  [...range(27, 5), ...range(38, 5)], // 5 diamonds, 5 hearts
];

// Layout B: seat 1 holds the joker and no spades.
const HANDS_B = [
  range(0, 10), // all spades
  [JOKER, ...range(11, 9)], // joker + 9 clubs
  range(22, 10), // all diamonds
  range(33, 10), // all hearts
];

// Layout C: joker-free (it stays in the middle); one suit per seat.
const HANDS_C = [range(0, 10), range(11, 10), range(22, 10), range(33, 10)];

function autoPlay(state: PlayState): PlayState {
  while (!playDone(state)) {
    const seat = playToAct(state);
    if (seat === null) break;
    const card = legalPlaysFor(state, seat)[0]!;
    const needsSuit = card === JOKER && state.trump === null && state.ledSuit === null;
    state = needsSuit ? playCard(state, seat, card, 0) : playCard(state, seat, card);
  }
  return state;
}

describe('initPlay', () => {
  it('starts with the declarer on lead', () => {
    const state = initPlay(HANDS_A, bid(NUM, 8, NT), 2, [0, 1, 2, 3]);
    expect(state.leader).toBe(2);
    expect(playToAct(state)).toBe(2);
    expect(trickOrder(state)).toEqual([2, 3, 0, 1]);
  });

  it('rejects short hands and inactive declarers', () => {
    const short = HANDS_A.map((h, s) => (s === 0 ? h.slice(1) : h));
    expect(() => initPlay(short, bid(NUM, 8, NT), 0, [0, 1, 2, 3])).toThrow('10 cards');
    expect(() => initPlay(HANDS_A, bid(NULLA), 0, [1, 2, 3])).toThrow('active seat');
  });
});

describe('turn and legality enforcement', () => {
  it('rejects plays out of turn', () => {
    const state = initPlay(HANDS_A, bid(NUM, 8, NT), 0, [0, 1, 2, 3]);
    expect(() => playCard(state, 1, 22)).toThrow("not seat 1's turn");
  });

  it('rejects a sluff while a follower is held', () => {
    let state = initPlay(HANDS_A, bid(NUM, 8, NT), 0, [0, 1, 2, 3]);
    state = playCard(state, 0, JOKER, 2); // joker led naming diamonds
    expect(() => playCard(state, 1, 11)).toThrow('not a legal play'); // club while holding diamonds
  });
});

describe('joker leads (no trump)', () => {
  it('requires a named suit and makes it the led suit (AC in tricks: joker wins)', () => {
    let state = initPlay(HANDS_A, bid(NUM, 8, NT), 0, [0, 1, 2, 3]);
    expect(() => playCard(state, 0, JOKER)).toThrow('requires jokerSuit');
    expect(() => playCard(state, 0, JOKER, 5)).toThrow('suit index');
    state = playCard(state, 0, JOKER, 2);
    expect(state.ledSuit).toBe(2);
    expect(legalPlaysFor(state, 1)).toEqual(range(22, 5)); // must follow diamonds
    state = playCard(state, 1, 22);
    state = playCard(state, 2, 33); // no diamonds: free sluff
    state = playCard(state, 3, 27);
    expect(state.tricks).toHaveLength(1);
    expect(state.tricks[0]).toMatchObject({ leader: 0, ledSuit: 2, winner: 0 });
    expect(state.leader).toBe(0); // joker took the trick
    expect(state.sideTricks).toEqual([1, 0]);
  });

  it('a followed joker silently assumes the led suit and blocks sluffing', () => {
    let state = initPlay(HANDS_B, bid(NUM, 8, NT), 0, [0, 1, 2, 3]);
    state = playCard(state, 0, 0); // 4S led
    expect(legalPlaysFor(state, 1)).toEqual([JOKER]); // only "spade" seat 1 holds
    expect(() => playCard(state, 1, JOKER, 0)).toThrow('only allowed when leading');
    state = playCard(state, 1, JOKER);
    state = playCard(state, 2, 22);
    state = playCard(state, 3, 33);
    expect(state.tricks[0]?.winner).toBe(1);
    expect(state.leader).toBe(1);
  });
});

describe('joker leads (trump hands)', () => {
  it('needs no named suit: the joker is trump', () => {
    let state = initPlay(HANDS_A, bid(NUM, 8, 3), 0, [0, 1, 2, 3]); // hearts trump
    expect(() => playCard(state, 0, JOKER, 2)).toThrow('only allowed when leading');
    state = playCard(state, 0, JOKER);
    expect(state.ledSuit).toBe(3);
    expect(legalPlaysFor(state, 2)).toEqual(range(33, 5)); // must follow hearts
  });
});

describe('sit-out rotation (AC-3)', () => {
  it('a nulla with 3 active seats resolves all 10 tricks over exactly those seats', () => {
    // Declarer 0's partner (seat 2) sits out.
    const active = [0, 1, 3];
    let state = initPlay(HANDS_A, bid(NULLA), 0, active);
    state = autoPlay(state);

    expect(playDone(state)).toBe(true);
    expect(state.tricks).toHaveLength(10);
    for (const trick of state.tricks) {
      expect(trick.plays).toHaveLength(3);
      expect(active).toContain(trick.winner);
      const seats = trick.plays.map((p) => p.seat);
      expect(new Set(seats).size).toBe(3);
      expect(seats).not.toContain(2);
      // Play order is the active-seat rotation starting from the leader.
      const i = active.indexOf(trick.leader);
      expect(seats).toEqual([...active.slice(i), ...active.slice(0, i)]);
    }
    expect(state.sideTricks[0] + state.sideTricks[1]).toBe(10);
    expect(state.hands[2]).toHaveLength(10); // the sat-out hand is untouched
    for (const s of active) expect(state.hands[s]).toHaveLength(0);
  });
});

describe('full hand to a scored result', () => {
  it('spade-flush nulla declarer wins every trick they lead and fails', () => {
    // Seat 0 (declarer, side 0) holds all ten spades; under no trump the led
    // spade always wins, so seat 0 wins all 10 tricks — the worst nulla.
    let state = initPlay(HANDS_C, bid(NULLA), 0, [0, 1, 3]);
    state = autoPlay(state);
    expect(state.sideTricks).toEqual([10, 0]);

    const result = scorePlay(state, false);
    expect(result.made).toBe(false);
    expect(result.declarerDelta).toBe(-250);
    expect(result.defenderDelta).toBe(100); // 10 per trick forced onto the bidders
  });

  it('refuses to score an unfinished hand', () => {
    const state = initPlay(HANDS_A, bid(NUM, 8, NT), 0, [0, 1, 2, 3]);
    expect(() => scorePlay(state, false)).toThrow('all 10 tricks');
  });
});
