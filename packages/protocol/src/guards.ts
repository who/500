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
    typeof x.started === 'boolean'
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
  startGame: () => true,
  bid: (m) => isBid(m.bid),
  discardKeeps: (m) => isCardArray(m.keeps),
  declareSlam: () => true,
  declineSlam: () => true,
  giveCard: (m) => isCard(m.card),
  playCard: (m) => isCard(m.card) && (m.jokerSuit === undefined || isSuit(m.jokerSuit)),
  nextHand: () => true,
  requestState: () => true,
};

const EVENT_CHECKS: Record<ServerEvent['t'], (m: Rec) => boolean> = {
  roomState: (m) => isRoomView(m.room),
  gameView: (m) => isSeatGameView(m.view),
  actionRequest: (m) =>
    isSeat(m.seat) && Array.isArray(m.actions) && m.actions.every(isEngineAction),
  trickResolved: (m) => isTrick(m.trick),
  handScored: (m) => isRec(m.result) && isBid(m.result.contract) && isScores(m.scores),
  gameOver: (m) => (m.winner === 0 || m.winner === 1) && isScores(m.scores),
  error: (m) =>
    typeof m.code === 'string' &&
    (ERROR_CODES as readonly string[]).includes(m.code) &&
    typeof m.message === 'string',
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
 * carry a non-negative integer seq; error envelopes may omit it.
 */
export function isEnvelope(x: unknown): x is Envelope {
  if (!isRec(x) || !isEvent(x.event)) return false;
  if (x.event.t === 'error') return x.seq === undefined || isSeqNumber(x.seq);
  return isSeqNumber(x.seq);
}
