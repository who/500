/**
 * Per-seat view types — what the server tells each client about a room and a
 * running game (PRD section 5). Everything here is JSON-serializable and
 * already redacted: nothing in these types may carry a card id from another
 * seat's hand, the middle, or the discards.
 */

import type { RedactedView } from '@five-hundred/engine';

export const BOT_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number];

export type SeatOccupant = 'human' | 'bot' | 'empty';

export interface RoomSeatView {
  readonly seat: number;
  readonly occupant: SeatOccupant;
  /** Display name; null unless a human holds the seat. */
  readonly name: string | null;
  /**
   * Bot difficulty for bot seats, and for empty seats the difficulty the
   * bot will play at when the game starts; null for human seats.
   */
  readonly difficulty: BotDifficulty | null;
  /** Humans only: false while disconnected (game paused). Bots are true. */
  readonly connected: boolean;
}

export interface RoomView {
  readonly roomCode: string;
  /** Seat held by the host, null until the host has sat down. */
  readonly hostSeat: number | null;
  /** Always exactly 4 entries, indexed by seat. */
  readonly seats: readonly RoomSeatView[];
  readonly started: boolean;
  /**
   * True while the acting seat belongs to a disconnected human: the server
   * makes no progress until they reconnect or the host converts the seat to
   * a bot. Always false when no game is running or a bot holds the turn.
   */
  readonly paused: boolean;
}

/**
 * One seat's view of the running game: the engine redacted view wrapped so
 * the payload can grow (pacing hints, etc.) without touching engine types.
 * The sequence number lives on the Envelope, not here.
 */
export interface SeatGameView {
  readonly view: RedactedView;
}
