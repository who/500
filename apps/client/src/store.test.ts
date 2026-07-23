import { describe, expect, it } from 'vitest';
import type {
  ActionRequestEvent,
  ClientCommand,
  Envelope,
  RoomView,
  SeatGameView,
  StateBearingEvent,
} from '@five-hundred/protocol';
import {
  clearSession,
  createStore,
  loadSession,
  saveSession,
  SESSION_STORAGE_KEY,
  type StorageLike,
  type StoredSession,
} from './store.ts';

class FakeStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function roomViewFixture(overrides: Partial<RoomView> = {}): RoomView {
  return {
    roomCode: 'ABCDE',
    hostSeat: 0,
    seats: [0, 1, 2, 3].map((seat) => ({
      seat,
      occupant: 'empty' as const,
      name: null,
      difficulty: 'medium' as const,
      connected: true,
    })),
    started: false,
    paused: false,
    ...overrides,
  };
}

/** Shallow RedactedView stand-in: only the fields the store touches. */
function gameViewFixture(seat: number, phase = 'PLAY'): SeatGameView {
  return { view: { seat, phase, hand: [1, 2, 3] } } as unknown as SeatGameView;
}

function actionRequestFixture(seat: number): ActionRequestEvent {
  return { t: 'actionRequest', seat, actions: [] };
}

const env = (seq: number, event: StateBearingEvent): Envelope => ({ seq, event });

function makeStore(opts: { storage?: StorageLike | null; session?: StoredSession } = {}) {
  const storage = opts.storage === undefined ? new FakeStorage() : opts.storage;
  if (opts.session !== undefined) saveSession(storage, opts.session);
  const sent: ClientCommand[] = [];
  const store = createStore({ send: (c) => sent.push(c), storage });
  return { store, sent, storage };
}

const requestStates = (sent: ClientCommand[]) => sent.filter((c) => c.t === 'requestState');

describe('session persistence', () => {
  it('round-trips a session and rejects malformed payloads', () => {
    const storage = new FakeStorage();
    expect(loadSession(storage)).toBeNull();
    const session = { roomCode: 'ABCDE', seatToken: 'tok-1', name: 'Ana' };
    saveSession(storage, session);
    expect(loadSession(storage)).toEqual(session);
    storage.setItem(SESSION_STORAGE_KEY, '{"roomCode":42}');
    expect(loadSession(storage)).toBeNull();
    storage.setItem(SESSION_STORAGE_KEY, 'not json');
    expect(loadSession(storage)).toBeNull();
    clearSession(storage);
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(loadSession(null)).toBeNull();
  });
});

