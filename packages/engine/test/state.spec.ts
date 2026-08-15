import { describe, expect, it } from 'vitest';
import {
  DNULLA,
  GameState,
  JOKER,
  NT,
  NULLA,
  NUM,
  PASS,
  STATE_FORMAT_VERSION,
  applyAction,
  bid,
  deserializeGame,
  legalActions,
  newGame,
  partnerOf,
  serializeGame,
  toActSeat,
} from '../src/index.js';
import { driveGame } from './drive.js';

// One-hand deciders: |declarer delta| >= 500 ends the game either way.
const TEN_NT = bid(NUM, 10, NT); // 520
const EIGHT_C = bid(NUM, 8, 1); // 260 as a numbered bid; slam is a flat 500

const NUM_GAME = driveGame(1, { contract: TEN_NT });
const SLAM_GAME = driveGame(2, { contract: EIGHT_C, slam: true });
const NULLA_GAME = driveGame(3, { contract: bid(NULLA) });
const DNULLA_GAME = driveGame(4, { contract: bid(DNULLA) });

function foldScores(states: readonly GameState[]): [number, number] {
  const scores: [number, number] = [0, 0];
  for (const s of states) {
    if (s.phase !== 'handScored' || s.handResult === null) continue;
    const d = s.handResult.declarer % 2;
    scores[d] += s.handResult.declarerDelta;
    scores[1 - d] += s.handResult.defenderDelta;
  }
  return scores;
}

describe('scripted full games through applyAction only (AC-1)', () => {
  it('NUM contract runs auction through gameOver', () => {
    const { states, final } = NUM_GAME;
    expect(final.phase).toBe('gameOver');
    expect(final.game.winner).not.toBeNull();
    const play = states.find((s) => s.phase === 'play');
    expect(play?.contract).toEqual(TEN_NT);
    expect(play?.activeSeats).toHaveLength(4);
    expect(states.some((s) => s.phase === 'slamDecision')).toBe(true); // offered, declined
    expect(final.handResult?.slam).toBe(false);
  });

  it('slam contract visits the slam sub-phases and scores a flat 500', () => {
    const { states, final } = SLAM_GAME;
    expect(final.phase).toBe('gameOver');
    expect(states.some((s) => s.phase === 'slamDecision')).toBe(true);
    expect(states.some((s) => s.phase === 'partnerCard')).toBe(true);
    const play = states.find((s) => s.phase === 'play');
    expect(play?.slam).toBe(true);
    expect(play?.activeSeats).toHaveLength(3); // partner sits out
    expect(Math.abs(final.handResult?.declarerDelta ?? 0)).toBe(500);
  });

  it('nulla contract sits the partner out and takes multiple hands', () => {
    const { states, final } = NULLA_GAME;
    expect(final.phase).toBe('gameOver');
    const play = states.find((s) => s.phase === 'play');
    expect(play?.activeSeats).toHaveLength(3);
    expect(play && play.activeSeats.includes(partnerOf(play.declarer as number))).toBe(false);
    expect(final.handNumber).toBeGreaterThan(0); // 250 a hand cannot decide hand 0
    expect(states.some((s) => s.phase === 'slamDecision')).toBe(false); // no slam offer
  });

  it('double nulla passes the discards through and keeps all four seats', () => {
    const { states, final } = DNULLA_GAME;
    expect(final.phase).toBe('gameOver');
    const partnerDiscard = states.find((s) => s.exchange?.phase === 'PARTNER_DISCARD');
    expect(partnerDiscard).toBeDefined();
    const declarer = partnerDiscard?.declarer as number;
    expect(partnerDiscard?.hands[partnerOf(declarer)]).toHaveLength(15);
    const play = states.find((s) => s.phase === 'play');
    expect(play?.activeSeats).toHaveLength(4);
  });

  it('game scores are the fold of every handScored result', () => {
    for (const { states, final } of [NUM_GAME, SLAM_GAME, NULLA_GAME, DNULLA_GAME]) {
      expect(final.game.scores).toEqual(foldScores(states));
      const [a, b] = final.game.scores;
      expect(Math.max(a, b) >= 500 || Math.min(a, b) <= -500).toBe(true);
    }
  });

  it('is deterministic for a given seed and script', () => {
    const again = driveGame(2, { contract: EIGHT_C, slam: true });
    expect(serializeGame(again.final)).toBe(serializeGame(SLAM_GAME.final));
  });
});

