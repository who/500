/**
 * Opt-in JSONL game logging for the server (fh-sja.2). Off unless explicitly
 * enabled; when enabled, every finished game appends one GameRecord to a
 * corpus file using the shared packages/learn schema. Hand snapshots and the
 * final record are built by the same recorder the headless sim uses — this
 * module only supplies the env-driven config, the per-seat policy metadata,
 * and the file sink.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { GameState } from '@five-hundred/engine';
import type { GameLogHand } from '@five-hundred/protocol';
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

/**
 * Condense one scored hand into its game-log summary row (fh-y2a.2): dealer,
 * the live auction in call order, each trick's leader and winner, and the
 * running totals. Pure and independent of the JSONL logger, so the client's
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
    tricks: state.play.tricks.map((t) => ({ leader: t.leader, winner: t.winner })),
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

  constructor(
    private readonly path: string,
    seed: number,
    players: readonly PlayerMeta[],
    private readonly store: GameStore | null = null,
  ) {
    this.recorder = new GameRecorder({
      source: 'server',
      gameId: randomUUID(),
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
