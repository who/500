/**
 * Hand-rolled type guards for the wire protocol — the package's only runtime
 * code (decision: no Zod; the checks are small). Guards verify the `t`
 * discriminant and the shape of every field a handler will touch, and
 * deliberately ignore unknown extra fields (forward compatibility). An
 * unknown `t` is rejected, never thrown on.
 */

import { N_CARDS } from '@five-hundred/engine';
import type { ClientCommand, Envelope, ServerEvent } from './messages.js';
import { ERROR_CODES } from './messages.js';
import { BOT_DIFFICULTIES } from './views.js';

type Rec = Record<string, unknown>;

function isRec(x: unknown): x is Rec {
  return typeof x === 'object' && x !== null;
}

function isSeat(x: unknown): boolean {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 3;
}

function isSuit(x: unknown): boolean {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 3;
}

function isCard(x: unknown): boolean {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < N_CARDS;
}

function isCardArray(x: unknown): boolean {
  return Array.isArray(x) && x.every(isCard);
}

function isSeqNumber(x: unknown): boolean {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

function isNonEmptyString(x: unknown): boolean {
  return typeof x === 'string' && x.length > 0;
}

/** A non-negative array index (hand numbers, trick indices). */
function isIndex(x: unknown): boolean {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

const BID_KINDS: readonly string[] = ['NUM', 'NULLA', 'DNULLA', 'IND', 'PASS'];

function isBid(x: unknown): boolean {
  return (
    isRec(x) &&
    typeof x.kind === 'string' &&
    BID_KINDS.includes(x.kind) &&
    typeof x.level === 'number' &&
    typeof x.strain === 'number'
  );
}

/** Engine actions as they appear inside actionRequest payloads. */
const ACTION_TYPES: readonly string[] = [
  'bid',
  'declareSlam',
  'declineSlam',
  'giveCard',
  'discardKeeps',
  'playCard',
  'nextHand',
];

function isEngineAction(x: unknown): boolean {
  return (
    isRec(x) && typeof x.type === 'string' && ACTION_TYPES.includes(x.type) && isSeat(x.seat)
  );
}

function isDifficulty(x: unknown): boolean {
  return typeof x === 'string' && (BOT_DIFFICULTIES as readonly string[]).includes(x);
}

function isScores(x: unknown): boolean {
  return Array.isArray(x) && x.length === 2 && x.every((s) => typeof s === 'number');
}

function isRoomSeatView(x: unknown): boolean {
  return (
    isRec(x) &&
    isSeat(x.seat) &&
    (x.occupant === 'human' || x.occupant === 'bot' || x.occupant === 'empty') &&
    (x.name === null || typeof x.name === 'string') &&
    (x.difficulty === null || isDifficulty(x.difficulty)) &&
    typeof x.connected === 'boolean'
  );
}

function isRoomView(x: unknown): boolean {
  return (
    isRec(x) &&
    isNonEmptyString(x.roomCode) &&
    (x.hostSeat === null || isSeat(x.hostSeat)) &&
    Array.isArray(x.seats) &&
    x.seats.length === 4 &&
    x.seats.every(isRoomSeatView) &&
    typeof x.started === 'boolean' &&
    typeof x.paused === 'boolean' &&
    // fh-sja.6 fields are optional (forward/backward compatible): validated
    // when present, treated as null/false when absent.
    (x.learnedVersion === undefined ||
      x.learnedVersion === null ||
      typeof x.learnedVersion === 'string') &&
    (x.adaptiveBots === undefined || typeof x.adaptiveBots === 'boolean')
  );
}

/** Shallow check of the wrapped engine RedactedView: the fields clients key on. */
function isSeatGameView(x: unknown): boolean {
  if (!isRec(x) || !isRec(x.view)) return false;
  const v = x.view;
  return isSeat(v.seat) && typeof v.phase === 'string' && isCardArray(v.hand);
}

function isTrick(x: unknown): boolean {
  return (
    isRec(x) &&
    isSeat(x.leader) &&
    isSeat(x.winner) &&
    Array.isArray(x.plays) &&
    x.plays.every((p) => isRec(p) && isSeat(p.seat) && isCard(p.card))
  );
}

/** One hand of the fh-y2a.2 game-log summary. */
function isGameLogHand(x: unknown): boolean {
  return (
    isRec(x) &&
    isIndex(x.handNumber) &&
    isSeat(x.dealer) &&
    isIndex(x.redeals) &&
    Array.isArray(x.auction) &&
    x.auction.every((c) => isRec(c) && isSeat(c.seat) && isBid(c.bid)) &&
    Array.isArray(x.tricks) &&
    x.tricks.every((t) => isRec(t) && isSeat(t.leader) && isSeat(t.winner)) &&
    isScores(x.scores)
  );
}

const COMMAND_CHECKS: Record<ClientCommand['t'], (m: Rec) => boolean> = {
  createRoom: (m) => isNonEmptyString(m.name),
  joinRoom: (m) =>
    isNonEmptyString(m.roomCode) &&
    isNonEmptyString(m.name) &&
    (m.token === undefined || typeof m.token === 'string'),
  sit: (m) => isSeat(m.seat),
  configureBots: (m) =>
    Array.isArray(m.bots) &&
    m.bots.every((b) => isRec(b) && isSeat(b.seat) && isDifficulty(b.difficulty)),
  setAdaptiveBots: (m) => typeof m.on === 'boolean',
  startGame: () => true,
  // difficulty is optional (fh-gpk): absent means the server's default tier.
  convertSeatToBot: (m) => isSeat(m.seat) && (m.difficulty === undefined || isDifficulty(m.difficulty)),
  bid: (m) => isBid(m.bid),
  discardKeeps: (m) => isCardArray(m.keeps),
  declareSlam: () => true,
  declineSlam: () => true,
  giveCard: (m) => isCard(m.card),
  playCard: (m) => isCard(m.card) && (m.jokerSuit === undefined || isSuit(m.jokerSuit)),
  nextHand: () => true,
  rematch: () => true,
  requestState: () => true,
  flagTrick: (m) =>
    isIndex(m.hand) && isIndex(m.trick) && (m.note === undefined || typeof m.note === 'string'),
  leaveRoom: () => true,
};

const EVENT_CHECKS: Record<ServerEvent['t'], (m: Rec) => boolean> = {
  roomState: (m) => isRoomView(m.room),
  gameView: (m) => isSeatGameView(m.view),
  actionRequest: (m) =>
    isSeat(m.seat) && Array.isArray(m.actions) && m.actions.every(isEngineAction),
  trickResolved: (m) => isTrick(m.trick),
  handScored: (m) => isRec(m.result) && isBid(m.result.contract) && isScores(m.scores),
  handReady: (m) => Array.isArray(m.ready) && m.ready.every(isSeat),
  gameOver: (m) => (m.winner === 0 || m.winner === 1) && isScores(m.scores),
  gameLog: (m) => Array.isArray(m.hands) && m.hands.every(isGameLogHand),
  error: (m) =>
    typeof m.code === 'string' &&
    (ERROR_CODES as readonly string[]).includes(m.code) &&
    typeof m.message === 'string',
  seatGranted: (m) => isSeat(m.seat) && isNonEmptyString(m.token),
};

export function isCommand(x: unknown): x is ClientCommand {
  if (!isRec(x) || typeof x.t !== 'string') return false;
  const check = (COMMAND_CHECKS as Record<string, ((m: Rec) => boolean) | undefined>)[x.t];
  return check !== undefined && check(x);
}

export function isEvent(x: unknown): x is ServerEvent {
  if (!isRec(x) || typeof x.t !== 'string') return false;
  const check = (EVENT_CHECKS as Record<string, ((m: Rec) => boolean) | undefined>)[x.t];
  return check !== undefined && check(x);
}

/**
 * An envelope is a valid event plus the seq rule: state-bearing events must
 * carry a non-negative integer seq; private (single-socket) envelopes —
 * errors and seatGranted — may omit it.
 */
export function isEnvelope(x: unknown): x is Envelope {
  if (!isRec(x) || !isEvent(x.event)) return false;
  if (x.event.t === 'error' || x.event.t === 'seatGranted') {
    return x.seq === undefined || isSeqNumber(x.seq);
  }
  return isSeqNumber(x.seq);
}