describe('serialize round-trip (AC-3)', () => {
  const midStates: [string, GameState | undefined][] = [
    ['mid-auction', NUM_GAME.states.find((s) => s.phase === 'auction' && s.auction?.declarer !== null)],
    ['mid-exchange', NUM_GAME.states.find((s) => s.phase === 'middleExchange')],
    ['slam partnerCard', SLAM_GAME.states.find((s) => s.phase === 'partnerCard')],
    ['dnulla partner discard', DNULLA_GAME.states.find((s) => s.exchange?.phase === 'PARTNER_DISCARD')],
    ['mid-trick', NUM_GAME.states.find((s) => s.phase === 'play' && (s.play?.plays.length ?? 0) > 0)],
    ['hand scored', NULLA_GAME.states.find((s) => s.phase === 'handScored')],
    ['game over', NUM_GAME.final],
  ];

  it.each(midStates)('round-trips a %s state with deep equality', (_label, state) => {
    expect(state).toBeDefined();
    const back = deserializeGame(serializeGame(state as GameState));
    expect(back).toStrictEqual(state);
    // and the revived state is still drivable
    const seat = toActSeat(back);
    if (seat !== null) expect(legalActions(back, seat).length).toBeGreaterThan(0);
  });

  it('rejects payloads that are not a versioned game state', () => {
    expect(() => deserializeGame('42')).toThrow(/serialized game state/);
    expect(() => deserializeGame(JSON.stringify({ v: STATE_FORMAT_VERSION + 1, state: {} }))).toThrow(
      /serialized game state/,
    );
  });
});