describe('seq handling', () => {
  it('applies monotonic events in order', () => {
    const { store } = makeStore();
    const apply = store.getState().applyServerEvent;
    apply(env(0, { t: 'roomState', room: roomViewFixture() }));
    apply(env(1, { t: 'gameView', view: gameViewFixture(2) }));
    apply(env(2, actionRequestFixture(2)));
    const s = store.getState();
    expect(s.roomView?.roomCode).toBe('ABCDE');
    expect(s.seatView).not.toBeNull();
    expect(s.seat).toBe(2);
    expect(s.pendingActions?.seat).toBe(2);
    expect(s.lastSeq).toBe(2);
  });

  // AC-3: stale (lower-seq) events never overwrite newer state.
  it('drops stale lower-seq events', () => {
    const { store, sent } = makeStore();
    const apply = store.getState().applyServerEvent;
    apply(env(5, { t: 'roomState', room: roomViewFixture({ started: true }) }));
    apply(env(4, { t: 'roomState', room: roomViewFixture({ started: false }) }));
    apply(env(3, { t: 'gameView', view: gameViewFixture(0) }));
    const s = store.getState();
    expect(s.roomView?.started).toBe(true);
    expect(s.seatView).toBeNull();
    expect(s.lastSeq).toBe(5);
    expect(sent).toEqual([]);
  });

  it('applies equal-seq companions of a resumed view (reattach resend)', () => {
    const { store } = makeStore();
    const apply = store.getState().applyServerEvent;
    // resumeView stamps gameView and actionRequest with the last-consumed seq.
    apply(env(7, { t: 'gameView', view: gameViewFixture(1) }));
    apply(env(7, actionRequestFixture(1)));
    const s = store.getState();
    expect(s.seat).toBe(1);
    expect(s.pendingActions?.seat).toBe(1);
    expect(s.lastSeq).toBe(7);
  });

  // AC-1: a seq gap triggers exactly one requestState and converges on the
  // full view.
  it('sends exactly one requestState on a gap and converges on the full view', () => {
    const { store, sent } = makeStore();
    const apply = store.getState().applyServerEvent;
    apply(env(0, { t: 'roomState', room: roomViewFixture() }));
    apply(env(1, { t: 'gameView', view: gameViewFixture(3) }));
    // Seq 2 lost in transit; 3 and 4 arrive as gaps and are dropped.
    apply(env(3, actionRequestFixture(3)));
    expect(requestStates(sent)).toHaveLength(1);
    expect(store.getState().pendingActions).toBeNull();
    apply(env(4, { t: 'trickResolved', trick: { leader: 0, winner: 1, ledSuit: 0, plays: [] } }));
    expect(requestStates(sent)).toHaveLength(1);
    expect(store.getState().lastTrick).toBeNull();
    // The reply: a full view stamped with the server's last-consumed seq.
    apply(env(4, { t: 'gameView', view: gameViewFixture(3, 'EXCHANGE') }));
    const s = store.getState();
    expect(s.recovering).toBe(false);
    expect(s.lastSeq).toBe(4);
    expect((s.seatView as { view: { phase: string } }).view.phase).toBe('EXCHANGE');
    // Stream continues gap-free without further recovery.
    apply(env(5, actionRequestFixture(3)));
    expect(store.getState().pendingActions?.seat).toBe(3);
    expect(requestStates(sent)).toHaveLength(1);
  });

  it('treats the first event after a reconnect as the new baseline', () => {
    const { store } = makeStore();
    const apply = store.getState().applyServerEvent;
    apply(env(41, { t: 'roomState', room: roomViewFixture() }));
    expect(store.getState().lastSeq).toBe(41);
    store.getState().handleSocketOpen();
    expect(store.getState().lastSeq).toBeNull();
    // A room-seq far from the old baseline is accepted without recovery.
    apply(env(97, { t: 'roomState', room: roomViewFixture({ paused: true }) }));
    expect(store.getState().roomView?.paused).toBe(true);
    expect(store.getState().lastSeq).toBe(97);
  });
});

