import { describe, expect, it } from 'vitest';
import { isCommand, isEvent } from './index.js';

/** One canonically valid sample per command type. */
const validCommands: Record<string, unknown> = {
  createRoom: { t: 'createRoom', name: 'Andy' },
  joinRoom: { t: 'joinRoom', roomCode: 'ABCD', name: 'Sam' },
  joinRoomReconnect: { t: 'joinRoom', roomCode: 'ABCD', name: 'Sam', token: 'secret-1' },
  sit: { t: 'sit', seat: 2 },
  configureBots: {
    t: 'configureBots',
    bots: [
      { seat: 1, difficulty: 'easy' },
      { seat: 3, difficulty: 'hard' },
    ],
  },
  configureBotsEmpty: { t: 'configureBots', bots: [] },
  startGame: { t: 'startGame' },
  convertSeatToBot: { t: 'convertSeatToBot', seat: 2, difficulty: 'easy' },
  // fh-gpk: difficulty is optional — omitting it takes the server default.
  convertSeatToBotDefaultTier: { t: 'convertSeatToBot', seat: 2 },
  bid: { t: 'bid', bid: { kind: 'NUM', level: 7, strain: 4 } },
  bidIndication: { t: 'bid', bid: { kind: 'IND', level: 6, strain: 0 } },
  bidPass: { t: 'bid', bid: { kind: 'PASS', level: 0, strain: -1 } },
  discardKeeps: { t: 'discardKeeps', keeps: [0, 5, 11, 14, 20, 23, 30, 33, 40, 44] },
  declareSlam: { t: 'declareSlam' },
  declineSlam: { t: 'declineSlam' },
  giveCard: { t: 'giveCard', card: 14 },
  playCard: { t: 'playCard', card: 7 },
  playCardJokerLead: { t: 'playCard', card: 44, jokerSuit: 2 },
  nextHand: { t: 'nextHand' },
  rematch: { t: 'rematch' },
  requestState: { t: 'requestState' },
  // fh-q2m: the debug panel's trick marker; the note is optional.
  flagTrick: { t: 'flagTrick', hand: 2, trick: 5 },
  flagTrickNoted: { t: 'flagTrick', hand: 0, trick: 0, note: 'bot ducked its ace' },
};

/** Malformed samples per command type: wrong, missing, or out-of-range fields. */
const malformedCommands: Record<string, unknown> = {
  createRoomMissingName: { t: 'createRoom' },
  createRoomEmptyName: { t: 'createRoom', name: '' },
  createRoomNumericName: { t: 'createRoom', name: 7 },
  joinRoomMissingCode: { t: 'joinRoom', name: 'Sam' },
  joinRoomNumericToken: { t: 'joinRoom', roomCode: 'ABCD', name: 'Sam', token: 7 },
  sitSeatTooBig: { t: 'sit', seat: 4 },
  sitSeatString: { t: 'sit', seat: '2' },
  sitSeatFraction: { t: 'sit', seat: 1.5 },
  sitSeatMissing: { t: 'sit' },
  configureBotsNotArray: { t: 'configureBots', bots: { seat: 1, difficulty: 'easy' } },
  configureBotsBadDifficulty: { t: 'configureBots', bots: [{ seat: 1, difficulty: 'expert' }] },
  configureBotsBadSeat: { t: 'configureBots', bots: [{ seat: 9, difficulty: 'easy' }] },
  convertSeatToBotBadSeat: { t: 'convertSeatToBot', seat: 4, difficulty: 'easy' },
  convertSeatToBotBadDifficulty: { t: 'convertSeatToBot', seat: 2, difficulty: 'expert' },
  convertSeatToBotMissingSeat: { t: 'convertSeatToBot', difficulty: 'easy' },
  bidMissing: { t: 'bid' },
  bidBadKind: { t: 'bid', bid: { kind: 'MISERE', level: 7, strain: 0 } },
  bidLevelString: { t: 'bid', bid: { kind: 'NUM', level: '7', strain: 0 } },
  discardKeepsNotArray: { t: 'discardKeeps', keeps: 5 },
  discardKeepsBadCard: { t: 'discardKeeps', keeps: [0, 45] },
  discardKeepsStringCard: { t: 'discardKeeps', keeps: [0, '5'] },
  giveCardOutOfDeck: { t: 'giveCard', card: 45 },
  giveCardNegative: { t: 'giveCard', card: -1 },
  giveCardMissing: { t: 'giveCard' },
  playCardMissing: { t: 'playCard' },
  playCardBadJokerSuit: { t: 'playCard', card: 44, jokerSuit: 4 },
  playCardFraction: { t: 'playCard', card: 7.5 },
  flagTrickMissingTrick: { t: 'flagTrick', hand: 1 },
  flagTrickNegativeTrick: { t: 'flagTrick', hand: 1, trick: -1 },
  flagTrickStringHand: { t: 'flagTrick', hand: '1', trick: 0 },
  flagTrickFractionTrick: { t: 'flagTrick', hand: 1, trick: 2.5 },
  flagTrickNumericNote: { t: 'flagTrick', hand: 1, trick: 0, note: 7 },
};

