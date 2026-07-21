/**
 * Authoritative game loop (PRD section 5 "Validation" / "Game loop"): maps
 * protocol game commands onto engine actions for the sender's bound seat,
 * validates them through applyAction, and broadcasts per-seat redacted views.
 * All hidden-information redaction happens exclusively through the engine's
 * redactedView — this module never hand-builds a view.
 *
 * Seq discipline: every state advance consumes one seq for the gameView wave
 * and one for the actionRequest wave. A wave delivers one envelope per seated
 * client, all stamped with the same seq but carrying that seat's own payload,
 * so every seated client sees the identical gap-free seq stream. actionRequest
 * therefore goes to every seated seat with its own legalActions — empty unless
 * that seat holds the turn — rather than only to the actor (a seq delivered to
 * one socket would read as a gap on every other). Phase-transition events
 * (trickResolved, handScored, gameOver) are identical for everyone and use a
 * plain one-seq broadcast; typed rejections are seq-less and private to the
 * sender, changing nothing.
 */

import { randomInt } from 'node:crypto';
import {
  applyAction,
  legalActions,
  newGame,
  redactedView,
  type Action,
  type ApplyResult,
  type EngineErrorCode,
  type GameState,
} from '@five-hundred/engine';
import type {
  ClientCommand,
  Envelope,
  ErrorCode,
  StateBearingEvent,
} from '@five-hundred/protocol';
import type { Room, RoomClient } from './rooms.js';

/** Game commands: everything ws.ts does not route to the room lifecycle. */
export type GameCommand = Extract<
  ClientCommand,
  {
    t:
      | 'bid'
      | 'discardKeeps'
      | 'declareSlam'
      | 'declineSlam'
      | 'giveCard'
      | 'playCard'
      | 'nextHand'
      | 'requestState';
  }
>;

/** The live game a Room's `game` slot holds once startGame has run. */
export interface GameSession {
  readonly kind: 'gameSession';
  /** RNG seed for the whole game, recorded for debugging/reproduction. */
  readonly seed: number;
  state: GameState;
  /** Human seats that have readied up for the next hand (PRD section 6.1). */
  readonly ready: Set<number>;
}

export function isGameSession(game: unknown): game is GameSession {
  return (
    typeof game === 'object' &&
    game !== null &&
    (game as { kind?: unknown }).kind === 'gameSession'
  );
}

/**
 * RoomStore startGame hook: seed a fresh engine game and send every seated
 * client its opening view. The seq-stamped envelopes precede the started
 * roomState the store broadcasts right after; both orders rebuild the same
 * client state.
 */
export function createGameSession(room: Room, seed: number = randomInt(0, 2 ** 32)): GameSession {
  const session: GameSession = { kind: 'gameSession', seed, state: newGame(seed), ready: new Set() };
  broadcastGameViews(room, session.state);
  broadcastActionRequests(room, session.state);
  return session;
}

/** Stamp one seq and deliver the identical event to every connected client. */
function broadcastAll(room: Room, event: StateBearingEvent): void {
  const envelope: Envelope = { seq: room.seq++, event };
  for (const client of room.clients) client.send(envelope);
}

/** Stamp one seq and deliver each seated client its own per-seat payload. */
function broadcastPerSeat(room: Room, make: (seat: number) => StateBearingEvent): void {
  const seq = room.seq++;
  for (const client of room.clients) {
    if (client.seat === null) continue;
    client.send({ seq, event: make(client.seat) });
  }
}

function broadcastGameViews(room: Room, state: GameState): void {
  broadcastPerSeat(room, (seat) => ({
    t: 'gameView',
    view: { view: redactedView(state, seat) },
  }));
}

function broadcastActionRequests(room: Room, state: GameState): void {
  broadcastPerSeat(room, (seat) => ({
    t: 'actionRequest',
    seat,
    actions: legalActions(state, seat),
  }));
}

/** Broadcast one state advance: transition events, then views, then requests. */
function broadcastAdvance(room: Room, prev: GameState, next: GameState): void {
  const prevTricks = prev.play?.tricks.length ?? 0;
  const nextTricks = next.play?.tricks.length ?? 0;
  if (next.play !== null && prev.play !== null && nextTricks > prevTricks) {
    const trick = next.play.tricks[nextTricks - 1];
    if (trick !== undefined) broadcastAll(room, { t: 'trickResolved', trick });
  }
  if (next.phase === 'handScored' && prev.phase !== 'handScored' && next.handResult !== null) {
    broadcastAll(room, { t: 'handScored', result: next.handResult, scores: next.game.scores });
  }
  if (next.phase === 'gameOver' && prev.phase !== 'gameOver' && next.game.winner !== null) {
    broadcastAll(room, { t: 'gameOver', winner: next.game.winner, scores: next.game.scores });
  }
  broadcastGameViews(room, next);
  broadcastActionRequests(room, next);
}

