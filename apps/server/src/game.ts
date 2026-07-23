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
  toActSeat,
  type Action,
  type ApplyResult,
  type Card,
  type EngineErrorCode,
  type GameState,
} from '@five-hundred/engine';
import type {
  ClientCommand,
  ConvertSeatToBotCommand,
  Envelope,
  ErrorCode,
  FlagTrickCommand,
  StateBearingEvent,
} from '@five-hundred/protocol';
import { BotDriver, type BotDriverOptions } from './botDriver.js';
import { createGameLogger, resolveGameLogConfig, type GameLogConfig, type GameLogger } from './gameLog.js';
import { DEFAULT_DIFFICULTY, isPaused, roomView, type Room, type RoomClient } from './rooms.js';

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
  /** Bot turn driver, null when the session runs without one (test stubs). */
  driver: BotDriver | null;
  /** Opt-in JSONL game logger, null when logging is disabled (the default). */
  logger: GameLogger | null;
  /** Whose turn it is; rooms.ts duck-types this for the paused flag. */
  actingSeat(): number | null;
  /** True once the game reached gameOver; rooms.ts duck-types this for rematch. */
  isOver(): boolean;
  /** Cancel pending bot timers; rooms.ts calls this when deleting the room. */
  dispose(): void;
}

export function isGameSession(game: unknown): game is GameSession {
  return (
    typeof game === 'object' &&
    game !== null &&
    (game as { kind?: unknown }).kind === 'gameSession'
  );
}

export interface GameSessionOptions {
  /** Bot driver config; `null` runs without a driver (test stub mode). */
  bots?: BotDriverOptions | null;
  /**
   * Game-log config; omit to read it from the environment (off by default).
   * Tests inject an explicit config to log to a temp dir or force it off.
   */
  log?: GameLogConfig;
}

/**
 * RoomStore startGame hook: seed a fresh engine game, attach the bot turn
 * driver, and send every seated client its opening view. The seq-stamped
 * envelopes precede the started roomState the store broadcasts right after;
 * both orders rebuild the same client state.
 */