const validEvents: Record<string, unknown> = {
  roomState: {
    t: 'roomState',
    room: {
      roomCode: 'ABCD',
      hostSeat: 0,
      seats: [
        { seat: 0, occupant: 'human', name: 'Andy', difficulty: null, connected: true },
        { seat: 1, occupant: 'bot', name: null, difficulty: 'easy', connected: true },
        { seat: 2, occupant: 'empty', name: null, difficulty: 'medium', connected: true },
        { seat: 3, occupant: 'human', name: 'Sam', difficulty: null, connected: false },
      ],
      started: false,
      paused: false,
    },
  },
  gameView: {
    t: 'gameView',
    view: { view: { seat: 0, phase: 'auction', hand: [0, 1, 2, 10, 20, 30, 40, 44, 5, 6] } },
  },
  actionRequest: {
    t: 'actionRequest',
    seat: 2,
    actions: [
      { type: 'bid', seat: 2, bid: { kind: 'PASS', level: 0, strain: -1 } },
      { type: 'playCard', seat: 2, card: 7 },
    ],
  },
  actionRequestEmpty: { t: 'actionRequest', seat: 0, actions: [] },
  trickResolved: {
    t: 'trickResolved',
    trick: {
      leader: 0,
      ledSuit: 2,
      plays: [
        { seat: 0, card: 26 },
        { seat: 1, card: 27 },
        { seat: 2, card: 30 },
        { seat: 3, card: 3 },
      ],
      winner: 2,
    },
  },
  handScored: {
    t: 'handScored',
    result: {
      contract: { kind: 'NUM', level: 8, strain: 2 },
      declarer: 1,
      slam: false,
      made: true,
      declarerDelta: 280,
      defenderDelta: 20,
      declarerSideTricks: 8,
      defenderSideTricks: 2,
    },
    scores: [280, 20],
  },
  handReady: { t: 'handReady', ready: [0, 1, 3] },
  handReadyEmpty: { t: 'handReady', ready: [] },
  gameOver: { t: 'gameOver', winner: 0, scores: [520, 180] },
  error: { t: 'error', code: 'notYourTurn', message: 'it is seat 1 to act' },
};

