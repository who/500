/**
 * Opt-in JSONL game logging for the server (fh-sja.2). Off unless explicitly
 * enabled; when enabled, every finished game appends one GameRecord to a
 * corpus file using the shared packages/learn schema. Hand snapshots and the
 * final record are built by the same recorder the headless sim uses — this
 * module only supplies the env-driven config, the per-seat policy metadata,
 * and the file sink.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isLoseAll, type GameState } from '@five-hundred/engine';
import type { GameLogHand, RateBotsCommand } from '@five-hundred/protocol';
import { PARAMS_SCHEMA_VERSION } from '@five-hundred/bots';
import {
  GameRecorder,
  appendGameRecordSync,
  createGameStore,
  type GameMarker,
  type GameStore,
  type PlayerMeta,
  type PolicyKind,
} from '@five-hundred/learn';
import { OVERLAY_VERSION } from './botParams.js';
import type { Room } from './rooms.js';

/** Longest note a trick flag may carry; anything longer is truncated. */
export const MAX_MARKER_NOTE = 200;

/** Where bot-feedback verdicts land, beside the game corpus (fh-y2a.3). */
export const FEEDBACK_FILE = 'feedback.jsonl';

export interface GameLogConfig {
  readonly enabled: boolean;
  readonly dir: string;
  readonly file: string;
}

/**
 * Resolve logging config from the environment. Logging is ON by default so a
 * game corpus accumulates for the learning pipeline (fh-sja); set
 * `FH_GAME_LOG` to `0`/`false` to opt out. The directory and filename have
 * safe defaults.
 */
export function resolveGameLogConfig(env: NodeJS.ProcessEnv = process.env): GameLogConfig {
  const flag = env.FH_GAME_LOG;
  const enabled = flag !== '0' && flag !== 'false';
  return {
    enabled,
    dir: env.FH_GAME_LOG_DIR ?? 'logs/games',
    file: env.FH_GAME_LOG_FILE ?? 'games.jsonl',
  };
}

/** Total tricks in a hand — the ceiling the bidders' count is measured against. */
const TRICKS_PER_HAND = 10;

/**
 * The trick at whose completion the bidders' set became certain (fh-jj0), or
 * null for a made hand. Mirrors the client's biddersAreSet math over the
 * hand's own trick list: a lose-all contract is set by the first trick forced
 * onto the bidders, a declared slam plays for all ten however it was bid, and
 * a numbered contract is set once the tricks still to come can no longer
 * reach its level. A set the play never made certain early — the rare one
 * that only fails on the last card — falls back to the final trick, because
 * the scored hand is the authority on whether the contract was made at all.
 */
function setPointOf(state: GameState): number | null {
  const contract = state.contract;
  const tricks = state.play?.tricks ?? [];
  if (contract === null || state.declarer === null || tricks.length === 0) return null;
  const result = state.handResult;
  if (result !== null && result.made) return null;
  const declSide = state.declarer % 2;
  const target = state.slam ? TRICKS_PER_HAND : contract.level;
  let bidderTricks = 0;
  let defenderTricks = 0;
  for (const [i, trick] of tricks.entries()) {
    if (trick.winner % 2 === declSide) bidderTricks += 1;
    else defenderTricks += 1;
    const set = isLoseAll(contract)
      ? bidderTricks >= 1
      : TRICKS_PER_HAND - defenderTricks < target;
    if (set) return i;
  }
  // Never certain in flight; the engine's verdict decides, and a set it only
  // confirmed at the end belongs to the last trick played.
  return result !== null && !result.made ? tricks.length - 1 : null;
}

/**
 * Condense one scored hand into its game-log summary row (fh-y2a.2): dealer,
 * the live auction in call order, each trick's leader, winner, and cards in
 * play order (fh-0au), and the running totals. Pure and independent of the
 * JSONL logger, so the client's
 * game-log view is populated even when disk logging is opted out.
 * `priorDealsDrawn` is the cumulative dealsDrawn before this hand, making the
 * difference (less the live deal) the hand's own thrown-in auctions.
 */
export function summarizeHand(state: GameState, priorDealsDrawn = 0): GameLogHand {
  if (state.phase !== 'handScored' || state.auction === null || state.play === null) {
    throw new Error('summarizeHand requires a scored hand (phase handScored)');
  }
  return {
    handNumber: state.handNumber,
    dealer: state.dealer,
    redeals: Math.max(0, state.dealsDrawn - priorDealsDrawn - 1),
    auction: state.auction.history.map((e) => ({ seat: e.seat, bid: e.bid })),
    slam: state.slam,
    tricks: state.play.tricks.map((t) => ({
      leader: t.leader,
      winner: t.winner,
      plays: t.plays.map((p) => ({ seat: p.seat, card: p.card })),
    })),
    setFromTrick: setPointOf(state),
    scores: [state.game.scores[0], state.game.scores[1]],
  };
}