export function createGameSession(
  room: Room,
  seed: number = randomInt(0, 2 ** 32),
  opts: GameSessionOptions = {},
): GameSession {
  const session: GameSession = {
    kind: 'gameSession',
    seed,
    state: newGame(seed),
    ready: new Set(),
    driver: null,
    logger: createGameLogger(room, seed, opts.log ?? resolveGameLogConfig()),
    actingSeat(): number | null {
      return toActSeat(session.state);
    },
    isOver(): boolean {
      return session.state.phase === 'gameOver';
    },
    dispose(): void {
      session.driver?.dispose();
    },
  };
  if (opts.bots !== null) {
    session.driver = new BotDriver(
      room,
      session,
      (action) => applyGameAction(room, action),
      opts.bots ?? {},
    );
  }
  broadcastGameViews(room, session.state);
  broadcastActionRequests(room, session.state);
  session.driver?.onAdvance(); // the opening auction may start on a bot seat
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
    // A decided game leaves handScored immediately (applyGameAction applies
    // the engine's nextHand itself — gameOver supersedes the ready-up), so
    // skip this transient state's view/request wave: an actionRequest
    // offering nextHand here would invite a doomed command.
    if (next.game.winner !== null) return;
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
  const wasPaused = isPaused(room);
  const result = applyAction(prev, action);
  if (!result.ok) return result;
  session.state = result.state;
  if (prev.phase === 'handScored') session.ready.clear();
  room.lastActivity = Date.now();
  broadcastAdvance(room, prev, result.state);
  // The turn may have landed on (or left) a disconnected human; keep every
  // client's paused indicator current.
  if (isPaused(room) !== wasPaused) {
    broadcastAll(room, { t: 'roomState', room: roomView(room) });
  }
  session.driver?.onAdvance();
  // Opt-in game logging: snapshot each hand as it scores, and flush the whole
  // record once the game is over. Both transitions are crossed exactly once,
  // so each hand is recorded once and the record is written once.
  if (session.logger !== null) {
    if (prev.phase !== 'handScored' && result.state.phase === 'handScored') {
      session.logger.recordHand(result.state);
    }
    if (prev.phase !== 'gameOver' && result.state.phase === 'gameOver') {
      session.logger.finish(result.state);
    }
  }
  // A hand that decides the game needs no ready-up: gameOver supersedes it,
  // so apply the engine's nextHand at once (handScored -> gameOver).
  if (result.state.phase === 'handScored' && result.state.game.winner !== null) {
    applyGameAction(room, { type: 'nextHand', seat: action.seat });
  }
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
 * Every seat currently counted as ready for the next hand: humans that sent
 * nextHand plus bot seats, which are always ready (readiness schema v1).
 */
function readySeats(room: Room, session: GameSession): number[] {
  return [0, 1, 2, 3].filter(
    (s) => room.seats[s]?.kind !== 'human' || session.ready.has(s),
  );
}

function broadcastHandReady(room: Room, session: GameSession): void {
  broadcastAll(room, { t: 'handReady', ready: readySeats(room, session) });
}

/**
 * nextHand is a ready-up, not a direct engine action: every human seat must
 * send it before the hand advances (bot seats are auto-ready). Re-sends are
 * idempotent and consume no seq. The engine's nextHand applies once, on
 * behalf of the last seat to ready.
 */
function handleNextHand(room: Room, session: GameSession, seat: number, client: RoomClient): void {
  if (session.state.phase !== 'handScored') {
    sendError(client, 'illegalAction', 'There is no finished hand to advance from.');
    return;
  }
  if (!session.ready.has(seat)) {
    session.ready.add(seat);
    broadcastHandReady(room, session);
  }
  advanceHandIfAllReady(room, session, seat);
}

/** Apply the engine's nextHand once every human seat has readied (any seat may apply it). */
function advanceHandIfAllReady(room: Room, session: GameSession, seat: number): void {
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

/**
 * Debug-panel command (fh-q2m): pin the trick the sender is looking at into
 * the room's in-progress game record. Pure annotation — no engine action, no
 * state change, no seq — so it is a silent no-op when the room is not logging
 * games. The hand/trick pair comes from the sender's own view; the server
 * trusts it and only stamps the seat and the clock.
 */
export function handleFlagTrick(client: RoomClient, cmd: FlagTrickCommand): void {
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
  if (seat === null) {
    sendError(client, 'badToken', 'No seat is bound to this connection.');
    return;
  }
  room.lastActivity = Date.now();
  session.logger?.flagTrick({
    hand: cmd.hand,
    trick: cmd.trick,
    seat,
    note: cmd.note,
    heldCards: heldCardsAt(session.state, seat),
  });
}

/**
 * The cards `seat` is still holding right now (fh-9f2), sorted ascending so
 * the snapshot reads suit by suit. Taken from the live play sub-state, not
 * `state.hands`, so it is the remaining hand at the flagged trick rather than
 * the original deal — that is what makes a marker judgeable without a replay.
 * Outside play (auction, exchange, between hands) there is nothing meaningful
 * to snapshot, so the field is simply omitted.
 */
function heldCardsAt(state: GameState, seat: number): readonly Card[] | undefined {
  const hand = state.play?.hands[seat];
  return hand === undefined ? undefined : [...hand].sort((a, b) => a - b);
}

/**
 * RoomStore resumeView hook: after a token reattach, resend the seat's full
 * current view plus its actionRequest, both stamped with the last-consumed
 * seq (a fresh seq spent on one socket would gap every other client). The
 * actionRequest matters when the reattached seat holds the turn — without it
 * the client would never relearn its legal actions and the game would stall.
 */
export function resumeView(room: Room, client: RoomClient): void {
  const session = room.game;
  const seat = client.seat;
  if (!isGameSession(session) || seat === null) return;
  const seq = Math.max(0, room.seq - 1);
  client.send({
    seq,
    event: { t: 'gameView', view: { view: redactedView(session.state, seat) } },
  });
  client.send({ seq, event: { t: 'actionRequest', seat, actions: legalActions(session.state, seat) } });
}

/**
 * Host command: hand a disconnected human seat to a bot mid-game
 * (irreversible; the seat's token dies with it, so its old holder gets
 * badToken on any later rejoin). The seat may hold the turn right now — the
 * driver handoff schedules its first decision — or be the lone unready seat
 * in handScored, where bots are auto-ready.
 */
export function handleConvertSeatToBot(client: RoomClient, cmd: ConvertSeatToBotCommand): void {
  const room = client.room;
  if (room === null) {
    sendError(client, 'badCommand', 'Not in a room.');
    return;
  }
  if (client !== room.host) {
    sendError(client, 'notHost', 'Only the host can convert a seat to a bot.');
    return;
  }
  const session = room.game;
  if (!isGameSession(session)) {
    sendError(client, 'badCommand', 'No game is running.');
    return;
  }
  if (cmd.seat === client.seat) {
    sendError(client, 'badCommand', 'The host seat cannot be converted.');
    return;
  }
  const seatState = room.seats[cmd.seat];
  if (seatState === undefined || seatState.kind !== 'human') {
    sendError(client, 'badCommand', `Seat ${cmd.seat} is not held by a human.`);
    return;
  }
  if (seatState.connected) {
    sendError(client, 'badCommand', `Seat ${cmd.seat} is still connected.`);
    return;
  }
  // fh-gpk: an unspecified tier means the product default (Hard).
  const difficulty = cmd.difficulty ?? DEFAULT_DIFFICULTY;
  room.seats[cmd.seat] = { kind: 'bot', difficulty };
  room.lastActivity = Date.now();
  broadcastAll(room, { t: 'roomState', room: roomView(room) });
  session.driver?.addBot(cmd.seat, difficulty);
  if (session.state.phase === 'handScored') {
    // The converted seat is now a bot, hence auto-ready: tell everyone.
    broadcastHandReady(room, session);
    advanceHandIfAllReady(room, session, cmd.seat);
  }
}