const malformedEvents: Record<string, unknown> = {
  roomStateMissingRoom: { t: 'roomState' },
  roomStateThreeSeats: {
    t: 'roomState',
    room: {
      roomCode: 'ABCD',
      hostSeat: null,
      seats: [
        { seat: 0, occupant: 'human', name: 'A', difficulty: null, connected: true },
        { seat: 1, occupant: 'bot', name: null, difficulty: 'easy', connected: true },
        { seat: 2, occupant: 'empty', name: null, difficulty: 'hard', connected: true },
      ],
      started: false,
      paused: false,
    },
  },
  roomStateBadOccupant: {
    t: 'roomState',
    room: {
      roomCode: 'ABCD',
      hostSeat: null,
      seats: [
        { seat: 0, occupant: 'ghost', name: null, difficulty: null, connected: true },
        { seat: 1, occupant: 'bot', name: null, difficulty: 'easy', connected: true },
        { seat: 2, occupant: 'empty', name: null, difficulty: 'hard', connected: true },
        { seat: 3, occupant: 'empty', name: null, difficulty: 'hard', connected: true },
      ],
      started: false,
      paused: false,
    },
  },
  roomStateMissingPaused: {
    t: 'roomState',
    room: {
      roomCode: 'ABCD',
      hostSeat: null,
      seats: [
        { seat: 0, occupant: 'human', name: 'A', difficulty: null, connected: true },
        { seat: 1, occupant: 'bot', name: null, difficulty: 'easy', connected: true },
        { seat: 2, occupant: 'empty', name: null, difficulty: 'hard', connected: true },
        { seat: 3, occupant: 'empty', name: null, difficulty: 'hard', connected: true },
      ],
      started: false,
    },
  },
  gameViewMissingView: { t: 'gameView' },
  gameViewBadHandCard: { t: 'gameView', view: { view: { seat: 0, phase: 'play', hand: [99] } } },
  actionRequestBadSeat: { t: 'actionRequest', seat: 5, actions: [] },
  actionRequestBadAction: {
    t: 'actionRequest',
    seat: 1,
    actions: [{ type: 'teleport', seat: 1 }],
  },
  trickResolvedBadWinner: {
    t: 'trickResolved',
    trick: { leader: 0, ledSuit: 1, plays: [], winner: 4 },
  },
  handScoredNoContract: { t: 'handScored', result: { made: true }, scores: [0, 0] },
  handScoredBadScores: {
    t: 'handScored',
    result: { contract: { kind: 'NUM', level: 7, strain: 0 } },
    scores: [40],
  },
  handReadyMissing: { t: 'handReady' },
  handReadyBadSeat: { t: 'handReady', ready: [0, 4] },
  gameOverBadWinner: { t: 'gameOver', winner: 2, scores: [500, 100] },
  errorUnknownCode: { t: 'error', code: 'kaboom', message: 'x' },
  errorMissingMessage: { t: 'error', code: 'badToken' },
};

const garbage: readonly unknown[] = [
  null,
  undefined,
  42,
  'bid',
  [],
  {},
  { t: 7 },
  { t: 'noSuchMessage' },
];

describe('isCommand', () => {
  it.each(Object.entries(validCommands))('accepts %s', (_name, sample) => {
    expect(isCommand(sample)).toBe(true);
  });

  it.each(Object.entries(malformedCommands))('rejects %s', (_name, sample) => {
    expect(isCommand(sample)).toBe(false);
  });

  it.each(garbage.map((g) => [g]))('rejects non-command %j', (sample) => {
    expect(isCommand(sample)).toBe(false);
  });

  it('rejects every server event', () => {
    for (const sample of Object.values(validEvents)) expect(isCommand(sample)).toBe(false);
  });

  it('tolerates unknown extra fields', () => {
    expect(isCommand({ t: 'sit', seat: 2, laterAddition: true })).toBe(true);
  });
});

describe('isEvent', () => {
  it.each(Object.entries(validEvents))('accepts %s', (_name, sample) => {
    expect(isEvent(sample)).toBe(true);
  });

  it.each(Object.entries(malformedEvents))('rejects %s', (_name, sample) => {
    expect(isEvent(sample)).toBe(false);
  });

  it.each(garbage.map((g) => [g]))('rejects non-event %j', (sample) => {
    expect(isEvent(sample)).toBe(false);
  });

  it('rejects every client command', () => {
    for (const sample of Object.values(validCommands)) expect(isEvent(sample)).toBe(false);
  });

  it('tolerates unknown extra fields', () => {
    expect(isEvent({ t: 'gameOver', winner: 1, scores: [510, 300], laterAddition: 'x' })).toBe(
      true,
    );
  });
});
