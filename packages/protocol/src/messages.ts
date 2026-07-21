/**
 * Wire protocol — every client→server command and server→client event
 * (PRD section 5). All messages are plain JSON discriminated on `t`.
 *
 * Commands carry no seat: the server binds each connection to a seat via the
 * join token and injects it when building engine actions. Deviations from the
 * PRD command list (recorded in issue fh-kum.1): `chooseJokerSuit` is not a
 * standalone command — the engine models it as the `jokerSuit` field of
 * playCard, so the protocol matches; `declineSlam` (explicit exchange
 * progression) and `requestState` (full-view recovery after a seq gap) are
 * additions.
 */

import type { Action, Bid, Card, HandResult, Trick } from '@five-hundred/engine';
import type { BotDifficulty, RoomView, SeatGameView } from './views.js';

// ---------------------------------------------------------------------------
// Client → server commands
// ---------------------------------------------------------------------------

export interface CreateRoomCommand {
  readonly t: 'createRoom';
  /** Display name of the creating player (becomes the host). */
  readonly name: string;
}

export interface JoinRoomCommand {
  readonly t: 'joinRoom';
  readonly roomCode: string;
  readonly name: string;
  /** Per-seat secret from a previous join; present only when reconnecting. */
  readonly token?: string;
}

export interface SitCommand {
  readonly t: 'sit';
  readonly seat: number;
}

export interface BotSeatConfig {
  readonly seat: number;
  readonly difficulty: BotDifficulty;
}

/** Host only: assign a difficulty to each listed bot/empty seat. */
export interface ConfigureBotsCommand {
  readonly t: 'configureBots';
  readonly bots: readonly BotSeatConfig[];
}

/** Host only: start the game; empty seats become bots at their difficulty. */
export interface StartGameCommand {
  readonly t: 'startGame';
}

export interface BidCommand {
  readonly t: 'bid';
  readonly bid: Bid;
}

/** The 10 cards to keep out of the 15 held during the middle exchange. */
export interface DiscardKeepsCommand {
  readonly t: 'discardKeeps';
  readonly keeps: readonly Card[];
}

export interface DeclareSlamCommand {
  readonly t: 'declareSlam';
}

export interface DeclineSlamCommand {
  readonly t: 'declineSlam';
}

/** Slam partner surrenders one card to the declarer. */
export interface GiveCardCommand {
  readonly t: 'giveCard';
  readonly card: Card;
}

export interface PlayCardCommand {
  readonly t: 'playCard';
  readonly card: Card;
  /** Required exactly when leading the joker with no trump suit. */
  readonly jokerSuit?: number;
}

export interface NextHandCommand {
  readonly t: 'nextHand';
}

/** Ask for a fresh full view after detecting a sequence-number gap. */
export interface RequestStateCommand {
  readonly t: 'requestState';
}

export type ClientCommand =
  | CreateRoomCommand
  | JoinRoomCommand
  | SitCommand
  | ConfigureBotsCommand
  | StartGameCommand
  | BidCommand
  | DiscardKeepsCommand
  | DeclareSlamCommand
  | DeclineSlamCommand
  | GiveCardCommand
  | PlayCardCommand
  | NextHandCommand
  | RequestStateCommand;

export type CommandType = ClientCommand['t'];

// ---------------------------------------------------------------------------
// Server → client events
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  'badCommand', // unparseable or malformed message
  'notYourTurn',
  'illegalAction', // right turn, but the move is illegal per legalActions
  'badRoomCode',
  'seatTaken',
  'notHost',
  'badToken',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface RoomStateEvent {
  readonly t: 'roomState';
  readonly room: RoomView;
}

export interface GameViewEvent {
  readonly t: 'gameView';
  readonly view: SeatGameView;
}

/** The receiving seat must act; `actions` come straight from legalActions. */
export interface ActionRequestEvent {
  readonly t: 'actionRequest';
  readonly seat: number;
  readonly actions: readonly Action[];
}

export interface TrickResolvedEvent {
  readonly t: 'trickResolved';
  readonly trick: Trick;
}

export interface HandScoredEvent {
  readonly t: 'handScored';
  readonly result: HandResult;
  /** Running game totals per side (index = seat % 2). */
  readonly scores: readonly [number, number];
}

export interface GameOverEvent {
  readonly t: 'gameOver';
  /** Winning side (0 or 1). */
  readonly winner: number;
  readonly scores: readonly [number, number];
}

export interface ErrorEvent {
  readonly t: 'error';
  readonly code: ErrorCode;
  readonly message: string;
}

/**
 * Sent only to the socket that claimed a seat: its per-seat secret token for
 * later reconnection. Private to one connection, so — like errors — it never
 * consumes a room seq (a per-room seq spent on one socket would look like a
 * gap to every other client).
 */
export interface SeatGrantedEvent {
  readonly t: 'seatGranted';
  readonly seat: number;
  readonly token: string;
}

/** Every event that reflects room/game state and therefore consumes a seq. */
export type StateBearingEvent =
  | RoomStateEvent
  | GameViewEvent
  | ActionRequestEvent
  | TrickResolvedEvent
  | HandScoredEvent
  | GameOverEvent;

/** Events addressed to a single socket; their envelopes may omit seq. */
export type PrivateEvent = ErrorEvent | SeatGrantedEvent;

export type ServerEvent = StateBearingEvent | PrivateEvent;

export type EventType = ServerEvent['t'];

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Every server event travels inside an envelope. `seq` is per-room and
 * increments on every state-bearing event so clients can detect gaps and
 * send requestState; errors and other single-socket events are turn-local,
 * so their envelopes may omit it. The union shape makes the seq requirement
 * a compile error to violate. Receivers must tolerate unknown extra fields
 * on the envelope.
 */
export type Envelope =
  | { readonly seq: number; readonly event: StateBearingEvent }
  | { readonly seq?: number; readonly event: PrivateEvent };