/**
 * The single validated apply path — human commands, the test harness, and the
 * bot driver (next leaf) all go through here. On success the room's session
 * advances and the broadcast wave goes out; on failure nothing changes and no
 * seq is consumed.
 */
export function applyGameAction(room: Room, action: Action): ApplyResult {
  const session = room.game;
  if (!isGameSession(session)) {
    return {
      ok: false,
      error: { code: 'badPhase', message: 'the room has no running game' },
    };
  }
  const prev = session.state;
  const result = applyAction(prev, action);
  if (!result.ok) return result;
  session.state = result.state;
  if (prev.phase === 'handScored') session.ready.clear();
  room.lastActivity = Date.now();
  broadcastAdvance(room, prev, result.state);
  return result;
}

function sendError(client: RoomClient, code: ErrorCode, message: string): void {
  client.send({ event: { t: 'error', code, message } });
}

/** Engine rejection -> protocol error code. */
function protocolErrorCode(code: EngineErrorCode): ErrorCode {
  return code === 'notYourTurn' ? 'notYourTurn' : 'illegalAction';
}

/** Protocol command -> engine action for the sender's bound seat. */
function toAction(cmd: Exclude<GameCommand, { t: 'nextHand' | 'requestState' }>, seat: number): Action {
  switch (cmd.t) {
    case 'bid':
      return { type: 'bid', seat, bid: cmd.bid };
    case 'discardKeeps':
      return { type: 'discardKeeps', seat, keeps: cmd.keeps };
    case 'declareSlam':
      return { type: 'declareSlam', seat };
    case 'declineSlam':
      return { type: 'declineSlam', seat };
    case 'giveCard':
      return { type: 'giveCard', seat, card: cmd.card };
    case 'playCard':
      return cmd.jokerSuit === undefined
        ? { type: 'playCard', seat, card: cmd.card }
        : { type: 'playCard', seat, card: cmd.card, jokerSuit: cmd.jokerSuit };
  }
}

/**
 * nextHand is a ready-up, not a direct engine action: every human seat must
 * send it before the hand advances (bot seats are auto-ready). Re-sends are
 * idempotent. The engine's nextHand applies once, on behalf of the last seat
 * to ready.
 */
function handleNextHand(room: Room, session: GameSession, seat: number, client: RoomClient): void {
  if (session.state.phase !== 'handScored') {
    sendError(client, 'illegalAction', 'There is no finished hand to advance from.');
    return;
  }
  session.ready.add(seat);
  const humanSeats = [0, 1, 2, 3].filter((s) => room.seats[s]?.kind === 'human');
  if (humanSeats.every((s) => session.ready.has(s))) {
    applyGameAction(room, { type: 'nextHand', seat });
  }
}

/**
 * Resend the sender's full current view, stamped with the last-consumed seq
 * (a fresh seq spent on one socket would gap every other client). The client
 * treats a full view as a new seq baseline.
 */
function handleRequestState(room: Room, session: GameSession, seat: number, client: RoomClient): void {
  client.send({
    seq: Math.max(0, room.seq - 1),
    event: { t: 'gameView', view: { view: redactedView(session.state, seat) } },
  });
}

/**
 * Entry point for game commands from ws.ts: resolve the sender's seat (bound
 * at sit time via its token), map to an engine action, validate, broadcast.
 * Failures send a typed error to the sender only and leave state (and seq)
 * untouched.
 */
export function handleGameCommand(client: RoomClient, cmd: GameCommand): void {
  const room = client.room;
  if (room === null) {
    sendError(client, 'badCommand', 'Not in a room.');
    return;
  }
  const session = room.game;
  if (!isGameSession(session)) {
    sendError(client, 'badCommand', 'The game has not started.');
    return;
  }
  const seat = client.seat;
  if (seat === null || room.seats[seat]?.kind !== 'human') {
    sendError(client, 'badToken', 'No seat is bound to this connection.');
    return;
  }
  room.lastActivity = Date.now();
  switch (cmd.t) {
    case 'requestState':
      handleRequestState(room, session, seat, client);
      return;
    case 'nextHand':
      handleNextHand(room, session, seat, client);
      return;
    default: {
      const result = applyGameAction(room, toAction(cmd, seat));
      if (!result.ok) {
        sendError(client, protocolErrorCode(result.error.code), result.error.message);
      }
    }
  }
}
