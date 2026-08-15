/**
 * Hand and game scoring — ports the scoring tail of play_hand
 * (five_hundred.py 493-510) and the game loop of play_game (537-555).
 *
 * Scoring branches, in oracle order:
 *   lose-all (nulla/dnulla)  made = declarer side took 0 tricks;
 *                            defenders score 10 per trick FORCED ONTO the
 *                            bidding side.
 *   slam                     made = all 10 tricks; ±500 even
 *                            when 9 tricks were taken.
 *   NUM                      made = declarer tricks >= level.
 *
 * Game: first side to +500 wins; a side at exactly -500 goes out the back.
 * When both sides cross +500 in the same hand the declarer side is checked
 * first (documented oracle assumption, five_hundred.py 26-30) — a side can
 * also win on defender points alone.
 */

import type { Bid } from './bids.js';
import { bidValue, isLoseAll } from './bids.js';
import type { PlayState } from './play.js';
import { playDone } from './play.js';

export const WIN_SCORE = 500;
export const OUT_THE_BACK = -500;

export interface HandResult {
  readonly contract: Bid;
  readonly declarer: number;
  readonly slam: boolean;
  readonly made: boolean;
  readonly declarerDelta: number;
  readonly defenderDelta: number;
  readonly declarerSideTricks: number;
  readonly defenderSideTricks: number;
}

/** Score a finished hand from the per-side trick counts. */
export function scoreHand(
  contract: Bid,
  declarer: number,
  slam: boolean,
  sideTricks: readonly [number, number],
): HandResult {
  const declSide = declarer % 2;
  const declTricks = declSide === 0 ? sideTricks[0] : sideTricks[1];
  const defTricks = declSide === 0 ? sideTricks[1] : sideTricks[0];
  const value = bidValue(contract);

  let made: boolean;
  let declarerDelta: number;
  let defenderDelta: number;
  if (isLoseAll(contract)) {
    made = declTricks === 0;
    declarerDelta = made ? value : -value;
    defenderDelta = 10 * declTricks; // tricks forced onto bidders
  } else if (slam) {
    made = declTricks === 10;
    declarerDelta = made ? 500 : -500;
    defenderDelta = 10 * defTricks;
  } else {
    made = declTricks >= contract.level;
    declarerDelta = made ? value : -value;
    defenderDelta = 10 * defTricks;
  }
  return {
    contract,
    declarer,
    slam,
    made,
    declarerDelta,
    defenderDelta,
    declarerSideTricks: declTricks,
    defenderSideTricks: defTricks,
  };
}

/** Score a completed play state directly. */
export function scorePlay(state: PlayState, slam: boolean): HandResult {
  if (!playDone(state)) throw new Error('cannot score before all 10 tricks are played');
  return scoreHand(state.contract, state.declarer, slam, state.sideTricks);
}

export interface GameScore {
  /** Cumulative points per side (index = seat % 2). */
  readonly scores: readonly [number, number];
  /** Winning side once the game is over, null while it runs. */
  readonly winner: number | null;
}

export function initGame(): GameScore {
  return { scores: [0, 0], winner: null };
}

/**
 * Fold a hand result into the game score, mirroring play_game's check
 * order: declarer side to +500 first, then defenders to +500, then
 * declarer side out the back (opponents win), then defenders out the back.
 */
export function applyHandResult(game: GameScore, result: HandResult): GameScore {
  if (game.winner !== null) throw new Error('game is already over');
  const d = result.declarer % 2;
  const scores: [number, number] =
    d === 0
      ? [game.scores[0] + result.declarerDelta, game.scores[1] + result.defenderDelta]
      : [game.scores[0] + result.defenderDelta, game.scores[1] + result.declarerDelta];
  const declScore = d === 0 ? scores[0] : scores[1];
  const defScore = d === 0 ? scores[1] : scores[0];

  let winner: number | null = null;
  if (declScore >= WIN_SCORE) winner = d;
  else if (defScore >= WIN_SCORE) winner = 1 - d;
  else if (declScore <= OUT_THE_BACK) winner = 1 - d;
  else if (defScore <= OUT_THE_BACK) winner = d;
  return { scores, winner };
}
