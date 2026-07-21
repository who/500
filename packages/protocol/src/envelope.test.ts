import { describe, expect, it } from 'vitest';
import type { Envelope, ErrorEvent, RoomStateEvent, TrickResolvedEvent } from './index.js';
import { isEnvelope } from './index.js';

const roomStateEvent: RoomStateEvent = {
  t: 'roomState',
  room: {
    roomCode: 'ABCD',
    hostSeat: 0,
    seats: [
      { seat: 0, occupant: 'human', name: 'Andy', difficulty: null, connected: true },
      { seat: 1, occupant: 'bot', name: null, difficulty: 'easy', connected: true },
      { seat: 2, occupant: 'bot', name: null, difficulty: 'medium', connected: true },
      { seat: 3, occupant: 'bot', name: null, difficulty: 'hard', connected: true },
    ],
    started: true,
  },
};

const trickResolvedEvent: TrickResolvedEvent = {
  t: 'trickResolved',
  trick: {
    leader: 0,
    ledSuit: 1,
    plays: [
      { seat: 0, card: 15 },
      { seat: 1, card: 16 },
      { seat: 2, card: 17 },
      { seat: 3, card: 18 },
    ],
    winner: 3,
  },
};

const errorEvent: ErrorEvent = { t: 'error', code: 'badRoomCode', message: 'no such room' };

describe('Envelope type', () => {
  it('requires seq on state-bearing events and lets error envelopes omit it', () => {
    const withSeq: Envelope = { seq: 1, event: roomStateEvent };
    const errNoSeq: Envelope = { event: errorEvent };
    const errWithSeq: Envelope = { seq: 2, event: errorEvent };

    // @ts-expect-error — a roomState envelope without seq must not compile
    const missingSeqRoom: Envelope = { event: roomStateEvent };
    // @ts-expect-error — a trickResolved envelope without seq must not compile
    const missingSeqTrick: Envelope = { event: trickResolvedEvent };

    for (const e of [withSeq, errNoSeq, errWithSeq, missingSeqRoom, missingSeqTrick]) {
      expect(typeof e.event.t).toBe('string');
    }
  });
});

describe('isEnvelope', () => {
  it('accepts state-bearing envelopes with a non-negative integer seq', () => {
    expect(isEnvelope({ seq: 0, event: roomStateEvent })).toBe(true);
    expect(isEnvelope({ seq: 17, event: trickResolvedEvent })).toBe(true);
  });

  it('rejects state-bearing envelopes without a valid seq', () => {
    expect(isEnvelope({ event: roomStateEvent })).toBe(false);
    expect(isEnvelope({ seq: -1, event: roomStateEvent })).toBe(false);
    expect(isEnvelope({ seq: 1.5, event: roomStateEvent })).toBe(false);
    expect(isEnvelope({ seq: '3', event: roomStateEvent })).toBe(false);
  });

  it('lets error envelopes omit seq but still rejects a malformed one', () => {
    expect(isEnvelope({ event: errorEvent })).toBe(true);
    expect(isEnvelope({ seq: 4, event: errorEvent })).toBe(true);
    expect(isEnvelope({ seq: -4, event: errorEvent })).toBe(false);
  });

  it('rejects envelopes whose event is missing or invalid', () => {
    expect(isEnvelope({ seq: 1 })).toBe(false);
    expect(isEnvelope({ seq: 1, event: { t: 'noSuchEvent' } })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope('roomState')).toBe(false);
  });

  it('tolerates unknown extra fields on the envelope', () => {
    expect(isEnvelope({ seq: 1, event: errorEvent, futureField: true })).toBe(true);
  });
});