describe('auto-rejoin', () => {
  const session = { roomCode: 'QWZRT', seatToken: 'tok-9', name: 'Bo' };

  // AC-2 happy path: a stored valid token rejoins the same seat.
  it('rejoins with the stored token on open and lands back in the seat', () => {
    const { store, sent } = makeStore({ session });
    expect(store.getState().session).toEqual(session);
    expect(store.getState().name).toBe('Bo');
    store.getState().handleSocketOpen();
    expect(sent).toEqual([{ t: 'joinRoom', roomCode: 'QWZRT', name: 'Bo', token: 'tok-9' }]);
    expect(store.getState().rejoining).toBe(true);
    // Server reattaches: roomState broadcast, then the resumed full view
    // stamped with the same (last-consumed) seq.
    const apply = store.getState().applyServerEvent;
    apply(env(12, { t: 'roomState', room: roomViewFixture({ roomCode: 'QWZRT', started: true }) }));
    apply(env(12, { t: 'gameView', view: gameViewFixture(2) }));
    const s = store.getState();
    expect(s.rejoining).toBe(false);
    expect(s.seat).toBe(2);
    expect(s.seatView).not.toBeNull();
    expect(s.roomView?.roomCode).toBe('QWZRT');
  });

  // AC-2 invalid-token path: storage is cleared and the home flow shown.
  it('clears storage and returns home on badToken', () => {
    const { store, storage } = makeStore({ session });
    store.getState().handleSocketOpen();
    store.getState().applyServerEvent({
      event: { t: 'error', code: 'badToken', message: 'No seat matches this token.' },
    });
    const s = store.getState();
    expect(storage?.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(s.session).toBeNull();
    expect(s.token).toBeNull();
    expect(s.seat).toBeNull();
    expect(s.roomView).toBeNull();
    expect(s.seatView).toBeNull();
    // Discarding a stale session is expected housekeeping, not a user error.
    expect(s.lastError).toBeNull();
    // Next open no longer attempts a rejoin.
    const before = store.getState();
    before.handleSocketOpen();
    expect(store.getState().rejoining).toBe(false);
  });

  it('clears storage when the room is gone (server restart / GC) mid-rejoin', () => {
    const { store, storage } = makeStore({ session });
    store.getState().handleSocketOpen();
    store.getState().applyServerEvent({
      event: { t: 'error', code: 'badRoomCode', message: 'No room with code QWZRT.' },
    });
    expect(storage?.getItem(SESSION_STORAGE_KEY)).toBeNull();
    const s = store.getState();
    expect(s.session).toBeNull();
    expect(s.roomView).toBeNull();
    expect(s.seat).toBeNull();
    expect(s.rejoining).toBe(false);
    // The room going away under a stored session is expected: land on a clean
    // Home screen rather than shouting 'No room with code QWZRT.' at launch.
    expect(s.lastError).toBeNull();
  });

  it('keeps the stored session on a badRoomCode outside the rejoin flow', () => {
    const { store, storage } = makeStore({ session });
    // e.g. the user typo'd a manual join before the auto-rejoin ran.
    store.getState().applyServerEvent({
      event: { t: 'error', code: 'badRoomCode', message: 'No room with code XXXXX.' },
    });
    expect(storage?.getItem(SESSION_STORAGE_KEY)).not.toBeNull();
    expect(store.getState().session).toEqual(session);
    // A code the user typed themselves is a real error: say so.
    expect(store.getState().lastError).toEqual({
      code: 'badRoomCode',
      message: 'No room with code XXXXX.',
    });
  });
});

describe('seat lifecycle', () => {
  it('persists the session when a seat is granted', () => {
    const { store, storage } = makeStore();
    store.getState().setName('Ana');
    const apply = store.getState().applyServerEvent;
    apply(env(0, { t: 'roomState', room: roomViewFixture({ roomCode: 'ZZTOP' }) }));
    apply({ event: { t: 'seatGranted', seat: 1, token: 'fresh-token' } });
    const s = store.getState();
    expect(s.seat).toBe(1);
    expect(s.token).toBe('fresh-token');
    expect(loadSession(storage)).toEqual({
      roomCode: 'ZZTOP',
      seatToken: 'fresh-token',
      name: 'Ana',
    });
  });

  it('marks the seat lost when a newer connection reclaims it', () => {
    const session = { roomCode: 'QWZRT', seatToken: 'tok-9', name: 'Bo' };
    const { store, sent } = makeStore({ session });
    store.getState().handleSocketOpen();
    const apply = store.getState().applyServerEvent;
    apply(env(3, { t: 'roomState', room: roomViewFixture({ roomCode: 'QWZRT' }) }));
    apply(env(3, { t: 'gameView', view: gameViewFixture(2) }));
    // Another tab reattached with the same token; the server kicks this one.
    apply({
      event: { t: 'error', code: 'seatTaken', message: 'Seat reclaimed by a newer connection.' },
    });
    const s = store.getState();
    expect(s.seatLost).toBe(true);
    expect(s.seat).toBeNull();
    // The losing tab must not steal the seat back on its next reconnect.
    const sentBefore = sent.length;
    store.getState().handleSocketOpen();
    expect(sent).toHaveLength(sentBefore);
  });

  it('leaveSession clears storage and returns to the home state', () => {
    const session = { roomCode: 'QWZRT', seatToken: 'tok-9', name: 'Bo' };
    const { store, storage } = makeStore({ session });
    const apply = store.getState().applyServerEvent;
    apply(env(0, { t: 'roomState', room: roomViewFixture() }));
    store.getState().leaveSession();
    const s = store.getState();
    expect(storage?.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(s.session).toBeNull();
    expect(s.roomView).toBeNull();
    expect(s.lastSeq).toBeNull();
  });
});
