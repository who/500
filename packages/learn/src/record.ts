/**
 * Building {@link GameRecord}s from live engine state. The recorder is pure
 * (no clock, no I/O) so the server and the headless sim share one code path
 * to the same schema — the caller owns the wall clock, the game id, and the
 * file sink.
 *
 * A hand is captured at `handScored`: its result, tricks, and auction are all
 * on the state, but play has emptied the live hands, so the pristine deal is
 * re-derived from `(seed, dealsDrawn - 1)` via {@link drawDeal}. `dealsDrawn`
 * is cumulative across the game, so the recorder tracks the running total to
 * attribute redeals to the hand that actually threw them in.
 */

import { drawDeal, type GameState } from '@five-hundred/engine';
import {
  SCHEMA_VERSION,
  type GameRecord,
  type HandRecord,
  type PlayerMeta,
} from './schema.js';

export interface GameRecorderMeta {
  readonly source: 'server' | 'sim';
  readonly gameId: string;
  readonly seed: number;
  /** ISO-8601 string, or null/omitted for headless corpora. */
  readonly createdAt?: string | null;
  /** Exactly four seat-indexed entries. */
  readonly players: readonly PlayerMeta[];
}

/**
 * Snapshot one finished hand. `priorDealsDrawn` is the recorder's running
 * `dealsDrawn` total before this hand, so `state.dealsDrawn - priorDealsDrawn
 * - 1` is the number of dead auctions redealt for this hand alone.
 */
export function buildHandRecord(state: GameState, priorDealsDrawn = 0): HandRecord {
  if (
    state.phase !== 'handScored' ||
    state.handResult === null ||
    state.play === null ||
    state.auction === null
  ) {
    throw new Error('buildHandRecord requires a scored hand (phase handScored)');
  }
  const deal = drawDeal(state.seed, state.dealsDrawn - 1);
  const redeals = Math.max(0, state.dealsDrawn - priorDealsDrawn - 1);
  const r = state.handResult;
  return {
    handNumber: state.handNumber,
    dealer: state.dealer,
    firstBidder: (state.dealer + 1) % 4,
    redeals,
    deal: {
      hands: deal.hands.map((h) => [...h]),
      middle: [...deal.middle],
    },
    auction: {
      calls: state.auction.history.map((e) => ({ seat: e.seat, bid: e.bid })),
      indications: state.auction.indications.map((e) => ({ seat: e.seat, bid: e.bid })),
      contract: state.contract,
      declarer: state.declarer,
    },
    slam: state.slam,
    activeSeats: [...state.activeSeats],
    discards: [...state.discards],
    tricks: state.play.tricks.map((t) => ({
      leader: t.leader,
      ledSuit: t.ledSuit,
      plays: t.plays.map((p) => ({ seat: p.seat, card: p.card })),
      winner: t.winner,
    })),
    result: {
      contract: r.contract,
      declarer: r.declarer,
      slam: r.slam,
      made: r.made,
      declarerDelta: r.declarerDelta,
      defenderDelta: r.defenderDelta,
      declarerSideTricks: r.declarerSideTricks,
      defenderSideTricks: r.defenderSideTricks,
    },
    scoresAfter: [state.game.scores[0], state.game.scores[1]],
  };
}

/**
 * Accumulates a game's hands into a {@link GameRecord}. Feed each scored hand
 * to {@link recordHand}, then call {@link finish} with the terminal state.
 */
export class GameRecorder {
  private readonly hands: HandRecord[] = [];
  private dealsDrawn = 0;

  constructor(private readonly meta: GameRecorderMeta) {}

  /** Snapshot a hand at `handScored` (call once per hand, in order). */
  recordHand(state: GameState): void {
    this.hands.push(buildHandRecord(state, this.dealsDrawn));
    this.dealsDrawn = state.dealsDrawn;
  }

  /** Number of hands captured so far. */
  get handCount(): number {
    return this.hands.length;
  }

  /** Assemble the record from the terminal (or last-seen) game state. */
  finish(state: GameState): GameRecord {
    return {
      v: SCHEMA_VERSION,
      source: this.meta.source,
      gameId: this.meta.gameId,
      seed: this.meta.seed,
      createdAt: this.meta.createdAt ?? null,
      players: this.meta.players.map((p) => ({ ...p })),
      hands: [...this.hands],
      winner: state.game.winner,
      finalScores: [state.game.scores[0], state.game.scores[1]],
    };
  }
}
