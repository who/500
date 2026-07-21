import { describe, expect, it } from 'vitest';
import {
  DNULLA,
  NULLA,
  NUM,
  NT,
  applyHandResult,
  bid,
  initGame,
  scoreHand,
} from '../src/index.js';

// Avondale values used below: 7S=140, 8S=240, 8D=280, 8H=300, 8NT=320.

describe('scoreHand — NUM contracts (AC-1)', () => {
  it('made when declarer tricks reach the level', () => {
    const r = scoreHand(bid(NUM, 8, 2), 0, false, [8, 2]);
    expect(r).toMatchObject({
      made: true,
      declarerDelta: 280,
      defenderDelta: 20,
      declarerSideTricks: 8,
      defenderSideTricks: 2,
    });
  });

  it('made exactly at the level', () => {
    const r = scoreHand(bid(NUM, 7, 0), 1, false, [3, 7]); // declarer seat 1 = side 1
    expect(r).toMatchObject({ made: true, declarerDelta: 140, defenderDelta: 30 });
  });

  it('set one short of the level', () => {
    const r = scoreHand(bid(NUM, 8, 2), 0, false, [7, 3]);
    expect(r).toMatchObject({ made: false, declarerDelta: -280, defenderDelta: 30 });
  });
});

describe('scoreHand — lose-all contracts (AC-1)', () => {
  it('nulla made: zero declarer tricks', () => {
    const r = scoreHand(bid(NULLA), 1, false, [10, 0]);
    expect(r).toMatchObject({ made: true, declarerDelta: 250, defenderDelta: 0 });
  });

  it('nulla set: defenders score 10 per trick forced onto the declarer side', () => {
    const r = scoreHand(bid(NULLA), 0, false, [2, 8]);
    expect(r).toMatchObject({ made: false, declarerDelta: -250, defenderDelta: 20 });
  });

  it('double nulla made and set', () => {
    expect(scoreHand(bid(DNULLA), 0, false, [0, 10])).toMatchObject({
      made: true,
      declarerDelta: 500,
      defenderDelta: 0,
    });
    expect(scoreHand(bid(DNULLA), 0, false, [3, 7])).toMatchObject({
      made: false,
      declarerDelta: -500,
      defenderDelta: 30,
    });
  });
});

describe('scoreHand — slams (AC-1)', () => {
  it('made slam scores value + 250', () => {
    const r = scoreHand(bid(NUM, 8, 3), 0, true, [10, 0]);
    expect(r).toMatchObject({ made: true, declarerDelta: 550, defenderDelta: 0 });
  });

  it('failed slam loses value + 250 even with 9 tricks taken', () => {
    const r = scoreHand(bid(NUM, 8, 3), 0, true, [9, 1]);
    expect(r).toMatchObject({ made: false, declarerDelta: -550, defenderDelta: 10 });
  });
});

describe('game accumulation', () => {
  it('accumulates hand deltas and stays live below the thresholds', () => {
    let game = initGame();
    game = applyHandResult(game, scoreHand(bid(NUM, 8, 2), 0, false, [8, 2]));
    expect(game).toEqual({ scores: [280, 20], winner: null });
    game = applyHandResult(game, scoreHand(bid(NUM, 7, 0), 1, false, [3, 7]));
    expect(game).toEqual({ scores: [310, 160], winner: null });
  });

  it('first side to +500 wins', () => {
    const game = applyHandResult(
      { scores: [420, 0], winner: null },
      scoreHand(bid(NUM, 8, 2), 2, false, [8, 2]), // seat 2 = side 0
    );
    expect(game).toEqual({ scores: [700, 20], winner: 0 });
  });

  it('a side can win on defender points alone', () => {
    const game = applyHandResult(
      { scores: [0, 470], winner: null },
      scoreHand(bid(NUM, 7, 0), 0, false, [6, 4]),
    );
    expect(game).toEqual({ scores: [-140, 510], winner: 1 });
  });

  it('both sides crossing +500 in one hand resolves for the declarer side (AC-2)', () => {
    // Declarer side 0: 460 + 280 = 740; defenders: 480 + 20 = 500. Both
    // cross, declarer side is checked first.
    const declarerSide0 = applyHandResult(
      { scores: [460, 480], winner: null },
      scoreHand(bid(NUM, 8, 2), 0, false, [8, 2]),
    );
    expect(declarerSide0).toEqual({ scores: [740, 500], winner: 0 });

    // Mirrored: declarer on side 1 wins the same shape.
    const declarerSide1 = applyHandResult(
      { scores: [480, 460], winner: null },
      scoreHand(bid(NUM, 8, 2), 1, false, [2, 8]),
    );
    expect(declarerSide1).toEqual({ scores: [500, 740], winner: 1 });
  });

  it('a side at exactly -500 goes out the back', () => {
    const game = applyHandResult(
      { scores: [-250, 100], winner: null },
      scoreHand(bid(NULLA), 0, false, [2, 8]),
    );
    expect(game).toEqual({ scores: [-500, 120], winner: 1 });
  });

  it('defenders going out the back hands the declarer side the game', () => {
    const game = applyHandResult(
      { scores: [100, -280], winner: null },
      scoreHand(bid(NUM, 8, NT), 1, false, [7, 3]), // side 1 set for 320
    );
    expect(game).toEqual({ scores: [170, -600], winner: 0 });
  });

  it('refuses to score onto a finished game', () => {
    const done = { scores: [520, 0] as [number, number], winner: 0 };
    expect(() => applyHandResult(done, scoreHand(bid(NULLA), 0, false, [10, 0]))).toThrow(
      'already over',
    );
  });
});