describe('turn, seat, and phase validation', () => {
  const start = newGame(0); // dealer 3, first bid to seat 0

  it('rejects an out-of-turn bid with notYourTurn', () => {
    const res = applyAction(start, { type: 'bid', seat: 1, bid: bid(PASS) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('notYourTurn');
  });

  it('rejects a bid at or below the current ladder position', () => {
    const first = applyAction(start, { type: 'bid', seat: 0, bid: bid(NUM, 8, 0) });
    if (!first.ok) throw new Error(first.error.message);
    const low = applyAction(first.state, { type: 'bid', seat: 1, bid: bid(NUM, 7, 0) });
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.error.code).toBe('illegalMove');
  });

  it('rejects a seat outside 0-3', () => {
    const res = applyAction(start, { type: 'bid', seat: 4, bid: bid(PASS) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('badSeat');
  });

  it('rejects actions from the wrong phase with badPhase', () => {
    const res = applyAction(start, { type: 'nextHand', seat: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('badPhase');
  });

  it('rejects a play by a sat-out seat with badSeat', () => {
    const play = NULLA_GAME.states.find((s) => s.phase === 'play') as GameState;
    const satOut = partnerOf(play.declarer as number);
    expect(legalActions(play, satOut)).toEqual([]);
    const card = play.hands[satOut]?.[0] as number;
    const res = applyAction(play, { type: 'playCard', seat: satOut, card });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('badSeat');
  });

  it('rejects jokerSuit on anything but a no-trump joker lead', () => {
    const state = NUM_GAME.states.find(
      (s) => s.phase === 'play' && legalActions(s, toActSeat(s) as number)[0]?.type === 'playCard',
    ) as GameState;
    const seat = toActSeat(state) as number;
    const action = legalActions(state, seat)[0];
    if (action?.type !== 'playCard' || action.card === JOKER) throw new Error('bad fixture');
    const res = applyAction(state, { ...action, jokerSuit: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('illegalMove');
  });

  it('rejects a discard that does not keep exactly 10 cards', () => {
    const state = NUM_GAME.states.find((s) => s.phase === 'middleExchange') as GameState;
    const seat = toActSeat(state) as number;
    const res = applyAction(state, {
      type: 'discardKeeps',
      seat,
      keeps: (state.hands[seat] ?? []).slice(0, 9),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('illegalMove');
  });

  it('freezes every action after gameOver', () => {
    const over = NUM_GAME.final;
    for (let seat = 0; seat < 4; seat++) expect(legalActions(over, seat)).toEqual([]);
    const res = applyAction(over, { type: 'nextHand', seat: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('gameOver');
  });
});

describe('redeal and rotation', () => {
  it('auto-redeals a dead auction, rotating the dealer and keeping scores', () => {
    let state = newGame(7);
    const before = state.hands.map((h) => [...h]);
    for (let i = 0; i < 4; i++) {
      const res = applyAction(state, { type: 'bid', seat: state.auction?.turn as number, bid: bid(PASS) });
      if (!res.ok) throw new Error(res.error.message);
      state = res.state;
    }
    expect(state.phase).toBe('auction');
    expect(state.dealsDrawn).toBe(2);
    expect(state.handNumber).toBe(0); // still the same hand
    expect(state.dealer).toBe(0); // rotated off the default 3
    expect(state.auction?.turn).toBe(1);
    expect(state.game.scores).toEqual([0, 0]);
    expect(state.hands).not.toEqual(before); // a genuinely fresh deal
  });

  it('nextHand rotates the dealer and advances the hand number', () => {
    const scored = NULLA_GAME.states.find((s) => s.phase === 'handScored') as GameState;
    const res = applyAction(scored, { type: 'nextHand', seat: 2 });
    if (!res.ok) throw new Error(res.error.message);
    expect(res.state.phase).toBe('auction');
    expect(res.state.handNumber).toBe(scored.handNumber + 1);
    expect(res.state.dealer).toBe((scored.dealer + 1) % 4);
    expect(res.state.game).toEqual(scored.game);
  });
});

describe('legalActions enumeration', () => {
  it('offers declareSlam/declineSlam to the declarer only', () => {
    const state = NUM_GAME.states.find((s) => s.phase === 'slamDecision') as GameState;
    const declarer = state.declarer as number;
    expect(legalActions(state, declarer).map((a) => a.type)).toEqual([
      'declareSlam',
      'declineSlam',
    ]);
    expect(legalActions(state, (declarer + 1) % 4)).toEqual([]);
  });

  it('offers one giveCard per held card to the slam partner', () => {
    const state = SLAM_GAME.states.find((s) => s.phase === 'partnerCard') as GameState;
    const partner = partnerOf(state.declarer as number);
    const actions = legalActions(state, partner);
    expect(actions).toHaveLength(state.hands[partner]?.length ?? -1);
    expect(actions.every((a) => a.type === 'giveCard')).toBe(true);
  });

  it('offers a single discardKeeps template during the exchange', () => {
    const state = NUM_GAME.states.find((s) => s.phase === 'middleExchange') as GameState;
    const seat = toActSeat(state) as number;
    expect(legalActions(state, seat)).toEqual([{ type: 'discardKeeps', seat, keeps: [] }]);
    expect(legalActions(state, (seat + 1) % 4)).toEqual([]);
  });

  it('offers nextHand to every seat once the hand is scored', () => {
    const state = NULLA_GAME.states.find((s) => s.phase === 'handScored') as GameState;
    for (let seat = 0; seat < 4; seat++) {
      expect(legalActions(state, seat)).toEqual([{ type: 'nextHand', seat }]);
    }
    expect(toActSeat(state)).toBeNull();
  });

  it('expands a no-trump joker lead into four suit-naming actions', () => {
    // Hand-craft the spot: move the joker into the leading seat's hand of a
    // no-trump play state (contract is 10NT, so trump is null).
    const base = NUM_GAME.states.find(
      (s) => s.phase === 'play' && s.play?.ledSuit === null,
    ) as GameState;
    const seat = toActSeat(base) as number;
    if (base.play === null) throw new Error('bad fixture');
    const hands = base.play.hands.map((h, i) =>
      i === seat ? [...h.filter((c) => c !== JOKER), JOKER] : h.filter((c) => c !== JOKER),
    );
    const state: GameState = { ...base, hands, play: { ...base.play, hands } };

    const jokerLeads = legalActions(state, seat).filter(
      (a) => a.type === 'playCard' && a.card === JOKER,
    );
    expect(jokerLeads).toHaveLength(4);
    expect(jokerLeads.map((a) => (a.type === 'playCard' ? a.jokerSuit : -1))).toEqual([0, 1, 2, 3]);

    const led = applyAction(state, jokerLeads[2] as Parameters<typeof applyAction>[1]);
    expect(led.ok).toBe(true);
    if (led.ok) expect(led.state.play?.ledSuit).toBe(2); // the named suit sticks
  });
});