/** A seat's log-schema policy kind: 'human', or the bot's difficulty tier. */
function seatKind(room: Room, seat: number): PolicyKind {
  const s = room.seats[seat];
  return s !== undefined && s.kind === 'human' ? 'human' : (s?.difficulty ?? 'medium');
}

/**
 * Accumulates a game's hands and writes one JSONL line at game end. Feed each
 * scored hand to {@link recordHand} and the terminal state to {@link finish}.
 */
export class GameLogger {
  private readonly recorder: GameRecorder;

  /** Corpus key for this game; feedback lines join on it (fh-y2a.3). */
  readonly gameId: string;

  constructor(
    private readonly path: string,
    seed: number,
    players: readonly PlayerMeta[],
    private readonly store: GameStore | null = null,
  ) {
    this.gameId = randomUUID();
    this.recorder = new GameRecorder({
      source: 'server',
      gameId: this.gameId,
      seed,
      createdAt: new Date().toISOString(),
      players,
    });
  }

  recordHand(state: GameState): void {
    this.recorder.recordHand(state);
  }

  /**
   * Pin a trick a player flagged (fh-q2m). Held in the in-progress recorder
   * and written with the finished record — never appended mid-game, which
   * would leave a partial duplicate line in the corpus. The wall clock lives
   * here because the recorder itself is pure.
   */
  flagTrick(flag: Omit<GameMarker, 'at'>): void {
    const note = flag.note?.trim().slice(0, MAX_MARKER_NOTE);
    const held = flag.heldCards;
    const played = flag.flaggedPlay;
    this.recorder.addMarker({
      hand: flag.hand,
      trick: flag.trick,
      seat: flag.seat,
      ...(played === undefined ? {} : { flaggedPlay: { ...played } }),
      ...(note === undefined || note === '' ? {} : { note }),
      ...(held === undefined || held.length === 0 ? {} : { heldCards: [...held] }),
      at: new Date().toISOString(),
    });
  }

  /** Markers flagged so far this game (test/inspection hook). */
  get markers(): readonly GameMarker[] {
    return this.recorder.flaggedMarkers;
  }

  /**
   * Append one thumbs verdict on the bots (fh-y2a.3) beside the corpus,
   * keyed by gameId so analysis can join it to the recorded game. Append-only
   * like the corpus itself: a repeat verdict from the same seat lands as a
   * newer line and wins at read time. Best-effort — a write failure is logged
   * and dropped, never thrown into the room.
   */
  appendFeedback(seat: number, verdict: RateBotsCommand['verdict']): void {
    const line = JSON.stringify({
      type: 'botFeedback',
      gameId: this.gameId,
      seat,
      verdict,
      at: new Date().toISOString(),
    });
    try {
      const dir = dirname(this.path);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, FEEDBACK_FILE), line + '\n');
    } catch (err) {
      console.error('bot-feedback write failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Append the finished game to the corpus (best-effort; logs on failure). */
  finish(state: GameState): void {
    const record = this.recorder.finish(state);
    try {
      appendGameRecordSync(this.path, record);
    } catch (err) {
      console.error('game-log write failed:', err instanceof Error ? err.message : err);
    }
    if (this.store === null) return;
    try {
      void this.store.putGame(record).catch((err: unknown) => {
        console.error('game-log store upload failed:', err instanceof Error ? err.message : err);
      });
    } catch (err) {
      console.error('game-log store upload failed:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Build a logger for a game, or null when logging is disabled. Seat metadata
 * is captured at game start (empty seats have already been converted to bots).
 */
export function createGameLogger(
  room: Room,
  seed: number,
  config: GameLogConfig,
  store?: GameStore | null,
): GameLogger | null {
  if (!config.enabled) return null;
  const resolved = store !== undefined ? store : createGameStore(process.env);
  const players: PlayerMeta[] = [0, 1, 2, 3].map((seat) => ({
    seat,
    kind: seatKind(room, seat),
    paramsSchemaVersion: PARAMS_SCHEMA_VERSION,
    overlayHash: OVERLAY_VERSION,
  }));
  return new GameLogger(join(config.dir, config.file), seed, players, resolved);
}
